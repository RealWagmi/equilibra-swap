import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

async function deployStandardPoolFixture() {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token0", "TK0", 18);
  const tokenB = await Token.deploy("Token1", "TK1", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();

  // Canonicalize variable names to match factory's lexicographic ordering:
  // factory.createPoolAndAddLiquidity sorts (tokenA, tokenB) so that
  // pool.getPoolMetadata().token0 < .token1.
  // Without this swap, hardhat's loadFixture re-runs may flip deployment addresses
  // between test runs and break tests that rely on (token0Addr, token1Addr) order.
  const tokenAAddr = await tokenA.getAddress();
  const tokenBAddr = await tokenB.getAddress();
  const [token0, token1] = tokenAAddr.toLowerCase() < tokenBAddr.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  await factory.setProtocolFee(20); // 20% of swap fee goes to protocol.

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  const million = hre.ethers.parseEther("1000000");
  await token0.mint(owner.address, million * 2n);
  await token1.mint(owner.address, million * 2n);
  await token0.mint(trader.address, million);
  await token1.mint(trader.address, million);

  // Atomic genesis: deploy + seed in one tx through the factory.
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);
  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad: PRESET.aWad,
      lambdaWad: PRESET.lambdaWad,
      baseFee: 30,
      emaPeriod: 1200,
      repegStepWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
      feeRampBps: 0,
      feeFloorBps: 20,
      repegShareBps: 5000,
    },
    million,
    million,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  // Trader uses the router; subsequent LP deposits flow through provider.
  const Provider = await hre.ethers.getContractFactory("MockMintCallbackProvider");
  const provider = await Provider.deploy();
  await provider.waitForDeployment();
  const providerAddr = await provider.getAddress();

  await token0.approve(providerAddr, MaxUint256);
  await token1.approve(providerAddr, MaxUint256);
  await token0.connect(trader).approve(await router.getAddress(), MaxUint256);
  await token1.connect(trader).approve(await router.getAddress(), MaxUint256);

  const token0Addr = await token0.getAddress();
  const token1Addr = await token1.getAddress();

  return {
    owner,
    trader,
    token0,
    token1,
    factory,
    pool,
    router,
    provider,
    poolAddress,
    token0Addr,
    token1Addr,
  };
}

async function deployFeeOnTransferFixture() {
  const [owner] = await hre.ethers.getSigners();

  const FOT = await hre.ethers.getContractFactory("MockFeeOnTransferERC20");
  const Standard = await hre.ethers.getContractFactory("MockERC20");
  const feeToken = await FOT.deploy("FeeToken", "FEE", 18, 100, owner.address);
  const stableToken = await Standard.deploy("Stable", "STB", 18);
  await feeToken.waitForDeployment();
  await stableToken.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  // The fee-on-transfer token guarantees that any genesis bootstrap will
  // revert in `addLiquidity`'s conservation check, so the fixture leaves
  // pool creation up to the test (which expects the revert).
  const amount = hre.ethers.parseEther("10000");
  await feeToken.mint(owner.address, amount);
  await stableToken.mint(owner.address, amount);

  await feeToken.approve(factoryAddr, MaxUint256);
  await stableToken.approve(factoryAddr, MaxUint256);

  return { owner, feeToken, stableToken, factory, poolImpl };
}

describe("PoolSecurity", function () {
  it("rejects fee-on-transfer tokens on liquidity paths", async function () {
    const { owner, feeToken, stableToken, factory, poolImpl } = await loadFixture(deployFeeOnTransferFixture);
    const amount = hre.ethers.parseEther("1000");

    // The genesis seed pulled by `createPoolAndAddLiquidity` runs through
    // the pool's conservation check; the FOT token short-changes the pool,
    // so the very first mint must revert with `UnsupportedTokenBehavior`.
    await expect(
      factory.createPoolAndAddLiquidity(
        await feeToken.getAddress(),
        await stableToken.getAddress(),
        {
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
          baseFee: 30,
          emaPeriod: 1200,
          repegStepWad: hre.ethers.parseUnits("1", 15),
          repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
          repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
          feeRampBps: 0,
          feeFloorBps: 20,
          repegShareBps: 5000,
        },
        amount,
        amount,
        owner.address
      )
    ).to.be.revertedWithCustomError(poolImpl, "UnsupportedTokenBehavior");
  });

  it("rejects callback underpayment and overpayment on swap", async function () {
    const { owner, pool, token0 } = await loadFixture(deployStandardPoolFixture);
    const CallbackTrader = await hre.ethers.getContractFactory("MockSwapCallbackTrader");
    const callbackTrader: any = await CallbackTrader.deploy();
    await callbackTrader.waitForDeployment();

    await token0.mint(await callbackTrader.getAddress(), hre.ethers.parseEther("10000"));

    const amountSpecified = hre.ethers.parseEther("100");
    await expect(
      callbackTrader.executeSwap(
        await pool.getAddress(),
        owner.address,
        true,
        amountSpecified,
        0 // PayMode.Exact
      )
    ).to.not.be.reverted;

    await expect(
      callbackTrader.executeSwap(
        await pool.getAddress(),
        owner.address,
        true,
        amountSpecified,
        1 // PayMode.Underpay
      )
    ).to.be.revertedWithCustomError(pool, "UnsupportedTokenBehavior");

    await expect(
      callbackTrader.executeSwap(
        await pool.getAddress(),
        owner.address,
        true,
        amountSpecified,
        2 // PayMode.Overpay
      )
    ).to.be.revertedWithCustomError(pool, "UnsupportedTokenBehavior");
  });

  it("allows protocol fee collection only by fee collector", async function () {
    const { owner, trader, pool, token0, router, token0Addr, token1Addr } =
      await loadFixture(deployStandardPoolFixture);
    const deadline = (await time.latest()) + 3600;

    await router.connect(trader).exactInputSingle({
      tokenIn: token0Addr,
      tokenOut: token1Addr,
      poolIndex: 0,
      recipient: trader.address,
      amountIn: hre.ethers.parseEther("1000"),
      amountOutMinimum: 0,
      deadline,
    });

    expect((await pool.getProtocolFees()).fee0).to.be.gt(0n);

    await expect(pool.connect(trader).collectProtocolFees(trader.address)).to.be.revertedWithCustomError(
      pool,
      "Unauthorized"
    );

    const collectorBalanceBefore = await token0.balanceOf(owner.address);
    await pool.connect(owner).collectProtocolFees(owner.address);
    const collectorBalanceAfter = await token0.balanceOf(owner.address);

    expect(collectorBalanceAfter).to.be.gt(collectorBalanceBefore);
    expect((await pool.getProtocolFees()).fee0).to.equal(0n);
  });

  it("keeps anchor static on liquidity events and updates through swaps", async function () {
    const { owner, trader, pool, router, token0Addr, token1Addr } = await loadFixture(deployStandardPoolFixture);
    const anchorBefore = (await pool.getOracleState()).priceScaleWad;

    await pool.removeLiquidity(hre.ethers.parseEther("1000"), 0, 0, owner.address);
    const anchorAfterLiquidity = (await pool.getOracleState()).priceScaleWad;
    expect(anchorAfterLiquidity).to.equal(anchorBefore);

    await time.increase(20);
    await router.connect(trader).exactInputSingle({
      tokenIn: token0Addr,
      tokenOut: token1Addr,
      poolIndex: 0,
      recipient: trader.address,
      amountIn: hre.ethers.parseEther("5000"),
      amountOutMinimum: 0,
      deadline: (await time.latest()) + 3600,
    });

    const anchorAfterSwap = (await pool.getOracleState()).priceScaleWad;
    expect(anchorAfterSwap).to.not.equal(0n);
  });

  it("enforces pause guard rails on swap and liquidity paths", async function () {
    const { owner, trader, pool, router, provider, poolAddress, token0Addr, token1Addr } =
      await loadFixture(deployStandardPoolFixture);

    await expect(pool.connect(trader).setPaused(true)).to.be.revertedWithCustomError(pool, "Unauthorized");

    await pool.connect(owner).setPaused(true);
    expect(await pool.paused()).to.equal(true);

    await expect(
      router.connect(trader).exactInputSingle({
        tokenIn: token0Addr,
        tokenOut: token1Addr,
        poolIndex: 0,
        recipient: trader.address,
        amountIn: hre.ethers.parseEther("100"),
        amountOutMinimum: 0,
        deadline: (await time.latest()) + 3600,
      })
    ).to.be.revertedWithCustomError(pool, "Paused");

    await expect(
      provider.addLiquidity(poolAddress, hre.ethers.parseEther("10"), hre.ethers.parseEther("10"), 0, owner.address)
    ).to.be.revertedWithCustomError(pool, "Paused");

    // Audit fix M-01: emergency pause must NOT block LP exits. The pool
    // has been seeded by `deployStandardPoolFixture` so `owner` already
    // holds LP shares; burning them while paused must succeed.
    const ownerShares = await pool.balanceOf(owner.address);
    expect(ownerShares).to.be.gt(0n);
    const sharesToBurn = ownerShares / 4n; // partial exit
    await expect(pool.connect(owner).removeLiquidity(sharesToBurn, 0, 0, owner.address)).to.not.be.reverted;
    expect(await pool.balanceOf(owner.address)).to.equal(ownerShares - sharesToBurn);
    expect(await pool.paused()).to.equal(true);

    await pool.connect(owner).setPaused(false);
    expect(await pool.paused()).to.equal(false);
  });

  it("allows the fee collector to harvest protocol fees while the pool is paused", async function () {
    // Audit fix M-01 surface: pause must NOT block protocol-fee
    // collection — otherwise an emergency pause could double as a
    // griefing vector that strands fees the protocol has already
    // earned. We accrue fees via a normal swap, flip the pause bit,
    // then call `collectProtocolFees` from the fee collector
    // (factory owner) and verify the harvest succeeds and zeroes the
    // packed fee buckets.
    const { owner, trader, pool, token0, router, token0Addr, token1Addr } =
      await loadFixture(deployStandardPoolFixture);

    // Accrue at least one wei of protocol fees first.
    await router.connect(trader).exactInputSingle({
      tokenIn: token0Addr,
      tokenOut: token1Addr,
      poolIndex: 0,
      recipient: trader.address,
      amountIn: hre.ethers.parseEther("1000"),
      amountOutMinimum: 0,
      deadline: (await time.latest()) + 3600,
    });
    expect((await pool.getProtocolFees()).fee0).to.be.gt(0n);

    await pool.connect(owner).setPaused(true);
    expect(await pool.paused()).to.equal(true);

    const collectorBefore = await token0.balanceOf(owner.address);
    await expect(pool.connect(owner).collectProtocolFees(owner.address)).to.not.be.reverted;
    const collectorAfter = await token0.balanceOf(owner.address);

    expect(collectorAfter).to.be.gt(collectorBefore);
    expect((await pool.getProtocolFees()).fee0).to.equal(0n);
    // Pool must still be paused — the harvest is allowed-while-paused
    // by design, not because the collector silently un-paused.
    expect(await pool.paused()).to.equal(true);
  });
});
