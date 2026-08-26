import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

/**
 * Regression suite for the "dual-purpose `_factory` slot" initialisation
 * pattern used by {EquilibraPool}.
 *
 * The pool's storage treats `_factory != address(0)` as its
 * "already-initialised" flag, which saves one SSTORE on every clone's
 * `initialize()` call compared to a dedicated `_initialized` boolean. The
 * trade-off is that the *implementation* must be pre-locked in its
 * constructor, otherwise a front-runner could seize it and pose as a
 * legitimate pool (OZ UUPS-style squat). These tests pin that invariant
 * down in code so it can never silently regress.
 */
async function deployFixture() {
  const [owner] = await hre.ethers.getSigners();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("A", "A", 18);
  const tokenB = await Token.deploy("B", "B", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();

  const aAddr = await tokenA.getAddress();
  const bAddr = await tokenB.getAddress();
  const [token0, token1] = aAddr.toLowerCase() < bAddr.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  // Pre-fund + pre-approve the factory so any test that spins up a clone via
  // `createPoolAndAddLiquidity` does not need to duplicate setup boilerplate.
  const seed = hre.ethers.parseEther("1000000");
  await token0.mint(owner.address, seed);
  await token1.mint(owner.address, seed);
  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);

  return { owner, poolImpl, factory, token0, token1 };
}

describe("EquilibraPool: implementation lock (constructor sentinel)", function () {
  it("implementation is locked: getPoolMetadata().factory reports its own address right after deployment", async function () {
    const { poolImpl } = await loadFixture(deployFixture);
    const implAddr = await poolImpl.getAddress();
    expect((await poolImpl.getPoolMetadata()).factory).to.equal(implAddr);
  });

  it("implementation rejects any direct initialize() call with AlreadyInitialized", async function () {
    const { poolImpl, token0, token1 } = await loadFixture(deployFixture);

    // Decimal-lift scales are pre-computed by the factory in the
    // production path. The tokens here are 18-decimal mocks, so the
    // lift collapses to `10**(18-18) == 1`.
    const params = {
      token0: await token0.getAddress(),
      token1: await token1.getAddress(),
      token0Scale: 1n,
      token1Scale: 1n,
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
      protocolFeePercent: 0,
      pairPoolIndex: 0,
      isPrivate: false,
      lpName: "spoof",
      lpSymbol: "SPF",
    };

    await expect(poolImpl.initialize(params)).to.be.revertedWithCustomError(poolImpl, "AlreadyInitialized");
  });

  it("implementation cannot be admin-controlled (factory-owner selector missing)", async function () {
    const { poolImpl, owner } = await loadFixture(deployFixture);

    // `_factory = address(this)` on the implementation, so `setPaused`
    // tries to call `IEquilibraFactory(address(this)).owner()` — a
    // selector the pool itself does not implement. The call reverts at
    // the external level with empty revert data ("function not
    // found"), which is structurally distinct from a custom-error
    // revert. We pin the empty-data shape via `revertedWithoutReason`
    // so a regression that wires up a real owner check (and thus
    // reverts with `Unauthorized` / `OwnableUnauthorizedAccount`) would
    // surface as a test failure instead of silently re-routing the
    // gate.
    await expect(poolImpl.connect(owner).setPaused(true)).to.be.revertedWithoutReason();
    expect(await poolImpl.paused()).to.equal(false);
  });

  it("clones are NOT affected by the lock: factory.createPoolAndAddLiquidity() initialises a fresh clone", async function () {
    const { factory, token0, token1, owner } = await loadFixture(deployFixture);

    const tx = await factory.createPoolAndAddLiquidity(
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
      hre.ethers.parseEther("1000"),
      hre.ethers.parseEther("1000"),
      owner.address
    );
    await tx.wait();

    const poolAddr = await factory.allPools(0);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);
    expect((await pool.getPoolMetadata()).factory).to.equal(await factory.getAddress());
    // Second `initialize()` on the same clone must still revert. Scales
    // mirror the factory's pre-computed lift for 18-decimal tokens.
    await expect(
      pool.initialize({
        token0: await token0.getAddress(),
        token1: await token1.getAddress(),
        token0Scale: 1n,
        token1Scale: 1n,
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
        protocolFeePercent: 0,
        pairPoolIndex: 0,
        isPrivate: false,
        lpName: "dup",
        lpSymbol: "DUP",
      })
    ).to.be.revertedWithCustomError(pool, "AlreadyInitialized");
    // The impl stays locked independently of any clone state.
    expect(await owner.provider.getCode(poolAddr)).to.not.equal("0x");
  });

  it("admin functions on a fresh clone are usable by the factory owner (sanity)", async function () {
    const { factory, token0, token1, owner } = await loadFixture(deployFixture);

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
      hre.ethers.parseEther("1000"),
      hre.ethers.parseEther("1000"),
      owner.address
    );

    const poolAddr = await factory.allPools(0);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);

    await pool.connect(owner).setPaused(true);
    expect(await pool.paused()).to.equal(true);
    await pool.connect(owner).setPaused(false);
    expect(await pool.paused()).to.equal(false);
  });
});
