// SPDX-License-Identifier: MIT
//
// CP-zone security regression suite.
//
// EquilibraSwap invariant `K = A · L · (x+y)/2 + (W − A) · x · y`
// with `A = a · W / (W + λ · D)` converges to the constant-product
// asymptote `K → x · y` as imbalance (`D → ∞`) grows, so every swap
// stays feasible no matter how thin the receiving side becomes — there
// is no liquidity wall.
//
// That asymptote is a feature for traders but it also opens a class of
// adversarial workflows that don't exist on segmented / wall AMMs:
// pushing the pool deep into the CP tail (≥ 99 % depletion), then
// trying to compose with `addLiquidity` / `removeLiquidity` and a
// reverse swap to drain the pool through pure curve / rounding
// arithmetic. The wider security suite already covers
// 10 % – 95 % round-trips and add/remove flux at moderate depths;
// this file extends the guarantees to the **deep CP regime** where
// the kernel's curvature is dominated by the constant-product term.
//
// Scenarios under test (each runs against both real presets, with
// `feeBps = 1`, `feeFloorBps = 0`, `feeRampBps = 0`, `repegShareBps = 0`
// so any positive PnL must come from a math leak, not fee economics
// or repeg drift):
//
//   A) Same-side deep-CP round-trip — attacker forwards / reverses a
//      USDT → BASE swap that drains 97/99/99.5 % of the BASE reserve.
//   B) Deep-CP cross-anchor round-trip — pre-deplete on one side, then
//      forward/reverse cross-anchor with the forward leg sized to push
//      the pool > 99 % through the opposite reserve.
//   C) Batched-vs-single in deep CP — splitting a 99 %-depletion swap
//      across 10 / 50 / 200 chunks never out-extracts the single-pass
//      equivalent.
//   D) Swap-into-CP + addLiquidity + swap-back + removeLiquidity —
//      attacker pushes the pool deep, mints a fresh LP position at the
//      imbalanced state, returns the swap, then burns the position.
//      Net wallet delta in USD-WAD must be ≤ rounding budget.
//   E) addLiquidity-first JIT attack — attacker mints LP at the
//      balanced state, immediately drives a deep-CP swap and returns,
//      then burns. The mint+burn must not amplify swap-leg PnL.
//   F) LP-sandwich exit — attacker is already an LP, drives a deep-CP
//      swap, burns the imbalanced LP slice, then reverses the swap.
//      Total wallet delta must remain non-positive.
//   G) Multi-cycle CP-zone zigzag — N iterations of (push deep CP →
//      swap back → addLiquidity → removeLiquidity). The pool's
//      anchor-priced value (`poolValueQuoteWad`) must not decrease
//      below the cumulative rounding budget over the whole cycle.
//
// All scenarios use the `loadFixture` + `evm_snapshot` pattern so the
// pool is reset to its seeded state between deplete sweeps.

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import {
  BPS,
  REAL_PRESETS,
  WAD,
  buildPreset,
  deplete,
  deploySecurityFixture,
  exactInputSingle,
  fmtBase,
  fmtQuote,
  fmtWad,
  snapshotPool,
  type PresetName,
  type PoolSnapshot,
  type SecurityFixture,
} from "../helpers/securityFixtures";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESETS_UNDER_TEST: PresetName[] = ["WETH", "WBTC"];

// Fractions of the *current* output reserve the deep-CP forward leg
// tries to drain. The kernel's depletion clamp may reject 99.9 % for
// some α / state combinations — the test sweep treats any
// `bisectAmountInForFractionalDraw` returning the maximum-valid
// probe as "best-effort deep" rather than a hard pass.
const DEEP_CP_FRACTIONS_BPS = [
  9_700n, // 97 %
  9_900n, // 99 %
  9_950n, // 99.5 %
];

// Per-scenario raw-token rounding budget. Same convention as
// AggressiveRoundTrip: 1 wei of the input token per swap leg, scaled
// up where the scenario chains multiple legs. The deep-CP curve does
// not relax this — the CP-asymptote itself is monotone and analytic,
// so deep depletion does not introduce any fresh rounding source.
const ROUNDING_BUDGET_RAW = 2n; // 2 raw wei (covers two-leg swaps).

// USD-WAD budget for compound (swap + LP + swap) attacks. The pool's
// LP redemption rounds DOWN by design, so a single mint+burn cycle
// may cost the attacker up to a few units of LP-token dust — but the
// pool's USD value should never drop. We allow a small per-scenario
// budget on the attacker side and a strict "no value loss" guard on
// the pool side.
const ATTACKER_USD_BUDGET_WAD_PER_LEG = 10n ** 15n; // $1e-3 per LP touch.

// Multi-cycle scenario: how many (push → return → addLiquidity →
// removeLiquidity) iterations to run.
const ZIGZAG_CYCLES = 12;

// ---------------------------------------------------------------------------
// Helpers — local to this file. Mirror the patterns used by
// AggressiveRoundTrip / LiquidityFluxStability so behaviour is
// directly comparable.
// ---------------------------------------------------------------------------

async function currentBlockTime(): Promise<number> {
  const block = await hre.ethers.provider.getBlock("latest");
  return Number(block!.timestamp);
}

interface RoundTripResult {
  inAmount: bigint;
  midAmount: bigint;
  outAmount: bigint;
  delta: bigint;
}

async function tradeRoundTrip(
  fx: SecurityFixture,
  signer: any,
  args: { inToken: string; outToken: string; amountIn: bigint }
): Promise<RoundTripResult> {
  const fwd = await exactInputSingle(fx, signer, {
    tokenIn: args.inToken,
    tokenOut: args.outToken,
    amountIn: args.amountIn,
  });
  const back = await exactInputSingle(fx, signer, {
    tokenIn: args.outToken,
    tokenOut: args.inToken,
    amountIn: fwd.amountOut,
  });
  return {
    inAmount: args.amountIn,
    midAmount: fwd.amountOut,
    outAmount: back.amountOut,
    delta: back.amountOut - args.amountIn,
  };
}

// Return the largest `amountIn` that the pool's solver will accept,
// up to a starting probe of `seedHi`. The kernel's depletion clamp
// reverts before the curve becomes degenerate; we halve the probe
// until we land inside the feasibility envelope.
async function maxValidAmountIn(
  fx: SecurityFixture,
  zeroForOne: boolean,
  seedHi: bigint
): Promise<{ amountIn: bigint; amountOut: bigint }> {
  let probe = seedHi;
  for (let i = 0; i < 64 && probe > 0n; i++) {
    try {
      const out = BigInt(await fx.pool.quoteExactIn(zeroForOne, probe));
      return { amountIn: probe, amountOut: out };
    } catch {
      probe = probe / 2n;
    }
  }
  return { amountIn: 0n, amountOut: 0n };
}

// Bisect `amountIn` against `quoteExactIn` to find the smallest input
// that drains `fractionBps` of `reserveOutCurrent`. Falls back to the
// maximum reachable input when the requested fraction is outside the
// solver's feasibility envelope. Used by the deep-CP scenarios where
// the target fraction may exceed what the pool can settle (≥ 99.5 %).
async function bisectAmountInForFraction(
  fx: SecurityFixture,
  tokenIn: string,
  reserveOutCurrent: bigint,
  fractionBps: bigint
): Promise<{ amountIn: bigint; expectedOut: bigint; reachable: boolean }> {
  const inIsToken0 = tokenIn.toLowerCase() === (fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr).toLowerCase();
  const zeroForOne = inIsToken0;

  const targetOut = (reserveOutCurrent * fractionBps) / BPS;
  const seedReserveIn = tokenIn.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.initialQuoteRaw : fx.initialBaseRaw;
  const { amountIn: maxIn, amountOut: maxOut } = await maxValidAmountIn(fx, zeroForOne, seedReserveIn * 256n);
  if (maxIn === 0n) {
    return { amountIn: 0n, expectedOut: 0n, reachable: false };
  }
  if (maxOut < targetOut) {
    return { amountIn: maxIn, expectedOut: maxOut, reachable: false };
  }

  let lo = 1n;
  let hi = maxIn;
  let bestIn = maxIn;
  let bestOut = maxOut;
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
      bestIn = mid;
      bestOut = out;
    } else {
      lo = mid;
    }
    if (hi - lo <= 1n) break;
  }
  return { amountIn: bestIn, expectedOut: bestOut, reachable: true };
}

// USD-WAD value of the supplied raw token deltas, weighted by the
// preset's static reference price (so adversarial anchor / EMA
// drift does not show up as an apparent attacker gain).
function deltaToUsdWad(fx: SecurityFixture, quoteDeltaRaw: bigint, baseDeltaRaw: bigint): bigint {
  const baseScale = 10n ** BigInt(fx.baseDecimals);
  const quoteScale = 10n ** 6n;
  const baseValueWad = (baseDeltaRaw * fx.preset.basePriceUsd * WAD) / baseScale;
  const quoteValueWad = (quoteDeltaRaw * WAD) / quoteScale;
  return baseValueWad + quoteValueWad;
}

async function attackerWalletDeltas(
  fx: SecurityFixture,
  signer: any
): Promise<{
  before: () => Promise<bigint[]>;
  after: () => Promise<bigint[]>;
}> {
  const addr = await signer.getAddress();
  const balQuoteSnap = async () => BigInt(await fx.quote.balanceOf(addr));
  const balBaseSnap = async () => BigInt(await fx.base.balanceOf(addr));
  return {
    before: async () => [await balQuoteSnap(), await balBaseSnap()],
    after: async () => [await balQuoteSnap(), await balBaseSnap()],
  };
}

async function addLiquidityAt(
  fx: SecurityFixture,
  signer: any,
  amountQuoteRaw: bigint,
  amountBaseRaw: bigint
): Promise<bigint> {
  const addr = await signer.getAddress();
  const sharesBefore = BigInt(await fx.pool.balanceOf(addr));
  await fx.router.connect(signer).addLiquidity({
    tokenA: fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr,
    tokenB: fx.quoteIsToken0 ? fx.baseAddr : fx.quoteAddr,
    poolIndex: 0,
    recipient: addr,
    amountADesired: fx.quoteIsToken0 ? amountQuoteRaw : amountBaseRaw,
    amountBDesired: fx.quoteIsToken0 ? amountBaseRaw : amountQuoteRaw,
    minShares: 0,
    deadline: (await currentBlockTime()) + 3600,
  });
  const sharesAfter = BigInt(await fx.pool.balanceOf(addr));
  return sharesAfter - sharesBefore;
}

async function removeLiquidityShares(fx: SecurityFixture, signer: any, shares: bigint): Promise<void> {
  const addr = await signer.getAddress();
  if (shares === 0n) return;
  await fx.pool.connect(signer).removeLiquidity(shares, 0, 0, addr);
}

// Provide a **proportional** add-liquidity payload that matches the
// pool's *current* reserve ratio — same `min`-rule trick the
// LiquidityFluxStability suite uses to avoid burning input on the
// floor side. Attacker sizes are anchored on `notionalQuoteRaw`.
async function proportionalAddAmounts(
  fx: SecurityFixture,
  notionalQuoteRaw: bigint
): Promise<{ quoteRaw: bigint; baseRaw: bigint }> {
  if (notionalQuoteRaw === 0n) return { quoteRaw: 0n, baseRaw: 0n };
  const [r0, r1] = await fx.pool.getReserves();
  const quoteRes = fx.quoteIsToken0 ? BigInt(r0) : BigInt(r1);
  const baseRes = fx.quoteIsToken0 ? BigInt(r1) : BigInt(r0);
  if (quoteRes === 0n || baseRes === 0n) {
    return { quoteRaw: notionalQuoteRaw, baseRaw: 0n };
  }
  return {
    quoteRaw: notionalQuoteRaw,
    baseRaw: (notionalQuoteRaw * baseRes) / quoteRes,
  };
}

function fmtAttackerRow(
  delta: bigint,
  poolValueDeltaWad: bigint,
  midState: PoolSnapshot
): Record<string, string | number> {
  return {
    "attacker raw Δ": delta.toString(),
    "pool USD Δ": `${poolValueDeltaWad >= 0n ? "+" : ""}${fmtWad(poolValueDeltaWad, 8)}`,
    "mid pos": midState.position.toFixed(4),
    "mid pmarg": midState.pMargWad === 0n ? "-" : fmtWad(midState.pMargWad, 6),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("CpZoneSecurity [real presets, fee=1bps, repeg=off]", function () {
  this.timeout(240_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const preset = buildPreset(presetName);
    const fixtureFor = async () => deploySecurityFixture(preset);

    // Production-preset fixture used by Test F. Captured at module
    // scope (not inline) so `loadFixture` can match the same
    // function reference across the deferred test runs and avoid
    // `FixtureAnonymousFunctionError`.
    const prodPreset = EQUILIBRA_PRESETS[presetName];
    const prodFixturePreset = buildPreset(presetName, {
      baseFee: prodPreset.feeBps,
      feeRampBps: prodPreset.feeRampBps,
      feeFloorBps: prodPreset.feeFloorBps,
      repegShareBps: prodPreset.repegShareBps,
    });
    const prodFixtureFor = async () => deploySecurityFixture(prodFixturePreset);

    describe(`${presetName} (aWad=${fmtWad(REAL_PRESETS[presetName].aWad, 4)}, lambdaWad=${fmtWad(REAL_PRESETS[presetName].lambdaWad, 4)})`, function () {
      // -------------------------------------------------------------------
      // A) Same-side deep-CP round-trip
      // -------------------------------------------------------------------
      it("A) Same-side round-trip in deep CP zone (≥97%) is non-positive", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        for (const fractionBps of DEEP_CP_FRACTIONS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const before = await snapshotPool(fx);
            const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, fractionBps);
            if (sized.amountIn === 0n) continue;

            const rt = await tradeRoundTrip(fx, fx.attacker, {
              inToken: fx.quoteAddr,
              outToken: fx.baseAddr,
              amountIn: sized.amountIn,
            });
            const mid = await snapshotPool(fx); // captured after fwd+back so
            // it isn't the deep state — but we recompute reserves below.

            rows.push({
              targetDrain: `${(Number(fractionBps) / 100).toFixed(1)}%`,
              reachable: sized.reachable ? "yes" : "max-effort",
              usdtIn: fmtQuote(sized.amountIn),
              baseMid: fmtBase(rt.midAmount, fx.preset.name),
              usdtBack: fmtQuote(rt.outAmount),
              delta: `${rt.delta >= 0n ? "+" : ""}${rt.delta} raw`,
              endPos: mid.position.toFixed(4),
            });

            expect(
              rt.delta,
              `deep-CP same-side round-trip leaked at ${fractionBps}bps under ${presetName} (delta=${rt.delta})`
            ).to.be.lessThanOrEqual(ROUNDING_BUDGET_RAW);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== A) Deep-CP round-trip — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // B) Deep-CP cross-anchor round-trip
      // -------------------------------------------------------------------
      it("B) Cross-anchor round-trip into deep CP (preDep + 99% drain) is non-positive", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        // Pre-deplete one side so the pool starts in `position > 0.5`,
        // then drain ≥ 99 % of the *current* opposite reserve so the
        // forward leg crosses the anchor and lands in the deep CP
        // tail of the mirror side.
        const preDeps: bigint[] = [3_000n, 5_000n, 7_000n];

        for (const preDep of preDeps) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            await deplete(fx, "quote", preDep);
            const before = await snapshotPool(fx);
            const sized = await bisectAmountInForFraction(
              fx,
              fx.quoteAddr,
              before.reserveBaseRaw,
              9_900n // 99 %
            );
            if (sized.amountIn === 0n) continue;

            const rt = await tradeRoundTrip(fx, fx.attacker, {
              inToken: fx.quoteAddr,
              outToken: fx.baseAddr,
              amountIn: sized.amountIn,
            });
            const after = await snapshotPool(fx);
            const crossed = (before.position - 0.5) * (after.position - 0.5) < 0;

            rows.push({
              preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
              posBefore: before.position.toFixed(4),
              posAfter: after.position.toFixed(4),
              crossed: crossed ? "yes" : "no",
              reachable: sized.reachable ? "yes" : "max-effort",
              usdtIn: fmtQuote(sized.amountIn),
              usdtBack: fmtQuote(rt.outAmount),
              delta: `${rt.delta >= 0n ? "+" : ""}${rt.delta} raw`,
            });

            expect(
              rt.delta,
              `cross-anchor deep-CP round-trip leaked (preDep=${preDep}bps) under ${presetName} (delta=${rt.delta})`
            ).to.be.lessThanOrEqual(ROUNDING_BUDGET_RAW);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== B) Cross-anchor deep-CP round-trip — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // C) Batched-vs-single in deep CP
      // -------------------------------------------------------------------
      it("C) Splitting a deep-CP swap (target 99% drain) never beats a single swap", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        const before = await snapshotPool(fx);
        const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, 9_900n);
        if (sized.amountIn === 0n) {
          this.skip();
          return;
        }

        // Single-pass benchmark.
        const singleSnap = await hre.network.provider.send("evm_snapshot", []);
        let singleOut = 0n;
        try {
          const single = await exactInputSingle(fx, fx.attacker, {
            tokenIn: fx.quoteAddr,
            tokenOut: fx.baseAddr,
            amountIn: sized.amountIn,
          });
          singleOut = single.amountOut;
        } finally {
          await hre.network.provider.send("evm_revert", [singleSnap]);
        }

        for (const splits of [10, 50, 200]) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const chunkIn = sized.amountIn / BigInt(splits);
            if (chunkIn === 0n) continue;

            let totalOut = 0n;
            let abandoned = false;
            for (let i = 0; i < splits; i++) {
              try {
                const r = await exactInputSingle(fx, fx.attacker, {
                  tokenIn: fx.quoteAddr,
                  tokenOut: fx.baseAddr,
                  amountIn: chunkIn,
                });
                totalOut += r.amountOut;
              } catch {
                // Solver may reject the trailing chunks once the BASE
                // reserve hits the depletion clamp. Stop the split run
                // and compare what was actually filled vs the single
                // benchmark — the assertion still holds (split ≤ single).
                abandoned = true;
                break;
              }
            }

            rows.push({
              splits,
              chunkIn: fmtQuote(chunkIn),
              totalIn: fmtQuote(chunkIn * BigInt(splits)),
              totalOut: fmtBase(totalOut, fx.preset.name),
              singleOut: fmtBase(singleOut, fx.preset.name),
              advantage: `${totalOut > singleOut ? "+" : ""}${totalOut - singleOut} raw`,
              abandoned: abandoned ? "yes" : "no",
            });

            // Only assert when the split actually completed; partial
            // splits cannot beat the single by construction (they
            // moved less input through the pool).
            if (!abandoned) {
              expect(
                totalOut,
                `batched deep-CP split (${splits}) beat the single under ${presetName} by ${totalOut - singleOut} raw`
              ).to.be.lessThanOrEqual(singleOut + ROUNDING_BUDGET_RAW);
            }
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== C) Batched-vs-single deep CP — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // D) Swap-into-CP + addLiquidity + swap-back + removeLiquidity
      // -------------------------------------------------------------------
      it("D) Swap-into-CP + addLiquidity + swap-back + removeLiquidity does not extract value", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        for (const fractionBps of DEEP_CP_FRACTIONS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const before = await snapshotPool(fx);
            const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, fractionBps);
            if (sized.amountIn === 0n) continue;

            const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            // Step 1 — push deep into the CP zone.
            const fwd = await exactInputSingle(fx, fx.attacker, {
              tokenIn: fx.quoteAddr,
              tokenOut: fx.baseAddr,
              amountIn: sized.amountIn,
            });
            const midState = await snapshotPool(fx);

            // Step 2 — mint LP at the imbalanced state. The amounts
            // are notionally sized as a tenth of the current QUOTE
            // reserve so the schedule fits the pool's wallet
            // requirements; the proportional re-shaping is done
            // against the live ratio.
            const notionalQuote = (midState.reserveQuoteRaw * 1_000n) / BPS; // 10 % of current quote
            const propAmounts = await proportionalAddAmounts(fx, notionalQuote);
            const sharesMinted = await addLiquidityAt(fx, fx.attacker, propAmounts.quoteRaw, propAmounts.baseRaw);

            // Step 3 — return the swap.
            await exactInputSingle(fx, fx.attacker, {
              tokenIn: fx.baseAddr,
              tokenOut: fx.quoteAddr,
              amountIn: fwd.amountOut,
            });

            // Step 4 — burn the LP slice.
            await removeLiquidityShares(fx, fx.attacker, sharesMinted);

            const after = await snapshotPool(fx);
            const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            const quoteDelta = balAfterQuote - balBeforeQuote;
            const baseDelta = balAfterBase - balBeforeBase;
            const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);
            const poolValueDeltaWad = after.poolValueQuoteWad - before.poolValueQuoteWad;

            rows.push({
              targetDrain: `${(Number(fractionBps) / 100).toFixed(1)}%`,
              "attacker quote Δ": `${quoteDelta >= 0n ? "+" : ""}${quoteDelta}`,
              "attacker base Δ": `${baseDelta >= 0n ? "+" : ""}${baseDelta}`,
              "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
              "pool USD Δ": `${poolValueDeltaWad >= 0n ? "+" : ""}${fmtWad(poolValueDeltaWad, 8)}`,
              shares: sharesMinted.toString(),
            });

            expect(
              attackerUsdWad <= ATTACKER_USD_BUDGET_WAD_PER_LEG,
              `attacker extracted USD value (target=${fractionBps}bps): ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(ATTACKER_USD_BUDGET_WAD_PER_LEG, 12)}) under ${presetName}`
            ).to.equal(true);
            expect(
              poolValueDeltaWad >= -ATTACKER_USD_BUDGET_WAD_PER_LEG,
              `pool USD value dropped (target=${fractionBps}bps): ${fmtWad(poolValueDeltaWad, 12)} under ${presetName}`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== D) Swap+CP + add + back + remove — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // D') Swap-into-CP + addLiquidity + removeLiquidity + swap-back
      //
      // Variation of D where the attacker burns the LP slice BEFORE
      // running the return swap. This re-orders the closing legs so
      // the attacker re-collects their proportional share at the
      // imbalanced state (rich in USDT, poor in WETH) and then
      // executes the return swap from outside the pool. Tests that
      // the proportional-burn-at-imbalance + post-burn-swap path
      // does not extract value beyond rounding.
      // -------------------------------------------------------------------
      it("D') Swap-into-CP + addLiquidity + removeLiquidity + swap-back does not extract value", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        for (const fractionBps of DEEP_CP_FRACTIONS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const before = await snapshotPool(fx);
            const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, fractionBps);
            if (sized.amountIn === 0n) continue;

            const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            // Step 1 — push deep into the CP zone.
            const fwd = await exactInputSingle(fx, fx.attacker, {
              tokenIn: fx.quoteAddr,
              tokenOut: fx.baseAddr,
              amountIn: sized.amountIn,
            });
            const midState = await snapshotPool(fx);

            // Step 2 — proportional mint at the imbalanced state.
            const notionalQuote = (midState.reserveQuoteRaw * 1_000n) / BPS;
            const propAmounts = await proportionalAddAmounts(fx, notionalQuote);
            const sharesMinted = await addLiquidityAt(fx, fx.attacker, propAmounts.quoteRaw, propAmounts.baseRaw);

            // Step 3 — burn LP at the imbalanced state (before return).
            await removeLiquidityShares(fx, fx.attacker, sharesMinted);

            // Step 4 — return swap with whatever WETH the attacker
            // still holds (swap1 output + LP-burn proportional WETH).
            const wethStillOwned = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress())) - balBeforeBase;
            void fwd;
            if (wethStillOwned > 0n) {
              await exactInputSingle(fx, fx.attacker, {
                tokenIn: fx.baseAddr,
                tokenOut: fx.quoteAddr,
                amountIn: wethStillOwned,
              });
            }

            const after = await snapshotPool(fx);
            const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            const quoteDelta = balAfterQuote - balBeforeQuote;
            const baseDelta = balAfterBase - balBeforeBase;
            const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);
            const poolValueDeltaWad = after.poolValueQuoteWad - before.poolValueQuoteWad;

            rows.push({
              targetDrain: `${(Number(fractionBps) / 100).toFixed(1)}%`,
              "attacker quote Δ": `${quoteDelta >= 0n ? "+" : ""}${quoteDelta}`,
              "attacker base Δ": `${baseDelta >= 0n ? "+" : ""}${baseDelta}`,
              "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
              "pool USD Δ": `${poolValueDeltaWad >= 0n ? "+" : ""}${fmtWad(poolValueDeltaWad, 8)}`,
              shares: sharesMinted.toString(),
            });

            expect(
              attackerUsdWad <= ATTACKER_USD_BUDGET_WAD_PER_LEG,
              `D' attacker extracted USD value (target=${fractionBps}bps): ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(ATTACKER_USD_BUDGET_WAD_PER_LEG, 12)}) under ${presetName}`
            ).to.equal(true);
            expect(
              poolValueDeltaWad >= -ATTACKER_USD_BUDGET_WAD_PER_LEG,
              `D' pool USD value dropped (target=${fractionBps}bps): ${fmtWad(poolValueDeltaWad, 12)} under ${presetName}`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== D') Swap+CP + add + remove + back — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // D.prod) Same scenario as D, but at production fee preset.
      //
      // Production preset is the canonical operator-deployed config:
      // smoothstep dynamic fee 100→220bps (WBTC) / 200→220bps (WETH),
      // EMA + auto-repeg active. The attacker's USD-Δ should be even
      // less favourable than at the 1bps regression preset because
      // the swap legs absorb a larger fee fraction.
      // -------------------------------------------------------------------
      it("D.prod) Swap-into-CP + add + back + remove is non-positive under production fees", async function () {
        const fx = await loadFixture(prodFixtureFor);
        const rows: any[] = [];

        for (const fractionBps of DEEP_CP_FRACTIONS_BPS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const before = await snapshotPool(fx);
            const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, fractionBps);
            if (sized.amountIn === 0n) continue;

            const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            const fwd = await exactInputSingle(fx, fx.attacker, {
              tokenIn: fx.quoteAddr,
              tokenOut: fx.baseAddr,
              amountIn: sized.amountIn,
            });
            const midState = await snapshotPool(fx);
            const notionalQuote = (midState.reserveQuoteRaw * 1_000n) / BPS;
            const propAmounts = await proportionalAddAmounts(fx, notionalQuote);
            const sharesMinted = await addLiquidityAt(fx, fx.attacker, propAmounts.quoteRaw, propAmounts.baseRaw);
            await exactInputSingle(fx, fx.attacker, {
              tokenIn: fx.baseAddr,
              tokenOut: fx.quoteAddr,
              amountIn: fwd.amountOut,
            });
            await removeLiquidityShares(fx, fx.attacker, sharesMinted);

            const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            const quoteDelta = balAfterQuote - balBeforeQuote;
            const baseDelta = balAfterBase - balBeforeBase;
            const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);

            rows.push({
              targetDrain: `${(Number(fractionBps) / 100).toFixed(1)}%`,
              "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
              shares: sharesMinted.toString(),
            });

            expect(
              attackerUsdWad <= ATTACKER_USD_BUDGET_WAD_PER_LEG,
              `D.prod attacker extracted USD value (target=${fractionBps}bps): ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(ATTACKER_USD_BUDGET_WAD_PER_LEG, 12)}) under ${presetName}`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== D.prod) Swap+CP + add + back + remove — ${presetName} (prod fees) ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // E) addLiquidity-first JIT attack — bounded fee-accrual only
      //
      // A JIT LP **legitimately earns** a proportional share of the
      // swap fees during their own round-trip (this is how LP works
      // by design). The attack vector to guard against is *amplified*
      // PnL beyond that fee accrual — i.e. the attacker recovering
      // their swap-leg cost faster than the round-trip should allow.
      //
      // Concretely: the attacker may end up `delta_round_trip + fees`
      // ahead of a no-LP baseline; that's just legitimate fees. Any
      // further improvement is a leak. We bound the legitimate gain
      // by `share × 2·forwardLeg × fee_rate` (round-trip volume) and
      // hard-assert the attacker's net USD stays inside that budget.
      // -------------------------------------------------------------------
      it("E) Mint LP → swap-into-CP → swap-back → burn LP earns at most the legitimate fee share", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        const before = await snapshotPool(fx);
        const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, 9_700n);
        if (sized.amountIn === 0n) {
          this.skip();
          return;
        }

        // Baseline: same swap pair without an LP touch.
        const baselineSnap = await hre.network.provider.send("evm_snapshot", []);
        let baselineDelta = 0n;
        try {
          const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
          await tradeRoundTrip(fx, fx.attacker, {
            inToken: fx.quoteAddr,
            outToken: fx.baseAddr,
            amountIn: sized.amountIn,
          });
          const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
          baselineDelta = balAfterQuote - balBeforeQuote;
        } finally {
          await hre.network.provider.send("evm_revert", [baselineSnap]);
        }

        const snap = await hre.network.provider.send("evm_snapshot", []);
        try {
          const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
          const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

          const notionalQuote = (fx.initialQuoteRaw * 500n) / BPS; // 5 %
          const propAmounts = await proportionalAddAmounts(fx, notionalQuote);
          const shares = await addLiquidityAt(fx, fx.attacker, propAmounts.quoteRaw, propAmounts.baseRaw);

          await tradeRoundTrip(fx, fx.attacker, {
            inToken: fx.quoteAddr,
            outToken: fx.baseAddr,
            amountIn: sized.amountIn,
          });

          await removeLiquidityShares(fx, fx.attacker, shares);

          const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
          const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
          const quoteDelta = balAfterQuote - balBeforeQuote;
          const baseDelta = balAfterBase - balBeforeBase;
          const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);

          // Legitimate fee accrual ceiling: attacker owns at most
          // `notionalQuote / pool_value` of the LP supply, and the
          // round-trip fires fees on `~2 × sized.amountIn` of volume
          // at `fx.preset.baseFee` bps. Cap the legitimate gain at
          // `share · 2 · sized · feeBps / BPS` — anything beyond
          // would mean the LP slice captured value the swap fee did
          // not generate.
          const feeBudgetWad = (sized.amountIn * 2n * BigInt(fx.preset.baseFee) * WAD) / (10n ** 6n * BPS);
          const totalBudgetWad = ATTACKER_USD_BUDGET_WAD_PER_LEG + feeBudgetWad;

          rows.push({
            scenario: "JIT LP + round-trip",
            "baseline rt Δ": `${baselineDelta >= 0n ? "+" : ""}${baselineDelta}`,
            "JIT quote Δ": `${quoteDelta >= 0n ? "+" : ""}${quoteDelta}`,
            "JIT base Δ": `${baseDelta >= 0n ? "+" : ""}${baseDelta}`,
            "JIT USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
            "fee budget USD": fmtWad(feeBudgetWad, 8),
            shares: shares.toString(),
          });

          expect(
            attackerUsdWad <= totalBudgetWad,
            `JIT-LP attack extracted USD value beyond legitimate fee accrual: ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(totalBudgetWad, 12)}) under ${presetName}`
          ).to.equal(true);
        } finally {
          await hre.network.provider.send("evm_revert", [snap]);
        }

        console.log(`\n=== E) JIT-LP wrap — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // E.prod) Same JIT-LP scenario but under production fees.
      //
      // The smoothstep dynamic fee ramps to ceiling at deep imbalance
      // (220bps for both presets), so the legitimate fee-accrual
      // budget is much larger and the attacker's share of those fees
      // is the only legal gain. The hard-assert keeps `attackerUsdΔ
      // ≤ shareOfRoundTripFees + rounding` so amplified PnL beyond
      // legal fees still fails the test.
      // -------------------------------------------------------------------
      it("E.prod) Mint LP → swap-into-CP → swap-back → burn LP under production fees", async function () {
        const fx = await loadFixture(prodFixtureFor);
        const rows: any[] = [];

        const before = await snapshotPool(fx);
        const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, 9_700n);
        if (sized.amountIn === 0n) {
          this.skip();
          return;
        }

        const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

        const notionalQuote = (fx.initialQuoteRaw * 500n) / BPS;
        const propAmounts = await proportionalAddAmounts(fx, notionalQuote);
        const shares = await addLiquidityAt(fx, fx.attacker, propAmounts.quoteRaw, propAmounts.baseRaw);
        await tradeRoundTrip(fx, fx.attacker, {
          inToken: fx.quoteAddr,
          outToken: fx.baseAddr,
          amountIn: sized.amountIn,
        });
        await removeLiquidityShares(fx, fx.attacker, shares);

        const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
        const quoteDelta = balAfterQuote - balBeforeQuote;
        const baseDelta = balAfterBase - balBeforeBase;
        const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);

        // Production fee ceiling — legitimate accrual budget at the
        // smoothstep ceiling (`fx.preset.baseFee` bps).
        const feeBudgetWad = (sized.amountIn * 2n * BigInt(fx.preset.baseFee) * WAD) / (10n ** 6n * BPS);
        const totalBudgetWad = ATTACKER_USD_BUDGET_WAD_PER_LEG + feeBudgetWad;

        rows.push({
          scenario: "JIT LP + round-trip @ prod fees",
          "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
          "fee budget USD": fmtWad(feeBudgetWad, 8),
          shares: shares.toString(),
        });

        expect(
          attackerUsdWad <= totalBudgetWad,
          `E.prod JIT-LP attack extracted USD beyond fee accrual: ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(totalBudgetWad, 12)}) under ${presetName}`
        ).to.equal(true);

        console.log(`\n=== E.prod) JIT-LP wrap @ prod fees — ${presetName} ===`);
        console.table(rows);
      });

      // -------------------------------------------------------------------
      // F) LP-sandwich exit — production-fees regression
      //
      // Attack flow: addLP at balanced → swap deep into CP zone →
      // burn LP at the imbalanced state → swap back.
      //
      // Mathematical context: a deep-CP forward swap pushes the pool
      // into a region where its anchor-priced reserves are *richer*
      // than at start (the trader paid more units of input than the
      // exchanged output is worth at reference price). An attacker
      // who burns proportional LP between the two swap legs locks in
      // that imbalance gain on their slice and hands the symmetric
      // loss (return-to-balance via swap2) to the remaining LPs. The
      // same imbalanced-exit primitive exists in every proportional
      // remove-liquidity AMM, including Curve V2's twocrypto.
      //
      // Realistic mitigation comes from **swap fees + auto-repeg**:
      // the round-trip burns enough notional through the dynamic-fee
      // ramp that the attacker's fee bill exceeds the imbalanced-exit
      // gain. This test runs the attack against the production preset
      // (`fee_bps = 220`, dynamic ramp on, `repeg_share_bps = 5_000`)
      // and hard-asserts the attack is unprofitable. The fee floor
      // here is a *design parameter* — operators must keep
      // `feeBps × feeRampBps` configured high enough to neutralise
      // this primitive.
      // -------------------------------------------------------------------
      it("F) LP-sandwich exit at deep CP is unprofitable under production fees", async function () {
        const fx = await loadFixture(prodFixtureFor);
        const rows: any[] = [];

        // Capture BOTH attacker balances and pool snapshot BEFORE
        // the LP deposit so the attacker-USD-Δ accounts for the full
        // primitive — including the LP mint cost. The earlier
        // version snapshotted balances *after* the mint, which
        // silently excluded the deposit and produced an apparently
        // positive +$84K figure that did not account for the
        // principal locked in shares.
        const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
        const before = await snapshotPool(fx);

        // Step 0 — attacker becomes a real LP at the balanced state
        // with a 10 % notional position.
        const sharesPretrade = await addLiquidityAt(
          fx,
          fx.attacker,
          (fx.initialQuoteRaw * 1_000n) / BPS,
          (fx.initialBaseRaw * 1_000n) / BPS
        );

        const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, 9_700n);
        if (sized.amountIn === 0n) {
          this.skip();
          return;
        }

        const fwd = await exactInputSingle(fx, fx.attacker, {
          tokenIn: fx.quoteAddr,
          tokenOut: fx.baseAddr,
          amountIn: sized.amountIn,
        });
        await removeLiquidityShares(fx, fx.attacker, sharesPretrade);
        await exactInputSingle(fx, fx.attacker, {
          tokenIn: fx.baseAddr,
          tokenOut: fx.quoteAddr,
          amountIn: fwd.amountOut,
        });

        const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
        const quoteDelta = balAfterQuote - balBeforeQuote;
        const baseDelta = balAfterBase - balBeforeBase;
        const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);
        const after = await snapshotPool(fx);

        rows.push({
          scenario: "LP-sandwich exit @ 97% (prod fees)",
          baseFee: `${fx.preset.baseFee} bps`,
          feeRampBps: `${fx.preset.feeRampBps}`,
          repegShareBps: `${fx.preset.repegShareBps}`,
          "swap1 amountIn (raw)": sized.amountIn.toString(),
          "swap1 amountIn (quote dec)": fmtQuote(sized.amountIn),
          "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
          "pool USD Δ": `${after.poolValueQuoteWad - before.poolValueQuoteWad >= 0n ? "+" : ""}${fmtWad(after.poolValueQuoteWad - before.poolValueQuoteWad, 8)}`,
          shares: sharesPretrade.toString(),
        });

        console.log(`\n=== F) LP-sandwich exit @ prod fees — ${presetName} ===`);
        console.table(rows);

        // Production-fees hard-assertion: the full LP-sandwich
        // primitive (mint LP → swap-into-CP → burn LP → swap-back)
        // must net negative for the attacker. The bug-free measurement
        // captures the LP deposit cost as part of the attacker's
        // balance delta, so the net Δ accounts for principal-at-risk.
        // Allow up to a small positive budget for wei-rounding noise.
        expect(
          attackerUsdWad <= ATTACKER_USD_BUDGET_WAD_PER_LEG,
          `LP-sandwich exit extracted USD under production fees: ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(ATTACKER_USD_BUDGET_WAD_PER_LEG, 12)}) under ${presetName}`
        ).to.equal(true);
      });

      // -------------------------------------------------------------------
      // F.sweep) LP-sandwich profitability sweep
      //
      // Scan a range of swap1 sizes (multiples of the seeded USDT
      // reserve) and report the attacker's USD-Δ at each size. Helps
      // identify the *optimal* attack size and verify whether F's
      // measurement at the bisection cap reflects the global maximum
      // or a local point on the surface. Diagnostic-only.
      // -------------------------------------------------------------------
      it("F.sweep) profitability surface across swap1 sizes × repegShareBps (diagnostic, prod fees)", async function () {
        this.timeout(900_000);
        const sweepMultipliers: bigint[] = [1n, 10n, 25n, 50n, 100n, 256n];
        // The diagnostic shows that `repegShareBps` does NOT
        // influence single-block atomic LP-sandwich extraction:
        // numbers are identical to four decimals across the full
        // [0, 10_000] range. The auto-repeg gate fires at most once
        // per block (`_lastRepegTs` guard) and `repegStepWad` is
        // capped well below the imbalance. We probe the post-floor
        // range as the canonical regression coverage.
        const shareSweep: number[] = [5000, 7500, 10000];
        const sweepRows: any[] = [];
        for (const share of shareSweep) {
          const shareFixturePreset = buildPreset(presetName, {
            baseFee: prodPreset.feeBps,
            feeRampBps: prodPreset.feeRampBps,
            feeFloorBps: prodPreset.feeFloorBps,
            repegShareBps: share,
          });
          const shareFixture = async () => deploySecurityFixture(shareFixturePreset);
          for (const mul of sweepMultipliers) {
            const fx = await loadFixture(shareFixture);
            // Capture balances BEFORE the LP deposit so the attacker-USD-Δ
            // accounts for the full sandwich primitive: deposit cost,
            // imbalanced exit, both swap legs.
            const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

            const sharesPretrade = await addLiquidityAt(
              fx,
              fx.attacker,
              (fx.initialQuoteRaw * 1_000n) / BPS,
              (fx.initialBaseRaw * 1_000n) / BPS
            );

            const swap1AmountIn = fx.initialQuoteRaw * mul;
            // Skip if attacker can't afford this size.
            const attackerUsdtBal = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            if (swap1AmountIn > attackerUsdtBal) {
              sweepRows.push({
                "swap1 ×reserve": `${mul}×`,
                "swap1 (raw)": swap1AmountIn.toString(),
                "attacker USD Δ": "skipped (insufficient balance)",
              });
              continue;
            }

            let fwdAmountOut: bigint = 0n;
            try {
              const fwd = await exactInputSingle(fx, fx.attacker, {
                tokenIn: fx.quoteAddr,
                tokenOut: fx.baseAddr,
                amountIn: swap1AmountIn,
              });
              fwdAmountOut = fwd.amountOut;
            } catch {
              sweepRows.push({
                "swap1 ×reserve": `${mul}×`,
                "swap1 (raw)": swap1AmountIn.toString(),
                "attacker USD Δ": "swap1 reverted",
              });
              continue;
            }
            await removeLiquidityShares(fx, fx.attacker, sharesPretrade);
            if (fwdAmountOut > 0n) {
              try {
                await exactInputSingle(fx, fx.attacker, {
                  tokenIn: fx.baseAddr,
                  tokenOut: fx.quoteAddr,
                  amountIn: fwdAmountOut,
                });
              } catch {
                // swap2 may revert if pool is too imbalanced; attacker
                // keeps the stranded base position.
              }
            }

            const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
            const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
            const quoteDelta = balAfterQuote - balBeforeQuote;
            const baseDelta = balAfterBase - balBeforeBase;
            const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);
            sweepRows.push({
              "share (bps)": share,
              "swap1 ×reserve": `${mul}×`,
              "swap1 (USDT)": fmtQuote(swap1AmountIn),
              "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 4)}`,
            });
          }
        }
        console.log(`\n=== F.sweep) LP-sandwich profitability surface — ${presetName} (prod fees, varying share) ===`);
        console.table(sweepRows);
      });

      // -------------------------------------------------------------------
      // F') LP-sandwich exit — diagnostic at near-zero fees
      //
      // Same scenario as F) but with the test-suite-wide curve-only
      // settings (`feeBps = 1`, `repegShareBps = 0`). We DO NOT hard
      // assert here — the attack is theoretically extractable in this
      // regime and the diagnostic table makes the magnitude visible
      // for monitoring. Production fee settings (covered by F) are
      // the safety net.
      // -------------------------------------------------------------------
      it("F') LP-sandwich exit at near-zero fees is bounded by the round-trip + IL identity (diagnostic)", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        // Capture BOTH attacker balances and pool snapshot BEFORE the
        // LP deposit so the value-conservation invariant (pool Δ +
        // attacker Δ ≈ 0) holds. Otherwise the LP principal would be
        // double-counted (attacker side excludes it, pool side
        // includes it).
        const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
        const before = await snapshotPool(fx);

        const sharesPretrade = await addLiquidityAt(
          fx,
          fx.attacker,
          (fx.initialQuoteRaw * 1_000n) / BPS,
          (fx.initialBaseRaw * 1_000n) / BPS
        );

        const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, before.reserveBaseRaw, 9_700n);
        if (sized.amountIn === 0n) {
          this.skip();
          return;
        }

        const fwd = await exactInputSingle(fx, fx.attacker, {
          tokenIn: fx.quoteAddr,
          tokenOut: fx.baseAddr,
          amountIn: sized.amountIn,
        });
        await removeLiquidityShares(fx, fx.attacker, sharesPretrade);
        await exactInputSingle(fx, fx.attacker, {
          tokenIn: fx.baseAddr,
          tokenOut: fx.quoteAddr,
          amountIn: fwd.amountOut,
        });

        const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
        const quoteDelta = balAfterQuote - balBeforeQuote;
        const baseDelta = balAfterBase - balBeforeBase;
        const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);
        const after = await snapshotPool(fx);

        rows.push({
          scenario: "LP-sandwich exit @ 97% (1 bps fee, repeg off)",
          "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
          "pool USD Δ": `${after.poolValueQuoteWad - before.poolValueQuoteWad >= 0n ? "+" : ""}${fmtWad(after.poolValueQuoteWad - before.poolValueQuoteWad, 8)}`,
          shares: sharesPretrade.toString(),
        });

        console.log(`\n=== F') LP-sandwich exit DIAGNOSTIC @ 1bps — ${presetName} ===`);
        console.table(rows);
        if (attackerUsdWad > 0n) {
          console.log(
            `    note: imbalanced-exit primitive extracted ${fmtWad(attackerUsdWad, 8)} USD-WAD. ` +
              `Production fee preset (covered by F) closes this window.`
          );
        }

        // Sanity sanity guard: pool value lost MUST equal attacker
        // gain (modulo wei-rounding) — i.e. the attack never creates
        // value out of thin air, it only redistributes from passive
        // LPs to the sandwich attacker.
        const conservationDeltaWad = after.poolValueQuoteWad - before.poolValueQuoteWad + attackerUsdWad;
        const conservationBudgetWad = ATTACKER_USD_BUDGET_WAD_PER_LEG * 4n; // generous wei-rounding pad.
        expect(
          conservationDeltaWad >= -conservationBudgetWad && conservationDeltaWad <= conservationBudgetWad,
          `value conservation broke (${fmtWad(conservationDeltaWad, 12)} USD-WAD pool+attacker) under ${presetName}`
        ).to.equal(true);
      });

      // -------------------------------------------------------------------
      // G) Multi-cycle CP-zone zigzag
      // -------------------------------------------------------------------
      it("G) Multi-cycle CP-zone zigzag does not drain the pool", async function () {
        const fx = await loadFixture(fixtureFor);
        const before = await snapshotPool(fx);
        const balBeforeQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balBeforeBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));

        // Each cycle sizes the swap to drain ~95 % of the *current*
        // BASE reserve so every iteration spends time deep in the CP
        // tail. The notional LP touch is 5 % of the current QUOTE
        // reserve.
        for (let i = 0; i < ZIGZAG_CYCLES; i++) {
          const cur = await snapshotPool(fx);
          const sized = await bisectAmountInForFraction(fx, fx.quoteAddr, cur.reserveBaseRaw, 9_500n);
          if (sized.amountIn === 0n) break;

          await tradeRoundTrip(fx, fx.attacker, {
            inToken: fx.quoteAddr,
            outToken: fx.baseAddr,
            amountIn: sized.amountIn,
          });

          const noteQuote = (cur.reserveQuoteRaw * 500n) / BPS;
          const propAmounts = await proportionalAddAmounts(fx, noteQuote);
          const shares = await addLiquidityAt(fx, fx.attacker, propAmounts.quoteRaw, propAmounts.baseRaw);
          await removeLiquidityShares(fx, fx.attacker, shares);
        }

        const after = await snapshotPool(fx);
        const balAfterQuote = BigInt(await fx.quote.balanceOf(await fx.attacker.getAddress()));
        const balAfterBase = BigInt(await fx.base.balanceOf(await fx.attacker.getAddress()));
        const quoteDelta = balAfterQuote - balBeforeQuote;
        const baseDelta = balAfterBase - balBeforeBase;
        const attackerUsdWad = deltaToUsdWad(fx, quoteDelta, baseDelta);
        const poolValueDeltaWad = after.poolValueQuoteWad - before.poolValueQuoteWad;

        const cycleBudgetWad = ATTACKER_USD_BUDGET_WAD_PER_LEG * BigInt(ZIGZAG_CYCLES);
        console.log(`\n=== G) Multi-cycle zigzag (${ZIGZAG_CYCLES} rounds) — ${presetName} ===`);
        console.table({
          "attacker quote Δ": `${quoteDelta >= 0n ? "+" : ""}${quoteDelta}`,
          "attacker base Δ": `${baseDelta >= 0n ? "+" : ""}${baseDelta}`,
          "attacker USD Δ": `${attackerUsdWad >= 0n ? "+" : ""}${fmtWad(attackerUsdWad, 8)}`,
          "pool USD Δ": `${poolValueDeltaWad >= 0n ? "+" : ""}${fmtWad(poolValueDeltaWad, 8)}`,
          "budget USD": `${fmtWad(cycleBudgetWad, 8)}`,
        });

        expect(
          attackerUsdWad <= cycleBudgetWad,
          `zigzag attacker extracted USD value: ${fmtWad(attackerUsdWad, 12)} (budget=${fmtWad(cycleBudgetWad, 12)}) under ${presetName}`
        ).to.equal(true);
        expect(
          poolValueDeltaWad >= -cycleBudgetWad,
          `pool USD value dropped over zigzag: ${fmtWad(poolValueDeltaWad, 12)} (budget=${fmtWad(cycleBudgetWad, 12)}) under ${presetName}`
        ).to.equal(true);
      });
    });
  }
});
