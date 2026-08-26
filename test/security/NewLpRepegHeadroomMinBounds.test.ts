import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { formatEther, MaxUint256 } from "ethers";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const Q96_ONE = 1n << 96n;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function fmt(value: bigint): string {
  return formatEther(value);
}

// ---------------------------------------------------------------------------
// Report.md ("New LP inherits and scales old repeg headroom") demonstrated
// a PROFITABLE closed two-repeg cycle at the OLD factory floor bounds
// (baseFee = 1 bp, emaPeriod = 30 s): Bob finished +61, Charlie −195.
//
// The shipped mitigation is the new floor bounds — MIN_BASE_FEE = 5 bps and
// MIN_EMA_PERIOD = 60 s (Constants.sol) — which flip the economics:
// manipulation swaps pay first-order fees (5x higher) while the repeg
// transfer is second-order in the 10 bp step, so the manipulation phase
// becomes fee-negative and the whole cycle turns into a donation to LPs.
//
// This test is the PoC reworked into a regression guard at exactly those
// MIN bounds, with every other knob kept at its most attacker-favourable
// valid value (10 bp step, 1 bp dead-bands, repegShare = 100%). It proves:
//   1. the attack MECHANICS still execute fully (both repegs fire, the
//      cycle closes: spot and priceScale return to their initial values);
//   2. yet the attacker loses — at ANY accumulated headroom size (small
//      and large budget variants), in BOTH tokens independently;
//   3. the would-be victims (pool / Charlie) end net POSITIVE.
//
// Note: the headroom amplification itself (postJoin budget ≈ 4x) is still
// present — it is covered by RepegBudgetInvariant.test.ts as a
// proportionality invariant. This test pins that the amplification is not
// spendable profitably at the floor bounds. If factory bounds are ever
// lowered again, this suite is the tripwire.
// ---------------------------------------------------------------------------

interface AttackResult {
  bobBudgetPnl: bigint;
  bobAttackPnl: bigint;
  bobFullPnl: bigint;
  bobToken0Delta: bigint;
  bobToken1Delta: bigint;
  charlieDelta: bigint;
  poolAttackDelta: bigint;
  preJoinHeadroom: bigint;
  postJoinHeadroom: bigint;
  scaleError: bigint;
  spotError: bigint;
  repegs: number;
  donationAfterDonate: bigint;
  donationAfterJoin: bigint;
  donationSpent: bigint;
}

// How the repeg gate gets funded in phase 1:
//  - headroom: Bob pays swap fees in same-timestamp round trips (vp growth).
//  - donation: Bob mints LP and parks ALL shares at the pool address. Parked
//    shares carry no claim on reserves and are spendable only by the
//    donation parachute inside _tryAutoRepeg — the cheapest possible gate
//    funding because the parachute burns exactly the shortfall δ (a
//    second-order dust amount per 10 bp commit).
type Funding = { type: "headroom"; cycles: number } | { type: "donation"; amount: bigint };

async function runAttack(funding: Funding): Promise<AttackResult> {
  const [alice, bob, charlie, protocol] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token A", "TKA", 18);
  const tokenB = await Token.deploy("Token B", "TKB", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const [token0, token1] =
    (await tokenA.getAddress()).toLowerCase() < (await tokenB.getAddress()).toLowerCase()
      ? [tokenA, tokenB]
      : [tokenB, tokenA];
  const token0Address = await token0.getAddress();
  const token1Address = await token1.getAddress();

  // Production pool implementation — no internals-exposing mock.
  const Pool = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImplementation = await Pool.deploy();
  await poolImplementation.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImplementation.getAddress(), alice.address, alice.address, 0);
  await factory.waitForDeployment();
  await factory.setProtocolFee(0);
  await factory.setFeeCollector(protocol.address);

  const seed = hre.ethers.parseEther("1000000");
  const participantFunding = hre.ethers.parseEther("20000000");
  await token0.mint(alice.address, seed);
  await token1.mint(alice.address, seed);
  for (const signer of [bob, charlie]) {
    await token0.mint(signer.address, participantFunding);
    await token1.mint(signer.address, participantFunding);
  }

  await token0.connect(alice).approve(await factory.getAddress(), MaxUint256);
  await token1.connect(alice).approve(await factory.getAddress(), MaxUint256);

  // The PoC configuration moved to the CURRENT factory floor bounds
  // (baseFee = 5 = MIN_BASE_FEE, emaPeriod = 60 = MIN_EMA_PERIOD); every
  // other knob stays at its most attacker-favourable valid value.
  await factory.connect(alice).createPoolAndAddLiquidity(
    token0Address,
    token1Address,
    {
      aWad: 909_610_000_000_000_030n,
      lambdaWad: 16_780_000_000_000_000n,
      baseFee: 5, // MIN_BASE_FEE — the cheapest manipulation the factory allows
      emaPeriod: 60, // MIN_EMA_PERIOD — the fastest EMA the factory allows
      repegStepWad: 1_000_000_000_000_000n, // 10 bp
      repegThresholdToken1UpWad: 100_000_000_000_000n, // 1 bp
      repegThresholdToken1DownWad: 100_000_000_000_000n, // 1 bp
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps: 10_000, // all accrued growth may fund repegs
    },
    seed,
    seed,
    alice.address
  );

  const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(
    await factory.getAddress(),
    await poolImplementation.getAddress(),
    await weth.getAddress()
  );
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();

  for (const signer of [bob, charlie]) {
    await token0.connect(signer).approve(routerAddress, MaxUint256);
    await token1.connect(signer).approve(routerAddress, MaxUint256);
  }

  const bobInitial0 = BigInt(await token0.balanceOf(bob.address));
  const bobInitial1 = BigInt(await token1.balanceOf(bob.address));

  const swapParams = (zeroForOne: boolean, amountIn: bigint) => ({
    tokenIn: zeroForOne ? token0Address : token1Address,
    tokenOut: zeroForOne ? token1Address : token0Address,
    poolIndex: 0,
    recipient: bob.address,
    amountIn,
    amountOutMinimum: 0n,
    deadline: MaxUint256,
  });

  const encodeSwap = (zeroForOne: boolean, amountIn: bigint) =>
    router.interface.encodeFunctionData("exactInputSingle", [swapParams(zeroForOne, amountIn)]);

  const bobTokenDeltas = async () => ({
    token0: BigInt(await token0.balanceOf(bob.address)) - bobInitial0,
    token1: BigInt(await token1.balanceOf(bob.address)) - bobInitial1,
  });

  const bobPnl = async () => {
    const delta = await bobTokenDeltas();
    return delta.token0 + delta.token1; // fixed external P0 = 1
  };

  const rawSpotWad = async () => {
    const oracle = await pool.getOracleState();
    return (BigInt(oracle.pMargWad) * BigInt(oracle.priceScaleWad)) / WAD;
  };

  const headroom = async () => {
    const lp = await pool.getLpValueState();
    const supply = BigInt(await pool.totalSupply());
    // repegShareBps == 10000 and protocolFee == 0 => floor == genesis.
    const perLp = BigInt(lp.unitValueWad) - BigInt(lp.genesisWad);
    return { perLp, total: (perLp * supply) / WAD };
  };

  // Phase 1: fund the repeg gate without moving the anchor.
  let donationAfterDonate = 0n;
  if (funding.type === "headroom") {
    // Fee-funded growth. Same-timestamp round trips; the snapshot only sizes
    // the reverse leg (calldata discovery, not an attack primitive).
    for (let cycle = 0; cycle < funding.cycles; cycle++) {
      const [reserve0] = (await pool.getReserves()).map(BigInt);
      const amountIn = (reserve0 * 500n) / BPS; // 5% of token0 reserve
      const timestamp = BigInt(await time.latest()) + 1n;

      const snapshot = await hre.network.provider.send("evm_snapshot", []);
      await time.setNextBlockTimestamp(timestamp);
      await router.connect(bob).exactInputSingle(swapParams(true, amountIn));
      const [reverseAmount] = await pool.quoteSwapToPrice(false, Q96_ONE);
      await hre.network.provider.send("evm_revert", [snapshot]);

      await time.setNextBlockTimestamp(timestamp);
      await router.connect(bob).multicall([encodeSwap(true, amountIn), encodeSwap(false, BigInt(reverseAmount))]);
    }
  } else {
    // Donation funding: Bob mints LP and parks every share at the pool.
    await router.connect(bob).addLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      recipient: bob.address,
      amountADesired: funding.amount,
      amountBDesired: funding.amount,
      minShares: 0n,
      deadline: MaxUint256,
    });
    const poolAddress = await pool.getAddress();
    const bobShares = BigInt(await pool.balanceOf(bob.address));
    await pool.connect(bob).transfer(poolAddress, bobShares);
    donationAfterDonate = BigInt(await pool.balanceOf(poolAddress));
  }

  const beforeJoin = await headroom();

  // Phase 2: Charlie joins with 3x the reserves (75% of post-mint supply).
  const [reserve0BeforeJoin, reserve1BeforeJoin] = (await pool.getReserves()).map(BigInt);
  const charlie0Before = BigInt(await token0.balanceOf(charlie.address));
  const charlie1Before = BigInt(await token1.balanceOf(charlie.address));

  await router.connect(charlie).addLiquidity({
    tokenA: token0Address,
    tokenB: token1Address,
    poolIndex: 0,
    recipient: charlie.address,
    amountADesired: reserve0BeforeJoin * 3n,
    amountBDesired: reserve1BeforeJoin * 3n,
    minShares: 0n,
    deadline: MaxUint256,
  });

  const charlieDepositValue =
    charlie0Before -
    BigInt(await token0.balanceOf(charlie.address)) +
    (charlie1Before - BigInt(await token1.balanceOf(charlie.address)));
  const charlieShares = BigInt(await pool.balanceOf(charlie.address));
  const afterJoin = await headroom();
  const donationAfterJoin = BigInt(await pool.balanceOf(await pool.getAddress()));

  const preAttackSpot = await rawSpotWad();
  const preAttackScale = BigInt((await pool.getOracleState()).priceScaleWad);
  const [preAttackReserve0, preAttackReserve1] = (await pool.getReserves()).map(BigInt);
  const bobBudgetPnl = await bobPnl();
  const blockBeforeAttack = await hre.ethers.provider.getBlockNumber();

  // Phase 3: push spot +5%, hold 150 s (2.5 half-lives at the 60 s floor —
  // sufficient: the dead-band is 1 bp and the step is capped at 10 bp, so
  // deeper EMA convergence changes nothing), trigger the upward repeg,
  // close and invert in the SAME timestamp.
  const [forwardReserve0] = (await pool.getReserves()).map(BigInt);
  await router.connect(bob).exactInputSingle(swapParams(true, (forwardReserve0 * 500n) / BPS));
  await time.increase(150);

  const firstTriggerTimestamp = BigInt(await time.latest()) + 1n;
  const firstSnapshot = await hre.network.provider.send("evm_snapshot", []);
  await time.setNextBlockTimestamp(firstTriggerTimestamp);
  await router.connect(bob).exactInputSingle(swapParams(true, hre.ethers.parseEther("1")));
  const [firstCloseAmount] = await pool.quoteSwapToPrice(false, Q96_ONE);
  const [, candidateReserve1] = (await pool.getReserves()).map(BigInt);
  const reverseManipulationAmount = ((candidateReserve1 + BigInt(firstCloseAmount)) * 500n) / BPS;
  await hre.network.provider.send("evm_revert", [firstSnapshot]);

  await time.setNextBlockTimestamp(firstTriggerTimestamp);
  await router
    .connect(bob)
    .multicall([
      encodeSwap(true, hre.ethers.parseEther("1")),
      encodeSwap(false, BigInt(firstCloseAmount)),
      encodeSwap(false, reverseManipulationAmount),
    ]);

  // Phase 4: hold the downward spot another 150 s, trigger the reverse
  // repeg, close back to raw spot P0 in the same timestamp.
  await time.increase(150);
  const secondTriggerTimestamp = BigInt(await time.latest()) + 1n;
  const secondSnapshot = await hre.network.provider.send("evm_snapshot", []);
  await time.setNextBlockTimestamp(secondTriggerTimestamp);
  await router.connect(bob).exactInputSingle(swapParams(false, hre.ethers.parseEther("1")));
  const [secondCloseAmount] = await pool.quoteSwapToPrice(true, Q96_ONE);
  await hre.network.provider.send("evm_revert", [secondSnapshot]);

  await time.setNextBlockTimestamp(secondTriggerTimestamp);
  await router
    .connect(bob)
    .multicall([encodeSwap(false, hre.ethers.parseEther("1")), encodeSwap(true, BigInt(secondCloseAmount))]);

  const finalScale = BigInt((await pool.getOracleState()).priceScaleWad);
  const finalSpot = await rawSpotWad();
  const [finalReserve0, finalReserve1] = (await pool.getReserves()).map(BigInt);
  const bobFullPnl = await bobPnl();
  const bobFullTokenDeltas = await bobTokenDeltas();
  const bobAttackPnl = bobFullPnl - bobBudgetPnl;

  const repegEvents = await pool.queryFilter(pool.filters.PriceScaleUpdated(), blockBeforeAttack + 1, "latest");
  const poolAttackDelta = finalReserve0 + finalReserve1 - (preAttackReserve0 + preAttackReserve1);
  // Buffer spent by the donation parachute during the attack, measured
  // BEFORE Charlie's withdrawal (the exit-leg buffer burn is proportional
  // rebalancing, not a parachute spend).
  const donationSpent = donationAfterJoin - BigInt(await pool.balanceOf(await pool.getAddress()));

  // Charlie performs a real full withdrawal through the router.
  await pool.connect(charlie).approve(routerAddress, charlieShares);
  const charlieWithdraw0Before = BigInt(await token0.balanceOf(charlie.address));
  const charlieWithdraw1Before = BigInt(await token1.balanceOf(charlie.address));
  await router.connect(charlie).removeLiquidity({
    tokenA: token0Address,
    tokenB: token1Address,
    poolIndex: 0,
    shares: charlieShares,
    amountAMin: 0n,
    amountBMin: 0n,
    recipient: charlie.address,
    deadline: MaxUint256,
  });
  const charlieWithdraw =
    BigInt(await token0.balanceOf(charlie.address)) -
    charlieWithdraw0Before +
    (BigInt(await token1.balanceOf(charlie.address)) - charlieWithdraw1Before);
  const charlieDelta = charlieWithdraw - charlieDepositValue;

  return {
    bobBudgetPnl,
    bobAttackPnl,
    bobFullPnl,
    bobToken0Delta: bobFullTokenDeltas.token0,
    bobToken1Delta: bobFullTokenDeltas.token1,
    charlieDelta,
    poolAttackDelta,
    preJoinHeadroom: beforeJoin.total,
    postJoinHeadroom: afterJoin.total,
    scaleError: abs(finalScale - preAttackScale),
    spotError: abs(finalSpot - preAttackSpot),
    repegs: repegEvents.length,
    donationAfterDonate,
    donationAfterJoin,
    donationSpent,
  };
}

function expectUnprofitable(r: AttackResult) {
  console.table([
    {
      preJoinHeadroom: fmt(r.preJoinHeadroom),
      postJoinHeadroom: fmt(r.postJoinHeadroom),
      bobBudgetPnl: fmt(r.bobBudgetPnl),
      bobAttackPnl: fmt(r.bobAttackPnl),
      bobFullPnl: fmt(r.bobFullPnl),
      bobToken0Delta: fmt(r.bobToken0Delta),
      bobToken1Delta: fmt(r.bobToken1Delta),
      charlieDelta: fmt(r.charlieDelta),
      poolAttackDelta: fmt(r.poolAttackDelta),
      scaleError: fmt(r.scaleError),
      repegs: r.repegs,
    },
  ]);

  // 1. The attack mechanics executed FULLY — the loss below is economic,
  //    not a misfire: both repegs fired and the cycle closed.
  expect(r.repegs).to.equal(2);
  expect(r.scaleError).to.be.lessThanOrEqual(2n);
  expect(r.spotError).to.be.lessThan(2n * 10n ** 10n);

  // 2. Building the headroom still costs what it builds.
  expect(r.bobBudgetPnl).to.be.lessThan(0n);
  expect(r.bobBudgetPnl).to.be.closeTo(-r.preJoinHeadroom, r.preJoinHeadroom / 50n + 10n ** 6n);

  // 3. The headroom DID amplify (the accounting fact from the report)…
  expect(r.postJoinHeadroom).to.be.greaterThan(r.preJoinHeadroom * 3n);

  // 4. …but at MIN_BASE_FEE the manipulation phase is fee-negative…
  expect(r.bobAttackPnl).to.be.lessThan(0n);
  // 5. …so the full cycle loses in BOTH tokens independently — no
  //    cross-token valuation can hide the loss.
  expect(r.bobFullPnl).to.be.lessThan(0n);
  expect(r.bobToken0Delta).to.be.lessThan(0n);
  expect(r.bobToken1Delta).to.be.lessThan(0n);

  // 6. The would-be victims end net positive: the "attack" is a donation.
  expect(r.poolAttackDelta).to.be.greaterThan(0n);
  expect(r.poolAttackDelta).to.be.closeTo(-r.bobAttackPnl, 4n);
  expect(r.charlieDelta).to.be.greaterThan(0n);
}

describe("NewLpRepegHeadroomMinBounds: the report's attack is unprofitable at floor bounds", function () {
  this.timeout(300_000);

  it("small accumulated budget (2 cycles): full cycle loses in both tokens", async function () {
    const r = await runAttack({ type: "headroom", cycles: 2 });
    expectUnprofitable(r);
  });

  it("large accumulated budget (20 cycles): even 3968 amplified headroom cannot convert", async function () {
    const r = await runAttack({ type: "headroom", cycles: 20 });
    expectUnprofitable(r);
  });

  // Donation funding is the CHEAPEST way to open the repeg gate: the
  // parachute burns exactly the per-commit shortfall δ (second-order dust
  // for a 10 bp step), so a parked donation funds repegs at a fraction of
  // what fee-funded headroom costs. This variant proves that even the
  // cheapest funding loses at the MIN bounds — and that the repegs here
  // commit through the halving LADDER on manipulation-swap fees (vpBefore
  // clears the floor at repegShare = 100%), leaving the parked buffer
  // effectively untouched.
  it("donation-funded gate: even the cheapest funding loses, buffer barely spent", async function () {
    const r = await runAttack({ type: "donation", amount: hre.ethers.parseEther("1000") });
    console.table([
      {
        donationAfterDonate: fmt(r.donationAfterDonate),
        donationAfterJoin: fmt(r.donationAfterJoin),
        donationSpent: fmt(r.donationSpent),
        bobBudgetPnl: fmt(r.bobBudgetPnl),
        bobAttackPnl: fmt(r.bobAttackPnl),
        bobFullPnl: fmt(r.bobFullPnl),
        bobToken0Delta: fmt(r.bobToken0Delta),
        bobToken1Delta: fmt(r.bobToken1Delta),
        charlieDelta: fmt(r.charlieDelta),
        poolAttackDelta: fmt(r.poolAttackDelta),
        scaleError: fmt(r.scaleError),
        repegs: r.repegs,
      },
    ]);

    // 1. The attack mechanics executed FULLY — both repegs fired. Unlike
    //    the headroom variant the cycle does NOT close bit-exactly: the
    //    halving ladder settles on different rungs per direction (the
    //    fee-funded budget available at each trigger differs), leaving the
    //    anchor within one repeg step of its start (measured: ~5 bp, the
    //    halved rung). Assert closure up to one full 10 bp step.
    expect(r.repegs).to.equal(2);
    expect(r.scaleError).to.be.lessThanOrEqual(1_000_000_000_000_000n);
    expect(r.spotError).to.be.lessThan(2n * 10n ** 10n);

    // 2. Charlie's 3x join multiplied the parked buffer ~4x via the
    //    proportional mint top-up (sharesOut x parked/active).
    expect(r.donationAfterDonate).to.be.greaterThan(0n);
    expect(r.donationAfterJoin).to.be.closeTo(r.donationAfterDonate * 4n, r.donationAfterDonate / 10n);

    // 3. The repegs committed through the halving ladder on
    //    manipulation-swap fee growth — the donation buffer is (at most
    //    dust) touched by the parachute.
    expect(r.donationSpent).to.be.lessThanOrEqual(r.donationAfterJoin / 100n + 10n ** 6n);

    // 4. Donating the seed LP is itself the budget cost…
    expect(r.bobBudgetPnl).to.be.lessThan(0n);
    // 5. …the manipulation phase stays fee-negative at MIN_BASE_FEE…
    expect(r.bobAttackPnl).to.be.lessThan(0n);
    // 6. …so the full cycle loses. The loss is concentrated in token0;
    //    token1 shows a residual GAIN because the unclosed 5 bp anchor
    //    offset leaves Bob with a residual position — worth less than the
    //    loss even at face value, so the fixed-P0 total stays negative.
    expect(r.bobFullPnl).to.be.lessThan(0n);
    expect(r.bobToken0Delta).to.be.lessThan(0n);

    // 7. The would-be victims end net positive.
    expect(r.poolAttackDelta).to.be.greaterThan(0n);
    expect(r.charlieDelta).to.be.greaterThan(0n);
  });
});
