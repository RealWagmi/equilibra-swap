import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;
const SEED = hre.ethers.parseEther("100000");

function makeConfig() {
  return {
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
  };
}

async function deployFixture() {
  const [owner, creator, stranger] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const t0 = await Token.deploy("Token0", "TK0", 18);
  const t1 = await Token.deploy("Token1", "TK1", 18);
  await t0.waitForDeployment();
  await t1.waitForDeployment();

  const poolImpl = await (await hre.ethers.getContractFactory("EquilibraPool")).deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  const trader = await (await hre.ethers.getContractFactory("MockSwapCallbackTrader")).deploy();
  await trader.waitForDeployment();

  for (const t of [t0, t1]) {
    await t.mint(creator.address, SEED * 10n);
    await t.mint(await trader.getAddress(), SEED);
    await t.connect(creator).approve(factoryAddr, MaxUint256);
  }

  // One pool created before deprecation.
  await factory
    .connect(creator)
    .createPoolAndAddLiquidity(await t0.getAddress(), await t1.getAddress(), makeConfig(), SEED, SEED, creator.address);
  const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));

  return { owner, creator, stranger, t0, t1, factory, pool, trader };
}

describe("EquilibraFactory: deprecation (permanent creation stop)", function () {
  it("starts non-deprecated and creates pools normally", async function () {
    const { factory, creator, t0, t1 } = await loadFixture(deployFixture);
    expect(await factory.deprecated()).to.equal(false);
    await expect(
      factory
        .connect(creator)
        .createPoolAndAddLiquidity(
          await t0.getAddress(),
          await t1.getAddress(),
          makeConfig(),
          SEED,
          SEED,
          creator.address
        )
    ).to.not.be.reverted;
    expect(await factory.allPoolsLength()).to.equal(2n);
  });

  it("only the owner can deprecate (non-owner reverts with OwnableUnauthorizedAccount)", async function () {
    const { factory, stranger, creator } = await loadFixture(deployFixture);
    await expect(factory.connect(stranger).deprecateFactory()).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );
    await expect(factory.connect(creator).deprecateFactory()).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );
    expect(await factory.deprecated()).to.equal(false);
  });

  it("flips the flag once, emits FactoryDeprecated and rejects a second call", async function () {
    const { factory, owner } = await loadFixture(deployFixture);
    await expect(factory.connect(owner).deprecateFactory())
      .to.emit(factory, "FactoryDeprecated")
      .withArgs(owner.address);
    expect(await factory.deprecated()).to.equal(true);
    await expect(factory.connect(owner).deprecateFactory()).to.be.revertedWithCustomError(factory, "FactoryDeprecated");
    expect(await factory.deprecated()).to.equal(true);
  });

  it("blocks both create entrypoints after deprecation", async function () {
    const { factory, owner, creator, t0, t1 } = await loadFixture(deployFixture);
    await factory.connect(owner).deprecateFactory();

    const a = await t0.getAddress();
    const b = await t1.getAddress();
    await expect(
      factory.connect(creator).createPoolAndAddLiquidity(a, b, makeConfig(), SEED, SEED, creator.address)
    ).to.be.revertedWithCustomError(factory, "FactoryDeprecated");
    await expect(
      factory.connect(creator).createPrivatePoolAndAddLiquidity(a, b, makeConfig(), SEED, SEED, creator.address)
    ).to.be.revertedWithCustomError(factory, "FactoryDeprecated");
    // The deprecation gate runs before config validation: an invalid config still surfaces the
    // deprecation, so callers see one deterministic error.
    await expect(
      factory
        .connect(creator)
        .createPoolAndAddLiquidity(a, b, { ...makeConfig(), baseFee: 0 }, SEED, SEED, creator.address)
    ).to.be.revertedWithCustomError(factory, "FactoryDeprecated");
    expect(await factory.allPoolsLength()).to.equal(1n);
  });

  it("leaves existing pools, registries and the admin surface working", async function () {
    const { factory, owner, creator, t0, t1, pool, trader } = await loadFixture(deployFixture);
    await factory.connect(owner).deprecateFactory();

    const a = await t0.getAddress();
    const b = await t1.getAddress();
    const poolAddr = await pool.getAddress();

    // Swaps on the pre-existing pool keep working.
    await time.increase(12);
    const [r0Before] = await pool.getReserves();
    await trader.executeSwap(poolAddr, owner.address, true, hre.ethers.parseEther("1"), 0);
    const [r0After] = await pool.getReserves();
    expect(r0After).to.be.gt(r0Before);

    // LPs can still exit.
    const shares = await pool.balanceOf(creator.address);
    await expect(pool.connect(creator).removeLiquidity(shares / 10n, 0, 0, creator.address)).to.not.be.reverted;

    // Registries and views are intact.
    expect(await factory.getPoolCountForPair(a, b)).to.equal(1n);
    expect(await factory.getPoolsByCreator(creator.address)).to.deep.equal([poolAddr]);
    expect(await factory.computePoolAddress(a, b, 0)).to.equal(poolAddr);

    // Owner administration of existing pools is unaffected.
    await expect(factory.connect(owner).addPoolToWhitelist(a, b, poolAddr)).to.not.be.reverted;
    expect(await factory.isPoolWhitelisted(a, b, poolAddr)).to.equal(true);
    await expect(factory.connect(owner).setProtocolFee(5)).to.not.be.reverted;
    await expect(pool.connect(owner).setPaused(true, false)).to.not.be.reverted;
    await expect(pool.connect(owner).setPaused(false, false)).to.not.be.reverted;
  });
});
