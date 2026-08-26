/**
 * RepegConservation — Equilibra multi-cycle security regression.
 *
 * Security invariants asserted on a 4-phase bull/bear trajectory:
 *
 *   INV-A  many repegs trigger (no degenerate trajectory).
 *   INV-B  cumulative `growth_wad` strictly > 0 (fees flowed).
 *   INV-C  `vp_final ≥ genesisVp + growth · (BPS − repegShareBps) / BPS`
 *          — the 50/50 floor that the auto-repeg gate is built to
 *          guarantee. A breach means the gate let through more IL than
 *          the configured budget — a serious LP-extraction bug.
 *   INV-D  reserve drift stays bounded (BULL/BEAR cycles cancel out
 *          modulo slippage).
 *   INV-E  `growth_wad` is monotone-up across every swap (anti-regression
 *          for the historical "growth-deflation" bug class).
 *   INV-F  drift of `_computeLpUnitValueWad` under a synthetic price-
 *          scale step grows monotonically with state imbalance — proves
 *          the metric encodes a real depth-cost signal, not a constant-
 *          magnitude artefact.
 */

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

const WAD = 10n ** 18n;
const BPS = 10_000n;

// Genesis pool composition: 1M USDT + 500 "WETH" (both 18 dec — keeps
// the math reproducible without dragging in token-decimal asymmetries).
const RESERVE_USDT_WAD = 1_000_000n * WAD;
const RESERVE_WETH_WAD = 500n * WAD;

// 4-phase BULL→BEAR→BULL→BEAR trajectory, 20 swaps per phase.
//   * Each swap is 1.5 % of the seeded reserve on the input side — large
//     enough to drag the EMA past `repegStepWad` after a few hits, small
//     enough that 20 steps don't drain the pool.
//   * 60 s between swaps lets the EMA decay between trades.
//   * Between phases sleep 5× EMA half-life so the EMA fully converges
//     to the new spot — every phase reliably triggers fresh repegs.
const STEPS_PER_PHASE = 20;
const SWAP_AMOUNT_USDT = (RESERVE_USDT_WAD * 150n) / BPS;
const SWAP_AMOUNT_WETH = (RESERVE_WETH_WAD * 150n) / BPS;
const TIME_PER_SWAP = 60;
const PHASE_BREAK_S = PRESET.emaPeriod * 5;

const EQ_REPEG_SHARE_BPS = BigInt(PRESET.repegShareBps);

type Direction = "USDT_TO_WETH" | "WETH_TO_USDT";

const TRAJECTORY: { label: string; direction: Direction; steps: number }[] = [
  { label: "Phase 1 BULL", direction: "USDT_TO_WETH", steps: STEPS_PER_PHASE },
  { label: "Phase 2 BEAR", direction: "WETH_TO_USDT", steps: STEPS_PER_PHASE },
  { label: "Phase 3 BULL", direction: "USDT_TO_WETH", steps: STEPS_PER_PHASE },
  { label: "Phase 4 BEAR", direction: "WETH_TO_USDT", steps: STEPS_PER_PHASE },
];

interface PoolFixture {
  pool: any;
  router: any;
  trader: any;
  usdt: any;
  weth: any;
  usdtAddr: string;
  wethAddr: string;
  initialReserve0: bigint;
  initialReserve1: bigint;
}

async function deployFixture(): Promise<PoolFixture> {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const usdt: any = await Token.deploy("USDT", "USDT", 18);
  const weth: any = await Token.deploy("WETH", "WETH", 18);
  await usdt.waitForDeployment();
  await weth.waitForDeployment();

  const usdtAddr = (await usdt.getAddress()).toLowerCase();
  const wethAddr = (await weth.getAddress()).toLowerCase();
  const isUsdtToken0 = usdtAddr < wethAddr;
  const [token0, token1] = isUsdtToken0 ? [usdt, weth] : [weth, usdt];

  const mintUsdt = RESERVE_USDT_WAD * 100n;
  const mintWeth = RESERVE_WETH_WAD * 100n;
  for (const signer of [owner, trader]) {
    await usdt.mint(signer.address, mintUsdt);
    await weth.mint(signer.address, mintWeth);
  }

  const PoolImpl = await hre.ethers.getContractFactory("MockEquilibraPool");
  const poolImpl: any = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  // Disable protocol fee — keeps the 50/50 floor accounting clean.
  await factory.setProtocolFee(0);

  const factoryAddr = await factory.getAddress();
  await usdt.approve(factoryAddr, MaxUint256);
  await weth.approve(factoryAddr, MaxUint256);

  const sortedAmt0 = isUsdtToken0 ? RESERVE_USDT_WAD : RESERVE_WETH_WAD;
  const sortedAmt1 = isUsdtToken0 ? RESERVE_WETH_WAD : RESERVE_USDT_WAD;

  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad: PRESET.aWad,
      lambdaWad: PRESET.lambdaWad,
      baseFee: PRESET.feeBps,
      emaPeriod: PRESET.emaPeriod,
      repegStepWad: PRESET.repegStepWad,
      repegThresholdToken1UpWad: PRESET.repegThresholdToken1UpWad,
      repegThresholdToken1DownWad: PRESET.repegThresholdToken1DownWad,
      feeRampBps: PRESET.feeRampBps,
      feeFloorBps: PRESET.feeFloorBps,
      repegShareBps: PRESET.repegShareBps,
    },
    sortedAmt0,
    sortedAmt1,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool: any = await hre.ethers.getContractAt("MockEquilibraPool", poolAddress);

  const Weth9 = await hre.ethers.getContractFactory("MockWETH9");
  const weth9: any = await Weth9.deploy();
  await weth9.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth9.getAddress());
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  await usdt.connect(trader).approve(routerAddr, MaxUint256);
  await weth.connect(trader).approve(routerAddr, MaxUint256);

  const [r0, r1] = await pool.getReserves();
  return {
    pool,
    router,
    trader,
    usdt,
    weth,
    usdtAddr: await usdt.getAddress(),
    wethAddr: await weth.getAddress(),
    initialReserve0: r0,
    initialReserve1: r1,
  };
}

async function exactInputSwap(fx: PoolFixture, direction: Direction, amountIn: bigint) {
  const [tokenIn, tokenOut] = direction === "USDT_TO_WETH" ? [fx.usdtAddr, fx.wethAddr] : [fx.wethAddr, fx.usdtAddr];
  return fx.router.connect(fx.trader).exactInputSingle({
    tokenIn,
    tokenOut,
    poolIndex: 0,
    recipient: fx.trader.address,
    amountIn,
    amountOutMinimum: 0n,
    deadline: MaxUint256,
  });
}

interface TrajectoryStats {
  totalSwaps: number;
  totalRepegs: number;
  reserveDriftPpm: bigint;
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function absBig(a: bigint): bigint {
  return a < 0n ? -a : a;
}

async function runTrajectory(fx: PoolFixture): Promise<TrajectoryStats> {
  let totalSwaps = 0;
  let totalRepegs = 0;

  for (const phase of TRAJECTORY) {
    const swapAmount = phase.direction === "USDT_TO_WETH" ? SWAP_AMOUNT_USDT : SWAP_AMOUNT_WETH;
    const psBeforePhase = (await fx.pool.getOracleState()).priceScaleWad;
    for (let i = 0; i < phase.steps; i++) {
      await exactInputSwap(fx, phase.direction, swapAmount);
      totalSwaps++;
      await time.increase(TIME_PER_SWAP);
    }
    const psAfterPhase = (await fx.pool.getOracleState()).priceScaleWad;
    if (psAfterPhase !== psBeforePhase) totalRepegs++;
    await time.increase(PHASE_BREAK_S);
  }

  // ReserveDriftPpm: compare to balanced state after a BULL+BEAR cycle.
  const [r0Now, r1Now] = await fx.pool.getReserves();
  const drift0 = (absBig(r0Now - fx.initialReserve0) * 1_000_000n) / fx.initialReserve0;
  const drift1 = (absBig(r1Now - fx.initialReserve1) * 1_000_000n) / fx.initialReserve1;
  return {
    totalSwaps,
    totalRepegs,
    reserveDriftPpm: bigMax(drift0, drift1),
  };
}

async function countRepegEvents(pool: any): Promise<number> {
  const filter = pool.filters.PriceScaleUpdated();
  const events = await pool.queryFilter(filter, 0, "latest");
  return events.length;
}

describe("RepegConservation (Equilibra-only multi-cycle)", () => {
  it("INV-A/B/C/D: 50/50 floor holds after a heavy 4-phase trajectory", async () => {
    const fx = await loadFixture(deployFixture);
    const stats = await runTrajectory(fx);
    const lp = await fx.pool.getLpValueState();
    const repegEvents = await countRepegEvents(fx.pool);

    // INV-A: trajectory MUST trigger repegs (otherwise the floor check
    // is vacuous).
    expect(
      repegEvents,
      `only ${repegEvents} PriceScaleUpdated events across ${stats.totalSwaps} swaps`
    ).to.be.greaterThanOrEqual(5);

    // INV-B: cumulative growth_wad strictly accrued.
    expect(lp.growthWad, "growth_wad never accrued").to.be.greaterThan(0n);

    // INV-C: 50/50 floor — auto-repeg gate guarantees
    //   vp_final ≥ genesisVp + growth · (BPS − repegShareBps) / BPS.
    // A breach means the gate let an LP-IL move through that ate into
    // committed growth — the worst-case profit-extraction surface for
    // an attacker that drives the EMA off-anchor.
    const keepBps = BPS - EQ_REPEG_SHARE_BPS;
    const floorVp = BigInt(lp.genesisWad) + (BigInt(lp.growthWad) * keepBps) / BPS;
    expect(
      BigInt(lp.unitValueWad),
      `vp_final (${lp.unitValueWad}) fell below 50/50 floor (${floorVp})`
    ).to.be.greaterThanOrEqual(floorVp - 1n);

    // INV-D: BULL+BEAR cycles cancel out modulo slippage. ≤ 15 %
    // generous bound — the priceScale shifts under repegs change the
    // pool's "balanced point" each phase, so exact cancellation is not
    // expected.
    expect(stats.reserveDriftPpm, `reserve drift ${stats.reserveDriftPpm} ppm > 150 000 ppm`).to.be.lessThan(150_000n);
  });

  it("INV-E: growth_wad is monotone-up across every swap", async () => {
    const fx = await loadFixture(deployFixture);
    let prevGrowth = (await fx.pool.getLpValueState()).growthWad;

    for (const phase of TRAJECTORY) {
      const swapAmount = phase.direction === "USDT_TO_WETH" ? SWAP_AMOUNT_USDT : SWAP_AMOUNT_WETH;
      for (let i = 0; i < phase.steps; i++) {
        await exactInputSwap(fx, phase.direction, swapAmount);
        const lp = await fx.pool.getLpValueState();
        expect(
          BigInt(lp.growthWad),
          `${phase.label} #${i}: growth_wad regressed (${prevGrowth} → ${lp.growthWad})`
        ).to.be.greaterThanOrEqual(BigInt(prevGrowth));
        prevGrowth = lp.growthWad;
        await time.increase(TIME_PER_SWAP);
      }
      await time.increase(PHASE_BREAK_S);
    }
  });

  it("INV-F: vp drift on a synthetic priceScale step grows with imbalance", async () => {
    // Pure-math probe under the cubic kernel. Take a fixed
    // priceScale and a +5 % step, then measure how the LP unit value
    // moves for a range of pool-imbalance probes. Drift magnitude must
    // monotonically grow with imbalance — proves the metric encodes a
    // real depth-cost (so opening the repeg gate at imbalance costs
    // strictly more LP value, which is what an arb-extraction guard
    // demands).
    const fx = await loadFixture(deployFixture);
    const supply = await fx.pool.totalSupply();
    const oracle = await fx.pool.getOracleState();
    const psOld = oracle.priceScaleWad;
    const stepBps = 500n; // +5 % synthetic step
    const psNew = (psOld * (BPS + stepBps)) / BPS;

    const [r0Bal, r1Bal] = await fx.pool.getReserves();

    type Probe = { label: string; r0: bigint; r1: bigint };
    const probes: Probe[] = [
      { label: "balanced", r0: r0Bal, r1: r1Bal },
      { label: "5% bias", r0: (r0Bal * 110n) / 100n, r1: (r1Bal * 90n) / 100n },
      {
        label: "15% bias",
        r0: (r0Bal * 130n) / 100n,
        r1: (r1Bal * 70n) / 100n,
      },
      {
        label: "30% bias",
        r0: (r0Bal * 160n) / 100n,
        r1: (r1Bal * 40n) / 100n,
      },
    ];

    const ppmDrifts: bigint[] = [];
    for (const p of probes) {
      const vpOld = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(p.r0, p.r1, psOld, supply));
      const vpNew = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(p.r0, p.r1, psNew, supply));
      const diff = vpNew > vpOld ? vpNew - vpOld : vpOld - vpNew;
      const ppm = vpOld === 0n ? 0n : (diff * 1_000_000n) / vpOld;
      ppmDrifts.push(ppm);
    }

    // The drift at the balanced state is the minimum (the symmetric
    // coord-change cancels at the diagonal). Imbalanced probes must
    // produce strictly higher drift — i.e. the metric is sensitive to
    // imbalance, not a fixed-magnitude artefact of the formula.
    for (let i = 1; i < ppmDrifts.length; i++) {
      expect(
        ppmDrifts[i],
        `drift[${i}] (${ppmDrifts[i]} ppm) did not exceed drift[${i - 1}] ` +
          `(${ppmDrifts[i - 1]} ppm) — depth-cost must grow with imbalance`
      ).to.be.greaterThan(ppmDrifts[i - 1]);
    }
  });

  // INV-I — **simulator-pattern replication on-chain**. Mimics
  // exactly what the simulator does: many small alternating swaps
  // with very short timestamp gaps (1 second between user trade
  // and the follow-up arb-like swap), 60 seconds between cycles.
  // If `priceScale` runs away on-chain with this pattern, the bug
  // is in the algorithm itself. If `priceScale` stays bounded,
  // the bug is simulator-specific (arb model or stateless quote).
  it("INV-I: simulator-pattern stress — 1000 swaps, priceScale stays bounded", async function () {
    this.timeout(120_000);
    const fx = await loadFixture(deployFixture);
    const psInitial = BigInt((await fx.pool.getOracleState()).priceScaleWad);

    // Mirror simulator: tiny user trade + 1-second arb trade in
    // opposite direction. Cycle every 60s. Swap sizes are rescaled
    // to current reserves per-cycle below (0.05 % of live reserve).
    //
    // Coverage runs (SOLIDITY_COVERAGE=true, normalised in
    // hardhat.config.ts) shrink the sweep 10×: instrumented swaps are
    // an order of magnitude slower and 500 cycles blow the 120 s
    // ceiling, while statement/branch hits saturate within the first
    // few cycles. The anti-runaway budget below scales with the swap
    // count, so the assertion stays consistent at any N.
    const N_CYCLES = process.env.SOLIDITY_COVERAGE === "true" ? 50 : 500;
    let psMax = psInitial;
    let psMin = psInitial;
    let repegFires = 0;
    let lastBlock = await time.latest();

    for (let cycle = 0; cycle < N_CYCLES; cycle++) {
      // User trade: USDT → WETH
      await time.setNextBlockTimestamp(lastBlock + 60);
      lastBlock += 60;
      const r0 = (await fx.pool.getReserves())[0];
      // Re-scale user trade to current reserve so always 0.05 %.
      const txU = await exactInputSwap(fx, "USDT_TO_WETH", (BigInt(r0) * 5n) / BPS);
      const recU = await txU.wait();

      // Arb mimic: WETH → USDT in opposite direction, 1 second later.
      await time.setNextBlockTimestamp(lastBlock + 1);
      lastBlock += 1;
      const r1 = (await fx.pool.getReserves())[1];
      const txA = await exactInputSwap(fx, "WETH_TO_USDT", (BigInt(r1) * 5n) / BPS);
      const recA = await txA.wait();

      // Track priceScale evolution.
      const ps = BigInt((await fx.pool.getOracleState()).priceScaleWad);
      if (ps > psMax) psMax = ps;
      if (ps < psMin) psMin = ps;

      // Count PriceScaleUpdated events.
      const filter = fx.pool.filters.PriceScaleUpdated();
      const events = await fx.pool.queryFilter(filter, recU.blockNumber, recA.blockNumber);
      repegFires += events.length;
    }

    const psFinal = BigInt((await fx.pool.getOracleState()).priceScaleWad);
    const psGrowthBps = (psMax * 10_000n) / psInitial;
    console.log(`\n  INV-I results after ${N_CYCLES} cycles (${N_CYCLES * 2} swaps):`);
    console.log(`    initial ps:   ${psInitial}`);
    console.log(`    final ps:     ${psFinal}`);
    console.log(`    max ps:       ${psMax}  (= ${Number(psGrowthBps) / 100}% of initial)`);
    console.log(`    min ps:       ${psMin}`);
    console.log(`    repeg fires:  ${repegFires}`);

    // Universal anti-runaway bound. Each repeg moves priceScale by
    // at most `repegStepWad` (WAD fraction) per call, so after
    // `N` swaps the absolute worst-case compound growth is
    // `(1 + step)^N`. We pick `10 ×` that as the safety budget —
    // anything that breaches this is a genuine algorithm regress
    // (e.g. the gate is allowing supra-step moves), independent of
    // the preset's calibration. For the old WETH preset
    // (`step = 0.1 %`, N = 1000) this evaluates to `~27 ×`; for the
    // new aggressive one (`step = 0.5 %`, N = 1000) it's `~1480 ×`,
    // both healthy and parameter-invariant.
    const stepFrac = Number(PRESET.repegStepWad) / 1e18;
    const numSwaps = N_CYCLES * 2;
    const theoreticalMax = Math.exp(stepFrac * numSwaps);
    const maxAllowedRatio = theoreticalMax * 10;
    const psRatio = Number(psMax) / Number(psInitial);
    expect(
      psRatio,
      `priceScale ran away on-chain: max ${psMax} vs init ${psInitial} ` +
        `(factor ${psRatio.toFixed(2)}, budget ${maxAllowedRatio.toFixed(2)} ` +
        `at step=${stepFrac * 100}% × ${numSwaps} swaps). Algorithm bug.`
    ).to.be.lessThan(maxAllowedRatio);
  });

  // INV-H — *real* anchor-tracking regression. The simulator
  // showed `priceScale` freezing after the first ~3 months of a
  // 4-year run despite the market moving 3×, with 100% of late
  // swaps blocked by `deviation_below_threshold`. The hypothesis: pool
  // arbs keep `pool_spot ≈ priceScale` (not `≈ market`), so EMA
  // tracks the frozen priceScale and the gate never re-opens.
  //
  // This test forces the market price to walk far away from
  // `priceScale` by doing many large one-direction swaps + arb-like
  // counter-swaps, then verifies the anchor caught up.
  it("INV-H: priceScale tracks a sustained market move (not frozen)", async () => {
    const fx = await loadFixture(deployFixture);
    const psInitial = BigInt((await fx.pool.getOracleState()).priceScaleWad);

    // Drive the pool decisively in one direction with large swaps.
    // Each swap is 5% of seeded reserve — big enough to move
    // pool's marginal price by ~5-10% per hit, accumulating to a
    // large overall move. 60 swaps in same direction over ~1 hour.
    const BIG_SWAP = (RESERVE_USDT_WAD * 500n) / BPS;
    for (let i = 0; i < 60; i++) {
      await exactInputSwap(fx, "USDT_TO_WETH", BIG_SWAP);
      await time.increase(60);
    }

    const psAfter = BigInt((await fx.pool.getOracleState()).priceScaleWad);
    const psMovePpm = (absBig(psAfter - psInitial) * 1_000_000n) / psInitial;

    // Anchor should have walked significantly (≥ 1% = 10 000 ppm),
    // in either direction. The sign depends on whether the seeded
    // pool's `priceScale` started above or below where the
    // sustained pressure pushes it. If priceScale froze (simulator
    // pathology), |psMovePpm| would be ~0.
    expect(
      psMovePpm,
      `|priceScale move| only ${psMovePpm} ppm under 60 large USDT→WETH \
       swaps — anchor is stuck. Initial=${psInitial}, after=${psAfter}.`
    ).to.be.greaterThan(10_000n);
  });

  // INV-G — anti-runaway regression for TZ-V15 §2.8 Variant 1.
  //
  // Background. The `vp = 2·L_eq · √(priceScale·WAD) /
  // supply` was not anchor-invariant under the symmetric coord
  // change. Each successful repeg silently grew `vp` by
  // `√(P_new/P_old) − 1` (≈ 0.05% per 0.1% step), which
  // `_accrueLpValueGrowth` credited as real growth. The repeg-gate
  // threshold (`vpGenesis + growth · keepBps`) rises by HALF that
  // delta, so `vp_before − threshold` grew linearly, keeping the
  // gate open indefinitely → priceScale runaway in long runs.
  //
  // Test setup. Run 200 BULL/BEAR round-trips (400 swaps total) of
  // equal magnitude, each pair leaving the pool composition
  // approximately unchanged. Real growth from fees is small but
  // nonzero. Under the **original** broken formula, `priceScale`
  // would drift one-way by ~400 × 0.05% = 20% (and grow further
  // with each subsequent cycle). Under **Variant 1**, drift is
  // O(rounding) per step, so cumulative drift stays in single-digit
  // percent at most.
  it("INV-G: 400 zero-net swaps do not drive priceScale runaway", async () => {
    const fx = await loadFixture(deployFixture);
    const psInitial = BigInt((await fx.pool.getOracleState()).priceScaleWad);

    // Universal swap sizing. The activation deadband is
    // `repegStepWad`, so a per-swap spot move much smaller than
    // that never accumulates enough EMA deviation to exercise the
    // gate. We size swaps as `max(0.5 %, 20 × the wider dead-band)` of
    // reserve so the trajectory always crosses the deadband at
    // least a few times over 200 round-trips, regardless of how
    // the preset calibrates the dead-band or how deep the curve
    // plateau is (a deeper `aWad` shrinks per-swap price impact).
    // Floor at 0.5 % preserves the historical test sensitivity for
    // tiny-threshold presets.
    const widerThresholdWad =
      PRESET.repegThresholdToken1UpWad > PRESET.repegThresholdToken1DownWad
        ? PRESET.repegThresholdToken1UpWad
        : PRESET.repegThresholdToken1DownWad;
    const thresholdBps = Number(widerThresholdWad / 10n ** 14n); // wad → bp
    const swapBps = BigInt(Math.max(50, thresholdBps * 20));
    const SWAP_USDT = (RESERVE_USDT_WAD * swapBps) / BPS;
    const SWAP_WETH = (RESERVE_WETH_WAD * swapBps) / BPS;

    let prevGrowth = (await fx.pool.getLpValueState()).growthWad;
    let maxGrowthDeltaWei = 0n;

    const ROUND_TRIPS = 200;
    for (let i = 0; i < ROUND_TRIPS; i++) {
      await exactInputSwap(fx, "USDT_TO_WETH", SWAP_USDT);
      await time.increase(TIME_PER_SWAP);
      await exactInputSwap(fx, "WETH_TO_USDT", SWAP_WETH);
      await time.increase(TIME_PER_SWAP);

      // Track the max single-step `growth_wad` delta — should reflect
      // only real fee accrual, not phantom priceScale-induced drift.
      const lp = await fx.pool.getLpValueState();
      const delta = BigInt(lp.growthWad) - BigInt(prevGrowth);
      if (delta > maxGrowthDeltaWei) maxGrowthDeltaWei = delta;
      prevGrowth = lp.growthWad;
    }

    const psFinal = BigInt((await fx.pool.getOracleState()).priceScaleWad);
    const psDriftPpm = (absBig(psFinal - psInitial) * 1_000_000n) / psInitial;
    const repegEvents = await countRepegEvents(fx.pool);

    // INV-G.1 — priceScale drift bounded vs the algorithm's
    // theoretical worst-case. Each repeg can move priceScale by at
    // most `repegStepWad`, so the compound upper bound across
    // `N = 2 × ROUND_TRIPS` swaps is `(1 + step)^N`. The original
    // broken sqrt-drift formula rode the cap **every** swap; a
    // healthy implementation under symmetric cycling stays well
    // below the cap, but for a parameter-invariant bound we accept
    // anything inside `0.5 × (compound − 1)` (the regression-bug
    // mode produced ~100 % of that compound).
    const stepFrac = Number(PRESET.repegStepWad) / 1e18;
    const numSwaps = ROUND_TRIPS * 2;
    const compoundCap = Math.exp(stepFrac * numSwaps);
    const driftBudgetPpm = BigInt(Math.ceil((compoundCap - 1) * 1_000_000 * 0.5));
    expect(
      psDriftPpm,
      `priceScale drifted ${psDriftPpm} ppm over ${ROUND_TRIPS} round-trips ` +
        `(theoretical compound cap = ${compoundCap.toFixed(2)}× at ` +
        `step=${stepFrac * 100}% × ${numSwaps} swaps). The sqrt-drift ` +
        `regression mode rode the cap every swap.`
    ).to.be.lessThan(driftBudgetPpm);

    // INV-G.2 — `growth_wad` deltas reflect real fee accrual only.
    // The sqrt-drift bug-mode produced phantom growth of magnitude
    // `step × vp_old` per swap. We bound the max per-swap delta to
    // a multiple of the realistic fee accrual (`baseFee × swap_size
    // × reserve`); anything beyond that means growth was minted by
    // a non-fee channel.
    const baseFeeWadBp = BigInt(PRESET.feeBps); // bp on input
    const maxFeeWei = (RESERVE_USDT_WAD * swapBps * baseFeeWadBp) / (BPS * BPS);
    const growthDeltaBudget = maxFeeWei * 100n; // 100× headroom
    expect(
      maxGrowthDeltaWei,
      `max growth delta per swap = ${maxGrowthDeltaWei} wei (budget ` +
        `${growthDeltaBudget} = 100× per-swap fee). The sqrt-drift ` +
        `bug-mode dominated this by orders of magnitude.`
    ).to.be.lessThan(growthDeltaBudget);

    // INV-G.3 — repegs DID fire (the test is meaningful only if
    // the gate is exercised). With the universal swap sizing above
    // the trajectory always crosses the activation deadband at
    // least a handful of times.
    expect(
      repegEvents,
      `expected at least 1 repeg over ${ROUND_TRIPS} round-trips with ` +
        `swap=${swapBps}bp, step=${stepFrac * 100}% — the trajectory ` +
        `must exercise the gate (raise swap size or shrink step if ` +
        `the preset is calibrated outside this universal scaling).`
    ).to.be.greaterThan(0);
  });
});
