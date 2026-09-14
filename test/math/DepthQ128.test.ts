import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  deployNativeQuantumFixture,
  deployLpRepairFixture,
  LP_REPAIR_CASES,
  exactOutSettlement,
} from "../fixtures/nativeQuantum";

const W = 10n ** 18n;
const Q = 1n << 128n;
function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const next = (x + n / x) / 2n;
    if (next >= x) return x;
    x = next;
  }
}
// Exact polynomial of Equilibra's depth, not a copy of the normalized implementation.
function depthInterval(x: bigint, y: bigint, a: bigint, lambda: bigint): [bigint, bigint] {
  const p = x * y;
  const h = W * p + lambda * (x - y) ** 2n;
  const b = a * p * (x + y);
  const disc = b * b + 16n * h * (h - a * p) * p;
  const root = sqrt(disc * Q * Q);
  const denominator = 4n * h * W;
  return [(b * Q + root) / denominator, (b * Q + root + denominator) / denominator];
}

describe("Q128 depth and native LP guard", function () {
  it("matches the independent positive root over both orientations and every parameter corner", async () => {
    const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
    let checked = 0;
    for (const a of [W / 10n, 990000000000000000n, W - 1n]) {
      for (const lambda of [W / 1000000n, W / 1000n, W]) {
        for (const r of [W, 500000n * W, 10n ** 30n]) {
          for (const ratio of [1n, 2n, 10n, 1000n]) {
            for (const [x, y] of [
              [r, r / ratio],
              [r / ratio, r],
            ]) {
              const actual = BigInt(await math.solveLFromState(x, y, a, lambda));
              const [low, high] = depthInterval(x, y, a, lambda);
              expect(actual).to.be.at.most(high);
              // Each normalized floor costs O(R/W) Q128 units; this grid
              // stays far from the extreme-ratio WAD-weight fallback.
              expect(low - actual).to.be.at.most(16n * (r / W + 1n));
              if (x === y) expect(actual).to.equal((x * Q) / W);
              const reverse = await math.solveLFromState(y, x, a, lambda);
              expect(reverse).to.equal(actual);
              ++checked;
            }
          }
        }
      }
    }
    expect(checked).to.equal(216);
  });

  it("does not floor intermediate depth back to WAD", async () => {
    const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
    const l = BigInt(await math.solveLFromState(7n * W, 11n * W, W - 1n, W / 1000n));
    const throughWad = (((l * W) / Q) * Q) / W;
    expect(l).to.be.greaterThan(throughWad);
    const k = await math.computeQuoteK(7n * W, 11n * W, l, W - 1n, W / 1000n);
    expect(await math.computeK(7n * W, 11n * W, W - 1n, W / 1000n)).to.equal(k >> 18n);
  });

  it("rejects a genuine micro decrease in both quote and execution, without mutating state", async () => {
    for (const zeroForOne of [true, false]) {
      const f = await deployLpRepairFixture("lp-decrease", zeroForOne);
      const w = f.witness;
      const pre = depthInterval(w.reserveIn, w.reserveOut, w.aWad, w.lambdaWad);
      const post = depthInterval(w.reserveIn + w.amount, w.reserveOut - w.raw, w.aWad, w.lambdaWad);
      expect(post[1]).to.be.lessThan(pre[0]);
      const before = { reserves: Array.from(await f.pool.getReserves()), oracle: await f.pool.getOracleState() };
      await expect(f.pool.quoteExactIn(zeroForOne, w.amount)).to.be.revertedWithCustomError(f.pool, "LpValueDecreased");
      await expect(
        f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, w.amount, 0)
      ).to.be.revertedWithCustomError(f.pool, "LpValueDecreased");
      expect({ reserves: Array.from(await f.pool.getReserves()), oracle: await f.pool.getOracleState() }).to.deep.equal(
        before
      );
    }
  });

  for (const zeroForOne of [true, false]) {
    for (const kind of LP_REPAIR_CASES) {
      it("applies the common math margin and one strict LP check: " + kind + "/" + zeroForOne, async () => {
        const f = await deployLpRepairFixture(kind, zeroForOne);
        const w = f.witness;
        const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
        const [raw, iters] = await math[w.exactOut ? "quoteExactOutForward" : "quoteExactInForward"](
          w.reserveIn,
          w.reserveOut,
          w.exactOut ? w.amount : w.amount - 1n,
          w.aWad,
          w.lambdaWad
        );
        expect(raw).to.equal(w.raw);
        expect(iters).to.be.greaterThan(0n).and.at.most(40n);
        const pre = depthInterval(w.reserveIn, w.reserveOut, w.aWad, w.lambdaWad);
        const initial = w.exactOut ? exactOutSettlement(w.raw) : { input: w.amount, fee: 1n, cut: 0n };
        const rawIn = initial.input - initial.cut;
        const rawOut = w.exactOut ? w.amount : w.raw;
        const rawPost = depthInterval(w.reserveIn + rawIn, w.reserveOut - rawOut, w.aWad, w.lambdaWad);
        if (w.error === "LpValueDecreased")
          expect(rawPost[1], "rejected settlement really decreases continuous depth").to.be.lessThan(pre[0]);
        else expect(rawPost[0], "settlement preserves continuous depth").to.be.greaterThan(pre[1]);
        const capture = async () => ({
          reserves: Array.from(await f.pool.getReserves()),
          oracle: Array.from(await f.pool.getOracleState()),
          lp: Array.from(await f.pool.getLpValueState()),
          balances: await Promise.all(f.tokens.map((t) => t.balanceOf(f.pool.target))),
        });
        const before = await capture();
        const quote = () => f.pool[w.exactOut ? "quoteExactOut" : "quoteExactIn"](zeroForOne, w.amount);
        const swap = () =>
          f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, w.exactOut ? -w.amount : w.amount, 0);
        if (w.error) {
          if (w.error === "AmountTooSmallAfterNormalization") expect(w.raw).to.equal(0n);
          await expect(quote()).to.be.revertedWithCustomError(f.pool, w.error);
          await expect(swap()).to.be.revertedWithCustomError(f.pool, w.error);
          expect(await capture()).to.deep.equal(before);
        } else {
          const input = w.exactOut ? w.expected : w.amount;
          const output = w.exactOut ? w.amount : w.expected;
          const final = initial;
          const checkedQuote = await quote();
          expect(checkedQuote).to.equal(w.exactOut ? final.input : w.raw);
          const post = depthInterval(w.reserveIn + input - final.cut, w.reserveOut - output, w.aWad, w.lambdaWad);
          expect(post[0], "common margin preserves continuous LP depth").to.be.greaterThan(pre[1]);
          expect(checkedQuote).to.equal(w.expected);
          expect(await capture(), "quote must be read-only").to.deep.equal(before);
          await expect(swap())
            .to.emit(f.pool, "Swap")
            .withArgs(
              f.trader.target,
              f.owner.address,
              zeroForOne,
              input,
              output,
              final.fee,
              final.cut,
              W,
              final.fee - final.cut
            );
          const reserves = await f.pool.getReserves();
          expect(reserves[zeroForOne ? 0 : 1]).to.equal(w.reserveIn + input - final.cut);
          expect(reserves[zeroForOne ? 1 : 0]).to.equal(w.reserveOut - output);
          expect((await f.pool.getProtocolFees())[zeroForOne ? 0 : 1]).to.equal(final.cut);
        }
      });
    }
  }

  async function fixture() {
    return deployNativeQuantumFixture({
      decimals: [18, 18],
      seedRatio: [500000n, 500000n],
      protocol: 25,
      initialSwap: false,
    });
  }
  for (const zeroForOne of [true, false]) {
    for (const exactOut of [true, false]) {
      it(
        "keeps post-protocol depth nondecreasing and checked quote equal to swap: " + zeroForOne + "/" + exactOut,
        async () => {
          const f = await loadFixture(fixture);
          const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
          const cp = await f.pool.getCurveParams();
          const anchor = (await f.pool.getOracleState()).priceScaleWad;
          const depth = async () => {
            const [r0, r1] = await f.pool.getReserves();
            return BigInt(await math.solveLFromState(r1, (r0 * W) / anchor, cp.aWad, cp.lambdaWad));
          };
          const before = await depth();
          const requested = 1000n * W;
          const quote = exactOut
            ? await f.pool.quoteExactOut(zeroForOne, requested)
            : await f.pool.quoteExactIn(zeroForOne, requested);
          const input = exactOut ? quote : requested;
          const output = exactOut ? requested : quote;
          const tokenIn = f.tokens[zeroForOne ? 0 : 1];
          const tokenOut = f.tokens[zeroForOne ? 1 : 0];
          const trader = await f.trader.getAddress();
          await tokenIn.mint(trader, input);
          const bal = await tokenOut.balanceOf(f.owner.address);
          await f.trader.executeSwap(
            await f.pool.getAddress(),
            f.owner.address,
            zeroForOne,
            exactOut ? -requested : requested,
            0
          );
          expect((await tokenOut.balanceOf(f.owner.address)) - bal).to.equal(output);
          expect(await depth()).to.be.at.least(before);
        }
      );
    }
  }
});
