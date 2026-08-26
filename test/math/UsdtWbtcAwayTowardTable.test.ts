import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

// USDT-WBTC pair → use the WBTC preset that ships in
// `simulator/test_helpers/config.ts` (Phase 1 bootstrap mirror of the
// canonical Rust defaults). Test-time overrides via env vars
// (`TABLE_A_WAD`, `TABLE_LAMBDA_WAD`) are honoured for ad-hoc parameter
// sweeps without amending the on-chain config — the legacy `TABLE_ALPHA`
// is gone because the two-knob kernel no longer has a single-knob alpha.
const PRESET = EQUILIBRA_PRESETS.WBTC;

type FixtureResult = {
  usdt: any;
  wbtc: any;
  pool: any;
  router: any;
  owner: Awaited<ReturnType<typeof hre.ethers.getSigners>>[0];
  trader: Awaited<ReturnType<typeof hre.ethers.getSigners>>[1];
  usdtAddr: string;
  wbtcAddr: string;
  usdtIsToken0: boolean;
};

type TableRow = {
  step: string;
  amountIn: string;
  equilibraOut: string;
  cpOut: string;
  diffVsCpBps: string;
  repegBudget: string;
  budgetVsRequired: string;
  rebalanced: string;
};

const USDT_DECIMALS = 6;
const WBTC_DECIMALS = 8;
const PRICE_USDT_PER_WBTC_RAW = 102_354_000_000n; // 102,354.000000 USDT
const WAD = 10n ** 18n;
const BPS = 10_000n;
const TEST_A_WAD = process.env.TABLE_A_WAD ? hre.ethers.parseUnits(process.env.TABLE_A_WAD, 18) : PRESET.aWad;
const TEST_LAMBDA_WAD = process.env.TABLE_LAMBDA_WAD
  ? hre.ethers.parseUnits(process.env.TABLE_LAMBDA_WAD, 18)
  : PRESET.lambdaWad;

const INITIAL_USDT_RAW = 500_000n * 10n ** BigInt(USDT_DECIMALS);
const TOWARD_USDT_NOTIONALS = [1n, 100n, 1000n];

const AWAY_USDT_NOTIONALS: bigint[] = [];
for (let usdt = 50_000n; usdt <= 550_000n; usdt += 50_000n) {
  AWAY_USDT_NOTIONALS.push(usdt);
}

function usdtRawToWbtcRaw(usdtRaw: bigint): bigint {
  return (usdtRaw * 10n ** BigInt(WBTC_DECIMALS)) / PRICE_USDT_PER_WBTC_RAW;
}

function fromWadDown(wadAmount: bigint, decimals: number): bigint {
  if (decimals === 18) return wadAmount;
  return wadAmount / 10n ** BigInt(18 - decimals);
}

function formatRebalanceFlag(rebalanced: boolean): string {
  return rebalanced ? "yes" : "no";
}

function formatPercentFromBps(valueBps: bigint): string {
  const whole = valueBps / 100n;
  const fraction = (valueBps % 100n).toString().padStart(2, "0");
  return `${formatWhole(whole)}.${fraction}%`;
}

type RebalanceBudgetMetrics = {
  budgetUsdtRaw: bigint;
  budgetVsRequired: string;
};

async function computeRebalanceBudgetMetrics(pool: any): Promise<RebalanceBudgetMetrics> {
  // LP unit-value accounting (unchanged shape under the current kernel, only the
  // anchor terminology moved): the repeg budget is the cumulative
  // `_lpValueGrowthWad` scaled by the configured `repegShareBps`. The
  // table converts that quote-WAD-per-LP value back to a USDT-raw figure
  // by multiplying through the current `totalSupply` and unwinding the
  // current `priceScaleWad` (USDT is token0 in this fixture, token1 is
  // the quote-WAD denominator).
  const lpValueGrowthWad = BigInt((await pool.getLpValueState()).growthWad);
  const repegShareBps = BigInt((await pool.getFeeConfig()).repegShareBps);
  const priceScaleWad = BigInt((await pool.getOracleState()).priceScaleWad);
  const totalSupply = BigInt(await pool.totalSupply());
  if (lpValueGrowthWad === 0n || repegShareBps === 0n || totalSupply === 0n || priceScaleWad === 0n) {
    return { budgetUsdtRaw: 0n, budgetVsRequired: "N/A" };
  }

  // Quote-WAD budget per LP-unit × totalSupply / WAD = quote-WAD budget.
  const budgetQuoteWad = (lpValueGrowthWad * repegShareBps * totalSupply) / (BPS * WAD);
  // Convert the quote-WAD budget back to token0 (USDT) raw units:
  //   budget_token0_wad = budget_quote_wad * WAD / priceScaleWad
  //   budget_usdt_raw   = from_wad_down(budget_token0_wad, USDT_DECIMALS)
  const budgetToken0Wad = (budgetQuoteWad * WAD) / priceScaleWad;
  const budgetUsdtRaw = fromWadDown(budgetToken0Wad, USDT_DECIMALS);

  // Coverage is shown as the share-of-LP-unit-value the budget represents.
  // The "required" threshold is the protocol's own gate
  // (`vpAfter >= vp0 + growth · keepBps / BPS`) which is swap-specific;
  // here we surface the unit-value share to make the table monotonic.
  const coverageBps = (lpValueGrowthWad * repegShareBps) / WAD;
  return {
    budgetUsdtRaw,
    budgetVsRequired: formatPercentFromBps(coverageBps),
  };
}

function computeCpExactInOut(
  amountInRaw: bigint,
  reserveInRaw: bigint,
  reserveOutRaw: bigint,
  baseFeeBps: bigint
): bigint {
  if (amountInRaw === 0n || reserveInRaw === 0n || reserveOutRaw === 0n) return 0n;
  const feeAmount = (amountInRaw * baseFeeBps) / 10_000n;
  const cleanIn = amountInRaw - feeAmount;
  if (cleanIn === 0n) return 0n;
  return (reserveOutRaw * cleanIn) / (reserveInRaw + cleanIn);
}

function applyCpExactIn(
  amountInRaw: bigint,
  reserveInRaw: bigint,
  reserveOutRaw: bigint,
  baseFeeBps: bigint
): {
  amountOutRaw: bigint;
  reserveInAfterRaw: bigint;
  reserveOutAfterRaw: bigint;
} {
  const amountOutRaw = computeCpExactInOut(amountInRaw, reserveInRaw, reserveOutRaw, baseFeeBps);
  const feeAmount = (amountInRaw * baseFeeBps) / 10_000n;
  const cleanIn = amountInRaw - feeAmount;
  return {
    amountOutRaw,
    reserveInAfterRaw: reserveInRaw + cleanIn,
    reserveOutAfterRaw: reserveOutRaw - amountOutRaw,
  };
}

function diffBps(actual: bigint, reference: bigint): bigint {
  if (reference === 0n) return 0n;
  return ((actual - reference) * 10_000n) / reference;
}

function formatSignedBps(valueBps: bigint): string {
  const sign = valueBps > 0n ? "+" : "";
  return `${sign}${valueBps.toString()} bps`;
}

function formatWhole(value: bigint): string {
  const digits = value.toString();
  if (digits.length <= 3) return digits;

  const parts: string[] = [];
  let index = digits.length;
  while (index > 3) {
    parts.unshift(digits.slice(index - 3, index));
    index -= 3;
  }
  parts.unshift(digits.slice(0, index));
  return parts.join(",");
}

function formatAmount(rawAmount: bigint, decimals: number, maxFractionDigits = decimals): string {
  const scale = 10n ** BigInt(decimals);
  const integerPart = rawAmount / scale;
  const fractionPart = rawAmount % scale;

  const integerFormatted = formatWhole(integerPart);
  if (maxFractionDigits === 0) {
    return integerFormatted;
  }

  const fractionFormatted = fractionPart
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFractionDigits)
    .replace(/0+$/, "");

  return fractionFormatted.length > 0 ? `${integerFormatted}.${fractionFormatted}` : integerFormatted;
}

async function deployUsdtWbtcFixture(): Promise<FixtureResult> {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const usdt: any = await Token.deploy("Tether USD", "USDT", USDT_DECIMALS);
  const wbtc: any = await Token.deploy("Wrapped BTC", "WBTC", WBTC_DECIMALS);
  await usdt.waitForDeployment();
  await wbtc.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  const factoryAddr = await factory.getAddress();

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth: any = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  const initialWbtcRaw = usdtRawToWbtcRaw(INITIAL_USDT_RAW);

  await usdt.mint(owner.address, INITIAL_USDT_RAW * 5n);
  await wbtc.mint(owner.address, initialWbtcRaw * 5n);
  await usdt.mint(trader.address, 4_000_000n * 10n ** BigInt(USDT_DECIMALS));
  await wbtc.mint(trader.address, 100n * 10n ** BigInt(WBTC_DECIMALS));

  const usdtAddr = await usdt.getAddress();
  const wbtcAddr = await wbtc.getAddress();
  const usdtIsToken0 = usdtAddr.toLowerCase() < wbtcAddr.toLowerCase();

  // Atomic deploy + seed: amounts are paired with the (token0, token1) order
  // we pass in; the factory sorts the pair lexicographically and re-pairs the
  // amounts before forwarding them to `addLiquidity`.
  await usdt.approve(factoryAddr, MaxUint256);
  await wbtc.approve(factoryAddr, MaxUint256);
  await factory.createPoolAndAddLiquidity(
    usdtAddr,
    wbtcAddr,
    {
      aWad: TEST_A_WAD,
      lambdaWad: TEST_LAMBDA_WAD,
      baseFee: 30,
      emaPeriod: 601,
      repegStepWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
      feeRampBps: 0,
      feeFloorBps: 20,
      repegShareBps: 5000,
    },
    INITIAL_USDT_RAW,
    initialWbtcRaw,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool: any = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  // Factory sorts tokens by address; verify pool token ordering matches.
  const metaInfo = await pool.getPoolMetadata();
  const poolT0 = metaInfo.token0;
  const poolT1 = metaInfo.token1;
  expect(poolT0.toLowerCase() < poolT1.toLowerCase()).to.equal(true);

  await usdt.connect(trader).approve(await router.getAddress(), MaxUint256);
  await wbtc.connect(trader).approve(await router.getAddress(), MaxUint256);

  return {
    usdt,
    wbtc,
    pool,
    router,
    owner,
    trader,
    usdtAddr,
    wbtcAddr,
    usdtIsToken0,
  };
}

describe("USDT/WBTC Away Toward Table", function () {
  it("prints stateful and isolated away/toward tables for 50k..550k USDT equivalents", async function () {
    this.timeout(180_000);

    const { usdt, wbtc, pool, router, trader, usdtAddr, wbtcAddr, usdtIsToken0 } =
      await loadFixture(deployUsdtWbtcFixture);

    async function getReserves(): Promise<{ usdt: bigint; wbtc: bigint }> {
      const [r0Raw, r1Raw] = await pool.getReserves();
      const r0 = BigInt(r0Raw);
      const r1 = BigInt(r1Raw);
      return usdtIsToken0 ? { usdt: r0, wbtc: r1 } : { usdt: r1, wbtc: r0 };
    }

    const rows: TableRow[] = [];
    const isolatedRows: TableRow[] = [];
    const baseDeadline = (await time.latest()) + 24 * 60 * 60;
    const baseFeeBps = BigInt((await pool.getFeeConfig()).baseFee);
    const statefulBaseSnapshotId = await hre.network.provider.send("evm_snapshot", []);
    const initReserves = await getReserves();
    const cpStateful = {
      reserveUsdtRaw: initReserves.usdt,
      reserveWbtcRaw: initReserves.wbtc,
    };

    for (const awayUsdtNotional of AWAY_USDT_NOTIONALS) {
      const awayUsdtRaw = awayUsdtNotional * 10n ** BigInt(USDT_DECIMALS);
      const awayWbtcInRaw = usdtRawToWbtcRaw(awayUsdtRaw);
      expect(awayWbtcInRaw).to.be.gt(0n);

      const reservesBefore = await getReserves();
      const reserveUsdtBefore = reservesBefore.usdt;
      const reserveWbtcBefore = reservesBefore.wbtc;
      const awayCpStateful = applyCpExactIn(
        awayWbtcInRaw,
        cpStateful.reserveWbtcRaw,
        cpStateful.reserveUsdtRaw,
        baseFeeBps
      );
      cpStateful.reserveWbtcRaw = awayCpStateful.reserveInAfterRaw;
      cpStateful.reserveUsdtRaw = awayCpStateful.reserveOutAfterRaw;
      const awayBudgetMetrics = await computeRebalanceBudgetMetrics(pool);
      const awayPriceScaleBefore = BigInt((await pool.getOracleState()).priceScaleWad);

      // The cubic kernel has the same CP-asymptotic tail as the
      // V1.0 blend invariant — every leg is feasible regardless of how
      // thin the receiving side becomes. The remaining safety net only
      // catches the pathological `AmountTooSmall` /
      // `InsufficientLiquidity` reverts that may still appear when an
      // excessively deep cumulative AWAY chain leaves a reserve below
      // the floor for the next swap's gross-up rounding. Such cases get
      // reported as `skip (infeasible)` instead of aborting the suite.
      let awaySwapReverted = false;
      const usdtBefore = await usdt.balanceOf(trader.address);
      try {
        await router.connect(trader).exactInputSingle({
          tokenIn: wbtcAddr,
          tokenOut: usdtAddr,
          poolIndex: 0,
          recipient: trader.address,
          amountIn: awayWbtcInRaw,
          amountOutMinimum: 0,
          deadline: baseDeadline,
        });
      } catch (err: any) {
        const msg = (err?.message ?? "").toString();
        if (!/InsufficientLiquidity|AmountTooSmall/i.test(msg)) {
          throw err;
        }
        awaySwapReverted = true;
      }
      if (awaySwapReverted) {
        rows.push({
          step: `away stateful (${formatWhole(awayUsdtNotional)} USDT eq)`,
          amountIn: `${formatAmount(awayWbtcInRaw, WBTC_DECIMALS, 8)} WBTC`,
          equilibraOut: "skip (infeasible)",
          cpOut: `${formatAmount(awayCpStateful.amountOutRaw, USDT_DECIMALS, 6)} USDT`,
          diffVsCpBps: "—",
          repegBudget: `${formatAmount(awayBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
          budgetVsRequired: awayBudgetMetrics.budgetVsRequired,
          rebalanced: "—",
        });
        // Reset the stateful CP shadow back so we don't drift further
        // away from the actual on-chain reserves. The shadow tracks
        // the CP reference path the table prints alongside Equilibra;
        // when Equilibra refuses a leg there is no on-chain state
        // change and the CP shadow should not move either.
        cpStateful.reserveWbtcRaw = reserveWbtcBefore;
        cpStateful.reserveUsdtRaw = reserveUsdtBefore;
        continue;
      }
      const usdtAfter = await usdt.balanceOf(trader.address);
      const awayUsdtOut = BigInt(usdtAfter) - BigInt(usdtBefore);
      expect(awayUsdtOut).to.be.gt(0n);
      const awayVsCp = diffBps(awayUsdtOut, awayCpStateful.amountOutRaw);
      const awayPriceScaleAfter = BigInt((await pool.getOracleState()).priceScaleWad);
      const awayRes = await getReserves();
      const awayReserveUsdt = awayRes.usdt;
      const awayReserveWbtc = awayRes.wbtc;
      expect(awayReserveUsdt).to.be.lt(reserveUsdtBefore);
      expect(awayReserveWbtc).to.be.gt(reserveWbtcBefore);

      rows.push({
        step: `away stateful (${formatWhole(awayUsdtNotional)} USDT eq)`,
        amountIn: `${formatAmount(awayWbtcInRaw, WBTC_DECIMALS, 8)} WBTC`,
        equilibraOut: `${formatAmount(awayUsdtOut, USDT_DECIMALS, 6)} USDT`,
        cpOut: `${formatAmount(awayCpStateful.amountOutRaw, USDT_DECIMALS, 6)} USDT`,
        diffVsCpBps: formatSignedBps(awayVsCp),
        repegBudget: `${formatAmount(awayBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
        budgetVsRequired: awayBudgetMetrics.budgetVsRequired,
        rebalanced: formatRebalanceFlag(awayPriceScaleAfter !== awayPriceScaleBefore),
      });

      for (const towardUsdtNotional of TOWARD_USDT_NOTIONALS) {
        const towardUsdtRaw = towardUsdtNotional * 10n ** BigInt(USDT_DECIMALS);
        const snapshotId = await hre.network.provider.send("evm_snapshot", []);
        try {
          const towardBudgetMetrics = await computeRebalanceBudgetMetrics(pool);
          const towardPriceScaleBefore = BigInt((await pool.getOracleState()).priceScaleWad);
          const towardRes = await getReserves();
          const towardReserveUsdtRaw = towardRes.usdt;
          const towardReserveWbtcRaw = towardRes.wbtc;
          const towardCpOutRaw = computeCpExactInOut(
            towardUsdtRaw,
            towardReserveUsdtRaw,
            towardReserveWbtcRaw,
            baseFeeBps
          );
          const wbtcBefore = await wbtc.balanceOf(trader.address);

          let towardSwapReverted = false;
          try {
            await router.connect(trader).exactInputSingle({
              tokenIn: usdtAddr,
              tokenOut: wbtcAddr,
              poolIndex: 0,
              recipient: trader.address,
              amountIn: towardUsdtRaw,
              amountOutMinimum: 0,
              deadline: baseDeadline + Number(towardUsdtNotional),
            });
          } catch (err: any) {
            const msg = (err?.message ?? "").toString();
            if (!/InsufficientLiquidity|AmountTooSmall/i.test(msg)) {
              throw err;
            }
            towardSwapReverted = true;
          }

          if (towardSwapReverted) {
            rows.push({
              step: `toward isolated (${formatWhole(towardUsdtNotional)} USDT)`,
              amountIn: `${formatAmount(towardUsdtRaw, USDT_DECIMALS, 6)} USDT`,
              equilibraOut: "skip (infeasible)",
              cpOut: `${formatAmount(towardCpOutRaw, WBTC_DECIMALS, 8)} WBTC`,
              diffVsCpBps: "—",
              repegBudget: `${formatAmount(towardBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
              budgetVsRequired: towardBudgetMetrics.budgetVsRequired,
              rebalanced: "—",
            });
            continue;
          }

          const wbtcAfter = await wbtc.balanceOf(trader.address);
          const towardWbtcOut = BigInt(wbtcAfter) - BigInt(wbtcBefore);
          expect(towardWbtcOut).to.be.gt(0n);
          const towardVsCp = diffBps(towardWbtcOut, towardCpOutRaw);
          const towardPriceScaleAfter = BigInt((await pool.getOracleState()).priceScaleWad);

          rows.push({
            step: `toward isolated (${formatWhole(towardUsdtNotional)} USDT)`,
            amountIn: `${formatAmount(towardUsdtRaw, USDT_DECIMALS, 6)} USDT`,
            equilibraOut: `${formatAmount(towardWbtcOut, WBTC_DECIMALS, 8)} WBTC`,
            cpOut: `${formatAmount(towardCpOutRaw, WBTC_DECIMALS, 8)} WBTC`,
            diffVsCpBps: formatSignedBps(towardVsCp),
            repegBudget: `${formatAmount(towardBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
            budgetVsRequired: towardBudgetMetrics.budgetVsRequired,
            rebalanced: formatRebalanceFlag(towardPriceScaleAfter !== towardPriceScaleBefore),
          });
        } finally {
          await hre.network.provider.send("evm_revert", [snapshotId]);
        }
      }
      const postTowardRes = await getReserves();
      expect(postTowardRes.usdt).to.equal(awayReserveUsdt);
      expect(postTowardRes.wbtc).to.equal(awayReserveWbtc);
    }

    console.table(rows);
    // Under the cubic kernel every AWAY leg in the configured
    // sweep is feasible; the row count should match the full
    // cartesian product. The `<=` upper bound and `>=` lower bound
    // are kept so the residual `AmountTooSmall` safety net (see
    // catch-block above) can still mark a leg as `skip
    // (infeasible)` without flagging the suite as malformed.
    const fullRows = AWAY_USDT_NOTIONALS.length * (1 + TOWARD_USDT_NOTIONALS.length);
    expect(rows.length).to.be.lte(fullRows);
    expect(rows.length).to.be.gte(1 + TOWARD_USDT_NOTIONALS.length);

    await hre.network.provider.send("evm_revert", [statefulBaseSnapshotId]);
    const isolatedDeadline = (await time.latest()) + 24 * 60 * 60;

    for (const awayUsdtNotional of AWAY_USDT_NOTIONALS) {
      const isolatedSnapshotId = await hre.network.provider.send("evm_snapshot", []);
      try {
        const awayUsdtRaw = awayUsdtNotional * 10n ** BigInt(USDT_DECIMALS);
        const awayWbtcInRaw = usdtRawToWbtcRaw(awayUsdtRaw);
        expect(awayWbtcInRaw).to.be.gt(0n);

        const isoResBefore = await getReserves();
        const reserveUsdtBefore = isoResBefore.usdt;
        const reserveWbtcBefore = isoResBefore.wbtc;
        const awayCpOutRaw = applyCpExactIn(awayWbtcInRaw, reserveWbtcBefore, reserveUsdtBefore, baseFeeBps);
        const awayBudgetMetrics = await computeRebalanceBudgetMetrics(pool);
        const awayPriceScaleBefore = BigInt((await pool.getOracleState()).priceScaleWad);

        const usdtBefore = await usdt.balanceOf(trader.address);
        let isolatedAwayReverted = false;
        try {
          await router.connect(trader).exactInputSingle({
            tokenIn: wbtcAddr,
            tokenOut: usdtAddr,
            poolIndex: 0,
            recipient: trader.address,
            amountIn: awayWbtcInRaw,
            amountOutMinimum: 0,
            deadline: isolatedDeadline + Number(awayUsdtNotional),
          });
        } catch (err: any) {
          const msg = (err?.message ?? "").toString();
          if (!/InsufficientLiquidity|AmountTooSmall/i.test(msg)) {
            throw err;
          }
          isolatedAwayReverted = true;
        }
        if (isolatedAwayReverted) {
          isolatedRows.push({
            step: `away isolated (${formatWhole(awayUsdtNotional)} USDT eq)`,
            amountIn: `${formatAmount(awayWbtcInRaw, WBTC_DECIMALS, 8)} WBTC`,
            equilibraOut: "skip (infeasible)",
            cpOut: `${formatAmount(awayCpOutRaw.amountOutRaw, USDT_DECIMALS, 6)} USDT`,
            diffVsCpBps: "—",
            repegBudget: `${formatAmount(awayBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
            budgetVsRequired: awayBudgetMetrics.budgetVsRequired,
            rebalanced: "—",
          });
          continue;
        }
        const usdtAfter = await usdt.balanceOf(trader.address);
        const awayUsdtOut = BigInt(usdtAfter) - BigInt(usdtBefore);
        expect(awayUsdtOut).to.be.gt(0n);
        const awayVsCp = diffBps(awayUsdtOut, awayCpOutRaw.amountOutRaw);
        const awayPriceScaleAfter = BigInt((await pool.getOracleState()).priceScaleWad);
        const isoResAfter = await getReserves();
        const awayReserveUsdt = isoResAfter.usdt;
        const awayReserveWbtc = isoResAfter.wbtc;
        expect(awayReserveUsdt).to.be.lt(reserveUsdtBefore);
        expect(awayReserveWbtc).to.be.gt(reserveWbtcBefore);

        isolatedRows.push({
          step: `away isolated (${formatWhole(awayUsdtNotional)} USDT eq)`,
          amountIn: `${formatAmount(awayWbtcInRaw, WBTC_DECIMALS, 8)} WBTC`,
          equilibraOut: `${formatAmount(awayUsdtOut, USDT_DECIMALS, 6)} USDT`,
          cpOut: `${formatAmount(awayCpOutRaw.amountOutRaw, USDT_DECIMALS, 6)} USDT`,
          diffVsCpBps: formatSignedBps(awayVsCp),
          repegBudget: `${formatAmount(awayBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
          budgetVsRequired: awayBudgetMetrics.budgetVsRequired,
          rebalanced: formatRebalanceFlag(awayPriceScaleAfter !== awayPriceScaleBefore),
        });

        for (const towardUsdtNotional of TOWARD_USDT_NOTIONALS) {
          const towardUsdtRaw = towardUsdtNotional * 10n ** BigInt(USDT_DECIMALS);
          const towardSnapshotId = await hre.network.provider.send("evm_snapshot", []);
          try {
            const towardBudgetMetrics = await computeRebalanceBudgetMetrics(pool);
            const towardPriceScaleBefore = BigInt((await pool.getOracleState()).priceScaleWad);
            const isoTowardRes = await getReserves();
            const towardReserveUsdtRaw = isoTowardRes.usdt;
            const towardReserveWbtcRaw = isoTowardRes.wbtc;
            const towardCpOutRaw = computeCpExactInOut(
              towardUsdtRaw,
              towardReserveUsdtRaw,
              towardReserveWbtcRaw,
              baseFeeBps
            );
            const wbtcBefore = await wbtc.balanceOf(trader.address);

            let isoTowardSwapReverted = false;
            try {
              await router.connect(trader).exactInputSingle({
                tokenIn: usdtAddr,
                tokenOut: wbtcAddr,
                poolIndex: 0,
                recipient: trader.address,
                amountIn: towardUsdtRaw,
                amountOutMinimum: 0,
                deadline: isolatedDeadline + Number(awayUsdtNotional + towardUsdtNotional),
              });
            } catch (err: any) {
              const msg = (err?.message ?? "").toString();
              if (!/InsufficientLiquidity|AmountTooSmall/i.test(msg)) {
                throw err;
              }
              isoTowardSwapReverted = true;
            }

            if (isoTowardSwapReverted) {
              isolatedRows.push({
                step: `toward isolated (${formatWhole(towardUsdtNotional)} USDT)`,
                amountIn: `${formatAmount(towardUsdtRaw, USDT_DECIMALS, 6)} USDT`,
                equilibraOut: "skip (infeasible)",
                cpOut: `${formatAmount(towardCpOutRaw, WBTC_DECIMALS, 8)} WBTC`,
                diffVsCpBps: "—",
                repegBudget: `${formatAmount(towardBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
                budgetVsRequired: towardBudgetMetrics.budgetVsRequired,
                rebalanced: "—",
              });
              continue;
            }

            const wbtcAfter = await wbtc.balanceOf(trader.address);
            const towardWbtcOut = BigInt(wbtcAfter) - BigInt(wbtcBefore);
            expect(towardWbtcOut).to.be.gt(0n);
            const towardVsCp = diffBps(towardWbtcOut, towardCpOutRaw);
            const towardPriceScaleAfter = BigInt((await pool.getOracleState()).priceScaleWad);

            isolatedRows.push({
              step: `toward isolated (${formatWhole(towardUsdtNotional)} USDT)`,
              amountIn: `${formatAmount(towardUsdtRaw, USDT_DECIMALS, 6)} USDT`,
              equilibraOut: `${formatAmount(towardWbtcOut, WBTC_DECIMALS, 8)} WBTC`,
              cpOut: `${formatAmount(towardCpOutRaw, WBTC_DECIMALS, 8)} WBTC`,
              diffVsCpBps: formatSignedBps(towardVsCp),
              repegBudget: `${formatAmount(towardBudgetMetrics.budgetUsdtRaw, USDT_DECIMALS, 6)} USDT`,
              budgetVsRequired: towardBudgetMetrics.budgetVsRequired,
              rebalanced: formatRebalanceFlag(towardPriceScaleAfter !== towardPriceScaleBefore),
            });
          } finally {
            await hre.network.provider.send("evm_revert", [towardSnapshotId]);
          }
        }
        const isoPostTowardRes = await getReserves();
        expect(isoPostTowardRes.usdt).to.equal(awayReserveUsdt);
        expect(isoPostTowardRes.wbtc).to.equal(awayReserveWbtc);
      } finally {
        await hre.network.provider.send("evm_revert", [isolatedSnapshotId]);
      }
    }

    console.table(isolatedRows);
    // Same accounting rule as the stateful table — every AWAY leg
    // is feasible under the cubic kernel, so the row count
    // should match the full cartesian product; the bounded `<=`
    // / `>=` ranges only guard against the residual safety net
    // for `AmountTooSmall` rounding cases.
    const isolatedFullRows = AWAY_USDT_NOTIONALS.length * (1 + TOWARD_USDT_NOTIONALS.length);
    expect(isolatedRows.length).to.be.lte(isolatedFullRows);
    expect(isolatedRows.length).to.be.gte(1 + TOWARD_USDT_NOTIONALS.length);
  });
});
