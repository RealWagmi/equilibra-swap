// Dust-scale quote and execution classification on de-anchored pools.
// Q128 and the common margin change both the setup trade
// and its subsequent dust quotes. Pin individual reachable amounts:
// positive quotes must execute exactly; native dust refusals must match
// the same typed error in both paths and leave the reserves untouched.
// The historical literal kernel state remains a separate regression below.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

const CONFIG = {
  aWad: 909610000000000000n, // a = 0.90961
  lambdaWad: 16780000000000000n, // λ = 0.01678
  baseFee: 30,
  emaPeriod: 1200,
  repegStepWad: hre.ethers.parseUnits("1", 15),
  repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
  repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
  feeRampBps: 0, // flat fee — deterministic clean-input mapping
  feeFloorBps: 20,
  repegShareBps: 0, // anchor frozen — deterministic post-skew state
};

const SEED = hre.ethers.parseEther("1000");
const SKEW_IN = hre.ethers.parseEther("11500");

// Pinned post-skew reserves (protocol fee 0 ⇒ reserve0 = seed + skew).
// The setup quote includes the common 0.000001% output margin.
const R0_AFTER = 12500000000000000000000n;
const R1_AFTER = 28483997255003368787n;

const DUST_CASES = [
  { amount: 1n, error: "AmountTooSmallAfterNormalization" },
  { amount: 1000n, output: 1n }, // first LP check passes: no output quantum
  { amount: 2200n, output: 2n },
  { amount: 2210n, output: 2n },
  { amount: 3000n, output: 3n },
  { amount: 50000n, output: 54n }, // the old WAD-precision cap refusal now converges
  { amount: 74000n, output: 81n }, // the old zero-output classification no longer applies
] as const;

describe("Dust quote and swap classification (de-anchored pool)", function () {
  async function deployFixture() {
    const [owner, trader] = await hre.ethers.getSigners();
    const Token = await hre.ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("TokenA", "TKA", 18);
    const tokenB = await Token.deploy("TokenB", "TKB", 18);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
    const poolImpl = await PoolImpl.deploy();
    await poolImpl.waitForDeployment();
    const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
    const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
    await factory.waitForDeployment();
    const Weth = await hre.ethers.getContractFactory("MockWETH9");
    const weth = await Weth.deploy();
    await weth.waitForDeployment();
    const Router = await hre.ethers.getContractFactory("EquilibraRouter");
    const router = await Router.deploy(
      await factory.getAddress(),
      await poolImpl.getAddress(),
      await weth.getAddress()
    );
    await router.waitForDeployment();

    for (const t of [tokenA, tokenB]) {
      await t.mint(owner.address, MaxUint256 / 4n);
      await t.approve(await factory.getAddress(), MaxUint256);
      await t.approve(await router.getAddress(), MaxUint256);
      await t.mint(trader.address, hre.ethers.parseEther("1000000"));
      await t.connect(trader).approve(await router.getAddress(), MaxUint256);
    }

    await factory.createPoolAndAddLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      CONFIG,
      SEED,
      SEED,
      owner.address
    );
    const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
    const meta = await pool.getPoolMetadata();

    // One large 0→1 swap de-anchors the pool (anchor frozen by
    // repegShareBps = 0): reserve0 climbs to seed + skew exactly
    // (protocol fee 0), reserve1 drains to the pinned value.
    await router.exactInputSingle({
      tokenIn: meta.token0,
      tokenOut: meta.token1,
      poolIndex: 0,
      recipient: owner.address,
      amountIn: SKEW_IN,
      amountOutMinimum: 0,
      deadline: MaxUint256,
    });

    return { owner, trader, pool, router, meta };
  }

  it("reaches the pinned de-anchored state", async function () {
    const fx = await loadFixture(deployFixture);
    const [r0, r1] = await fx.pool.getReserves();
    expect(r0).to.equal(R0_AFTER);
    expect(r1).to.equal(R1_AFTER);
  });

  for (const c of DUST_CASES) {
    it(`classifies input ${c.amount} identically in the quote and actual swap`, async function () {
      const fx = await loadFixture(deployFixture);
      const swap = () =>
        fx.router.connect(fx.trader).exactInputSingle({
          tokenIn: fx.meta.token0,
          tokenOut: fx.meta.token1,
          poolIndex: 0,
          recipient: fx.trader.address,
          amountIn: c.amount,
          amountOutMinimum: 0,
          deadline: MaxUint256,
        });
      if ("error" in c) {
        const before = Array.from(await fx.pool.getReserves());
        await expect(fx.pool.quoteExactIn(true, c.amount)).to.be.revertedWithCustomError(fx.pool, c.error);
        await expect(swap()).to.be.revertedWithCustomError(fx.pool, c.error);
        expect(Array.from(await fx.pool.getReserves())).to.deep.equal(before);
      } else {
        expect(await fx.pool.quoteExactIn(true, c.amount)).to.equal(c.output);
        const tokenOut = await hre.ethers.getContractAt("MockERC20", fx.meta.token1);
        const before = await tokenOut.balanceOf(fx.trader.address);
        await swap();
        expect((await tokenOut.balanceOf(fx.trader.address)) - before).to.equal(c.output);
      }
    });
  }

  it("meaningful amounts stay quotable and swappable", async function () {
    const fx = await loadFixture(deployFixture);
    const amt = hre.ethers.parseEther("1");
    const quoted = await fx.pool.quoteExactIn(true, amt);
    expect(quoted).to.be.gt(0n);
    const balBefore = await (await hre.ethers.getContractAt("MockERC20", fx.meta.token1)).balanceOf(fx.trader.address);
    await fx.router.connect(fx.trader).exactInputSingle({
      tokenIn: fx.meta.token0,
      tokenOut: fx.meta.token1,
      poolIndex: 0,
      recipient: fx.trader.address,
      amountIn: amt,
      amountOutMinimum: quoted,
      deadline: MaxUint256,
    });
    const balAfter = await (await hre.ethers.getContractAt("MockERC20", fx.meta.token1)).balanceOf(fx.trader.address);
    expect(balAfter - balBefore).to.equal(quoted);
  });

  it("rejects zero-clean-input exact-out dust consistently without state changes", async function () {
    for (const outAmt of [1n, 2n, 5n]) {
      const fx = await loadFixture(deployFixture);
      const before = Array.from(await fx.pool.getReserves());
      await expect(fx.pool.quoteExactOut(false, outAmt)).to.be.revertedWithCustomError(
        fx.pool,
        "AmountTooSmallAfterNormalization"
      );
      await expect(
        fx.router.connect(fx.trader).exactOutputSingle({
          tokenIn: fx.meta.token1,
          tokenOut: fx.meta.token0,
          poolIndex: 0,
          recipient: fx.trader.address,
          amountOut: outAmt,
          amountInMaximum: 2n,
          deadline: MaxUint256,
        })
      ).to.be.revertedWithCustomError(fx.pool, "AmountTooSmallAfterNormalization");
      expect(Array.from(await fx.pool.getReserves())).to.deep.equal(before);
    }
  });

  it("quoteSwapToPrice never returns an unexecutable pair on the de-anchored pool", async function () {
    const fx = await loadFixture(deployFixture);
    const os = await fx.pool.getOracleState();
    const target = (BigInt(os.sqrtPriceX96) * 99n) / 100n;
    const [amountIn, amountOut] = await fx.router.quoteSwapToPrice(fx.meta.token0, fx.meta.token1, 0, target);
    if (amountIn === 0n) {
      expect(amountOut).to.equal(0n);
    } else {
      // Executability: the quoted pair must replay through the live
      // quote bit-for-bit.
      expect(amountOut).to.be.gt(0n);
      expect(await fx.pool.quoteExactIn(true, amountIn)).to.equal(amountOut);
    }
  });

  it("kernel pins: Q128 resolves the historical wrong-side and stagnation fixtures", async function () {
    const Harness = await hre.ethers.getContractFactory("SwapMathHarness");
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    // This literal used to hit the wrong-side zero sentinel. Pin the
    // actual Q128 result without claiming exact continuous-root accuracy
    // for an extremely small pool or deleting the production sentinel.
    const [dx, exactOutIterations] = await harness.quoteExactOutForward(
      1_000_000_000_000n,
      100_000_000_000n,
      1n,
      990000000000000000n, // a = 0.99
      1000000000000000000n // λ = 1.0
    );
    expect(dx).to.be.greaterThan(0n);
    expect(exactOutIterations).to.equal(2n);
    // Historical literal state, deliberately distinct from the reachable
    // reserves above: Q128 now exits in two iterations with positive output.
    const [dy, iterations] = await harness.quoteExactInForward(
      12500000000000000000000n,
      28483987539843244337n,
      2204n,
      909610000000000000n,
      16780000000000000n
    );
    expect(dy).to.equal(2n);
    expect(iterations).to.equal(2n);
  });

  // RouterZap.test.ts separately exercises typed dust rejection and
  // quote/execution agreement through the public zap surfaces.
});

describe("quoteSwapToPrice executability guard (dust-band pool)", function () {
  // Admissible pool whose bisection probes land in the kernel's
  // zero-output band: without the either-side-zero guard the view
  // returned (1, 0, false) — a positive amountIn whose execution is
  // guaranteed to revert.
  const CONFIG2 = {
    aWad: 100000000000000000n, // a = 0.1 (A_MIN)
    lambdaWad: 1000000000000000n, // λ = 0.001: retain the original dust regression curve
    baseFee: 30,
    emaPeriod: 1200,
    repegStepWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
    feeRampBps: 0,
    feeFloorBps: 20,
    repegShareBps: 0,
  };
  const Q96 = 1n << 96n;

  async function deployTinyFixture(seed = 1n) {
    const [owner] = await hre.ethers.getSigners();
    const Token = await hre.ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("TokenA", "TKA", 18);
    const tokenB = await Token.deploy("TokenB", "TKB", 18);
    const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
    const poolImpl = await PoolImpl.deploy();
    const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
    const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
    for (const t of [tokenA, tokenB]) {
      await t.mint(owner.address, hre.ethers.parseEther("10"));
      await t.approve(await factory.getAddress(), MaxUint256);
    }
    await factory.createPoolAndAddLiquidity(
      await tokenA.getAddress(),
      await tokenB.getAddress(),
      CONFIG2,
      seed * hre.ethers.parseEther("1"),
      seed * hre.ethers.parseEther("1"),
      owner.address
    );
    const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
    const weth = await (await hre.ethers.getContractFactory("MockWETH9")).deploy();
    const router = await (
      await hre.ethers.getContractFactory("EquilibraRouter")
    ).deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
    return { pool, router, meta: await pool.getPoolMetadata() };
  }

  async function deployDustBoundaryFixture() {
    return deployTinyFixture(3n);
  }

  it("skips the refused one-unit input and finds a checked nonzero neighbor", async function () {
    const fx = await loadFixture(deployTinyFixture);
    const target = Q96 - 1_000_000_000_000n;
    const [amountIn, amountOut, crossesAnchor] = await fx.router.quoteSwapToPrice(
      fx.meta.token0,
      fx.meta.token1,
      0,
      target
    );
    expect(amountIn).to.be.gte(3n);
    expect(amountOut).to.be.gt(0n);
    expect(await fx.pool.quoteExactIn(true, amountIn)).to.equal(amountOut);
    expect(crossesAnchor).to.equal(false);
    // The smaller input still refuses; recovery must not turn that into an OK quote.
    await expect(fx.pool.quoteExactIn(true, 1n)).to.be.revertedWithCustomError(
      fx.pool,
      "AmountTooSmallAfterNormalization"
    );
  });

  for (const zeroForOne of [true, false]) {
    it("preserves a positive price-target dust output that passes its LP guard: " + zeroForOne, async function () {
      const { pool, router, meta } = await loadFixture(deployDustBoundaryFixture);
      expect(await pool.quoteExactIn(zeroForOne, 3n)).to.equal(1n);
      const target = zeroForOne ? Q96 - 400000000000n : Q96 + 400000000000n;
      const [input, output] = await router.quoteSwapToPrice(
        zeroForOne ? meta.token0 : meta.token1,
        zeroForOne ? meta.token1 : meta.token0,
        0,
        target
      );
      expect(input).to.be.greaterThan(0n);
      expect(output).to.be.greaterThan(0n);
      expect(output).to.equal(await pool.quoteExactIn(zeroForOne, input));
    });
  }

  it("still returns executable pairs for reachable targets", async function () {
    const fx = await loadFixture(deployTinyFixture);
    const os = await fx.pool.getOracleState();
    const target = (BigInt(os.sqrtPriceX96) * 95n) / 100n;
    const [amountIn, amountOut] = await fx.router.quoteSwapToPrice(fx.meta.token0, fx.meta.token1, 0, target);
    expect(amountIn).to.be.gt(0n);
    expect(amountOut).to.be.gt(0n);
    expect(await fx.pool.quoteExactIn(true, amountIn)).to.equal(amountOut);
  });
});
