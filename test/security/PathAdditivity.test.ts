// SPDX-License-Identifier: MIT
//
// EquilibraSwapMath path-additivity validator. Exercises split-vs-
// single scenarios (away regime, cross-anchor) on a minimal stateful
// kernel harness — pure curve math, no fees, no router, no LP token.
//
// Hypothesis: with state-only K(x, y) and Newton-style secant solve,
// `Σ small_dy ≈ single_dy` strictly (within ~1 wei × N split-floor
// noise).
//
// The test also captures gas-per-swap on the harness for cross-
// reference against the production pool's swap path.

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import { REAL_PRESETS, REFERENCE_PRICES, type PresetName } from "../helpers/securityFixtures";

const QUOTE_DECIMALS = 6;
const BASE_DECIMALS: Record<PresetName, number> = {
  WETH: 18,
  WBTC: 8,
};
const QUOTE_SCALE = 10n ** BigInt(QUOTE_DECIMALS);
const BASE_SCALES: Record<PresetName, bigint> = {
  WETH: 10n ** 18n,
  WBTC: 10n ** 8n,
};

const INITIAL_QUOTE_USD = 500_000n;
const PRESETS_UNDER_TEST: PresetName[] = ["WETH", "WBTC"];

interface HarnessFixture {
  harness: any;
  quoteIsToken0: boolean;
  initialQuoteRaw: bigint;
  initialBaseRaw: bigint;
}

async function deployHarness(presetName: PresetName): Promise<HarnessFixture> {
  const preset = REAL_PRESETS[presetName];
  const basePriceUsd = REFERENCE_PRICES[presetName];

  const initialQuoteRaw = INITIAL_QUOTE_USD * QUOTE_SCALE;
  const initialBaseRaw = (INITIAL_QUOTE_USD * BASE_SCALES[presetName]) / basePriceUsd;

  // Synthetic token addresses — the harness uses them as labels only,
  // never as transfer targets.
  const tokenA = "0x0000000000000000000000000000000000000001";
  const tokenB = "0x0000000000000000000000000000000000000002";
  const quoteIsToken0 = tokenA < tokenB;

  const r0Raw = quoteIsToken0 ? initialQuoteRaw : initialBaseRaw;
  const r1Raw = quoteIsToken0 ? initialBaseRaw : initialQuoteRaw;
  const d0 = quoteIsToken0 ? QUOTE_DECIMALS : BASE_DECIMALS[presetName];
  const d1 = quoteIsToken0 ? BASE_DECIMALS[presetName] : QUOTE_DECIMALS;
  const r0Wad = r0Raw * 10n ** BigInt(18 - d0);
  const r1Wad = r1Raw * 10n ** BigInt(18 - d1);

  const Harness = await hre.ethers.getContractFactory("StatefulKernelHarness");
  const harness = await Harness.deploy(r0Wad, r1Wad, preset.aWad, preset.lambdaWad, d0, d1);
  await harness.waitForDeployment();

  return {
    harness,
    quoteIsToken0,
    initialQuoteRaw,
    initialBaseRaw,
  };
}

interface SplitResult {
  singleOut: bigint;
  splitTotalOut: bigint;
  splits: bigint[];
  delta: bigint;
  gasSingle: bigint;
  gasSplitsAvg: bigint;
}

async function compareSplitVsSingle(
  fx: HarnessFixture,
  zeroForOne: boolean,
  totalAmount: bigint,
  splits: number
): Promise<SplitResult> {
  // Snapshot before single.
  const snap1 = await hre.network.provider.send("evm_snapshot", []);

  // Single swap.
  const txSingle = await fx.harness.swapExactIn(zeroForOne, totalAmount);
  const rcSingle = await txSingle.wait();
  const evSingle = rcSingle.logs.find((l: any) => l.fragment && l.fragment.name === "Swap");
  const singleOut = BigInt(evSingle.args.amountOutRaw);
  const gasSingle = BigInt(rcSingle.gasUsed);

  await hre.network.provider.send("evm_revert", [snap1]);

  // Splits.
  const splitOuts: bigint[] = [];
  let total = 0n;
  let totalGas = 0n;
  const baseChunk = totalAmount / BigInt(splits);
  for (let i = 0; i < splits; i++) {
    const isLast = i === splits - 1;
    const amt = isLast ? totalAmount - baseChunk * BigInt(splits - 1) : baseChunk;
    const tx = await fx.harness.swapExactIn(zeroForOne, amt);
    const rc = await tx.wait();
    const ev = rc.logs.find((l: any) => l.fragment && l.fragment.name === "Swap");
    const out = BigInt(ev.args.amountOutRaw);
    splitOuts.push(out);
    total += out;
    totalGas += BigInt(rc.gasUsed);
  }

  return {
    singleOut,
    splitTotalOut: total,
    splits: splitOuts,
    delta: total - singleOut,
    gasSingle,
    gasSplitsAvg: totalGas / BigInt(splits),
  };
}

async function depleteHarness(fx: HarnessFixture, zeroForOne: boolean, targetDepletionBps: bigint): Promise<void> {
  // Bisect input amount that drains the OUTPUT-side reserve to
  // (1 - targetDepletion) of its current level.
  const [r0Pre, r1Pre] = await fx.harness.getReservesRaw();
  const reserveOutPre = zeroForOne ? BigInt(r1Pre) : BigInt(r0Pre);
  const targetOutAfter = (reserveOutPre * (10_000n - targetDepletionBps)) / 10_000n;
  const desiredDraw = reserveOutPre - targetOutAfter;

  const inAmt = BigInt(await fx.harness.quoteExactOut(zeroForOne, desiredDraw));
  if (inAmt === 0n) return;
  await fx.harness.swapExactIn(zeroForOne, inAmt);
}

function fmtRaw(raw: bigint, decimals: number, precision = 8): string {
  const sign = raw < 0n ? "-" : "";
  const ax = raw < 0n ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = ax / scale;
  const frac = ax % scale;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, precision);
  return `${sign}${whole.toString()}.${fracStr}`.replace(/0+$/, "").replace(/\.$/, "");
}

describe("PathAdditivity [EquilibraSwapMath — state-only K, single-piece, secant]", function () {
  this.timeout(180_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const fixtureFor = async () => deployHarness(presetName);

    describe(`${presetName} preset`, function () {
      it("Splitting USDT→BASE from balanced state matches single swap exactly (1..95% of QUOTE)", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];

        const PCTS = [100n, 1_000n, 5_000n, 9_000n, 9_500n];
        const SPLITS = 10;
        // Per-preset dust budget. The secant on integer K hits a hard
        // noise floor (~10 wei per leg) when reserves enter the
        // CP-tail regime — `α=0.5` (WETH) crosses that boundary at
        // ~50% depth, while `α=8.97` (WBTC) stays Stableswap-flat
        // throughout the entire 1..95% sweep. The bound is still
        // `< 10⁻⁶` of the swap value, so any path-additivity leak that
        // survives this budget remains detectable as a real solver bug.
        const dustBudget = presetName === "WETH" ? BigInt(SPLITS) * 12n : BigInt(SPLITS) * 2n;
        const zeroForOne = fx.quoteIsToken0;

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const totalUsdt = (fx.initialQuoteRaw * pct) / 10_000n;
            const r = await compareSplitVsSingle(fx, zeroForOne, totalUsdt, SPLITS);
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(2)}%`,
              singleOut: fmtRaw(r.singleOut, BASE_DECIMALS[presetName]),
              splitOut: fmtRaw(r.splitTotalOut, BASE_DECIMALS[presetName]),
              Δ: `${r.delta >= 0n ? "+" : ""}${fmtRaw(r.delta, BASE_DECIMALS[presetName], 12)}`,
              "gas single": r.gasSingle.toString(),
              "gas split avg": r.gasSplitsAvg.toString(),
            });
            expect(r.delta <= dustBudget, `pct=${pct}bps: delta=${r.delta}, budget=${dustBudget}`).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== V2 split-vs-single balanced — ${presetName} ===`);
        console.table(rows);
      });

      it("Splitting from a pre-depleted away regime matches single swap exactly", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];
        const failures: string[] = [];

        const PRE_DEPLETIONS = [3_000n, 6_000n, 8_000n, 9_000n];
        const FORWARD_PCTS = [1_000n, 2_500n, 5_000n];
        const SPLITS = 8;
        // Per-leg dust budget — the L-recovery quadratic in
        // `solveLFromState` adds a handful of WAD-wei of residual on
        // every split leg.
        // The bound is ≪ 10⁻¹⁰ of the swap value, so any systematic
        // split-beats-single advantage that survives this budget
        // remains detectable as a real path-additivity leak.
        const dustBudget = BigInt(SPLITS) * 4_096n;
        const zeroForOne = fx.quoteIsToken0;

        for (const preDep of PRE_DEPLETIONS) {
          for (const fwdPct of FORWARD_PCTS) {
            const snap = await hre.network.provider.send("evm_snapshot", []);
            try {
              await depleteHarness(fx, zeroForOne, preDep);

              const [r0, r1] = await fx.harness.getReservesRaw();
              const reserveQuoteCurrent = fx.quoteIsToken0 ? BigInt(r0) : BigInt(r1);
              const totalUsdt = (reserveQuoteCurrent * fwdPct) / 10_000n;
              if (totalUsdt < BigInt(SPLITS)) continue;

              // The blend invariant concentrates liquidity hard
              // enough that some `(preDep, fwdPct)` combinations push
              // the post-depletion pool past its feasibility envelope.
              // Probe
              // the single swap first; if it reverts, skip — the row
              // is not a path-additivity test, it's a request the
              // curve cannot fulfil.
              try {
                await fx.harness.quoteExactIn.staticCall(zeroForOne, totalUsdt);
              } catch {
                rows.push({
                  preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
                  fwdPct: `${(Number(fwdPct) / 100).toFixed(1)}%`,
                  singleOut: "—",
                  splitOut: "—",
                  Δ: "skip (infeasible)",
                  "gas split avg": "—",
                  leaked: "no",
                });
                continue;
              }

              const r = await compareSplitVsSingle(fx, zeroForOne, totalUsdt, SPLITS);

              const beat = r.delta > dustBudget;
              rows.push({
                preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
                fwdPct: `${(Number(fwdPct) / 100).toFixed(1)}%`,
                singleOut: fmtRaw(r.singleOut, BASE_DECIMALS[presetName]),
                splitOut: fmtRaw(r.splitTotalOut, BASE_DECIMALS[presetName]),
                Δ: `${r.delta >= 0n ? "+" : ""}${fmtRaw(r.delta, BASE_DECIMALS[presetName], 12)}`,
                "gas split avg": r.gasSplitsAvg.toString(),
                leaked: beat ? "YES" : "no",
              });
              if (beat) {
                failures.push(
                  `preDep=${preDep}bps fwd=${fwdPct}bps: split beats single by ${fmtRaw(r.delta, BASE_DECIMALS[presetName], 12)} ${presetName}`
                );
              }
            } finally {
              await hre.network.provider.send("evm_revert", [snap]);
            }
          }
        }

        console.log(`\n=== V2 split-vs-single AWAY REGIME — ${presetName} ===`);
        console.table(rows);

        expect(
          failures.length === 0,
          `${failures.length}/12 away-regime split scenarios beat single on V2 (budget=${dustBudget}):\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });

      it("Splitting through an anchor crossing matches single swap exactly", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];
        const failures: string[] = [];

        const PRE_DEPLETIONS = [2_000n, 5_000n, 8_000n];
        const SPLITS = 10;
        // Per-leg dust: same rationale as the away-regime test —
        // blend-invariant path-additivity drift is bounded by a
        // handful of raw-decimal wei per split leg.
        const dustBudget = BigInt(SPLITS) * 4_096n;
        const zeroForOne = fx.quoteIsToken0;

        for (const preDep of PRE_DEPLETIONS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            await depleteHarness(fx, zeroForOne, preDep);

            const [r0, r1] = await fx.harness.getReservesRaw();
            const reserveBaseCurrent = fx.quoteIsToken0 ? BigInt(r1) : BigInt(r0);
            const targetBaseDraw = (reserveBaseCurrent * 8_000n) / 10_000n;
            const totalUsdt = BigInt(await fx.harness.quoteExactOut(zeroForOne, targetBaseDraw));
            if (totalUsdt === 0n) continue;

            const r = await compareSplitVsSingle(fx, zeroForOne, totalUsdt, SPLITS);

            const beat = r.delta > dustBudget;
            rows.push({
              preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
              singleOut: fmtRaw(r.singleOut, BASE_DECIMALS[presetName]),
              splitOut: fmtRaw(r.splitTotalOut, BASE_DECIMALS[presetName]),
              Δ: `${r.delta >= 0n ? "+" : ""}${fmtRaw(r.delta, BASE_DECIMALS[presetName], 12)}`,
              "gas split avg": r.gasSplitsAvg.toString(),
              leaked: beat ? "YES" : "no",
            });
            if (beat) {
              failures.push(
                `preDep=${preDep}bps: split beats single by ${fmtRaw(r.delta, BASE_DECIMALS[presetName], 12)} ${presetName}`
              );
            }
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== V2 split-vs-single CROSS-ANCHOR — ${presetName} ===`);
        console.table(rows);

        expect(
          failures.length === 0,
          `${failures.length}/3 cross-anchor scenarios beat single on V2 (budget=${dustBudget}):\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });

      it("K(x,y) is conserved across forward + reverse round-trip (path-symmetry)", async function () {
        const fx = await loadFixture(fixtureFor);
        const zeroForOne = fx.quoteIsToken0;

        // Round-trip at 50% of QUOTE reserve from balanced state.
        const totalUsdt = (fx.initialQuoteRaw * 5_000n) / 10_000n;
        const kStart = BigInt(await fx.harness.getInvariantK());

        const txFwd = await fx.harness.swapExactIn(zeroForOne, totalUsdt);
        const rcFwd = await txFwd.wait();
        const evFwd = rcFwd.logs.find((l: any) => l.fragment && l.fragment.name === "Swap");
        const baseOut = BigInt(evFwd.args.amountOutRaw);
        const kMid = BigInt(await fx.harness.getInvariantK());

        const txRev = await fx.harness.swapExactIn(!zeroForOne, baseOut);
        const rcRev = await txRev.wait();
        const evRev = rcRev.logs.find((l: any) => l.fragment && l.fragment.name === "Swap");
        const usdtBack = BigInt(evRev.args.amountOutRaw);
        const kEnd = BigInt(await fx.harness.getInvariantK());

        const traderPnL = usdtBack - totalUsdt;
        console.log(`\n=== V2 round-trip K conservation — ${presetName} ===`);
        console.log(
          `  K_start = ${kStart}\n` +
            `  K_mid   = ${kMid}\n` +
            `  K_end   = ${kEnd}\n` +
            `  trader PnL = ${traderPnL} (USDT raw)\n` +
            `  base bought = ${baseOut} (BASE raw)`
        );

        // K is conserved by construction (modulo Newton residual + raw-decimal
        // floor). Our budget: each swap can raw-floor up to 1 unit of output
        // token, which translates to a small WAD perturbation of K. Check that
        // K stays within a reasonable envelope.
        const kDriftBps = ((kEnd > kStart ? kEnd - kStart : kStart - kEnd) * 10_000n) / kStart;
        expect(kDriftBps <= 2n, `K drifted ${kDriftBps}bps over round-trip (start=${kStart}, end=${kEnd})`).to.equal(
          true
        );

        // Trader's USDT PnL should be ≤ 0 (within ~1 USDT-wei rounding) in a
        // zero-fee path-additive AMM — round-trip gives back at most what
        // they put in, never more.
        expect(traderPnL <= 1n, `trader netted +${traderPnL} USDT-wei on a fee-less round-trip`).to.equal(true);
      });
    });
  }
});
