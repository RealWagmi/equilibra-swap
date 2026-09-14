import { expect } from "chai";
import hre from "hardhat";
import {
  impersonateAccount,
  loadFixture,
  setBalance,
  stopImpersonatingAccount,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { MaxUint256, Signer } from "ethers";

// Runtime-safe parameter administration through EquilibraParamTimelock:
// creator-admin under a 24h delay, 7d grace, policy band on the repeg
// share, and timelock-side validation of every factory invariant at
// queue time and again at execution time (pool setters are bare stores).

const WAD = 10n ** 18n;
const DAY = 24 * 3600;

const POOL_CONFIG = {
  aWad: 8n * 10n ** 17n,
  lambdaWad: 5n * 10n ** 16n,
  baseFee: 100,
  emaPeriod: 600,
  repegStepWad: 5n * 10n ** 15n,
  repegThresholdToken1UpWad: 3n * 10n ** 15n,
  repegThresholdToken1DownWad: 3n * 10n ** 15n,
  feeRampBps: 1000,
  feeFloorBps: 60,
  repegShareBps: 5000,
};

async function deployTimelockFixture(
  repegShareBps = POOL_CONFIG.repegShareBps,
  overrides: Partial<typeof POOL_CONFIG> = {}
) {
  const [owner, creator, stranger] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const usdt: any = await Token.deploy("Tether USD", "USDT", 6);
  const weth: any = await Token.deploy("Wrapped Ether", "WETH", 18);
  await usdt.waitForDeployment();
  await weth.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(
    await poolImpl.getAddress(),
    await owner.getAddress(),
    await owner.getAddress(),
    0
  );
  await factory.waitForDeployment();
  // Non-zero protocol fee so the repeg-share prescale round-trip and
  // the budget cap are exercised with a live gross-up.
  await factory.setProtocolFee(10);

  const timelock: any = await hre.ethers.getContractAt("EquilibraParamTimelock", await factory.paramTimelock());

  const Weth9 = await hre.ethers.getContractFactory("MockWETH9");
  const weth9: any = await Weth9.deploy();
  await weth9.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(
    await factory.getAddress(),
    await poolImpl.getAddress(),
    await weth9.getAddress()
  );
  await router.waitForDeployment();

  // Seed liquidity: 3M USDT against 1000 WETH (price 3000).
  const usdtSeed = 3_000_000n * 10n ** 6n;
  const wethSeed = 1_000n * WAD;
  for (const signer of [owner, creator, stranger]) {
    const addr = await signer.getAddress();
    await usdt.mint(addr, usdtSeed * 100n);
    await weth.mint(addr, wethSeed * 100n);
  }
  await usdt.connect(creator).approve(await factory.getAddress(), MaxUint256);
  await weth.connect(creator).approve(await factory.getAddress(), MaxUint256);

  const usdtAddr = await usdt.getAddress();
  const wethAddr = await weth.getAddress();
  const usdtIsToken0 = usdtAddr.toLowerCase() < wethAddr.toLowerCase();
  const token0 = usdtIsToken0 ? usdtAddr : wethAddr;
  const token1 = usdtIsToken0 ? wethAddr : usdtAddr;
  const amount0 = usdtIsToken0 ? usdtSeed : wethSeed;
  const amount1 = usdtIsToken0 ? wethSeed : usdtSeed;

  await factory
    .connect(creator)
    .createPoolAndAddLiquidity(
      token0,
      token1,
      { ...POOL_CONFIG, ...overrides, repegShareBps },
      amount0,
      amount1,
      await creator.getAddress()
    );
  const poolAddr = await factory.allPools(0);
  const pool: any = await hre.ethers.getContractAt("EquilibraPool", poolAddr);

  for (const signer of [owner, creator, stranger]) {
    await usdt.connect(signer).approve(await router.getAddress(), MaxUint256);
    await weth.connect(signer).approve(await router.getAddress(), MaxUint256);
  }

  return {
    owner,
    creator,
    stranger,
    usdt,
    weth,
    usdtAddr,
    wethAddr,
    factory,
    timelock,
    router,
    pool,
    poolAddr,
  };
}

describe("EquilibraParamTimelock", function () {
  for (const increaseStep of [true, false]) {
    it(`repairs a factory-created band above the step by ${increaseStep ? "raising the step" : "lowering the bands"}`, async () => {
      const step = POOL_CONFIG.repegStepWad;
      const band = step * 2n;
      const fx = await deployTimelockFixture(5000, {
        repegThresholdToken1UpWad: band,
        repegThresholdToken1DownWad: band,
      });
      const before = await fx.pool.getFeeConfig();
      expect(before.repegThresholdToken1UpWad).to.be.gt(before.repegStepWad);
      if (increaseStep) await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, band);
      else await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, step, step);
      expect(await fx.pool.getFeeConfig()).to.deep.equal(before);
      await time.increase(DAY + 1);
      if (increaseStep) await fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr);
      else await fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr);
      const after = await fx.pool.getFeeConfig();
      expect(after.repegThresholdToken1UpWad).to.equal(after.repegStepWad);
      expect(after.repegThresholdToken1DownWad).to.equal(after.repegStepWad);
    });
  }

  describe("wiring and access control", function () {
    it("factory deploys the timelock and registers the creator as pool admin", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      expect(await fx.timelock.factory()).to.equal(await fx.factory.getAddress());
      expect(await fx.timelock.poolAdmin(fx.poolAddr)).to.equal(await fx.creator.getAddress());
    });

    it("pool setters reject every caller except the timelock", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      for (const signer of [fx.owner, fx.creator, fx.stranger]) {
        await expect(fx.pool.connect(signer).setFeeParams(100, 1000, 60)).to.be.revertedWithCustomError(
          fx.pool,
          "NotParamTimelock"
        );
        await expect(fx.pool.connect(signer).setRepegStepWad(10n ** 15n)).to.be.revertedWithCustomError(
          fx.pool,
          "NotParamTimelock"
        );
        await expect(fx.pool.connect(signer).setRepegShareBps(7000)).to.be.revertedWithCustomError(
          fx.pool,
          "NotParamTimelock"
        );
        await expect(fx.pool.connect(signer).setParachuteBandMult(31)).to.be.revertedWithCustomError(
          fx.pool,
          "NotParamTimelock"
        );
      }
    });

    it("only the pool admin can queue/cancel; only the factory can register", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await expect(
        fx.timelock.connect(fx.stranger).queueFeeParams(fx.poolAddr, 100, 1000, 60)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
      // The factory owner holds no special power over pool params.
      await expect(fx.timelock.connect(fx.owner).queueRepegStep(fx.poolAddr, 10n ** 15n)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPoolAdmin"
      );
      await expect(
        fx.timelock.connect(fx.stranger).registerPool(fx.poolAddr, await fx.stranger.getAddress())
      ).to.be.revertedWithCustomError(fx.timelock, "NotFactory");
    });

    it("two-step admin handover: nominee must accept; old admin keeps control until then", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const strangerAddr = await fx.stranger.getAddress();
      // Nominate only — control does NOT move yet.
      await expect(fx.timelock.connect(fx.creator).nominatePoolAdmin(fx.poolAddr, strangerAddr))
        .to.emit(fx.timelock, "PoolAdminNominated")
        .withArgs(fx.poolAddr, strangerAddr);
      expect(await fx.timelock.poolAdmin(fx.poolAddr)).to.equal(await fx.creator.getAddress());
      // Old admin still governs; nominee cannot yet.
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 4n * 10n ** 15n);
      await expect(
        fx.timelock.connect(fx.stranger).queueRepegStep(fx.poolAddr, 10n ** 15n)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
      // A non-nominee cannot accept.
      await expect(fx.timelock.connect(fx.owner).acceptPoolAdmin(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPendingPoolAdmin"
      );
      // Nominee accepts -> control moves, nomination cleared, old admin locked out.
      const acceptTx = fx.timelock.connect(fx.stranger).acceptPoolAdmin(fx.poolAddr);
      await expect(acceptTx).to.emit(fx.timelock, "PoolAdminNominated").withArgs(fx.poolAddr, hre.ethers.ZeroAddress);
      await expect(acceptTx).to.emit(fx.timelock, "PoolAdminSet").withArgs(fx.poolAddr, strangerAddr);
      expect(await fx.timelock.poolAdmin(fx.poolAddr)).to.equal(strangerAddr);
      expect(await fx.timelock.pendingPoolAdmin(fx.poolAddr)).to.equal(hre.ethers.ZeroAddress);
      await expect(
        fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 10n ** 15n)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");

      // Renounce still one-step and terminal.
      await expect(fx.timelock.connect(fx.stranger).renouncePoolAdmin(fx.poolAddr)).to.not.emit(
        fx.timelock,
        "PoolAdminNominated"
      );
      expect(await fx.timelock.poolAdmin(fx.poolAddr)).to.equal(hre.ethers.ZeroAddress);
      await expect(
        fx.timelock.connect(fx.stranger).queueFeeParams(fx.poolAddr, 100, 1000, 60)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
    });

    it("renounce after nominate keeps the pool frozen (stale nominee cannot un-freeze)", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const strangerAddr = await fx.stranger.getAddress();
      await fx.timelock.connect(fx.creator).nominatePoolAdmin(fx.poolAddr, strangerAddr);
      // Renounce clears the nomination too, so the pending nominee cannot
      // later accept and resurrect administration of a frozen pool.
      await expect(fx.timelock.connect(fx.creator).renouncePoolAdmin(fx.poolAddr))
        .to.emit(fx.timelock, "PoolAdminNominated")
        .withArgs(fx.poolAddr, hre.ethers.ZeroAddress);
      expect(await fx.timelock.pendingPoolAdmin(fx.poolAddr)).to.equal(hre.ethers.ZeroAddress);
      await expect(fx.timelock.connect(fx.stranger).acceptPoolAdmin(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPendingPoolAdmin"
      );
      expect(await fx.timelock.poolAdmin(fx.poolAddr)).to.equal(hre.ethers.ZeroAddress);
    });

    it("accept clears inherited pendings; nomination can be cancelled with address(0)", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const strangerAddr = await fx.stranger.getAddress();
      // Cancel a nomination.
      await fx.timelock.connect(fx.creator).nominatePoolAdmin(fx.poolAddr, strangerAddr);
      await fx.timelock.connect(fx.creator).nominatePoolAdmin(fx.poolAddr, hre.ethers.ZeroAddress);
      await expect(fx.timelock.connect(fx.stranger).acceptPoolAdmin(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPendingPoolAdmin"
      );
      // Queue a change, hand over, and confirm the incoming admin starts clean.
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 150, 500, 80);
      await fx.timelock.connect(fx.creator).nominatePoolAdmin(fx.poolAddr, strangerAddr);
      await fx.timelock.connect(fx.stranger).acceptPoolAdmin(fx.poolAddr);
      await time.increase(DAY + 1);
      // The outgoing admin lost the role entirely; the incoming admin
      // finds the inherited queue cleared.
      await expect(fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPoolAdmin"
      );
      await expect(fx.timelock.connect(fx.stranger).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );
    });

    it("renounce clears the pending queue — frozen means frozen", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 150, 500, 80);
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 4n * 10n ** 15n);
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, 4n * 10n ** 15n, 4n * 10n ** 15n);
      await expect(fx.timelock.connect(fx.creator).renouncePoolAdmin(fx.poolAddr)).to.emit(
        fx.timelock,
        "ChangeCancelled"
      );
      await time.increase(DAY + 1);
      // Renounce leaves nobody holding the role — every execute path is
      // locked — AND the pending queue itself was cleared on the way out.
      for (const fn of ["executeFeeParams", "executeRepegStep", "executeRepegThresholds"] as const) {
        await expect(fx.timelock.connect(fx.creator)[fn](fx.poolAddr)).to.be.revertedWithCustomError(
          fx.timelock,
          "NotPoolAdmin"
        );
      }
      expect((await fx.timelock.pendingFeeParams(fx.poolAddr)).eta).to.equal(0n);
      expect((await fx.timelock.pendingRepegStep(fx.poolAddr)).eta).to.equal(0n);
      expect((await fx.timelock.pendingRepegThresholds(fx.poolAddr)).eta).to.equal(0n);
    });
  });

  describe("queue / execute / cancel lifecycle", function () {
    it("fee change executes only after the delay and applies exactly", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 150, 500, 80);

      await expect(fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotReady"
      );

      await time.increase(DAY + 1);
      // Execution is admin-gated like queue and cancel — a stranger
      // cannot push the announced change over the line.
      await expect(fx.timelock.connect(fx.stranger).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPoolAdmin"
      );
      await expect(fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr))
        .to.emit(fx.pool, "FeeParamsUpdated")
        .withArgs(150, 500, 80);

      const cfg = await fx.pool.getFeeConfig();
      expect(cfg.baseFee).to.equal(150);
      expect(cfg.feeRampBps).to.equal(500);
      expect(cfg.feeFloorBps).to.equal(80);

      await expect(fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );
    });

    it("queued change expires after the grace window", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 150, 500, 80);
      await time.increase(DAY + 7 * DAY + 2);
      await expect(fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeExpired"
      );
    });

    it("cancel clears the pending change; re-queue restarts the clock", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 4n * 10n ** 15n);
      await fx.timelock.connect(fx.creator).cancelRepegStep(fx.poolAddr);
      await expect(fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );
      await expect(fx.timelock.connect(fx.creator).cancelRepegStep(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );

      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 6n * 10n ** 15n);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).repegStepWad).to.equal(6n * 10n ** 15n);
    });
  });

  describe("fee invariants", function () {
    it("rejects floor above ceiling and a ramp without headroom at queue time", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await expect(
        fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 100, 1000, 101)
      ).to.be.revertedWithCustomError(fx.timelock, "InvalidFeeFloor");
      await expect(
        fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 100, 1000, 100)
      ).to.be.revertedWithCustomError(fx.timelock, "InvalidFeeFloor");
      await expect(fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 0, 0, 0)).to.be.revertedWithCustomError(
        fx.timelock,
        "InvalidFee"
      );
      await expect(
        fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 1, 9_500, 0)
      ).to.be.revertedWithCustomError(fx.timelock, "InvalidFeeFloor");
      await expect(
        fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 1, 9_500, 1)
      ).to.be.revertedWithCustomError(fx.timelock, "InvalidFeeFloor");
      // MIN_BASE_FEE boundary remains independent of the repeg bands.
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 1, 0, 2);
    });

    it("rejects a live ramp below the monotonicity guard at queue time", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      // span = 120 − 40 = 80 → guard minimum = ceil(12·1e4·80² / 9880²) = 8.
      await expect(
        fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 120, 7, 40)
      ).to.be.revertedWithCustomError(fx.timelock, "FeeRampTooNarrow");
      // Exactly at the minimum queues fine.
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 120, 8, 40);
    });

    for (const [ramp, floor] of [
      [9500, 1],
      [0, 0],
    ]) {
      it("can lower fees below both stored bands (ramp=" + ramp + ", floor=" + floor + ")", async function () {
        const fx = await loadFixture(deployTimelockFixture);
        await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 5, ramp, floor);
        await time.increase(DAY + 1);
        await fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr);
        const cfg = await fx.pool.getFeeConfig();
        expect(cfg.baseFee).to.equal(5);
        expect(cfg.feeFloorBps).to.equal(floor);
        expect(cfg.repegThresholdToken1UpWad).to.equal(POOL_CONFIG.repegThresholdToken1UpWad);
        expect(cfg.repegThresholdToken1DownWad).to.equal(POOL_CONFIG.repegThresholdToken1DownWad);
      });
    }

    it("timelock applies the validated fee tuple at execution", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 200, 0, 0);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeFeeParams(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).baseFee).to.equal(200);
    });
  });

  describe("repeg thresholds", function () {
    it("queued thresholds execute after the delay and land in getFeeConfig", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, 4n * 10n ** 15n, 2n * 10n ** 15n);
      // Not ready before the delay.
      await expect(fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotReady"
      );
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr);
      const cfg = await fx.pool.getFeeConfig();
      expect(cfg.repegThresholdToken1UpWad).to.equal(4n * 10n ** 15n);
      expect(cfg.repegThresholdToken1DownWad).to.equal(2n * 10n ** 15n);
    });

    it("rejects out-of-range bands and bands above the live step on either side", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const step = POOL_CONFIG.repegStepWad;
      for (const [up, down, error] of [
        [0n, step, "InvalidRepegThreshold"],
        [step, 0n, "InvalidRepegThreshold"],
        [WAD, step, "InvalidRepegThreshold"],
        [step, WAD, "InvalidRepegThreshold"],
        [WAD + 1n, step, "InvalidRepegThreshold"],
        [step, WAD + 1n, "InvalidRepegThreshold"],
        [step + 1n, step, "RepegThresholdExceedsStep"],
        [step, step + 1n, "RepegThresholdExceedsStep"],
      ] as const) {
        await expect(
          fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, up, down)
        ).to.be.revertedWithCustomError(fx.timelock, error);
      }
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, step, step);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr);
      const cfg = await fx.pool.getFeeConfig();
      expect(cfg.repegThresholdToken1UpWad).to.equal(step);
      expect(cfg.repegThresholdToken1DownWad).to.equal(step);
    });

    it("keeps the step ceiling at WAD but requires both bands strictly below it", async function () {
      const fx = await deployTimelockFixture(5000, { repegStepWad: WAD });
      for (const [up, down] of [
        [WAD, 1n],
        [1n, WAD],
      ] as const) {
        await expect(
          fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, up, down)
        ).to.be.revertedWithCustomError(fx.timelock, "InvalidRepegThreshold");
      }
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, WAD - 1n, WAD - 1n);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr);
      const cfg = await fx.pool.getFeeConfig();
      expect(cfg.repegStepWad).to.equal(WAD);
      expect(cfg.repegThresholdToken1UpWad).to.equal(WAD - 1n);
      expect(cfg.repegThresholdToken1DownWad).to.equal(WAD - 1n);
    });

    for (const feesFirst of [false, true]) {
      it("fee and threshold changes execute independently (fees first: " + feesFirst + ")", async function () {
        const fx = await loadFixture(deployTimelockFixture);
        const threshold = 10n ** 15n; // 0.1% = 10 bps, above the 1-bps floor.
        await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, threshold, threshold);
        await fx.timelock.connect(fx.creator).queueFeeParams(fx.poolAddr, 5, 9500, 1);
        await time.increase(DAY + 1);
        const methods = feesFirst
          ? ["executeFeeParams", "executeRepegThresholds"]
          : ["executeRepegThresholds", "executeFeeParams"];
        for (const method of methods) await fx.timelock.connect(fx.creator)[method](fx.poolAddr);
        const cfg = await fx.pool.getFeeConfig();
        expect(cfg.baseFee).to.equal(5);
        expect(cfg.feeFloorBps).to.equal(1);
        expect(cfg.repegThresholdToken1UpWad).to.equal(threshold);
        expect(cfg.repegThresholdToken1DownWad).to.equal(threshold);
      });
    }

    it("rechecks queued thresholds after an intervening step decrease", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const threshold = 4n * 10n ** 15n;
      const step = 35n * 10n ** 14n;
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, threshold, threshold);
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, step);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr);
      await expect(fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegThresholdExceedsStep"
      );
      const cfg = await fx.pool.getFeeConfig();
      expect(cfg.repegStepWad).to.equal(step);
      expect(cfg.repegThresholdToken1UpWad).to.equal(POOL_CONFIG.repegThresholdToken1UpWad);
    });

    it("rechecks a queued step after an intervening threshold increase", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const threshold = 4n * 10n ** 15n;
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 35n * 10n ** 14n);
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, threshold, threshold);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr);
      await expect(fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegThresholdExceedsStep"
      );
      expect((await fx.pool.getFeeConfig()).repegStepWad).to.equal(POOL_CONFIG.repegStepWad);
    });

    for (const upLarger of [false, true]) {
      it("step updates respect both bands and allow equality (up larger: " + upLarger + ")", async function () {
        const fx = await loadFixture(deployTimelockFixture);
        const small = 3n * 10n ** 15n;
        const large = 4n * 10n ** 15n;
        await fx.timelock
          .connect(fx.creator)
          .queueRepegThresholds(fx.poolAddr, upLarger ? large : small, upLarger ? small : large);
        await time.increase(DAY + 1);
        await fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr);
        await expect(
          fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, large - 1n)
        ).to.be.revertedWithCustomError(fx.timelock, "RepegThresholdExceedsStep");
        await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, large);
        await time.increase(DAY + 1);
        await fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr);
        expect((await fx.pool.getFeeConfig()).repegStepWad).to.equal(large);
      });
    }

    it("cancel clears the pending bands; only the admin may queue or cancel", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await expect(
        fx.timelock.connect(fx.stranger).queueRepegThresholds(fx.poolAddr, 3n * 10n ** 15n, 3n * 10n ** 15n)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
      await fx.timelock.connect(fx.creator).queueRepegThresholds(fx.poolAddr, 4n * 10n ** 15n, 4n * 10n ** 15n);
      await expect(fx.timelock.connect(fx.stranger).cancelRepegThresholds(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPoolAdmin"
      );
      await fx.timelock.connect(fx.creator).cancelRepegThresholds(fx.poolAddr);
      await time.increase(DAY + 1);
      await expect(fx.timelock.connect(fx.creator).executeRepegThresholds(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );
    });

    it("pool setter rejects every caller except the timelock", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await expect(
        fx.pool.connect(fx.creator).setRepegThresholds(3n * 10n ** 15n, 3n * 10n ** 15n)
      ).to.be.revertedWithCustomError(fx.pool, "NotParamTimelock");
    });
  });

  describe("repeg step", function () {
    it("rejects out-of-range steps and per-change moves beyond half/double of the live value", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await expect(fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, 0)).to.be.revertedWithCustomError(
        fx.timelock,
        "InvalidRepegStep"
      );
      await expect(fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, WAD + 1n)).to.be.revertedWithCustomError(
        fx.timelock,
        "InvalidRepegStep"
      );
      // Live step is 5e15 -> the per-change band is [2.5e15, 1e16].
      // One wei past either edge is rejected; the exact edges pass.
      const current = (await fx.pool.getFeeConfig()).repegStepWad;
      const upper = current * 2n;
      const lower = current / 2n;
      await expect(
        fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, upper + 1n)
      ).to.be.revertedWithCustomError(fx.timelock, "RepegStepChangeTooLarge");
      await expect(
        fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, lower - 1n)
      ).to.be.revertedWithCustomError(fx.timelock, "RepegStepChangeTooLarge");
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, upper);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).repegStepWad).to.equal(upper);
      // Reaching a far setting is a ratchet across several 24h windows:
      // the next band is measured from the NEW live value.
      const next = upper * 2n;
      await fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, next);
      await expect(
        fx.timelock.connect(fx.creator).queueRepegStep(fx.poolAddr, next + 1n)
      ).to.be.revertedWithCustomError(fx.timelock, "RepegStepChangeTooLarge");
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegStep(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).repegStepWad).to.equal(next);
    });
  });

  describe("parachute band multiplier (K)", function () {
    it("seeds K = 30 and round-trips a queued change through getFeeConfig", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      // Seeded from Constants.REPEG_PARACHUTE_BAND_MULT — never a
      // creation parameter, so every pool starts at the canonical 30.
      expect((await fx.pool.getFeeConfig()).parachuteBandMult).to.equal(30);

      const selector = fx.pool.interface.getFunction("setParachuteBandMult").selector;
      await expect(fx.timelock.connect(fx.creator).queueParachuteBandMult(fx.poolAddr, 45))
        .to.emit(fx.timelock, "ParachuteBandMultQueued")
        .withArgs(fx.poolAddr, 45, anyValue);

      // 24h delay enforced.
      await expect(fx.timelock.connect(fx.creator).executeParachuteBandMult(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotReady"
      );

      await time.increase(DAY + 1);
      // Execution is admin-gated like queue and cancel.
      await expect(
        fx.timelock.connect(fx.stranger).executeParachuteBandMult(fx.poolAddr)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
      const execTx = fx.timelock.connect(fx.creator).executeParachuteBandMult(fx.poolAddr);
      await expect(execTx).to.emit(fx.pool, "ParachuteBandMultUpdated").withArgs(45);
      await expect(execTx).to.emit(fx.timelock, "ChangeExecuted").withArgs(fx.poolAddr, selector);
      expect((await fx.pool.getFeeConfig()).parachuteBandMult).to.equal(45);

      // The queue is consumed by execution.
      await expect(fx.timelock.connect(fx.creator).executeParachuteBandMult(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );

      // The uint8 ceiling (255) is queueable — the type caps the range.
      await fx.timelock.connect(fx.creator).queueParachuteBandMult(fx.poolAddr, 255);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeParachuteBandMult(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).parachuteBandMult).to.equal(255);
    });

    it("queued K change expires after the grace window", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueParachuteBandMult(fx.poolAddr, 45);
      await time.increase(DAY + 7 * DAY + 2);
      await expect(fx.timelock.connect(fx.creator).executeParachuteBandMult(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeExpired"
      );
      expect((await fx.pool.getFeeConfig()).parachuteBandMult).to.equal(30);
    });

    it("rejects K = 0 and non-admin queue/cancel; cancel clears the pending change", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      // Zero would erase the lag qualifier — rejected outright.
      await expect(
        fx.timelock.connect(fx.creator).queueParachuteBandMult(fx.poolAddr, 0)
      ).to.be.revertedWithCustomError(fx.timelock, "InvalidParachuteBandMult");
      // Only the pool admin may queue or cancel.
      await expect(
        fx.timelock.connect(fx.stranger).queueParachuteBandMult(fx.poolAddr, 31)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
      await fx.timelock.connect(fx.creator).queueParachuteBandMult(fx.poolAddr, 31);
      await expect(fx.timelock.connect(fx.stranger).cancelParachuteBandMult(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "NotPoolAdmin"
      );

      const selector = fx.pool.interface.getFunction("setParachuteBandMult").selector;
      await expect(fx.timelock.connect(fx.creator).cancelParachuteBandMult(fx.poolAddr))
        .to.emit(fx.timelock, "ChangeCancelled")
        .withArgs(fx.poolAddr, selector);
      await time.increase(DAY + 1);
      await expect(fx.timelock.connect(fx.creator).executeParachuteBandMult(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );
      // Cancelling an empty queue is refused too.
      await expect(fx.timelock.connect(fx.creator).cancelParachuteBandMult(fx.poolAddr)).to.be.revertedWithCustomError(
        fx.timelock,
        "ParamChangeNotQueued"
      );
    });

    it("admin handover and renounce clear the pending K change", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      const selector = fx.pool.interface.getFunction("setParachuteBandMult").selector;

      // Handover: the incoming admin starts with a clean queue.
      await fx.timelock.connect(fx.creator).queueParachuteBandMult(fx.poolAddr, 40);
      await fx.timelock.connect(fx.creator).nominatePoolAdmin(fx.poolAddr, await fx.stranger.getAddress());
      await expect(fx.timelock.connect(fx.stranger).acceptPoolAdmin(fx.poolAddr))
        .to.emit(fx.timelock, "ChangeCancelled")
        .withArgs(fx.poolAddr, selector);
      await time.increase(DAY + 1);
      // The incoming admin (stranger) finds the inherited queue cleared.
      await expect(
        fx.timelock.connect(fx.stranger).executeParachuteBandMult(fx.poolAddr)
      ).to.be.revertedWithCustomError(fx.timelock, "ParamChangeNotQueued");

      // Renounce: frozen means frozen — the still-queued K change dies
      // with the role instead of staying executable, and no caller
      // retains an execute path.
      await fx.timelock.connect(fx.stranger).queueParachuteBandMult(fx.poolAddr, 40);
      await expect(fx.timelock.connect(fx.stranger).renouncePoolAdmin(fx.poolAddr))
        .to.emit(fx.timelock, "ChangeCancelled")
        .withArgs(fx.poolAddr, selector);
      await time.increase(DAY + 1);
      await expect(
        fx.timelock.connect(fx.stranger).executeParachuteBandMult(fx.poolAddr)
      ).to.be.revertedWithCustomError(fx.timelock, "NotPoolAdmin");
      expect((await fx.timelock.pendingParachuteBandMult(fx.poolAddr)).eta).to.equal(0n);
      expect((await fx.pool.getFeeConfig()).parachuteBandMult).to.equal(30);
    });
  });

  describe("repeg share policy", function () {
    for (const share of [5000, 7000]) {
      it(`permits a same-value share update on/above the floor (${share})`, async () => {
        const fx = await deployTimelockFixture(share);
        const before = await fx.pool.getLpValueState();
        await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, share);
        await time.increase(DAY + 1);
        await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr))
          .to.emit(fx.pool, "RepegShareUpdated")
          .withArgs(share, before.genesisWad);
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(share);
        expect(await fx.pool.getLpValueState()).to.deep.equal(before);
      });
    }

    async function lowShareFixture() {
      return deployTimelockFixture(2000);
    }

    async function oneBpsShareFixture() {
      return deployTimelockFixture(1);
    }

    async function zeroShareFixture() {
      return deployTimelockFixture(0);
    }

    it("allows successive 20% -> 30% -> 40% increases after each timelock delay", async function () {
      const fx = await loadFixture(lowShareFixture);
      let current = 2000n;
      expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(current);
      for (const next of [3000n, 4000n]) {
        await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, next))
          .to.emit(fx.timelock, "RepegShareQueued")
          .withArgs(fx.poolAddr, next, anyValue);
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(current);
        await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr)).to.be.revertedWithCustomError(
          fx.timelock,
          "ParamChangeNotReady"
        );
        await time.increase(DAY + 1);
        await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr))
          .to.emit(fx.pool, "RepegShareUpdated")
          .withArgs(next, anyValue);
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(next);
        expect((await fx.timelock.pendingRepegShare(fx.poolAddr)).eta).to.equal(0n);
        current = next;
      }
    });

    it("rejects 20% -> 20%, 10% and zero without queuing a change", async function () {
      const fx = await loadFixture(lowShareFixture);
      for (const next of [2000, 1000, 0]) {
        await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, next)).to.be.revertedWithCustomError(
          fx.timelock,
          "RepegShareChangeOutOfRange"
        );
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(2000n);
        expect((await fx.timelock.pendingRepegShare(fx.poolAddr)).eta).to.equal(0n);
      }
    });

    it("accepts the 50% boundary and preserves the floor after reaching it", async function () {
      const fx = await loadFixture(lowShareFixture);
      // Both an increase to the floor and a later decrease back to it
      // remain legal; neither 50% nor 70% may fall below the floor.
      for (const next of [5000n, 7000n, 5000n]) {
        await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, next);
        await time.increase(DAY + 1);
        await fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr);
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(next);
        for (const belowFloor of [4999, 3000]) {
          await expect(
            fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, belowFloor)
          ).to.be.revertedWithCustomError(fx.timelock, "RepegShareChangeOutOfRange");
        }
        expect((await fx.timelock.pendingRepegShare(fx.poolAddr)).eta).to.equal(0n);
      }
    });

    it("allows one-bps share increments from a nonzero one-bps genesis share", async function () {
      const fx = await loadFixture(oneBpsShareFixture);
      expect((await fx.pool.getFeeConfig()).protocolFeePercent).to.equal(10n);
      expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(1n);
      for (const next of [2n, 3n]) {
        await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, next);
        await time.increase(DAY + 1);
        await fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr);
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(next);
      }
    });

    it("keeps zero-share opt-out immutable even for a one-bps increase", async function () {
      const fx = await loadFixture(zeroShareFixture);
      for (const next of [0, 1, 2000, 5000]) {
        await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, next)).to.be.revertedWithCustomError(
          fx.timelock,
          "RepegShareImmutable"
        );
      }
      expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(0n);
      expect((await fx.timelock.pendingRepegShare(fx.poolAddr)).eta).to.equal(0n);
    });

    it("retains the protocol-adjusted ceiling when raising a sub-floor share", async function () {
      const fx = await loadFixture(lowShareFixture);
      expect((await fx.pool.getFeeConfig()).protocolFeePercent).to.equal(10n);
      // At protocol fee 10%, user 8550 maps to stored 9500 exactly.
      await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8551)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegShareChangeOutOfRange"
      );
      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8550);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr);
      expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(8550n);
    });

    for (const liveShare of [0, 2500, 3000, 4000, 5000, 7000]) {
      it("revalidates queued 30% against live share " + liveShare + " bps at execution", async function () {
        const fx = await loadFixture(lowShareFixture);
        await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 3000);
        const pending = await fx.timelock.pendingRepegShare(fx.poolAddr);
        expect(pending.repegShareBps).to.equal(3000n);

        // A new queue would overwrite the old one. Change only the live
        // pool state through its existing timelock-gated setter to exercise
        // execution-time validation independently of queue-time validation.
        const timelockAddress = await fx.timelock.getAddress();
        await setBalance(timelockAddress, WAD);
        await impersonateAccount(timelockAddress);
        try {
          const timelockSigner = await hre.ethers.getSigner(timelockAddress);
          await fx.pool.connect(timelockSigner).setRepegShareBps(liveShare);
        } finally {
          await stopImpersonatingAccount(timelockAddress);
        }
        expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(BigInt(liveShare));
        const lpBefore = await fx.pool.getLpValueState();
        await time.increase(DAY + 1);

        if (liveShare === 2500) {
          await fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr);
          expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(3000n);
          expect((await fx.timelock.pendingRepegShare(fx.poolAddr)).eta).to.equal(0n);
        } else {
          await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr)).to.be.revertedWithCustomError(
            fx.timelock,
            liveShare === 0 ? "RepegShareImmutable" : "RepegShareChangeOutOfRange"
          );
          expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(BigInt(liveShare));
          expect(await fx.pool.getLpValueState()).to.deep.equal(lpBefore);
          expect(await fx.timelock.pendingRepegShare(fx.poolAddr)).to.deep.equal(pending);
        }
      });
    }

    it("enforces the runtime band [5000, 9500]", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 4999)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegShareChangeOutOfRange"
      );
      await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 9501)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegShareChangeOutOfRange"
      );
    });

    it("ceiling binds in stored space: the grossed-up share stays <= 9500", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      // protocolFeePercent = 10: stored = user * 10000 / 9000. A
      // user-space ceiling would admit 9000 -> stored 10000 = BPS,
      // collapsing the LP growth slice to zero; the stored-space
      // ceiling caps the user share at 8550 -> stored exactly 9500.
      await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 9000)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegShareChangeOutOfRange"
      );
      await expect(fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8551)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegShareChangeOutOfRange"
      );
      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8550);
    });

    it("prescale round-trips the user-facing share through getFeeConfig", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 7000);
      await time.increase(DAY + 1);
      await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr))
        .to.emit(fx.pool, "RepegShareUpdated")
        .withArgs(7000, anyValue);
      expect((await fx.pool.getFeeConfig()).repegShareBps).to.equal(7000);
    });

    it("opt-out pools keep every repeg knob immutable", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      // Second pool with auto-repeg disabled (share = 0). The threshold
      // is inert on such pools, so any in-range value passes creation.
      await fx.factory
        .connect(fx.creator)
        .createPoolAndAddLiquidity(
          fx.usdtAddr.toLowerCase() < fx.wethAddr.toLowerCase() ? fx.usdtAddr : fx.wethAddr,
          fx.usdtAddr.toLowerCase() < fx.wethAddr.toLowerCase() ? fx.wethAddr : fx.usdtAddr,
          { ...POOL_CONFIG, repegShareBps: 0 },
          fx.usdtAddr.toLowerCase() < fx.wethAddr.toLowerCase() ? 3_000_000n * 10n ** 6n : 1_000n * WAD,
          fx.usdtAddr.toLowerCase() < fx.wethAddr.toLowerCase() ? 1_000n * WAD : 3_000_000n * 10n ** 6n,
          await fx.creator.getAddress()
        );
      const optOutAddr = await fx.factory.allPools(1);
      await expect(fx.timelock.connect(fx.creator).queueRepegShare(optOutAddr, 7000)).to.be.revertedWithCustomError(
        fx.timelock,
        "RepegShareImmutable"
      );
      // The step stays queueable on an opt-out pool: with repegShareBps
      // pinned to 0 forever the step is inert, so tuning it is harmless
      // (only the usual range + per-change band apply).
      await fx.timelock.connect(fx.creator).queueRepegStep(optOutAddr, 4n * 10n ** 15n);
    });
  });

  describe("repeg-share epochs (non-retroactive ratchet)", function () {
    const BPS = 10_000n;
    const PF = 10n; // fixture protocol fee percent
    // Mirrors the pool's floor-division gross-up.
    const stored = (user: bigint) => (user * BPS) / (BPS - PF * 100n);
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    const sealJump = (growth: bigint, oldUserShare: bigint) => ceilDiv(growth * (BPS - stored(oldUserShare)), BPS);

    async function accrueGrowth(fx: any) {
      const deadline = Math.floor(Date.now() / 1000) + 10 * DAY;
      for (let i = 0; i < 4; i++) {
        await fx.router.connect(fx.stranger).exactInputSingle({
          tokenIn: i % 2 === 0 ? fx.usdtAddr : fx.wethAddr,
          tokenOut: i % 2 === 0 ? fx.wethAddr : fx.usdtAddr,
          poolIndex: 0,
          recipient: await fx.stranger.getAddress(),
          amountIn: i % 2 === 0 ? 200_000n * 10n ** 6n : 60n * 10n ** 18n,
          amountOutMinimum: 0,
          deadline,
        });
      }
    }

    it("sealing: base ratchets by the outgoing share's slice, accumulator resets, budget survives", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await accrueGrowth(fx);
      const before = await fx.pool.getLpValueState();
      expect(BigInt(before.growthWad)).to.be.gt(0n);
      const expectedBase = BigInt(before.genesisWad) + sealJump(BigInt(before.growthWad), 5000n);

      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8000);
      await time.increase(DAY + 1);
      await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr))
        .to.emit(fx.pool, "RepegShareUpdated")
        .withArgs(8000, expectedBase);

      const after = await fx.pool.getLpValueState();
      expect(BigInt(after.genesisWad)).to.equal(expectedBase);
      expect(BigInt(after.growthWad)).to.equal(0n);
      // The high-water mark is untouched: the live spendable budget
      // (unit value minus floor) carries over through the seal.
      expect(BigInt(after.unitValueWad)).to.equal(BigInt(before.unitValueWad));
      // The base never exceeds the live unit value (ceil may land at
      // most 1 wei above an exactly-spent floor).
      expect(BigInt(after.genesisWad)).to.be.lte(BigInt(after.unitValueWad) + 1n);
    });

    it("a second change seals only the new epoch's growth", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      await accrueGrowth(fx);
      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8000);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr);
      const mid = await fx.pool.getLpValueState();

      await accrueGrowth(fx);
      const beforeSecond = await fx.pool.getLpValueState();
      const epochGrowth = BigInt(beforeSecond.growthWad);
      expect(epochGrowth).to.be.gt(0n);
      // The sealed history of epoch #0 must not be re-split: the jump
      // depends only on the growth earned since the previous seal.
      const expectedBase = BigInt(mid.genesisWad) + sealJump(epochGrowth, 8000n);

      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8100);
      await time.increase(DAY + 1);
      await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr))
        .to.emit(fx.pool, "RepegShareUpdated")
        .withArgs(8100, expectedBase);
      expect(BigInt((await fx.pool.getLpValueState()).genesisWad)).to.equal(expectedBase);
    });

    it("lowering seals identically under the outgoing share (no retro re-protection)", async function () {
      const fx = await loadFixture(deployTimelockFixture);
      // Raise to the stored-space ceiling first (user 8550 -> stored 9500).
      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 8550);
      await time.increase(DAY + 1);
      await fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr);
      const mid = await fx.pool.getLpValueState();

      await accrueGrowth(fx);
      const before = await fx.pool.getLpValueState();
      const epochGrowth = BigInt(before.growthWad);
      // Outgoing share 8550 -> stored 9500 -> only 5% of the epoch's
      // growth seals into the base; the lowering applies 50/50 to the
      // FUTURE only.
      const expectedBase = BigInt(mid.genesisWad) + sealJump(epochGrowth, 8550n);

      await fx.timelock.connect(fx.creator).queueRepegShare(fx.poolAddr, 5000);
      await time.increase(DAY + 1);
      await expect(fx.timelock.connect(fx.creator).executeRepegShare(fx.poolAddr))
        .to.emit(fx.pool, "RepegShareUpdated")
        .withArgs(5000, expectedBase);
      const after = await fx.pool.getLpValueState();
      expect(BigInt(after.genesisWad)).to.equal(expectedBase);
      expect(BigInt(after.growthWad)).to.equal(0n);
    });
  });
});
