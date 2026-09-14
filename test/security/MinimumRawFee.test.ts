import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";
import { deployNativeQuantumFixture, exactOutSettlement } from "../fixtures/nativeQuantum";

const WAD = 10n ** 18n;

async function swapEvent(
  f: Awaited<ReturnType<typeof deployNativeQuantumFixture>>,
  zeroForOne: boolean,
  amount: bigint
) {
  const receipt = await (await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, amount, 0)).wait();
  const event = receipt!.logs
    .filter((log) => log.address.toLowerCase() === f.pool.target.toString().toLowerCase())
    .map((log) => f.pool.interface.parseLog(log))
    .find((log) => log?.name === "Swap");
  expect(event, "Swap event").not.to.equal(undefined);
  return event!.args;
}

describe("Minimum raw swap fee", function () {
  for (const decimals of [0, 1, 2, 6, 8, 18]) {
    it(`changes only zero floor-fees, not positive floors: ${decimals} decimals`, async function () {
      const f = await deployNativeQuantumFixture({
        decimals: [decimals, decimals],
        seedRatio: [500000n, 500000n],
        initialSwap: false,
        protocol: 25,
      });
      for (const zeroForOne of [true, false]) {
        const input = zeroForOne ? 0 : 1;
        await f.tokens[input].mint(f.trader.target, 200000n);
        for (const [amount, expectedFee] of [
          [1000n, 1n],
          [1999n, 1n],
          [2000n, 1n],
          [3000n, 1n],
          [3999n, 1n],
          [4000n, 2n],
          [100000n, 50n],
        ]) {
          const quote = await f.pool.quoteExactIn(zeroForOne, amount);
          const event = await swapEvent(f, zeroForOne, amount);
          expect(event.amountOut).to.equal(quote);
          expect(event.amountIn).to.equal(amount);
          expect(event.feeAmount).to.equal(expectedFee);
          expect(event.protocolFeeAmount).to.equal((expectedFee * 25n) / 100n);
          expect(event.lpFeeAccrued).to.equal(expectedFee - event.protocolFeeAmount);
        }
        const before = Array.from(await f.pool.getReserves());
        await expect(f.pool.quoteExactIn(zeroForOne, 1n)).to.be.revertedWithCustomError(
          f.pool,
          "AmountTooSmallAfterNormalization"
        );
        await expect(
          f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, 1n, 0)
        ).to.be.revertedWithCustomError(f.pool, "AmountTooSmallAfterNormalization");
        expect(Array.from(await f.pool.getReserves())).to.deep.equal(before);
      }
    });
  }

  for (const ramp of [0, 10000]) {
    for (const decimals of [0, 1, 2, 18]) {
      for (const zeroForOne of [true, false]) {
        it(`keeps the exact-out +1 separate from the minimum fee: ${ramp}/${decimals}/${zeroForOne}`, async function () {
          const f = await deployNativeQuantumFixture({
            decimals: [decimals, decimals],
            seedRatio: [500000n, 500000n],
            initialSwap: false,
            poolConfig: { aWad: 990000000000000000n, feeRampBps: ramp, feeFloorBps: 1 },
          });
          const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
          const scale = WAD / f.units[0];
          const wanted = 999n;
          const [cleanWad] = await math.quoteExactOutForward(
            500000n * WAD,
            500000n * WAD,
            wanted * scale,
            990000000000000000n,
            10n ** 15n
          );
          const clean = (cleanWad + scale - 1n) / scale;
          // The whole positive 1..5-bps rate interval rounds to zero here.
          expect(clean).to.be.gt(0n);
          expect(clean).to.be.lt(2000n);
          const expected = exactOutSettlement(clean, 5, 0);
          expect(expected.input).to.equal(clean + 2n);
          expect(await f.pool.quoteExactOut(zeroForOne, wanted)).to.equal(expected.input);
          const input = zeroForOne ? 0 : 1;
          await f.tokens[input].mint(f.trader.target, expected.input);
          const event = await swapEvent(f, zeroForOne, -wanted);
          expect(event.amountIn).to.equal(expected.input);
          expect(event.amountOut).to.equal(wanted);
          expect(event.feeAmount).to.equal(2n);
        });
      }
    }
  }

  it("rejects a zero resolved rate for a live dynamic ramp", async function () {
    await expect(
      deployNativeQuantumFixture({
        seedRatio: [500000n, 500000n],
        initialSwap: false,
        poolConfig: { feeRampBps: 10000, feeFloorBps: 0 },
      })
    ).to.be.revertedWithCustomError(await hre.ethers.getContractFactory("EquilibraFactory"), "InvalidFeeFloor");
  });

  for (const output of [0, 1]) {
    it("includes the minimum fee in post-burn zap previews: token" + output, async function () {
      const f = await deployNativeQuantumFixture({
        decimals: [0, 0],
        seedRatio: [500000n, 500000n],
        initialSwap: false,
        protocol: 25,
      });
      const weth = await (await hre.ethers.getContractFactory("MockWETH9")).deploy();
      const router = await (
        await hre.ethers.getContractFactory("EquilibraRouter")
      ).deploy(f.factory.target, f.impl.target, weth.target);
      await router.waitForDeployment();
      await f.pool.approve(router.target, MaxUint256);
      const liquidity = (await f.pool.totalSupply()) / 1000n;
      const tokenOut = f.tokens[output];
      const quote = await router.previewZapOut(f.tokens[0].target, f.tokens[1].target, 0, liquidity, tokenOut.target);
      const before = await tokenOut.balanceOf(f.owner.address);
      const receipt = await (
        await router.zapOutSingleSided({
          tokenA: f.tokens[0].target,
          tokenB: f.tokens[1].target,
          poolIndex: 0,
          tokenOut: tokenOut.target,
          recipient: f.owner.address,
          liquidity,
          minAmountOut: quote,
          deadline: MaxUint256,
        })
      ).wait();
      expect((await tokenOut.balanceOf(f.owner.address)) - before).to.equal(quote);
      const event = receipt!.logs
        .filter((log) => log.address.toLowerCase() === f.pool.target.toString().toLowerCase())
        .map((log) => f.pool.interface.parseLog(log))
        .find((log) => log?.name === "Swap");
      expect(event, "zap's internal swap").not.to.equal(undefined);
      expect(event!.args.feeAmount).to.equal(1n);
      expect(event!.args.protocolFeeAmount).to.equal(0n);
    });
  }
});
