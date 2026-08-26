// Targeted branch coverage for the `_tryAutoRepeg` halving ladder on
// the LIVE contract: which rung commits, exhaustion, the once-per-block
// latch on a refused attempt, and the worst-case gas envelope of an
// all-rungs-refused swap.
//
// Method: every scenario drives the pool into an imbalanced, EMA-drifted
// state through real router swaps, then reconstructs the ladder's
// decision inputs from public views (`getOracleState`, `getReserves`,
// `getLpValueState`, `getFeeConfig`) plus the `MockEquilibraPool`
// solvency probe and the `PoolOracleHarness` log-step. Each test first
// ASSERTS its premise (which rungs the budget can afford) and then
// asserts the pool's observed behaviour on the next trigger swap. A
// preset change that invalidates the engineered state fails the premise
// assert loudly instead of letting the scenario silently degrade.
//
// The prediction is made one block before the trigger swap, so the
// trigger's own EMA blend perturbs the decision inputs slightly; the
// scenarios keep an order-of-magnitude margin between the budget and
// the neighbouring rung costs, and the behavioural assertions compare
// against coarse fractions of the predicted move rather than exact
// candidates. The bit-exact rung semantics are pinned by the Rust
// mirror's `halving_ladder_tests` on frozen states; this file pins the
// same decisions end-to-end through `swap()`.
import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const REPEG_DAMPING_DIVISOR = 5n;
const MAX_REPEG_STEP_HALVINGS = 3;
const REPEG_GAS_GUARD_WAD = 4n * 10n ** 10n;

const PRESET = EQUILIBRA_PRESETS.WETH;

type LadderFixture = {
  owner: any;
  trader: any;
  token0: any;
  token1: any;
  pool: any;
  router: any;
  oracleHarness: any;
  repegShareBps: bigint;
  repegStepWad: bigint;
};

async function deployLadderFixture(repegShareBps: number): Promise<LadderFixture> {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token0", "TK0", 18);
  const tokenB = await Token.deploy("Token1", "TK1", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const [token0, token1] =
    (await tokenA.getAddress()).toLowerCase() < (await tokenB.getAddress()).toLowerCase()
      ? [tokenA, tokenB]
      : [tokenB, tokenA];

  const PoolImpl = await hre.ethers.getContractFactory("MockEquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  await factory.setProtocolFee(0);

  const million = hre.ethers.parseEther("1000000");
  await token0.mint(owner.address, million * 2n);
  await token1.mint(owner.address, million * 2n);
  await token0.mint(trader.address, million);
  await token1.mint(trader.address, million);
  await token0.approve(await factory.getAddress(), MaxUint256);
  await token1.approve(await factory.getAddress(), MaxUint256);

  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad: PRESET.aWad,
      lambdaWad: PRESET.lambdaWad,
      baseFee: 100, // flat 1% — meaningful growth per unit of volume
      emaPeriod: 1200,
      repegStepWad: 5n * 10n ** 15n,
      // Small symmetric dead-bands: the scenarios control activation
      // through the EMA drift itself, not the bands.
      repegThresholdToken1UpWad: 10n ** 14n,
      repegThresholdToken1DownWad: 10n ** 14n,
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps,
    },
    million,
    million,
    owner.address
  );

  const pool = await hre.ethers.getContractAt("MockEquilibraPool", await factory.allPools(0));

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  await token0.connect(trader).approve(await router.getAddress(), MaxUint256);
  await token1.connect(trader).approve(await router.getAddress(), MaxUint256);

  const Harness = await hre.ethers.getContractFactory("PoolOracleHarness");
  const oracleHarness = await Harness.deploy();
  await oracleHarness.waitForDeployment();

  return {
    owner,
    trader,
    token0,
    token1,
    pool,
    router,
    oracleHarness,
    repegShareBps: BigInt(repegShareBps),
    repegStepWad: 5n * 10n ** 15n,
  };
}

async function swapExactIn(fx: LadderFixture, tokenIn: any, tokenOut: any, amountIn: bigint) {
  return fx.router.connect(fx.trader).exactInputSingle({
    tokenIn: await tokenIn.getAddress(),
    tokenOut: await tokenOut.getAddress(),
    poolIndex: 0,
    recipient: fx.trader.address,
    amountIn,
    amountOutMinimum: 0n,
    deadline: MaxUint256,
  });
}

// Imbalance + EMA drift + fee growth: one big token0-in swap (reserve0
// up, reserve1 down => spot above the anchor), then a time gap and a
// dust swap so the EMA blends toward the displaced spot. Returns after
// the EMA is current as of the last mined block.
async function driveIntoLadderState(fx: LadderFixture, bigSwapWei: bigint) {
  await swapExactIn(fx, fx.token0, fx.token1, bigSwapWei);
  await time.increase(3600); // 3 half-lives: EMA ≈ clamped spot
  await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
}

type LadderSnapshot = {
  priceScaleWad: bigint;
  emaWad: bigint;
  deviationWad: bigint;
  baseAppliedWad: bigint;
  thresholdWad: bigint;
  vpLiveWad: bigint;
  spendableWad: bigint;
  candidates: bigint[]; // rung k = 0..3
  probes: bigint[]; // vpAfter per rung
  costs: bigint[]; // vpLive − vpAfter per rung (0 when the rung gains)
};

// Reconstruct the ladder's decision inputs from public views — the
// same numbers `_tryAutoRepeg` derives internally on the NEXT swap
// (modulo that swap's own EMA blend and reserve delta, which the
// scenarios keep negligible against their margins).
async function snapshotLadder(fx: LadderFixture): Promise<LadderSnapshot> {
  const oracle = await fx.pool.getOracleState();
  const [r0, r1] = await fx.pool.getReserves();
  const lp = await fx.pool.getLpValueState();
  const supply = BigInt(await fx.pool.totalSupply());

  const ps = BigInt(oracle.priceScaleWad);
  const ema = BigInt(oracle.emaPriceWad);
  const [hi, lo] = ema >= ps ? [ema, ps] : [ps, ema];
  const deviationWad = (hi * WAD) / lo - WAD;
  const damped = deviationWad / REPEG_DAMPING_DIVISOR;
  const baseAppliedWad = fx.repegStepWad < damped ? fx.repegStepWad : damped;

  // protocolFee = 0 in this fixture, so the stored (grossed-up) share
  // equals the user-facing one reported by getFeeConfig.
  const thresholdWad = BigInt(lp.genesisWad) + (BigInt(lp.growthWad) * (BPS - fx.repegShareBps)) / BPS;
  const vpLiveWad = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, ps, supply));

  const candidates: bigint[] = [];
  const probes: bigint[] = [];
  const costs: bigint[] = [];
  for (let k = 0; k <= MAX_REPEG_STEP_HALVINGS; k++) {
    const applied = baseAppliedWad >> BigInt(k);
    const candidate = BigInt(await fx.oracleHarness.applyLogStep(ps, ema, applied));
    const probe = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, candidate, supply));
    candidates.push(candidate);
    probes.push(probe);
    costs.push(vpLiveWad > probe ? vpLiveWad - probe : 0n);
  }

  const spendableWad = vpLiveWad > thresholdWad ? vpLiveWad - thresholdWad : 0n;
  return {
    priceScaleWad: ps,
    emaWad: ema,
    deviationWad,
    baseAppliedWad,
    thresholdWad,
    vpLiveWad,
    spendableWad,
    candidates,
    probes,
    costs,
  };
}

async function ampleBudgetFixture() {
  return deployLadderFixture(10_000);
}
async function tightBudgetFixture() {
  return deployLadderFixture(1_300);
}
async function starvedBudgetFixture() {
  return deployLadderFixture(1);
}

async function priceScaleEvents(fx: LadderFixture, fromBlock: number) {
  return fx.pool.queryFilter(fx.pool.filters.PriceScaleUpdated(), fromBlock);
}

describe("RepegHalvingLadder", () => {
  // Budget covers the full rung with room to spare: the ladder commits
  // the UNHALVED step (no fallback), moving the anchor by ≈ the full
  // predicted magnitude.
  it("commits the full rung when the growth budget is ample", async () => {
    const fx = await loadFixture(ampleBudgetFixture);
    await driveIntoLadderState(fx, hre.ethers.parseEther("30000"));

    const snap = await snapshotLadder(fx);
    expect(snap.spendableWad, "premise: budget must cover the full rung").to.be.greaterThan(
      snap.costs[0] + REPEG_GAS_GUARD_WAD
    );
    const predictedFullMove =
      snap.candidates[0] > snap.priceScaleWad
        ? snap.candidates[0] - snap.priceScaleWad
        : snap.priceScaleWad - snap.candidates[0];

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "the trigger swap must commit a repeg").to.equal(1);

    const oldPs = BigInt(events[0].args.oldPriceScaleWad ?? events[0].args[0]);
    const newPs = BigInt(events[0].args.newPriceScaleWad ?? events[0].args[1]);
    const moved = newPs > oldPs ? newPs - oldPs : oldPs - newPs;
    // Full-rung commit: the realised move sits at the predicted
    // magnitude (75% floor absorbs the trigger swap's own EMA blend).
    expect(moved).to.be.greaterThan((predictedFullMove * 75n) / 100n);
  });

  // Budget sits between the smallest and the full rung: the ladder
  // falls back and commits a HALVED step instead of freezing.
  it("falls back to a halved rung when the full step is unaffordable", async () => {
    const fx = await loadFixture(tightBudgetFixture);
    await driveIntoLadderState(fx, hre.ethers.parseEther("30000"));

    const snap = await snapshotLadder(fx);
    // Premise: the full rung must NOT fit the budget, some deeper rung must.
    expect(snap.spendableWad, "premise: full rung unaffordable").to.be.lessThan(snap.costs[0]);
    expect(snap.costs[MAX_REPEG_STEP_HALVINGS], "premise: deepest rung affordable").to.be.lessThan(snap.spendableWad);
    const predictedFullMove =
      snap.candidates[0] > snap.priceScaleWad
        ? snap.candidates[0] - snap.priceScaleWad
        : snap.priceScaleWad - snap.candidates[0];

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "a partial rung must still commit").to.equal(1);

    const oldPs = BigInt(events[0].args.oldPriceScaleWad ?? events[0].args[0]);
    const newPs = BigInt(events[0].args.newPriceScaleWad ?? events[0].args[1]);
    const moved = newPs > oldPs ? newPs - oldPs : oldPs - newPs;
    // Fallback commit: the realised move is a strict fraction of the
    // full rung (≤ 60% ⇒ at least one halving happened; > 0 ⇒ the
    // anchor did not freeze).
    expect(moved).to.be.greaterThan(0n);
    expect(moved).to.be.lessThan((predictedFullMove * 60n) / 100n);
  });

  // Budget below even the deepest rung: no rung commits, the anchor and
  // the once-per-block latch stay untouched, and the swap still settles.
  it("leaves the anchor and the repeg latch untouched when every rung is refused", async () => {
    const fx = await loadFixture(starvedBudgetFixture);
    await driveIntoLadderState(fx, hre.ethers.parseEther("30000"));

    const snap = await snapshotLadder(fx);
    expect(snap.spendableWad, "premise: even the deepest rung unaffordable").to.be.lessThan(
      snap.costs[MAX_REPEG_STEP_HALVINGS]
    );

    const [, lastRepegTsBefore] = await fx.pool.getOracleTimestamps();
    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);

    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "no rung may commit").to.equal(0);
    const oracle = await fx.pool.getOracleState();
    expect(BigInt(oracle.priceScaleWad)).to.equal(snap.priceScaleWad);
    // `_lastRepegTs` advances only on a successful commit — a refused
    // ladder must NOT latch the block, so the attempt re-arms for the
    // block's next swap.
    const [, lastRepegTsAfter] = await fx.pool.getOracleTimestamps();
    expect(lastRepegTsAfter).to.equal(lastRepegTsBefore);
  });

  // The all-rungs-refused path is the swap's new worst-case compute
  // path (four solvency probes, no SSTORE refund from a commit). Pin a
  // generous gas envelope so a future regression that balloons the
  // per-rung probe or adds rungs shows up here.
  it("bounds the gas of an all-rungs-refused swap", async () => {
    const fx = await loadFixture(starvedBudgetFixture);
    await driveIntoLadderState(fx, hre.ethers.parseEther("30000"));

    const snap = await snapshotLadder(fx);
    expect(snap.spendableWad, "premise: every rung refused").to.be.lessThan(snap.costs[MAX_REPEG_STEP_HALVINGS]);

    const tx = await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const receipt = await tx.wait();
    expect(Number(receipt.gasUsed)).to.be.lessThan(400_000);
  });
});
