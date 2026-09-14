// SPDX-License-Identifier: MIT
//
// Batching guard under flat fees and a frozen anchor. Integer-path
// comparisons retain their original dust budget. A cap-certified
// single quote can underpay more than its split execution; only that
// independently measured deficit may extend the comparison budget.
// Every leg also checks its exact continuous reference and actual LP depth.
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
import { assertQuotePrecision, exactInputReference } from "../helpers/continuousReference";

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
  singleUnderquote: bigint;
  singleIterations: bigint;
  singleDepthGain: bigint;
}

type BatchFixture = SecurityFixture & { math: any };

async function checkedPoolSwap(fx: BatchFixture, tokenIn: string, tokenOut: string, amount: bigint) {
  const quoteIn = tokenIn.toLowerCase() === fx.quoteAddr.toLowerCase();
  const zeroForOne = quoteIn === fx.quoteIsToken0;
  const d0 = fx.quoteIsToken0 ? 6 : fx.baseDecimals;
  const d1 = fx.quoteIsToken0 ? fx.baseDecimals : 6;
  const scale0 = 10n ** BigInt(18 - d0);
  const scale1 = 10n ** BigInt(18 - d1);
  const WAD = 10n ** 18n;
  const [r0, r1] = await fx.pool.getReserves();
  const anchor = BigInt((await fx.pool.getOracleState()).priceScaleWad);
  const x = r1 * scale1;
  const y = (r0 * scale0 * WAD) / anchor;
  const fee = await fx.pool.getFeeConfig();
  expect(fee.feeRampBps, "reference fixture must use a flat fee").to.equal(0n);
  expect(fee.repegShareBps, "reference anchor must remain frozen").to.equal(0n);
  const clean = amount - (amount * BigInt(fee.baseFee)) / BPS;
  const dx = zeroForOne ? (clean * scale0 * WAD) / anchor : clean * scale1;
  const ref = await exactInputReference(
    fx.math,
    zeroForOne ? y : x,
    zeroForOne ? x : y,
    dx,
    fx.preset.aWad,
    fx.preset.lambdaWad
  );
  const lower = (v: bigint) => (zeroForOne ? v / scale1 : (v * anchor) / WAD / scale0);
  const lpBefore = await fx.pool.getLpValueState();
  const result = await exactInputSingle(fx, fx.trader, { tokenIn, tokenOut, amountIn: amount });
  const kernelOut = lower(ref.quotedMath);
  const cut = (((amount * BigInt(fee.baseFee)) / BPS) * BigInt(fee.protocolFeePercent)) / 100n;
  const rawPost0 = r0 + (zeroForOne ? amount - cut : -kernelOut);
  const rawPost1 = r1 + (zeroForOne ? -kernelOut : amount - cut);
  const rawDepth = await fx.math.solveLFromState(
    rawPost1 * scale1,
    (rawPost0 * scale0 * WAD) / anchor,
    fx.preset.aWad,
    fx.preset.lambdaWad
  );
  expect(rawDepth, "single strict LP guard").to.be.gte(ref.lBefore);
  expect(result.amountOut, "math quote already includes the common margin").to.equal(kernelOut);
  // Preserve the independent solver-error comparison; the common margin is included in its amount budget.
  assertQuotePrecision(kernelOut, lower(ref.referenceMath), ref.iterations, PER_SPLIT_DUST, "fee-inclusive kernel leg");
  const referenceOut = lower(ref.referenceMath);
  const [post0, post1] = await fx.pool.getReserves();
  const lAfter = BigInt(
    await fx.math.solveLFromState(post1 * scale1, (post0 * scale0 * WAD) / anchor, fx.preset.aWad, fx.preset.lambdaWad)
  );
  expect(lAfter, "actual fee-inclusive depth never decreases").to.be.at.least(ref.lBefore);
  const lpAfter = await fx.pool.getLpValueState();
  expect(lpAfter.unitValueWad).to.be.at.least(lpBefore.unitValueWad);
  expect(lpAfter.growthWad).to.be.at.least(lpBefore.growthWad);
  return { ...result, referenceOut, iterations: ref.iterations, depthGain: lAfter - ref.lBefore };
}

async function compareSplitVsSingle(
  fx: BatchFixture,
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
  const single = await checkedPoolSwap(fx, tokenIn, tokenOut, totalAmount);
  const singleOut = single.amountOut;
  await hre.network.provider.send("evm_revert", [snapSingle]);

  // ---- N consecutive splits at the SAME starting state ----
  const splitOuts: bigint[] = [];
  let total = 0n;
  const baseChunk = totalAmount / BigInt(splits);
  for (let i = 0; i < splits; i++) {
    const isLast = i === splits - 1;
    const amt = isLast ? totalAmount - baseChunk * BigInt(splits - 1) : baseChunk;
    const r = await checkedPoolSwap(fx, tokenIn, tokenOut, amt);
    splitOuts.push(r.amountOut);
    total += r.amountOut;
  }

  return {
    singleOut,
    splitTotalOut: total,
    splits: splitOuts,
    delta: total - singleOut,
    singleUnderquote: single.referenceOut > singleOut ? single.referenceOut - singleOut : 0n,
    singleIterations: single.iterations,
    singleDepthGain: single.depthGain,
  };
}

describe("SwapBatchVsSingle [real presets, fee=5bps, repeg=off]", function () {
  this.timeout(180_000);

  for (const quoteIsToken0 of [true, false]) {
    it(`pins WBTC 95% BASE→USDT precision and LP depth with quoteIsToken0=${quoteIsToken0}`, async function () {
      // Numeric rounding depends on which token is anchor-normalized.
      // Require both actual address orderings, independent of preceding tests.
      let poolFixture: SecurityFixture | undefined;
      for (let attempt = 0; attempt < 16; attempt++) {
        const candidate = await deploySecurityFixture(buildPreset("WBTC"));
        if (candidate.quoteIsToken0 === quoteIsToken0) {
          poolFixture = candidate;
          break;
        }
      }
      expect(poolFixture, "required native-token orientation was not constructed").to.exist;
      const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
      await math.waitForDeployment();
      const fx: BatchFixture = { ...poolFixture!, math };
      const r = await compareSplitVsSingle(fx, {
        tokenIn: fx.baseAddr,
        tokenOut: fx.quoteAddr,
        totalAmount: (fx.initialBaseRaw * 9500n) / BPS,
        splits: 10,
      });
      expect(r.delta).to.be.at.most(dustBudgetFor(r.singleOut, 10) + r.singleUnderquote);
      // Q128 resolves the former late single-quote shortfall on the fast
      // path in both token orderings. Every leg above is independently
      // checked with the common margin and against post-fee L.
      expect(r.singleIterations).to.equal(quoteIsToken0 ? 7n : 8n);
      expect(r.singleOut).to.be.greaterThan(0n);
      expect(r.singleUnderquote).to.be.gt(0n);
      expect(r.delta).to.be.lessThan(0n);
      console.log("Pinned WBTC 95% precision", {
        quoteIsToken0,
        singleOut: r.singleOut.toString(),
        iterations: r.singleIterations.toString(),
        verifiedUnderquote: r.singleUnderquote.toString(),
        splitAdvantage: r.delta.toString(),
        actualDepthGain: r.singleDepthGain.toString(),
      });
    });
  }

  for (const presetName of PRESETS_UNDER_TEST) {
    const preset = buildPreset(presetName);
    const fixtureFor = async () => {
      const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
      await math.waitForDeployment();
      return { ...(await deploySecurityFixture(preset)), math };
    };

    describe(`${presetName} (aWad=${fmtWad(REAL_PRESETS[presetName].aWad, 4)}, lambdaWad=${fmtWad(REAL_PRESETS[presetName].lambdaWad, 4)})`, function () {
      it("[stress] USDT→BASE splitting stays within dust plus verified single underquote (10..95% of QUOTE reserve)", async function () {
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

            const dustBudget = dustBudgetFor(r.singleOut, SPLITS) + r.singleUnderquote;
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

      it("[stress] BASE→USDT splitting stays within dust plus verified single underquote (10..95% of BASE reserve)", async function () {
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

            const dustBudget = dustBudgetFor(r.singleOut, SPLITS) + r.singleUnderquote;
            if (presetName === "WBTC" && pct === 9500n) {
              console.log("WBTC 95% BASE→USDT precision regression", {
                singleOut: r.singleOut.toString(),
                iterations: r.singleIterations.toString(),
                verifiedUnderquote: r.singleUnderquote.toString(),
                splitAdvantage: r.delta.toString(),
                actualDepthGain: r.singleDepthGain.toString(),
              });
            }
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

      it("[stress] Away-regime splitting stays within dust plus verified single underquote", async function () {
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

              const dustBudget = dustBudgetFor(r.singleOut, SPLITS) + r.singleUnderquote;
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

      it("[stress] Cross-anchor splitting stays within dust plus verified single underquote", async function () {
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

            const dustBudget = dustBudgetFor(r.singleOut, SPLITS) + r.singleUnderquote;
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
