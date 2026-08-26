import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
// The production envelope (`Constants.A_MIN_WAD..A_MAX_WAD`,
// `LAMBDA_MIN_WAD..LAMBDA_MAX_WAD`).
const A_WAD = 5n * 10n ** 17n; // 0.5 · WAD — mid-band depth-at-anchor.
const LAMBDA_WAD = 10n ** 16n; // 0.01 · WAD — moderate plateau width.

async function deployHarness() {
  const Harness = await hre.ethers.getContractFactory("SwapMathHarness");
  const h: any = await Harness.deploy();
  await h.waitForDeployment();
  return { h };
}

describe("EquilibraSwapMath helpers (decimal lift / state distance / K-and-L)", function () {
  // -------------------------------------------------------------------------
  // toWad / fromWadDown / fromWadUp — decimal-lift helpers
  // -------------------------------------------------------------------------
  describe("toWad", function () {
    it("returns the raw amount unchanged for 18-decimal tokens", async function () {
      const { h } = await loadFixture(deployHarness);
      expect(await h.toWad(123n * WAD, 18)).to.equal(123n * WAD);
      expect(await h.toWad(0n, 18)).to.equal(0n);
    });

    it("scales 6-decimal amounts up to WAD", async function () {
      const { h } = await loadFixture(deployHarness);
      // 1 USDC (1e6 raw) → 1 WAD.
      expect(await h.toWad(10n ** 6n, 6)).to.equal(WAD);
      // 1234.567890 USDC → 1234.567890 · 1e18.
      expect(await h.toWad(1234567890n, 6)).to.equal(1234567890n * 10n ** 12n);
    });

    it("scales 0-decimal amounts (raw == count of integer tokens)", async function () {
      const { h } = await loadFixture(deployHarness);
      expect(await h.toWad(7n, 0)).to.equal(7n * WAD);
    });

    it("reverts for decimals > 18", async function () {
      const { h } = await loadFixture(deployHarness);
      await expect(h.toWad(1n, 19)).to.be.revertedWithCustomError(h, "TokenDecimalsTooLarge");
    });
  });

  describe("fromWadDown", function () {
    it("returns the WAD amount unchanged for 18-decimal tokens", async function () {
      const { h } = await loadFixture(deployHarness);
      expect(await h.fromWadDown(123n * WAD, 18)).to.equal(123n * WAD);
    });

    it("floor-rounds 6-decimal conversions", async function () {
      const { h } = await loadFixture(deployHarness);
      // 1.000000_999_999_999_999 USDC (WAD) → floor to 1 USDC raw.
      const wad = 10n ** 18n + (10n ** 12n - 1n);
      expect(await h.fromWadDown(wad, 6)).to.equal(10n ** 6n);
    });

    it("reverts for decimals > 18", async function () {
      const { h } = await loadFixture(deployHarness);
      await expect(h.fromWadDown(1n, 19)).to.be.revertedWithCustomError(h, "TokenDecimalsTooLarge");
    });
  });

  describe("fromWadUp", function () {
    it("returns the WAD amount unchanged for 18-decimal tokens", async function () {
      const { h } = await loadFixture(deployHarness);
      expect(await h.fromWadUp(123n * WAD, 18)).to.equal(123n * WAD);
    });

    it("ceil-rounds 6-decimal conversions on a sub-wei remainder", async function () {
      const { h } = await loadFixture(deployHarness);
      // 1.000_000_000_000_000_001 USDC (WAD) → ceil to 1.000001 USDC raw.
      const wad = 10n ** 18n + 1n;
      expect(await h.fromWadUp(wad, 6)).to.equal(10n ** 6n + 1n);
      // Exactly 1 USDC has zero remainder → ceil == floor == 1e6.
      expect(await h.fromWadUp(10n ** 18n, 6)).to.equal(10n ** 6n);
    });

    it("reverts for decimals > 18", async function () {
      const { h } = await loadFixture(deployHarness);
      await expect(h.fromWadUp(1n, 19)).to.be.revertedWithCustomError(h, "TokenDecimalsTooLarge");
    });
  });

  // -------------------------------------------------------------------------
  // distanceState — D = (y − x)² / (xy)
  // -------------------------------------------------------------------------
  describe("distanceState", function () {
    it("reverts on zero reserves (either side)", async function () {
      const { h } = await loadFixture(deployHarness);
      await expect(h.distanceState(0n, WAD)).to.be.revertedWithCustomError(h, "InsufficientLiquidity");
      await expect(h.distanceState(WAD, 0n)).to.be.revertedWithCustomError(h, "InsufficientLiquidity");
    });

    it("returns zero at balance (xWad == yWad)", async function () {
      const { h } = await loadFixture(deployHarness);
      expect(await h.distanceState(WAD, WAD)).to.equal(0n);
      expect(await h.distanceState(50n * WAD, 50n * WAD)).to.equal(0n);
    });

    it("returns a positive symmetric distance for asymmetric reserves", async function () {
      const { h } = await loadFixture(deployHarness);
      // (y-x)²/(xy) = (1)²/(2·1) = 0.5 → 5e17 WAD
      const d = await h.distanceState(WAD, 2n * WAD);
      expect(d).to.equal(5n * 10n ** 17n);
      // Symmetry: swapping x and y must not change |y−x|² / (xy).
      const dRev = await h.distanceState(2n * WAD, WAD);
      expect(dRev).to.equal(d);
    });
  });

  // -------------------------------------------------------------------------
  // computeKAndL / balanceScaleFromK (two-knob cubic kernel)
  //
  // Anchor identity: at `x = y = L_eq`, `K = W · L_eq²`. Inverse
  // mapping `balanceScaleFromK(K) = sqrt_wad(K)` collapses to a single
  // sqrtWad — no `α` dependence as in the prior kernel.
  // -------------------------------------------------------------------------
  describe("computeKAndL / balanceScaleFromK", function () {
    it("returns positive (K, L) at a balanced state", async function () {
      const { h } = await loadFixture(deployHarness);
      const [kRaw, lRaw] = await h.computeKAndL(100n * WAD, 100n * WAD, A_WAD, LAMBDA_WAD);
      const k = BigInt(kRaw);
      const l = BigInt(lRaw);
      expect(k).to.be.greaterThan(0n);
      expect(l).to.be.greaterThan(0n);
      // At the anchor `K = W · L²` ⇒ `K_stored = mulWad(L, L)`.
      const expectedK = (l * l) / WAD;
      const diff = expectedK > k ? expectedK - k : k - expectedK;
      expect(diff).to.be.lessThan(10n);
    });

    it("returns positive (K, L) at an asymmetric state", async function () {
      const { h } = await loadFixture(deployHarness);
      const [kRaw, lRaw] = await h.computeKAndL(80n * WAD, 120n * WAD, A_WAD, LAMBDA_WAD);
      expect(BigInt(kRaw)).to.be.greaterThan(0n);
      expect(BigInt(lRaw)).to.be.greaterThan(0n);
    });

    it("returns (0, 0) on a degenerate state (zero reserve)", async function () {
      const { h } = await loadFixture(deployHarness);
      const [kRaw, lRaw] = await h.computeKAndL(0n, 100n * WAD, A_WAD, LAMBDA_WAD);
      expect(BigInt(kRaw)).to.equal(0n);
      expect(BigInt(lRaw)).to.equal(0n);
    });

    it("balanceScaleFromK round-trips against computeKAndL at the anchor", async function () {
      const { h } = await loadFixture(deployHarness);
      const reserve = 100n * WAD;
      const [kRaw, lRaw] = await h.computeKAndL(reserve, reserve, A_WAD, LAMBDA_WAD);
      const l = BigInt(lRaw);
      const lEq = BigInt(await h.balanceScaleFromK(kRaw));
      const diff = l > lEq ? l - lEq : lEq - l;
      // sqrtWad introduces sub-wei rounding; tolerate a few wei.
      expect(diff).to.be.lessThan(100n);
    });

    it("balanceScaleFromK returns 0 on zero K (degenerate state)", async function () {
      const { h } = await loadFixture(deployHarness);
      expect(BigInt(await h.balanceScaleFromK(0n))).to.equal(0n);
    });

    it("(a, λ) decoupling: at the anchor, L is independent of λ", async function () {
      // Anchor identity: at `x = y`, `D = 0`, so `A = a` regardless
      // of λ, and the L-quadratic resolves to `L = x` exactly. λ moving
      // does not perturb anchor depth.
      const { h } = await loadFixture(deployHarness);
      const reserve = 100n * WAD;
      const lambdas = [10n ** 15n, 10n ** 16n, 10n ** 17n, 10n ** 18n];
      let prev: bigint | null = null;
      for (const lambda of lambdas) {
        const [, lRaw] = await h.computeKAndL(reserve, reserve, A_WAD, lambda);
        const l = BigInt(lRaw);
        if (prev !== null) {
          expect(l).to.equal(prev);
        }
        prev = l;
      }
      // The shared L equals the anchor reserve exactly (no sqrt rounding
      // at the diagonal, the formula simplifies to `L = x`).
      expect(prev).to.equal(reserve);
    });

    it("(a, λ) decoupling: at the anchor, L is independent of a", async function () {
      const { h } = await loadFixture(deployHarness);
      const reserve = 100n * WAD;
      const aValues = [10n ** 17n, 5n * 10n ** 17n, 9n * 10n ** 17n];
      let prev: bigint | null = null;
      for (const a of aValues) {
        const [, lRaw] = await h.computeKAndL(reserve, reserve, a, LAMBDA_WAD);
        const l = BigInt(lRaw);
        if (prev !== null) {
          expect(l).to.equal(prev);
        }
        prev = l;
      }
      expect(prev).to.equal(reserve);
    });
  });
});
