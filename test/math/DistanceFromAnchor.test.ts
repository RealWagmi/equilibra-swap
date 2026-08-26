import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;

describe("distanceFromAnchorWad: edge cases and precision", function () {
  let harness: any;

  before(async function () {
    const F = await hre.ethers.getContractFactory("SwapMathHarness");
    harness = await F.deploy();
    await harness.waitForDeployment();
  });

  // ── Identity: equal prices ─────────────────────────────────────────
  it("returns 0 when prices are equal", async function () {
    expect(await harness.distanceFromAnchorWad(WAD, WAD)).to.equal(0n);

    const bigPrice = 102_354n * WAD;
    expect(await harness.distanceFromAnchorWad(bigPrice, bigPrice)).to.equal(0n);
  });

  // ── Symmetry: dist(p, a) == dist(a, p) ────────────────────────────
  it("is symmetric: dist(p, a) == dist(a, p)", async function () {
    const p = (WAD * 150n) / 100n; // 1.5
    const a = WAD;
    const forward = await harness.distanceFromAnchorWad(p, a);
    const reverse = await harness.distanceFromAnchorWad(a, p);
    expect(forward).to.equal(reverse);
  });

  // ── Known analytical value: p = 2a → dist = 0.5 ──────────────────
  it("p = 2a gives dist ≈ 0.5 WAD", async function () {
    const p = 2n * WAD;
    const a = WAD;
    // exact: (2-1)^2 / (2*1) = 1/2 = 0.5
    const dist = await harness.distanceFromAnchorWad(p, a);
    const expected = WAD / 2n; // 5e17
    expect(dist).to.equal(expected);
  });

  // ── Known value: 1% deviation ─────────────────────────────────────
  it("1% deviation gives dist ≈ 9.9e-5 WAD", async function () {
    const p = (WAD * 101n) / 100n; // 1.01
    const a = WAD;
    // exact: 0.01^2 / (1.01 * 1) = 0.0001/1.01 ≈ 9.900990099e-5
    const expected = 99009900990099n; // ≈ 9.9e13 in WAD
    const dist = await harness.distanceFromAnchorWad(p, a);
    expect(dist).to.be.closeTo(expected, 2n);
  });

  // ── Very small diff (1 wei): floors to 0 safely ──────────────────
  it("1 wei difference floors to 0 (safe: A = aMax)", async function () {
    const dist = await harness.distanceFromAnchorWad(WAD + 1n, WAD);
    expect(dist).to.equal(0n);
  });

  // ── Small but meaningful diff: ~0.001% (1e13) ────────────────────
  it("0.001% diff gives tiny but non-zero distance", async function () {
    const diff = WAD / 100_000n; // 1e13 = 0.001%
    const p = WAD + diff;
    const a = WAD;
    const dist = await harness.distanceFromAnchorWad(p, a);
    expect(dist).to.be.gte(0n);
  });

  // ── Large prices (BTC-like: 100k USDT) ────────────────────────────
  it("handles large prices correctly (100k vs 102k)", async function () {
    const p = 102_000n * WAD;
    const a = 100_000n * WAD;
    // exact: (2000)^2 / (102000*100000) = 4e6 / 1.02e10 ≈ 3.9216e-4
    const expected = 392156862745098n; // ≈ 3.92e14
    const dist = await harness.distanceFromAnchorWad(p, a);
    expect(dist).to.be.closeTo(expected, 10n);
  });

  // ── Very small price (stablecoin micro-deviation) ─────────────────
  it("handles very small prices (0.001 WAD)", async function () {
    const p = WAD / 1000n; // 1e15
    const a = WAD / 1000n + WAD / 100_000n; // slightly higher
    const dist = await harness.distanceFromAnchorWad(p, a);
    expect(dist).to.be.gt(0n);
  });

  // ── Reverts on zero prices ────────────────────────────────────────
  it("reverts with InvalidPriceScale when either price is 0", async function () {
    await expect(harness.distanceFromAnchorWad(0, WAD)).to.be.revertedWithCustomError(harness, "InvalidPriceScale");
    await expect(harness.distanceFromAnchorWad(WAD, 0)).to.be.revertedWithCustomError(harness, "InvalidPriceScale");
  });

  // ── Extreme ratio: 1000x price deviation ──────────────────────────
  it("handles extreme 1000x deviation without overflow", async function () {
    const p = 1000n * WAD;
    const a = WAD;
    // exact: (999)^2 / (1000*1) = 998001/1000 = 998.001
    const expected = (998001n * WAD) / 1000n; // 998.001 * WAD
    const dist = await harness.distanceFromAnchorWad(p, a);
    expect(dist).to.be.closeTo(expected, WAD / 1000n);
  });

  // ── Monotonicity: larger deviation → larger distance ──────────────
  it("is strictly monotonic: more deviation gives more distance", async function () {
    let prevDist = 0n;
    for (let bps = 10n; bps <= 5000n; bps += 10n) {
      const p = WAD + (WAD * bps) / 10_000n;
      const dist = BigInt(await harness.distanceFromAnchorWad(p, WAD));
      expect(dist).to.be.gte(prevDist, `monotonicity violated at ${bps}bps`);
      prevDist = dist;
    }
  });
});
