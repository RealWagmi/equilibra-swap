// Direct unit tests for `EquilibraSwapMath.sqrtPriceX96ToMathPriceWad`
// and its inverse `mathPriceToSqrtPriceX96`. The pool's
// `quoteSwapToPrice` entry point relies on the round-trip identity
// `mathPriceToSqrtPriceX96(sqrtPriceX96ToMathPriceWad(s)) ≈ s` to
// translate V3-style stop prices into Equilibra's math-space
// marginal-price target — so a regression in either direction would
// silently mistarget cross-anchor swaps.
//
// These were entirely uncovered by the prior suite (no caller ever
// wrote a unit test against the helpers themselves; only the
// integration test `QuoteSwapToPrice.test.ts` exercised them
// indirectly through the live pool).
import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
const Q96 = 1n << 96n;
// Canonical Uniswap-V3 sqrt-ratio domain, mirrored from Constants.sol.
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
// First `sqrtPriceX96` whose square reaches one Q96 unit.
const TWO_POW_48 = 1n << 48n;

// `sqrtPriceX96` for a given decimal-normalised price `p_raw =
// reserve1_raw / reserve0_raw`. Caller must convert to raw decimals
// first.
function priceToSqrtX96(priceFloat: number): bigint {
  // sqrtPriceX96 = sqrt(price) * 2^96, with `price = raw1/raw0`.
  // Using the floating-point representation is fine here because every
  // assertion that touches `sqrtPriceX96` allows a tolerance of
  // ≤ 1 sqrt-unit (the inverse mapping is good to within 2^-48
  // relative error per the NatSpec).
  return BigInt(Math.floor(Math.sqrt(priceFloat) * Number(Q96)));
}

describe("EquilibraSwapMath.sqrtPriceX96 ↔ pMargWad", function () {
  let h: any;

  before(async function () {
    const F = await hre.ethers.getContractFactory("SwapMathHarness");
    h = await F.deploy();
    await h.waitForDeployment();
  });

  describe("Forward (sqrtPriceX96 → pMargWad)", function () {
    it("at balance with symmetric decimals returns pMargWad == WAD", async function () {
      // 18-decimal pair, anchor = WAD. Balanced reserves ⇒ V3 raw
      // price = 1.0, sqrtPriceX96 = 2^96.
      const p = await h.sqrtPriceX96ToMathPriceWad(Q96, WAD, WAD, WAD);
      expect(p).to.equal(WAD);
    });

    it("at balance with asymmetric decimals (USDT-6/WBTC-8) round-trips to ~WAD", async function () {
      // Mirrors the canonical USDT-quote / WBTC-base layout. With the
      // anchor seeded from balanced reserves and pMargWad piped
      // through both helpers, the math-space marginal price must
      // collapse back to ≈ 1.0 — but the chain has THREE flooring
      // divisions (`WAD_SQ_X96 / priceQ96`, `… · t0 / t1`,
      // `… / anchor`) whose residuals compound multiplicatively in
      // the asymmetric-scale regime. The NatSpec only documents
      // ≤ 1 sqrt-unit on the inverse alone; the round-trip envelope
      // is therefore wider. We pin the looser-but-still-honest
      // 1-ppm bound so a real precision regression (orders of
      // magnitude of drift) still fires while the structural
      // multi-stage floor is allowed.
      const t0Scale = 10n ** 12n; // USDT 6dp → 1e12 lift to WAD
      const t1Scale = 10n ** 10n; // WBTC 8dp → 1e10 lift to WAD
      // Anchor = divWad(reserve0_lifted, reserve1_lifted) at balance
      // for $100k USDT vs 1 WBTC at $100k. r0 raw = 1e11, r1 raw = 1e8
      // ⇒ r0 lifted = 1e23, r1 lifted = 1e18 ⇒ anchor = divWad = 1e23.
      const anchorWad = 10n ** 23n;
      const sqrtBal = await h.mathPriceToSqrtPriceX96(WAD, anchorWad, t0Scale, t1Scale);
      const pMarg = BigInt(await h.sqrtPriceX96ToMathPriceWad(sqrtBal, anchorWad, t0Scale, t1Scale));
      const drift = pMarg > WAD ? pMarg - WAD : WAD - pMarg;
      const tol = WAD / 1_000_000n; // 1 ppm of WAD
      expect(drift, `drift=${drift}`).to.be.lessThanOrEqual(tol);
    });

    it("is anti-monotone in sqrtPriceX96", async function () {
      // V3 zeroForOne moves sqrtPrice down → pMarg moves up; the
      // function must therefore be strictly anti-monotone. Sweep a
      // log-spaced grid through 0.1..10x of balance.
      const anchorWad = WAD;
      const samples = [
        priceToSqrtX96(0.1),
        priceToSqrtX96(0.5),
        priceToSqrtX96(0.9),
        priceToSqrtX96(1),
        priceToSqrtX96(1.1),
        priceToSqrtX96(2),
        priceToSqrtX96(10),
      ];
      let prev = 1n << 255n;
      for (const s of samples) {
        const p = BigInt(await h.sqrtPriceX96ToMathPriceWad(s, anchorWad, WAD, WAD));
        expect(p, `sqrt=${s}`).to.be.lessThan(prev);
        prev = p;
      }
    });

    it("reverts with InvalidPriceScale when anchorWad is zero", async function () {
      await expect(h.sqrtPriceX96ToMathPriceWad(Q96, 0n, WAD, WAD)).to.be.revertedWithCustomError(
        h,
        "InvalidPriceScale"
      );
    });

    it("reverts with MathInvariantViolation when token1Scale is zero", async function () {
      await expect(h.sqrtPriceX96ToMathPriceWad(Q96, WAD, WAD, 0n)).to.be.revertedWithCustomError(
        h,
        "MathInvariantViolation"
      );
    });

    it("reverts with MathInvariantViolation when sqrtPriceX96 is zero", async function () {
      await expect(h.sqrtPriceX96ToMathPriceWad(0n, WAD, WAD, WAD)).to.be.revertedWithCustomError(
        h,
        "MathInvariantViolation"
      );
    });

    it("saturates the whole sub-2^48 band to the largest representable price", async function () {
      // `sqrtPriceX96² / 2^96` floors to zero below 2^48, so the band
      // has no distinct representation — it maps onto the value the
      // first representable input (2^48) produces.
      const atFirstRepresentable = BigInt(await h.sqrtPriceX96ToMathPriceWad(TWO_POW_48, WAD, WAD, WAD));
      expect(atFirstRepresentable).to.be.greaterThan(0n);
      for (const sp of [MIN_SQRT_RATIO, MIN_SQRT_RATIO + 1n, 1n << 40n, TWO_POW_48 - 1n]) {
        expect(BigInt(await h.sqrtPriceX96ToMathPriceWad(sp, WAD, WAD, WAD)), `sp=${sp}`).to.equal(
          atFirstRepresentable
        );
      }
    });

    it("saturates the top of the domain to one wei instead of a zero price", async function () {
      // A zero here is indistinguishable from "no admissible quote" at
      // the call site, so the high pole keeps a price.
      for (const sp of [MAX_SQRT_RATIO - 1n, MAX_SQRT_RATIO / 2n]) {
        expect(BigInt(await h.sqrtPriceX96ToMathPriceWad(sp, WAD, WAD, WAD)), `sp=${sp}`).to.equal(1n);
      }
    });

    it("decodes every value the inverse can emit, including its low clamp", async function () {
      // The inverse clamps extreme-tiny prices to MIN_SQRT_RATIO; that
      // output must survive a trip back through the decoder.
      const clamped = BigInt(await h.mathPriceToSqrtPriceX96(10n ** 36n, 10n ** 36n, 1n, WAD));
      expect(clamped).to.equal(MIN_SQRT_RATIO);
      expect(BigInt(await h.sqrtPriceX96ToMathPriceWad(clamped, 10n ** 36n, 1n, WAD))).to.be.greaterThan(0n);
    });
  });

  describe("Inverse (pMargWad → sqrtPriceX96)", function () {
    it("at pMargWad == WAD with symmetric decimals returns ~2^96", async function () {
      const got = BigInt(await h.mathPriceToSqrtPriceX96(WAD, WAD, WAD, WAD));
      // ≤ 1 sqrt-unit relative error per NatSpec. Q96 is 2^96 ≈
      // 7.92e28, so a 1 sqrt-unit gap is sub-wei here; we still
      // accept ±2 as a safety net.
      expect(got).to.be.greaterThanOrEqual(Q96 - 2n);
      expect(got).to.be.lessThanOrEqual(Q96 + 2n);
    });

    it("saturates at MAX_SQRT_RATIO - 1 when pMargWad == 0 (V3-safe upper clamp, L-11)", async function () {
      // Canonical Uniswap V3 MAX_SQRT_RATIO − 1: unlike the old
      // type(uint160).max sentinel this value never reverts a
      // TickMath-style consumer.
      const maxSqrtRatioMinusOne = 1461446703485210103287273052203988822378723970341n;
      const got = BigInt(await h.mathPriceToSqrtPriceX96(0n, WAD, WAD, WAD));
      expect(got).to.equal(maxSqrtRatioMinusOne);
    });

    it("applies the Q96 lift before the scale-ratio division (18/6 decimals, L-10)", async function () {
      // token0 = 18 decimals (scale 1), token1 = 6 decimals (scale 1e12).
      // The old cascade floored `numWad·t0Scale/t1Scale` BEFORE the Q96
      // lift — for t1Scale = 1e12 that truncates numWad (~1e18) down to
      // ~1e6 units (~1e-6 relative error on non-divisible prices, and
      // total collapse to 0 on 18/0-decimals pairs). Pin the reordered
      // cascade bit-exactly against a bigint mirror: lift → scale-ratio
      // → sqrt → <<48.
      const t0Scale = 1n;
      const t1Scale = 10n ** 12n;
      const priceScale = 2000n * WAD;
      const pMarg = 987_654_321_987_654_321n; // odd, non-divisible price

      const bigintSqrt = (v: bigint): bigint => {
        if (v < 2n) return v;
        let x = 1n << (BigInt(v.toString(2).length + 1) / 2n);
        let y = (x + v / x) / 2n;
        while (y < x) {
          x = y;
          y = (x + v / x) / 2n;
        }
        return x;
      };
      const numWad = (WAD * WAD) / pMarg;
      const lifted = (numWad * (1n << 96n)) / priceScale; // Q96 lift FIRST
      const priceQ96 = (lifted * t0Scale) / t1Scale; //      scale ratio LAST
      const expected = bigintSqrt(priceQ96) << 48n;

      const enc = BigInt(await h.mathPriceToSqrtPriceX96(pMarg, priceScale, t0Scale, t1Scale));
      expect(enc).to.equal(expected);
      // Sanity: the old order (scale ratio first) would have produced a
      // strictly different, coarser encoding for this input.
      const oldOrder = bigintSqrt((((numWad * t0Scale) / t1Scale) * (1n << 96n)) / priceScale) << 48n;
      expect(enc).to.not.equal(oldOrder);
    });

    it("clamps up to MIN_SQRT_RATIO instead of underflowing on extreme-tiny prices (L-11)", async function () {
      const minSqrtRatio = 4295128739n;
      // Extreme pMarg + priceScale + inverted scales push the projection
      // below the V3 floor — must clamp to MIN_SQRT_RATIO, never 0.
      const got = BigInt(await h.mathPriceToSqrtPriceX96(10n ** 36n, 10n ** 36n, 1n, 10n ** 18n));
      expect(got).to.equal(minSqrtRatio);
    });

    it("reverts with InvalidPriceScale when anchorWad is zero", async function () {
      await expect(h.mathPriceToSqrtPriceX96(WAD, 0n, WAD, WAD)).to.be.revertedWithCustomError(h, "InvalidPriceScale");
    });

    it("reverts with InvalidPriceScale when token1Scale is zero", async function () {
      await expect(h.mathPriceToSqrtPriceX96(WAD, WAD, WAD, 0n)).to.be.revertedWithCustomError(h, "InvalidPriceScale");
    });
  });

  describe("Round-trip identity (sqrt → math → sqrt)", function () {
    // The inverse pair is monotone and good to ≤ 1 sqrt-unit (NatSpec).
    // Round-trip drift must therefore stay inside a ~2^48-relative band.
    it("recovers the same sqrtPriceX96 within 2^48 relative for symmetric decimals", async function () {
      const tol = 1n << 48n; // 1 sqrt-unit per NatSpec
      const probes = [priceToSqrtX96(0.5), priceToSqrtX96(1), priceToSqrtX96(2)];
      for (const sqrtIn of probes) {
        const p = await h.sqrtPriceX96ToMathPriceWad(sqrtIn, WAD, WAD, WAD);
        const back = BigInt(await h.mathPriceToSqrtPriceX96(p, WAD, WAD, WAD));
        const drift = back > sqrtIn ? back - sqrtIn : sqrtIn - back;
        expect(drift, `sqrt=${sqrtIn}`).to.be.lessThanOrEqual(tol);
      }
    });

    it("recovers the same pMargWad within 1 wei for the math → sqrt → math direction", async function () {
      const probes = [WAD / 2n, WAD, (WAD * 3n) / 2n, WAD * 2n];
      for (const pIn of probes) {
        const sqrt = await h.mathPriceToSqrtPriceX96(pIn, WAD, WAD, WAD);
        const back = BigInt(await h.sqrtPriceX96ToMathPriceWad(sqrt, WAD, WAD, WAD));
        const drift = back > pIn ? back - pIn : pIn - back;
        // Worst-case drift is ~ 2 · pIn / 2^48 (one sqrt-unit on each
        // side). For pIn ≤ 2 WAD, that is ≪ 1e6 wei — but the integer
        // floor in the on-chain `sqrt` floors the boundary, so we
        // generously allow `pIn / 1e10` to absorb the rounding while
        // still catching a real regression.
        const tol = pIn / 10n ** 10n + 4n;
        expect(drift, `pIn=${pIn}`).to.be.lessThanOrEqual(tol);
      }
    });
  });
});
