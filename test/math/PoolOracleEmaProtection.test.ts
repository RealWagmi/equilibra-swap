import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";
import { poolEmaLogWad } from "../helpers/storageLayout";
import numericDomain from "../../simulator/tests/fixtures/equilibra-numeric-domain.json";

const WAD = 10n ** 18n;
const LONG_ELAPSED = 60_000;

describe("PoolOracle: persistent log EMA", function () {
  let harness: any;
  before(async function () {
    harness = await (await hre.ethers.getContractFactory("PoolOracleHarness")).deploy();
    await harness.waitForDeployment();
  });

  it("bootstraps only from an empty timestamp, without a spot cap", async function () {
    const spot = 7n * WAD;
    const [log, stamp] = await harness.updateEma(0n, 0, spot, WAD, 600, LONG_ELAPSED);
    expect(log).to.equal(await harness.priceToEmaLog(spot));
    expect(stamp).to.equal(BigInt(LONG_ELAPSED));
  });

  it("treats log zero as price one, not as an uninitialized EMA", async function () {
    const [log] = await harness.updateEma(0n, 1000, 1000n * WAD, WAD, 600, 1001);
    expect(log).to.be.gt(0n);
    expect(log).to.be.lt(await harness.priceToEmaLog(2n * WAD));
  });

  it("clamps runaway spot symmetrically and preserves the capped target logarithm", async function () {
    for (const [spot, target, decoded] of [
      [1000n * WAD, 2n * WAD, 2n * WAD - 1n],
      [1n, WAD / 2n, WAD / 2n - 1n],
    ]) {
      const [log] = await harness.updateEma(0n, 1000, spot, WAD, 600, 1000 + LONG_ELAPSED);
      expect(log).to.equal(await harness.priceToEmaLog(target));
      expect(await harness.emaLogToPrice(log)).to.equal(decoded);
    }
  });

  it("constant spot is an exact fixed point of the stored logarithm", async function () {
    for (const price of [1n, 2n, WAD, 123456789012345678n, 3000n * WAD]) {
      const old = await harness.priceToEmaLog(price);
      for (const elapsed of [1, 60, LONG_ELAPSED]) {
        const [log] = await harness.updateEma(old, 1000, price, price, 600, 1000 + elapsed);
        expect(log).to.equal(old);
      }
    }
  });

  it("retains sub-price-unit movement across sixty one-second updates", async function () {
    let log = await harness.priceToEmaLog(1000n);
    for (let i = 1; i <= 60; i++) {
      const [next] = await harness.updateEma(log, 999 + i, 2000n, 1000n, 865, 1000 + i);
      expect(next).to.be.gt(log);
      log = next;
    }
    expect(await harness.emaLogToPrice(log)).to.equal(1047n);
  });

  it("decodes a positive minimum without a spot/EMA ratio precision cliff", async function () {
    const v = numericDomain.minimumEma;
    for (const tau of v.tauSeconds) {
      for (const old of [...v.oldEmaWad, (2n * WAD + 1n).toString()]) {
        const [log, stamp] = await harness.updateEma(
          await harness.priceToEmaLog(BigInt(old)),
          1000,
          BigInt(v.spotWad),
          BigInt(v.priceScaleWad),
          tau,
          1000 + tau * v.elapsedTauMultiples
        );
        expect(await harness.emaLogToPrice(log)).to.equal(BigInt(v.expected));
        expect(stamp).to.equal(BigInt(1000 + tau * v.elapsedTauMultiples));
      }
    }
    const initial = await harness.priceToEmaLog(1n);
    const [updated] = await harness.updateEma(initial, 1000, 10n ** 30n, 2n, 600, 1001);
    expect(await harness.emaLogToPrice(updated)).to.equal(1n);
    expect(updated).to.be.gt(initial);
  });

  it("preserves both state fields for zero spot or a non-increasing timestamp", async function () {
    const initial = await harness.priceToEmaLog(7n * WAD);
    for (const [spot, now] of [
      [0n, 10000],
      [9n * WAD, 5000],
      [9n * WAD, 4999],
    ] as const) {
      const [log, stamp] = await harness.updateEma(initial, 5000, spot, WAD, 600, now);
      expect(log).to.equal(initial);
      expect(stamp).to.equal(5000n);
    }
  });

  it("skips the spot cap when priceScale is zero", async function () {
    const [log] = await harness.updateEma(0n, 1000, 100n * WAD, 0n, 600, 1000 + LONG_ELAPSED);
    expect(log).to.equal(await harness.priceToEmaLog(100n * WAD));
    expect(await harness.emaLogToPrice(log)).to.equal(99999999999999999897n);
  });
});

async function tinyAnchorPoolFixture() {
  const f = await deployNativeQuantumFixture({
    initialSwap: false,
    isPrivate: true,
    protocol: 5,
    seedAmountsRaw: [10n, 5n * WAD],
    poolConfig: { aWad: WAD / 10n, lambdaWad: WAD, emaPeriod: 600 },
  });
  for (const token of f.tokens) await token.mint(f.trader.target, 100n * WAD);
  return f;
}

describe("PoolOracle minimum EMA: private pool liveness", function () {
  it("keeps oracle reads, both swap directions and withdrawal working after tiny-price rounding", async function () {
    const f = await loadFixture(tinyAnchorPoolFixture);
    const start = await time.latest();
    expect((await f.pool.getOracleState()).priceScaleWad).to.equal(2n);

    const steps = [
      { elapsed: 1, zeroForOne: true, input: 5n, output: 1443026644584300269n, ema: 1n },
      { elapsed: 10_001, zeroForOne: true, input: 2n, output: 225385115467835200n, ema: 3n },
      { elapsed: 10_002, zeroForOne: false, input: 3n * WAD, output: 8n, ema: 3n },
      { elapsed: 100_002, zeroForOne: true, input: 10n * WAD, output: 6331513176632732127n, ema: 1n },
      { elapsed: 100_003, zeroForOne: true, input: WAD / 1000n, output: 6327873n, ema: 1n },
    ];
    for (const step of steps) {
      await time.setNextBlockTimestamp(start + step.elapsed);
      expect(await f.pool.quoteExactIn(step.zeroForOne, step.input)).to.equal(step.output);
      const tokenOut = f.tokens[step.zeroForOne ? 1 : 0];
      const balanceBefore = await tokenOut.balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, step.zeroForOne, step.input, 0);
      expect((await tokenOut.balanceOf(f.owner.address)) - balanceBefore).to.equal(step.output);
      const oracle = await f.pool.getOracleState();
      expect(oracle.emaPriceWad).to.equal(step.ema);
      expect(oracle.priceScaleWad).to.equal(2n);
    }

    for (const zeroForOne of [true, false]) {
      const input = zeroForOne ? WAD / 1000n : WAD;
      const quote = await f.pool.quoteExactIn(zeroForOne, input);
      expect(quote).to.be.gt(0n);
      const tokenOut = f.tokens[zeroForOne ? 1 : 0];
      const balanceBefore = await tokenOut.balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, input, 0);
      expect((await tokenOut.balanceOf(f.owner.address)) - balanceBefore).to.equal(quote);
      expect((await f.pool.getOracleState()).emaPriceWad).to.be.gt(0n);
      await time.increase(1);
      expect(await f.pool.getLiveEmaPrice()).to.be.gt(0n);
    }

    const logBefore = await poolEmaLogWad(await f.pool.getAddress());
    const timestampsBefore = await f.pool.getOracleTimestamps();
    await time.increase(60);
    expect(await f.pool.getLiveEmaPrice()).to.be.gt(0n);
    expect(await poolEmaLogWad(await f.pool.getAddress())).to.equal(logBefore);
    expect(await f.pool.getOracleTimestamps()).to.deep.equal(timestampsBefore);

    const shares = (await f.pool.balanceOf(f.owner.address)) / 2n;
    const supply = await f.pool.totalSupply();
    const reserves = await f.pool.getReserves();
    const balances = await Promise.all(f.tokens.map((token) => token.balanceOf(f.owner.address)));
    await f.pool.removeLiquidity(shares, 0, 0, f.owner.address);
    for (let i = 0; i < 2; i++) {
      expect((await f.tokens[i].balanceOf(f.owner.address)) - balances[i]).to.equal((reserves[i] * shares) / supply);
    }
    expect(await f.pool.totalSupply()).to.equal(supply - shares);
  });
});

async function priceBoundsFixture() {
  return deployNativeQuantumFixture({ initialSwap: false, seedAmountsRaw: [10n ** 24n, 10n ** 24n] });
}

describe("Public genesis initial-price bounds", function () {
  const lower = 1_000_000n;
  const upper = 10n ** 30n;
  for (const price of [lower - 1n, lower, upper, upper + 1n]) {
    it("rejects public initial price " + price + " and allows its private counterpart", async function () {
      const f = await loadFixture(priceBoundsFixture);
      const amount1 = 10n ** 24n;
      const amount0 = price * (amount1 / WAD);
      await f.tokens[0].mint(f.owner.address, amount0);
      const config = {
        aWad: WAD / 10n,
        lambdaWad: 10n ** 15n,
        baseFee: 5,
        feeFloorBps: 0,
        feeRampBps: 0,
        emaPeriod: 600,
        repegShareBps: 0,
        repegStepWad: 10n ** 15n,
        repegThresholdToken1UpWad: 10n ** 14n,
        repegThresholdToken1DownWad: 10n ** 14n,
      };
      const args = [f.tokens[0].target, f.tokens[1].target, config, amount0, amount1, f.owner.address] as const;
      await expect(f.factory.createPoolAndAddLiquidity(...args)).to.be.revertedWithCustomError(
        f.impl,
        "InvalidPriceScale"
      );
      await f.factory.createPrivatePoolAndAddLiquidity(...args);
      const pool = await hre.ethers.getContractAt("EquilibraPool", await f.factory.allPools(1));
      expect(await pool.getPriceScale()).to.equal(price);
    });
  }
  for (const price of [lower + 1n, upper - 1n]) {
    it("accepts public initial price " + price + " immediately inside the interval", async function () {
      const f = await deployNativeQuantumFixture({
        initialSwap: false,
        seedAmountsRaw: [price * 10n ** 6n, 10n ** 24n],
      });
      expect(await f.pool.getPriceScale()).to.equal(price);
    });
  }
});
