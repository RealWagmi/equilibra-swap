import { exactInputReference, assertQuotePrecision } from "../helpers/continuousReference";
// Coarse two-knob depth and quote grids. Passing these samples is not a
// universal monotonicity claim: depleted tails and conditional native repair
// have known adjacent-input reversals. SmallLambdaMonotonicity.test.ts replays
// those witnesses; the shared Rust integration test also rescans the dense grid.
// A quote reversal alone does not establish a profitable closed swap cycle.

import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
const A_MIN = 10n ** 17n; // 0.1 · W
const A_MAX = WAD - 1n; // largest fixed-point alpha strictly below 1
const LAMBDA_MIN = 10n ** 12n; // 1e-6 · W
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
    // assert that `amount_out` is non-decreasing in `amount_in`
    // on this sampled grid, not universally in depleted tails.
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
        // Match the Router's price-target probe cap. Direct swaps and
        // exact-in quotes do not impose this 99% input limit.
        const dxBpsLadder = [1n, 10n, 100n, 1_000n, 2_500n, 5_000n, 6_000n, 7_500n, 9_000n, 9_900n];
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

      it(`${corner.label}: the common margin increases depth without excessive underquote`, async function () {
        // Fee-free returned quotes now retain an explicit common margin.
        const xMath = 10n ** 22n;
        const yMath = xMath;
        const dx = xMath / 100n; // 1 %
        const lPre = BigInt(await h.solveLFromState(xMath, yMath, corner.a, corner.lambda));
        const [outRaw] = await h.quoteExactInForward(xMath, yMath, dx, corner.a, corner.lambda);
        const out = BigInt(outRaw);
        expect(out).to.be.greaterThan(0n);
        const xPost = xMath + dx;
        const yPost = yMath - out;
        const lPost = BigInt(await h.solveLFromState(xPost, yPost, corner.a, corner.lambda));
        expect(lPost, "retained margin must not reduce depth").to.be.at.least(lPre);
        const ref = await exactInputReference(h, xMath, yMath, dx, corner.a, corner.lambda);
        assertQuotePrecision(out, ref.referenceMath, ref.iterations, 1n, corner.label);
      });
    }
  });
  describe("Error direction past the whole reserve", function () {
    // Fee-free raw math: preserve the existing one-sided depth budget
    // on successful quotes. At high alpha / lambda=1e12 some large tail
    // probes reach the 40-iteration limit; verify that exact refusal,
    // not a returned unchecked result. Native settlement's strict LP
    // guard is tested separately and has no such depth tolerance.

    const AS: Array<[string, bigint]> = [
      ["A_MIN", A_MIN],
      ["preset", 909610000000000030n],
      ["A_MAX", A_MAX],
    ];
    const LAMBDAS: Array<[string, bigint]> = [
      ["LAMBDA_MIN", LAMBDA_MIN],
      ["preset", 16780000000000000n],
      ["LAMBDA_MAX", LAMBDA_MAX],
    ];
    // Anchor plus both de-anchored directions, including whole-reserve inputs.
    const STATES: Array<[string, bigint, bigint]> = [
      ["anchor", 10n ** 22n, 10n ** 22n],
      ["y = x/4", 10n ** 22n, 10n ** 22n / 4n],
      ["y = 4x", 10n ** 22n, 4n * 10n ** 22n],
    ];
    // Include a substantial 0.1% control so every state exercises a
    // successful quote even when its large tail probes are refused.
    const IN_SIZE_PERMILLE = [1n, 900n, 1_000n, 1_050n, 1_500n, 3_000n];
    // Exact-out: output is bounded by the reserve it is drawn from, so
    // the demanding end is near-total depletion instead.
    const OUT_SIZE_PERMILLE = [900n, 990n, 999n];

    it("successful exact-in quotes preserve depth; extreme nonconvergence is explicit", async function () {
      for (const [aTag, a] of AS) {
        for (const [lTag, lambda] of LAMBDAS) {
          for (const [sTag, x, y] of STATES) {
            const lPre = BigInt(await h.solveLFromState(x, y, a, lambda));
            const tolerance = lPre / 10n ** 15n;
            let completed = 0;
            let largeCompleted = 0;
            const refused: bigint[] = [];
            for (const permille of IN_SIZE_PERMILLE) {
              const dx = (x * permille) / 1_000n;
              let out: bigint;
              try {
                const [outRaw] = await h.quoteExactInForward(x, y, dx, a, lambda);
                out = BigInt(outRaw);
              } catch (error) {
                const tag = `a=${aTag} λ=${lTag} state=${sTag} dx=${permille}/1000`;
                expect(a, tag).to.be.gt(A_MIN);
                expect(lambda, tag).to.equal(LAMBDA_MIN);
                expect(permille, tag).to.be.gte(900n);
                expect((error as { data?: string }).data, tag).to.equal(
                  h.interface.getError("SolverDidNotConverge")!.selector
                );
                refused.push(permille);
                continue;
              }
              expect(out).to.be.gt(0n);
              const lPost = BigInt(await h.solveLFromState(x + dx, y - out, a, lambda));
              expect(
                lPost + tolerance,
                `a=${aTag} λ=${lTag} state=${sTag} dx=${permille}/1000 of x: ` +
                  `L_post=${lPost} fell below L_pre=${lPre} beyond floor dust`
              ).to.be.gte(lPre);
              completed += 1;
              if (permille > 1n) largeCompleted += 1;
            }
            expect(completed, `a=${aTag} λ=${lTag} state=${sTag}: no depth checks executed`).to.be.gt(0);
            expect(largeCompleted, "the 0.1% control must not be the only successful quote").to.be.gt(0);
            // Curve-aware seeding resolves every former refusal in this grid.
            expect(refused, `a=${aTag} λ=${lTag} state=${sTag}: refusal frontier changed`).to.deep.equal([]);
          }
        }
      }
    });

    it("exact-out never settles below the pre-state depth", async function () {
      for (const [aTag, a] of AS) {
        for (const [lTag, lambda] of LAMBDAS) {
          for (const [sTag, x, y] of STATES) {
            const lPre = BigInt(await h.solveLFromState(x, y, a, lambda));
            const tolerance = lPre / 10n ** 15n;
            for (const permille of OUT_SIZE_PERMILLE) {
              const dy = (y * permille) / 1_000n;
              const [inRaw] = await h.quoteExactOutForward(x, y, dy, a, lambda);
              const paid = BigInt(inRaw);
              if (paid === 0n) continue;
              const lPost = BigInt(await h.solveLFromState(x + paid, y - dy, a, lambda));
              expect(
                lPost + tolerance,
                `a=${aTag} λ=${lTag} state=${sTag} dy=${permille}/1000 of y: ` +
                  `L_post=${lPost} fell below L_pre=${lPre} beyond floor dust`
              ).to.be.gte(lPre);
            }
          }
        }
      }
    });
  });
});
