// Dust-scale quote semantics on strongly de-anchored pools.
//
// In integer arithmetic the secant solver's terminal iterate can land
// on the wrong side of the pre-state (`yPost > yMath`) when the trade's
// signal is dominated by the kernel's integer quantization — reachable
// on pools whose state sits far from the anchor. The kernel fails
// closed on such iterates with a zero-output sentinel (and the
// exact-out mirror with a zero input), which the pool's typed dust
// guards turn into
// `AmountTooSmallAfterNormalization`; `quoteExactIn` returns 0 like
// every other unquotable dust case. This suite pins that classification
// on a state where the overshoot branch demonstrably fires.
//
// Vector provenance: bit-exact bigint replica of the kernel, validated
// against the chain point-for-point; the pinned post-skew state has the
// overshoot band `dxMath ∈ [2195, 73910]` for the exact-in solver.
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
const R0_AFTER = 12500000000000000000000n;
const R1_AFTER = 28483987539843244337n;

// Raw input amounts whose clean input lands inside the overshoot band
// (clean = amt − ⌊amt·0.003⌋ ∈ [2195, 73910]).
const IN_BAND = [2210n, 3000n, 50000n, 74000n];
// Just below the band (clean(2200) = 2194): the solver converges
// normally there and quotes a 5-wei output.
const BELOW_BAND = 2200n;
const BELOW_BAND_OUT = 5n;

describe("Dust quote soft-fail (de-anchored pool)", function () {
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

  it("quoteExactIn returns 0 (no revert) across the overshoot band", async function () {
    const fx = await loadFixture(deployFixture);
    for (const amt of IN_BAND) {
      expect(await fx.pool.quoteExactIn(true, amt)).to.equal(0n);
    }
    // The band's lower neighbour quotes a nonzero dust output — the
    // zero classification is confined to the overshoot band itself.
    expect(await fx.pool.quoteExactIn(true, BELOW_BAND)).to.equal(BELOW_BAND_OUT);
  });

  it("swapping an in-band amount reverts with the typed dust error", async function () {
    const fx = await loadFixture(deployFixture);
    for (const amt of [IN_BAND[1], IN_BAND[2]]) {
      await expect(
        fx.router.connect(fx.trader).exactInputSingle({
          tokenIn: fx.meta.token0,
          tokenOut: fx.meta.token1,
          poolIndex: 0,
          recipient: fx.trader.address,
          amountIn: amt,
          amountOutMinimum: 0,
          deadline: MaxUint256,
        })
      ).to.be.revertedWithCustomError(fx.pool, "AmountTooSmallAfterNormalization");
    }
  });

  it("meaningful amounts stay quotable and swappable", async function () {
    const fx = await loadFixture(deployFixture);
    const amt = hre.ethers.parseEther("1");
    const quoted = await fx.pool.quoteExactIn(true, amt);
    expect(quoted).to.be.gt(0n);
    const balBefore = await (
      await hre.ethers.getContractAt("MockERC20", fx.meta.token1)
    ).balanceOf(fx.trader.address);
    await fx.router.connect(fx.trader).exactInputSingle({
      tokenIn: fx.meta.token0,
      tokenOut: fx.meta.token1,
      poolIndex: 0,
      recipient: fx.trader.address,
      amountIn: amt,
      amountOutMinimum: quoted,
      deadline: MaxUint256,
    });
    const balAfter = await (
      await hre.ethers.getContractAt("MockERC20", fx.meta.token1)
    ).balanceOf(fx.trader.address);
    expect(balAfter - balBefore).to.equal(quoted);
  });

  it("dust exact-out on this fixture quotes deterministically (branch pinned at kernel level)", async function () {
    const fx = await loadFixture(deployFixture);
    // On this state the exact-out solver converges normally for 1/2/5
    // wei outputs — the wrong-side branch is exercised by the direct
    // kernel vectors below, not by this fixture.
    for (const outAmt of [1n, 2n, 5n]) {
      expect(await fx.pool.quoteExactOut(false, outAmt)).to.equal(2n);
    }
  });

  it("quoteSwapToPrice never returns an unexecutable pair on the de-anchored pool", async function () {
    const fx = await loadFixture(deployFixture);
    const os = await fx.pool.getOracleState();
    const target = (BigInt(os.sqrtPriceX96) * 99n) / 100n;
    const [amountIn, amountOut] = await fx.pool.quoteSwapToPrice(true, target);
    if (amountIn === 0n) {
      expect(amountOut).to.equal(0n);
    } else {
      // Executability: the quoted pair must replay through the live
      // quote bit-for-bit.
      expect(amountOut).to.be.gt(0n);
      expect(await fx.pool.quoteExactIn(true, amountIn)).to.equal(amountOut);
    }
  });

  it("kernel branch pins: wrong-side iterates report zero sentinels", async function () {
    const Harness = await hre.ethers.getContractFactory("SwapMathHarness");
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    // Exact-out undershoot vector (terminal iterate 106_282 below the
    // pre-state input axis).
    const [dx] = await harness.quoteExactOutForward(
      1_000_000_000_000n,
      100_000_000_000n,
      1n,
      990000000000000000n, // a = 0.99
      1000000000000000000n // λ = 1.0
    );
    expect(dx).to.equal(0n);
    // Exact-in overshoot twin on this suite's pinned de-anchored state
    // (clean input 2204 sits inside the [2195, 73910] band).
    const [dy] = await harness.quoteExactInForward(
      12500000000000000000000n,
      28483987539843244337n,
      2204n,
      909610000000000000n,
      16780000000000000n
    );
    expect(dy).to.equal(0n);
  });

  // previewZapIn's zero-swap-quote guard (mirroring the execution's
  // dust revert) has no deterministically reachable vector through the
  // public zap surface on the states explored here: the CP-zap
  // heuristic's swap split jumps discretely past the kernel's
  // zero-quote bands. The guard exists as defense-in-depth, matching
  // previewZapOut's identical off-side rule.
});

describe("quoteSwapToPrice executability guard (dust-band pool)", function () {
  // Admissible pool whose bisection probes land in the kernel's
  // zero-output band: without the either-side-zero guard the view
  // returned (1, 0, false) — a positive amountIn whose execution is
  // guaranteed to revert.
  const CONFIG2 = {
    aWad: 100000000000000000n, // a = 0.1 (A_MIN)
    lambdaWad: 1000000000000000n, // λ = 0.001 (LAMBDA_MIN)
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

  async function deployTinyFixture() {
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
      hre.ethers.parseEther("1"),
      hre.ethers.parseEther("1"),
      owner.address
    );
    const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
    return { pool };
  }

  it("folds an unexecutable best iterate into (0, 0, false)", async function () {
    const fx = await loadFixture(deployTinyFixture);
    const target = Q96 - 100_000_000_000n;
    const [amountIn, amountOut, crossesAnchor] = await fx.pool.quoteSwapToPrice(true, target);
    expect(amountIn).to.equal(0n);
    expect(amountOut).to.equal(0n);
    expect(crossesAnchor).to.equal(false);
    // The would-be pair really is unexecutable on this state.
    expect(await fx.pool.quoteExactIn(true, 1n)).to.equal(0n);
  });

  it("still returns executable pairs for reachable targets", async function () {
    const fx = await loadFixture(deployTinyFixture);
    const os = await fx.pool.getOracleState();
    const target = (BigInt(os.sqrtPriceX96) * 95n) / 100n;
    const [amountIn, amountOut] = await fx.pool.quoteSwapToPrice(true, target);
    expect(amountIn).to.be.gt(0n);
    expect(amountOut).to.be.gt(0n);
    expect(await fx.pool.quoteExactIn(true, amountIn)).to.equal(amountOut);
  });
});
