import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

// 18/18-decimals pair at a WETH-like price so the genesis vp precision
// gate is comfortably satisfied.
const SEED_WETH = hre.ethers.parseEther("100");
const SEED_TOKEN = hre.ethers.parseEther("400000");

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

describe("FactoryNativeSeed", function () {
  async function deployFixture() {
    const [owner, creator, recipient] = await hre.ethers.getSigners();

    const Weth = await hre.ethers.getContractFactory("MockWETH9");
    const weth = await Weth.deploy();
    await weth.waitForDeployment();
    const wethAddr = (await weth.getAddress()).toLowerCase();

    // One mock token on each side of the WETH9 address so both sorted
    // layouts (WETH = token0 and WETH = token1) are exercised.
    const Token = await hre.ethers.getContractFactory("MockERC20");
    let below: any = null;
    let above: any = null;
    for (let i = 0; below === null || above === null; i++) {
      if (i > 40) throw new Error("no mock token addresses on both sides of WETH9");
      const t = await Token.deploy(`Mock${i}`, `MK${i}`, 18);
      await t.waitForDeployment();
      const addr = (await t.getAddress()).toLowerCase();
      if (addr < wethAddr && below === null) below = t;
      else if (addr > wethAddr && above === null) above = t;
    }

    const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
    const poolImpl = await PoolImpl.deploy();
    await poolImpl.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
    const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, await weth.getAddress(), 0);
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();

    for (const t of [below, above]) {
      await t.mint(creator.address, SEED_TOKEN * 4n);
      await t.connect(creator).approve(factoryAddr, MaxUint256);
    }

    return { owner, creator, recipient, weth, below, above, factory, factoryAddr };
  }

  async function expectNoResidue(fx: Awaited<ReturnType<typeof deployFixture>>) {
    expect(await hre.ethers.provider.getBalance(fx.factoryAddr)).to.equal(0n);
    expect(await fx.weth.balanceOf(fx.factoryAddr)).to.equal(0n);
  }

  it("stores the immutable WETH9 address", async function () {
    const fx = await loadFixture(deployFixture);
    expect(await fx.factory.WETH9()).to.equal(await fx.weth.getAddress());
  });

  it("seeds the WETH side from attached native value (WETH = token0)", async function () {
    const fx = await loadFixture(deployFixture);
    // `above` sorts after WETH, so the sorted pair puts WETH in slot 0.
    await fx.factory
      .connect(fx.creator)
      .createPoolAndAddLiquidity(
        await fx.weth.getAddress(),
        await fx.above.getAddress(),
        makeConfig(),
        SEED_WETH,
        SEED_TOKEN,
        fx.recipient.address,
        { value: SEED_WETH }
      );

    const poolAddr = await fx.factory.allPools(0);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);
    expect((await pool.getPoolMetadata()).token0).to.equal(await fx.weth.getAddress());
    expect(await fx.weth.balanceOf(poolAddr)).to.equal(SEED_WETH);
    expect(await fx.above.balanceOf(poolAddr)).to.equal(SEED_TOKEN);
    expect(await pool.balanceOf(fx.recipient.address)).to.be.gt(0n);
    await expectNoResidue(fx);
    // The creator held no WETH and granted the factory no WETH
    // approval — the leg was funded entirely from `msg.value`.
    expect(await fx.weth.balanceOf(fx.creator.address)).to.equal(0n);
    expect(await fx.weth.allowance(fx.creator.address, fx.factoryAddr)).to.equal(0n);
  });

  it("seeds the WETH side from attached native value (WETH = token1)", async function () {
    const fx = await loadFixture(deployFixture);
    // `below` sorts before WETH, so the sorted pair puts WETH in slot 1.
    await fx.factory
      .connect(fx.creator)
      .createPoolAndAddLiquidity(
        await fx.below.getAddress(),
        await fx.weth.getAddress(),
        makeConfig(),
        SEED_TOKEN,
        SEED_WETH,
        fx.recipient.address,
        { value: SEED_WETH }
      );

    const poolAddr = await fx.factory.allPools(0);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);
    expect((await pool.getPoolMetadata()).token1).to.equal(await fx.weth.getAddress());
    expect(await fx.weth.balanceOf(poolAddr)).to.equal(SEED_WETH);
    expect(await fx.below.balanceOf(poolAddr)).to.equal(SEED_TOKEN);
    expect(await pool.balanceOf(fx.recipient.address)).to.be.gt(0n);
    await expectNoResidue(fx);
  });

  it("seeds a private pool from native value and keeps the allowlist wiring", async function () {
    const fx = await loadFixture(deployFixture);
    await fx.factory
      .connect(fx.creator)
      .createPrivatePoolAndAddLiquidity(
        await fx.weth.getAddress(),
        await fx.above.getAddress(),
        makeConfig(),
        SEED_WETH,
        SEED_TOKEN,
        fx.recipient.address,
        { value: SEED_WETH }
      );

    const poolAddr = await fx.factory.allPools(0);
    expect(await fx.factory.isPrivatePool(poolAddr)).to.equal(true);
    expect(await fx.factory.isLpAllowed(poolAddr, fx.creator.address)).to.equal(true);
    expect(await fx.factory.isLpAllowed(poolAddr, fx.recipient.address)).to.equal(true);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);
    expect(await pool.balanceOf(fx.recipient.address)).to.be.gt(0n);
    await expectNoResidue(fx);
  });

  it("reverts NativeValueMismatch when msg.value is not exactly the WETH-side amount", async function () {
    const fx = await loadFixture(deployFixture);
    for (const value of [SEED_WETH - 1n, SEED_WETH + 1n]) {
      await expect(
        fx.factory
          .connect(fx.creator)
          .createPoolAndAddLiquidity(
            await fx.weth.getAddress(),
            await fx.above.getAddress(),
            makeConfig(),
            SEED_WETH,
            SEED_TOKEN,
            fx.recipient.address,
            { value }
          )
      ).to.be.revertedWithCustomError(fx.factory, "NativeValueMismatch");
    }
  });

  it("reverts NoWethLeg when value is attached but neither token is WETH9", async function () {
    const fx = await loadFixture(deployFixture);
    await expect(
      fx.factory
        .connect(fx.creator)
        .createPoolAndAddLiquidity(
          await fx.below.getAddress(),
          await fx.above.getAddress(),
          makeConfig(),
          SEED_TOKEN,
          SEED_TOKEN,
          fx.recipient.address,
          { value: 1n }
        )
    ).to.be.revertedWithCustomError(fx.factory, "NoWethLeg");
  });

  it("unwinds a native seed atomically when the other leg's pull fails", async function () {
    const fx = await loadFixture(deployFixture);
    // `recipient` has granted the factory no approvals: the WETH leg
    // is already wrapped when the other leg's transferFrom fails, so
    // only transaction atomicity returns the attached value.
    await expect(
      fx.factory
        .connect(fx.recipient)
        .createPoolAndAddLiquidity(
          await fx.weth.getAddress(),
          await fx.above.getAddress(),
          makeConfig(),
          SEED_WETH,
          SEED_TOKEN,
          fx.recipient.address,
          { value: SEED_WETH }
        )
    ).to.be.reverted;
    expect(await fx.factory.allPoolsLength()).to.equal(0n);
    await expectNoResidue(fx);
  });

  it("pays the seed by amount, not by balance: stray WETH on the factory stays put", async function () {
    const fx = await loadFixture(deployFixture);
    const stray = hre.ethers.parseEther("5") + 1n;
    await fx.weth.connect(fx.creator).deposit({ value: stray });
    await fx.weth.connect(fx.creator).transfer(fx.factoryAddr, stray);

    await fx.factory
      .connect(fx.creator)
      .createPoolAndAddLiquidity(
        await fx.weth.getAddress(),
        await fx.above.getAddress(),
        makeConfig(),
        SEED_WETH,
        SEED_TOKEN,
        fx.recipient.address,
        { value: SEED_WETH }
      );

    const poolAddr = await fx.factory.allPools(0);
    // Exactly the declared amount reaches the pool; the stray neither
    // leaks into the genesis reserves nor blocks creation.
    expect(await fx.weth.balanceOf(poolAddr)).to.equal(SEED_WETH);
    expect(await fx.weth.balanceOf(fx.factoryAddr)).to.equal(stray);
    expect(await hre.ethers.provider.getBalance(fx.factoryAddr)).to.equal(0n);
  });

  it("reverts NativeValueMismatch when the WETH-side declared amount is zero", async function () {
    const fx = await loadFixture(deployFixture);
    for (const create of ["createPoolAndAddLiquidity", "createPrivatePoolAndAddLiquidity"] as const) {
      await expect(
        (fx.factory.connect(fx.creator) as any)[create](
          await fx.weth.getAddress(),
          await fx.above.getAddress(),
          makeConfig(),
          0n,
          SEED_TOKEN,
          fx.recipient.address,
          { value: hre.ethers.parseEther("1") }
        )
      ).to.be.revertedWithCustomError(fx.factory, "NativeValueMismatch");
    }
  });

  it("emits the unchanged creation events on the native path", async function () {
    const fx = await loadFixture(deployFixture);
    const wethAddr = await fx.weth.getAddress();
    const aboveAddr = await fx.above.getAddress();
    const predicted = await fx.factory.computePoolAddress(wethAddr, aboveAddr, 0);

    const tx = fx.factory
      .connect(fx.creator)
      .createPrivatePoolAndAddLiquidity(
        wethAddr,
        aboveAddr,
        makeConfig(),
        SEED_WETH,
        SEED_TOKEN,
        fx.recipient.address,
        { value: SEED_WETH }
      );

    await expect(tx)
      .to.emit(fx.factory, "PoolCreated")
      .withArgs(wethAddr, aboveAddr, predicted, fx.creator.address, 0, 1, anyValue)
      .and.to.emit(fx.factory, "PrivatePoolCreated")
      .withArgs(predicted, fx.creator.address)
      .and.to.emit(fx.factory, "PoolLpAllowlistUpdated")
      .withArgs(predicted, fx.creator.address, true)
      .and.to.emit(fx.factory, "PoolLpAllowlistUpdated")
      .withArgs(predicted, fx.recipient.address, true)
      // Solady's WETH emits no Deposit event — the wrap surfaces as
      // the mint Transfer from the zero address to the factory.
      .and.to.emit(fx.weth, "Transfer")
      .withArgs(hre.ethers.ZeroAddress, fx.factoryAddr, SEED_WETH);
  });

  it("keeps the pure ERC-20 path with msg.value == 0 (WETH via approval)", async function () {
    const fx = await loadFixture(deployFixture);
    await fx.weth.connect(fx.creator).deposit({ value: SEED_WETH });
    await fx.weth.connect(fx.creator).approve(fx.factoryAddr, MaxUint256);

    await fx.factory
      .connect(fx.creator)
      .createPoolAndAddLiquidity(
        await fx.weth.getAddress(),
        await fx.above.getAddress(),
        makeConfig(),
        SEED_WETH,
        SEED_TOKEN,
        fx.recipient.address
      );

    const poolAddr = await fx.factory.allPools(0);
    expect(await fx.weth.balanceOf(poolAddr)).to.equal(SEED_WETH);
    expect(await fx.weth.balanceOf(fx.creator.address)).to.equal(0n);
    await expectNoResidue(fx);
  });
});
