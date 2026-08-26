// Functional + economic coverage for the repeg DONATION PARACHUTE on
// the live contract: the branch `_tryAutoRepeg` hands over to when NO
// repeg committed — from the pre-gate (no spendable growth budget at
// all) AND after the halving ladder exhausted every rung. Scope here is
// the mechanism itself (activation math, exact-shortfall burn sizing,
// buffer conservation, vp-invariance of the liquidity legs);
// adversarial scenarios live with the rest of the attacker-perspective
// suite.
//
// Donation model: a plain LP `transfer` of shares to the pool's own
// address (the guarded variant lives in `EquilibraRouter.donate` and is
// covered by DonateGuard.test.ts). Parked shares are vp-neutral (supply
// unchanged) and are spendable ONLY by `_tryDonationParachute`, which
// opens when the geometric EMA/anchor deviation reaches
// `K × the active dead-band` — K is PER-POOL STORAGE
// (`getFeeConfig().parachuteBandMult`, seeded from
// `Constants.REPEG_PARACHUTE_BAND_MULT` and timelock-adjustable), so
// every activation bound below is read from the pool, never hardcoded.
// The parachute commits the FULL damped step in one shot and burns
// exactly the shortfall `δ = ⌈S · (T − vpAfter) / T⌉`, landing the
// post-burn unit value ON the gate floor `T`.
//
// Method mirrors RepegHalvingLadder.test.ts: drive the pool into the
// target state through real router swaps, reconstruct the decision
// inputs from public views plus the `MockEquilibraPool` solvency probe
// and the `PoolOracleHarness` log-step, ASSERT the premise, then assert
// the pool's observed behaviour on the trigger swap.
//
// The starved fixture pairs a 5 bps flat fee (growth per unit of volume
// stays under the gas guard, so the pool never accrues an own budget)
// with 1e14 dead-bands (inside the stall-guard cap `feeScale · 1e14 =
// 5e14`), putting the parachute's activation at `K × 1e14` (0.3% of
// anchor lag at the canonical K = 30).
import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const REPEG_DAMPING_DIVISOR = 5n;
const REPEG_GAS_GUARD_WAD = 4n * 10n ** 10n;
const REPEG_DONATION_DUST_SHARES = 10n ** 12n;
const MAX_REPEG_STEP_HALVINGS = 3n;
const DEAD_BAND_WAD = 10n ** 14n;

const PRESET = EQUILIBRA_PRESETS.WETH;

// No sandwicher signer: an economic parachute sandwich is structurally
// pointless — the exact-shortfall burn lands the unit value ON the gate
// floor, so a commit adds zero redemption value for a sandwicher to
// capture (the donation's entire uplift is consumed by the anchor move
// within the committing transaction).
type Fixture = {
  owner: any;
  trader: any;
  token0: any;
  token1: any;
  pool: any;
  router: any;
  oracleHarness: any;
};

async function deployFixture(repegShareBps: number, baseFee: number): Promise<Fixture> {
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
  for (const who of [owner, trader]) {
    await token0.mint(who.address, million * 20n);
    await token1.mint(who.address, million * 20n);
  }
  await token0.approve(await factory.getAddress(), MaxUint256);
  await token1.approve(await factory.getAddress(), MaxUint256);

  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad: PRESET.aWad,
      lambdaWad: PRESET.lambdaWad,
      baseFee,
      emaPeriod: 1200,
      repegStepWad: 5n * 10n ** 15n,
      // Bands sit well inside the stall-guard cap (`baseFee · 1e14` =
      // 5e14 for a flat 5-bps pool), putting the parachute activation
      // at `parachuteBandMult × 1e14` (read from getFeeConfig(), never
      // hardcoded).
      repegThresholdToken1UpWad: DEAD_BAND_WAD,
      repegThresholdToken1DownWad: DEAD_BAND_WAD,
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

  return { owner, trader, token0, token1, pool, router, oracleHarness };
}

// Starved of own budget (5 bps fee × 1 bps share keeps the spendable
// surplus under the gas guard) but free to build a large anchor lag.
async function starvedFixture() {
  return deployFixture(1, 5);
}
// Same pool with an ample share: the ladder has a real budget, so the
// parachute branch must never be reached.
async function fundedFixture() {
  return deployFixture(10_000, 100);
}
// Full share but a 5 bps fee: real (above-gas-guard) budget, yet at a
// multi-% anchor lag even the smallest ladder rung costs more than the
// accrued growth — the post-ladder-exhaustion handover route.
async function exhaustedLadderFixture() {
  return deployFixture(10_000, 5);
}
// Auto-repeg opted out: the step-0 short-circuit must keep any donated
// buffer unspendable forever.
async function optOutFixture() {
  return deployFixture(0, 5);
}

async function swapExactIn(fx: Fixture, tokenIn: any, tokenOut: any, amountIn: bigint) {
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

async function driveIntoLag(fx: Fixture, bigSwapWei: bigint) {
  await swapExactIn(fx, fx.token0, fx.token1, bigSwapWei);
  await time.increase(3600); // 3 half-lives: EMA ≈ clamped spot
  await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
}

// Live per-pool gate parameters, read from the pool (K and the step are
// runtime-adjustable storage — never hardcode them).
type GateParams = {
  bandMult: bigint;
  storedShareBps: bigint;
  stepWad: bigint;
};

async function gateParams(fx: Fixture): Promise<GateParams> {
  const cfg = await fx.pool.getFeeConfig();
  // Stored (grossed-up) share: `⌊user · BPS / (BPS − pf·100)⌋` — the
  // exact inverse of getFeeConfig's ceil map. protocolFee = 0 in every
  // fixture here, so stored == user, but derive it anyway.
  const storedShareBps = (BigInt(cfg.repegShareBps) * BPS) / (BPS - BigInt(cfg.protocolFeePercent) * 100n);
  return {
    bandMult: BigInt(cfg.parachuteBandMult),
    storedShareBps,
    stepWad: BigInt(cfg.repegStepWad),
  };
}

function geometricDeviation(a: bigint, b: bigint): bigint {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi * WAD) / lo - WAD;
}

type Snapshot = {
  reserve0: bigint;
  reserve1: bigint;
  priceScaleWad: bigint;
  emaWad: bigint;
  deviationWad: bigint;
  activationWad: bigint;
  thresholdWad: bigint;
  vpLiveWad: bigint;
  surplusWad: bigint; // vpLive − threshold (0 when starved)
  fullCandidateWad: bigint;
  fullProbeWad: bigint;
  supply: bigint;
  expectedBurnShares: bigint;
  donationShares: bigint;
};

async function snapshot(fx: Fixture): Promise<Snapshot> {
  const oracle = await fx.pool.getOracleState();
  const [r0, r1] = await fx.pool.getReserves();
  const lp = await fx.pool.getLpValueState();
  const supply = BigInt(await fx.pool.totalSupply());
  const gp = await gateParams(fx);

  const ps = BigInt(oracle.priceScaleWad);
  const ema = BigInt(oracle.emaPriceWad);
  const deviationWad = geometricDeviation(ema, ps);
  const damped = deviationWad / REPEG_DAMPING_DIVISOR;
  const appliedWad = gp.stepWad < damped ? gp.stepWad : damped;

  const thresholdWad = BigInt(lp.genesisWad) + (BigInt(lp.growthWad) * (BPS - gp.storedShareBps)) / BPS;
  const vpLiveWad = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, ps, supply));
  const fullCandidateWad = BigInt(await fx.oracleHarness.applyLogStep(ps, ema, appliedWad));
  const fullProbeWad = BigInt(
    await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, fullCandidateWad, supply)
  );
  // δ = ⌈S · (T − vpAfter) / T⌉, zero when the candidate is accretive.
  const expectedBurnShares =
    fullProbeWad >= thresholdWad ? 0n : (supply * (thresholdWad - fullProbeWad) + thresholdWad - 1n) / thresholdWad;

  return {
    reserve0: BigInt(r0),
    reserve1: BigInt(r1),
    priceScaleWad: ps,
    emaWad: ema,
    deviationWad,
    // Both fixture bands are equal, so the active side is irrelevant.
    activationWad: DEAD_BAND_WAD * gp.bandMult,
    thresholdWad,
    vpLiveWad,
    surplusWad: vpLiveWad > thresholdWad ? vpLiveWad - thresholdWad : 0n,
    fullCandidateWad,
    fullProbeWad,
    supply,
    expectedBurnShares,
    donationShares: BigInt(await fx.pool.balanceOf(await fx.pool.getAddress())),
  };
}

async function donate(fx: Fixture, shares: bigint) {
  await fx.pool.connect(fx.owner).transfer(await fx.pool.getAddress(), shares);
}

async function priceScaleEvents(fx: Fixture, fromBlock: number) {
  return fx.pool.queryFilter(fx.pool.filters.PriceScaleUpdated(), fromBlock);
}

// Recompute the parachute's exact commit math from POST-state + the
// PriceScaleUpdated event. `swap()` writes the accrued growth and the
// final reserves BEFORE `_tryAutoRepeg` runs and the parachute mutates
// neither afterwards, so every input the pool used is reconstructible
// bit-for-bit after the trigger transaction.
async function auditCommit(fx: Fixture, event: any, donationBefore: bigint, supplyBefore: bigint) {
  const oldPs = BigInt(event.args[0]);
  const newPs = BigInt(event.args[1]);
  const emaAfter = BigInt(event.args[3]);
  const gp = await gateParams(fx);

  const [r0, r1] = await fx.pool.getReserves();
  const supplyAfter = BigInt(await fx.pool.totalSupply());
  const bufferAfter = BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()));
  const burned = donationBefore - bufferAfter;
  expect(supplyBefore - supplyAfter, "supply falls by exactly the burn").to.equal(burned);
  const supplyAtCommit = supplyAfter + burned;

  // (1) UPPER bound on the anchor move: the parachute commits EXACTLY
  // the full damped step `min(stepWad, dev/5)` — an undamped or
  // overshooting step (or a halved ladder rung) fails the equality.
  const devAtCommit = geometricDeviation(emaAfter, oldPs);
  const damped = devAtCommit / REPEG_DAMPING_DIVISOR;
  const applied = gp.stepWad < damped ? gp.stepWad : damped;
  const fullCandidate = BigInt(await fx.oracleHarness.applyLogStep(oldPs, emaAfter, applied));
  expect(newPs, "commit must be exactly the full damped step").to.equal(fullCandidate);
  const moved = newPs > oldPs ? newPs - oldPs : oldPs - newPs;
  const fullMove = fullCandidate > oldPs ? fullCandidate - oldPs : oldPs - fullCandidate;
  expect(moved).to.be.lessThanOrEqual(fullMove);

  // (2) EXACT shortfall burn δ = ⌈S · (T − vpAfter) / T⌉.
  const lpAfter = await fx.pool.getLpValueState();
  const floorWad = BigInt(lpAfter.genesisWad) + (BigInt(lpAfter.growthWad) * (BPS - gp.storedShareBps)) / BPS;
  const vpProbe = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, newPs, supplyAtCommit));
  const expectedBurn = vpProbe >= floorWad ? 0n : (supplyAtCommit * (floorWad - vpProbe) + floorWad - 1n) / floorWad;
  expect(burned, "burn is exactly the shortfall").to.equal(expectedBurn);

  // (3) Post-burn latch lands ON the gate floor: `⌊vpAfter·S/(S−δ)⌋`,
  // never below T, overshoot bounded to wei dust.
  const latch = BigInt(lpAfter.unitValueWad);
  expect(latch).to.equal((vpProbe * supplyAtCommit) / (supplyAtCommit - burned));
  expect(latch, "latch never lands below the gate floor").to.be.greaterThanOrEqual(floorWad);
  expect(latch - floorWad, "latch overshoot is wei dust").to.be.lessThanOrEqual(4n);

  return { burned, floorWad, latch, newPs };
}

describe("DonationParachute", () => {
  // Happy path: starved pool + large anchor lag + funded buffer ⇒ the
  // parachute commits the FULL step and burns exactly the shortfall.
  it("commits the full damped step and burns exactly the shortfall", async () => {
    const fx = await loadFixture(starvedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    expect(snap.surplusWad, "premise: no own budget").to.be.lessThanOrEqual(REPEG_GAS_GUARD_WAD);
    expect(snap.deviationWad, "premise: lag past the parachute activation").to.be.greaterThan(snap.activationWad);
    expect(snap.expectedBurnShares, "premise: the step needs a subsidy").to.be.greaterThan(0n);
    expect(snap.donationShares, "premise: buffer covers the shortfall").to.be.greaterThan(snap.expectedBurnShares);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "the parachute must commit").to.equal(1);

    const { burned } = await auditCommit(fx, events[0], snap.donationShares, snap.supply);
    expect(burned, "the parachute must burn from the buffer").to.be.greaterThan(0n);
  });

  // The δ = 0 no-subsidy commit the NatSpec documents: a candidate
  // probing AT or ABOVE the gate floor commits without touching the
  // buffer. No plain swap scenario reaches that state deterministically
  // (it needs a vp-accretive candidate at a starved gate), so this is
  // the state-constructed twin of the Rust unit test
  // `parachute_commits_without_subsidy_when_candidate_needs_none`: the
  // mock forwarder drives the production branch verbatim with a crafted
  // `vpFloorWad` while every other input is live pool state.
  it("commits with δ = 0 (no subsidy) when the candidate needs none", async () => {
    const fx = await loadFixture(starvedFixture);
    await donate(fx, hre.ethers.parseEther("1000"));

    const [r0, r1] = await fx.pool.getReserves();
    const oracle = await fx.pool.getOracleState();
    const ps = BigInt(oracle.priceScaleWad);
    const emaBefore = BigInt(oracle.emaPriceWad);
    const gp = await gateParams(fx);

    // Crafted qualifier set: a 1% lag clears K × band with margin; the
    // damped step min(stepWad, dev/5) stays inside the EMA clamp;
    // vpFloor = 1 wei forces the accretive arm (any live vp ≥ 1 wei),
    // i.e. the δ = 0 branch — `supplyAfter == supply`, no burn.
    const emaArg = (ps * 101n) / 100n;
    const deviation = geometricDeviation(emaArg, ps);
    expect(deviation, "premise: lag clears the activation").to.be.greaterThanOrEqual(DEAD_BAND_WAD * gp.bandMult);
    const damped = deviation / REPEG_DAMPING_DIVISOR;
    const applied = gp.stepWad < damped ? gp.stepWad : damped;
    const expectedPs = BigInt(await fx.oracleHarness.applyLogStep(ps, emaArg, applied));
    expect(expectedPs, "premise: the full step is a real move").to.not.equal(ps);

    const supplyBefore = BigInt(await fx.pool.totalSupply());
    const bufferBefore = BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()));
    expect(bufferBefore, "premise: usable buffer").to.be.greaterThan(REPEG_DONATION_DUST_SHARES);

    const returnedPs = await fx.pool.exposed_tryDonationParachute.staticCall(
      r0,
      r1,
      emaArg,
      emaBefore,
      gp.stepWad,
      deviation,
      1n
    );
    expect(returnedPs, "the parachute must commit the full step").to.equal(expectedPs);

    await expect(fx.pool.exposed_tryDonationParachute(r0, r1, emaArg, emaBefore, gp.stepWad, deviation, 1n))
      .to.emit(fx.pool, "PriceScaleUpdated")
      .withArgs(ps, expectedPs, emaBefore, emaArg);

    // δ = 0: no burn anywhere — supply and buffer bit-unchanged.
    expect(BigInt(await fx.pool.totalSupply()), "supply untouched").to.equal(supplyBefore);
    expect(BigInt(await fx.pool.balanceOf(await fx.pool.getAddress())), "buffer untouched").to.equal(bufferBefore);
    // Latch degenerates to the raw probe exactly: ⌊vp·S/S⌋ = vp.
    const probe = BigInt(await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(r0, r1, expectedPs, supplyBefore));
    const lp = await fx.pool.getLpValueState();
    expect(BigInt(lp.unitValueWad), "latch == raw vpAfter probe").to.equal(probe);
    expect(BigInt((await fx.pool.getOracleState()).priceScaleWad), "anchor committed").to.equal(expectedPs);
  });

  // The qualifier is the whole point of the parachute: an anchor lag
  // past the dead-band but below `K × band` must NOT touch donated
  // funds — ordinary regimes stay LP-budget-funded.
  it("never spends the buffer below the activation multiple", async () => {
    const fx = await loadFixture(starvedFixture);
    // Small drive: enough lag to clear the dead-band, far below K×band.
    await swapExactIn(fx, fx.token0, fx.token1, hre.ethers.parseEther("600"));
    await time.increase(3600);
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    expect(snap.surplusWad, "premise: no own budget").to.be.lessThanOrEqual(REPEG_GAS_GUARD_WAD);
    expect(snap.deviationWad, "premise: lag clears the dead-band").to.be.greaterThan(DEAD_BAND_WAD);
    expect(snap.deviationWad, "premise: lag below the activation multiple").to.be.lessThan(snap.activationWad);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);

    expect((await priceScaleEvents(fx, before + 1)).length, "no commit below activation").to.equal(0);
    expect(BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()))).to.equal(snap.donationShares);
    expect(BigInt(await fx.pool.totalSupply())).to.equal(snap.supply);
  });

  // A buffer that cannot cover the shortfall must leave everything
  // untouched — no partial burn, no anchor move.
  it("skips when the buffer cannot cover the shortfall", async () => {
    const fx = await loadFixture(starvedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));

    const probe = await snapshot(fx);
    expect(probe.expectedBurnShares, "premise: a subsidy is required").to.be.greaterThan(0n);
    // Above the dust floor, far below the shortfall.
    await donate(fx, REPEG_DONATION_DUST_SHARES * 10n);

    const snap = await snapshot(fx);
    expect(snap.donationShares).to.be.lessThan(snap.expectedBurnShares);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);

    expect((await priceScaleEvents(fx, before + 1)).length, "no commit without funds").to.equal(0);
    expect(BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()))).to.equal(snap.donationShares);
    expect(BigInt(await fx.pool.totalSupply())).to.equal(snap.supply);
  });

  // Edge: a wei-scale gift must not wake the parachute's probe work —
  // a buffer at the dust floor (≤ 1e12 shares) counts as empty.
  it("treats a dust buffer as empty", async () => {
    const fx = await loadFixture(starvedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, REPEG_DONATION_DUST_SHARES);

    const snap = await snapshot(fx);
    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);

    expect((await priceScaleEvents(fx, before + 1)).length, "dust must not commit").to.equal(0);
    expect(BigInt(await fx.pool.totalSupply())).to.equal(snap.supply);
  });

  // The ladder is strictly LP-budget-funded: a pool with its own budget
  // must reach a normal rung commit and leave the buffer untouched.
  it("leaves the buffer untouched while the pool has its own budget", async () => {
    const fx = await loadFixture(fundedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    expect(snap.surplusWad, "premise: the pool has an own budget").to.be.greaterThan(REPEG_GAS_GUARD_WAD);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    expect((await priceScaleEvents(fx, before + 1)).length, "the ladder must commit").to.equal(1);

    expect(
      BigInt(await fx.pool.balanceOf(await fx.pool.getAddress())),
      "a ladder commit must never spend donated shares"
    ).to.equal(snap.donationShares);
    expect(BigInt(await fx.pool.totalSupply())).to.equal(snap.supply);
  });

  // ============ Post-ladder-exhaustion handover route ============
  // The parachute is consulted from TWO call sites; the tests above hit
  // the pre-gate (no own budget at all). Here the pool HAS a real
  // budget (surplus > gas guard, so the ladder runs) but at a multi-%
  // lag every rung's IL cost exceeds it — the ladder exhausts and the
  // post-ladder handover must still reach the buffer.

  // Assert (from live state) that the ladder itself cannot commit:
  // every non-dust rung's post-move unit value sits below the floor.
  async function assertLadderExhausted(fx: Fixture, snap: Snapshot) {
    expect(snap.surplusWad, "premise: real own budget (pre-gate passes)").to.be.greaterThan(REPEG_GAS_GUARD_WAD);
    expect(snap.deviationWad, "premise: lag qualifies the parachute").to.be.greaterThanOrEqual(snap.activationWad);
    const gp = await gateParams(fx);
    const damped = snap.deviationWad / REPEG_DAMPING_DIVISOR;
    const applied = gp.stepWad < damped ? gp.stepWad : damped;
    let realRungs = 0;
    for (let k = 0n; k <= MAX_REPEG_STEP_HALVINGS; k++) {
      const rung = applied >> k;
      if (rung === 0n) break;
      const cand = BigInt(await fx.oracleHarness.applyLogStep(snap.priceScaleWad, snap.emaWad, rung));
      if (cand === snap.priceScaleWad) break; // dust move ends the ladder
      const vpK = BigInt(
        await fx.pool.exposed_computeLpUnitValueWadAtPriceScale(snap.reserve0, snap.reserve1, cand, snap.supply)
      );
      expect(vpK, `premise: rung ${k} must be unaffordable`).to.be.lessThan(snap.thresholdWad);
      realRungs += 1;
    }
    expect(realRungs, "premise: the ladder actually probed rungs").to.be.greaterThan(0);
  }

  it("commits from the buffer after the halving ladder exhausts every rung", async () => {
    const fx = await loadFixture(exhaustedLadderFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    await assertLadderExhausted(fx, snap);
    expect(snap.expectedBurnShares, "premise: the full step needs a subsidy").to.be.greaterThan(0n);
    expect(snap.donationShares, "premise: buffer covers the shortfall").to.be.greaterThan(snap.expectedBurnShares);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "the post-ladder handover must commit").to.equal(1);

    // A ladder rung never burns; the exact-δ burn + full-step equality
    // inside the audit prove the PARACHUTE committed.
    const { burned } = await auditCommit(fx, events[0], snap.donationShares, snap.supply);
    expect(burned, "the commit must be buffer-funded").to.be.greaterThan(0n);
  });

  it("the same exhausted-ladder state commits nothing without a buffer", async () => {
    const fx = await loadFixture(exhaustedLadderFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));

    const snap = await snapshot(fx);
    await assertLadderExhausted(fx, snap);
    expect(snap.donationShares, "premise: empty buffer").to.equal(0n);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);

    expect((await priceScaleEvents(fx, before + 1)).length, "no funds — no commit").to.equal(0);
    expect(BigInt(await fx.pool.totalSupply())).to.equal(snap.supply);
  });

  // ============ vp-invariance of the liquidity legs ============
  // Both liquidity legs rescale the parked buffer to keep
  // `parked/active` — and therefore vp and the parachute's feasibility
  // — invariant. Without that, exits would drop vp below the gate floor
  // (making every later parachute burn larger — a donation-griefing
  // DoS) and joins could fabricate spendable budget.

  it("S1: an ordinary removeLiquidity keeps vp on the gate floor", async () => {
    const fx = await loadFixture(starvedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "setup: parachute commit lands vp on the floor").to.equal(1);
    const { floorWad, latch } = await auditCommit(fx, events[0], snap.donationShares, snap.supply);

    const parked = BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()));
    const supply = BigInt(await fx.pool.totalSupply());
    const active = supply - parked;
    const shares = BigInt(await fx.pool.balanceOf(fx.owner.address)) / 10n;

    await fx.pool.connect(fx.owner).removeLiquidity(shares, 0n, 0n, fx.owner.address);

    // The re-anchored unit value stays ON the floor (the buffer burn
    // keeps parked/active — hence vp — invariant up to wei rounding).
    const vpAfter = BigInt((await fx.pool.getLpValueState()).unitValueWad);
    const drift = vpAfter >= latch ? vpAfter - latch : latch - vpAfter;
    expect(drift, "exit must not move vp off the gate floor").to.be.lessThanOrEqual(16n);
    expect(vpAfter + 16n, "no budget destroyed below the floor").to.be.greaterThanOrEqual(floorWad);

    // The buffer was rescaled by exactly the exiting holder's slice.
    const expectedBufferBurn = (parked * shares) / active;
    expect(parked - BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()))).to.equal(expectedBufferBurn);
  });

  it("a whale exit does not break parachute feasibility (DoS gone)", async () => {
    const fx = await loadFixture(starvedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    // Whale: the owner holds ~the entire active float; drop half of it.
    const whaleShares = BigInt(await fx.pool.balanceOf(fx.owner.address)) / 2n;
    await fx.pool.connect(fx.owner).removeLiquidity(whaleShares, 0n, 0n, fx.owner.address);

    // Premises re-checked on the POST-exit state: still starved, still
    // past activation, buffer still covers the (rescaled) shortfall.
    const snap = await snapshot(fx);
    expect(snap.surplusWad, "premise: still no own budget").to.be.lessThanOrEqual(REPEG_GAS_GUARD_WAD);
    expect(snap.deviationWad, "premise: lag still past activation").to.be.greaterThan(snap.activationWad);
    expect(snap.expectedBurnShares, "premise: a subsidy is still required").to.be.greaterThan(0n);
    expect(snap.donationShares, "premise: rescaled buffer still covers").to.be.greaterThan(snap.expectedBurnShares);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);
    const events = await priceScaleEvents(fx, before + 1);
    expect(events.length, "the parachute must still commit after the exit").to.equal(1);
    const { burned } = await auditCommit(fx, events[0], snap.donationShares, snap.supply);
    expect(burned).to.be.greaterThan(0n);
  });

  it("addLiquidity against a live buffer leaves the spendable surplus unchanged", async () => {
    const fx = await loadFixture(fundedFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    expect(snap.surplusWad, "premise: a real spendable surplus exists").to.be.greaterThan(REPEG_GAS_GUARD_WAD);
    const active = snap.supply - snap.donationShares;
    const traderBefore = BigInt(await fx.pool.balanceOf(fx.trader.address));

    await fx.router.connect(fx.trader).addLiquidity({
      tokenA: await fx.token0.getAddress(),
      tokenB: await fx.token1.getAddress(),
      poolIndex: 0,
      amountADesired: hre.ethers.parseEther("100000"),
      amountBDesired: hre.ethers.parseEther("100000"),
      minShares: 0n,
      recipient: fx.trader.address,
      deadline: MaxUint256,
    });

    const sharesOut = BigInt(await fx.pool.balanceOf(fx.trader.address)) - traderBefore;
    expect(sharesOut).to.be.greaterThan(0n);

    // No budget fabrication: the join must not move `vpLive − floor`.
    const after = await snapshot(fx);
    const surplusDrift =
      after.surplusWad >= snap.surplusWad ? after.surplusWad - snap.surplusWad : snap.surplusWad - after.surplusWad;
    expect(surplusDrift, "join must not fabricate or destroy budget").to.be.lessThanOrEqual(REPEG_GAS_GUARD_WAD);

    // The buffer was topped up by exactly the joiner's proportional
    // slice, keeping parked/active invariant.
    const expectedTopUp = (sharesOut * snap.donationShares) / active;
    expect(after.donationShares - snap.donationShares).to.equal(expectedTopUp);
  });

  // Edge: pools that opted out of auto-repeg (`repegShareBps == 0`)
  // never reach the parachute — a donated buffer is unspendable.
  it("a repegShareBps == 0 pool never spends a donated buffer", async () => {
    const fx = await loadFixture(optOutFixture);
    await driveIntoLag(fx, hre.ethers.parseEther("30000"));
    await donate(fx, hre.ethers.parseEther("50000"));

    const snap = await snapshot(fx);
    expect(snap.deviationWad, "premise: lag would qualify the parachute").to.be.greaterThan(snap.activationWad);
    expect(snap.donationShares, "premise: funded buffer").to.be.greaterThan(REPEG_DONATION_DUST_SHARES);

    const before = await hre.ethers.provider.getBlockNumber();
    await swapExactIn(fx, fx.token0, fx.token1, 10n ** 12n);

    expect((await priceScaleEvents(fx, before + 1)).length, "opt-out: no commit ever").to.equal(0);
    expect(BigInt(await fx.pool.balanceOf(await fx.pool.getAddress()))).to.equal(snap.donationShares);
    expect(BigInt(await fx.pool.totalSupply())).to.equal(snap.supply);
  });
});
