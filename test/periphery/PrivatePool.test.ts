// Private pools: mint-gated pools whose every LP recipient must sit on
// the factory-held allowlist curated by the pool admin. The gate lives
// in the POOL's `addLiquidity` (recipient check), so it covers every
// mint path at one site — router `addLiquidity`, both zap-ins and
// direct pool calls. Exits, swaps, donations and ERC20 LP transfers
// stay ungated. Private pools additionally run the parameter timelock
// on `PRIVATE_DELAY` (10 min) instead of the public `DELAY` (24 h).
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

const CONFIG = {
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

async function deployFixture() {
  const [owner, insider, outsider] = await hre.ethers.getSigners();

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
  const factoryAddr = await factory.getAddress();

  const timelock = await hre.ethers.getContractAt("EquilibraParamTimelock", await factory.paramTimelock());

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const seed = hre.ethers.parseEther("1000");
  for (const signer of [owner, insider, outsider]) {
    await tokenA.mint(signer.address, seed);
    await tokenB.mint(signer.address, seed);
    await tokenA.connect(signer).approve(routerAddr, MaxUint256);
    await tokenB.connect(signer).approve(routerAddr, MaxUint256);
  }
  await tokenA.approve(factoryAddr, MaxUint256);
  await tokenB.approve(factoryAddr, MaxUint256);

  const tokenAAddr = await tokenA.getAddress();
  const tokenBAddr = await tokenB.getAddress();
  await factory.createPrivatePoolAndAddLiquidity(
    tokenAAddr,
    tokenBAddr,
    CONFIG,
    hre.ethers.parseEther("100"),
    hre.ethers.parseEther("100"),
    owner.address
  );
  const poolAddr = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);

  return {
    owner,
    insider,
    outsider,
    tokenA,
    tokenB,
    tokenAAddr,
    tokenBAddr,
    factory,
    timelock,
    router,
    routerAddr,
    pool,
    poolAddr,
  };
}

function addParams(fx: Awaited<ReturnType<typeof deployFixture>>, recipient: string) {
  return {
    tokenA: fx.tokenAAddr,
    tokenB: fx.tokenBAddr,
    poolIndex: 0,
    recipient,
    amountADesired: hre.ethers.parseEther("1"),
    amountBDesired: hre.ethers.parseEther("1"),
    minShares: 0,
    deadline: MaxUint256,
  };
}

describe("Private pools", function () {
  describe("creation", function () {
    it("flags the pool, emits PrivatePoolCreated and allowlists creator + genesis recipient", async function () {
      const fx = await loadFixture(deployFixture);
      expect(await fx.factory.isPrivatePool(fx.poolAddr)).to.equal(true);
      expect(await fx.factory.isLpAllowed(fx.poolAddr, fx.owner.address)).to.equal(true);
      expect(await fx.pool.balanceOf(fx.owner.address)).to.be.greaterThan(0n);

      // A separate genesis recipient is allowlisted alongside the creator.
      const tx = fx.factory.createPrivatePoolAndAddLiquidity(
        fx.tokenAAddr,
        fx.tokenBAddr,
        CONFIG,
        hre.ethers.parseEther("10"),
        hre.ethers.parseEther("10"),
        fx.insider.address
      );
      await expect(tx).to.emit(fx.factory, "PrivatePoolCreated");
      const secondPool = await fx.factory.allPools(1);
      // Exact args: pool + creator-admin, and BOTH genesis allowlist
      // entries (creator, distinct genesis recipient) in one tx.
      await expect(tx).to.emit(fx.factory, "PrivatePoolCreated").withArgs(secondPool, fx.owner.address);
      await expect(tx).to.emit(fx.factory, "PoolLpAllowlistUpdated").withArgs(secondPool, fx.owner.address, true);
      await expect(tx).to.emit(fx.factory, "PoolLpAllowlistUpdated").withArgs(secondPool, fx.insider.address, true);
      expect(await fx.factory.isLpAllowed(secondPool, fx.owner.address)).to.equal(true);
      expect(await fx.factory.isLpAllowed(secondPool, fx.insider.address)).to.equal(true);
    });

    it("public pools stay ungated and refuse allowlist edits", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.factory.createPoolAndAddLiquidity(
        fx.tokenAAddr,
        fx.tokenBAddr,
        CONFIG,
        hre.ethers.parseEther("10"),
        hre.ethers.parseEther("10"),
        fx.owner.address
      );
      const publicPool = await fx.factory.allPools(1);
      expect(await fx.factory.isPrivatePool(publicPool)).to.equal(false);
      // The view is self-contained for integrators: public pools admit
      // everyone, private pools answer from the curated list.
      expect(await fx.factory.isLpAllowed(publicPool, fx.outsider.address)).to.equal(true);
      expect(await fx.factory.isLpAllowed(fx.poolAddr, fx.outsider.address)).to.equal(false);

      // Outsider recipient mints freely on the public pool (poolIndex 1).
      await fx.router.connect(fx.outsider).addLiquidity({
        ...addParams(fx, fx.outsider.address),
        poolIndex: 1,
      });

      await expect(fx.factory.setLpAllowed(publicPool, [fx.outsider.address], true)).to.be.revertedWithCustomError(
        fx.factory,
        "NotPrivatePool"
      );
    });
  });

  describe("mint gate", function () {
    it("rejects a non-allowlisted recipient on every mint path and admits after allowlisting", async function () {
      const fx = await loadFixture(deployFixture);

      // Router addLiquidity: the RECIPIENT is gated (the payer is not).
      await expect(
        fx.router.connect(fx.outsider).addLiquidity(addParams(fx, fx.outsider.address))
      ).to.be.revertedWithCustomError(fx.pool, "LpNotAllowed");
      // An allowlisted payer cannot smuggle shares to an outsider either.
      await expect(
        fx.router.connect(fx.owner).addLiquidity(addParams(fx, fx.outsider.address))
      ).to.be.revertedWithCustomError(fx.pool, "LpNotAllowed");

      // Zap flows go through the same pool-side gate.
      await expect(
        fx.router.connect(fx.outsider).zapInSingleSided({
          tokenIn: fx.tokenAAddr,
          tokenOut: fx.tokenBAddr,
          poolIndex: 0,
          recipient: fx.outsider.address,
          amountIn: hre.ethers.parseEther("1"),
          minLiquidity: 0,
          deadline: MaxUint256,
        })
      ).to.be.revertedWithCustomError(fx.pool, "LpNotAllowed");

      // Imbalanced zap runs its rebalancing swap BEFORE the mint — the
      // gate still fires at the mint and the whole tx (swap included)
      // unwinds atomically: balances and reserves bit-unchanged.
      {
        const balA = await fx.tokenA.balanceOf(fx.outsider.address);
        const balB = await fx.tokenB.balanceOf(fx.outsider.address);
        const [r0, r1] = await fx.pool.getReserves();
        await expect(
          fx.router.connect(fx.outsider).zapInImbalanced({
            tokenA: fx.tokenAAddr,
            tokenB: fx.tokenBAddr,
            poolIndex: 0,
            recipient: fx.outsider.address,
            amountA: hre.ethers.parseEther("2"),
            amountB: 0,
            minLiquidity: 0,
            deadline: MaxUint256,
          })
        ).to.be.revertedWithCustomError(fx.pool, "LpNotAllowed");
        expect(await fx.tokenA.balanceOf(fx.outsider.address)).to.equal(balA);
        expect(await fx.tokenB.balanceOf(fx.outsider.address)).to.equal(balB);
        const [r0After, r1After] = await fx.pool.getReserves();
        expect(r0After).to.equal(r0);
        expect(r1After).to.equal(r1);
      }

      // The direct (non-router) callback path hits the same pool-side
      // gate: the pool checks the recipient before any callback runs.
      const Provider = await hre.ethers.getContractFactory("MockMintCallbackProvider");
      const provider = await Provider.deploy();
      await provider.waitForDeployment();
      const providerAddr = await provider.getAddress();
      await fx.tokenA.connect(fx.outsider).approve(providerAddr, MaxUint256);
      await fx.tokenB.connect(fx.outsider).approve(providerAddr, MaxUint256);
      const amt = hre.ethers.parseEther("1");
      await expect(
        provider.connect(fx.outsider).addLiquidity(fx.poolAddr, amt, amt, 0, fx.outsider.address)
      ).to.be.revertedWithCustomError(fx.pool, "LpNotAllowed");

      await fx.factory.setLpAllowed(fx.poolAddr, [fx.insider.address], true);
      await fx.router.connect(fx.insider).addLiquidity(addParams(fx, fx.insider.address));

      // The gate is recipient-only in BOTH directions: an unallowlisted
      // PAYER may fund an allowlisted recipient.
      const insiderShares = await fx.pool.balanceOf(fx.insider.address);
      await fx.router.connect(fx.outsider).addLiquidity(addParams(fx, fx.insider.address));
      expect(await fx.pool.balanceOf(fx.insider.address)).to.be.greaterThan(insiderShares);

      // And the direct path admits once the recipient is allowlisted.
      await fx.factory.setLpAllowed(fx.poolAddr, [fx.outsider.address], true);
      await provider.connect(fx.outsider).addLiquidity(fx.poolAddr, amt, amt, 0, fx.outsider.address);
      expect(await fx.pool.balanceOf(fx.outsider.address)).to.be.greaterThan(0n);
      await fx.factory.setLpAllowed(fx.poolAddr, [fx.outsider.address], false);
      expect(await fx.pool.balanceOf(fx.insider.address)).to.be.greaterThan(0n);

      // De-listing closes the gate again.
      await fx.factory.setLpAllowed(fx.poolAddr, [fx.insider.address], false);
      await expect(
        fx.router.connect(fx.insider).addLiquidity(addParams(fx, fx.insider.address))
      ).to.be.revertedWithCustomError(fx.pool, "LpNotAllowed");
    });

    it("leaves exits and LP transfers ungated", async function () {
      const fx = await loadFixture(deployFixture);

      // Allowlisted LP hands shares to an outsider — transfers stay free
      // (the gate bounds entry through minting, not secondary custody).
      const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
      await fx.pool.connect(fx.owner).transfer(fx.outsider.address, shares);

      // The outsider can exit through the router without any listing.
      await fx.pool.connect(fx.outsider).approve(fx.routerAddr, MaxUint256);
      const [a, b] = await fx.router.connect(fx.outsider).removeLiquidity.staticCall({
        tokenA: fx.tokenAAddr,
        tokenB: fx.tokenBAddr,
        poolIndex: 0,
        shares,
        amountAMin: 0,
        amountBMin: 0,
        recipient: fx.outsider.address,
        deadline: MaxUint256,
      });
      await fx.router.connect(fx.outsider).removeLiquidity({
        tokenA: fx.tokenAAddr,
        tokenB: fx.tokenBAddr,
        poolIndex: 0,
        shares,
        amountAMin: a,
        amountBMin: b,
        recipient: fx.outsider.address,
        deadline: MaxUint256,
      });
      expect(await fx.pool.balanceOf(fx.outsider.address)).to.equal(0n);
    });

    it("leaves donations ungated: an outsider can park LP into the buffer", async function () {
      const fx = await loadFixture(deployFixture);

      // The outsider receives shares by transfer and donates them via
      // the router — both legs are transfers, not mints, so neither
      // consults the allowlist.
      const shares = (await fx.pool.balanceOf(fx.owner.address)) / 20n;
      await fx.pool.connect(fx.owner).transfer(fx.outsider.address, shares);
      await fx.pool.connect(fx.outsider).approve(fx.routerAddr, shares);
      await fx.router.connect(fx.outsider).donate(fx.tokenAAddr, fx.tokenBAddr, 0, shares, MaxUint256, MaxUint256);
      expect(await fx.pool.balanceOf(fx.poolAddr)).to.equal(shares);
    });
  });

  describe("allowlist administration", function () {
    it("batch add/remove with events; only the pool admin may edit", async function () {
      const fx = await loadFixture(deployFixture);

      await expect(
        fx.factory.connect(fx.owner).setLpAllowed(fx.poolAddr, [fx.insider.address, fx.outsider.address], true)
      )
        .to.emit(fx.factory, "PoolLpAllowlistUpdated")
        .withArgs(fx.poolAddr, fx.insider.address, true);
      expect(await fx.factory.isLpAllowed(fx.poolAddr, fx.outsider.address)).to.equal(true);

      await expect(
        fx.factory.connect(fx.insider).setLpAllowed(fx.poolAddr, [fx.insider.address], true)
      ).to.be.revertedWithCustomError(fx.factory, "NotPoolAdmin");
    });

    it("exposes the raw membership list via getLpAllowlist (unordered)", async function () {
      const fx = await loadFixture(deployFixture);
      // Genesis with creator == recipient seeds exactly one entry.
      expect(await fx.factory.getLpAllowlistLength(fx.poolAddr)).to.equal(1n);
      expect(await fx.factory.getLpAllowlist(fx.poolAddr)).to.deep.equal([fx.owner.address]);

      await fx.factory.connect(fx.owner).setLpAllowed(fx.poolAddr, [fx.insider.address, fx.outsider.address], true);
      // Re-adding an existing member must not duplicate the entry.
      await fx.factory.connect(fx.owner).setLpAllowed(fx.poolAddr, [fx.insider.address], true);
      expect(await fx.factory.getLpAllowlistLength(fx.poolAddr)).to.equal(3n);
      expect([...(await fx.factory.getLpAllowlist(fx.poolAddr))].sort()).to.deep.equal(
        [fx.owner.address, fx.insider.address, fx.outsider.address].sort()
      );

      await fx.factory.connect(fx.owner).setLpAllowed(fx.poolAddr, [fx.owner.address], false);
      expect(await fx.factory.getLpAllowlistLength(fx.poolAddr)).to.equal(2n);
      expect(await fx.factory.isLpAllowed(fx.poolAddr, fx.owner.address)).to.equal(false);
      expect([...(await fx.factory.getLpAllowlist(fx.poolAddr))].sort()).to.deep.equal(
        [fx.insider.address, fx.outsider.address].sort()
      );

      // Public pools: the raw list stays empty while the policy admits
      // everyone — the pair of views distinguishes "allowed because
      // public" from "explicitly allowlisted".
      await fx.factory.createPoolAndAddLiquidity(
        fx.tokenAAddr,
        fx.tokenBAddr,
        CONFIG,
        hre.ethers.parseEther("10"),
        hre.ethers.parseEther("10"),
        fx.owner.address
      );
      const publicPool = await fx.factory.allPools(1);
      expect(await fx.factory.getLpAllowlistLength(publicPool)).to.equal(0n);
      expect(await fx.factory.getLpAllowlist(publicPool)).to.deep.equal([]);
      expect(await fx.factory.isLpAllowed(publicPool, fx.outsider.address)).to.equal(true);
    });

    it("follows the timelock's two-step admin handover", async function () {
      const fx = await loadFixture(deployFixture);

      await fx.timelock.connect(fx.owner).nominatePoolAdmin(fx.poolAddr, fx.insider.address);
      await fx.timelock.connect(fx.insider).acceptPoolAdmin(fx.poolAddr);

      // The allowlist authority moved with the role — no second registry.
      await expect(
        fx.factory.connect(fx.owner).setLpAllowed(fx.poolAddr, [fx.outsider.address], true)
      ).to.be.revertedWithCustomError(fx.factory, "NotPoolAdmin");
      await fx.factory.connect(fx.insider).setLpAllowed(fx.poolAddr, [fx.outsider.address], true);
      expect(await fx.factory.isLpAllowed(fx.poolAddr, fx.outsider.address)).to.equal(true);
    });

    it("renouncing the admin freezes the allowlist forever", async function () {
      const fx = await loadFixture(deployFixture);

      await fx.timelock.connect(fx.owner).renouncePoolAdmin(fx.poolAddr);

      // poolAdmin is zero now — nobody, including the former admin, can
      // curate the list; membership is frozen at its current state.
      await expect(
        fx.factory.connect(fx.owner).setLpAllowed(fx.poolAddr, [fx.insider.address], true)
      ).to.be.revertedWithCustomError(fx.factory, "NotPoolAdmin");
    });
  });

  describe("parameter timelock delay", function () {
    it("private pools execute after PRIVATE_DELAY (10 min), not the public 24 h", async function () {
      const fx = await loadFixture(deployFixture);

      await fx.timelock.connect(fx.owner).queueFeeParams(fx.poolAddr, 40, 0, 20);
      // Too early: one minute in.
      await time.increase(60);
      await expect(fx.timelock.connect(fx.owner).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotReady"
      );
      // Past the short window: executes without waiting a day.
      await time.increase(10 * 60);
      await fx.timelock.connect(fx.owner).executeFeeParams(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).baseFee).to.equal(40);
    });

    it("public pools keep the full 24 h delay", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.factory.createPoolAndAddLiquidity(
        fx.tokenAAddr,
        fx.tokenBAddr,
        CONFIG,
        hre.ethers.parseEther("10"),
        hre.ethers.parseEther("10"),
        fx.owner.address
      );
      const publicPool = await fx.factory.allPools(1);

      await fx.timelock.connect(fx.owner).queueFeeParams(publicPool, 40, 0, 20);
      await time.increase(11 * 60);
      await expect(fx.timelock.connect(fx.owner).executeFeeParams(publicPool)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotReady"
      );
      await time.increase(24 * 3600);
      await fx.timelock.connect(fx.owner).executeFeeParams(publicPool);
    });

    it("private queue eta boundaries: eta-1 not ready, eta executes, eta+GRACE+1 expired", async function () {
      const fx = await loadFixture(deployFixture);
      const stepWad = hre.ethers.parseUnits("2", 15);

      await fx.timelock.connect(fx.owner).queueRepegStep(fx.poolAddr, stepWad);
      let eta = (await fx.timelock.pendingRepegStep(fx.poolAddr)).eta;

      // One second BEFORE eta the change is not ready...
      await time.setNextBlockTimestamp(eta - 1n);
      await expect(fx.timelock.connect(fx.owner).executeRepegStep(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotReady"
      );
      // ...and one second past the grace window it is expired for good.
      const grace = await fx.timelock.GRACE_PERIOD();
      await time.setNextBlockTimestamp(eta + grace + 1n);
      await expect(fx.timelock.connect(fx.owner).executeRepegStep(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeExpired"
      );

      // Re-queue: execution EXACTLY at eta passes (equality is ready).
      await fx.timelock.connect(fx.owner).queueRepegStep(fx.poolAddr, stepWad);
      eta = (await fx.timelock.pendingRepegStep(fx.poolAddr)).eta;
      await time.setNextBlockTimestamp(eta);
      await fx.timelock.connect(fx.owner).executeRepegStep(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).repegStepWad).to.equal(stepWad);
    });
  });
});
