import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import hre from "hardhat";
import { formatEther, MaxUint256 } from "ethers";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const Q96_ONE = 1n << 96n;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ---------------------------------------------------------------------------
// RESEARCH probe (not a regression guard — lives outside every npm-test glob;
// run explicitly: `npx hardhat test test/experiments/CurveShapeAttackSurface.test.ts`).
//
// How does the CURVE SHAPE (aWad, lambdaWad) affect the two-repeg attack
// surface of NewLpRepegHeadroomMinBounds? Same attack runner, parameterized:
//   - aWad      (depth at anchor)  x lambdaWad (plateau width)
//   - baseFee   (flat fee; feeRampBps = 0)
//   - funding   headroom round-trips | LP donation | none
//
// Everything runs at the CURRENT factory floor bounds (MIN_EMA_PERIOD = 60 s,
// MIN_BASE_FEE = 5 bps for the lowest cell) with the most attacker-favourable
// repeg knobs (10 bp step, 1 bp dead-bands, repegShare = 100%).
//
// Per run we record: attack-phase PnL, full-cycle PnL, pool-side delta,
// repegs fired, donation buffer spent (parachute vs ladder question) and the
// fees paid during the attack phase (from Swap events).
// ---------------------------------------------------------------------------

type Funding = { type: "headroom"; cycles: number } | { type: "donation"; amount: bigint } | { type: "none" };

interface AttackOptions {
  aWad: bigint;
  lambdaWad: bigint;
  baseFee: number;
  emaPeriod: number;
  funding: Funding;
}

interface AttackResult {
  bobBudgetPnl: bigint;
  bobAttackPnl: bigint;
  bobFullPnl: bigint;
  poolAttackDelta: bigint;
  charlieDelta: bigint;
  attackFees: bigint;
  donationAfterDonate: bigint;
  donationAfterJoin: bigint;
  donationSpent: bigint;
  scaleError: bigint;
  repegs: number;
}

async function runAttack(opts: AttackOptions): Promise<AttackResult> {
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

  await factory.connect(alice).createPoolAndAddLiquidity(
    token0Address,
    token1Address,
    {
      aWad: opts.aWad,
      lambdaWad: opts.lambdaWad,
      baseFee: opts.baseFee,
      emaPeriod: opts.emaPeriod,
      repegStepWad: 1_000_000_000_000_000n, // 10 bp
      repegThresholdToken1UpWad: 100_000_000_000_000n, // 1 bp
      repegThresholdToken1DownWad: 100_000_000_000_000n, // 1 bp
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps: 10_000,
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

  const bobPnl = async () => {
    const d0 = BigInt(await token0.balanceOf(bob.address)) - bobInitial0;
    const d1 = BigInt(await token1.balanceOf(bob.address)) - bobInitial1;
    return d0 + d1; // fixed external P0 = 1
  };

  // Phase 1: fund the repeg gate (or skip it entirely for funding 'none').
  let donationAfterDonate = 0n;
  if (opts.funding.type === "headroom") {
    for (let cycle = 0; cycle < opts.funding.cycles; cycle++) {
      const [reserve0] = (await pool.getReserves()).map(BigInt);
      const amountIn = (reserve0 * 500n) / BPS;
      const timestamp = BigInt(await time.latest()) + 1n;

      const snapshot = await hre.network.provider.send("evm_snapshot", []);
      await time.setNextBlockTimestamp(timestamp);
      await router.connect(bob).exactInputSingle(swapParams(true, amountIn));
      const [reverseAmount] = await pool.quoteSwapToPrice(false, Q96_ONE);
      await hre.network.provider.send("evm_revert", [snapshot]);

      await time.setNextBlockTimestamp(timestamp);
      await router.connect(bob).multicall([encodeSwap(true, amountIn), encodeSwap(false, BigInt(reverseAmount))]);
    }
  } else if (opts.funding.type === "donation") {
    await router.connect(bob).addLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      recipient: bob.address,
      amountADesired: opts.funding.amount,
      amountBDesired: opts.funding.amount,
      minShares: 0n,
      deadline: MaxUint256,
    });
    const poolAddress = await pool.getAddress();
    const bobShares = BigInt(await pool.balanceOf(bob.address));
    await pool.connect(bob).transfer(poolAddress, bobShares);
    donationAfterDonate = BigInt(await pool.balanceOf(poolAddress));
  }

  // Phase 2: Charlie joins with 3x the reserves.
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
  const donationAfterJoin = BigInt(await pool.balanceOf(await pool.getAddress()));

  const preAttackScale = BigInt((await pool.getOracleState()).priceScaleWad);
  const [preAttackReserve0, preAttackReserve1] = (await pool.getReserves()).map(BigInt);
  const bobBudgetPnl = await bobPnl();
  const blockBeforeAttack = await hre.ethers.provider.getBlockNumber();

  // Phase 3: push spot +5%, hold 150 s, trigger the upward repeg, close and
  // invert in the same timestamp.
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
  const [finalReserve0, finalReserve1] = (await pool.getReserves()).map(BigInt);
  const bobFullPnl = await bobPnl();
  const bobAttackPnl = bobFullPnl - bobBudgetPnl;

  const repegEvents = await pool.queryFilter(pool.filters.PriceScaleUpdated(), blockBeforeAttack + 1, "latest");
  const swapEvents = await pool.queryFilter(pool.filters.Swap(), blockBeforeAttack + 1, "latest");
  const attackFees = swapEvents.reduce((acc, ev) => acc + BigInt(ev.args.feeAmount), 0n);
  const poolAttackDelta = finalReserve0 + finalReserve1 - (preAttackReserve0 + preAttackReserve1);
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
    poolAttackDelta,
    charlieDelta,
    attackFees,
    donationAfterDonate,
    donationAfterJoin,
    donationSpent,
    scaleError: abs(finalScale - preAttackScale),
    repegs: repegEvents.length,
  };
}

function num(value: bigint): number {
  return Number(formatEther(value));
}

describe("CurveShapeAttackSurface: curve shape vs the two-repeg attack (research)", function () {
  this.timeout(1_800_000);

  const A_WADS = [3n * 10n ** 17n, 7n * 10n ** 17n, 909_610_000_000_000_030n, 99n * 10n ** 16n];
  const LAMBDAS = [10n ** 15n, 16_780_000_000_000_000n, 10n ** 17n, 10n ** 18n];
  const BASE_FEES = [5, 20, 100];
  const FUNDINGS: { label: string; funding: Funding }[] = [
    { label: "headroom2", funding: { type: "headroom", cycles: 2 } },
    { label: "donation1k", funding: { type: "donation", amount: hre.ethers.parseEther("1000") } },
  ];

  it("sweeps aWad x lambdaWad x baseFee x funding at MIN bounds", async function () {
    const rows: Record<string, string | number>[] = [];

    for (const aWad of A_WADS) {
      for (const lambdaWad of LAMBDAS) {
        for (const baseFee of BASE_FEES) {
          for (const { label, funding } of FUNDINGS) {
            const tag = `a=${num(aWad)} λ=${num(lambdaWad)} fee=${baseFee} ${label}`;
            try {
              const r = await runAttack({ aWad, lambdaWad, baseFee, emaPeriod: 60, funding });
              rows.push({
                run: tag,
                bobBudget: num(r.bobBudgetPnl).toFixed(2),
                bobAttack: num(r.bobAttackPnl).toFixed(2),
                bobFull: num(r.bobFullPnl).toFixed(2),
                poolDelta: num(r.poolAttackDelta).toFixed(2),
                charlie: num(r.charlieDelta).toFixed(2),
                atkFees: num(r.attackFees).toFixed(2),
                donSpent: num(r.donationSpent).toFixed(6),
                repegs: r.repegs,
                scaleErr: num(r.scaleError).toExponential(1),
              });
            } catch (err) {
              rows.push({ run: tag, bobFull: `N/A: ${String(err).slice(0, 120)}` });
            }
          }
        }
      }
    }

    // Control: no phase-1 funding at all on the PoC curve at 5 bps — do the
    // manipulation swaps' own fees open the gate?
    try {
      const r = await runAttack({
        aWad: 909_610_000_000_000_030n,
        lambdaWad: 16_780_000_000_000_000n,
        baseFee: 5,
        emaPeriod: 60,
        funding: { type: "none" },
      });
      rows.push({
        run: "a=0.9096 λ=0.01678 fee=5 NONE (control)",
        bobBudget: num(r.bobBudgetPnl).toFixed(2),
        bobAttack: num(r.bobAttackPnl).toFixed(2),
        bobFull: num(r.bobFullPnl).toFixed(2),
        poolDelta: num(r.poolAttackDelta).toFixed(2),
        charlie: num(r.charlieDelta).toFixed(2),
        atkFees: num(r.attackFees).toFixed(2),
        donSpent: num(r.donationSpent).toFixed(6),
        repegs: r.repegs,
        scaleErr: num(r.scaleError).toExponential(1),
      });
    } catch (err) {
      rows.push({ run: "NONE control", bobFull: `N/A: ${String(err).slice(0, 120)}` });
    }

    console.table(rows);
  });
});
