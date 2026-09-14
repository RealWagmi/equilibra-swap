import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;
const SEED = hre.ethers.parseEther("100000");

function makeConfig(aWad: bigint = PRESET.aWad, lambdaWad: bigint = PRESET.lambdaWad) {
  return {
    aWad,
    lambdaWad,
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

// ---------------------------------------------------------------------------
// Fixture: deploys 18-decimal token0/token1 + a third token so we can build
// two pools for the same pair (to exercise pagination + per-pair count).
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, creator] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const t0 = await Token.deploy("Token0", "TK0", 18);
  const t1 = await Token.deploy("Token1", "TK1", 18);
  await t0.waitForDeployment();
  await t1.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  await t0.mint(creator.address, SEED * 10n);
  await t1.mint(creator.address, SEED * 10n);
  const factoryAddr = await factory.getAddress();
  await t0.connect(creator).approve(factoryAddr, MaxUint256);
  await t1.connect(creator).approve(factoryAddr, MaxUint256);

  return { owner, creator, t0, t1, factory, poolImpl };
}

describe("EquilibraFactory: views + parameter validation", function () {
  // -------------------------------------------------------------------------
  // Decimal-too-large gate
  // -------------------------------------------------------------------------
  describe("token decimals validation", function () {
    it("reverts pool creation when a token's decimals > 18", async function () {
      const { owner, creator, factory, t0 } = await loadFixture(deployFixture);

      const Token = await hre.ethers.getContractFactory("MockERC20");
      // 19 decimals: factory's `_resolveTokenScale` must reject the pool.
      const fat = await Token.deploy("FatToken", "FAT", 19);
      await fat.waitForDeployment();
      await fat.mint(creator.address, SEED);
      await fat.connect(creator).approve(await factory.getAddress(), MaxUint256);

      void owner;
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await fat.getAddress(),
            { ...makeConfig(), aWad: PRESET.aWad, lambdaWad: PRESET.lambdaWad },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "TokenDecimalsTooLarge");
    });
  });

  // -------------------------------------------------------------------------
  // Alpha bounds (MIN / MAX)
  // -------------------------------------------------------------------------
  describe("(a, λ) bounds validation (two-knob kernel)", function () {
    it("rejects aWad below A_MIN_WAD (1e17)", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), aWad: 1n },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "InvalidA");
    });

    it("accepts A_MAX_WAD = WAD - 1 without truncating its packed value", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      const aWad = 10n ** 18n - 1n;
      await factory
        .connect(creator)
        .createPoolAndAddLiquidity(
          await t0.getAddress(),
          await t1.getAddress(),
          makeConfig(aWad),
          SEED,
          SEED,
          creator.address
        );
      const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
      expect((await pool.getCurveParams()).aWad).to.equal(aWad);
      expect(await pool.balanceOf(creator.address)).to.be.greaterThan(0n);
    });

    it("rejects aWad = WAD above the strict A_MAX_WAD = WAD - 1 boundary", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), aWad: 10n ** 18n },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "InvalidA");
    });

    it("accepts LAMBDA_MIN_WAD = 1e12 without truncating its packed value", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      const lambdaWad = 10n ** 12n;
      await factory
        .connect(creator)
        .createPoolAndAddLiquidity(
          await t0.getAddress(),
          await t1.getAddress(),
          { ...makeConfig(), lambdaWad },
          SEED,
          SEED,
          creator.address
        );
      const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
      expect((await pool.getCurveParams()).lambdaWad).to.equal(lambdaWad);
      expect(await pool.balanceOf(creator.address)).to.be.greaterThan(0n);
    });

    it("rejects one unit below LAMBDA_MIN_WAD (1e12)", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), lambdaWad: 10n ** 12n - 1n },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "InvalidLambda");
    });

    it("rejects lambdaWad above LAMBDA_MAX_WAD (1e18)", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), lambdaWad: 10n ** 18n + 1n },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "InvalidLambda");
    });
  });

  describe("repeg thresholds are independent of swap fees", function () {
    for (const mode of [
      { name: "dynamic 1-2 bps", baseFee: 2, feeRampBps: 9500, feeFloorBps: 1 },
      { name: "flat 1 bps", baseFee: 1, feeRampBps: 0, feeFloorBps: 1 },
    ]) {
      for (const side of ["repegThresholdToken1UpWad", "repegThresholdToken1DownWad"] as const) {
        for (const threshold of [1n, 10n ** 15n, 10n ** 18n - 1n]) {
          it("accepts " + side + "=" + threshold + " with " + mode.name + " and live repegs", async function () {
            const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
            const config = {
              ...makeConfig(),
              baseFee: mode.baseFee,
              feeRampBps: mode.feeRampBps,
              feeFloorBps: mode.feeFloorBps,
              [side]: threshold,
            };
            await factory
              .connect(creator)
              .createPoolAndAddLiquidity(
                await t0.getAddress(),
                await t1.getAddress(),
                config,
                SEED,
                SEED,
                creator.address
              );
            const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
            const stored = await pool.getFeeConfig();
            expect(stored.repegThresholdToken1UpWad).to.equal(config.repegThresholdToken1UpWad);
            expect(stored.repegThresholdToken1DownWad).to.equal(config.repegThresholdToken1DownWad);
            expect(stored.repegStepWad).to.equal(config.repegStepWad);
            expect(stored.repegShareBps).to.equal(5000);
          });
        }
      }
    }

    it("keeps disabled-repeg thresholds inert within the same absolute range", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await factory.connect(creator).createPoolAndAddLiquidity(
        await t0.getAddress(),
        await t1.getAddress(),
        {
          ...makeConfig(),
          repegShareBps: 0,
          repegThresholdToken1UpWad: 10n ** 18n - 1n,
          repegThresholdToken1DownWad: 10n ** 18n - 1n,
        },
        SEED,
        SEED,
        creator.address
      );
      const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
      expect((await pool.getFeeConfig()).repegShareBps).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ramp monotonicity guard: a live ramp must satisfy
  // `feeRampBps · (BPS − baseFee)² ≥ FEE_RAMP_GUARD_MULT · BPS · span²`,
  // otherwise the terminal rate can climb faster than the gross input grows
  // and a larger exact-in trade would return less output. The
  // `(BPS − baseFee)²` factor tightens the bound as the ceiling grows.
  // -------------------------------------------------------------------------
  describe("ramp monotonicity guard (FeeRampTooNarrow)", function () {
    // span = 100, base = 120 → minimum = ceil(12·1e4·100² / 9880²) = 13.
    const GUARD_CFG = { baseFee: 120, feeFloorBps: 20 };

    it("rejects a live ramp just below the guard minimum", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), ...GUARD_CFG, feeRampBps: 12 },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "FeeRampTooNarrow");
    });

    it("accepts a ramp exactly at the guard minimum (boundary inclusive)", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), ...GUARD_CFG, feeRampBps: 13 },
            SEED,
            SEED,
            creator.address
          )
      ).to.not.be.reverted;
    });

    it("rejects a high-ceiling config a span-only bound would admit", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      // span = 95 at ceiling 2000: `1 − f` headroom is only 80%, so the
      // base-aware minimum is 17 — ramp 11 (which clears the span-only
      // arithmetic `11·1e4 ≥ 12·95²`) must be refused.
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), baseFee: 2000, feeFloorBps: 1905, feeRampBps: 11 },
            SEED,
            SEED,
            creator.address
          )
      ).to.be.revertedWithCustomError(factory, "FeeRampTooNarrow");
    });

    it("skips the guard for flat-fee pools (feeRampBps = 0)", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      // Flat-fee mode has no gross-dependent rate, so any span deploys.
      await expect(
        factory
          .connect(creator)
          .createPoolAndAddLiquidity(
            await t0.getAddress(),
            await t1.getAddress(),
            { ...makeConfig(), baseFee: 2000, feeFloorBps: 0, feeRampBps: 0 },
            SEED,
            SEED,
            creator.address
          )
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Repeg threshold range validation: both direction dead-bands are in [1, 1e18).
  // -------------------------------------------------------------------------
  describe("repeg threshold range validation (InvalidRepegThreshold)", function () {
    for (const side of ["repegThresholdToken1UpWad", "repegThresholdToken1DownWad"] as const) {
      it(`rejects a zero ${side}`, async function () {
        const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
        await expect(
          factory
            .connect(creator)
            .createPoolAndAddLiquidity(
              await t0.getAddress(),
              await t1.getAddress(),
              { ...makeConfig(), [side]: 0n },
              SEED,
              SEED,
              creator.address
            )
        ).to.be.revertedWithCustomError(factory, "InvalidRepegThreshold");
      });

      it(`rejects ${side} at or above 1e18 (WAD)`, async function () {
        const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
        for (const threshold of [10n ** 18n, 10n ** 18n + 1n]) {
          await expect(
            factory
              .connect(creator)
              .createPoolAndAddLiquidity(
                await t0.getAddress(),
                await t1.getAddress(),
                { ...makeConfig(), repegShareBps: 0, [side]: threshold },
                SEED,
                SEED,
                creator.address
              )
          ).to.be.revertedWithCustomError(factory, "InvalidRepegThreshold");
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Pair-keyed views: getPoolsByPair / Page / Count / At
  // -------------------------------------------------------------------------
  describe("pair-keyed views", function () {
    async function withTwoPoolsFixture() {
      const ctx = await deployFixture();
      const t0Addr = await ctx.t0.getAddress();
      const t1Addr = await ctx.t1.getAddress();

      // Two pools per pair, distinguished only by the per-pair index
      // (the salt path uses `pairPoolIndex`).
      await ctx.factory
        .connect(ctx.creator)
        .createPoolAndAddLiquidity(
          t0Addr,
          t1Addr,
          { ...makeConfig(), aWad: PRESET.aWad, lambdaWad: PRESET.lambdaWad },
          SEED,
          SEED,
          ctx.creator.address
        );
      await ctx.factory
        .connect(ctx.creator)
        .createPoolAndAddLiquidity(t0Addr, t1Addr, { ...makeConfig(), baseFee: 25 }, SEED, SEED, ctx.creator.address);

      const pool0 = await ctx.factory.allPools(0);
      const pool1 = await ctx.factory.allPools(1);

      return { ...ctx, t0Addr, t1Addr, pool0, pool1 };
    }

    it("LP metadata carries the pair-local index; permit domains differ per pool", async function () {
      const { pool0, pool1 } = await withTwoPoolsFixture();
      const lp0 = await hre.ethers.getContractAt("EquilibraPool", pool0);
      const lp1 = await hre.ethers.getContractAt("EquilibraPool", pool1);

      // Two pools of one pair must be distinguishable by name alone.
      expect(await lp0.name()).to.match(/ #0$/);
      expect(await lp0.symbol()).to.match(/-0$/);
      expect(await lp1.name()).to.match(/ #1$/);
      expect(await lp1.symbol()).to.match(/-1$/);
      // End-to-end domain pin: recompute pool #1's separator from its
      // exact on-chain name (with the index suffix), the Solady permit
      // version "1", the chain id and the pool address — proving the
      // indexed name is what feeds the live EIP-712 domain.
      const expectedDomain = hre.ethers.TypedDataEncoder.hashDomain({
        name: await lp1.name(),
        version: "1",
        chainId: (await hre.ethers.provider.getNetwork()).chainId,
        verifyingContract: pool1,
      });
      expect(await lp1.DOMAIN_SEPARATOR()).to.equal(expectedDomain);
      expect(await lp0.DOMAIN_SEPARATOR()).to.not.equal(await lp1.DOMAIN_SEPARATOR());
    });

    it("getPoolsByPair returns both deployed pools, order-independent", async function () {
      const { factory, t0Addr, t1Addr, pool0, pool1 } = await withTwoPoolsFixture();
      const list = await factory.getPoolsByPair(t0Addr, t1Addr);
      expect(list).to.have.lengthOf(2);
      expect(list).to.include.members([pool0, pool1]);

      // Order-independent: swap the inputs and expect the same set.
      const listReversed = await factory.getPoolsByPair(t1Addr, t0Addr);
      expect(listReversed).to.have.lengthOf(2);
      expect(listReversed).to.include.members([pool0, pool1]);
    });

    it("getPoolCountForPair matches the deployed count", async function () {
      const { factory, t0Addr, t1Addr } = await withTwoPoolsFixture();
      expect(await factory.getPoolCountForPair(t0Addr, t1Addr)).to.equal(2n);
    });

    it("getPoolAt returns the pool at the requested per-pair index", async function () {
      const { factory, t0Addr, t1Addr, pool0, pool1 } = await withTwoPoolsFixture();
      const at0 = await factory.getPoolAt(t0Addr, t1Addr, 0);
      const at1 = await factory.getPoolAt(t0Addr, t1Addr, 1);
      expect([at0, at1]).to.include.members([pool0, pool1]);
    });

    describe("getPoolsByPairPage", function () {
      it("returns the requested page and the right `remaining` count", async function () {
        const { factory, t0Addr, t1Addr } = await withTwoPoolsFixture();

        const [p0, rem0] = await factory.getPoolsByPairPage(t0Addr, t1Addr, 0, 1);
        expect(p0).to.have.lengthOf(1);
        expect(rem0).to.equal(1n);

        const [p1, rem1] = await factory.getPoolsByPairPage(t0Addr, t1Addr, 1, 1);
        expect(p1).to.have.lengthOf(1);
        expect(rem1).to.equal(0n);
      });

      it("clamps an over-sized `limit` to the available tail", async function () {
        const { factory, t0Addr, t1Addr } = await withTwoPoolsFixture();
        const [page, remaining] = await factory.getPoolsByPairPage(t0Addr, t1Addr, 0, 100);
        expect(page).to.have.lengthOf(2);
        expect(remaining).to.equal(0n);
      });

      it("returns an empty page with `remaining = total - offset` when limit == 0", async function () {
        const { factory, t0Addr, t1Addr } = await withTwoPoolsFixture();
        const [page, remaining] = await factory.getPoolsByPairPage(t0Addr, t1Addr, 0, 0);
        expect(page).to.have.lengthOf(0);
        expect(remaining).to.equal(2n);
      });

      it("returns an empty page with `remaining = 0` when offset >= total", async function () {
        const { factory, t0Addr, t1Addr } = await withTwoPoolsFixture();
        const [page, remaining] = await factory.getPoolsByPairPage(t0Addr, t1Addr, 5, 10);
        expect(page).to.have.lengthOf(0);
        expect(remaining).to.equal(0n);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Whitelist views (already partially tested via FactoryIntegration; here we
  // exercise the per-pair list / count / at getters for non-empty whitelists).
  // -------------------------------------------------------------------------
  describe("whitelist views", function () {
    it("getWhitelistedPoolsByPair / Count / At enumerate whitelisted pools", async function () {
      const { owner, creator, factory, t0, t1 } = await loadFixture(deployFixture);
      const t0Addr = await t0.getAddress();
      const t1Addr = await t1.getAddress();

      await factory
        .connect(creator)
        .createPoolAndAddLiquidity(
          t0Addr,
          t1Addr,
          { ...makeConfig(), aWad: PRESET.aWad, lambdaWad: PRESET.lambdaWad },
          SEED,
          SEED,
          creator.address
        );
      const pool0 = await factory.allPools(0);

      // Initially empty.
      expect(await factory.getWhitelistedPoolsByPair(t0Addr, t1Addr)).to.have.lengthOf(0);
      expect(await factory.getWhitelistedPoolCountForPair(t0Addr, t1Addr)).to.equal(0n);

      await factory.connect(owner).addPoolToWhitelist(t0Addr, t1Addr, pool0);

      const list = await factory.getWhitelistedPoolsByPair(t0Addr, t1Addr);
      expect(list).to.have.lengthOf(1);
      expect(list[0]).to.equal(pool0);

      expect(await factory.getWhitelistedPoolCountForPair(t0Addr, t1Addr)).to.equal(1n);
      expect(await factory.getWhitelistedPoolAt(t0Addr, t1Addr, 0)).to.equal(pool0);
    });
  });

  // -------------------------------------------------------------------------
  // Creator view
  // -------------------------------------------------------------------------
  describe("getPoolsByCreator", function () {
    it("returns all pools deployed by a given creator", async function () {
      const { creator, factory, t0, t1 } = await loadFixture(deployFixture);
      const t0Addr = await t0.getAddress();
      const t1Addr = await t1.getAddress();

      await factory
        .connect(creator)
        .createPoolAndAddLiquidity(
          t0Addr,
          t1Addr,
          { ...makeConfig(), aWad: PRESET.aWad, lambdaWad: PRESET.lambdaWad },
          SEED,
          SEED,
          creator.address
        );
      await factory
        .connect(creator)
        .createPoolAndAddLiquidity(t0Addr, t1Addr, { ...makeConfig(), baseFee: 40 }, SEED, SEED, creator.address);

      const pools = await factory.getPoolsByCreator(creator.address);
      expect(pools).to.have.lengthOf(2);
      expect(pools[0]).to.equal(await factory.allPools(0));
      expect(pools[1]).to.equal(await factory.allPools(1));
    });
  });
});
