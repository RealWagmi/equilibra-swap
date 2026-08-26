// ТЗ-V15 § 9.4 #6 — edge-band monotonicity for the two-knob kernel.
//
// `TwoKnobIndependence.test.ts` pins the operator-matrix decoupling at
// one off-anchor state and the 3 × 3 production envelope. That is
// sufficient for the structural decoupling claim, but leaves three
// blind spots:
//
//   1. **State sweep.** The 3 × 3 L-matrix monotonicity (rows ↓ in λ,
//      cols ↑ in a) is only asserted at one off-anchor probe
//      (`κ = 2.618`). The same property must hold across the full
//      imbalance band a real pool will ever see — from a hair off
//      anchor (5 % bias) up to deep depletion (70 % bias).
//
//   2. **Envelope corners.** A 3-point grid `{A_MIN, A_MID, A_MAX}` ×
//      `{LAMBDA_MIN, LAMBDA_MID, LAMBDA_MAX}` tests the centre and
//      the bounds, but the **diagonal corners**
//      `(a=A_MIN, λ=LAMBDA_MIN)`, `(A_MAX, LAMBDA_MIN)`, `(A_MIN,
//      LAMBDA_MAX)`, `(A_MAX, LAMBDA_MAX)` are where numerical
//      conditioning is most fragile. They get probed indirectly by
//      the matrix sweep, but a deliberate corner-only assertion makes
//      the failure mode crystal clear (you'd see exactly which corner
//      misbehaves).
//
//   3. **Slippage curve monotonicity in `d`.** The kernel must
//      produce a strictly non-decreasing `amount_out(d)` as the
//      drained fraction `d` grows — otherwise the swap-loop is
//      arbitrageable. The visualizer's `enforce_monotonic_penalty`
//      helper (`simulator/src/app/visualizer.rs:647`) exists because
//      raw per-point `sample_penalty_at_d_bps` *can* return
//      non-monotone values under floor-rounding noise on the
//      *inversion* step (find-amount-in-for-target-out bisection
//      residual). That noise lives in the visualizer's slippage
//      sampler, not in the kernel itself — but no test directly
//      pins the **kernel-level** slippage monotonicity. This file
//      adds that probe for all four envelope corners.

import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
const A_MIN = 10n ** 17n; // 0.1 · W
const A_MAX = 99n * 10n ** 16n; // 0.99 · W
const LAMBDA_MIN = 10n ** 15n; // 1e-3 · W
const LAMBDA_MAX = 10n ** 18n; // 1 · W

const A_MID = 5n * 10n ** 17n; // 0.5 · W
const LAMBDA_MID = 10n ** 16n; // 1e-2 · W
const A_GRID = [A_MIN, A_MID, A_MAX];
const LAMBDA_GRID = [LAMBDA_MIN, LAMBDA_MID, LAMBDA_MAX];

// State sweep: each probe is `(xMath, yMath)` with `yMath = κ · xMath`.
// Picks span from a near-balanced probe (`κ = 1.05`, ≈ 5 % bias) up
// to deep imbalance (`κ = 5`, ≈ 70 % bias). The kernel's
// state-distance `D = (y − x)² / (xy)` grows monotonically in `κ`,
// so this set covers `D ∈ [≈ 0.0024, ≈ 3.2]` — well past the
// `λ · D = W` half-amplification point for the entire production
// `λ` band.
const KAPPAS_BIPS: Array<{ label: string; kappaBps: bigint }> = [
  { label: "5% bias", kappaBps: 10_500n }, //  κ = 1.05
  { label: "30% bias", kappaBps: 13_000n }, //  κ = 1.3
  { label: "200% bias", kappaBps: 30_000n }, //  κ = 3.0
  { label: "400% bias", kappaBps: 50_000n }, //  κ = 5.0
];

async function deployHarness() {
  const F = await hre.ethers.getContractFactory("SwapMathHarness");
  const h: any = await F.deploy();
  await h.waitForDeployment();
  return h;
}

describe("TwoKnobMonotonicityEdge: L-matrix monotonicity across states + slippage-curve monotonicity at envelope corners (ТЗ §9.4 #6)", function () {
  this.timeout(180_000);

  let h: any;

  before(async function () {
    h = await deployHarness();
  });

  describe("L-matrix monotonicity across multiple off-anchor states", function () {
    // For every (xMath, yMath) state in the imbalance ladder, build
    // the full 3 × 3 L-matrix and assert:
    //   * rows (fixed a, sweep λ): `L` strictly non-increasing in λ
    //   * cols (fixed λ, sweep a): `L` strictly non-decreasing in a
    //
    // If the kernel ever produces a non-monotone cell at any
    // state, the corresponding `expect(...).to.be.lte/gte(...)`
    // fires with the exact failing cell labelled so the regression
    // is immediately diagnosable.

    for (const probe of KAPPAS_BIPS) {
      it(`${probe.label} (κ = ${probe.kappaBps}/10000): rows monotone ↓ in λ, cols monotone ↑ in a`, async function () {
        const xMath = 10n ** 22n; // 1e22 (≈ 10 000 math-units)
        const yMath = (xMath * probe.kappaBps) / 10_000n;

        const lMatrix: bigint[][] = [];
        for (const a of A_GRID) {
          const row: bigint[] = [];
          for (const lambda of LAMBDA_GRID) {
            const l = BigInt(await h.solveLFromState(xMath, yMath, a, lambda));
            row.push(l);
          }
          lMatrix.push(row);
        }

        // Rows: fixed a, sweep λ → L non-increasing.
        for (let i = 0; i < A_GRID.length; i += 1) {
          const row = lMatrix[i];
          for (let j = 1; j < row.length; j += 1) {
            expect(
              row[j],
              `${probe.label}, a=${A_GRID[i]}: L[λ=${LAMBDA_GRID[j]}]=${row[j]} ` +
                `should be ≤ L[λ=${LAMBDA_GRID[j - 1]}]=${row[j - 1]}`
            ).to.be.lte(row[j - 1]);
          }
        }
        // Cols: fixed λ, sweep a → L non-decreasing.
        for (let j = 0; j < LAMBDA_GRID.length; j += 1) {
          for (let i = 1; i < A_GRID.length; i += 1) {
            expect(
              lMatrix[i][j],
              `${probe.label}, λ=${LAMBDA_GRID[j]}: L[a=${A_GRID[i]}]=${lMatrix[i][j]} ` +
                `should be ≥ L[a=${A_GRID[i - 1]}]=${lMatrix[i - 1][j]}`
            ).to.be.gte(lMatrix[i - 1][j]);
          }
        }
      });
    }
  });

  describe("Slippage-curve monotonicity at production-envelope corners", function () {
    // For each of the four corners `(a, λ) ∈ {A_MIN, A_MAX} ×
    // {LAMBDA_MIN, LAMBDA_MAX}`, sweep a coarse `dx`-ladder
    // through the math-space `quoteExactInForward` kernel and
    // assert that `amount_out` is strictly non-decreasing in
    // `amount_in`. (This is the structural "no negative
    // slippage" property — a curve that runs backwards anywhere
    // is arbitrageable in a single round-trip.)
    //
    // The probes are mid-band reserves `(xMath = yMath = 1e22)`;
    // we sweep `dx` from sub-bps (`1e-6` of x) up to 60 % of x.
    // The `quoteExactInForward` kernel is anchor-coordinate
    // math-space, so we don't need to lift through `priceScale` —
    // the test directly stresses the kernel arithmetic.

    const CORNERS: Array<{ label: string; a: bigint; lambda: bigint }> = [
      { label: "(A_MIN, LAMBDA_MIN)", a: A_MIN, lambda: LAMBDA_MIN },
      { label: "(A_MIN, LAMBDA_MAX)", a: A_MIN, lambda: LAMBDA_MAX },
      { label: "(A_MAX, LAMBDA_MIN)", a: A_MAX, lambda: LAMBDA_MIN },
      { label: "(A_MAX, LAMBDA_MAX)", a: A_MAX, lambda: LAMBDA_MAX },
    ];

    for (const corner of CORNERS) {
      it(`${corner.label}: amount_out(dx) is non-decreasing across the dx ladder`, async function () {
        const xMath = 10n ** 22n;
        const yMath = xMath;
        // Geometric ladder so we exercise both micro- and
        // macro-amount probes. Pinning to bps fractions of
        // `xMath` keeps the relative size invariant across the
        // test (rather than absolute wei amounts that get tiny
        // at the upper end of the production band).
        const dxBpsLadder = [1n, 10n, 100n, 1_000n, 2_500n, 5_000n, 6_000n];
        const outs: bigint[] = [];
        for (const bps of dxBpsLadder) {
          const dx = (xMath * bps) / 10_000n;
          if (dx === 0n) {
            outs.push(0n);
            continue;
          }
          const [outRaw] = await h.quoteExactInForward(xMath, yMath, dx, corner.a, corner.lambda);
          outs.push(BigInt(outRaw));
        }

        for (let i = 1; i < outs.length; i += 1) {
          expect(
            outs[i],
            `${corner.label}: amount_out(dx[${i}]=${dxBpsLadder[i]}bps)=${outs[i]} ` +
              `regressed below amount_out(dx[${i - 1}]=${dxBpsLadder[i - 1]}bps)=${outs[i - 1]}`
          ).to.be.gte(outs[i - 1]);
        }
      });

      it(`${corner.label}: post-swap K-level-set is preserved to within sqrt-floor (1 wei)`, async function () {
        // Companion structural check at each corner: a single
        // forward swap on the fee-free math harness must leave the
        // K-level-set numerically invariant. The pool-level
        // `L_post ≥ L_pre` invariant (which DOES require fee
        // accrual) lives in `NoPersistentG.test.ts`; this probe is
        // the kernel-only version — without fees `L` is constant up
        // to a 1-wei sqrt-floor residual, and any drift larger than
        // that signals a numerical regression at the corner.
        const xMath = 10n ** 22n;
        const yMath = xMath;
        const dx = xMath / 100n; // 1 %
        const lPre = BigInt(await h.solveLFromState(xMath, yMath, corner.a, corner.lambda));
        const [outRaw] = await h.quoteExactInForward(xMath, yMath, dx, corner.a, corner.lambda);
        const out = BigInt(outRaw);
        if (out === 0n) return; // sub-wei probe (e.g. λ=MAX with κ→1) — skip
        const xPost = xMath + dx;
        const yPost = yMath - out;
        const lPost = BigInt(await h.solveLFromState(xPost, yPost, corner.a, corner.lambda));
        const drift = lPost > lPre ? lPost - lPre : lPre - lPost;
        // 1-wei tolerance: the closed-form L solver uses `sqrtWad`
        // which floors. A drift > 1 wei at the kernel level means
        // either the solver is numerically unstable at the corner
        // (the property the two-knob kernel is supposed to fix) or a multi-stage
        // mulDiv has lost precision past the documented envelope.
        expect(
          drift,
          `${corner.label}: |L_post − L_pre|=${drift} wei exceeds 1-wei sqrt-floor tolerance ` +
            `(L_pre=${lPre}, L_post=${lPost})`
        ).to.be.lte(1n);
      });
    }
  });
});
