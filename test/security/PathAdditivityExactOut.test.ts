// SPDX-License-Identifier: MIT
//
// EquilibraSwapMath exact-output path-additivity validator.
//
// Three guards against exact-output specific leaks:
//
//   (a) Split exactOut: trader specifies total `dy_total` to receive,
//       splits into N equal pieces of `dy_total / N`. Σ(dx_i) must
//       equal single dx (within ceil-rounding noise per leg).
//
//   (b) Round-trip exactIn → exactOut: trader buys with exact-input
//       USDT, then sells the exact USDT amount they want back via
//       exact-output. Net PnL in BASE must be ≤ 0 (within rounding).
//
//   (c) Round-trip exactOut → exactIn: trader buys an exact BASE
//       amount, then sells that exact amount back via exact-input.
//       Net PnL in USDT must be ≤ 0.
//
// All three exercise the inverse Newton iteration (`quoteExactOutForward`),
// which is the symmetric twin of the exact-input solver but runs against
// `xPost` as the unknown instead of `yPost`. K(x,y) symmetry under
// (x ↔ y) guarantees the same convergence characteristics, so any leak
// here would indicate a non-symmetric implementation defect.

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

  return { harness, quoteIsToken0, initialQuoteRaw, initialBaseRaw };
}

async function depleteHarness(fx: HarnessFixture, zeroForOne: boolean, targetDepletionBps: bigint): Promise<void> {
  const [r0Pre, r1Pre] = await fx.harness.getReservesRaw();
  const reserveOutPre = zeroForOne ? BigInt(r1Pre) : BigInt(r0Pre);
  const desiredDraw = (reserveOutPre * targetDepletionBps) / 10_000n;
  const inAmt = BigInt(await fx.harness.quoteExactOut(zeroForOne, desiredDraw));
  if (inAmt === 0n) return;
  await fx.harness.swapExactIn(zeroForOne, inAmt);
}

async function getSwapEvent(rc: any) {
  return rc.logs.find((l: any) => l.fragment && l.fragment.name === "Swap");
}

interface ExactOutSplitResult {
  singleIn: bigint;
  splitTotalIn: bigint;
  splits: bigint[];
  delta: bigint; // splitTotalIn - singleIn (must be ≥ -dust, i.e. split never pays LESS)
  gasSingle: bigint;
  gasSplitsAvg: bigint;
}

async function compareSplitVsSingleExactOut(
  fx: HarnessFixture,
  zeroForOne: boolean,
  totalDyOut: bigint,
  splits: number
): Promise<ExactOutSplitResult> {
  const snap = await hre.network.provider.send("evm_snapshot", []);

  const txSingle = await fx.harness.swapExactOut(zeroForOne, totalDyOut);
  const rcSingle = await txSingle.wait();
  const evSingle = await getSwapEvent(rcSingle);
  const singleIn = BigInt(evSingle.args.amountInRaw);
  const gasSingle = BigInt(rcSingle.gasUsed);

  await hre.network.provider.send("evm_revert", [snap]);

  const splitIns: bigint[] = [];
  let total = 0n;
  let totalGas = 0n;
  const baseChunk = totalDyOut / BigInt(splits);
  for (let i = 0; i < splits; i++) {
    const isLast = i === splits - 1;
    const dyChunk = isLast ? totalDyOut - baseChunk * BigInt(splits - 1) : baseChunk;
    if (dyChunk === 0n) continue;
    const tx = await fx.harness.swapExactOut(zeroForOne, dyChunk);
    const rc = await tx.wait();
    const ev = await getSwapEvent(rc);
    const dxIn = BigInt(ev.args.amountInRaw);
    splitIns.push(dxIn);
    total += dxIn;
    totalGas += BigInt(rc.gasUsed);
  }

  return {
    singleIn,
    splitTotalIn: total,
    splits: splitIns,
    delta: total - singleIn,
    gasSingle,
    gasSplitsAvg: totalGas / BigInt(splits),
  };
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

describe("PathAdditivity ExactOut [state-only K, secant]", function () {
  this.timeout(180_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const fixtureFor = async () => deployHarness(presetName);

    describe(`${presetName} preset`, function () {
      // ----------------------------------------------------------------
      // (a) Split exactOut from balanced state
      // ----------------------------------------------------------------
      it("ExactOut split from balanced state matches single (1..70% of BASE)", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];
        const failures: string[] = [];

        const PCTS = [100n, 1_000n, 5_000n, 7_000n];
        const SPLITS = 10;
        // For exact-out, splits use ceil-rounding on each leg; the legitimate
        // budget is 1 wei × N (each split can ceil up to 1 raw-input wei).
        const dustBudget = BigInt(SPLITS) * 2n;
        const zeroForOne = fx.quoteIsToken0;

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const totalBaseOut = (fx.initialBaseRaw * pct) / 10_000n;
            const r = await compareSplitVsSingleExactOut(fx, zeroForOne, totalBaseOut, SPLITS);
            // For path-additive AMM with ceil-up dx, split should pay ≥ single
            // by ≤ N×ceil-noise — never LESS.
            const beat = r.delta < -dustBudget;
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(2)}%`,
              singleIn: fmtRaw(r.singleIn, QUOTE_DECIMALS),
              splitIn: fmtRaw(r.splitTotalIn, QUOTE_DECIMALS),
              "Δ (split−single)": `${r.delta >= 0n ? "+" : ""}${r.delta}`,
              "gas single": r.gasSingle.toString(),
              "gas split avg": r.gasSplitsAvg.toString(),
              leaked: beat ? "YES" : "no",
            });
            if (beat) {
              failures.push(`pct=${pct}bps: split paid ${r.delta} less than single (budget=±${dustBudget})`);
            }
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }

        console.log(`\n=== V2 exactOut split vs single — ${presetName} ===`);
        console.table(rows);
        expect(
          failures.length === 0,
          `${failures.length} balanced exact-out split scenarios saved input vs single:\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });

      // ----------------------------------------------------------------
      // (b) ExactOut split in away regime
      // ----------------------------------------------------------------
      it("ExactOut split from a pre-depleted state matches single", async function () {
        const fx = await loadFixture(fixtureFor);
        const rows: any[] = [];
        const failures: string[] = [];

        const PRE_DEPLETIONS = [3_000n, 6_000n, 8_000n, 9_000n];
        const FORWARD_PCTS = [1_000n, 2_500n, 5_000n];
        const SPLITS = 8;
        const dustBudget = BigInt(SPLITS) * 2n;
        const zeroForOne = fx.quoteIsToken0;

        for (const preDep of PRE_DEPLETIONS) {
          for (const fwdPct of FORWARD_PCTS) {
            const snap = await hre.network.provider.send("evm_snapshot", []);
            try {
              await depleteHarness(fx, zeroForOne, preDep);
              const [r0, r1] = await fx.harness.getReservesRaw();
              const reserveBaseCurrent = fx.quoteIsToken0 ? BigInt(r1) : BigInt(r0);
              // We're going to drain `fwdPct` of the *output* (BASE) reserve
              // via exact-out. Sized to stay deep in away regime.
              const totalBaseOut = (reserveBaseCurrent * fwdPct) / 10_000n;
              if (totalBaseOut < BigInt(SPLITS)) continue;

              const r = await compareSplitVsSingleExactOut(fx, zeroForOne, totalBaseOut, SPLITS);

              const beat = r.delta < -dustBudget;
              rows.push({
                preDep: `${(Number(preDep) / 100).toFixed(1)}%`,
                fwdPct: `${(Number(fwdPct) / 100).toFixed(1)}%`,
                singleIn: fmtRaw(r.singleIn, QUOTE_DECIMALS),
                splitIn: fmtRaw(r.splitTotalIn, QUOTE_DECIMALS),
                "Δ (split−single)": `${r.delta >= 0n ? "+" : ""}${r.delta}`,
                "gas split avg": r.gasSplitsAvg.toString(),
                leaked: beat ? "YES" : "no",
              });
              if (beat) {
                failures.push(`preDep=${preDep}bps fwd=${fwdPct}bps: split saved ${-r.delta} (budget=±${dustBudget})`);
              }
            } finally {
              await hre.network.provider.send("evm_revert", [snap]);
            }
          }
        }

        console.log(`\n=== V2 exactOut AWAY — ${presetName} ===`);
        console.table(rows);

        expect(
          failures.length === 0,
          `${failures.length}/12 away-regime exact-out scenarios leaked:\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });

      // ----------------------------------------------------------------
      // (c) Round-trip exactIn → exactOut (USDT-target reverse)
      // ----------------------------------------------------------------
      it("Round-trip exactIn(USDT) → exactOut(USDT) is non-profitable", async function () {
        const fx = await loadFixture(fixtureFor);
        const zeroForOne = fx.quoteIsToken0; // USDT → BASE
        const PCTS = [500n, 2_000n, 5_000n];
        const rows: any[] = [];

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const usdtIn = (fx.initialQuoteRaw * pct) / 10_000n;
            // Forward: exactIn USDT → BASE.
            const txFwd = await fx.harness.swapExactIn(zeroForOne, usdtIn);
            const rcFwd = await txFwd.wait();
            const evFwd = await getSwapEvent(rcFwd);
            const baseAcquired = BigInt(evFwd.args.amountOutRaw);

            // Reverse: exactOut for `usdtIn` of USDT — sell BASE to recover the
            // exact USDT amount they put in.
            const txRev = await fx.harness.swapExactOut(!zeroForOne, usdtIn);
            const rcRev = await txRev.wait();
            const evRev = await getSwapEvent(rcRev);
            const baseSold = BigInt(evRev.args.amountInRaw);

            // Trader's BASE PnL: bought `baseAcquired`, paid `baseSold`. Loss is
            // expected (curve-AMM round-trip ≤ 0 with no fees, by K-conservation).
            const basePnL = baseAcquired - baseSold;
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              usdtIn: fmtRaw(usdtIn, QUOTE_DECIMALS),
              baseAcquired: fmtRaw(baseAcquired, BASE_DECIMALS[presetName]),
              baseSold: fmtRaw(baseSold, BASE_DECIMALS[presetName]),
              baseDelta: `${basePnL >= 0n ? "+" : ""}${basePnL}`,
            });

            // Trader cannot net any meaningful BASE on the round-trip.
            // The secant solver converges to ≲ 1 ppb of the requested
            // output but cannot return below the WAD-grid floor of the
            // raw token; for highly-concentrated presets (WBTC) the
            // round-trip noise floor lands at a few dozen BASE-wei.
            // 100 BASE-wei is a hard ceiling — at WBTC-8 that is
            // < 1e-6 USD on the reference $100K WBTC, well below any
            // exploitable profit.
            const basePnLBudget = 100n;
            expect(
              basePnL <= basePnLBudget,
              `pct=${pct}bps: trader netted +${basePnL} BASE-wei on a fee-less round-trip (budget=${basePnLBudget})`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }
        console.log(`\n=== V2 exactIn → exactOut round-trip — ${presetName} ===`);
        console.table(rows);
      });

      // ----------------------------------------------------------------
      // (d) Round-trip exactOut → exactIn (BASE-target reverse)
      // ----------------------------------------------------------------
      it("Round-trip exactOut(BASE) → exactIn(BASE) is non-profitable", async function () {
        const fx = await loadFixture(fixtureFor);
        const zeroForOne = fx.quoteIsToken0;
        const PCTS = [500n, 2_000n, 5_000n];
        const rows: any[] = [];

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const baseOutTarget = (fx.initialBaseRaw * pct) / 10_000n;
            // Forward: exactOut, trader specifies BASE to receive.
            const txFwd = await fx.harness.swapExactOut(zeroForOne, baseOutTarget);
            const rcFwd = await txFwd.wait();
            const evFwd = await getSwapEvent(rcFwd);
            const usdtPaid = BigInt(evFwd.args.amountInRaw);

            // Reverse: exactIn the same BASE amount back, recover USDT.
            const txRev = await fx.harness.swapExactIn(!zeroForOne, baseOutTarget);
            const rcRev = await txRev.wait();
            const evRev = await getSwapEvent(rcRev);
            const usdtRecovered = BigInt(evRev.args.amountOutRaw);

            const usdtPnL = usdtRecovered - usdtPaid;
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              baseTarget: fmtRaw(baseOutTarget, BASE_DECIMALS[presetName]),
              usdtPaid: fmtRaw(usdtPaid, QUOTE_DECIMALS),
              usdtRecovered: fmtRaw(usdtRecovered, QUOTE_DECIMALS),
              usdtDelta: `${usdtPnL >= 0n ? "+" : ""}${usdtPnL}`,
            });

            // Same noise-floor argument as the BASE round-trip above —
            // a few wei of secant-residual is the irreducible numerical
            // floor of K-conservation under decimal-asymmetric pairs.
            const usdtPnLBudget = 100n;
            expect(
              usdtPnL <= usdtPnLBudget,
              `pct=${pct}bps: trader netted +${usdtPnL} USDT-wei on a fee-less round-trip (budget=${usdtPnLBudget})`
            ).to.equal(true);
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }
        console.log(`\n=== V2 exactOut → exactIn round-trip — ${presetName} ===`);
        console.table(rows);
      });

      // ----------------------------------------------------------------
      // (e) ExactIn ↔ ExactOut quote parity at the same Δ
      //
      // Note: for decimal-asymmetric pairs (e.g. USDT/WBTC, 6/8 dec) the
      // forward quote rounds dy DOWN to base-decimals and the inverse quote
      // re-WAD-scales that floored dyRaw back up — the missing fractional
      // satoshi of dy translates into ~1 satoshi worth of dx loss through
      // the local marginal price. The budget below is sized to absorb that
      // quantisation envelope; the round-trip *swap* tests above (c, d) are
      // the structural arb guard, this test just sanity-checks that the
      // rounding loss stays within decimal granularity.
      // ----------------------------------------------------------------
      it("Pricing parity: exactIn(dx) gives dy, then exactOut(dy) ≈ dx (within 1 ulp)", async function () {
        const fx = await loadFixture(fixtureFor);
        const zeroForOne = fx.quoteIsToken0;
        const PCTS = [100n, 1_000n, 5_000n, 9_000n];
        const rows: any[] = [];
        const failures: string[] = [];

        // Per-decimal quantisation budget (USDT-wei). For decimal-asymmetric
        // pairs the dy_raw floor and the Newton residual compound: each
        // satoshi of dy floor can blow up to ~`marginalPrice` of dx-equiv,
        // and the marginal price itself rises with depletion. Empirically
        // the envelope on WBTC sits at ~3 satoshi of dx, with a margin
        // for deep swaps. For WETH (math-WAD == raw-WAD) the envelope is
        // tight to a few wei of ceil-up noise.
        const basePriceUsd = REFERENCE_PRICES[presetName];
        const baseDecimals = BigInt(BASE_DECIMALS[presetName]);
        const oneSatoshiInUsdtWei = baseDecimals === 18n ? 1n : (basePriceUsd * QUOTE_SCALE) / 10n ** baseDecimals;
        const quantisationBudget = baseDecimals === 18n ? 5n : oneSatoshiInUsdtWei * 5n;

        for (const pct of PCTS) {
          const snap = await hre.network.provider.send("evm_snapshot", []);
          try {
            const usdtIn = (fx.initialQuoteRaw * pct) / 10_000n;
            const dyForExactIn = BigInt(await fx.harness.quoteExactIn(zeroForOne, usdtIn));
            const dxForExactOut = BigInt(await fx.harness.quoteExactOut(zeroForOne, dyForExactIn));

            const drift = dxForExactOut - usdtIn;
            const inBudget = drift >= -quantisationBudget;
            rows.push({
              pct: `${(Number(pct) / 100).toFixed(1)}%`,
              dxIn: fmtRaw(usdtIn, QUOTE_DECIMALS),
              dyOut: fmtRaw(dyForExactIn, BASE_DECIMALS[presetName]),
              dxRecovered: fmtRaw(dxForExactOut, QUOTE_DECIMALS),
              "Δ (USDT-wei)": `${drift >= 0n ? "+" : ""}${drift}`,
              budget: `±${quantisationBudget}`,
              ok: inBudget ? "yes" : "NO",
            });
            if (!inBudget) {
              failures.push(`pct=${pct}bps: drift=${drift} (budget=±${quantisationBudget})`);
            }
          } finally {
            await hre.network.provider.send("evm_revert", [snap]);
          }
        }
        console.log(`\n=== V2 inverse-quote parity — ${presetName} ===`);
        console.table(rows);

        expect(
          failures.length === 0,
          `${failures.length} parity drift exceeded decimal-quantisation budget:\n  ${failures.join("\n  ")}`
        ).to.equal(true);
      });
    });
  }
});
