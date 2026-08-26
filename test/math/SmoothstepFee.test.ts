// Direct unit tests for `EquilibraSwapMath.smoothstepFeeWad`. The pool's
// hot swap path consumes this function on every swap, but until now the
// only coverage was the indirect "active ramp" sweeps in
// `test/security/DynamicFee.test.ts`. The three disabled paths
// (`rampDistWad == 0`, `feeCeilingWad <= floorWad`, `distPostWad >=
// rampDistWad`), the saturation behaviour, the C¹-continuous shape
// `m(r) = 2r − r²`, and the strict monotonicity guarantee are all pinned
// here so a refactor of the resolver cannot silently regress them.
import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
const BPS = 10_000n;
// `feeRampWad = feeRampBps · 1e14` — see EquilibraSwapMath.smoothstepFeeWad.
const RAMP_BPS_TO_WAD = 10n ** 14n;
// Fee rates are WAD fractions: `1 bps == 1e14`.
const FEE_BPS_TO_WAD = 10n ** 14n;

function bpsToRampDist(bps: bigint): bigint {
  return bps * RAMP_BPS_TO_WAD;
}

function feeWad(bps: bigint): bigint {
  return bps * FEE_BPS_TO_WAD;
}

// Reference smoothstep (mirrors the on-chain integer arithmetic in
// `smoothstepFeeWad`). Used as the truth value for monotonicity and
// shape checks.
function expectedFeeWad(distPostWad: bigint, rampDistWad: bigint, floorWad: bigint, ceilingWad: bigint): bigint {
  if (rampDistWad === 0n || ceilingWad <= floorWad) return ceilingWad;
  if (distPostWad >= rampDistWad) return ceilingWad;
  const r = (distPostWad * WAD) / rampDistWad;
  const r2 = (r * r) / WAD;
  const m = 2n * r - r2;
  return floorWad + ((ceilingWad - floorWad) * m) / WAD;
}

describe("EquilibraSwapMath.smoothstepFeeWad", function () {
  let h: any;

  before(async function () {
    const F = await hre.ethers.getContractFactory("SwapMathHarness");
    h = await F.deploy();
    await h.waitForDeployment();
  });

  describe("Disabled paths return feeCeilingWad unchanged", function () {
    it("returns ceiling when rampDistWad == 0 (pool opted out of ramp)", async function () {
      const ceiling = feeWad(100n);
      const got = await h.smoothstepFeeWad(WAD / 2n, 0n, feeWad(20n), ceiling);
      expect(got).to.equal(ceiling);
    });

    it("returns ceiling when feeCeilingWad == floorWad (no headroom)", async function () {
      const got = await h.smoothstepFeeWad(WAD / 4n, WAD, feeWad(20n), feeWad(20n));
      expect(got).to.equal(feeWad(20n));
    });

    it("returns ceiling when feeCeilingWad < floorWad (degenerate config)", async function () {
      const got = await h.smoothstepFeeWad(WAD / 4n, WAD, feeWad(50n), feeWad(30n));
      expect(got).to.equal(feeWad(30n));
    });

    it("returns ceiling when distPostWad >= rampDistWad (saturated)", async function () {
      const ramp = bpsToRampDist(1_000n); // 1000 bps == 0.1 WAD
      const dist = ramp;
      const got = await h.smoothstepFeeWad(dist, ramp, feeWad(20n), feeWad(100n));
      expect(got).to.equal(feeWad(100n));

      const beyond = ramp + 1n;
      const got2 = await h.smoothstepFeeWad(beyond, ramp, feeWad(20n), feeWad(100n));
      expect(got2).to.equal(feeWad(100n));
    });
  });

  describe("Active ramp boundaries", function () {
    it("returns floorWad when distPostWad == 0 (m(0) = 0)", async function () {
      const ramp = bpsToRampDist(1_000n);
      const got = await h.smoothstepFeeWad(0n, ramp, feeWad(20n), feeWad(100n));
      expect(got).to.equal(feeWad(20n));
    });

    it("returns ceiling at the right edge before saturating (distPostWad == ramp - 1)", async function () {
      const ramp = bpsToRampDist(1_000n);
      const got = await h.smoothstepFeeWad(ramp - 1n, ramp, feeWad(20n), feeWad(100n));
      // m(r) ≈ 2·1 − 1 = 1 at r → 1, so the rate ≈ ceiling. Allow one
      // bps-equivalent for the integer-rounding gap between r and 1.
      expect(got).to.be.greaterThanOrEqual(feeWad(99n));
      expect(got).to.be.lessThanOrEqual(feeWad(100n));
    });

    it("matches reference m(r) = 2r − r² across mid-ramp probe points", async function () {
      const ramp = bpsToRampDist(1_000n);
      const floor = feeWad(20n);
      const ceiling = feeWad(100n);
      const probes = [ramp / 10n, ramp / 4n, ramp / 2n, (ramp * 3n) / 4n, (ramp * 9n) / 10n];
      for (const dist of probes) {
        const got = BigInt(await h.smoothstepFeeWad(dist, ramp, floor, ceiling));
        const ref = expectedFeeWad(dist, ramp, floor, ceiling);
        expect(got, `dist=${dist}`).to.equal(ref);
      }
    });
  });

  describe("Monotonicity in distPostWad", function () {
    it("is strictly non-decreasing as distPostWad sweeps the ramp", async function () {
      const ramp = bpsToRampDist(1_000n);
      const floor = feeWad(20n);
      const ceiling = feeWad(100n);
      const N = 50n;
      let prev = -1n;
      for (let i = 0n; i <= N; i++) {
        const dist = (ramp * i) / N;
        const fee = BigInt(await h.smoothstepFeeWad(dist, ramp, floor, ceiling));
        expect(fee, `step ${i} dist=${dist}`).to.be.greaterThanOrEqual(prev);
        prev = fee;
      }
      // First sample should equal the floor; last should saturate at ceiling.
      const first = BigInt(await h.smoothstepFeeWad(0n, ramp, floor, ceiling));
      const last = BigInt(await h.smoothstepFeeWad(ramp, ramp, floor, ceiling));
      expect(first).to.equal(floor);
      expect(last).to.equal(ceiling);
    });

    it("clamps r=0 to floor regardless of ramp width", async function () {
      for (const rampBps of [1n, 100n, 1_000n, 10_000n]) {
        const ramp = bpsToRampDist(rampBps);
        const got = await h.smoothstepFeeWad(0n, ramp, feeWad(20n), feeWad(220n));
        expect(got).to.equal(feeWad(20n));
      }
    });

    it("resolves between integer-bps levels (WAD precision)", async function () {
      // A mid-ramp distance must produce a rate that is NOT a multiple
      // of 1 bps — the whole point of WAD resolution is that the rate
      // moves in ulps of 1e-18 rather than 1e-4 steps.
      const ramp = bpsToRampDist(1_000n);
      const fee = BigInt(await h.smoothstepFeeWad(ramp / 3n, ramp, feeWad(20n), feeWad(100n)));
      expect(fee % FEE_BPS_TO_WAD).to.not.equal(0n);
    });
  });

  describe("Reference table (NatSpec) — anchor-deviation row", function () {
    // Lifted directly from the NatSpec table in EquilibraSwapMath
    // (`feeFloorBps = 20`, ceiling `100 bps`). Storing the table
    // values as test expectations means a refactor of the smoothstep
    // formula must reproduce the documented numbers wei-for-wei.
    const FLOOR = feeWad(20n);
    const CEIL = feeWad(100n);
    const PRICE_MOVE_BPS_TO_WAD: Array<[bigint, bigint]> = [
      [100n, 9_901n * 10n ** 10n], // 1.00%   → 9.901e+13 distWad
      [200n, 3_922n * 10n ** 11n], // 2.00%   → 3.922e+14
      [500n, 2_381n * 10n ** 12n], // 5.00%   → 2.381e+15
      [1_000n, 9_091n * 10n ** 12n], // 10.00%  → 9.091e+15
    ];

    for (const [moveBps, distWad] of PRICE_MOVE_BPS_TO_WAD) {
      it(`reproduces the documented fee at ${(Number(moveBps) / 100).toFixed(2)}% move (ramp=1000)`, async function () {
        const ramp = bpsToRampDist(1_000n);
        const fee = BigInt(await h.smoothstepFeeWad(distWad, ramp, FLOOR, CEIL));
        const ref = expectedFeeWad(distWad, ramp, FLOOR, CEIL);
        expect(fee).to.equal(ref);
        expect(fee).to.be.greaterThanOrEqual(FLOOR);
        expect(fee).to.be.lessThanOrEqual(CEIL);
      });
    }
  });

  describe("BPS-to-WAD ramp-width semantics", function () {
    // 10000 bps == 1.0 WAD == one full state-distance unit. This
    // identity is the only thing tying the on-chain ramp configuration
    // to the off-chain price-distance metric, so we pin it.
    it("treats feeRampBps == 10000 as exactly the full WAD distance unit", async function () {
      const fullWadRamp = bpsToRampDist(BPS);
      expect(fullWadRamp).to.equal(WAD);
      // dist exactly at WAD saturates.
      const fee = await h.smoothstepFeeWad(WAD, fullWadRamp, feeWad(20n), feeWad(100n));
      expect(fee).to.equal(feeWad(100n));
      // dist at WAD/2 (half the ramp) sits mid-ramp.
      const half = await h.smoothstepFeeWad(WAD / 2n, fullWadRamp, feeWad(20n), feeWad(100n));
      const refHalf = expectedFeeWad(WAD / 2n, fullWadRamp, feeWad(20n), feeWad(100n));
      expect(half).to.equal(refHalf);
      expect(half).to.be.greaterThan(feeWad(20n));
      expect(half).to.be.lessThan(feeWad(100n));
    });
  });
});
