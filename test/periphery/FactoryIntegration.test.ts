import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;
const SEED = hre.ethers.parseEther("100000");

function makeConfig(
  baseFee: number,
  emaPeriod: number,
  aWad: bigint = PRESET.aWad,
  lambdaWad: bigint = PRESET.lambdaWad
) {
  return {
    aWad,
    lambdaWad,
    baseFee,
    emaPeriod,
    repegStepWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
    feeRampBps: 0,
    feeFloorBps: 20,
    repegShareBps: 5000,
  };
}

describe("FactoryIntegration", function () {
  async function deployFixture() {
    const [owner, creator] = await hre.ethers.getSigners();

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

    // Fund the creator with seed tokens and approve the factory; the factory
    // is the sole entry point for atomic pool creation + initial liquidity.
    await token0.mint(creator.address, SEED * 4n);
    await token1.mint(creator.address, SEED * 4n);
    const factoryAddr = await factory.getAddress();
    await token0.connect(creator).approve(factoryAddr, MaxUint256);
    await token1.connect(creator).approve(factoryAddr, MaxUint256);

    return { owner, creator, token0, token1, factory, poolImpl };
  }

  it("creates pools with aligned (aWad, lambdaWad) curve params", async function () {
    const { creator, token0, token1, factory } = await loadFixture(deployFixture);

    await factory
      .connect(creator)
      .createPoolAndAddLiquidity(
        await token0.getAddress(),
        await token1.getAddress(),
        makeConfig(25, 1200),
        SEED,
        SEED,
        creator.address
      );

    const poolAddress = await factory.allPools(0);
    expect(poolAddress).to.properAddress;
    expect(await factory.getPoolCountForPair(await token0.getAddress(), await token1.getAddress())).to.equal(1n);
    expect(await factory.getPoolsByCreatorCount(creator.address)).to.equal(1n);

    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
    const cp = await pool.getCurveParams();
    expect(cp.aWad).to.equal(PRESET.aWad);
    expect(cp.lambdaWad).to.equal(PRESET.lambdaWad);
    expect((await pool.getFeeConfig()).baseFee).to.equal(25n);
    // Factory always sorts tokens by address (pool.token0 < pool.token1).
    const t0Addr = await token0.getAddress();
    const t1Addr = await token1.getAddress();
    const [sorted0, sorted1] = t0Addr.toLowerCase() < t1Addr.toLowerCase() ? [t0Addr, t1Addr] : [t1Addr, t0Addr];
    const meta0 = await pool.getPoolMetadata();
    expect(meta0.token0).to.equal(sorted0);
    expect(meta0.token1).to.equal(sorted1);
  });

  it("supports whitelist management for created pools", async function () {
    const { owner, creator, token0, token1, factory } = await loadFixture(deployFixture);

    await factory.connect(creator).createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      {
        ...makeConfig(30, 1800),
        aWad: PRESET.aWad,
        lambdaWad: PRESET.lambdaWad,
      },
      SEED,
      SEED,
      creator.address
    );
    const poolAddress = await factory.allPools(0);

    expect(await factory.isPoolWhitelisted(await token0.getAddress(), await token1.getAddress(), poolAddress)).to.equal(
      false
    );

    await factory.connect(owner).addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddress);

    expect(await factory.isPoolWhitelisted(await token0.getAddress(), await token1.getAddress(), poolAddress)).to.equal(
      true
    );

    await factory
      .connect(owner)
      .removePoolFromWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddress);
    expect(await factory.isPoolWhitelisted(await token0.getAddress(), await token1.getAddress(), poolAddress)).to.equal(
      false
    );
  });

  it("wires router with pool and exposes raw storage reads", async function () {
    const { creator, token0, token1, factory, poolImpl } = await loadFixture(deployFixture);
    const seedAmount = hre.ethers.parseEther("100000");

    await factory.connect(creator).createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      {
        ...makeConfig(30, 1200),
        aWad: PRESET.aWad,
        lambdaWad: PRESET.lambdaWad,
      },
      seedAmount,
      seedAmount,
      creator.address
    );
    const poolAddress = await factory.allPools(0);

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

    await token0.connect(creator).approve(await router.getAddress(), MaxUint256);
    await token1.connect(creator).approve(await router.getAddress(), MaxUint256);
    await router.connect(creator).exactInputSingle({
      tokenIn: await token0.getAddress(),
      tokenOut: await token1.getAddress(),
      poolIndex: 0,
      recipient: creator.address,
      amountIn: hre.ethers.parseEther("1000"),
      amountOutMinimum: 0,
      deadline: (await hre.ethers.provider.getBlock("latest"))!.timestamp + 3600,
    });

    // Post-Lens observability: off-chain callers use typed pool views
    // (replaces the former `lens.getPoolState` one-shot call).
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
    const t0Addr = await token0.getAddress();
    const t1Addr = await token1.getAddress();
    const [sorted0, sorted1] = t0Addr.toLowerCase() < t1Addr.toLowerCase() ? [t0Addr, t1Addr] : [t1Addr, t0Addr];
    const meta = await pool.getPoolMetadata();
    expect(meta.token0).to.equal(sorted0);
    expect(meta.token1).to.equal(sorted1);
    const [r0, r1] = await pool.getReserves();
    expect(r0).to.be.gt(0n);
    expect(r1).to.be.gt(0n);
  });

  it("getStorageSlots returns raw slot data for off-chain observability", async function () {
    const { creator, token0, token1, factory } = await loadFixture(deployFixture);

    await factory.connect(creator).createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      {
        ...makeConfig(30, 1200),
        aWad: PRESET.aWad,
        lambdaWad: PRESET.lambdaWad,
      },
      SEED,
      SEED,
      creator.address
    );
    const poolAddress = await factory.allPools(0);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

    // Empty input returns empty output.
    const empty = await pool.getStorageSlots([]);
    expect(empty.length).to.equal(0);

    // Reading a small batch must return the matching array shape and
    // produce values consistent with a second call (pure view, no
    // side-effects between reads).
    const slots = [0n, 1n, 2n, 3n, 4n, 5n, 42n];
    const first = await pool.getStorageSlots(slots);
    const second = await pool.getStorageSlots(slots);
    expect(first.length).to.equal(slots.length);
    expect(second.length).to.equal(slots.length);
    for (let i = 0; i < slots.length; i++) {
      expect(first[i]).to.equal(second[i]);
    }

    // An obviously-out-of-range slot must read as zero (EVM default).
    const far = await pool.getStorageSlots([2n ** 200n]);
    expect(far[0]).to.equal("0x0000000000000000000000000000000000000000000000000000000000000000");

    // At least one slot in the first few must be non-zero after
    // `createPoolAndAddLiquidity` (LP totalSupply, token addresses, or
    // packed config all live in the early slot range). We intentionally
    // avoid asserting on exact layout so the test survives refactors.
    const anyNonZero = first.some((w) => w !== "0x0000000000000000000000000000000000000000000000000000000000000000");
    expect(anyNonZero).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // Negative paths and bounds enforcement.
  //
  // Mirrors the actual `EquilibraFactory` revert surface so a regression
  // that drops a guard (e.g. removes the `IdenticalTokens` check) would
  // surface as a test failure, not as a silently relaxed factory.
  // Bounds values are pinned to `Constants.sol` — bumping a ceiling
  // requires updating both the contract and this test.
  // -------------------------------------------------------------------------

  // Mirrors `Constants.sol`. Importing from the contract source would
  // require a separate harness exposing `Constants.*`; pinning the
  // numeric constants here is fine because any drift between this list
  // and the contract surfaces immediately as a failing assertion.
  const MAX_BASE_FEE = 2_000;
  const MAX_PROTOCOL_FEE = 25;
  const MIN_EMA_PERIOD = 60;
  // Largest accepted half-life input: the factory bounds the stored
  // internal tau = ceil(emaPeriod * 1000 / 694) by MAX_EMA_PERIOD
  // (604800 s), i.e. floor(604800 * 694 / 1000).
  const MAX_EMA_HALF_LIFE = 419_731;
  const MAX_FEE_RAMP_BPS = 10_000;
  const MAX_REPEG_SHARE_BPS = 10_000;
  const WAD = hre.ethers.parseUnits("1", 18);

  describe("constructor", function () {
    it("reverts with ZeroAddress when poolImplementation is zero", async function () {
      const [owner] = await hre.ethers.getSigners();
      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      await expect(
        Factory.deploy(hre.ethers.ZeroAddress, owner.address, owner.address, 0)
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("reverts with ZeroAddress when feeCollector is zero", async function () {
      const [owner] = await hre.ethers.getSigners();
      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();
      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      await expect(
        Factory.deploy(await poolImpl.getAddress(), hre.ethers.ZeroAddress, owner.address, 0)
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("reverts with ZeroAddress when WETH9 is zero", async function () {
      const [owner] = await hre.ethers.getSigners();
      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();
      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      await expect(
        Factory.deploy(await poolImpl.getAddress(), owner.address, hre.ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("validates and applies the construction-time protocol fee", async function () {
      const [owner] = await hre.ethers.getSigners();
      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();
      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");

      // Same bounds as the setter: percent units, [0, 25].
      await expect(
        Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 26)
      ).to.be.revertedWithCustomError(Factory, "InvalidProtocolFee");

      // A nonzero construction-time fee is live from the very first
      // pool: pools snapshot the value at creation, so no window with a
      // zero protocol share exists.
      const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 5);
      await factory.waitForDeployment();
      await expect(factory.deploymentTransaction()).to.emit(factory, "ProtocolFeeChanged").withArgs(0, 5);
      expect(await factory.protocolFee()).to.equal(5n);

      const Token = await hre.ethers.getContractFactory("MockERC20");
      const t0 = await Token.deploy("P0", "P0", 18);
      const t1 = await Token.deploy("P1", "P1", 18);
      for (const t of [t0, t1]) {
        await t.mint(owner.address, SEED);
        await t.approve(await factory.getAddress(), SEED);
      }
      await factory.createPoolAndAddLiquidity(
        await t0.getAddress(),
        await t1.getAddress(),
        makeConfig(25, 1200),
        SEED,
        SEED,
        owner.address
      );
      const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
      expect((await pool.getFeeConfig()).protocolFeePercent).to.equal(5n);
    });
  });

  describe("createPoolAndAddLiquidity input validation", function () {
    it("reverts with IdenticalTokens when token0 == token1", async function () {
      const { creator, token0, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token0.getAddress(),
          {
            ...makeConfig(25, 1200),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "IdenticalTokens");
    });

    it("reverts with ZeroAddress when token0 is zero", async function () {
      const { creator, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          hre.ethers.ZeroAddress,
          await token1.getAddress(),
          {
            ...makeConfig(25, 1200),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts with ZeroAddress when token1 is zero", async function () {
      const { creator, token0, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          hre.ethers.ZeroAddress,
          {
            ...makeConfig(25, 1200),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts with InvalidA when aWad is below A_MIN_WAD ", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(25, 1200),
            aWad: 1n,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidA");
    });

    it("reverts with InvalidA when aWad exceeds A_MAX_WAD ", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(25, 1200),
            aWad: 10n ** 18n,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidA");
    });

    it("reverts with InvalidFee when baseFee is below MIN_BASE_FEE", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(4, 1200),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidFee");
    });

    it("reverts with InvalidFee when baseFee exceeds MAX_BASE_FEE", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(MAX_BASE_FEE + 1, 1200),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidFee");
    });

    it("reverts with InvalidEmaPeriod when emaPeriod is below MIN_EMA_PERIOD", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(25, MIN_EMA_PERIOD - 1),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidEmaPeriod");
    });

    it("reverts with InvalidEmaPeriod when the converted tau exceeds MAX_EMA_PERIOD", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(25, MAX_EMA_HALF_LIFE + 1),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidEmaPeriod");
    });

    it("half-life -> tau -> half-life round-trips exactly across the entire valid domain", function () {
      // Pure-formula sweep with the factory's exact integer semantics:
      // BigInt `/` truncates like the EVM DIV opcode, so
      // `(h * 1000 + 693) / 694` is the factory's ceil conversion and
      // `(tau * 694) / 1000` is the pool view's floor inverse. Exhaustive
      // over every accepted input — the view identity is proven for the
      // whole domain, while the deploy test below spot-checks the same
      // pairs through the real contracts.
      let prevTau = 0n;
      for (let halfLife = 60n; halfLife <= 419_731n; halfLife++) {
        const tau = (halfLife * 1000n + 693n) / 694n;
        if ((tau * 694n) / 1000n !== halfLife) {
          throw new Error(`round trip broke at halfLife=${halfLife}: tau=${tau}`);
        }
        if (tau < 87n || tau > 604_800n) {
          throw new Error(`tau=${tau} escapes PoolOracle bounds at halfLife=${halfLife}`);
        }
        if (tau < prevTau) {
          throw new Error(`tau not monotone at halfLife=${halfLife}`);
        }
        prevTau = tau;
      }
      expect(prevTau).to.equal(604_800n);
    });

    it("accepts the emaPeriod boundaries and rounding edges, returning the half-life bit-for-bit", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      // Beyond the two boundaries, the sampled half-lives hit every
      // rounding class of the ceil conversion — the remainder
      // (h * 1000) % 694 is always even, so the edges are r = 0 (exact
      // division, 347 -> tau 500), r = 2 (minimal bump, 220 -> 318) and
      // r = 692 (maximal bump, 127 -> 183) — plus typical deploy values.
      const samples = [MIN_EMA_PERIOD, 127, 220, 347, 600, 3600, 86_400, MAX_EMA_HALF_LIFE];
      await token0.mint(creator.address, SEED * BigInt(samples.length));
      await token1.mint(creator.address, SEED * BigInt(samples.length));
      for (const halfLife of samples) {
        await factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            ...makeConfig(25, halfLife),
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
          },
          SEED,
          SEED,
          creator.address
        );
        const poolCount = await factory.allPoolsLength();
        const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(poolCount - 1n));
        // Round trip: tau = ceil(h*1000/694) stays within [h*1000/694, h*1000/694 + 1),
        // so floor(tau*694/1000) always recovers the exact input.
        expect((await pool.getFeeConfig()).emaPeriod).to.equal(halfLife);
      }
    });

    it("reverts with InvalidRepegStep when repegStepWad is zero", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 25,
            emaPeriod: 1200,
            repegStepWad: 0n,
            repegThresholdToken1UpWad: 0n,
            repegThresholdToken1DownWad: 0n,
            feeRampBps: 0,
            feeFloorBps: 20,
            repegShareBps: 5_000,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidRepegStep");
    });

    it("reverts with InvalidRepegStep when repegStepWad exceeds WAD", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 25,
            emaPeriod: 1200,
            repegStepWad: WAD + 1n,
            repegThresholdToken1UpWad: WAD + 1n,
            repegThresholdToken1DownWad: WAD + 1n,
            feeRampBps: 0,
            feeFloorBps: 20,
            repegShareBps: 5_000,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidRepegStep");
    });

    it("reverts with InvalidFeeRamp when feeRampBps exceeds MAX_FEE_RAMP_BPS", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 25,
            emaPeriod: 1200,
            repegStepWad: WAD / 1_000n,
            repegThresholdToken1UpWad: WAD / 1_000n,
            repegThresholdToken1DownWad: WAD / 1_000n,
            feeRampBps: MAX_FEE_RAMP_BPS + 1,
            feeFloorBps: 20,
            repegShareBps: 5_000,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidFeeRamp");
    });

    it("reverts with InvalidFeeFloor when feeFloorBps exceeds baseFee", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 30,
            emaPeriod: 1200,
            repegStepWad: WAD / 1_000n,
            repegThresholdToken1UpWad: WAD / 1_000n,
            repegThresholdToken1DownWad: WAD / 1_000n,
            feeRampBps: 1_000,
            feeFloorBps: 31, // > baseFee
            repegShareBps: 5_000,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidFeeFloor");
    });

    it("reverts with InvalidRepegShare when repegShareBps exceeds MAX_REPEG_SHARE_BPS", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 25,
            emaPeriod: 1200,
            repegStepWad: WAD / 1_000n,
            repegThresholdToken1UpWad: WAD / 1_000n,
            repegThresholdToken1DownWad: WAD / 1_000n,
            feeRampBps: 1_000,
            feeFloorBps: 20,
            repegShareBps: MAX_REPEG_SHARE_BPS + 1,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidRepegShare");
    });

    it("rejects feeFloorBps == baseFee with feeRampBps != 0 (FeeRampNoHeadroom)", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      // Pairing a non-zero ramp with `baseFee == feeFloorBps` would
      // leave the smoothstep with no headroom to interpolate into —
      // the factory rejects this misconfig at deploy time rather than
      // letting the pool silently collapse the ramp to a flat fee.
      await expect(
        factory.connect(creator).createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 50,
            emaPeriod: 1200,
            repegStepWad: WAD / 1_000n,
            repegThresholdToken1UpWad: WAD / 1_000n,
            repegThresholdToken1DownWad: WAD / 1_000n,
            feeRampBps: 1_000,
            feeFloorBps: 50, // == baseFee
            repegShareBps: 5_000,
          },
          SEED,
          SEED,
          creator.address
        )
      ).to.be.revertedWithCustomError(factory, "FeeRampNoHeadroom");
    });

    it("accepts feeFloorBps == baseFee when feeRampBps == 0 (flat-fee mode)", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      // Equality is fine in flat-fee mode (`feeRampBps == 0`): no
      // ramp means no headroom is needed.
      await factory.connect(creator).createPoolAndAddLiquidity(
        await token0.getAddress(),
        await token1.getAddress(),
        {
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
          baseFee: 50,
          emaPeriod: 1200,
          repegStepWad: WAD / 1_000n,
          repegThresholdToken1UpWad: WAD / 1_000n,
          repegThresholdToken1DownWad: WAD / 1_000n,
          feeRampBps: 0,
          feeFloorBps: 50, // == baseFee
          repegShareBps: 5_000,
        },
        SEED,
        SEED,
        creator.address
      );
      const poolAddr = await factory.allPools(0);
      const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);
      const fee = await pool.getFeeConfig();
      expect(fee.baseFee).to.equal(50n);
      expect(fee.feeFloorBps).to.equal(50n);
    });
  });

  describe("setProtocolFee", function () {
    it("only the owner can call (non-owner reverts with OwnableUnauthorizedAccount)", async function () {
      const { creator, factory } = await loadFixture(deployFixture);
      await expect(factory.connect(creator).setProtocolFee(10))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(creator.address);
    });

    it("reverts with InvalidProtocolFee when fee exceeds MAX_PROTOCOL_FEE", async function () {
      const { owner, factory } = await loadFixture(deployFixture);
      await expect(factory.connect(owner).setProtocolFee(MAX_PROTOCOL_FEE + 1)).to.be.revertedWithCustomError(
        factory,
        "InvalidProtocolFee"
      );
    });

    it("emits ProtocolFeeChanged with old and new fee", async function () {
      const { owner, factory } = await loadFixture(deployFixture);
      // Default deployment leaves protocolFee at 0; bump to a valid
      // value and confirm the event tracks both edges.
      await expect(factory.connect(owner).setProtocolFee(10)).to.emit(factory, "ProtocolFeeChanged").withArgs(0, 10);
      expect(await factory.protocolFee()).to.equal(10);
    });

    it("accepts MAX_PROTOCOL_FEE at the boundary", async function () {
      const { owner, factory } = await loadFixture(deployFixture);
      await factory.connect(owner).setProtocolFee(MAX_PROTOCOL_FEE);
      expect(await factory.protocolFee()).to.equal(MAX_PROTOCOL_FEE);
    });
  });

  describe("setFeeCollector", function () {
    it("non-owner cannot change the collector", async function () {
      const { creator, factory } = await loadFixture(deployFixture);
      await expect(factory.connect(creator).setFeeCollector(creator.address))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(creator.address);
    });

    it("reverts with ZeroAddress on a zero collector", async function () {
      const { owner, factory } = await loadFixture(deployFixture);
      await expect(factory.connect(owner).setFeeCollector(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress"
      );
    });

    it("emits FeeCollectorChanged with the old and new collector", async function () {
      const { owner, creator, factory } = await loadFixture(deployFixture);
      await expect(factory.connect(owner).setFeeCollector(creator.address))
        .to.emit(factory, "FeeCollectorChanged")
        .withArgs(owner.address, creator.address);
      expect(await factory.feeCollector()).to.equal(creator.address);
    });
  });

  describe("whitelist permissions and edge cases", function () {
    async function deployedPoolFixture() {
      const base = await deployFixture();
      await base.factory.connect(base.creator).createPoolAndAddLiquidity(
        await base.token0.getAddress(),
        await base.token1.getAddress(),
        {
          ...makeConfig(25, 1200),
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
        },
        SEED,
        SEED,
        base.creator.address
      );
      const poolAddr = await base.factory.allPools(0);
      return { ...base, poolAddr };
    }

    it("non-owner cannot add to the whitelist", async function () {
      const { creator, factory, token0, token1, poolAddr } = await loadFixture(deployedPoolFixture);
      await expect(
        factory.connect(creator).addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr)
      )
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(creator.address);
    });

    it("non-owner cannot remove from the whitelist", async function () {
      const { owner, creator, factory, token0, token1, poolAddr } = await loadFixture(deployedPoolFixture);
      await factory.connect(owner).addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr);
      await expect(
        factory.connect(creator).removePoolFromWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr)
      )
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(creator.address);
    });

    it("addPoolToWhitelist with zero pool address reverts with ZeroAddress", async function () {
      const { owner, factory, token0, token1 } = await loadFixture(deployedPoolFixture);
      await expect(
        factory
          .connect(owner)
          .addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("addPoolToWhitelist for a pool not under the pair reverts with PoolNotFound", async function () {
      const { owner, factory, token0, token1 } = await loadFixture(deployedPoolFixture);
      // Use a freshly-deployed token so the pair never matches the pool
      // under test (any address != poolAddr would do; this also rejects
      // typoes that paste a token instead of a pool).
      const Token = await hre.ethers.getContractFactory("MockERC20");
      const stranger = await Token.deploy("X", "X", 18);
      await expect(
        factory
          .connect(owner)
          .addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), await stranger.getAddress())
      ).to.be.revertedWithCustomError(factory, "PoolNotFound");
    });

    it("addPoolToWhitelist twice for the same pool reverts with PoolExists", async function () {
      const { owner, factory, token0, token1, poolAddr } = await loadFixture(deployedPoolFixture);
      await factory.connect(owner).addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr);
      await expect(
        factory.connect(owner).addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr)
      ).to.be.revertedWithCustomError(factory, "PoolExists");
    });

    it("removePoolFromWhitelist before adding reverts with PoolNotFound", async function () {
      const { owner, factory, token0, token1, poolAddr } = await loadFixture(deployedPoolFixture);
      await expect(
        factory.connect(owner).removePoolFromWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr)
      ).to.be.revertedWithCustomError(factory, "PoolNotFound");
    });

    it("emits PoolWhitelistUpdated on add and remove", async function () {
      const { owner, factory, token0, token1, poolAddr } = await loadFixture(deployedPoolFixture);
      await expect(
        factory.connect(owner).addPoolToWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr)
      )
        .to.emit(factory, "PoolWhitelistUpdated")
        .withArgs(await token0.getAddress(), await token1.getAddress(), poolAddr, true);
      await expect(
        factory.connect(owner).removePoolFromWhitelist(await token0.getAddress(), await token1.getAddress(), poolAddr)
      )
        .to.emit(factory, "PoolWhitelistUpdated")
        .withArgs(await token0.getAddress(), await token1.getAddress(), poolAddr, false);
    });
  });

  describe("deterministic addressing and multi-pool indexing", function () {
    it("computePoolAddress matches the address of the actually deployed pool", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      const t0 = await token0.getAddress();
      const t1 = await token1.getAddress();
      // Pre-compute the next pool's address with `pairPoolIndex = 0`,
      // then deploy and confirm the salt-derived prediction matches.
      const predicted = await factory.computePoolAddress(t0, t1, 0);
      await factory.connect(creator).createPoolAndAddLiquidity(
        t0,
        t1,
        {
          ...makeConfig(25, 1200),
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
        },
        SEED,
        SEED,
        creator.address
      );
      const actual = await factory.allPools(0);
      expect(actual.toLowerCase()).to.equal(predicted.toLowerCase());
    });

    it("two pools per pair get independent addresses and indices", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      const t0 = await token0.getAddress();
      const t1 = await token1.getAddress();

      await factory.connect(creator).createPoolAndAddLiquidity(
        t0,
        t1,
        {
          ...makeConfig(25, 1200),
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
        },
        SEED,
        SEED,
        creator.address
      );
      // A second pool with a different baseFee — the factory must
      // accept this and assign it pairPoolIndex = 1 (independent salt).
      await factory.connect(creator).createPoolAndAddLiquidity(
        t0,
        t1,
        {
          ...makeConfig(50, 1200),
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
        },
        SEED,
        SEED,
        creator.address
      );

      expect(await factory.getPoolCountForPair(t0, t1)).to.equal(2n);
      const pool0 = await factory.getPoolAt(t0, t1, 0);
      const pool1 = await factory.getPoolAt(t0, t1, 1);
      expect(pool0).to.not.equal(pool1);

      // Determinism still holds for index 1.
      const predicted1 = await factory.computePoolAddress(t0, t1, 1);
      expect(pool1.toLowerCase()).to.equal(predicted1.toLowerCase());
    });

    it("token-pair canonicalisation: input order does not affect the lookup", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      const t0 = await token0.getAddress();
      const t1 = await token1.getAddress();
      await factory.connect(creator).createPoolAndAddLiquidity(
        t0,
        t1,
        {
          ...makeConfig(25, 1200),
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
        },
        SEED,
        SEED,
        creator.address
      );
      // Either lookup order resolves to the same pool — `_getPairKey`
      // canonicalises (min, max) before hashing, and the resulting
      // index is order-invariant.
      const fwd = await factory.getPoolCountForPair(t0, t1);
      const rev = await factory.getPoolCountForPair(t1, t0);
      expect(fwd).to.equal(rev);
      expect(fwd).to.equal(1n);

      const poolFwd = await factory.getPoolAt(t0, t1, 0);
      const poolRev = await factory.getPoolAt(t1, t0, 0);
      expect(poolFwd).to.equal(poolRev);
    });

    it("seed amounts get re-paired to the canonical (sorted0, sorted1) order", async function () {
      const { creator, token0, token1, factory } = await loadFixture(deployFixture);
      const t0 = await token0.getAddress();
      const t1 = await token1.getAddress();
      // Pass the tokens in REVERSE (max, min) order with deliberately
      // asymmetric seed amounts. The factory must re-pair the amounts
      // to match the sorted slot order, so each token's pool reserve
      // is the one the caller asked for.
      const reversedFirst = t0 > t1 ? t0 : t1;
      const reversedSecond = t0 > t1 ? t1 : t0;
      const seedFirst = SEED;
      const seedSecond = SEED * 2n;
      await factory.connect(creator).createPoolAndAddLiquidity(
        reversedFirst,
        reversedSecond,
        {
          ...makeConfig(25, 1200),
          aWad: PRESET.aWad,
          lambdaWad: PRESET.lambdaWad,
        },
        seedFirst,
        seedSecond,
        creator.address
      );
      const poolAddr = await factory.allPools(0);
      const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddr);
      const meta = await pool.getPoolMetadata();
      // Sorted slots: token0 is the lower address, token1 is the higher.
      const sorted0 = t0 < t1 ? t0 : t1;
      const sorted1 = t0 < t1 ? t1 : t0;
      expect(meta.token0).to.equal(sorted0);
      expect(meta.token1).to.equal(sorted1);
      const [r0, r1] = await pool.getReserves();
      // The token corresponding to `reversedFirst` got `seedFirst`. If
      // `reversedFirst` ended up as token1 after sorting, its reserve
      // is `r1`; if it ended up as token0, it's `r0`. Equivalent in
      // either case: the seed for `reversedFirst` matches whichever
      // sorted slot the factory mapped it into.
      const reservedForReversedFirst = reversedFirst === sorted0 ? r0 : r1;
      const reservedForReversedSecond = reversedSecond === sorted0 ? r0 : r1;
      expect(reservedForReversedFirst).to.equal(seedFirst);
      expect(reservedForReversedSecond).to.equal(seedSecond);
    });
  });
});
