import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployNativeQuantumFixture, PRECISION_CONFIG, setNativeReserves } from "../fixtures/nativeQuantum";
import { setPackedPoolField } from "../helpers/storageLayout";
import vectors from "../../simulator/tests/fixtures/equilibra-numeric-domain.json";

const W = 10n ** 18n;
const Q = 1n << 128n;
const MAX = (1n << 256n) - 1n;
const Q96 = 1n << 96n;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const CONFIG = { ...PRECISION_CONFIG, aWad: (99n * W) / 100n, lambdaWad: W / 1000n, baseFee: 5 };

async function harnesses() {
  const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
  const oracle = await (await hre.ethers.getContractFactory("PoolOracleHarness")).deploy();
  return { math, oracle };
}

async function executeQuoted(
  f: Awaited<ReturnType<typeof deployNativeQuantumFixture>>,
  zeroForOne: boolean,
  input: bigint
) {
  const quote = await f.pool.quoteExactIn(zeroForOne, input);
  expect(quote).to.be.gt(0n);
  const incoming = f.tokens[zeroForOne ? 0 : 1],
    outgoing = f.tokens[zeroForOne ? 1 : 0];
  await incoming.mint(f.trader.target, input);
  const before = await outgoing.balanceOf(f.owner.address);
  await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, input, 0);
  expect((await outgoing.balanceOf(f.owner.address)) - before).to.equal(quote);
  return quote;
}

describe("Numeric-domain overflow regressions", function () {
  it("keeps a factory-created private cheap-token pool quotable, readable and swappable after both directions", async () => {
    const f = await deployNativeQuantumFixture({
      initialSwap: false,
      isPrivate: true,
      decimals: [6, 18],
      seedRatio: [500000n, 10n ** 20n],
      poolConfig: CONFIG,
    });
    expect((await f.pool.getOracleState()).priceScaleWad).to.equal(5000n);
    expect(await executeQuoted(f, false, 10n ** 35n)).to.equal(499740104n);
    expect((await f.pool.getOracleState()).pMargWad).to.be.gt(0n);
    await time.increase(60);
    await executeQuoted(f, true, 500000000n);
    expect((await f.pool.getOracleState()).pMargWad).to.be.gt(0n);
  });

  it("projects a large anchor through spot, EMA and a later reverse swap without overflowing", async () => {
    const f = await deployNativeQuantumFixture({ initialSwap: false, decimals: [0, 18], poolConfig: CONFIG });
    await f.tokens[0].mint(f.owner.address, 3n * 10n ** 38n);
    await f.factory.createPrivatePoolAndAddLiquidity(
      f.tokens[0].target,
      f.tokens[1].target,
      CONFIG,
      3n * 10n ** 38n,
      10n ** 15n,
      f.owner.address
    );
    const pool = await hre.ethers.getContractAt("EquilibraPool", await f.factory.allPools(1));
    const large = { ...f, pool };
    expect((await pool.getOracleState()).priceScaleWad).to.equal(3n * 10n ** 59n);
    await time.increase(60);
    await executeQuoted(large, false, 10n ** 12n);
    expect((await pool.getOracleState()).pMargWad).to.be.gt(0n);
    await time.increase(60);
    await executeQuoted(large, true, 10n ** 34n);
    expect((await pool.getOracleState()).priceScaleWad).to.equal(3n * 10n ** 59n);
  });

  it("preserves full-width EMA and anchor-step floor rounding", async () => {
    const { oracle } = await loadFixture(harnesses);
    const v = vectors.fullWidthEma;
    const price = BigInt(v.anchorCoefficient) * 10n ** BigInt(v.anchorExponent);
    expect(price * W).to.be.gt(MAX);
    for (const spot of [2n * price, price / 2n]) {
      const [log, stamp] = await oracle.updateEma(await oracle.priceToEmaLog(price), 1000, spot, price, 600, 61000);
      expect(log).to.equal(await oracle.priceToEmaLog(spot));
      const ema = await oracle.emaLogToPrice(log);
      expect(ema > spot ? ema - spot : spot - ema).to.be.lte(spot / 10n ** 15n);
      expect(stamp).to.equal(61000n);
    }
    for (const up of [false, true]) {
      const factor = await oracle.applyLogStep(W, up ? 2n * W : W / 2n, W / 1000n);
      const expected = (price * factor) / W;
      expect(await oracle.applyLogStep(price, up ? 2n * price : price / 2n, W / 1000n)).to.equal(expected);
      const shifted = await oracle.shiftPriceScale(price, up ? 2n * price : price / 2n, W / 1000n);
      expect(shifted.priceScaleNewWad).to.equal(expected);
    }
  });

  it("matches the shared large-coordinate price vector", async () => {
    const { math } = await loadFixture(harnesses);
    const v = vectors.largeMarginalPrice;
    const y = (BigInt(v.yWad) * W) / BigInt(v.priceScaleWad);
    expect(
      await math.marginalPriceFromState(BigInt(v.xMath), y, BigInt(vectors.aWad), BigInt(vectors.lambdaWad))
    ).to.equal(BigInt(v.expected));
  });

  it("reduces decimal scales before conversion and clamps only an unrepresentable final result", async () => {
    const { math } = await loadFixture(harnesses);
    // Unbounded BigInt reproduces the documented Q96 floors independently of overflow handling.
    const scales = [1n, 10n ** 10n, 10n ** 12n, W];
    for (const s0 of scales)
      for (const s1 of scales) {
        for (const anchor of [1n, W, 3n * 10n ** 59n]) {
          for (const sqrt of [MIN_SQRT, (1n << 48n) - 1n, Q96, MAX_SQRT]) {
            const priceQ96 = (sqrt * sqrt) / Q96 || 1n;
            const raw = (((W * W * Q96) / priceQ96) * s0) / s1 / anchor;
            const expected = raw > MAX ? MAX : raw || 1n;
            expect(await math.sqrtPriceX96ToMathPriceWad(sqrt, anchor, s0, s1)).to.equal(expected);
          }
        }
      }
    expect(await math.mathPriceToSqrtPriceX96(1n, 1n, W, 1n)).to.equal(MAX_SQRT);
    for (const [s0, s1] of [
      [0n, 1n],
      [1n, 0n],
    ]) {
      await expect(math.sqrtPriceX96ToMathPriceWad(Q96, W, s0, s1)).to.be.revertedWithCustomError(
        math,
        "MathInvariantViolation"
      );
      await expect(math.mathPriceToSqrtPriceX96(W, W, s0, s1)).to.be.revertedWithCustomError(math, "InvalidPriceScale");
    }
  });

  it("accepts the canonical low sqrt target through the real 0/18-decimal router", async () => {
    const f = await deployNativeQuantumFixture({
      initialSwap: false,
      decimals: [0, 18],
      seedRatio: [500000n, 500000n],
      poolConfig: CONFIG,
    });
    const weth = await (await hre.ethers.getContractFactory("MockWETH9")).deploy();
    const router = await (
      await hre.ethers.getContractFactory("EquilibraRouter")
    ).deploy(f.factory.target, f.impl.target, weth.target);
    const [input, output, reached] = await router.quoteSwapToPrice(f.tokens[0].target, f.tokens[1].target, 0, MIN_SQRT);
    expect(input).to.equal(495000n);
    expect(output).to.equal(463936506966482387087446n);
    expect(reached).to.equal(false);
    expect(await f.pool.quoteExactIn(true, input)).to.equal(output);
  });

  it("saturates the CP fee proxy without rejecting an executable large swap", async () => {
    const { math } = await loadFixture(harnesses);
    const r = 500000n * W;
    const scale = 10n ** 12n;
    const input = (Q + 10n ** 15n - r + scale - 1n) / scale;
    expect(await math.predictPostDistanceCp(r, r, input * scale)).to.equal(W);
    expect(await math.predictPostDistanceCp(W, W, W * W)).to.equal(W); // proxy rounds to zero
    expect(await math.predictPostDistanceCp(2n, 2n, 1n)).to.equal(0n); // unchanged dust product
    for (const ramp of [0, 10000]) {
      const f = await deployNativeQuantumFixture({
        initialSwap: false,
        decimals: [6, 6],
        seedRatio: [500000n, 500000n],
        poolConfig: { ...CONFIG, feeFloorBps: ramp ? 1 : 0, feeRampBps: ramp },
      });
      expect(await executeQuoted(f, false, input)).to.equal(499999994999n);
    }
  });

  it("rejects an oversized diagonal at factory genesis, not after the first swap", async () => {
    const { math } = await loadFixture(harnesses);
    // Lifted reserves 1e33/1e40: LP-supply product fits; normalized x=y=1e40 does not.
    expect(10n ** 33n * 10n ** 40n).to.be.at.most(MAX);
    await expect(
      deployNativeQuantumFixture({
        initialSwap: false,
        decimals: [6, 6],
        seedRatio: [10n ** 15n, 10n ** 22n],
        poolConfig: CONFIG,
      })
    ).to.be.revertedWithCustomError(math, "MathOutOfRange");
  });

  it("rolls back the whole swap when a repeg candidate leaves the numeric domain", async () => {
    // Synthetic boundary state: isolates propagation, not a claimed market trajectory.
    const f = await deployNativeQuantumFixture({
      initialSwap: false,
      decimals: [6, 6],
      seedRatio: [500000n, 500000n],
      poolConfig: { ...CONFIG, repegShareBps: 5000, repegStepWad: W / 200n },
    });
    const { math, oracle } = await harnesses();
    const scale = 10n ** 12n;
    const reserves = [((3n * Q) / 2n - 10n ** 33n) / scale, Q / 2n / scale];
    for (const token of f.tokens) await token.mint(f.owner.address, Q);
    await setNativeReserves(f, reserves);
    const now = await time.latest();
    await setPackedPoolField(
      f.pool.target.toString(),
      "_emaLogWad",
      BigInt.asUintN(256, await oracle.priceToEmaLog(W / 2n))
    );
    await setPackedPoolField(f.pool.target.toString(), "_lastEmaTs", BigInt(now + 1000));
    const input = 1000000n;
    const output = await f.pool.quoteExactIn(false, input);
    const x = (reserves[1] + input) * scale,
      y = (reserves[0] - output) * scale;
    expect(await math.solveLFromState(x, y, CONFIG.aWad, CONFIG.lambdaWad)).to.be.gt(0n);
    const candidate = await oracle.applyLogStep(W, W / 2n, W / 200n);
    await expect(
      math.solveLFromState(x, (y * W) / candidate, CONFIG.aWad, CONFIG.lambdaWad)
    ).to.be.revertedWithCustomError(math, "MathOutOfRange");
    const snapshot = async () => ({
      reserves: Array.from(await f.pool.getReserves()),
      lp: Array.from(await f.pool.getLpValueState()),
      oracle: Array.from(await f.pool.getOracleState()),
      balances: await Promise.all(f.tokens.map((token) => token.balanceOf(f.pool.target))),
    });
    const before = await snapshot();
    await f.tokens[1].mint(f.trader.target, input);
    await expect(f.trader.executeSwap(f.pool.target, f.owner.address, false, input, 0)).to.be.revertedWithCustomError(
      f.pool,
      "MathOutOfRange"
    );
    expect(await snapshot()).to.deep.equal(before);
  });
});
