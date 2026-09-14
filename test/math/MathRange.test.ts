import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, takeSnapshot, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";
import { outputAfterMargin } from "../helpers/continuousReference";

const W = 10n ** 18n;
const Q = 1n << 128n;
const MAX = (1n << 256n) - 1n;
const A = (99n * W) / 100n;
const LAMBDA = W / 1000n;
const R = 500000n * W;

function marginalPriceReferenceAtAnchor(xMath: bigint, yMath: bigint, lQ128: bigint) {
  const nWad = (xMath * yMath) / W;
  const diffSqWad = (xMath - yMath) ** 2n / W;
  const distanceWad = (diffSqWad * W) / nWad;
  const denominatorWad = W + (LAMBDA * distanceWad) / W;
  const ampWad = (A * W) / denominatorWad;
  const prefactor = (ampWad * LAMBDA) / denominatorWad;

  const absDiff = yMath > xMath ? yMath - xMath : xMath - yMath;
  const absXdDdx = (((absDiff * (xMath + yMath)) / W) * W) / nWad;
  const absXdAdxWad = (prefactor * absXdDdx) / W;
  const lsWad = (lQ128 * (xMath + yMath)) / (2n * Q);
  const absTau = (absXdAdxWad * (lsWad - nWad >= 0n ? lsWad - nWad : nWad - lsWad)) / W;

  const alHalf = (ampWad * lQ128) / (2n * W);
  const tailWad = ((W - ampWad) * nWad) / W;
  const xKx = (alHalf * xMath) / Q + tailWad;
  const yKy = (alHalf * yMath) / Q + tailWad;
  const pMargWad = (((yMath * xKx) / xMath) * W) / yKy;
  return { prefactor, absTau, pMargWad };
}

function directedMulDiv(x: bigint, y: bigint, denominator: bigint, upper: boolean) {
  const product = x * y;
  return upper ? (product + denominator - 1n) / denominator : product / denominator;
}

function discreteQuoteKReference(x: bigint, y: bigint, depth: bigint) {
  const n = (x * y) / (W >> 18n);
  const h = (depth * (x + y)) / (1n << 111n);
  if (h === n) return { k: n, precision: Q };

  const positive = h > n;
  const upper = !positive;
  const difference = x > y ? x - y : y - x;
  const xy = x * y;
  const square = difference * difference;
  const precision = square >> 127n >= xy ? W : Q;
  const distance = directedMulDiv(square, precision, xy, !upper);
  const denominator = precision + directedMulDiv(LAMBDA, distance, W, !upper);
  const anchor = directedMulDiv(A, precision, W, upper);
  const theta = directedMulDiv(anchor, precision, denominator, upper);
  const correction = directedMulDiv(theta, positive ? h - n : n - h, precision, upper);
  return { k: positive ? n + correction : n - correction, precision };
}

function discreteCounterpartBracket(xPost: bigint, yPre: bigint, depth: bigint, target: bigint) {
  let low = 1n;
  let high = yPre;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (discreteQuoteKReference(xPost, mid, depth).k >= target) high = mid;
    else low = mid;
  }
  return { low, high };
}

async function mathFixture() {
  return (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
}

async function poolFixture() {
  return deployNativeQuantumFixture({
    initialSwap: false,
    seedRatio: [500000n, 500000n],
    poolConfig: { aWad: A, lambdaWad: LAMBDA, baseFee: 5 },
  });
}

describe("Pool signed amount conversion", function () {
  it("accepts zero through int256.max and preserves the typed refusal above it", async () => {
    const h = await (await hre.ethers.getContractFactory("MockEquilibraPool")).deploy();
    for (const amount of [0n, 1n, Q - 1n, (1n << 255n) - 1n]) {
      expect(await h.exposed_toSignedPositive(amount)).to.equal(amount);
    }
    for (const amount of [1n << 255n, (1n << 255n) + 1n, MAX]) {
      await expect(h.exposed_toSignedPositive(amount)).to.be.revertedWithCustomError(h, "InvalidAmountSpecified");
    }
  });
});

describe("Invariant-weight uint256 range", function () {
  for (const reverse of [false, true]) {
    for (const kind of ["product", "square"] as const) {
      it(`rejects ${kind} overflow with MathOutOfRange, reverse=${reverse}`, async () => {
        const math = await loadFixture(mathFixture);
        const small = kind === "product" ? Q : 1n;
        const large = Q + 1n;
        const [x, y] = reverse ? [large, small] : [small, large];
        expect(x * y > MAX).to.equal(kind === "product");
        expect((x - y) ** 2n > MAX).to.equal(kind === "square");
        for (const a of [W / 10n, A, W - 1n]) {
          for (const lambda of [10n ** 12n, LAMBDA, W]) {
            await expect(math.solveLFromState(x, y, a, lambda)).to.be.revertedWithCustomError(math, "MathOutOfRange");
            await expect(math.computeQuoteK(x, y, Q, a, lambda)).to.be.revertedWithCustomError(math, "MathOutOfRange");
          }
        }
      });

      it(`accepts the ${kind} boundary without narrowing the domain, reverse=${reverse}`, async () => {
        const small = kind === "product" ? Q - 1n : 1n;
        const large = kind === "product" ? Q + 1n : Q;
        const [x, y] = reverse ? [large, small] : [small, large];
        if (kind === "product") expect(x * y).to.equal(MAX);
        else expect(large - small).to.equal(Q - 1n);
        const math = await loadFixture(mathFixture);
        for (const a of [W / 10n, A, W - 1n]) {
          for (const lambda of [10n ** 12n, LAMBDA, W]) {
            const depth = await math.solveLFromState(x, y, a, lambda);
            expect(depth).to.be.gt(0n);
            expect(await math.computeQuoteK(x, y, depth, a, lambda)).to.be.gt(0n);
          }
        }
      });
    }
  }

  it("preserves zero-coordinate and valid diagonal shortcuts but rejects an oversized diagonal", async () => {
    const math = await loadFixture(mathFixture);
    for (const [x, y] of [
      [0n, Q + 1n],
      [Q + 1n, 0n],
    ]) {
      expect(await math.solveLFromState(x, y, A, LAMBDA)).to.equal(0n);
      expect(await math.computeQuoteK(x, y, Q, A, LAMBDA)).to.equal(0n);
    }
    const diagonal = Q - 1n;
    const depth = await math.solveLFromState(diagonal, diagonal, A, LAMBDA);
    expect(depth).to.equal((diagonal * Q) / W);
    expect(await math.computeQuoteK(diagonal, diagonal, depth, A, LAMBDA)).to.be.gt(0n);
    for (const invalid of [Q, Q + 1n, 10n ** 40n]) {
      expect(invalid * invalid).to.be.gt(MAX);
      await expect(math.solveLFromState(invalid, invalid, A, LAMBDA)).to.be.revertedWithCustomError(
        math,
        "MathOutOfRange"
      );
    }
  });
});

describe("Curve seed at the opposite squared-distance boundary", function () {
  it("uses the upper neighbor when the lower second point would overflow", async () => {
    const h = await loadFixture(mathFixture);
    const scale = 10n ** 12n,
      cpTarget = 10n ** 24n,
      margin = 6n * 10n ** 20n,
      gross = 10n ** 12n;
    const clean = (gross - (gross * 5n) / 10000n) * scale;
    const fixed = ((Q + cpTarget - margin + scale - 1n) / scale) * scale;
    const x = fixed - clean,
      y = (cpTarget * fixed + x - 1n) / x;
    const cp = (x * y) / fixed;
    expect(cp).to.equal(cpTarget);
    expect(fixed - cp).to.be.lt(Q);
    expect(fixed - (cp - cp / 1000n)).to.be.at.least(Q);
    expect(Array.from(await h.quoteExactInForward(x, y, clean, A, LAMBDA))).to.deep.equal([2937187662n, 2n]);
  });
});

describe("Native quote and swap arithmetic refusals", function () {
  for (const zeroForOne of [true, false]) {
    it(`rejects an exact-out target that leaves no room for the output margin, direction=${zeroForOne}`, async () => {
      const f = await loadFixture(poolFixture);
      const before = {
        reserves: Array.from(await f.pool.getReserves()),
        oracle: Array.from(await f.pool.getOracleState()),
        lp: Array.from(await f.pool.getLpValueState()),
        balances: await Promise.all(f.tokens.map((t) => t.balanceOf(f.pool.target))),
      };
      const output = R - 1n;
      const seed = (R * R) / (R - output);
      expect((seed - 1n) ** 2n).to.be.gt(MAX);
      await expect(f.pool.quoteExactOut(zeroForOne, output)).to.be.revertedWithCustomError(
        f.pool,
        "InsufficientLiquidity"
      );
      await expect(
        f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, -output, 0)
      ).to.be.revertedWithCustomError(f.pool, "InsufficientLiquidity");
      expect({
        reserves: Array.from(await f.pool.getReserves()),
        oracle: Array.from(await f.pool.getOracleState()),
        lp: Array.from(await f.pool.getLpValueState()),
        balances: await Promise.all(f.tokens.map((t) => t.balanceOf(f.pool.target))),
      }).to.deep.equal(before);
    });

    it(`keeps both exact-out and exact-in executable at the old second-seed overflow, direction=${zeroForOne}`, async () => {
      // A numeric-limit regression, not a representative market trade.
      const f = await loadFixture(poolFixture);
      const math = await mathFixture();
      const input = ((Q - 1n) * 9998n) / 10000n;
      const output = await f.pool.quoteExactIn(zeroForOne, input);
      const historicalOutput = 499999999999999264801466n;
      expect(output).to.equal(historicalOutput - historicalOutput / 100000000n);
      const remaining = R - output;
      const seed = (R * R) / (R - historicalOutput);
      const second = (seed * 1001n) / 1000n;
      expect((seed - (R - historicalOutput)) ** 2n).to.be.at.most(MAX);
      expect((second - (R - historicalOutput)) ** 2n).to.be.gt(MAX);
      const beforeDepth = await math.solveLFromState(R, R, A, LAMBDA);
      expect(await math.computeQuoteK(R - historicalOutput, seed, beforeDepth, A, LAMBDA)).to.be.gt(0n);
      const snapshot = await takeSnapshot();
      const required = await f.pool.quoteExactOut(zeroForOne, output);
      const inToken = f.tokens[zeroForOne ? 0 : 1];
      const outToken = f.tokens[zeroForOne ? 1 : 0];
      await inToken.mint(f.trader.target, required);
      const paid = await inToken.balanceOf(f.trader.target);
      const received = await outToken.balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, -output, 0);
      expect(paid - (await inToken.balanceOf(f.trader.target))).to.equal(required);
      expect((await outToken.balanceOf(f.owner.address)) - received).to.equal(output);
      const exactOutReserves = await f.pool.getReserves();
      expect(exactOutReserves.every((r: bigint) => r > 0n && r < Q)).to.equal(true);
      expect(await math.solveLFromState(exactOutReserves[0], exactOutReserves[1], A, LAMBDA)).to.be.at.least(
        beforeDepth
      );
      await snapshot.restore();
      expect(Array.from(await f.pool.getReserves())).to.deep.equal([R, R]);
      const tokenIn = f.tokens[zeroForOne ? 0 : 1];
      const tokenOut = f.tokens[zeroForOne ? 1 : 0];
      await tokenIn.mint(f.trader.target, input);
      const balance = await tokenOut.balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, input, 0);
      expect((await tokenOut.balanceOf(f.owner.address)) - balance).to.equal(output);
      const after = Array.from(await f.pool.getReserves());
      expect(after).to.deep.equal(zeroForOne ? [R + input, remaining] : [remaining, R + input]);
      expect(after.every((r) => r > 0n && r < Q)).to.equal(true);
      expect(await math.solveLFromState(after[0], after[1], A, LAMBDA)).to.be.at.least(beforeDepth);
      const oracle = await f.pool.getOracleState();
      expect(oracle.priceScaleWad).to.equal(W);
      const [reserve0, reserve1] = after;
      const xMath = reserve1;
      const yMath = reserve0;
      const marginalDepth = await math.solveLFromState(xMath, yMath, A, LAMBDA);
      const marginalReference = marginalPriceReferenceAtAnchor(xMath, yMath, marginalDepth);
      expect(marginalReference.prefactor).to.equal(0n);
      expect(marginalReference.absTau).to.equal(0n);
      expect(oracle.pMargWad).to.equal(marginalReference.pMargWad);
      expect(oracle.sqrtPriceX96).to.equal(
        zeroForOne ? 4295128739n : 1461446703485210103287273052203988822378723970341n
      );
      const backwards = !zeroForOne;
      await tokenOut.mint(f.trader.target, W);
      await time.increase(60);
      const backQuote = await f.pool.quoteExactIn(backwards, W);
      const reverseDepth = await math.solveLFromState(remaining, R + input, A, LAMBDA);
      const reverseXPost = remaining + W - (W * 5n) / 10000n;
      const reverseTarget = discreteQuoteKReference(remaining, R + input, reverseDepth);
      expect(reverseTarget.precision).to.equal(Q);
      expect(await math.computeQuoteK(remaining, R + input, reverseDepth, A, LAMBDA)).to.equal(reverseTarget.k);

      // The continuous root need not be an integer root of the production's
      // directed Q128 quote-K. The solver may stop at the lower neighbor on
      // a quantized-K stagnation exit, so accept only the two adjacent
      // discrete counterparts that straddle this independent level-set root.
      const reverseBracket = discreteCounterpartBracket(reverseXPost, R + input, reverseDepth, reverseTarget.k);
      const lowerK = discreteQuoteKReference(reverseXPost, reverseBracket.low, reverseDepth);
      const upperK = discreteQuoteKReference(reverseXPost, reverseBracket.high, reverseDepth);
      expect(lowerK.precision).to.equal(Q);
      expect(upperK.precision).to.equal(Q);
      expect(lowerK.k).to.be.lt(reverseTarget.k);
      expect(upperK.k).to.be.at.least(reverseTarget.k);
      const lowerOutput = outputAfterMargin(R + input - reverseBracket.high);
      const upperOutput = outputAfterMargin(R + input - reverseBracket.low);
      expect(upperOutput - lowerOutput).to.be.at.most(1n);
      expect(backQuote).to.be.at.least(lowerOutput);
      expect(backQuote).to.be.at.most(upperOutput);
      const backBalance = await tokenIn.balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, backwards, W, 0);
      expect((await tokenIn.balanceOf(f.owner.address)) - backBalance).to.equal(backQuote);
    });
  }
});
