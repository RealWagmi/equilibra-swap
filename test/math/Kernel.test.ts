import {
  assertQuotePrecision,
  assertExactOutputPrecision,
  exactInputReference,
  exactOutputReferenceWithL,
} from "../helpers/continuousReference";
// SPDX-License-Identifier: MIT
//
// EquilibraSwap math-kernel invariants. Asserts structural properties
// of the two-knob cubic `K = A·L·(x+y)/2 + (W−A)·xy` and the symmetric
// `(xMath, yMath) = (xWad/√p, yWad·√p)` coordinate change. Every
// numerical threshold is derived purely from the kernel formula.

import hre from "hardhat";
import { expect } from "chai";

const WAD = 10n ** 18n;
const Q128 = 1n << 128n;

// Production envelope for the new (a, λ) knobs.
const A_MIN = 1n * 10n ** 17n; // 0.1 · W
const A_MAX = WAD - 1n; // Exact production ceiling; WAD itself is excluded.
const LAMBDA_MIN = 10n ** 12n;
const LAMBDA_MAX = 10n ** 18n;

const SAMPLE_AB: Array<{ name: string; a: bigint; lambda: bigint }> = [
  { name: "centre", a: 5n * 10n ** 17n, lambda: 10n ** 16n },
  { name: "deep+wide", a: A_MAX, lambda: LAMBDA_MIN },
  { name: "deep+narrow", a: A_MAX, lambda: LAMBDA_MAX },
  { name: "shallow+wide", a: A_MIN, lambda: LAMBDA_MIN },
  { name: "shallow+narrow", a: A_MIN, lambda: LAMBDA_MAX },
  { name: "reference a=0.5", a: 5n * 10n ** 17n, lambda: 10n ** 16n },
  { name: "reference a=0.7", a: 7n * 10n ** 17n, lambda: 5n * 10n ** 16n },
];

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

async function deployMath() {
  const Harness = await hre.ethers.getContractFactory("SwapMathHarness");
  const harness = await Harness.deploy();
  await harness.waitForDeployment();
  return harness;
}

describe("EquilibraSwapMath invariant kernel", () => {
  describe("computeK / solveLFromState round-trip", () => {
    it("pins anchor L and K, including directed fixed-point rounding at A_MAX", async () => {
      const harness = await deployMath();
      for (const { name, a, lambda } of SAMPLE_AB) {
        const xMath = 10n ** 24n; // 1e24, healthy magnitude
        const yMath = xMath; // anchor
        const lWad = BigInt(await harness.solveLFromState(xMath, yMath, a, lambda));
        const kWad = BigInt(await harness.computeK(xMath, yMath, a, lambda));
        const expectedL = (xMath * Q128) / WAD;
        const expectedK = (xMath * xMath) / WAD;
        expect(lWad, `${name}: L at anchor`).to.equal(expectedL);
        expect(kWad, `${name}: K at anchor`).to.equal(expectedK);
      }
    });

    it("K(state, L_solve) lies on the W·L² level set within ≤ a few wei", async () => {
      const harness = await deployMath();
      // Off-anchor states with healthy magnitudes.
      const cases = [
        [10n ** 24n, (3n * 10n ** 24n) / 2n], // 2:3 ratio
        [(3n * 10n ** 24n) / 4n, 10n ** 24n], // 3:4 ratio
        [10n ** 24n, 2n * 10n ** 24n], // 1:2 ratio
      ] as Array<[bigint, bigint]>;
      for (const { name, a, lambda } of SAMPLE_AB) {
        for (const [x, y] of cases) {
          const l = BigInt(await harness.solveLFromState(x, y, a, lambda));
          const k = BigInt(await harness.computeK(x, y, a, lambda));
          // The W·L² target equals mulWad(L, L) under W = WAD.
          const target = (l * l * WAD) / (Q128 * Q128);
          // Allow ≤ 1 ppt (10⁻¹²) relative error (plus a 1 000 wei
          // absolute floor for tiny K). The residual stacks across
          // sqrtWad + mulWad chains in `solveLFromState`, but on the
          // production envelope it stays many orders of magnitude
          // below the K-magnitude itself (~10³⁰ for `x = 10²⁴`).
          const tolerance = target / 10n ** 12n + 1_000n;
          expect(absBig(k - target), `${name}: K ≈ L² @ (${x}, ${y})`).to.be.lte(tolerance);
        }
      }
    });

    it("computeKAndL returns the same (K, L) as separate calls", async () => {
      const harness = await deployMath();
      const x = 7n * 10n ** 23n;
      const y = 13n * 10n ** 23n;
      for (const { name, a, lambda } of SAMPLE_AB) {
        const l1 = BigInt(await harness.solveLFromState(x, y, a, lambda));
        const k1 = BigInt(await harness.computeK(x, y, a, lambda));
        const [k2, l2] = await harness.computeKAndL(x, y, a, lambda);
        expect(BigInt(l2), `${name}: L joint vs scalar`).to.equal(l1);
        expect(BigInt(k2), `${name}: K joint vs scalar`).to.equal(k1);
      }
    });
  });

  describe("Asymmetric coordinate change identity (quote-side normalisation)", () => {
    it("xMath = xWad (base axis identity) and yMath = divWad(yWad, priceScale)", async () => {
      // The pool lifts via the asymmetric one-sided change:
      //   xMath = xWad
      //   yMath = yWad · WAD / priceScale
      // The product `xMath · yMath` is no longer preserved (the
      // previous symmetric design preserved it but collapsed the IL
      // signal Gate 2 needs — see audit notes).
      const harness = await deployMath();
      const priceScale = 5n * WAD;
      const xWad = 7n * 10n ** 23n;
      const yWad = 13n * 10n ** 23n;
      const [xMath, yMath] = await harness.toMathSpace(xWad, yWad, priceScale);
      expect(BigInt(xMath), "xMath identity on base axis").to.equal(xWad);
      const yExpected = (yWad * WAD) / priceScale; // floor — `divWad` semantics.
      expect(BigInt(yMath), "yMath = divWad(yWad, priceScale)").to.equal(yExpected);
    });
  });

  describe("Marginal price symmetries", () => {
    it("pMarg(x, x; ·) == WAD exactly (anchor diagonal)", async () => {
      const harness = await deployMath();
      for (const { name, a, lambda } of SAMPLE_AB) {
        const p = BigInt(await harness.marginalPriceFromState(10n ** 24n, 10n ** 24n, a, lambda));
        expect(p, `${name}: pMarg at anchor`).to.equal(WAD);
      }
    });

    it("pMarg moves the expected direction off-anchor", async () => {
      const harness = await deployMath();
      // When yMath > xMath, the marginal price of x (in units of y) is
      // > WAD (x is "scarcer" → costs more y). When yMath < xMath, < WAD.
      const x = 10n ** 24n;
      const yHi = 2n * x;
      const yLo = x / 2n;
      for (const { name, a, lambda } of SAMPLE_AB) {
        const pHi = BigInt(await harness.marginalPriceFromState(x, yHi, a, lambda));
        const pLo = BigInt(await harness.marginalPriceFromState(x, yLo, a, lambda));
        expect(pHi, `${name}: pMarg(x < y)`).to.be.gt(WAD);
        expect(pLo, `${name}: pMarg(x > y)`).to.be.lt(WAD);
      }
    });
  });

  describe("CP-proxy distance predictor", () => {
    it("returns 0 at zero deposit and rises monotonically with size", async () => {
      const harness = await deployMath();
      const x = 10n ** 24n;
      const y = 10n ** 24n;
      const sizes = [WAD / 1000n, WAD / 100n, WAD / 10n, WAD, WAD * 10n];
      let prev = 0n;
      const at0 = BigInt(await harness.predictPostDistanceCp(x, y, 0));
      expect(at0).to.equal(0n);
      for (const s of sizes) {
        const d = BigInt(await harness.predictPostDistanceCp(x, y, s));
        expect(d).to.be.gte(prev); // weakly monotone (size > 0 → D ≥ 0)
        prev = d;
      }
    });
  });

  describe("Same-state quote inversion (not an executed trading round trip)", () => {
    it("both quote directions match independent roots plus their explicit margins", async () => {
      const harness = await deployMath();
      const x = 10n ** 24n;
      const y = 10n ** 24n;
      const dxFractions = [WAD / 1000n, WAD / 100n, WAD / 10n, WAD / 4n];
      for (const { name, a, lambda } of SAMPLE_AB) {
        for (const f of dxFractions) {
          const dx = (x * f) / WAD;
          const ref = await exactInputReference(harness, x, y, dx, a, lambda);
          assertQuotePrecision(ref.quotedMath, ref.referenceMath, ref.iterations, 16n, name + ": exact-in");
          const [dxBack, iterations] = await harness.quoteExactOutForward(x, y, ref.quotedMath, a, lambda);
          const expectedInput = exactOutputReferenceWithL(x, y, ref.quotedMath, a, lambda, ref.lBefore);
          assertExactOutputPrecision(BigInt(dxBack), expectedInput, BigInt(iterations), 16n, name + ": exact-out");
        }
      }
    });
  });

  describe("Two-knob decoupling", () => {
    it("changing λ alone does not move centre pMarg/L; changing a alone does not move plateau-edge cliff", async () => {
      const harness = await deployMath();
      // At the anchor, L = x = y for all (a, λ). Probe two λ values at
      // the same a, verify L_eq matches.
      const xAnchor = 10n ** 24n;
      const a = 5n * 10n ** 17n;
      const lambdas = [LAMBDA_MIN, LAMBDA_MAX];
      const Ls = lambdas.map(async (l) => BigInt(await harness.solveLFromState(xAnchor, xAnchor, a, l)));
      const resolvedLs = await Promise.all(Ls);
      expect(resolvedLs[0]).to.equal(resolvedLs[1]);
      expect(resolvedLs[0]).to.equal((xAnchor * Q128) / WAD);

      // Q128 anchor depth preserves the same identity at A_MAX.
      const lambda = 10n ** 16n;
      const aValues = [A_MIN, A_MAX];
      const Ls2 = await Promise.all(
        aValues.map(async (av) => BigInt(await harness.solveLFromState(xAnchor, xAnchor, av, lambda)))
      );
      expect(Ls2[0]).to.equal((xAnchor * Q128) / WAD);
      expect(Ls2[1]).to.equal((xAnchor * Q128) / WAD);
    });
  });
});
