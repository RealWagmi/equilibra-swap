// SPDX-License-Identifier: MIT
//
// Aggressive round-trip profit guard.
//
// Goal: under the **real** WETH/WBTC presets (two-knob cubic
// invariant `K = A·L·(x+y)/2 + (W−A)·xy` with `A = a·W/(W+λ·D)`,
// symmetric coord change) but with a flat 5 bps fee and **auto-repeg
// disabled**, prove that no trader can extract value from the pool by
// closing a forward + reverse swap
// in any of the three regimes the curve solver supports:
//
//   A) **Same-side push**          — pool starts balanced, trader
//      deepens depletion on one side then immediately reverses.
//
//   B) **Cross-anchor (toward → away → back)** — pool is pre-depleted
//      on one side, trader's forward swap is sized so it crosses the
//      anchor and lands on the opposite side; the back swap then has
//      to cross again to come home.
//
//   C) **Cross-anchor (away first → cross-back)** — pool is pre-
//      depleted, trader's forward swap pushes deeper *into* the away
//      direction; the back swap is sized large enough to overshoot
//      through the anchor and out the other side, then the trader has
//      to cross once more to settle.
//
// In each scenario the assertion is the same: `usdtBack ≤ usdtIn`
// (modulo a 1-wei raw rounding budget that is unavoidable because the
// math-space `WAD` step floors down through USDT's 6-decimal grid).

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import {
  BPS,
  REAL_PRESETS,
  buildPreset,
  deplete,
  deploySecurityFixture,
  exactInputSingle,
  fmtBase,
  fmtQuote,
  fmtWad,
  snapshotPool,
  type PresetName,
  type SecurityFixture,
} from "../helpers/securityFixtures";

const USDT_ROUNDING_BUDGET = 1n; // 1 raw USDT (1e-6 USDT) per swap leg.

const PRESETS_UNDER_TEST: PresetName[] = ["WETH", "WBTC"];

// Depletion sweep — covers the operationally interesting band.
// Below 10% the curve is so flat that any leak would be drowned by the
// 1-wei budget; above 95% the solver is in the depletion clamp regime
// where exact-output stalls — handled separately in QuoteSwapToPrice.
const DEPLETION_PCTS_BPS = [
  1_000n, // 10%
  2_000n, // 20%
  3_000n, // 30%
  4_000n, // 40%
  5_000n, // 50%
  6_000n, // 60%
  7_000n, // 70%
  8_000n, // 80%
  9_000n, // 90%
  9_500n, // 95%
];

interface TraderRoundTrip {
  inToken: string;
  inAmount: bigint;
  midAmount: bigint;
  outAmount: bigint;
  delta: bigint;
  deltaBps: bigint;
}

// Closes a forward + reverse swap on the same pool; the trader's PnL is
// always denominated in `args.forwardTokenIn` (so the assertion is
// direction-agnostic — works for USDT-in and BASE-in scenarios alike).
async function tradeRoundTrip(
  fx: SecurityFixture,
  args: {
    forwardTokenIn: string;
    forwardTokenOut: string;
    forwardAmount: bigint;
  }
): Promise<TraderRoundTrip> {
  const { trader } = fx;
  const traderAddr = await trader.getAddress();
  const inCt = args.forwardTokenIn.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.quote : fx.base;

  const inBefore = BigInt(await inCt.balanceOf(traderAddr));

  const fwd = await exactInputSingle(fx, trader, {
    tokenIn: args.forwardTokenIn,
    tokenOut: args.forwardTokenOut,
    amountIn: args.forwardAmount,
  });
  const back = await exactInputSingle(fx, trader, {
    tokenIn: args.forwardTokenOut,
    tokenOut: args.forwardTokenIn,
    amountIn: fwd.amountOut,
  });

  const inAfter = BigInt(await inCt.balanceOf(traderAddr));

  const inAmount = args.forwardAmount;
  const midAmount = fwd.amountOut;
  const outAmount = back.amountOut;
  const delta = outAmount - inAmount;

  // Reconcile the wallet snapshot with the booked trade identity.
  const walletDelta = inAfter - inBefore;
  if (walletDelta !== delta) {
    throw new Error(`tradeRoundTrip: wallet delta ${walletDelta} != booked delta ${delta}`);
  }

  const deltaBps = inAmount === 0n ? 0n : (delta * 10_000n) / inAmount;
  return {
    inToken: args.forwardTokenIn,
    inAmount,
    midAmount,
    outAmount,
    delta,
    deltaBps,
  };
}

// Bisect on `quoteExactIn` to find the smallest `amountIn` that drains
// `fractionBps` of `reserveOutCurrent` from the pool. Used by the
// cross-anchor scenarios to size the forward leg so it lands strictly
// past the anchor without revert-tripping on the pool's depletion clamp.
async function bisectAmountInForFractionalDraw(
  fx: SecurityFixture,
  tokenIn: string,
  tokenOut: string,
  reserveOutCurrent: bigint,
  fractionBps: bigint
): Promise<bigint> {
  const targetOut = (reserveOutCurrent * fractionBps) / 10_000n;
  const inIsToken0 = tokenIn.toLowerCase() === (fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr).toLowerCase();
  const zeroForOne = inIsToken0;

  // Probe down from a large upper bound until the pool's solver accepts.
  let probeHi = tokenIn.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.initialQuoteRaw * 4n : fx.initialBaseRaw * 4n;
  let maxValidIn = 0n;
  let maxValidOut = 0n;
  for (let i = 0; i < 32; i++) {
    try {
      const out = BigInt(await fx.pool.quoteExactIn(zeroForOne, probeHi));
      maxValidIn = probeHi;
      maxValidOut = out;
      break;
    } catch {
      probeHi = probeHi / 2n;
      if (probeHi <= 1n) break;
    }
  }
  if (maxValidIn === 0n) {
    throw new Error("bisectAmountInForFractionalDraw: solver always reverts");
  }
  if (maxValidOut < targetOut) {
    return maxValidIn;
  }

  let lo = 1n;
  let hi = maxValidIn;
  let best = 0n;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2n;
    let out: bigint;
    try {
      out = BigInt(await fx.pool.quoteExactIn(zeroForOne, mid));
    } catch {
      hi = mid;
      continue;
    }
    if (out >= targetOut) {
      hi = mid;
      best = mid;
    } else {
      lo = mid;
    }
    if (hi - lo <= 1n) break;
  }
  return best === 0n ? maxValidIn : best;
}

function formatLeg(
  rt: TraderRoundTrip,
  fx: SecurityFixture
): {
  inAmt: string;
  midAmt: string;
  outAmt: string;
  delta: string;
} {
  const inIsQuote = rt.inToken.toLowerCase() === fx.quoteAddr.toLowerCase();
  const inFmt = inIsQuote ? fmtQuote : (raw: bigint) => fmtBase(raw, fx.preset.name);
  const midFmt = inIsQuote ? (raw: bigint) => fmtBase(raw, fx.preset.name) : fmtQuote;
  return {
    inAmt: inFmt(rt.inAmount),
    midAmt: midFmt(rt.midAmount),
    outAmt: inFmt(rt.outAmount),
    delta: `${rt.delta >= 0n ? "+" : ""}${inFmt(rt.delta)}`,
  };
}

describe("AggressiveRoundTrip [real presets, fee=5bps, repeg=off]", function () {
  this.timeout(180_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const preset = buildPreset(presetName);
    const fixtureFor = async () => deploySecurityFixture(preset);

    describe(`${presetName} preset (aWad=${fmtWad(REAL_PRESETS[presetName].aWad, 4)}, lambdaWad=${fmtWad(REAL_PRESETS[presetName].lambdaWad, 4)})`, function () {
      it("A) Same-side round-trip from balanced state is non-positive across [10%..95%] of input reserve", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        for (const pct of DEPLETION_PCTS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const usdtIn = (fx.initialQuoteRaw * pct) / BPS;
            const rt = await tradeRoundTrip(fx, {
              forwardTokenIn: fx.quoteAddr,
              forwardTokenOut: fx.baseAddr,
              forwardAmount: usdtIn,
            });
            const fmt = formatLeg(rt, fx);

            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              usdtIn: fmt.inAmt,
              baseOut: fmt.midAmt,
              usdtBack: fmt.outAmt,
              delta: fmt.delta,
              deltaBps: `${rt.deltaBps >= 0n ? "+" : ""}${rt.deltaBps} bps`,
            });

            expect(
              rt.delta,
              `same-side round-trip leaked at pct=${pct}bps under ${presetName} (delta=${rt.delta} wei)`
            ).to.be.lessThanOrEqual(USDT_ROUNDING_BUDGET);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== A) Same-side round-trip — ${presetName} ===`);
        console.table(rows);
      });

      it("B) Cross-anchor round-trip (USDT-in toward, BASE-excess pool) is non-positive at every pre-depletion", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        // Pre-deplete QUOTE → pool ends with QUOTE scarce, BASE in
        // surplus, `position > 0.5`. To move TOWARD balance the
        // trader has to *buy* BASE (USDT → BASE), pulling BASE out
        // of the pool. Sized by bisection so the forward leg drains
        // ~50% of the *current* BASE reserve — that is large enough
        // to cross the anchor (`position` lands on the opposite side)
        // at every pre-depletion in the sweep.
        const PRE_DEPLETIONS_BPS = [1_000n, 3_000n, 5_000n, 7_000n, 8_500n];

        for (const preDep of PRE_DEPLETIONS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            await deplete(fx, "quote", preDep);
            const before = await snapshotPool(fx);

            const forwardUsdtIn = await bisectAmountInForFractionalDraw(
              fx,
              fx.quoteAddr,
              fx.baseAddr,
              before.reserveBaseRaw,
              5_000n // 50% of current BASE reserve
            );
            const rt = await tradeRoundTrip(fx, {
              forwardTokenIn: fx.quoteAddr,
              forwardTokenOut: fx.baseAddr,
              forwardAmount: forwardUsdtIn,
            });
            const after = await snapshotPool(fx);
            const fmt = formatLeg(rt, fx);
            const crossed = (before.position - 0.5) * (after.position - 0.5) < 0;

            rows.push({
              preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
              posBefore: before.position.toFixed(4),
              posAfter: after.position.toFixed(4),
              crossed: crossed ? "yes" : "no",
              usdtIn: fmt.inAmt,
              baseMid: fmt.midAmt,
              usdtBack: fmt.outAmt,
              delta: fmt.delta,
              bps: `${rt.deltaBps >= 0n ? "+" : ""}${rt.deltaBps} bps`,
            });

            expect(
              rt.delta,
              `cross-anchor USDT-in toward (preDep=${preDep}bps) leaked under ${presetName} (delta=${rt.delta} wei)`
            ).to.be.lessThanOrEqual(USDT_ROUNDING_BUDGET);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== B) Cross-anchor toward (USDT in, BASE-excess pool) — ${presetName} ===`);
        console.table(rows);
      });

      it("B') Cross-anchor round-trip (BASE-in toward, QUOTE-excess pool) is non-positive at every pre-depletion", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        // Mirror of B): pre-deplete BASE → pool ends with BASE scarce,
        // QUOTE in surplus, `position < 0.5`. To move TOWARD balance
        // the trader has to *buy* QUOTE (BASE → USDT), pulling QUOTE
        // out of the pool. Sized to drain ~50% of the current QUOTE
        // reserve so the forward leg crosses the anchor.
        const PRE_DEPLETIONS_BPS = [1_000n, 3_000n, 5_000n, 7_000n, 8_500n];

        for (const preDep of PRE_DEPLETIONS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            await deplete(fx, "base", preDep);
            const before = await snapshotPool(fx);

            const forwardBaseIn = await bisectAmountInForFractionalDraw(
              fx,
              fx.baseAddr,
              fx.quoteAddr,
              before.reserveQuoteRaw,
              5_000n // 50% of current QUOTE reserve
            );
            const rt = await tradeRoundTrip(fx, {
              forwardTokenIn: fx.baseAddr,
              forwardTokenOut: fx.quoteAddr,
              forwardAmount: forwardBaseIn,
            });
            const after = await snapshotPool(fx);
            const fmt = formatLeg(rt, fx);
            const crossed = (before.position - 0.5) * (after.position - 0.5) < 0;

            rows.push({
              preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
              posBefore: before.position.toFixed(4),
              posAfter: after.position.toFixed(4),
              crossed: crossed ? "yes" : "no",
              baseIn: fmt.inAmt,
              usdtMid: fmt.midAmt,
              baseBack: fmt.outAmt,
              delta: fmt.delta,
              bps: `${rt.deltaBps >= 0n ? "+" : ""}${rt.deltaBps} bps`,
            });

            expect(
              rt.delta,
              `cross-anchor BASE-in toward (preDep=${preDep}bps) leaked under ${presetName} (delta=${rt.delta} wei)`
            ).to.be.lessThanOrEqual(USDT_ROUNDING_BUDGET);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== B') Cross-anchor toward (BASE in, QUOTE-excess pool) — ${presetName} ===`);
        console.table(rows);
      });

      it("C) Round-trip pushed AGAINST a pre-depletion (away→deeper, then revert) is non-positive", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        // Pool is pre-depleted on QUOTE (USDT scarce ⇒ BASE in surplus).
        // Trader sells *more* USDT — both legs stay on the BASE-rich
        // side; the forward leg pushes deeper into the away regime
        // (the worst case for the constant-product tail), the back
        // leg returns toward the pre-depleted state without ever
        // crossing the anchor.
        const PRE_DEPLETIONS_BPS = [2_000n, 4_000n, 6_000n, 8_000n, 9_000n];
        const FORWARD_PCTS_BPS = [500n, 1_000n, 2_500n, 5_000n];

        for (const preDep of PRE_DEPLETIONS_BPS) {
          for (const fwdPct of FORWARD_PCTS_BPS) {
            const snap = await hre.network.provider.send("evm_snapshot", []);
            try {
              await deplete(fx, "quote", preDep);
              const before = await snapshotPool(fx);

              const forwardUsdtIn = (before.reserveQuoteRaw * fwdPct) / BPS;
              if (forwardUsdtIn === 0n) continue;

              const rt = await tradeRoundTrip(fx, {
                forwardTokenIn: fx.quoteAddr,
                forwardTokenOut: fx.baseAddr,
                forwardAmount: forwardUsdtIn,
              });
              const fmt = formatLeg(rt, fx);

              rows.push({
                preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
                fwdPct: `${(Number(fwdPct) / 100).toFixed(1)}%`,
                usdtIn: fmt.inAmt,
                baseOut: fmt.midAmt,
                usdtBack: fmt.outAmt,
                delta: fmt.delta,
                bps: `${rt.deltaBps >= 0n ? "+" : ""}${rt.deltaBps} bps`,
              });

              expect(
                rt.delta,
                `away-deepening round-trip leaked (preDep=${preDep}bps, fwdPct=${fwdPct}bps) under ${presetName} (delta=${rt.delta} wei)`
              ).to.be.lessThanOrEqual(USDT_ROUNDING_BUDGET);
            } finally {
              await hre.network.provider.send("evm_revert", [snap]);
            }
          }
        }

        console.log(`\n=== C) Pre-depleted away-push round-trip — ${presetName} ===`);
        console.table(rows);
      });

      it("D) Pool's quote-priced value never falls more than the 1-wei rounding budget across the full sweep", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        // Mirror image of A): for each forward%, capture the pool's
        // anchor-priced value before/after the round-trip. Any leak the
        // trader could exploit must show up as a value-loss here.
        for (const pct of [2_000n, 5_000n, 8_000n, 9_500n]) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const before = await snapshotPool(fx);
            const usdtIn = (fx.initialQuoteRaw * pct) / BPS;
            await tradeRoundTrip(fx, {
              forwardTokenIn: fx.quoteAddr,
              forwardTokenOut: fx.baseAddr,
              forwardAmount: usdtIn,
            });
            const after = await snapshotPool(fx);
            const dValueWad = after.poolValueQuoteWad - before.poolValueQuoteWad;

            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              valueBefore: fmtWad(before.poolValueQuoteWad, 4),
              valueAfter: fmtWad(after.poolValueQuoteWad, 4),
              "Δ value (USDT, WAD)": `${dValueWad >= 0n ? "+" : ""}${fmtWad(dValueWad, 6)}`,
            });

            // 1 WAD wei budget covers the floor noise on the WAD ↔ raw
            // conversion of `reserveQuoteRaw`. Any deeper drop would
            // mean the trader extracted value (impossible iff
            // `_computeExactInSwapMath` is conservative).
            expect(
              dValueWad,
              `pool value dropped by ${dValueWad} WAD wei (pct=${pct}bps, ${presetName})`
            ).to.be.greaterThanOrEqual(-1n);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== D) Pool value conservation — ${presetName} ===`);
        console.table(rows);
      });
    });
  }
});
