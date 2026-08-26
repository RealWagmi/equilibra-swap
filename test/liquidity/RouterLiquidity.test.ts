import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const WAD = 10n ** 18n;
const PRESET = EQUILIBRA_PRESETS.WETH;

// Default genesis bootstrap: 1:1 ratio at 1000e18 each so the router suite
// can focus on follow-up deposits / slippage / events. Tests that need a
// different ratio override via `genesis0` / `genesis1`.
async function deployFixtureWith(
  genesis0: bigint = hre.ethers.parseEther("1000"),
  genesis1: bigint = hre.ethers.parseEther("1000")
) {
  const [owner, lp2] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const token0 = await Token.deploy("Token0", "TK0", 18);
  const token1 = await Token.deploy("Token1", "TK1", 18);
  await token0.waitForDeployment();
  await token1.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const supply = hre.ethers.parseEther("10000000");
  await token0.mint(owner.address, supply);
  await token1.mint(owner.address, supply);
  await token0.mint(lp2.address, supply);
  await token1.mint(lp2.address, supply);

  // Owner seeds the genesis liquidity through the factory (the only
  // entry-point that can deploy a pool now). Approvals to the factory
  // are owner-only because lp2 only ever talks to the router.
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
    genesis0,
    genesis1,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  // Users approve only the router for follow-up deposits, never the pool.
  await token0.approve(routerAddr, MaxUint256);
  await token1.approve(routerAddr, MaxUint256);
  await token0.connect(lp2).approve(routerAddr, MaxUint256);
  await token1.connect(lp2).approve(routerAddr, MaxUint256);

  const token0Addr = await token0.getAddress();
  const token1Addr = await token1.getAddress();
  return {
    owner,
    lp2,
    token0,
    token1,
    pool,
    router,
    poolAddress,
    routerAddr,
    token0Addr,
    token1Addr,
    genesis0,
    genesis1,
  };
}

function deployFixture() {
  return deployFixtureWith();
}

describe("RouterLiquidity", function () {
  it("genesis bootstrap (via factory) mints correct sqrt-based shares", async function () {
    // The router cannot bootstrap an empty pool any more (factory is the
    // only deployer) — this test pins down the genesis arithmetic by
    // bootstrapping with a non-1:1 ratio through the factory directly.
    const { owner, pool } = await deployFixtureWith(hre.ethers.parseEther("1000"), hre.ethers.parseEther("4000"));

    const totalSupply = await pool.totalSupply();
    const deadShares = 1_000_000n;
    // sqrt(1000e18 * 4000e18) = 2000e18
    const expectedShares = 2000n * WAD - deadShares;
    expect(totalSupply).to.equal(expectedShares + deadShares);

    const ownerBal = await pool.balanceOf(owner.address);
    expect(ownerBal).to.equal(expectedShares);
  });

  it("proportional deposit through router pulls only needed amounts", async function () {
    const { lp2, router, token0, token1, token0Addr, token1Addr } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;

    // LP2 provides excess token1; only proportional amount should be pulled.
    const deposit0 = hre.ethers.parseEther("500");
    const deposit1 = hre.ethers.parseEther("2000");

    const bal0Before = await token0.balanceOf(lp2.address);
    const bal1Before = await token1.balanceOf(lp2.address);

    await router.connect(lp2).addLiquidity({
      tokenA: token0Addr,
      tokenB: token1Addr,
      poolIndex: 0,
      recipient: lp2.address,
      amountADesired: deposit0,
      amountBDesired: deposit1,
      minShares: 0,
      deadline,
    });

    const spent0 = bal0Before - (await token0.balanceOf(lp2.address));
    const spent1 = bal1Before - (await token1.balanceOf(lp2.address));

    // At 1:1 ratio, only 500 of each token should be used.
    expect(spent0).to.equal(deposit0);
    expect(spent1).to.equal(deposit0); // 500, not 2000
  });

  it("user never approves pool directly", async function () {
    const { lp2, pool, router, token0, token1, poolAddress, token0Addr, token1Addr } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;

    // LP2 only ever approved the router — verify no direct pool allowance.
    expect(await token0.allowance(lp2.address, poolAddress)).to.equal(0n);
    expect(await token1.allowance(lp2.address, poolAddress)).to.equal(0n);

    // Follow-up deposit through the router still succeeds without any
    // direct pool approval.
    await router.connect(lp2).addLiquidity({
      tokenA: token0Addr,
      tokenB: token1Addr,
      poolIndex: 0,
      recipient: lp2.address,
      amountADesired: hre.ethers.parseEther("1000"),
      amountBDesired: hre.ethers.parseEther("1000"),
      minShares: 0,
      deadline,
    });

    const shares = await pool.balanceOf(lp2.address);
    expect(shares).to.be.gt(0n);
  });

  it("enforces deadline", async function () {
    const { lp2, router, token0Addr, token1Addr } = await loadFixture(deployFixture);

    const pastDeadline = (await time.latest()) - 1;

    await expect(
      router.connect(lp2).addLiquidity({
        tokenA: token0Addr,
        tokenB: token1Addr,
        poolIndex: 0,
        recipient: lp2.address,
        amountADesired: hre.ethers.parseEther("1000"),
        amountBDesired: hre.ethers.parseEther("1000"),
        minShares: 0,
        deadline: pastDeadline,
      })
    ).to.be.revertedWithCustomError(router, "DeadlineExpired");
  });

  it("enforces minShares slippage protection", async function () {
    const { lp2, router, pool, token0Addr, token1Addr } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;

    // Attempt a follow-up deposit with impossibly high minShares.
    await expect(
      router.connect(lp2).addLiquidity({
        tokenA: token0Addr,
        tokenB: token1Addr,
        poolIndex: 0,
        recipient: lp2.address,
        amountADesired: hre.ethers.parseEther("100"),
        amountBDesired: hre.ethers.parseEther("100"),
        minShares: hre.ethers.parseEther("999999"),
        deadline,
      })
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");
  });

  it("rejects callback from non-pool address", async function () {
    const { router, token0Addr, token1Addr } = await loadFixture(deployFixture);

    // Directly calling the callback should revert because msg.sender won't match
    // the deterministic pool address computed from the encoded data.
    const fakeData = hre.ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint32", "address"],
      [token0Addr, token1Addr, 0, hre.ethers.ZeroAddress]
    );

    await expect(router.equilibraMintCallback(1000, 1000, fakeData)).to.be.revertedWithCustomError(
      router,
      "InvalidCallbackSender"
    );
  });

  it("follow-up shares are proportional to deposit size", async function () {
    const { owner, lp2, pool, router, token0Addr, token1Addr } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;

    const base = hre.ethers.parseEther("1000");
    const sharesOwner = await pool.balanceOf(owner.address);

    // LP2 deposits the same amount the genesis seeded.
    await router.connect(lp2).addLiquidity({
      tokenA: token0Addr,
      tokenB: token1Addr,
      poolIndex: 0,
      recipient: lp2.address,
      amountADesired: base,
      amountBDesired: base,
      minShares: 0,
      deadline,
    });
    const sharesLp2 = await pool.balanceOf(lp2.address);

    // LP2 gets slightly more due to dead shares diluting owner.
    expect(sharesLp2 - sharesOwner).to.equal(1_000_000n);
  });

  it("emits LiquidityAdded with router as sender (follow-up deposit)", async function () {
    const { lp2, pool, router, routerAddr, token0Addr, token1Addr } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;

    const a0 = hre.ethers.parseEther("1000");
    const a1 = hre.ethers.parseEther("1000");

    await expect(
      router.connect(lp2).addLiquidity({
        tokenA: token0Addr,
        tokenB: token1Addr,
        poolIndex: 0,
        recipient: lp2.address,
        amountADesired: a0,
        amountBDesired: a1,
        minShares: 0,
        deadline,
      })
    )
      .to.emit(pool, "LiquidityAdded")
      .withArgs(routerAddr, lp2.address, a0, a1, (shares: bigint) => shares > 0n);
  });

  it("does not move anchor price on follow-up deposits", async function () {
    const { lp2, pool, router, token0Addr, token1Addr } = await loadFixture(deployFixture);
    const deadline = (await time.latest()) + 3600;

    const anchorBefore = (await pool.getOracleState()).priceScaleWad;

    await router.connect(lp2).addLiquidity({
      tokenA: token0Addr,
      tokenB: token1Addr,
      poolIndex: 0,
      recipient: lp2.address,
      amountADesired: hre.ethers.parseEther("500"),
      amountBDesired: hre.ethers.parseEther("500"),
      minShares: 0,
      deadline,
    });

    expect((await pool.getOracleState()).priceScaleWad).to.equal(anchorBefore);
  });
});
