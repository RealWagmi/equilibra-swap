// ТЗ-V15 § 9.4 #2 — asymmetric-coordinate-change invariants.
//
// The pool lifts `(xWad, yWad)` into math-space via the
// asymmetric change (`priceScale = yWad / xWad` at the anchor):
//
//     xMath = xWad                              (base axis, identity)
//     yMath = yWad · WAD / priceScaleWad        (quote → base)
//
// Three structural identities follow:
//
//   1. **Base-axis identity.** `xMath == xWad` always, exactly.
//   2. **Quote-axis projection.** `yMath == divWad(yWad, priceScale)`,
//      i.e. floor((yWad · WAD) / priceScale).
//   3. **Anchor diagonal.** When `priceScale = yWad / xWad`, the lift
//      lands on the diagonal `yMath ≈ xMath`. This is the property the
//      cubic kernel relies on to apply its symmetric closed-form
//      around the anchor.
//
// The previous design used a *symmetric* lift (`xMath = xWad/√p`,
// `yMath = yWad·√p`) under which the product `xMath·yMath` was
// preserved. That convention has been replaced because the
// product-preservation collapsed the IL signal the auto-repeg gate
// needs: shifting `priceScale` left the product (and therefore L_eq
// at the kernel limit) almost invariant, so `vp_after ≈ vp_before`
// and Gate 2 never bit. The asymmetric coords mirror V1 and Curve V2
// (`xp[1] · price_scale`) and restore the real cost-of-IL signal.

import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
const Q96 = 1n << 96n;

function divWadFloor(a: bigint, b: bigint): bigint {
  return (a * WAD) / b;
}

function mulWadFloor(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

function mulDivUp(a: bigint, b: bigint, denom: bigint): bigint {
  const num = a * b;
  return num === 0n ? 0n : (num - 1n) / denom + 1n;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

async function deployHarness() {
  const F = await hre.ethers.getContractFactory("SwapMathHarness");
  const h: any = await F.deploy();
  await h.waitForDeployment();
  return h;
}

describe("AsymmetricCoordChange: lift identities (ТЗ §9.4 #2)", function () {
  let h: any;

  before(async function () {
    h = await deployHarness();
  });

  describe("Base-axis identity and quote-axis projection", function () {
    // Production-likely price-scale band:
    //   * 1e-3 W — stable pair pulled deep below parity.
    //   * 1 W    — balanced (priceScale == 1).
    //   * 10 W   — moderate skew.
    //   * 1e5 W  — heavy skew (WBTC/USDT ratio).
    //   * 1e6 W  — extreme skew (e.g. wrapped meme-coin pair).
    const PRICE_SCALES: bigint[] = [10n ** 15n, WAD, 10n * WAD, 10n ** 23n, 10n ** 24n];

    const RESERVE_PAIRS: Array<[bigint, bigint]> = [
      [7n * 10n ** 23n, 13n * 10n ** 23n],
      [WAD, WAD],
      [10n ** 22n, 10n ** 26n],
    ];

    for (const ps of PRICE_SCALES) {
      for (const [xWad, yWad] of RESERVE_PAIRS) {
        it(`priceScale=${ps}, xWad=${xWad}, yWad=${yWad}: x identity + y projection`, async function () {
          const [xMath, yMath] = await h.toMathSpace(xWad, yWad, ps);
          // Base axis is untouched.
          expect(BigInt(xMath), "xMath must equal xWad exactly").to.equal(xWad);
          // Quote axis is `divWad(yWad, priceScale)` exactly.
          expect(BigInt(yMath), "yMath must equal divWad(yWad, priceScale)").to.equal(divWadFloor(yWad, ps));
        });
      }
    }

    it("at-anchor diagonal: priceScale = yWad / xWad ⇒ yMath ≈ xMath", async function () {
      // Sweep a few reserve ratios; in each case set priceScale to the
      // implied anchor `yWad/xWad`. The lift must land on the diagonal
      // within a single floored `divWad` residual (≤ ppb of magnitude).
      const probes: Array<[bigint, bigint]> = [
        [WAD, WAD],
        [10n ** 24n, 3n * 10n ** 24n],
        [2n * 10n ** 23n, 7n * 10n ** 23n],
        [WAD * 1000n, WAD * 17n],
      ];
      for (const [xWad, yWad] of probes) {
        const ps = divWadFloor(yWad, xWad);
        const [xMath, yMath] = await h.toMathSpace(xWad, yWad, ps);
        const drift = absBig(BigInt(yMath) - BigInt(xMath));
        // Bound: one floored `divWad` introduces at most
        // ~`xWad / 1e12 + 1` wei of error against the ideal continuous
        // diagonal for any practical reserve size.
        const tolerance = xWad / 10n ** 12n + 1n;
        expect(drift, `anchor diagonal: xMath=${xMath} yMath=${yMath} drift=${drift} > ${tolerance}`).to.be.lte(
          tolerance
        );
      }
    });
  });

  describe("Lift / lower round-trip closure", function () {
    // `fromMathSpaceDown(toMathSpace(...))` is the canonical
    // pool-favourable round-trip; the residual is at most one floored
    // `divWad`/`mulWad` cycle, so `xWad` returns exactly and `yWad`
    // rounds DOWN by at most `1 + priceScale/WAD` wei.
    const SAMPLES: Array<{ xWad: bigint; yWad: bigint; ps: bigint }> = [
      { xWad: WAD, yWad: WAD, ps: WAD },
      { xWad: 10n ** 24n, yWad: 3n * 10n ** 24n, ps: 3n * WAD },
      { xWad: 10n ** 22n, yWad: 10n ** 26n, ps: 10n ** 22n },
      { xWad: 7n * 10n ** 23n, yWad: 13n * 10n ** 23n, ps: WAD * 2n },
    ];

    for (const { xWad, yWad, ps } of SAMPLES) {
      it(`round-trip: priceScale=${ps}, xWad=${xWad}, yWad=${yWad}`, async function () {
        const [xMath, yMath] = await h.toMathSpace(xWad, yWad, ps);
        const xMathB = BigInt(xMath);
        const yMathB = BigInt(yMath);

        // Off-chain mirror of `fromMathSpaceDown`.
        const xBack = xMathB;
        const yBack = mulWadFloor(yMathB, ps);

        expect(xBack, "x round-trips identity").to.equal(xWad);
        // y round-trips down by at most a ULP. The kernel relies on
        // the rounding being pool-favourable (downward-only).
        const drift = yWad - yBack;
        const tolerance = 1n + ps / WAD;
        expect(drift, `y drift ${drift} > tolerance ${tolerance}`).to.be.gte(0n);
        expect(drift, `y drift ${drift} > tolerance ${tolerance}`).to.be.lte(tolerance);
      });
    }

    it("ceil round-trip (mulDivUp) is at least input", async function () {
      // For exact-out paths the pool rounds the *input* up via
      // `mulDivUp(yMath, priceScale, WAD)`. The result must always be
      // >= the original `yWad`.
      const xWad = 10n ** 24n;
      const yWad = 3n * 10n ** 24n;
      const ps = (yWad * WAD) / xWad;
      const [, yMath] = await h.toMathSpace(xWad, yWad, ps);
      const yCeil = mulDivUp(BigInt(yMath), ps, WAD);
      expect(yCeil, "ceil round-trip must not undercount input").to.be.gte(yWad);
    });
  });

  describe("Marginal-price round-trip: pMargWad → sqrtPriceX96 → pMargWad", function () {
    // Independent of the math-space lift; kept here for full coverage.
    const TOLERANCE_PPM = 2n;

    const PROBES: Array<{ price: bigint; label: string; anchor: bigint }> = [
      { price: WAD, label: "at-anchor (WAD)", anchor: WAD },
      { price: (WAD * 105n) / 100n, label: "5% above anchor", anchor: WAD },
      { price: (WAD * 95n) / 100n, label: "5% below anchor", anchor: WAD },
      { price: WAD * 2n, label: "2x above anchor", anchor: WAD },
      { price: WAD / 2n, label: "2x below anchor", anchor: WAD },
    ];

    for (const probe of PROBES) {
      it(`round-trip closes within ${TOLERANCE_PPM} ppm — ${probe.label}`, async function () {
        const sqrtX96: bigint = BigInt(await h.mathPriceToSqrtPriceX96(probe.price, probe.anchor, WAD, WAD));
        const back: bigint = BigInt(await h.sqrtPriceX96ToMathPriceWad(sqrtX96, probe.anchor, WAD, WAD));
        const drift = absBig(back - probe.price);
        const driftPpm = (drift * 1_000_000n) / probe.price;
        expect(driftPpm, `${probe.label}: drift=${drift} (${driftPpm} ppm) exceeds ${TOLERANCE_PPM} ppm`).to.be.lte(
          TOLERANCE_PPM
        );
      });
    }

    it("the at-anchor projection lands at exactly Q96 (± 2 sqrt-units)", async function () {
      const sqrtX96: bigint = BigInt(await h.mathPriceToSqrtPriceX96(WAD, WAD, WAD, WAD));
      const drift = absBig(sqrtX96 - Q96);
      expect(drift).to.be.lte(2n);
    });
  });
});
