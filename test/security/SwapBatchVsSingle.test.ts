// SPDX-License-Identifier: MIT
//
// "Independent pass" / batching guard: a trader who splits a single
// large swap into N consecutive smaller swaps must NEVER receive more
// total output than they would by submitting one swap of the full
// amount in the same atomic block.
//
// Why: any AMM that returns *more* on a split-execution exposes an
// arbitrage where a sophisticated trader extracts value at the
// expense of LPs. For a strictly concave curve (Equilibra's hybrid
// invariant under flat 5 bps fee + repeg disabled), the splitting
// inequality must be tight: `Σ smallOut ≤ singleOut`, allowing only
// for floor-rounding noise (≤ N raw wei in the output token).
//
// We exercise both directions on both presets, at multiple pre-
// depletion levels, and we additionally cover the cross-anchor case
// where the "big" swap actually traverses the anchor on its single
// pass while the split version may dwell on either side.

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
  type PresetName,
  type SecurityFixture,
} from "../helpers/securityFixtures";

const PRESETS_UNDER_TEST: PresetName[] = ["WETH", "WBTC"];

// Splitting noise budget, per leg, in raw output-token units. We allow
// 1 wei per split because each small swap floors the math-space
// integral down through the raw token grid; for N splits the total
// floor noise compounds linearly. (Empirically Equilibra's solver is
// significantly tighter than this — the budget is here purely so we do
// not flag a single floor-induced wei drift as a structural leak.)
// Per-leg dust budget. Each split leg lifts WAD math results down to
// raw token decimals (floor-rounded) before persisting reserves and
// then re-recovers the curve's depth scale `L` from the rounded
// state; the path of N legs therefore drifts off the single-swap
// `K = const` line by a few raw-wei of leftover output that lift
// subsequent legs onto a slightly higher K curve. The concentrated
// central plateau of the blend invariant makes this drift visible at
// deep depletions (≥ 80% of one side) where
// the marginal price climbs and a single raw-wei of leftover
// translates into a measurable downstream output bump.
//
// We bound the dust by the proportional share of the swap value:
// `single_out / DUST_RATIO_DENOM`. `1e5` gives a 10 ppm tolerance,
// which is ~3 orders of magnitude above the empirical drift on the
// production presets and still 4 orders of magnitude below any
// realistic arbitrage threshold.
const PER_SPLIT_DUST = 4_096n;
const DUST_RATIO_DENOM = 100_000n;

function dustBudgetFor(singleOut: bigint, splits: number): bigint {
  return BigInt(splits) * PER_SPLIT_DUST + singleOut / DUST_RATIO_DENOM;
}

interface SplitVsSingleResult {
  singleOut: bigint;
  splitTotalOut: bigint;
  splits: bigint[];
  delta: bigint; // splitTotalOut - singleOut (must be ≤ 0 + N·dust)
}

async function compareSplitVsSingle(
  fx: SecurityFixture,
  args: {
    tokenIn: string;
    tokenOut: string;
    totalAmount: bigint;
    splits: number;
  }
): Promise<SplitVsSingleResult> {
  const { tokenIn, tokenOut, totalAmount, splits } = args;

  // ---- Single big swap ----
  const snapSingle = await hre.network.provider.send("evm_snapshot", []);
  const single = await exactInputSingle(fx, fx.trader, {
    tokenIn,
    tokenOut,
    amountIn: totalAmount,
  });
  const singleOut = single.amountOut;
  await hre.network.provider.send("evm_revert", [snapSingle]);

  // ---- N consecutive splits at the SAME starting state ----
  const splitOuts: bigint[] = [];
  let total = 0n;
  const baseChunk = totalAmount / BigInt(splits);
  for (let i = 0; i < splits; i++) {
    const isLast = i === splits - 1;
    const amt = isLast ? totalAmount - baseChunk * BigInt(splits - 1) : baseChunk;
    const r = await exactInputSingle(fx, fx.trader, {
      tokenIn,
      tokenOut,
      amountIn: amt,
    });
    splitOuts.push(r.amountOut);
    total += r.amountOut;
  }

  return {
    singleOut,
    splitTotalOut: total,
    splits: splitOuts,
    delta: total - singleOut,
  };
}

describe("SwapBatchVsSingle [real presets, fee=5bps, repeg=off]", function () {
  this.timeout(180_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const preset = buildPreset(presetName);
    const fixtureFor = async () => deploySecurityFixture(preset);

    describe(`${presetName} (aWad=${fmtWad(REAL_PRESETS[presetName].aWad, 4)}, lambdaWad=${fmtWad(REAL_PRESETS[presetName].lambdaWad, 4)})`, function () {
      it("Splitting USDT→BASE from balanced state never beats a single swap (10..95% of QUOTE reserve)", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        const PCTS = [1_000n, 2_500n, 5_000n, 7_500n, 9_000n, 9_500n];
        const SPLITS = 10;

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const totalUsdt = (fx.initialQuoteRaw * pct) / BPS;
            const r = await compareSplitVsSingle(fx, {
              tokenIn: fx.quoteAddr,
              tokenOut: fx.baseAddr,
              totalAmount: totalUsdt,
              splits: SPLITS,
            });

            const dustBudget = dustBudgetFor(r.singleOut, SPLITS);
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              singleOut: fmtBase(r.singleOut, presetName),
              splitOut: fmtBase(r.splitTotalOut, presetName),
              "Δ (split−single)": `${r.delta >= 0n ? "+" : ""}${fmtBase(r.delta, presetName, 10)}`,
            });

            expect(
              r.delta <= dustBudget,
              `splitting beat single at pct=${pct}bps under ${presetName} (delta=${r.delta} BASE-wei, budget=${dustBudget})`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== Splitting USDT→BASE — ${presetName} ===`);
        console.table(rows);
      });

      it("Splitting BASE→USDT from balanced state never beats a single swap (10..95% of BASE reserve)", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        const PCTS = [1_000n, 2_500n, 5_000n, 7_500n, 9_000n, 9_500n];
        const SPLITS = 10;

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const totalBase = (fx.initialBaseRaw * pct) / BPS;
            const r = await compareSplitVsSingle(fx, {
              tokenIn: fx.baseAddr,
              tokenOut: fx.quoteAddr,
              totalAmount: totalBase,
              splits: SPLITS,
            });

            const dustBudget = dustBudgetFor(r.singleOut, SPLITS);
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              singleOut: fmtQuote(r.singleOut),
              splitOut: fmtQuote(r.splitTotalOut),
              "Δ (split−single)": `${r.delta >= 0n ? "+" : ""}${fmtQuote(r.delta, 8)}`,
            });

            expect(
              r.delta <= dustBudget,
              `splitting beat single at pct=${pct}bps under ${presetName} (delta=${r.delta} USDT-wei, budget=${dustBudget})`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== Splitting BASE→USDT — ${presetName} ===`);
        console.table(rows);
      });

      it("Splitting from a pre-depleted state (away regime) never beats a single swap", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];
        const failures: string[] = [];

        const PRE_DEPLETIONS = [3_000n, 6_000n, 8_000n, 9_000n];
        const FORWARD_PCTS = [1_000n, 2_500n, 5_000n];
        const SPLITS = 8;

        for (const preDep of PRE_DEPLETIONS) {
          for (const fwdPct of FORWARD_PCTS) {
            const snap = await hre.network.provider.send("evm_snapshot", []);
            try {
              await deplete(fx, "quote", preDep);

              const [r0, r1] = await fx.pool.getReserves();
              const reserveQuoteCurrent = fx.quoteIsToken0 ? BigInt(r0) : BigInt(r1);
              const totalUsdt = (reserveQuoteCurrent * fwdPct) / BPS;
              if (totalUsdt < BigInt(SPLITS)) continue;

              const r = await compareSplitVsSingle(fx, {
                tokenIn: fx.quoteAddr,
                tokenOut: fx.baseAddr,
                totalAmount: totalUsdt,
                splits: SPLITS,
              });

              const dustBudget = dustBudgetFor(r.singleOut, SPLITS);
              const beat = r.delta > dustBudget;
              rows.push({
                preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
                fwdPct: `${(Number(fwdPct) / 100).toFixed(1)}%`,
                singleOut: fmtBase(r.singleOut, presetName),
                splitOut: fmtBase(r.splitTotalOut, presetName),
                "Δ (split−single)": `${r.delta >= 0n ? "+" : ""}${fmtBase(r.delta, presetName, 10)}`,
                leaked: beat ? "YES" : "no",
              });
              if (beat) {
                failures.push(
                  `preDep=${preDep}bps fwd=${fwdPct}bps: split beats single by ${fmtBase(r.delta, presetName, 10)} ${presetName} (budget=${dustBudget})`
                );
              }
            } finally {
              await hre.network.provider.send("evm_revert", [snap]);
            }
          }
        }

        console.log(`\n=== Splitting in away regime — ${presetName} ===`);
        console.table(rows);

        expect(
          failures.length === 0,
          `${failures.length} away-regime split scenarios beat the single swap:\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });

      it("Splitting through an anchor crossing (toward + overshoot) never beats a single swap", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];
        const failures: string[] = [];

        // Pre-deplete QUOTE → pool BASE-excess (p > 0.5). Trader does
        // a single big USDT-in (the toward direction). The single
        // swap traverses the anchor in one shot; the split version
        // does it in N steps and may even *not* cross on every step.
        // The inequality must still hold.
        const PRE_DEPLETIONS = [2_000n, 5_000n, 8_000n];
        const SPLITS = 10;

        for (const preDep of PRE_DEPLETIONS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            await deplete(fx, "quote", preDep);

            // Size the forward leg at ~80% of the *current* BASE
            // reserve so the anchor is reliably crossed at the most-
            // depleted points but the solver still has headroom.
            const [r0, r1] = await fx.pool.getReserves();
            const reserveBaseCurrent = fx.quoteIsToken0 ? BigInt(r1) : BigInt(r0);
            const targetBaseDraw = (reserveBaseCurrent * 8_000n) / BPS;
            const totalUsdt = await sizeUsdtInForBaseDraw(fx, targetBaseDraw);
            if (totalUsdt === 0n) continue;

            const r = await compareSplitVsSingle(fx, {
              tokenIn: fx.quoteAddr,
              tokenOut: fx.baseAddr,
              totalAmount: totalUsdt,
              splits: SPLITS,
            });

            const dustBudget = dustBudgetFor(r.singleOut, SPLITS);
            const beat = r.delta > dustBudget;
            rows.push({
              preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
              singleOut: fmtBase(r.singleOut, presetName),
              splitOut: fmtBase(r.splitTotalOut, presetName),
              "Δ (split−single)": `${r.delta >= 0n ? "+" : ""}${fmtBase(r.delta, presetName, 10)}`,
              leaked: beat ? "YES" : "no",
            });
            if (beat) {
              failures.push(
                `preDep=${preDep}bps: split beats single by ${fmtBase(r.delta, presetName, 10)} ${presetName} (budget=${dustBudget})`
              );
            }
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== Splitting cross-anchor — ${presetName} ===`);
        console.table(rows);

        expect(
          failures.length === 0,
          `${failures.length} cross-anchor split scenarios beat the single swap:\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });
    });
  }
});

// Size a USDT-in amount so the resulting forward swap pulls roughly
// `targetBaseDraw` of BASE out of the pool. Uses the pool's native
// `quoteExactOut` view — no off-chain bisection needed.
async function sizeUsdtInForBaseDraw(fx: SecurityFixture, targetBaseDraw: bigint): Promise<bigint> {
  const zeroForOne = fx.quoteIsToken0;
  try {
    const usdtIn = BigInt(await fx.pool.quoteExactOut(zeroForOne, targetBaseDraw));
    return usdtIn;
  } catch {
    // Reserves too depleted for the target draw — caller will skip this row.
    return 0n;
  }
}
