import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

// Constants mirrored from contracts/libraries/Constants.sol
const BPS = 10_000n;
const WAD = 10n ** 18n;
const MAX_REPEG_SHARE_BPS = 10_000n;
const DEFAULT_REPEG_SHARE_BPS = 5_000n;
// Absolute vp-unit guard (not scaled by genesis): ≈2e-8 of accepted vp0.
const REPEG_GAS_GUARD_WAD = 4n * 10n ** 10n;

type FixtureOpts = {
  baseFee?: number;
  feeRampBps?: number;
  feeFloorBps?: number;
  repegShareBps?: number;
  repegStepWad?: bigint;
  repegThresholdWad?: bigint;
  aWad?: bigint;
  lambdaWad?: bigint;
  protocolFeePercent?: number;
  seedWei?: bigint;
  emaPeriod?: number;
};

// ---------------------------------------------------------------------------
// Fixture: standalone pool + router with configurable `repegShareBps` and
// a wide concentration band (small `α`) so swaps actually move the
// marginal price enough
// to (a) accrue meaningful LP unit-value growth and (b) drag the EMA past
// `repegStepWad` without exotic seeding.
// ---------------------------------------------------------------------------
async function deployRepegFixture(opts: FixtureOpts = {}) {
  const baseFee = opts.baseFee ?? 100; // 1.00 %
  const feeRampBps = opts.feeRampBps ?? 0; // flat-fee path → simpler accounting
  const feeFloorBps = opts.feeFloorBps ?? 20;
  const repegShareBps = opts.repegShareBps ?? Number(DEFAULT_REPEG_SHARE_BPS);
  const repegStepWad = opts.repegStepWad ?? PRESET.repegStepWad;
  // Activation dead-band defaults to the resolved step so every fixture
  // keeps the coupled step==threshold behaviour it was written for.
  const repegThresholdWad = opts.repegThresholdWad ?? repegStepWad;
  const aWad = opts.aWad ?? PRESET.aWad;
  const lambdaWad = opts.lambdaWad ?? PRESET.lambdaWad;
  const emaPeriod = opts.emaPeriod ?? 1200;

  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token0", "TK0", 18);
  const tokenB = await Token.deploy("Token1", "TK1", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const tokenAAddr = await tokenA.getAddress();
  const tokenBAddr = await tokenB.getAddress();
  const [token0, token1] = tokenAAddr.toLowerCase() < tokenBAddr.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  // Use the `MockEquilibraPool` test subclass as the pool implementation.
  // It inherits production `EquilibraPool` verbatim and re-exposes only
  // the handful of `internal` helpers (`_computeLpUnitValueWad`,
  // `_toWadByScale`, `_normalizeQuoteDown`, `_computeSegmentAMax`)
  // the regression tests need, as `exposed_*` external functions.
  const PoolImpl = await hre.ethers.getContractFactory("MockEquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  await factory.setProtocolFee(opts.protocolFeePercent ?? 0);

  const million = hre.ethers.parseEther("1000000");
  const seed = opts.seedWei ?? million;
  await token0.mint(owner.address, million * 2n);
  await token1.mint(owner.address, million * 2n);
  await token0.mint(trader.address, million);
  await token1.mint(trader.address, million);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);

  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad,
      lambdaWad,
      baseFee,
      emaPeriod,
      repegStepWad,
      repegThresholdToken1UpWad: repegThresholdWad,
      repegThresholdToken1DownWad: repegThresholdWad,
      feeRampBps,
      feeFloorBps,
      repegShareBps,
    },
    seed,
    seed,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  // The clone is bytecode-identical to `MockEquilibraPool`, so attaching
  // the mock ABI gives tests access to `exposed_computeLpUnitValueWadAtPriceScale` &
  // friends without changing any production behaviour.
  const pool = await hre.ethers.getContractAt("MockEquilibraPool", poolAddress);

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  await token0.connect(trader).approve(routerAddr, MaxUint256);
  await token1.connect(trader).approve(routerAddr, MaxUint256);

  return {
    owner,
    trader,
    token0,
    token1,
    factory,
    pool,
    router,
    poolAddress,
    repegShareBps: BigInt(repegShareBps),
    repegStepWad,
    repegThresholdWad,
  };
}

async function defaultFixture() {
  return deployRepegFixture();
}

async function disabledShareFixture() {
  return deployRepegFixture({ repegShareBps: 0 });
}

// Share==0 pool used to pin the L-4 invariant under mint/burn churn.
// A small (0.001-token) seed is the smallest the WAD swap math stays
// well-conditioned at; even here the per-cycle `_reanchorLpUnitValue`
// creep is far below the gas guard (the bug needs sub-1e10-wei reserves,
// where swaps themselves revert), so we are pinning the *guarantee*, not
// triggering the old bug — which is unreachable on any functional pool.
async function disabledShareChurnFixture() {
  return deployRepegFixture({
    repegShareBps: 0,
    seedWei: 10n ** 15n,
    repegStepWad: 10n ** 13n,
  });
}

async function fullShareFixture() {
  return deployRepegFixture({ repegShareBps: Number(MAX_REPEG_SHARE_BPS) });
}

// Helper: trigger the EMA to drift well past `repegStepWad` so the
// activation gate inside `_tryAutoRepeg` does not block the test.
// Uses the router's V3-style `exactInputSingle` so the test exercises the
// real callback flow rather than a synthetic `pool.swap()` call.
async function pumpEmaWithBigSwap(router: any, trader: any, tokenIn: any, tokenOut: any, amountInOverride?: bigint) {
  // 1 % of the seeded reserve — large enough to push the marginal price
  // well past `repegStepWad = 0.1 %` and to accrue a meaningful LP unit
  // value delta on the inline LP fee.
  const amountIn = amountInOverride ?? hre.ethers.parseEther("10000");
  const tokenInAddr = await tokenIn.getAddress();
  const tokenOutAddr = await tokenOut.getAddress();
  return router.connect(trader).exactInputSingle({
    tokenIn: tokenInAddr,
    tokenOut: tokenOutAddr,
    poolIndex: 0,
    recipient: trader.address,
    amountIn,
    amountOutMinimum: 0n,
    deadline: MaxUint256,
  });
}

describe("RepegProfitShare", () => {
  // -------------------------------------------------------------------
  // Boundary / configuration semantics.
  // -------------------------------------------------------------------
  describe("Configuration", () => {
    it("rejects repegShareBps > MAX_REPEG_SHARE_BPS at the factory", async () => {
      const [owner] = await hre.ethers.getSigners();
      const Token = await hre.ethers.getContractFactory("MockERC20");
      const tokenA = await Token.deploy("Token0", "TK0", 18);
      const tokenB = await Token.deploy("Token1", "TK1", 18);
      await tokenA.waitForDeployment();
      await tokenB.waitForDeployment();

      const PoolImpl = await hre.ethers.getContractFactory("MockEquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();

      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
      await factory.waitForDeployment();

      const million = hre.ethers.parseEther("1000000");
      await tokenA.mint(owner.address, million);
      await tokenB.mint(owner.address, million);
      await tokenA.approve(await factory.getAddress(), MaxUint256);
      await tokenB.approve(await factory.getAddress(), MaxUint256);

      await expect(
        factory.createPoolAndAddLiquidity(
          await tokenA.getAddress(),
          await tokenB.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 30,
            emaPeriod: 600,
            repegStepWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
            feeRampBps: 0,
            feeFloorBps: 20,
            repegShareBps: Number(MAX_REPEG_SHARE_BPS) + 1,
          },
          million,
          million,
          owner.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidRepegShare");
    });

    it("persists the configured repegShareBps in pool storage", async () => {
      // Strict on-chain check via the getter — duplicates the
      // `PoolCreated.config.repegShareBps` field that the factory
      // already emits at deploy time, so this is the only place that
      // needs to assert "the storage slot truly took the value".
      const { pool } = await loadFixture(defaultFixture);
      expect((await pool.getFeeConfig()).repegShareBps).to.equal(DEFAULT_REPEG_SHARE_BPS);
    });

    it("getter returns the stored repegShareBps", async () => {
      const { pool } = await loadFixture(defaultFixture);
      expect((await pool.getFeeConfig()).repegShareBps).to.equal(DEFAULT_REPEG_SHARE_BPS);

      const { pool: pool0 } = await loadFixture(disabledShareFixture);
      expect((await pool0.getFeeConfig()).repegShareBps).to.equal(0n);

      const { pool: poolFull } = await loadFixture(fullShareFixture);
      expect((await poolFull.getFeeConfig()).repegShareBps).to.equal(MAX_REPEG_SHARE_BPS);
    });
  });

  // -------------------------------------------------------------------
  // LP unit-value bookkeeping semantics — genesis / accrual / re-anchor.
  // -------------------------------------------------------------------
  describe("LP unit-value growth", () => {
    it("seeds genesis vp0 == vpLive and zero growth on the first mint", async () => {
      const { pool } = await loadFixture(defaultFixture);
      const lp = await pool.getLpValueState();
      expect(lp.genesisWad).to.be.greaterThan(0n);
      expect(lp.unitValueWad).to.equal(lp.genesisWad);
      expect(lp.growthWad).to.equal(0n);
    });

    it("accrues monotonic growth across swaps and emits LpValueGrowthAccrued", async () => {
      const { pool, router, trader, token0, token1 } = await loadFixture(defaultFixture);
      const lpBefore = await pool.getLpValueState();
      const vpBefore = lpBefore.unitValueWad;
      const growthBefore = lpBefore.growthWad;

      const tx = await pumpEmaWithBigSwap(router, trader, token0, token1);
      const receipt = await tx.wait();

      const lpAfter = await pool.getLpValueState();
      const vpAfter = lpAfter.unitValueWad;
      const growthAfter = lpAfter.growthWad;

      // High-water mark + cumulative accumulator must both rise by the same
      // delta — that is the contract invariant baked into
      // `_accrueLpValueGrowth`.
      const deltaVp = vpAfter - vpBefore;
      const deltaGrowth = growthAfter - growthBefore;
      expect(deltaVp).to.be.greaterThan(0n);
      expect(deltaGrowth).to.equal(deltaVp);

      const evt = receipt!.logs
        .map((l: any) => {
          try {
            return pool.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter((e: any) => e?.name === "LpValueGrowthAccrued");
      expect(evt.length).to.equal(1);
      expect(evt[0]!.args.deltaWad).to.equal(deltaVp);
      expect(evt[0]!.args.totalGrowthWad).to.equal(growthAfter);

      // Idempotency: a second tiny swap in the *opposite* direction must not
      // shrink either the high-water mark or the growth accumulator
      // (defended by the `vpNow <= vpLast` short-circuit in the contract).
      // We don't pump back to the anchor — just check the gate behaves.
      const lpMid = await pool.getLpValueState();
      const growthBefore2 = lpMid.growthWad;
      const vp2 = lpMid.unitValueWad;
      const tinyOpposite = hre.ethers.parseEther("100");
      await pumpEmaWithBigSwap(router, trader, token1, token0, tinyOpposite);
      const lpEnd = await pool.getLpValueState();
      expect(lpEnd.unitValueWad).to.be.greaterThanOrEqual(vp2);
      expect(lpEnd.growthWad).to.be.greaterThanOrEqual(growthBefore2);
    });
  });

  // -------------------------------------------------------------------
  // Repeg gate semantics — share boundaries + gas guard floor.
  // -------------------------------------------------------------------
  describe("Auto-repeg gate", () => {
    it("never repegs when repegShareBps == 0", async () => {
      const { pool, router, trader, token0, token1 } = await loadFixture(disabledShareFixture);
      const anchor0 = (await pool.getOracleState()).priceScaleWad;

      // Build up several swaps + roll the block forward so the once-per-block
      // guard does not blanket the gate. Even with healthy growth, share=0
      // pins `keepBps = BPS = 10000`, so threshold = vp0 + growth × 1.0,
      // i.e. the gate stays shut by construction.
      for (let i = 0; i < 5; i++) {
        await pumpEmaWithBigSwap(router, trader, token0, token1);
        await time.increase(1);
      }
      const anchor1 = (await pool.getOracleState()).priceScaleWad;
      expect(anchor1).to.equal(anchor0);
    });

    // L-4: the "disabled by construction" guarantee relied on
    // `vpBefore ≤ vpGenesis + growth`, but `_reanchorLpUnitValue` creeps
    // the high-water mark above that bound on every proportional
    // mint/burn (floor rounding favours remaining LPs and is NOT booked
    // into `_lpValueGrowthWad`). The explicit `_repegShareBps == 0`
    // short-circuit makes the guarantee exact regardless of creep. We pin
    // the invariant here under EMA drift + mint/burn churn + swaps: the
    // anchor must never move and no `PriceScaleUpdated` may ever fire on a
    // share==0 pool. (The creep only clears the gas guard on sub-1e10-wei
    // reserves where the swap math itself reverts, so this enforces the
    // guarantee rather than reproducing the now-blocked trigger.)
    it("never repegs when repegShareBps == 0 even after mint/burn churn (L-4)", async () => {
      const { pool, router, trader, token0, token1, owner } = await loadFixture(disabledShareChurnFixture);
      const seed = 10n ** 15n;
      const routerAddr = await router.getAddress();
      await token0.connect(owner).approve(routerAddr, MaxUint256);
      await token1.connect(owner).approve(routerAddr, MaxUint256);
      const token0Addr = await token0.getAddress();
      const token1Addr = await token1.getAddress();

      const anchor0 = (await pool.getOracleState()).priceScaleWad;
      let sawRepeg = false;
      const scanForRepeg = async (txPromise: Promise<any>) => {
        const receipt = await (await txPromise).wait();
        for (const l of receipt.logs) {
          if (l.address.toLowerCase() !== (pool.target as string).toLowerCase()) continue;
          try {
            if (pool.interface.parseLog({ topics: [...l.topics], data: l.data })?.name === "PriceScaleUpdated") {
              sawRepeg = true;
            }
          } catch {
            /* not a pool event */
          }
        }
      };

      // (1) Drive the EMA past the activation step.
      for (let i = 0; i < 4; i++) {
        await scanForRepeg(pumpEmaWithBigSwap(router, trader, token0, token1, seed / 50n));
        await time.increase(300);
      }

      // (2) Mint/burn churn — exercises the `_reanchorLpUnitValue` path
      // that the watermark-creep relied on.
      const add = seed / 100n;
      for (let i = 0; i < 12; i++) {
        const sharesBefore = await pool.balanceOf(owner.address);
        await router.connect(owner).addLiquidity({
          tokenA: token0Addr,
          tokenB: token1Addr,
          poolIndex: 0,
          recipient: owner.address,
          amountADesired: add,
          amountBDesired: add,
          minShares: 0,
          deadline: MaxUint256,
        });
        const minted = (await pool.balanceOf(owner.address)) - sharesBefore;
        if (minted > 0n) {
          await pool.connect(owner).removeLiquidity(minted, 0, 0, owner.address);
        }
      }

      // (3) More swaps across fresh blocks, both directions.
      for (let i = 0; i < 4; i++) {
        await scanForRepeg(pumpEmaWithBigSwap(router, trader, token0, token1, seed / 50n));
        await time.increase(1);
        await scanForRepeg(pumpEmaWithBigSwap(router, trader, token1, token0, seed / 50n));
        await time.increase(1);
      }

      const anchorN = (await pool.getOracleState()).priceScaleWad;
      expect(anchorN, "priceScale moved on a repegShareBps==0 pool (L-4)").to.equal(anchor0);
      expect(sawRepeg, "a PriceScaleUpdated fired on a repegShareBps==0 pool (L-4)").to.equal(false);

      // Post-hoc sweep over the WHOLE run — covers the mint/burn churn
      // txs of section (2), which `scanForRepeg` does not wrap, and
      // would also catch a transient move-and-revert the end-state
      // anchor equality above cannot see.
      const allRepegs = await pool.queryFilter(pool.filters.PriceScaleUpdated(), 0, "latest");
      expect(allRepegs.length, "PriceScaleUpdated found in full log sweep (L-4)").to.equal(0);
    });

    it("opens the gate once growth clears the gas guard with repegShareBps == 10000", async () => {
      const { pool, router, trader, token0, token1 } = await loadFixture(fullShareFixture);
      const anchor0 = (await pool.getOracleState()).priceScaleWad;
      const gasGuard = REPEG_GAS_GUARD_WAD;

      // First swap is large enough (5 % of the seeded reserve) to push the
      // marginal price well past `repegStepWad = 0.1 %` and to accrue
      // meaningful LP-unit-value growth on the inline LP fee.
      const bigIn = hre.ethers.parseEther("50000");
      await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);

      // Let the EMA catch up to the new spot — by `5 × emaPeriod` the
      // exponential weighting on the post-swap spot is well above 95 %,
      // so the relative deviation `|ema/anchor − 1|` exceeds
      // `repegStepWad`.
      await time.increase(1200 * 5);

      // Second swap: drives the EMA past `repegStepWad` (already there)
      // and lets the gate commit on this same call. share = 10000 ⇒
      // threshold = vp0, so any growth above `gasGuard` opens the gate.
      await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      const anchor1 = (await pool.getOracleState()).priceScaleWad;

      expect(anchor1).to.not.equal(anchor0);
      const growth = (await pool.getLpValueState()).growthWad;
      expect(growth).to.be.greaterThan(gasGuard);
    });

    it("default 50/50 split keeps the gate above genesis + half of growth", async () => {
      const { pool, router, trader, token0, token1 } = await loadFixture(defaultFixture);
      const vp0 = (await pool.getLpValueState()).genesisWad;
      const anchor0 = (await pool.getOracleState()).priceScaleWad;

      // Pump growth in the same direction across several swaps + advance
      // one block per swap to clear the once-per-block guard.
      for (let i = 0; i < 4; i++) {
        await pumpEmaWithBigSwap(router, trader, token0, token1);
        await time.increase(1);
      }
      const anchorN = (await pool.getOracleState()).priceScaleWad;
      const lpAfterN = await pool.getLpValueState();
      const vpLive = lpAfterN.unitValueWad;
      const growth = lpAfterN.growthWad;

      // Whether the gate fires or not, the cumulative growth accumulator
      // must never decrease (repegs latch `vpAfter` into the high-water
      // mark but leave `lpValueGrowthWad` intact).
      expect(growth).to.be.greaterThan(0n);
      // 50/50 invariant: the live unit value must always sit at least at
      // the half-of-growth threshold (otherwise an in-flight repeg would
      // have moved the threshold above the live value, which is forbidden
      // by the post-gate `vpAfter >= threshold` check).
      const threshold = vp0 + growth / 2n;
      expect(vpLive).to.be.greaterThanOrEqual(threshold);
      // And anchor either followed the EMA (gate fired) or stayed pinned —
      // both branches are allowed; the regression here is on the
      // *invariant*, not the directional outcome.
      if (anchorN !== anchor0) {
        const evtFilter = pool.filters.PriceScaleUpdated();
        const evts = await pool.queryFilter(evtFilter, 0, "latest");
        expect(evts.length).to.be.greaterThan(0);
      }
    });

    it("respects the once-per-block guard regardless of the share setting", async () => {
      // Two swaps at the same block.timestamp must not produce more than
      // one anchor move, even with `share = 10000` and an EMA that is
      // begging for a step.
      const { pool, router, trader, token0, token1 } = await loadFixture(fullShareFixture);

      const bigIn = hre.ethers.parseEther("50000");
      // Prime the pool with a big swap + let the EMA catch up so the
      // very next swap is going to clear both gates and try to commit
      // a repeg. We deliberately do NOT trigger any repegs here yet —
      // `time.increase` only bumps the next-block timestamp; no swap
      // is executed during the wait.
      await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      await time.increase(1200 * 5);

      const repegEventsPre = await pool.queryFilter(pool.filters.PriceScaleUpdated(), 0, "latest");

      // Now disable auto-mining and submit BOTH swaps before we mine. They
      // will share a single block (and a single timestamp).
      await hre.network.provider.send("evm_setAutomine", [false]);
      try {
        await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
        await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
        await hre.network.provider.send("evm_mine", []);
      } finally {
        await hre.network.provider.send("evm_setAutomine", [true]);
      }

      const repegEventsPost = await pool.queryFilter(pool.filters.PriceScaleUpdated(), 0, "latest");

      // Sanity: the first of the two in-block swaps must commit a repeg
      // (otherwise the test reduces to a no-op and is not actually
      // probing the once-per-block guard).
      const firedInBlock = repegEventsPost.length - repegEventsPre.length;
      expect(firedInBlock).to.equal(1);
    });

    it("fires on the same swap that breaches the threshold", async () => {
      // Once the EMA has drifted past the activation step and growth
      // sits above the gas guard, a single breach swap must clear all
      // gates and emit `PriceScaleUpdated` inside its own tx. Earlier
      // revisions latched the threshold on pre-swap reserves and
      // forced the gate to wait for the *next* swap; the M-02 fix
      // moved the gate behind `_accrueLpValueGrowth`, so the breach
      // swap can now commit its own repeg.
      const { pool, router, trader, token0, token1 } = await loadFixture(fullShareFixture);

      // Prime: one big swap drives the post-swap spot well above
      // `anchor + repegStepWad`. The prime itself cannot repeg because
      // `_updateEma` runs on PRE-swap reserves (so the genesis EMA is
      // still pinned to anchor) and `_lastRepegTs == genesis ts`.
      const bigIn = hre.ethers.parseEther("50000");
      await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);

      // Let the EMA absorb the new spot. After 5 × emaPeriod the
      // weighting on the post-prime spot is well above 95 %, so
      // `|ema/anchor − 1|` strictly exceeds `repegStepWad`.
      await time.increase(1200 * 5);

      const anchorBefore = (await pool.getOracleState()).priceScaleWad;
      const repegEventsPre = await pool.queryFilter(pool.filters.PriceScaleUpdated(), 0, "latest");

      // Breach swap: `_updateEma` now sees a wildly off-anchor spot,
      // the activation gate opens on this very call, and the new
      // growth booked by `_accrueLpValueGrowth` is enough to clear
      // both Gate 1 and Gate 2 → repeg commits in-tx.
      const tx = await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      const receipt = await tx.wait();

      const repegEventsPost = await pool.queryFilter(pool.filters.PriceScaleUpdated(), 0, "latest");
      const firedInTx = repegEventsPost.length - repegEventsPre.length;
      expect(firedInTx).to.equal(1);

      // The repeg must belong to *this* tx — same tx hash — so we
      // know the gate opened mid-swap rather than on a hypothetical
      // follow-up.
      const repegEvt = repegEventsPost[repegEventsPost.length - 1];
      expect(repegEvt.transactionHash).to.equal(receipt!.hash);

      const anchorAfter = (await pool.getOracleState()).priceScaleWad;
      expect(anchorAfter).to.not.equal(anchorBefore);
    });

    it("uses post-swap reserves for IL math, not pre-swap", async () => {
      // Bit-exact regression: after a successful repeg the latched
      // `lpUnitValueWad` must equal `_computeLpUnitValueWad(r_post,
      // anchorNew, supply)`. Computing the same metric over the
      // pre-swap reserves under the same anchor must give a different
      // number (otherwise the check is meaningless), so we assert the
      // strict inequality too.
      const { pool, router, trader, token0, token1 } = await loadFixture(fullShareFixture);

      // Prime the pool: one big swap to pump the EMA and accrue plenty
      // of `lpValueGrowthWad`, then a forwards-time wait so the
      // EMA is well past `repegStepWad`. Critically, no repeg yet
      // because it's the very first swap and `_lastRepegTs ==
      // block.timestamp`.
      const bigIn = hre.ethers.parseEther("50000");
      await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      await time.increase(1200 * 5);

      // Snapshot the pre-swap state so we can replay
      // `_computeLpUnitValueWad` against it later.
      const [reserve0Pre, reserve1Pre] = await pool.getReserves();
      const anchorPre = (await pool.getOracleState()).priceScaleWad;
      const supplyPre = await pool.totalSupply();

      // Sanity: the prime did not commit a repeg (the once-per-block
      // guard latched on genesis time). If it had we would have lost
      // our pre-swap snapshot.
      expect((await pool.getOracleState()).priceScaleWad).to.equal(anchorPre);

      // The breach swap. With share=10000 and growth ≫ gas guard the
      // gate opens and `_tryAutoRepeg` commits inside this swap.
      const tx = await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      await tx.wait();

      const [reserve0Post, reserve1Post] = await pool.getReserves();
      const anchorNew = (await pool.getOracleState()).priceScaleWad;
      const supplyAfter = await pool.totalSupply();
      const vpAfterActual = (await pool.getLpValueState()).unitValueWad;

      // The repeg must have happened (otherwise the rest of the
      // assertion is vacuous).
      expect(anchorNew).to.not.equal(anchorPre);
      // No mint/burn during the swap → supply is unchanged.
      expect(supplyAfter).to.equal(supplyPre);
      // The swap moved reserves; otherwise we cannot tell whether the
      // probe is sensitive to the (r_pre vs r_post) distinction.
      expect(reserve0Post).to.not.equal(reserve0Pre);
      expect(reserve1Post).to.not.equal(reserve1Pre);

      // Replay `_computeLpUnitValueWad` over both states using the
      // `MockEquilibraPool` wrapper; the production code is exercised
      // verbatim, no formula is duplicated in the test.
      const vpFromPostReserves = await pool.exposed_computeLpUnitValueWadAtPriceScale(
        reserve0Post,
        reserve1Post,
        anchorNew,
        supplyAfter
      );
      const vpFromPreReserves = await pool.exposed_computeLpUnitValueWadAtPriceScale(
        reserve0Pre,
        reserve1Pre,
        anchorNew,
        supplyAfter
      );

      expect(vpAfterActual).to.equal(vpFromPostReserves);
      expect(vpAfterActual).to.not.equal(vpFromPreReserves);
    });

    it("LP unit-value metric is a pure function of `(reserves, anchor, supply, cp)`", async () => {
      // Replay the exact post-cascade configuration (swap → repeg →
      // swap) and verify two structural properties of
      // `_computeLpUnitValueWad`:
      //   1) the latched `unitValueWad` matches the explicit-`cp`
      //      probe bit-for-bit (the metric is deterministic from the
      //      visible state),
      //   2) the metric is invariant under the only "stale" handle a
      //      caller could plausibly forge — the pre-repeg `cp` (which
      //      is identical to the post-repeg `cp` because repegs do not
      //      mutate `α`).
      const { pool, router, trader, token0, token1 } = await loadFixture(fullShareFixture);

      const bigIn = hre.ethers.parseEther("50000");
      await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      await time.increase(1200 * 5);

      const anchorBefore = (await pool.getOracleState()).priceScaleWad;

      const tx = await pumpEmaWithBigSwap(router, trader, token0, token1, bigIn);
      await tx.wait();

      const anchorAfter = (await pool.getOracleState()).priceScaleWad;
      const vpAfterActual = (await pool.getLpValueState()).unitValueWad;
      const [reserve0Post, reserve1Post] = await pool.getReserves();
      const supplyAfter = await pool.totalSupply();

      // Sanity: the repeg must have fired (otherwise the assertion
      // lives in a code path the production swap path never hits).
      expect(anchorAfter).to.not.equal(anchorBefore);

      const cpRaw = await pool.getCurveParams();

      // Determinism probe: the metric is a pure function of
      //   `(reserves, priceScale, supply, aWad, lambdaWad)`.
      // Two probes must converge to the latched `vpAfterActual`:
      //   1) explicit-cs overload — exercises the parameterised ABI.
      //   2) storage overload at the post-repeg priceScale (live `cp`).
      const vpFromCs = await pool["exposed_computeLpUnitValueWadWithCs"](
        reserve0Post,
        reserve1Post,
        supplyAfter,
        cpRaw.aWad,
        cpRaw.lambdaWad,
        anchorAfter
      );
      expect(vpFromCs).to.equal(vpAfterActual);

      const vpFromStorage = await pool.exposed_computeLpUnitValueWadAtPriceScale(
        reserve0Post,
        reserve1Post,
        anchorAfter,
        supplyAfter
      );
      expect(vpFromStorage).to.equal(vpAfterActual);
    });

    it("phantom-vp drift is identically zero on a deeply unbalanced pool", async () => {
      // Anti-regression for the historical cascade in
      // `run_20260428_095841`. We do NOT trigger a repeg here — we
      // snapshot the pool, *project* a candidate post-repeg anchor,
      // and verify that the metric is fully determined by
      // `(reserves, anchor_candidate, supply, cp)`: the storage and
      // the `cp`-overload must converge bit-for-bit, and the value
      // must be independent of pool-side state outside that
      // quadruple. The original cascade was loudest at small
      // `α` (the unclamped `aSeg < min(x, y)` branch); we keep the
      // regime — small base fee, deeply unbalanced reserves,
      // candidate anchor advance — so any future refactor that
      // re-introduces a hidden segment dependency surfaces
      // immediately.
      const cascadeFixture = async () =>
        deployRepegFixture({
          repegStepWad: hre.ethers.parseUnits("5", 15),
          // Auto-repeg disabled: the vp-metric probes below are
          // share-independent, no repeg is (or ever was) triggered —
          // at 5 bps the growth budget is ~nil — and a live share with
          // a 5e15 step on a 5-bps flat pool now trips the factory's
          // stall guard (cap = baseFee·1e14 = 5e14).
          repegShareBps: 0,
          baseFee: 5, // 5 bps — matches the cascade run
          feeRampBps: 0,
          feeFloorBps: 0,
        });
      const { pool, router, trader, token0, token1 } = await loadFixture(cascadeFixture);

      // Drive the pool deeply unbalanced — five 100k-ETH swaps in the
      // same direction roll the inventory ~50% off centre.
      for (let i = 0; i < 5; i++) {
        await pumpEmaWithBigSwap(router, trader, token0, token1, hre.ethers.parseEther("100000"));
        await time.increase(60);
      }

      const [r0, r1] = await pool.getReserves();
      const supply = await pool.totalSupply();
      const oracle = await pool.getOracleState();
      const anchorOld = oracle.priceScaleWad;
      const cpRaw = await pool.getCurveParams();

      const stepWad = hre.ethers.parseUnits("5", 15);
      const anchorNew = (anchorOld * (WAD + stepWad)) / WAD;

      // Three independent probes of the metric at the SAME state under
      // Mock helpers:
      //   1) `withCs` overload — exercises the explicit-parameter ABI
      //      used by `_tryAutoRepeg`'s post-state computation.
      //   2) `atPriceScale` overload — reads (a, λ) from storage,
      //      counterfactual priceScale.
      //   3) `atPriceScale` at the *original* priceScale — sanity check.
      const vpExplicitCp = await pool["exposed_computeLpUnitValueWadWithCs"](
        r0,
        r1,
        supply,
        cpRaw.aWad,
        cpRaw.lambdaWad,
        anchorNew
      );
      const vpStorageNewAnchor = await pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, anchorNew, supply);
      const vpStorageOldAnchor = await pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, anchorOld, supply);

      // Bit-exact equality between the two overloads at the candidate
      // anchor: the metric is fully determined by the public state.
      // `drift = 0` rules out the historical "phantom-vp" bug class.
      expect(vpExplicitCp).to.equal(vpStorageNewAnchor);

      // The anchor MUST move the metric (otherwise the assertion above
      // is vacuous — both probes would return the same number for any
      // anchor). The absolute contract guard is comfortably crossed by a
      // 0.5% anchor step.
      const anchorDelta =
        vpStorageOldAnchor > vpStorageNewAnchor
          ? vpStorageOldAnchor - vpStorageNewAnchor
          : vpStorageNewAnchor - vpStorageOldAnchor;
      expect(anchorDelta).to.be.greaterThan(REPEG_GAS_GUARD_WAD);
    });

    it("LP unit-value metric drift on a realistic repeg step is bounded and IL-shaped", async () => {
      // LP unit value is `vp = 2·L_eq · √(priceScale·WAD) / supply`
      // under the symmetric coord change `(x/√p, y·√p)`. A priceScale
      // step on FIXED reserves rotates both math-space axes
      // (product preserved, `L_eq` from the cubic isn't a pure
      // function of the product alone). The `√(priceScale·WAD)`
      // compensator restores diagonal invariance, but off-diagonal
      // states retain a residual drift that scales with the depth-cost
      // the repeg would actually realise — which is what auto-repeg
      // gate-2 is built to catch. We bound the drift below a real-
      // world IL budget and require it to remain symmetric (a real
      // IL signal, not an arithmetic artefact biased to one side).
      const { pool, router, trader, token0, token1 } = await loadFixture(fullShareFixture);

      // Drive a single big swap so reserves drift away from the pure
      // genesis 1:1 balance; vp probes run over a *realistic* live pool
      // configuration rather than the trivially symmetric initial state.
      await pumpEmaWithBigSwap(router, trader, token0, token1, hre.ethers.parseEther("50000"));

      const [r0, r1] = await pool.getReserves();
      const supply = await pool.totalSupply();
      const anchorOld = (await pool.getOracleState()).priceScaleWad;

      const stepWad = hre.ethers.parseUnits("5", 15); // 0.5 % per step
      const anchorUp = (anchorOld * (WAD + stepWad)) / WAD;
      const anchorDown = (anchorOld * (WAD - stepWad)) / WAD;

      const vpBase = await pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, anchorOld, supply);
      const vpUp = await pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, anchorUp, supply);
      const vpDown = await pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, anchorDown, supply);

      // Sanity: supply / metric are non-degenerate.
      expect(vpBase).to.be.greaterThan(0n);

      // Drift in parts-per-million × 100 (so 50 ppm = 50).
      const driftUp = vpUp >= vpBase ? vpUp - vpBase : vpBase - vpUp;
      const driftDown = vpDown >= vpBase ? vpDown - vpBase : vpBase - vpDown;
      const ppmUp = (driftUp * 1_000_000n) / vpBase;
      const ppmDown = (driftDown * 1_000_000n) / vpBase;

      // NOTE. Under the legacy symmetric coord change `(x/√p, y·√p)` a
      // priceScale move on FIXED reserves rotates BOTH math-space axes
      // (the product `xMath · yMath` is preserved, but `L_eq` recovered
      // from the cubic isn't a pure function of the product alone).
      // The `√(priceScale·WAD)` compensator nominally restores the
      // diagonal invariance, but off-diagonal states retain a residual
      // drift that scales with the depth-cost the repeg would actually
      // realise — which is *what auto-repeg's gate-2 is built to
      // catch*. So we bound the drift instead of claiming exact
      // invariance:
      //   * absolute drift ≤ 1 % of vp (10 000 ppm) — well below the
      //     gate threshold for any realistic single 0.5 % step,
      //   * symmetric within 50 % of magnitude — confirms the drift is
      //     a real IL signal, not an arithmetic artefact biased to one
      //     side.
      const PPM_BOUND = 10_000n;
      expect(ppmUp).to.be.lessThan(
        PPM_BOUND,
        `+0.5 %% priceScale step drifted vp by ${ppmUp} ppm — exceeds the ${PPM_BOUND}-ppm IL bound`
      );
      expect(ppmDown).to.be.lessThan(
        PPM_BOUND,
        `−0.5 %% priceScale step drifted vp by ${ppmDown} ppm — exceeds the ${PPM_BOUND}-ppm IL bound`
      );
      const symRatio = ppmUp >= ppmDown ? (ppmUp * 100n) / (ppmDown + 1n) : (ppmDown * 100n) / (ppmUp + 1n);
      expect(symRatio).to.be.lessThan(
        200n,
        `up/down drift asymmetry ${symRatio} % — should stay within 2× of each other`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Threshold-formula invariant: rebalance cadence is independent of
  // `protocolFeePercent`. Two pools with identical curves but different
  // protocol fees must accrue the SAME rebalance-spendable budget after
  // the same swap volume — the protocol slice is funded from LPs'
  // residual, not from the repeg budget.
  // ---------------------------------------------------------------------------
  describe("repeg threshold independence from protocolFeePercent", () => {
    it("two pools with same curve + different protocolFeePercent share the same gate-1 surplus", async () => {
      const REPEG_SHARE_BPS = 5000; // 50/50 LP-vs-repeg split at the level of "total fee"
      const SWAP_AMOUNT = hre.ethers.parseEther("50000");
      const NUM_SWAPS = 4;

      async function deployAndRun(protocolFeePercent: number) {
        const fx = await deployRepegFixture({
          repegShareBps: REPEG_SHARE_BPS,
          protocolFeePercent,
          // Keep the accumulator dynamics live (share != 0) but the
          // anchor frozen: the activation dead-band sits at the stall
          // guard's maximum for a flat 100-bps pool (baseFee·1e14 =
          // 1e16 = 1 %), and the slowest-possible EMA (max half-life
          // 419731 s -> internal tau = MAX_EMA_PERIOD = 7 d) barely
          // moves across the four back-to-back swaps (per-block decay
          // ≈ 2e-6), so the deviation stays orders of magnitude below
          // the gate.
          repegStepWad: 10n ** 16n,
          emaPeriod: 419_731,
        });
        for (let i = 0; i < NUM_SWAPS; i++) {
          await fx.router.connect(fx.trader).exactInputSingle({
            tokenIn: await fx.token0.getAddress(),
            tokenOut: await fx.token1.getAddress(),
            poolIndex: 0,
            recipient: await fx.trader.getAddress(),
            amountIn: SWAP_AMOUNT,
            amountOutMinimum: 0,
            deadline: MaxUint256,
          });
        }
        const lp = await fx.pool.getLpValueState();
        return {
          growth: BigInt(lp.growthWad),
          vpGenesis: BigInt(lp.genesisWad),
          unit: BigInt(lp.unitValueWad),
        };
      }

      const p0 = await deployAndRun(0);
      const p20 = await deployAndRun(20);

      // The realised growth IS proportional to (1 − p/100) because only
      // `lpFeeCut` enters reserves. Both numbers should be > 0.
      expect(p0.growth).to.be.gt(0n);
      expect(p20.growth).to.be.gt(0n);
      expect(p20.growth).to.be.lt(p0.growth);

      // The repeg-spendable "surplus" =
      //   `vpBefore − threshold = growth · share_effective`,
      //   `share_effective = repegShareBps / (BPS − p · 100)`
      // For p = 0:    surplus = growth · 5000 / 10000 = growth × 0.5
      // For p = 20%:  surplus = growth · 5000 / 8000  = growth × 0.625
      // Both must equal the same `growth(p=0) × 0.5` (within ulps).
      const BPS = 10000n;
      const surplus0 = (p0.growth * BigInt(REPEG_SHARE_BPS)) / (BPS - 0n * 100n);
      const surplus20 = (p20.growth * BigInt(REPEG_SHARE_BPS)) / (BPS - 20n * 100n);

      const diff = surplus0 > surplus20 ? surplus0 - surplus20 : surplus20 - surplus0;
      const ppmDrift = (diff * 1_000_000n) / surplus0;

      // Sub-1-ppm drift between the two pools' rebalance budgets —
      // protocol fee no longer slows down the repeg cadence.
      expect(ppmDrift).to.be.lessThan(
        100n,
        `Rebalance budget differs by ${ppmDrift} ppm between p=0 and p=20% pools — threshold formula must compensate`
      );
    });

    it("factory rejects repegShareBps + protocolFeePercent · 100 > BPS", async () => {
      // setProtocolFee = 25 (current MAX); then try to create a pool with
      // repegShareBps = 8001. Total = 8001 + 2500 = 10501 > 10000 → revert.
      const fx = await deployRepegFixture({ protocolFeePercent: 25 });
      const Token = await hre.ethers.getContractFactory("MockERC20");
      const t0 = await Token.deploy("X", "X", 18);
      await t0.waitForDeployment();
      const t1 = await Token.deploy("Y", "Y", 18);
      await t1.waitForDeployment();
      const million = hre.ethers.parseEther("1000000");
      await t0.mint(fx.owner.address, million);
      await t1.mint(fx.owner.address, million);
      await t0.connect(fx.owner).approve(await fx.factory.getAddress(), MaxUint256);
      await t1.connect(fx.owner).approve(await fx.factory.getAddress(), MaxUint256);
      await expect(
        fx.factory.connect(fx.owner).createPoolAndAddLiquidity(
          await t0.getAddress(),
          await t1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 100,
            emaPeriod: 1200,
            repegStepWad: PRESET.repegStepWad,
            repegThresholdToken1UpWad: PRESET.repegStepWad,
            repegThresholdToken1DownWad: PRESET.repegStepWad,
            feeRampBps: 0,
            feeFloorBps: 20,
            repegShareBps: 8_001, // 8001 + 2500 = 10501 > BPS
          },
          million,
          million,
          fx.owner.address
        )
      ).to.be.revertedWithCustomError(fx.factory, "RepegShareExceedsBudget");
    });

    it("factory accepts the tight boundary repegShareBps + protocolFeePercent · 100 == BPS", async () => {
      // protocolFee = 25, repegShareBps = 7500 → sum = 10000 (exactly BPS).
      const fx = await deployRepegFixture({
        protocolFeePercent: 25,
        repegShareBps: 7500,
      });
      // No revert ⇒ pool exists.
      const cfg = await fx.pool.getFeeConfig();
      expect(cfg.repegShareBps).to.equal(7500n);
      expect(cfg.protocolFeePercent).to.equal(25n);
    });
  });

  // ---------------------------------------------------------------------------
  // Worst-case gas envelope for `exactInputSingle`. Combines the three
  // biggest gas-consumers on the swap path:
  //   1. `_accrueProtocolFees` SSTORE  — fires when `protocolFeePercent > 0`.
  //   2. `_accrueLpValueGrowth` SSTORE — fires whenever LP growth accrues
  //      (every swap with a non-trivial size).
  //   3. `_tryAutoRepeg` SSTOREs       — fires when both gates pass:
  //         · `_anchorPrice`
  //         · `_lpUnitValueWad`        (latched to vpAfter)
  //         · `_lastRepegTs`
  //         · `PriceScaleUpdated` event
  //
  // Bound is loose (~210k) so compiler variance and minor refactors don't
  // produce flakes; the test exists primarily so a future change that
  // **regresses** the worst case by tens of thousands of gas shows up here
  // instead of in the gas-reporter aggregate.
  // ---------------------------------------------------------------------------
  describe("worst-case gas envelope", () => {
    it("exactInputSingle that fires repeg with non-zero protocolFeePercent stays under 185k gas", async function () {
      // Gas envelopes are only meaningful on production (viaIR,
      // optimizer-on) bytecode: coverage instrumentation adds a hook
      // call per statement and compiles with the optimizer off, which
      // inflates the same tx to ~235k. Skip under coverage — the
      // envelope is enforced on every regular `npm test` run.
      if (process.env.SOLIDITY_COVERAGE === "true") this.skip();
      // Pool config maximising every SSTORE on the swap path:
      //   • protocolFee = 25 (max) → `_protocolFeesPacked` SSTORE.
      //   • repegShareBps = 7500 (max compatible with p = 25) → gate wide open.
      //   • both repeg dead-bands small → activation gate fires after the EMA drifts.
      const fx = await deployRepegFixture({
        protocolFeePercent: 25,
        repegShareBps: 7500,
        repegStepWad: hre.ethers.parseUnits("1", 15), // 0.1 %
      });
      const { pool, router, trader, token0, token1 } = fx;

      // Pre-swap: drag the EMA past `repegStepWad` and pre-warm the
      // protocol-fee / LP-unit-value storage slots so the measured call
      // sees only the "delta" SSTORE costs, not first-write penalties.
      // We measure the SECOND swap so the bound reflects steady-state
      // worst case, not the one-off cold-init bonus.
      await pumpEmaWithBigSwap(router, trader, token0, token1);
      await time.increase(1200 * 5); // EMA catches up

      const anchorBefore = (await pool.getOracleState()).priceScaleWad;
      const tx = await pumpEmaWithBigSwap(router, trader, token0, token1);
      const rcpt = await tx.wait();
      const anchorAfter = (await pool.getOracleState()).priceScaleWad;

      // Sanity: the repeg must have fired (otherwise we measured the
      // wrong path).
      expect(anchorAfter).to.not.equal(anchorBefore);

      // The router → pool call also incurs router overhead; the assertion
      // is on the **whole tx** gas so it captures the entire user-facing
      // cost. The bound (~185k) is sized for the steady-state warm path
      // where all storage slots have already been touched once. Cold-
      // init swaps (first call of a freshly-deployed pool, no prior
      // protocol-fee buckets or LP-growth slots written) can run higher
      // — those are measured implicitly by the gas-reporter aggregate
      // across the rest of the suite.
      const gasUsed = BigInt(rcpt!.gasUsed);
      expect(gasUsed).to.be.lessThan(185_000n, `worst-case exactInputSingle gas: ${gasUsed}`);
    });
  });
});
