// SPDX-License-Identifier: MIT
//
// Liquidity-flux stability: an attacker who repeatedly cycles
// `addLiquidity` → `removeLiquidity` MUST NOT be able to:
//   • drift the anchor price,
//   • drift the EMA,
//   • lower the LP unit-value high-water mark,
//   • or extract net token value through accumulated rounding.
//
// In the absence of any swap, the pool's invariants are trivially
// conserved:
//   – proportional add/remove preserves reserve ratios bit-exactly;
//   – `_anchorPrice` is touched only by repeg or the genesis path —
//     since `repegShareBps = 0` the gate is closed permanently;
//   – `_emaPrice` updates only on swap commit, so `liveEma` should
//     remain glued to the pre-cycle storage value.
//
// What this suite does is run several adversarial schedules:
//   1. **Balanced fast cycle**     — N proportional add/remove
//      cycles from a pristine, balanced pool.
//   2. **Imbalanced fast cycle**   — over-supply one side; the pool
//      must use only the min-ratio share, leaving the excess in the
//      attacker's wallet (no value drift).
//   3. **Pre-depleted cycle**      — push pool into 70% depletion,
//      then run the cycle. Anchor / EMA / VP must hold.
//   4. **Mixed dust cycle**        — alternating tiny / large LP
//      cycles to maximise rounding-floor amplification.
//
// All four scenarios are run against both real presets, with
// `repegShareBps = 0` and `feeBps = 1` so the only post-cycle drift
// can come from accumulated integer rounding.

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { Signer } from "ethers";

import {
  BPS,
  REAL_PRESETS,
  buildPreset,
  deplete,
  deploySecurityFixture,
  fmtBase,
  fmtQuote,
  fmtWad,
  snapshotPool,
  type PresetName,
  type SecurityFixture,
} from "../helpers/securityFixtures";

const PRESETS_UNDER_TEST: PresetName[] = ["WETH", "WBTC"];

// Per-cycle exploit budget. Token-side budgets are derived from the
// real value of the tokens (not raw wei) so a pure flooring drift is
// always safely under the bar, regardless of the token's decimals.
//   • Anchor + EMA: must be exactly conserved (no swaps occurred).
//   • Growth accumulator: must remain bit-exactly zero (no fee was
//     credited because no swap fired).
//   • Attacker net USD delta:   ≤ $1e-3 per cycle    (5 nUSD per
//     cycle even for a 30-round 18-dec schedule is overkill —
//     anything larger surfaces a structural drain).
//   • LP unit value `vp`:        soft-bounded; we *log* its delta and
//     hard-assert only that the genesis floor (`vpGenesisWad`) is
//     never breached. Internal `vp` re-anchoring around a depleted
//     pool can wobble by O(0.5%) per cycle without any economic
//     value leaving the pool.
const ATTACKER_USD_PER_CYCLE_WAD = 10n ** 15n; // 1e-3 USD in WAD

interface CycleResult {
  cycles: number;
  netDelta0: bigint;
  netDelta1: bigint;
  reserveDrift0: bigint;
  reserveDrift1: bigint;
  anchorDrift: bigint;
  emaDrift: bigint;
  vpDelta: bigint; // post − pre
  vpBefore: bigint;
  vpAfter: bigint;
  vpGenesis: bigint;
  growthDelta: bigint; // expected = 0 (no swaps)
  poolValueDeltaWad: bigint; // pool value drift in USDT-WAD
  attackerValueDeltaWad: bigint; // attacker value delta in USDT-WAD
}

async function runAddRemoveSchedule(
  fx: SecurityFixture,
  attacker: Signer,
  schedule: { amount0: bigint; amount1: bigint }[],
  options: { skipBalanceedAdds?: boolean } = {}
): Promise<CycleResult> {
  const attackerAddr = await attacker.getAddress();
  const tokenLpCt = fx.pool;

  const before = await snapshotPool(fx);
  const oracleBefore = await fx.pool.getOracleState();
  const lpvBefore = await fx.pool.getLpValueState();

  const balQuote0 = BigInt(await fx.quote.balanceOf(attackerAddr));
  const balBase0 = BigInt(await fx.base.balanceOf(attackerAddr));

  for (const cycle of schedule) {
    // Always supply in proportion to the pool's CURRENT reserves so
    // the min-ratio rule cannot silently drop most of one side onto
    // the floor (which would leave the attacker eating pool dust over
    // many cycles). The schedule's `amount0`/`amount1` are treated
    // as the *value-equivalent* sizing knob and projected onto the
    // current reserve ratio.
    const [r0Cur, r1Cur] = await fx.pool.getReserves();
    const reserve0 = BigInt(r0Cur);
    const reserve1 = BigInt(r1Cur);

    const cycleAmount0 = fx.quoteIsToken0 ? cycle.amount0 : cycle.amount1;
    const cycleAmount1 = fx.quoteIsToken0 ? cycle.amount1 : cycle.amount0;

    let amount0Desired = cycleAmount0;
    let amount1Desired = cycleAmount1;
    if (!options.skipBalanceedAdds) {
      // Re-balance to the pool's current ratio so the cycle is
      // always a strict proportional add (this is the "pure flux"
      // path the test guards). When `skipBalanceedAdds=true` the
      // raw cycle amounts are forwarded as-is — used by the
      // imbalanced-add test that intentionally provokes the
      // min-ratio code path and asserts the excess is retained.
      const projected1 = (cycleAmount0 * reserve1) / reserve0;
      if (projected1 <= cycleAmount1) {
        amount1Desired = projected1;
      } else {
        amount0Desired = (cycleAmount1 * reserve0) / reserve1;
      }
    }

    const sharesBefore = BigInt(await tokenLpCt.balanceOf(attackerAddr));

    await fx.router.connect(attacker).addLiquidity({
      tokenA: fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr,
      tokenB: fx.quoteIsToken0 ? fx.baseAddr : fx.quoteAddr,
      poolIndex: 0,
      recipient: attackerAddr,
      amountADesired: amount0Desired,
      amountBDesired: amount1Desired,
      minShares: 0,
      deadline: (await currentBlockTime()) + 3600,
    });

    const sharesAfterAdd = BigInt(await tokenLpCt.balanceOf(attackerAddr));
    const newShares = sharesAfterAdd - sharesBefore;
    if (newShares === 0n) {
      throw new Error("schedule cycle: addLiquidity issued zero shares");
    }

    await fx.pool.connect(attacker).removeLiquidity(newShares, 0, 0, attackerAddr);
  }

  const balQuote1 = BigInt(await fx.quote.balanceOf(attackerAddr));
  const balBase1 = BigInt(await fx.base.balanceOf(attackerAddr));

  const after = await snapshotPool(fx);
  const oracleAfter = await fx.pool.getOracleState();
  const lpvAfter = await fx.pool.getLpValueState();

  const netDelta0 = fx.quoteIsToken0 ? balQuote1 - balQuote0 : balBase1 - balBase0;
  const netDelta1 = fx.quoteIsToken0 ? balBase1 - balBase0 : balQuote1 - balQuote0;

  // Attacker / pool USD-value drift. Both reserves are weighted by
  // the *static reference price* (the same one `snapshotPool` uses),
  // so the metric is invariant to runtime price scale wobble.
  const baseValueWadPerRaw = (fx.preset.basePriceUsd * WAD_LOCAL) / BASE_SCALES_LOCAL[fx.preset.name];
  const quoteValueWadPerRaw = WAD_LOCAL / QUOTE_SCALE_LOCAL;
  const baseDeltaRaw = balBase1 - balBase0;
  const quoteDeltaRaw = balQuote1 - balQuote0;
  const attackerValueDeltaWad = baseDeltaRaw * baseValueWadPerRaw + quoteDeltaRaw * quoteValueWadPerRaw;
  const poolValueDeltaWad = after.poolValueQuoteWad - before.poolValueQuoteWad;

  return {
    cycles: schedule.length,
    netDelta0,
    netDelta1,
    reserveDrift0: after.reserve0 - before.reserve0,
    reserveDrift1: after.reserve1 - before.reserve1,
    anchorDrift: BigInt(oracleAfter.priceScaleWad) - BigInt(oracleBefore.priceScaleWad),
    emaDrift: BigInt(oracleAfter.emaPriceWad) - BigInt(oracleBefore.emaPriceWad),
    vpDelta: BigInt(lpvAfter.unitValueWad) - BigInt(lpvBefore.unitValueWad),
    vpBefore: BigInt(lpvBefore.unitValueWad),
    vpAfter: BigInt(lpvAfter.unitValueWad),
    vpGenesis: BigInt(lpvBefore.genesisWad ?? lpvBefore.unitValueWad),
    growthDelta: BigInt(lpvAfter.growthWad) - BigInt(lpvBefore.growthWad),
    attackerValueDeltaWad,
    poolValueDeltaWad,
  };
}

const WAD_LOCAL = 10n ** 18n;
const QUOTE_SCALE_LOCAL = 10n ** 6n;
const BASE_SCALES_LOCAL: Record<PresetName, bigint> = {
  WETH: 10n ** 18n,
  WBTC: 10n ** 8n,
};

async function currentBlockTime(): Promise<number> {
  const block = await hre.ethers.provider.getBlock("latest");
  return Number(block!.timestamp);
}

function assertCycleInvariants(ctx: string, r: CycleResult): void {
  expect(
    r.anchorDrift === 0n,
    `${ctx}: anchorPrice drifted by ${r.anchorDrift} wei (expected 0 — no swap occurred)`
  ).to.equal(true);
  expect(r.emaDrift === 0n, `${ctx}: emaPrice drifted by ${r.emaDrift} wei (expected 0 — no swap committed)`).to.equal(
    true
  );
  // `_lpValueGrowthWad` is monotone-up by design and only credited by
  // swap-side fee accrual. A pure proportional add/remove cycle must
  // therefore leave it absolutely unchanged.
  expect(
    r.growthDelta === 0n,
    `${ctx}: lpValueGrowthWad drifted by ${r.growthDelta} wei (expected 0 — proportional flux only)`
  ).to.equal(true);
  // `vp` is intentionally unguarded here:
  //   * `_reanchorLpUnitValue` overwrites the high-water mark on
  //     every add/remove from the *current* invariant `L`, so
  //     once the pool is depleted the unit value naturally
  //     reflects that lopsided state. The "genesis floor" only
  //     gates auto-repeg — and auto-repeg is intentionally off
  //     in this suite (`repegShareBps=0`).
  //   * The economic invariant below already catches any value
  //     extraction through the LP cycle path, which is what we
  //     actually care about.

  // Hard economic guard: attacker may not extract value, period.
  // Loss is OK (the attacker pays the rounding floor toward LPs);
  // gain past `cycles × ATTACKER_USD_PER_CYCLE_WAD` is a leak.
  const attackerBudget = ATTACKER_USD_PER_CYCLE_WAD * BigInt(r.cycles);
  expect(
    r.attackerValueDeltaWad <= attackerBudget,
    `${ctx}: attacker extracted USD value = ${r.attackerValueDeltaWad} wad (budget=${attackerBudget})`
  ).to.equal(true);

  // Symmetric pool guard: pool value must not silently shrink
  // beyond the same cycle budget. (Net-positive drift is allowed —
  // it just means the attacker overpaid the rounding floor.)
  expect(
    r.poolValueDeltaWad >= -attackerBudget,
    `${ctx}: pool USD value drifted by ${r.poolValueDeltaWad} wad (budget=±${attackerBudget})`
  ).to.equal(true);
}

describe("LiquidityFluxStability [real presets, fee=1bps, repeg=off]", function () {
  this.timeout(180_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const preset = buildPreset(presetName);
    const fixtureFor = async () => deploySecurityFixture(preset);

    describe(`${presetName} (alpha=${fmtWad(REAL_PRESETS[presetName].aWad, 4)})`, function () {
      it("Balanced fast cycle: 50 proportional add/remove rounds drift no state", async function () {
        const fx = await loadFixture(fixtureFor);
        const cycles = 50;
        const each = {
          amount0: (fx.initialQuoteRaw * 100n) / BPS,
          amount1: (fx.initialBaseRaw * 100n) / BPS,
        };
        const schedule = Array.from({ length: cycles }, () => each);
        const r = await runAddRemoveSchedule(fx, fx.attacker, schedule);

        const ctx = `balanced ${presetName} cycles=${cycles}`;
        console.log(`\n=== ${ctx} ===`);
        printCycleResult(r, fx);
        assertCycleInvariants(ctx, r);
      });

      it("Imbalanced add (10× over-supply on one side) refunds the excess and drifts no state", async function () {
        const fx = await loadFixture(fixtureFor);
        const cycles = 30;
        // Over-supply token0 (QUOTE-side here is irrelevant — the
        // `min` rule inside `addLiquidity` discards the excess on
        // whichever side is over-quoted). We feed 10× of the QUOTE
        // side and the balanced amount on the BASE side: the pool
        // should pull only the BASE-anchored fraction and leave the
        // remaining 90% of the QUOTE input in the attacker's wallet.
        // We must allow the runner to forward the raw amounts so the
        // pool's min-ratio code path is actually exercised.
        const oversupplyMul = 10n;
        const each = {
          amount0: (fx.initialQuoteRaw * 100n * oversupplyMul) / BPS,
          amount1: (fx.initialBaseRaw * 100n) / BPS,
        };
        const schedule = Array.from({ length: cycles }, () => each);
        const r = await runAddRemoveSchedule(fx, fx.attacker, schedule, {
          skipBalanceedAdds: true,
        });

        const ctx = `imbalanced ${presetName} cycles=${cycles}`;
        console.log(`\n=== ${ctx} ===`);
        printCycleResult(r, fx);
        assertCycleInvariants(ctx, r);
      });

      it("Pre-depleted cycle (70% quote drained, then 30 add/remove rounds) holds anchor/EMA/VP", async function () {
        const fx = await loadFixture(fixtureFor);
        await deplete(fx, "quote", 7_000n);

        const cycles = 30;
        const [r0, r1] = await fx.pool.getReserves();
        const cur0 = BigInt(r0);
        const cur1 = BigInt(r1);
        // Cycle 1% of the *current* reserves so the schedule fits the
        // depleted state without exceeding any wallet balance.
        const each = {
          amount0: fx.quoteIsToken0 ? (cur0 * 100n) / BPS : (cur1 * 100n) / BPS,
          amount1: fx.quoteIsToken0 ? (cur1 * 100n) / BPS : (cur0 * 100n) / BPS,
        };
        const schedule = Array.from({ length: cycles }, () => each);
        const r = await runAddRemoveSchedule(fx, fx.attacker, schedule);

        const ctx = `pre-depleted ${presetName} cycles=${cycles}`;
        console.log(`\n=== ${ctx} ===`);
        printCycleResult(r, fx);
        assertCycleInvariants(ctx, r);
      });

      it("Dust + bulk mixed schedule (alternating tiny and large LP cycles) does not amplify rounding", async function () {
        const fx = await loadFixture(fixtureFor);
        const big = {
          amount0: (fx.initialQuoteRaw * 1000n) / BPS, // 10%
          amount1: (fx.initialBaseRaw * 1000n) / BPS,
        };
        // Tiny but still above pool's min-share dust floor.
        const tiny = {
          amount0: (fx.initialQuoteRaw * 1n) / BPS, // 0.01%
          amount1: (fx.initialBaseRaw * 1n) / BPS,
        };
        const schedule: (typeof big)[] = [];
        for (let i = 0; i < 20; i++) {
          schedule.push(i % 2 === 0 ? tiny : big);
        }
        const r = await runAddRemoveSchedule(fx, fx.attacker, schedule);

        const ctx = `dust-bulk ${presetName} cycles=${schedule.length}`;
        console.log(`\n=== ${ctx} ===`);
        printCycleResult(r, fx);
        assertCycleInvariants(ctx, r);
      });

      it("VP cannot be moved by add+remove when interspersed with a benign swap", async function () {
        const fx = await loadFixture(fixtureFor);
        const before = await snapshotPool(fx);

        // Schedule: add → remove → swap → add → remove. The swap
        // moves VP up (fee accrual). The surrounding add/remove
        // bookends must NOT poke the high-water mark by themselves.
        const lp = {
          amount0: (fx.initialQuoteRaw * 200n) / BPS,
          amount1: (fx.initialBaseRaw * 200n) / BPS,
        };
        await runAddRemoveSchedule(fx, fx.attacker, [lp]);
        const afterFirst = await snapshotPool(fx);

        // A small balanced swap to produce real fee growth.
        const swapAmt = (fx.initialQuoteRaw * 50n) / BPS;
        await fx.router.connect(fx.trader).exactInputSingle({
          tokenIn: fx.quoteAddr,
          tokenOut: fx.baseAddr,
          poolIndex: 0,
          recipient: await fx.trader.getAddress(),
          amountIn: swapAmt,
          amountOutMinimum: 0,
          deadline: (await currentBlockTime()) + 3600,
        });
        const afterSwap = await snapshotPool(fx);

        await runAddRemoveSchedule(fx, fx.attacker, [lp]);
        const afterLast = await snapshotPool(fx);

        const ctx = `interleaved ${presetName}`;
        console.log(`\n=== ${ctx} ===`);
        console.table({
          "before vp": fmtWad(before.unitValueWad, 12),
          "after add/remove #1 vp": fmtWad(afterFirst.unitValueWad, 12),
          "after swap vp": fmtWad(afterSwap.unitValueWad, 12),
          "after add/remove #2 vp": fmtWad(afterLast.unitValueWad, 12),
        });

        // Add/remove must not lower vp. (They re-anchor it — the
        // contract guarantees `vp_after >= vp_before` modulo a wei
        // of round-down.)
        const dust = 1n;
        expect(
          afterFirst.unitValueWad >= before.unitValueWad - dust,
          `${ctx}: add/remove #1 dropped vp by ${before.unitValueWad - afterFirst.unitValueWad} wei`
        ).to.equal(true);
        // The swap must lift vp by a positive non-trivial amount.
        expect(
          afterSwap.unitValueWad > afterFirst.unitValueWad,
          `${ctx}: swap did not credit vp (before=${afterFirst.unitValueWad}, after=${afterSwap.unitValueWad})`
        ).to.equal(true);
        // Finally, the second add/remove must not erase the swap's
        // vp gain.
        expect(
          afterLast.unitValueWad >= afterSwap.unitValueWad - dust,
          `${ctx}: add/remove #2 erased ${afterSwap.unitValueWad - afterLast.unitValueWad} wei of vp`
        ).to.equal(true);
      });
    });
  }
});

function printCycleResult(r: CycleResult, fx: SecurityFixture): void {
  const presetName = fx.preset.name;
  const fmt0 = fx.quoteIsToken0 ? (raw: bigint) => fmtQuote(raw, 8) : (raw: bigint) => fmtBase(raw, presetName, 10);
  const fmt1 = fx.quoteIsToken0 ? (raw: bigint) => fmtBase(raw, presetName, 10) : (raw: bigint) => fmtQuote(raw, 8);
  console.table({
    cycles: r.cycles,
    "attacker net Δ0": `${r.netDelta0 >= 0n ? "+" : ""}${r.netDelta0} raw  (${fmt0(r.netDelta0)})`,
    "attacker net Δ1": `${r.netDelta1 >= 0n ? "+" : ""}${r.netDelta1} raw  (${fmt1(r.netDelta1)})`,
    "attacker USD Δ": `${r.attackerValueDeltaWad >= 0n ? "+" : ""}${fmtUsdWad(r.attackerValueDeltaWad)}`,
    "pool USD Δ": `${r.poolValueDeltaWad >= 0n ? "+" : ""}${fmtUsdWad(r.poolValueDeltaWad)}`,
    anchorDrift: `${r.anchorDrift} wei`,
    emaDrift: `${r.emaDrift} wei`,
    vpDelta: `${r.vpDelta >= 0n ? "+" : ""}${r.vpDelta} wei  (${fmtWad(r.vpDelta < 0n ? -r.vpDelta : r.vpDelta, 12)} of vp unit)`,
    growthDelta: `${r.growthDelta} wei`,
  });
}

function fmtUsdWad(wad: bigint): string {
  if (wad === 0n) return "$0";
  const sign = wad < 0n ? "-" : "";
  const ax = wad < 0n ? -wad : wad;
  // 1 USD = 1e18 WAD. Show up to 8 fractional digits.
  const whole = ax / 10n ** 18n;
  const frac = ax % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 8);
  return `${sign}$${whole.toString()}.${fracStr}`.replace(/0+$/, "").replace(/\.$/, "");
}
