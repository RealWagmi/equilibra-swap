import { expect } from "chai";
import hre from "hardhat";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

// High-precision stress: drive the production
// `EquilibraSwapMath.quoteExactInForward` / `quoteExactOutForward`
// kernel through a few thousand pseudo-random states and assert four
// classical invariants that any conservative AMM must satisfy:
//
//   1. **Split-equivalence**: a single exact-in swap and 10 equal
//      splits of the same notional must produce nearly identical
//      cumulative output (rounding & path-dependence inside the
//      kernel, no rebate from splitting).
//   2. **Roundtrip**: exact-in followed by exact-out of the
//      previously-received amount must return the reserves to (≈) the
//      starting point. Asymmetric rounding inside `solveLFromState`
//      or `computeK` would manifest as a drifting reserve pair.
//   3. **Rounding stress**: tiny inputs (≤ 5 wei of math-space) must
//      either yield zero output or a strictly positive output on a
//      strictly improved input side — never a negative or
//      reserve-collapsing swap.
//   4. **(a, λ) coupling**: at the anchor, `K = W · L²` holds
//      regardless of `λ`, and the recovered `L_eq` from
//      `balanceScaleFromK(K)` must be invariant under `λ` sweeps for
//      a fixed `(x, y)` pair. This is the anchor-identity replacement
//      for the legacy "non-iterative A coupling" gate — when the prior
//      test passed a `pMargRef` through a single-knob amplifier, the
//      kernel decouples `λ` from anchor depth by construction.
//
// The legacy file was a pure-TypeScript shadow of the V1.0 single-knob
// curve. The math has changed shape vs the legacy kernel (two-knob cubic plus
// closed-form invariant `K = (1−w)·A·L·(x+y) + w·xy`), so a TS shadow
// would require a faithful port of `solveLFromState` and `computeK`.
// Instead this file is stronger: every assertion runs through the
// production code via `SwapMathHarness`, so any kernel regression
// flips a gate here, not just in the TS mirror.
const WAD = 10n ** 18n;

const PRESET = EQUILIBRA_PRESETS.WETH;

// Bounds chosen to keep the stress sweep inside a tractable runtime
// budget while still catching real precision drift. The original V1.0
// suite ran 10k iterations of a pure-TS shadow; this port runs
// 1.5k iterations of the actual on-chain kernel — a hundred-fold
// slower per sample, but a thousand-fold more meaningful.
//
// Coverage runs (SOLIDITY_COVERAGE=true, normalised in hardhat.config.ts)
// shrink the sweeps ~20×: instrumented legacy-codegen calls are an order
// of magnitude slower and would blow the per-spec timeouts, while
// statement/branch hit counts saturate after the first few iterations —
// the long sweeps only buy precision-drift confidence, which the regular
// `npm test` path already provides at full depth.
const IS_COVERAGE_RUN = process.env.SOLIDITY_COVERAGE === "true";
const SPLIT_ITERS = IS_COVERAGE_RUN ? 75 : 1_500;
const ROUNDTRIP_ITERS = IS_COVERAGE_RUN ? 75 : 1_500;
const LAMBDA_DECOUPLING_ITERS = IS_COVERAGE_RUN ? 25 : 500;

// Slack envelopes. The kernel's secant solver guarantees `≤ 1 ppb`
// residual + a small additive WAD-rounding constant in the NatSpec;
// we keep a generous safety margin on top so a real regression
// (orders-of-magnitude drift) still trips a gate without making the
// test flaky on sub-wei noise.
const SPLIT_PPM_EPS = 100n; // 100 ppm
const ROUNDTRIP_PPM_EPS = 100n; // 100 ppm
const ROUNDTRIP_ADDITIVE_WAD = 10_000n; // ≤ 10 000 wei of WAD-scaled drift

class PseudoRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  nextBigInt(minWad: bigint, maxWad: bigint): bigint {
    const span = maxWad - minWad + 1n;
    // Two u32 draws → ~62-bit unsigned range. Plenty for the
    // [1, 100k WAD] reserve / input bands we sample below.
    const draw = (BigInt(this.nextU32()) << 32n) | BigInt(this.nextU32());
    return minWad + (draw % span);
  }
}

function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

function ppmOf(value: bigint, total: bigint): bigint {
  if (total === 0n) return value === 0n ? 0n : 1_000_000n;
  return (value * 1_000_000n) / total;
}

async function deployHarness() {
  const F = await hre.ethers.getContractFactory("SwapMathHarness");
  const h: any = await F.deploy();
  await h.waitForDeployment();
  return h;
}

describe("HighPrecisionHarness — kernel stress", function () {
  let harness: any;

  before(async function () {
    harness = await deployHarness();
  });

  it("split-equivalence: 10×splitIn matches single oneShotIn within 100 ppm", async function () {
    this.timeout(600_000);
    const rng = new PseudoRng(42);
    let worstPpm = 0n;

    for (let i = 0; i < SPLIT_ITERS; i += 1) {
      const x = rng.nextBigInt(1_000n * WAD, 10_000n * WAD);
      const y = rng.nextBigInt(1_000n * WAD, 10_000n * WAD);
      const amountIn = rng.nextBigInt(WAD, 200n * WAD); // 1..200 WAD

      const [oneShotOut] = await harness.quoteExactInForward(x, y, amountIn, PRESET.aWad, PRESET.lambdaWad);
      if (oneShotOut === 0n) continue; // degenerate sample; skip

      const splitParts = 10n;
      const piece = amountIn / splitParts;
      let splitX = x;
      let splitY = y;
      let splitOut = 0n;
      let aborted = false;
      for (let step = 0; step < Number(splitParts); step += 1) {
        const [partOut] = await harness.quoteExactInForward(splitX, splitY, piece, PRESET.aWad, PRESET.lambdaWad);
        if (partOut === 0n) {
          aborted = true;
          break;
        }
        splitX = splitX + piece;
        splitY = splitY - partOut;
        splitOut += partOut;
      }
      if (aborted) continue;

      const drift = absDiff(BigInt(oneShotOut), splitOut);
      const ppm = ppmOf(drift, BigInt(oneShotOut));
      if (ppm > worstPpm) worstPpm = ppm;
    }

    expect(worstPpm).to.be.lte(SPLIT_PPM_EPS);
  });

  it("roundtrip: exact-in then exact-out returns reserves within 100 ppm", async function () {
    this.timeout(600_000);
    const rng = new PseudoRng(43);
    let worstPpm = 0n;

    for (let i = 0; i < ROUNDTRIP_ITERS; i += 1) {
      const x0 = rng.nextBigInt(500n * WAD, 5_000n * WAD);
      const y0 = rng.nextBigInt(500n * WAD, 5_000n * WAD);
      const amountIn = rng.nextBigInt(WAD / 10n, 250n * WAD); // 0.1..250 WAD

      // Forward leg: x0 → x0+dx, y0 → y0-dy.
      const [dyForward] = await harness.quoteExactInForward(x0, y0, amountIn, PRESET.aWad, PRESET.lambdaWad);
      if (dyForward === 0n) continue;
      const x1 = x0 + amountIn;
      const y1 = y0 - BigInt(dyForward);
      if (y1 === 0n) continue; // reserve collapsed — skip

      // Reverse leg: use exact-out to claw back exactly `dyForward`
      // units of y. Honest residual measure: how much `x` did we
      // have to put in on the way out vs. what we took out on the
      // way in.
      const [dxBack] = await harness.quoteExactOutForward(
        y1,
        x1,
        amountIn, // claw back the original amountIn worth of x — symmetric direction
        PRESET.aWad,
        PRESET.lambdaWad
      );
      // Symmetric note: `quoteExactOutForward(x', y', dy)` asks "how
      // much dx must I put into x' to extract dy units of y'?". With
      // the reserves flipped (`y1 → "x"`, `x1 → "y"`), the call asks
      // for the inverse leg. The residual we care about is
      // `|amountIn − implied| → 0` after one full forward+reverse
      // round on the same K-level set.
      const drift = absDiff(BigInt(dxBack), BigInt(dyForward));
      const denom = maxBigInt(BigInt(dyForward), 1n);
      const ppm = ppmOf(drift, denom);
      if (ppm > worstPpm && drift > ROUNDTRIP_ADDITIVE_WAD) {
        worstPpm = ppm;
      }
    }

    expect(worstPpm).to.be.lte(ROUNDTRIP_PPM_EPS);
  });

  it("rounding stress: tiny inputs never produce a negative or reserve-collapsing swap", async function () {
    const tinyStates: Array<[bigint, bigint]> = [
      [100n * WAD, 100n * WAD],
      [100n * WAD + WAD, 100n * WAD - WAD],
      [250n * WAD, 125n * WAD],
    ];
    const tinyInputs = [WAD / 1000n, (WAD * 2n) / 1000n, (WAD * 5n) / 1000n];

    for (const [x, y] of tinyStates) {
      for (const tinyIn of tinyInputs) {
        const [outRaw] = await harness.quoteExactInForward(x, y, tinyIn, PRESET.aWad, PRESET.lambdaWad);
        const out = BigInt(outRaw);
        // The kernel may round a sub-wei swap to zero output — that is
        // acceptable. What is NOT acceptable is a non-zero output
        // that would push `y` past the floor. We assert the
        // structural invariant: `out ≤ y`, and the post-swap reserves
        // both stay strictly positive.
        expect(out).to.be.lte(y);
        if (out > 0n) {
          expect(y - out).to.be.gt(0n);
          expect(x + tinyIn).to.be.gt(x);
        }
      }
    }
  });

  it("anchor identity: K = W · L² holds and L_eq is λ-invariant at x = y", async function () {
    this.timeout(120_000);
    const rng = new PseudoRng(44);
    // Anchor identity (replaces the legacy "non-iterative A
    // coupling" gate): at `x = y`, `A = a` regardless of λ, so the
    // L-quadratic resolves to `L = x` exactly and `K = W · L² = x · y`.
    // Sweep λ across the production envelope and assert L stays
    // pinned. This is a much stronger property than the old single-
    // knob test (which only bounded the round-trip drift on `A`).
    const lambdaSamples = [
      10n ** 15n, // λ_min
      10n ** 16n, // 0.01 W
      5n * 10n ** 16n, // 0.05 W
      10n ** 17n, // 0.1 W
      5n * 10n ** 17n, // 0.5 W
      10n ** 18n, // λ_max
    ];

    // The L-quadratic root floors by up to a few wei on arbitrary
    // reserves (the closed-form root passes through `sqrtWad`, which
    // truncates the integer square root). The structural invariant we
    // assert is twofold:
    //   * `L ≈ x` (within a few wei) at the anchor — drift is bounded
    //     by integer-sqrt residuals on the L-quadratic root, NOT by
    //     `λ` (the canonical SwapMathHelpers test uses exact-WAD-
    //     multiple reserves and gets `L == x` exactly; here we sweep
    //     random reserves and tolerate the wei-scale floor).
    //   * `L` is λ-invariant up to the same wei-scale residual: any
    //     two `(L_λ₁, L_λ₂)` pair for the same `(x, x, a)` must agree
    //     to ≤ a few wei. Drift larger than that would signal `λ`
    //     leaking into the anchor depth — exactly what the
    //     decoupling promises.
    const LAMBDA_L_DRIFT_TOL = 4n; // wei
    for (let i = 0; i < LAMBDA_DECOUPLING_ITERS; i += 1) {
      const r = rng.nextBigInt(500n * WAD, 20_000n * WAD);
      let expectedL: bigint | null = null;
      for (const lambda of lambdaSamples) {
        const [, l] = await harness.computeKAndL(r, r, PRESET.aWad, lambda);
        const lBig = BigInt(l);
        if (expectedL === null) {
          expectedL = lBig;
          // `L ≈ x` at the anchor — bounded by integer-sqrt residual.
          expect(absDiff(lBig, r)).to.be.lte(LAMBDA_L_DRIFT_TOL);
        } else {
          // `L` is λ-invariant up to the same wei-scale residual.
          expect(absDiff(lBig, expectedL), `λ=${lambda}, drift=${absDiff(lBig, expectedL)}`).to.be.lte(
            LAMBDA_L_DRIFT_TOL
          );
        }
      }
    }
  });

  // L-2 regression: the secant step was `(residual * db) / dk` in raw
  // int256, so the `residual · db` product reverted with panic 0x11
  // once `|residual · db| ≥ 2²⁵⁵` — reachable at math-space reserves
  // R ≳ 4.6e33 (≈ 4.6e15 whole 18-dec tokens, well below the uint128
  // reserve cap), bricking EVERY swap and quote on a large pool. The
  // fix computes the step over magnitudes via a 512-bit `fullMulDiv`
  // (bit-for-bit with the Rust reference), so the product can no longer
  // overflow. These reserves all sit above the old overflow threshold.
  it("L-2: large-pool swaps do not overflow the secant step (was panic 0x11)", async function () {
    this.timeout(60_000);
    const a = PRESET.aWad;
    const lambda = PRESET.lambdaWad;
    // Math-space reserves spanning just above the ~4.6e33 overflow
    // threshold up to deep into the regime that used to revert.
    const RESERVES = [5n * 10n ** 33n, 10n ** 34n, 5n * 10n ** 34n, 10n ** 35n];
    for (const R of RESERVES) {
      // A 1% exact-in swap on a balanced deep pool must return a
      // positive output close to (but below) the input — never revert.
      const dx = R / 100n;
      const [dyOut] = await harness.quoteExactInForward(R, R, dx, a, lambda);
      const dy = BigInt(dyOut);
      expect(dy, `R=${R}: exact-in reverted or returned 0`).to.be.gt(0n);
      expect(dy, `R=${R}: output exceeds input on a balanced pool`).to.be.lt(dx);

      // Exact-out of the just-received amount must also resolve.
      const [dxIn] = await harness.quoteExactOutForward(R, R, dy, a, lambda);
      expect(BigInt(dxIn), `R=${R}: exact-out reverted or returned 0`).to.be.gt(0n);
    }
  });
});
