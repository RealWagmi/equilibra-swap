// Direct unit tests for the `PoolOracle` repeg-step helpers:
// `shiftPriceScale` (the composed wrapper), `appliedRepegStep` (the
// damping cap) and `applyLogStep` (the log-domain move). The functions
// gate every auto-repeg, but their damping logic and revert surface are
// only exercised indirectly via the pool's swap path elsewhere — this
// file pins each branch:
//   * Damping cap `appliedStepWad = min(repegStepWad, deviation/5)`
//   * Log-domain move `psNew = mulWad(ps, expWad(±applied))`
//   * No-progress guard (`deviation < REPEG_DAMPING_DIVISOR` wei)
//   * No-overshoot clamp (landing exactly ON the target, never past it)
//   * Equality short-circuit (`target == priceScale`)
//   * Up/down reciprocal exactness (`exp(s)·exp(−s) == 1` up to dust)
//   * Revert paths (`InvalidPriceScale`, `InvalidRepegStep`).
//
// Expected post-step values are pinned to the exact Solady `expWad`
// outputs; the Rust reference (`apply_log_step` in
// `runtime_quoter/equilibra.rs`) pins the same numbers, so a drift on
// either side breaks one of the two suites before it can reach parity.
import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
// Mirrors `Constants.REPEG_DAMPING_DIVISOR` (5). Tightening the divisor
// in `Constants.sol` requires updating this constant — the test would
// otherwise silently keep passing under stale assumptions.
const REPEG_DAMPING_DIVISOR = 5n;

function expectedAppliedStep(
  priceScaleOld: bigint,
  target: bigint,
  repegStepWad: bigint
): { applied: bigint; deviation: bigint } {
  // Geometric (multiplicative) deviation |max/min − 1| — matches the
  // contract's activation metric. A ±2× move reads 1.0 WAD both ways.
  const [hi, lo] = target >= priceScaleOld ? [target, priceScaleOld] : [priceScaleOld, target];
  const deviation = (hi * WAD) / lo - WAD;
  const damped = deviation / REPEG_DAMPING_DIVISOR;
  const applied = repegStepWad < damped ? repegStepWad : damped;
  return { applied, deviation };
}

describe("PoolOracle.shiftPriceScale: damped log step + revert surface", function () {
  let harness: any;

  before(async function () {
    const F = await hre.ethers.getContractFactory("PoolOracleHarness");
    harness = await F.deploy();
    await harness.waitForDeployment();
  });

  it("returns (priceScale, 0) when target == priceScale (equality short-circuit)", async function () {
    const priceScale = WAD;
    const [newScale, moved] = await harness.shiftPriceScale(priceScale, priceScale, WAD / 1_000n);
    expect(newScale).to.equal(priceScale);
    expect(moved).to.equal(0n);
  });

  it("damping caps the step at deviation / REPEG_DAMPING_DIVISOR for an upward move", async function () {
    // 2 % deviation, large `repegStepWad` so damping (`deviation / 5`)
    // dominates: appliedStep == 0.02 / 5 = 4e15. The move is applied in
    // the log domain: psNew = mulWad(ps, expWad(+4e15)) — e^0.004 ·
    // 1e18 = 1004008010677341872 under Solady's expWad.
    const priceScale = WAD;
    const target = (priceScale * 102n) / 100n; // +2%
    const repegStepWad = WAD; // 100% (won't bind)

    const { applied, deviation } = expectedAppliedStep(priceScale, target, repegStepWad);
    const expectedNewScale = 1004008010677341872n;

    const [newScale, moved] = await harness.shiftPriceScale(priceScale, target, repegStepWad);
    expect(deviation).to.equal((WAD * 2n) / 100n);
    expect(applied).to.equal(deviation / REPEG_DAMPING_DIVISOR);
    expect(newScale).to.equal(expectedNewScale);
    expect(moved).to.equal(expectedNewScale - priceScale);
  });

  it("damping caps the step at deviation / REPEG_DAMPING_DIVISOR for a downward move", async function () {
    const priceScale = WAD;
    const target = (priceScale * 98n) / 100n; // −2%
    const repegStepWad = WAD;

    const { applied, deviation } = expectedAppliedStep(priceScale, target, repegStepWad);
    // Geometric downward deviation for a −2% target: ps/target − 1 =
    // 1/0.98 − 1 ≈ 2.0408% (vs a linear 2.0%); applied = dev/5 =
    // 4081632653061224 wei. psNew = mulWad(ps, expWad(−applied)) =
    // 995926685887904708.
    const expectedNewScale = 995926685887904708n;

    const [newScale, moved] = await harness.shiftPriceScale(priceScale, target, repegStepWad);
    expect(deviation).to.equal((WAD * WAD) / target - WAD);
    expect(applied).to.equal(deviation / REPEG_DAMPING_DIVISOR);
    expect(newScale).to.equal(expectedNewScale);
    expect(moved).to.equal(priceScale - expectedNewScale);
  });

  it("repegStepWad binds when deviation/5 exceeds the configured cap", async function () {
    // 50 % deviation; configured step = 0.1% — repegStepWad binds.
    // psNew = mulWad(ps, expWad(+1e15)) = e^0.001 · 1e18 =
    // 1001000500166708341.
    const priceScale = WAD;
    const target = (priceScale * 150n) / 100n;
    const repegStepWad = WAD / 1_000n; // 0.1%

    const { applied } = expectedAppliedStep(priceScale, target, repegStepWad);
    expect(applied).to.equal(repegStepWad);
    const expectedNewScale = 1001000500166708341n;

    const [newScale, moved] = await harness.shiftPriceScale(priceScale, target, repegStepWad);
    expect(newScale).to.equal(expectedNewScale);
    expect(moved).to.equal(expectedNewScale - priceScale);
  });

  // The geometric deviation makes a ±2× move register exactly 1.0 WAD
  // in BOTH directions. Under the EMA's symmetric `[ps/2, 2ps]` clamp
  // this is the maximum reachable deviation either way, so the full
  // `repegStepWad ∈ [1, WAD]` range activates symmetrically. The
  // deviation here is bit-exact with `_tryAutoRepeg`'s activation gate.
  it("geometric deviation: ±2× moves both register 1.0 WAD (symmetric)", async function () {
    const priceScale = WAD;

    // Upward 2× (EMA at the upper clamp) → deviation 1.0 WAD.
    const up = expectedAppliedStep(priceScale, priceScale * 2n, WAD);
    expect(up.deviation, "upward 2x").to.equal(WAD);

    // Downward 2× (EMA at the lower clamp ps/2) → deviation 1.0 WAD too.
    const down = expectedAppliedStep(priceScale, priceScale / 2n, WAD);
    expect(down.deviation, "downward 2x").to.equal(WAD);

    // And the contract actually moves the anchor DOWN for a ps/2 target
    // with a large step (repegStepWad = WAD): applied = min(WAD, 1.0/5)
    // = 0.2, so newScale = mulWad(ps, expWad(−0.2)) = e^−0.2 · 1e18 =
    // 818730753077981858.
    expect(down.applied).to.equal(WAD / 5n);
    const expectedNewScale = 818730753077981858n;
    const [newScale, moved] = await harness.shiftPriceScale(priceScale, priceScale / 2n, WAD);
    expect(newScale).to.equal(expectedNewScale);
    expect(moved).to.equal(priceScale - expectedNewScale);
  });

  it("no-progress guard keeps the scale put when deviation < REPEG_DAMPING_DIVISOR wei", async function () {
    // Deviation of `4` wei → damping cap `0` (integer division), so the
    // step rounds to zero and the function must return (priceScale, 0)
    // without modifying the scale by even 1 wei. Any delta larger than
    // `REPEG_DAMPING_DIVISOR - 1 == 4` would clear the gate.
    const priceScale = WAD;
    const target = priceScale + 4n;
    const [newScale, moved] = await harness.shiftPriceScale(priceScale, target, WAD);
    expect(newScale).to.equal(priceScale);
    expect(moved).to.equal(0n);
  });

  it("full-cap upward step multiplies by e (deep imbalanced move)", async function () {
    // Huge deviation upward with `repegStepWad = WAD` and priceScale =
    // 10 wei: damped == deviation/5 ≫ WAD ⇒ applied == WAD, so the move
    // is one full e-fold: newScale = mulWad(10, expWad(WAD)) =
    // ⌊10 · 2.718281828…⌋ = 27 wei.
    const priceScale = 10n; // 10 wei
    const target = WAD * 10n; // huge target
    const repegStepWad = WAD; // 100%

    const [newScale] = await harness.shiftPriceScale(priceScale, target, repegStepWad);
    expect(newScale).to.equal(27n);
  });

  it("stays strictly short of the target under divisor-5 damping (no overshoot)", async function () {
    // With `applied = min(repegStepWad, dev/5)` and `repegStepWad ≤
    // WAD` the log step cannot reach the target in one call for any
    // gap: downward the worst case is one ÷e fold (e^−1 ≈ 0.368 of the
    // anchor), still above a target more than e× away, and for nearer
    // targets `dev/5 < ln(1 + dev)` keeps the landing short. Pin a
    // spread of gaps on both sides.
    const priceScale = WAD;
    const cases: Array<[bigint, bigint]> = [
      [(WAD * 19n) / 100n, WAD], // gap 5.26x down, dev/5 binds
      [WAD / 10n, WAD], //          gap 10x down, full-cap ÷e fold
      [(WAD * 19n) / 100n, (WAD * 82n) / 100n], // step ceiling binds
      [WAD * 4n, WAD], //           gap 4x up, dev/5 = 0.6 binds
      [WAD * 100n, WAD], //         gap 100x up, full-cap ×e fold
    ];
    for (const [target, step] of cases) {
      const [newScale] = await harness.shiftPriceScale(priceScale, target, step);
      if (target < priceScale) {
        expect(newScale, `target=${target} step=${step}`).to.be.greaterThan(target);
        expect(newScale, `target=${target} step=${step}`).to.be.lessThan(priceScale);
      } else {
        expect(newScale, `target=${target} step=${step}`).to.be.lessThan(target);
        expect(newScale, `target=${target} step=${step}`).to.be.greaterThan(priceScale);
      }
    }
    // The full-cap downward fold is exactly one ÷e: e^−1 · 1e18 =
    // 367879441171442321 (Solady expWad, floor rounding).
    const [fullFold] = await harness.shiftPriceScale(priceScale, WAD / 10n, WAD);
    expect(fullFold).to.equal(367879441171442321n);
  });

  it("applyLogStep clamps an oversized raw step exactly ON the target (both directions)", async function () {
    // The composed `shiftPriceScale` path cannot overshoot (previous
    // test), but `applyLogStep` accepts any raw `applied` — the
    // halving ladder feeds it `base >> k` and library callers could
    // pass an un-damped magnitude. An e-fold (applied = WAD) against a
    // ±10% target must land exactly ON the target, never past it.
    const priceScale = WAD;
    const upTarget = (priceScale * 110n) / 100n;
    expect(await harness.applyLogStep(priceScale, upTarget, WAD)).to.equal(upTarget);
    const downTarget = (priceScale * 90n) / 100n;
    expect(await harness.applyLogStep(priceScale, downTarget, WAD)).to.equal(downTarget);
  });

  it("applyLogStep up/down moves of one magnitude are reciprocal up to dust", async function () {
    // exp(s) · exp(−s) == 1 exactly in the reals; in WAD fixed point
    // the round trip may lose only rounding dust (≤ ps / 1e12 — the
    // same tolerance the Rust reference pins). This is the property
    // that keeps mirrored (reciprocal-frame) pools on reciprocal
    // anchors instead of accumulating an O(s²) drift per repeg.
    const priceScale = 3n * 10n ** 17n;
    const applied = 3n * 10n ** 17n; // 0.3 — far from any clamp below
    const upped = BigInt(await harness.applyLogStep(priceScale, WAD * 100n, applied));
    const roundTripped = BigInt(await harness.applyLogStep(upped, 1n, applied));
    const drift = roundTripped >= priceScale ? roundTripped - priceScale : priceScale - roundTripped;
    expect(drift).to.be.lessThanOrEqual(priceScale / 10n ** 12n);
  });

  it("appliedRepegStep returns min(cap, deviation/5)", async function () {
    expect(await harness.appliedRepegStep(WAD, WAD / 10n)).to.equal(WAD / 50n);
    expect(await harness.appliedRepegStep(WAD / 100n, WAD)).to.equal(WAD / 100n);
    expect(await harness.appliedRepegStep(WAD, 4n)).to.equal(0n);
  });

  it("reverts with InvalidPriceScale when priceScale or target is zero", async function () {
    await expect(harness.shiftPriceScale(0n, WAD, WAD / 1_000n)).to.be.revertedWithCustomError(
      harness,
      "InvalidPriceScale"
    );
    await expect(harness.shiftPriceScale(WAD, 0n, WAD / 1_000n)).to.be.revertedWithCustomError(
      harness,
      "InvalidPriceScale"
    );
  });

  it("reverts with InvalidRepegStep when repegStepWad is 0 or > WAD", async function () {
    await expect(harness.shiftPriceScale(WAD, WAD * 2n, 0n)).to.be.revertedWithCustomError(harness, "InvalidRepegStep");
    await expect(harness.shiftPriceScale(WAD, WAD * 2n, WAD + 1n)).to.be.revertedWithCustomError(
      harness,
      "InvalidRepegStep"
    );
  });
});
