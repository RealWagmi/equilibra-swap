import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";
import { EQUILIBRA_PRESETS, TEST_PRICES, type EquilibraPoolParams } from "../../simulator/test_helpers/config";
import { runRustSimulatorTrace } from "../../simulator/test_helpers/rustTestUtils";

/**
 * General on-chain vs Rust-offchain parity test.
 *
 * Goals:
 *   • Use the real simulator presets (WETH + WBTC) so that whatever the
 *     benchmarks / dashboard exercise is what we also regression-test.
 *   • Drive a long multi-action scenario (quote → swap → swap → swap →
 *     addLiquidity → swap → removeLiquidity → swap …) through the
 *     EquilibraPool and record every pre/post state snapshot.
 *   • Replay the exact same sequence through the Rust simulator's
 *     `trace_mode` and assert that every single state field lands at the
 *     same value, bit-for-bit, at every step.
 *   • No tolerances, no "allowed drift". The simulation is a core part of
 *     the project and must be trustworthy as a 1-for-1 mirror of the
 *     on-chain math (including the dynamic-fee ramp, the LP-unit-value
 *     re-anchoring on proportional liquidity events, and auto-repegs).
 *
 * The on-chain state variables `_emaPeriod`, `_repegStepWad`,
 * `_lastEmaTs`, `_lastRepegTs` are not exposed through public getters. We
 * therefore:
 *   • read `_emaPeriod`, `_repegStepWad` from the fixture inputs
 *     (immutable post-initialize),
 *   • track `_lastEmaTs` / `_lastRepegTs` in TS by mirroring the
 *     exact on-chain rules:
 *       - `_lastEmaTs` := `block.timestamp` of every `swap()` tx,
 *       - `_lastRepegTs` := `block.timestamp` of every `swap()` tx that
 *         emits `AnchorUpdated`,
 *       - `addLiquidity` (after genesis) / `removeLiquidity` do not
 *         touch either timestamp,
 *       - genesis mint seeds both to the creation block timestamp.
 *   • `e0`/`e1` are not stored on-chain — the solvency invariant is
 *     `balance == reserve + protocolFee`. The Rust simulator caches
 *     `e0`/`e1` explicitly and updates them differently depending on the
 *     action type (swap → `reserve + protocolFee`, add/remove → `reserve`
 *     only). We mirror the same rule below.
 */

type BaseSymbol = "WETH" | "WBTC";

// Hardhat's `HardhatEthersSigner` is emitted as `any` to sidestep the
// upstream type re-export; the runtime shape is what we need here.

type Tokens = {
  usdt: any;
  weth: any;
  wbtc: any;
  usdtAddr: string;
  wethAddr: string;
  wbtcAddr: string;
};

type PoolInfra = {
  owner: any;
  trader: any;
  factory: any;
  router: any;
  factoryAddr: string;
  routerAddr: string;
  tokens: Tokens;
};

type PoolContext = {
  infra: PoolInfra;
  baseSymbol: BaseSymbol;
  preset: EquilibraPoolParams;
  pool: any;
  poolAddress: string;
  // Directional token bookkeeping. Whichever token address is numerically
  // lower becomes `token0`; this wiring is driven entirely by the real
  // factory sorting, so both orientations are exercised across the suite.
  token0: any;
  token1: any;
  token0Addr: string;
  token1Addr: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  initTs: number;
  // Mirrored private storage from the fixture — immutable after init.
  // Effective (preset + per-scenario override) fee / repeg config the
  // pool was actually created with; the Rust trace input must carry
  // these, never the raw preset, or an override scenario would replay
  // against a differently configured mirror.
  feeBps: number;
  feeRampBps: number;
  feeFloorBps: number;
  repegShareBps: number;
  emaPeriod: number;
  repegStepWad: bigint;
  repegThresholdToken1UpWad: bigint;
  repegThresholdToken1DownWad: bigint;
  /// Donation-parachute activation multiplier K, read back from the
  /// live `getFeeConfig().parachuteBandMult` storage (seeded from
  /// `Constants.REPEG_PARACHUTE_BAND_MULT`, never a creation param).
  parachuteBandMult: number;
  // TS-tracked private timestamps, kept in sync with the on-chain rules.
  trackedLastEmaTs: number;
  trackedLastRepegTs: number;
  // Drives the `e0/e1` rule in `captureState`.
  lastActionIsSwap: boolean;
};

type StepAction = "swap" | "swapExactOut" | "add" | "remove" | "donate";

type RecordedState = {
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  protocolFee0: bigint;
  protocolFee1: bigint;
  e0: bigint;
  e1: bigint;
  anchorReserve0: bigint;
  anchorReserve1: bigint;
  equilibraEmaPrice: bigint;
  equilibraLastTimestamp: bigint;
  equilibraLastRecenterTimestamp: bigint;
  equilibraAnchorPriceWad: bigint;
  equilibraLpUnitValueGenesisWad: bigint;
  equilibraLpUnitValueWad: bigint;
  equilibraLpValueGrowthWad: bigint;
  /// LP shares parked on the pool's own address (the donation buffer).
  donationShares: bigint;
};

type RecordedStep =
  | {
      action: "swap";
      tokenIn: string;
      amountIn: bigint;
      amountOutOnchain: bigint;
      feeAmountOnchain: bigint;
      anchorUpdated: boolean;
      timestamp: number;
      pre: RecordedState;
      post: RecordedState;
    }
  | {
      action: "swapExactOut";
      tokenIn: string;
      amountOut: bigint;
      amountInOnchain: bigint;
      feeAmountOnchain: bigint;
      anchorUpdated: boolean;
      timestamp: number;
      pre: RecordedState;
      post: RecordedState;
    }
  | {
      action: "add";
      amount0Desired: bigint;
      amount1Desired: bigint;
      amount0UsedOnchain: bigint;
      amount1UsedOnchain: bigint;
      mintedLiquidity: bigint;
      timestamp: number;
      pre: RecordedState;
      post: RecordedState;
    }
  | {
      action: "remove";
      shares: bigint;
      amount0OutOnchain: bigint;
      amount1OutOnchain: bigint;
      timestamp: number;
      pre: RecordedState;
      post: RecordedState;
    }
  | {
      action: "donate";
      shares: bigint;
      timestamp: number;
      pre: RecordedState;
      post: RecordedState;
    };

type RustTraceStateOut = {
  reserve0: string;
  reserve1: string;
  totalSupply: string;
  e0: string;
  e1: string;
  protocolFee0: string;
  protocolFee1: string;
  anchorReserve0: string;
  anchorReserve1: string;
  equilibraEmaPrice?: string;
  equilibraLastTimestamp?: string;
  equilibraLastRecenterTimestamp?: string;
  equilibraRepegStepWad?: string;
  equilibraRepegThresholdWad?: string;
  equilibraAnchorPriceWad?: string;
  equilibraLpUnitValueGenesisWad?: string;
  equilibraLpUnitValueWad?: string;
  equilibraLpValueGrowthWad?: string;
  equilibraDonationShares?: string;
  equilibraFeeRampBps?: number;
  equilibraFeeFloorBps?: number;
  equilibraRepegShareBps?: number;
};

type RustTraceStepOut = {
  index: number;
  action: string;
  tokenIn?: string;
  amountIn?: string;
  amountOut?: string;
  amount0?: string;
  amount1?: string;
  liquidity?: string;
  mintedLiquidity?: string;
  amount0Out?: string;
  amount1Out?: string;
  equilibraRecentered?: boolean;
  equilibraRecenterBlockedBy?: string;
  timestamp: number;
  pre: RustTraceStateOut;
  post: RustTraceStateOut;
};

type RustTraceOutput = {
  mode: string;
  amm: string;
  baseSymbol: string;
  steps: RustTraceStepOut[];
  finalState: RustTraceStateOut;
};

// ---------------------------------------------------------------------------
// Low-level math helpers mirroring the Rust / Solidity implementations.
// ---------------------------------------------------------------------------

const WAD = 10n ** 18n;

function pow10(n: number): bigint {
  let out = 1n;
  for (let i = 0; i < n; i++) out *= 10n;
  return out;
}

function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}

/**
 * Exact port of `derive_legacy_anchor_balances` from the Rust simulator —
 * used to compute the virtual anchor balances from the on-chain anchor
 * price + reserves. We reproduce it here so that the comparison is
 * self-contained (no Rust round-trip for a field we already have all the
 * inputs for).
 */
function deriveAnchorReserves(
  reserve0: bigint,
  reserve1: bigint,
  anchorPriceWad: bigint,
  token0Decimals: number,
  token1Decimals: number
): { anchor0: bigint; anchor1: bigint } {
  if (anchorPriceWad === 0n) return { anchor0: 0n, anchor1: 0n };
  const scale0 = pow10(18 - token0Decimals);
  const scale1 = pow10(18 - token1Decimals);
  if (scale0 === 0n || scale1 === 0n) return { anchor0: 0n, anchor1: 0n };
  const xMath = reserve0 * scale0;
  const yMath = reserve1 * scale1;
  const valueFromX = mulDivFloor(xMath, anchorPriceWad, WAD);
  const totalValueInY = valueFromX + yMath;
  const anchorYMath = totalValueInY / 2n;
  const denom = anchorPriceWad * 2n === 0n ? 1n : anchorPriceWad * 2n;
  const anchorXMath = mulDivFloor(totalValueInY, WAD, denom);
  const anchor0 = anchorXMath / scale0;
  const anchor1 = anchorYMath / scale1;
  return { anchor0, anchor1 };
}

// ---------------------------------------------------------------------------
// Genesis sizing. 1M USD split 50/50 USDT + base; we do BigInt math to avoid
// `f64` rounding drift. Rust reproduces the exact same seeded reserves via
// `TracePoolInput`, so there's no need to mimic `build_initial_deposit_amounts`
// bit-for-bit — the Rust trace starts from whatever reserves we feed it.
// ---------------------------------------------------------------------------
function initialReserves(baseSymbol: BaseSymbol): {
  baseAmount: bigint;
  quoteAmount: bigint;
} {
  const halfUsdWad = 500_000n * WAD; // 500k USD in 1e18 units
  const quoteAmount = halfUsdWad / 10n ** 12n; // USDT = 6 dp
  const baseDecimals = baseSymbol === "WETH" ? 18 : 8;
  const price = TEST_PRICES[baseSymbol];
  const baseAmount = (halfUsdWad * pow10(baseDecimals)) / price;
  return { baseAmount, quoteAmount };
}

// ---------------------------------------------------------------------------
// Infra / pool deployment helpers.
// ---------------------------------------------------------------------------

async function deployInfra(): Promise<PoolInfra> {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const usdt = await Token.deploy("USD Tether", "USDT", 6);
  const weth = await Token.deploy("Wrapped Ether", "WETH", 18);
  const wbtc = await Token.deploy("Wrapped BTC", "WBTC", 8);
  await usdt.waitForDeployment();
  await weth.waitForDeployment();
  await wbtc.waitForDeployment();

  const usdtAddr = await usdt.getAddress();
  const wethAddr = await weth.getAddress();
  const wbtcAddr = await wbtc.getAddress();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();
  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  // Router needs a WETH9 address — we reuse the MockWETH9 helper. Any
  // WETH9-compatible deploy works; the router only touches ETH via wrap
  // paths which this test never exercises.
  const Weth9 = await hre.ethers.getContractFactory("MockWETH9");
  const weth9 = await Weth9.deploy();
  await weth9.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth9.getAddress());
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // Plentiful bankroll covers genesis seeds + worst-case test-sweep sizes
  // (multi-million-dollar swaps) across both pools.
  const hugeUsdt = 10n ** 18n; // 1 trillion USDT (6 dp)
  const hugeWeth = 10n ** 30n;
  const hugeWbtc = 10n ** 20n;
  for (const acct of [owner, trader]) {
    await (usdt as any).mint(acct.address, hugeUsdt);
    await (weth as any).mint(acct.address, hugeWeth);
    await (wbtc as any).mint(acct.address, hugeWbtc);
    await (usdt as any).connect(acct).approve(factoryAddr, MaxUint256);
    await (weth as any).connect(acct).approve(factoryAddr, MaxUint256);
    await (wbtc as any).connect(acct).approve(factoryAddr, MaxUint256);
    await (usdt as any).connect(acct).approve(routerAddr, MaxUint256);
    await (weth as any).connect(acct).approve(routerAddr, MaxUint256);
    await (wbtc as any).connect(acct).approve(routerAddr, MaxUint256);
  }

  return {
    owner,
    trader,
    factory,
    router,
    factoryAddr,
    routerAddr,
    tokens: { usdt, weth, wbtc, usdtAddr, wethAddr, wbtcAddr },
  };
}

/**
 * Per-scenario deviations from the canonical preset. Only the fee /
 * repeg knobs are overridable — the curve shape (`aWad`, `lambdaWad`)
 * and the genesis sizing always come from the preset so every scenario
 * exercises the calibrated production kernel.
 */
type PoolParamOverrides = {
  baseFee?: number;
  feeRampBps?: number;
  feeFloorBps?: number;
  repegShareBps?: number;
  emaPeriod?: number;
  repegStepWad?: bigint;
  repegThresholdToken1UpWad?: bigint;
  repegThresholdToken1DownWad?: bigint;
};

async function setupPool(
  infra: PoolInfra,
  baseSymbol: BaseSymbol,
  overrides: PoolParamOverrides = {}
): Promise<PoolContext> {
  const preset = EQUILIBRA_PRESETS[baseSymbol];
  const feeBps = overrides.baseFee ?? preset.feeBps;
  const feeRampBps = overrides.feeRampBps ?? preset.feeRampBps;
  const feeFloorBps = overrides.feeFloorBps ?? preset.feeFloorBps;
  const repegShareBps = overrides.repegShareBps ?? preset.repegShareBps;
  const emaPeriod = overrides.emaPeriod ?? preset.emaPeriod;
  const repegStepWad = overrides.repegStepWad ?? preset.repegStepWad;
  // Default scenarios pin the dead-band to the step: the recenter
  // probing is calibrated for a step-sized activation quantum.
  const repegThresholdToken1UpWad = overrides.repegThresholdToken1UpWad ?? preset.repegStepWad;
  const repegThresholdToken1DownWad = overrides.repegThresholdToken1DownWad ?? preset.repegStepWad;
  const { baseAmount, quoteAmount } = initialReserves(baseSymbol);
  const baseToken = baseSymbol === "WETH" ? infra.tokens.weth : infra.tokens.wbtc;
  const baseAddr = baseSymbol === "WETH" ? infra.tokens.wethAddr : infra.tokens.wbtcAddr;
  const baseDecimals = baseSymbol === "WETH" ? 18 : 8;
  const usdtAddr = infra.tokens.usdtAddr;
  const usdtDecimals = 6;

  // Any strictly-future block timestamp works; pad enough headroom so
  // the subsequent per-step `setNextBlockTimestamp(t)` calls stay
  // monotonic.
  const nowTs = await time.latest();
  const initTs = nowTs + 60;
  await time.setNextBlockTimestamp(initTs);

  // Factory re-sorts token pair + amounts by address, so pass the
  // unsorted pair exactly as `(base, usdt)` with their matching amounts.
  await infra.factory.connect(infra.owner).createPoolAndAddLiquidity(
    baseAddr,
    usdtAddr,
    {
      aWad: preset.aWad,
      lambdaWad: preset.lambdaWad,
      baseFee: feeBps,
      emaPeriod,
      repegStepWad,
      repegThresholdToken1UpWad,
      repegThresholdToken1DownWad,
      feeRampBps,
      feeFloorBps,
      repegShareBps,
    },
    baseAmount,
    quoteAmount,
    infra.owner.address
  );

  const poolIndex = (await infra.factory.allPoolsLength()) - 1n;
  const poolAddress = await infra.factory.allPools(poolIndex);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  // Per-pool parachute activation multiplier K — live storage, exposed
  // as the last field of getFeeConfig(). Read it back rather than
  // hardcoding the Constants seed so a future timelock-adjusted fixture
  // flows into the Rust trace automatically.
  const feeConfig = await pool.getFeeConfig();
  const parachuteBandMult = Number(feeConfig.parachuteBandMult);

  const meta = await pool.getPoolMetadata();
  const token0Addr = meta.token0.toLowerCase();
  const token1Addr = meta.token1.toLowerCase();
  const baseLower = baseAddr.toLowerCase();
  const usdtLower = usdtAddr.toLowerCase();

  let token0: any;
  let token1: any;
  let token0Symbol: string;
  let token1Symbol: string;
  let token0Decimals: number;
  let token1Decimals: number;

  if (token0Addr === baseLower) {
    token0 = baseToken;
    token1 = infra.tokens.usdt;
    token0Symbol = baseSymbol;
    token1Symbol = "USDT";
    token0Decimals = baseDecimals;
    token1Decimals = usdtDecimals;
  } else if (token0Addr === usdtLower) {
    token0 = infra.tokens.usdt;
    token1 = baseToken;
    token0Symbol = "USDT";
    token1Symbol = baseSymbol;
    token0Decimals = usdtDecimals;
    token1Decimals = baseDecimals;
  } else {
    throw new Error(`pool.getPoolMetadata().token0=${token0Addr} is neither base(${baseLower}) nor USDT(${usdtLower})`);
  }

  // Pre-approve the trader (and owner) for router swaps on both pool tokens.
  // The router pre-transfers the input token before `swap()`.
  for (const signer of [infra.owner, infra.trader]) {
    await token0.connect(signer).approve(infra.routerAddr, MaxUint256);
    await token1.connect(signer).approve(infra.routerAddr, MaxUint256);
  }

  return {
    infra,
    baseSymbol,
    preset,
    pool,
    poolAddress,
    token0,
    token1,
    token0Addr,
    token1Addr,
    token0Symbol,
    token1Symbol,
    token0Decimals,
    token1Decimals,
    initTs,
    feeBps,
    feeRampBps,
    feeFloorBps,
    repegShareBps,
    emaPeriod,
    repegStepWad,
    repegThresholdToken1UpWad,
    repegThresholdToken1DownWad,
    parachuteBandMult,
    trackedLastEmaTs: initTs,
    trackedLastRepegTs: initTs,
    lastActionIsSwap: false,
  };
}

// ---------------------------------------------------------------------------
// State capture.
// ---------------------------------------------------------------------------
async function captureState(ctx: PoolContext): Promise<RecordedState> {
  const [r0, r1] = await ctx.pool.getReserves();
  const oracle = await ctx.pool.getOracleState();
  // `OracleState` renamed `anchorPrice` → `priceScaleWad` and
  // `emaPrice` → `emaPriceWad`. The local `anchorPriceWad`
  // identifier kept for trace-JSON field naming consistency with
  // HEAD's `equilibraAnchorPriceWad` schema.
  const anchorPriceWad = BigInt(oracle.priceScaleWad);
  const emaPrice = BigInt(oracle.emaPriceWad);
  const lpState = await ctx.pool.getLpValueState();
  const lpUnitValueGenesis = BigInt(lpState.genesisWad);
  const lpUnitValue = BigInt(lpState.unitValueWad);
  const lpValueGrowth = BigInt(lpState.growthWad);
  const [pf0Raw, pf1Raw] = await ctx.pool.getProtocolFees();
  const pf0 = BigInt(pf0Raw);
  const pf1 = BigInt(pf1Raw);
  const totalSupply = BigInt(await ctx.pool.totalSupply());
  const donationShares = BigInt(await ctx.pool.balanceOf(ctx.poolAddress));

  const reserve0 = BigInt(r0);
  const reserve1 = BigInt(r1);

  // Mirror the Rust `e0/e1` update rules. See the test's top-level doc
  // block for the full reasoning; the short version is:
  //   • genesis / add / remove → `e = reserve` (protocolFee carries
  //     forward on-chain but Rust keeps `e` at reserve-only here),
  //   • swap → `e = reserve + protocolFee` (= balanceOf(pool)).
  const e0 = ctx.lastActionIsSwap ? reserve0 + pf0 : reserve0;
  const e1 = ctx.lastActionIsSwap ? reserve1 + pf1 : reserve1;

  const { anchor0, anchor1 } = deriveAnchorReserves(
    reserve0,
    reserve1,
    anchorPriceWad,
    ctx.token0Decimals,
    ctx.token1Decimals
  );

  return {
    reserve0,
    reserve1,
    totalSupply,
    protocolFee0: pf0,
    protocolFee1: pf1,
    e0,
    e1,
    anchorReserve0: anchor0,
    anchorReserve1: anchor1,
    equilibraEmaPrice: emaPrice,
    equilibraLastTimestamp: BigInt(ctx.trackedLastEmaTs),
    equilibraLastRecenterTimestamp: BigInt(ctx.trackedLastRepegTs),
    equilibraAnchorPriceWad: anchorPriceWad,
    equilibraLpUnitValueGenesisWad: lpUnitValueGenesis,
    equilibraLpUnitValueWad: lpUnitValue,
    equilibraLpValueGrowthWad: lpValueGrowth,
    donationShares,
  };
}

// ---------------------------------------------------------------------------
// On-chain action executors, returning the Rust-mirror step payload.
// ---------------------------------------------------------------------------

async function pushSwap(
  ctx: PoolContext,
  steps: RecordedStep[],
  tokenInSide: "token0" | "token1",
  amountIn: bigint,
  ts: number
): Promise<void> {
  const pre = await captureState(ctx);
  const inAddr = tokenInSide === "token0" ? ctx.token0Addr : ctx.token1Addr;
  const outAddr = tokenInSide === "token0" ? ctx.token1Addr : ctx.token0Addr;

  // Keep the quote-vs-swap invariant tight: the router's `quoteExactIn`
  // must agree with the Pool-level `swap()` output down to the last wei.
  const onchainQuote = BigInt(await ctx.pool.quoteExactIn(tokenInSide === "token0", amountIn));

  await time.setNextBlockTimestamp(ts);
  const tx = await ctx.infra.router.connect(ctx.infra.trader).exactInputSingle({
    tokenIn: inAddr,
    tokenOut: outAddr,
    poolIndex: 0,
    recipient: ctx.infra.trader.address,
    amountIn,
    amountOutMinimum: 0,
    deadline: ts + 600,
  });
  const receipt = await tx.wait();

  const swapTopic = ctx.pool.interface.getEvent("Swap").topicHash;
  const anchorTopic = ctx.pool.interface.getEvent("PriceScaleUpdated").topicHash;
  let amountOutOnchain = 0n;
  let feeAmountOnchain = 0n;
  let anchorUpdated = false;
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() !== ctx.poolAddress.toLowerCase()) continue;
    if (log.topics[0] === swapTopic) {
      const parsed = ctx.pool.interface.decodeEventLog("Swap", log.data, log.topics);
      amountOutOnchain = BigInt(parsed.amountOut);
      feeAmountOnchain = BigInt(parsed.feeAmount);
    } else if (log.topics[0] === anchorTopic) {
      anchorUpdated = true;
    }
  }
  expect(amountOutOnchain, "swap receipt missing Swap event").to.be.greaterThan(0n);
  expect(onchainQuote, "quoteExactIn vs swap amountOut").to.equal(amountOutOnchain);

  ctx.trackedLastEmaTs = ts;
  if (anchorUpdated) ctx.trackedLastRepegTs = ts;
  ctx.lastActionIsSwap = true;

  const post = await captureState(ctx);
  steps.push({
    action: "swap",
    tokenIn: inAddr,
    amountIn,
    amountOutOnchain,
    feeAmountOnchain,
    anchorUpdated,
    timestamp: ts,
    pre,
    post,
  });
}

async function pushSwapExactOut(
  ctx: PoolContext,
  steps: RecordedStep[],
  tokenInSide: "token0" | "token1",
  amountOut: bigint,
  ts: number
): Promise<void> {
  const pre = await captureState(ctx);
  const inAddr = tokenInSide === "token0" ? ctx.token0Addr : ctx.token1Addr;
  const outAddr = tokenInSide === "token0" ? ctx.token1Addr : ctx.token0Addr;

  // The unification commit guarantees `quoteExactOut` and the live
  // `exactOutputSingle` charge bit-exactly the same `amountIn`.
  // Verifying it here keeps the assertion close to the swap so a
  // regression in the Solidity exact-out path surfaces with a clear
  // label rather than as a downstream Rust parity drift.
  const onchainQuote = BigInt(await ctx.pool.quoteExactOut(tokenInSide === "token0", amountOut));

  await time.setNextBlockTimestamp(ts);
  const tx = await ctx.infra.router.connect(ctx.infra.trader).exactOutputSingle({
    tokenIn: inAddr,
    tokenOut: outAddr,
    poolIndex: 0,
    recipient: ctx.infra.trader.address,
    amountOut,
    amountInMaximum: MaxUint256,
    deadline: ts + 600,
  });
  const receipt = await tx.wait();

  const swapTopic = ctx.pool.interface.getEvent("Swap").topicHash;
  const anchorTopic = ctx.pool.interface.getEvent("PriceScaleUpdated").topicHash;
  let amountInOnchain = 0n;
  let amountOutOnchain = 0n;
  let feeAmountOnchain = 0n;
  let anchorUpdated = false;
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() !== ctx.poolAddress.toLowerCase()) continue;
    if (log.topics[0] === swapTopic) {
      const parsed = ctx.pool.interface.decodeEventLog("Swap", log.data, log.topics);
      amountInOnchain = BigInt(parsed.amountIn);
      amountOutOnchain = BigInt(parsed.amountOut);
      feeAmountOnchain = BigInt(parsed.feeAmount);
    } else if (log.topics[0] === anchorTopic) {
      anchorUpdated = true;
    }
  }
  expect(amountInOnchain, "swapExactOut receipt missing Swap event").to.be.greaterThan(0n);
  expect(amountOutOnchain, "swapExactOut delivered amountOut").to.equal(amountOut);
  expect(onchainQuote, "quoteExactOut vs swap amountIn").to.equal(amountInOnchain);

  ctx.trackedLastEmaTs = ts;
  if (anchorUpdated) ctx.trackedLastRepegTs = ts;
  ctx.lastActionIsSwap = true;

  const post = await captureState(ctx);
  steps.push({
    action: "swapExactOut",
    tokenIn: inAddr,
    amountOut,
    amountInOnchain,
    feeAmountOnchain,
    anchorUpdated,
    timestamp: ts,
    pre,
    post,
  });
}

async function pushAdd(
  ctx: PoolContext,
  steps: RecordedStep[],
  amount0Desired: bigint,
  amount1Desired: bigint,
  ts: number
): Promise<void> {
  const pre = await captureState(ctx);
  // Route through the router to exercise the same pathway dashboards /
  // users would. The router internally re-sorts and forwards
  // `(amount0Desired, amount1Desired)` to the pool as sorted amounts.
  await time.setNextBlockTimestamp(ts);
  const tx = await ctx.infra.router.connect(ctx.infra.owner).addLiquidity({
    tokenA: ctx.token0Addr,
    tokenB: ctx.token1Addr,
    poolIndex: 0,
    recipient: ctx.infra.owner.address,
    amountADesired: amount0Desired,
    amountBDesired: amount1Desired,
    minShares: 0,
    deadline: ts + 600,
  });
  const receipt = await tx.wait();

  const topic = ctx.pool.interface.getEvent("LiquidityAdded").topicHash;
  let amount0Used = 0n;
  let amount1Used = 0n;
  let shares = 0n;
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() !== ctx.poolAddress.toLowerCase()) continue;
    if (log.topics[0] !== topic) continue;
    const parsed = ctx.pool.interface.decodeEventLog("LiquidityAdded", log.data, log.topics);
    amount0Used = BigInt(parsed.amount0);
    amount1Used = BigInt(parsed.amount1);
    shares = BigInt(parsed.sharesMinted);
  }
  expect(shares, "addLiquidity receipt missing LiquidityAdded event").to.be.greaterThan(0n);

  // `addLiquidity` (after genesis) does not update either timestamp.
  ctx.lastActionIsSwap = false;

  const post = await captureState(ctx);
  steps.push({
    action: "add",
    amount0Desired,
    amount1Desired,
    amount0UsedOnchain: amount0Used,
    amount1UsedOnchain: amount1Used,
    mintedLiquidity: shares,
    timestamp: ts,
    pre,
    post,
  });
}

async function pushRemove(ctx: PoolContext, steps: RecordedStep[], shares: bigint, ts: number): Promise<void> {
  const pre = await captureState(ctx);

  // The router does not expose `removeLiquidity`, mirroring Uniswap V3.
  // We call the pool directly from the LP holder (owner, who received
  // genesis + mixed-add shares).
  await time.setNextBlockTimestamp(ts);
  const tx = await ctx.pool.connect(ctx.infra.owner).removeLiquidity(shares, 0, 0, ctx.infra.owner.address);
  const receipt = await tx.wait();

  const topic = ctx.pool.interface.getEvent("LiquidityRemoved").topicHash;
  let amount0Out = 0n;
  let amount1Out = 0n;
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() !== ctx.poolAddress.toLowerCase()) continue;
    if (log.topics[0] !== topic) continue;
    const parsed = ctx.pool.interface.decodeEventLog("LiquidityRemoved", log.data, log.topics);
    amount0Out = BigInt(parsed.amount0);
    amount1Out = BigInt(parsed.amount1);
  }
  expect(amount0Out + amount1Out, "removeLiquidity empty payout").to.be.greaterThan(0n);

  // `removeLiquidity` never touches `_lastEmaTs` / `_lastRepegTs`.
  ctx.lastActionIsSwap = false;

  const post = await captureState(ctx);
  steps.push({
    action: "remove",
    shares,
    amount0OutOnchain: amount0Out,
    amount1OutOnchain: amount1Out,
    timestamp: ts,
    pre,
    post,
  });
}

async function pushDonate(ctx: PoolContext, steps: RecordedStep[], shares: bigint, ts: number): Promise<void> {
  const pre = await captureState(ctx);

  // A donation is a plain LP `transfer` to the pool's own address — no
  // pool entrypoint involved. Supply and reserves are untouched; the
  // parked balance becomes the parachute's emergency fund. It touches
  // neither the EMA/repeg timestamps nor the `e0/e1` convention (note
  // `ctx.lastActionIsSwap` is deliberately left as-is).
  await time.setNextBlockTimestamp(ts);
  await (await ctx.pool.connect(ctx.infra.owner).transfer(ctx.poolAddress, shares)).wait();

  const post = await captureState(ctx);
  expect(post.donationShares - pre.donationShares, "donation must land in the pool buffer").to.equal(shares);
  expect(post.totalSupply, "a donation never changes totalSupply").to.equal(pre.totalSupply);
  steps.push({ action: "donate", shares, timestamp: ts, pre, post });
}

// ---------------------------------------------------------------------------
// Rust trace plumbing.
// ---------------------------------------------------------------------------

function buildRustTraceInput(ctx: PoolContext, steps: RecordedStep[]): Record<string, unknown> {
  const firstPre = steps[0].pre;

  const poolPayload: Record<string, unknown> = {
    contextName: `equilibra:${ctx.baseSymbol}`,
    amm: "equilibra",
    baseSymbol: ctx.baseSymbol,
    token0: ctx.token0Addr,
    token1: ctx.token1Addr,
    token0Symbol: ctx.token0Symbol,
    token1Symbol: ctx.token1Symbol,
    token0Decimals: ctx.token0Decimals,
    token1Decimals: ctx.token1Decimals,
    reserve0: firstPre.reserve0.toString(),
    reserve1: firstPre.reserve1.toString(),
    feeBps: ctx.feeBps,
    totalSupply: firstPre.totalSupply.toString(),
    aWad: ctx.preset.aWad.toString(),
    lambdaWad: ctx.preset.lambdaWad.toString(),
    protocolFeePercent: ctx.preset.protocolFeePercent,
    emaPeriod: ctx.emaPeriod,
    equilibraFeeRampBps: ctx.feeRampBps,
    equilibraFeeFloorBps: ctx.feeFloorBps,
    equilibraRepegShareBps: ctx.repegShareBps,
    equilibraRepegStepWad: ctx.repegStepWad.toString(),
    equilibraRepegThresholdToken1UpWad: ctx.repegThresholdToken1UpWad.toString(),
    equilibraRepegThresholdToken1DownWad: ctx.repegThresholdToken1DownWad.toString(),
    // Always forward the pool's LIVE parachute K (read from
    // getFeeConfig at setup) — for factory-default pools this equals
    // the Rust parser's absent-field default (30), and any future
    // timelock-adjusted fixture flows through without harness edits.
    parachuteBandMult: ctx.parachuteBandMult,
    anchorReserve0: firstPre.anchorReserve0.toString(),
    anchorReserve1: firstPre.anchorReserve1.toString(),
    equilibraProtocolFee0: firstPre.protocolFee0.toString(),
    equilibraProtocolFee1: firstPre.protocolFee1.toString(),
    equilibraE0: firstPre.e0.toString(),
    equilibraE1: firstPre.e1.toString(),
    equilibraEmaPrice: firstPre.equilibraEmaPrice.toString(),
    equilibraLastTimestamp: firstPre.equilibraLastTimestamp.toString(),
    equilibraLastRecenterTimestamp: firstPre.equilibraLastRecenterTimestamp.toString(),
    equilibraAnchorPriceWad: firstPre.equilibraAnchorPriceWad.toString(),
    equilibraLpUnitValueGenesisWad: firstPre.equilibraLpUnitValueGenesisWad.toString(),
    equilibraLpUnitValueWad: firstPre.equilibraLpUnitValueWad.toString(),
    equilibraLpValueGrowthWad: firstPre.equilibraLpValueGrowthWad.toString(),
  };

  const stepPayloads = steps.map((s) => {
    if (s.action === "swap") {
      return {
        action: "swap",
        tokenIn: s.tokenIn,
        amountIn: s.amountIn.toString(),
        timestamp: s.timestamp,
      };
    }
    if (s.action === "swapExactOut") {
      return {
        action: "swapExactOut",
        tokenIn: s.tokenIn,
        amountOut: s.amountOut.toString(),
        timestamp: s.timestamp,
      };
    }
    if (s.action === "add") {
      return {
        action: "addLiquidity",
        amount0: s.amount0Desired.toString(),
        amount1: s.amount1Desired.toString(),
        timestamp: s.timestamp,
      };
    }
    if (s.action === "donate") {
      return {
        action: "donate",
        liquidity: s.shares.toString(),
        timestamp: s.timestamp,
      };
    }
    return {
      action: "removeLiquidity",
      liquidity: s.shares.toString(),
      timestamp: s.timestamp,
    };
  });

  return {
    startTimestamp: ctx.initTs,
    pool: poolPayload,
    steps: stepPayloads,
  };
}

// ---------------------------------------------------------------------------
// Strict parity assertions.
// ---------------------------------------------------------------------------

function assertStateMatchesRust(
  label: string,
  side: "pre" | "post" | "final",
  expected: RecordedState,
  actual: RustTraceStateOut
): void {
  const tag = `${label} ${side}`;
  expect(BigInt(actual.reserve0), `${tag} reserve0`).to.equal(expected.reserve0);
  expect(BigInt(actual.reserve1), `${tag} reserve1`).to.equal(expected.reserve1);
  expect(BigInt(actual.totalSupply), `${tag} totalSupply`).to.equal(expected.totalSupply);
  expect(BigInt(actual.protocolFee0), `${tag} protocolFee0`).to.equal(expected.protocolFee0);
  expect(BigInt(actual.protocolFee1), `${tag} protocolFee1`).to.equal(expected.protocolFee1);
  expect(BigInt(actual.e0), `${tag} e0`).to.equal(expected.e0);
  expect(BigInt(actual.e1), `${tag} e1`).to.equal(expected.e1);
  expect(BigInt(actual.anchorReserve0), `${tag} anchorReserve0`).to.equal(expected.anchorReserve0);
  expect(BigInt(actual.anchorReserve1), `${tag} anchorReserve1`).to.equal(expected.anchorReserve1);
  expect(BigInt(actual.equilibraEmaPrice ?? "0"), `${tag} equilibraEmaPrice`).to.equal(expected.equilibraEmaPrice);
  expect(BigInt(actual.equilibraLastTimestamp ?? "0"), `${tag} equilibraLastTimestamp`).to.equal(
    expected.equilibraLastTimestamp
  );
  expect(BigInt(actual.equilibraLastRecenterTimestamp ?? "0"), `${tag} equilibraLastRecenterTimestamp`).to.equal(
    expected.equilibraLastRecenterTimestamp
  );
  expect(BigInt(actual.equilibraAnchorPriceWad ?? "0"), `${tag} equilibraAnchorPriceWad`).to.equal(
    expected.equilibraAnchorPriceWad
  );
  expect(BigInt(actual.equilibraLpUnitValueGenesisWad ?? "0"), `${tag} equilibraLpUnitValueGenesisWad`).to.equal(
    expected.equilibraLpUnitValueGenesisWad
  );
  expect(BigInt(actual.equilibraLpUnitValueWad ?? "0"), `${tag} equilibraLpUnitValueWad`).to.equal(
    expected.equilibraLpUnitValueWad
  );
  expect(BigInt(actual.equilibraLpValueGrowthWad ?? "0"), `${tag} equilibraLpValueGrowthWad`).to.equal(
    expected.equilibraLpValueGrowthWad
  );
  expect(BigInt(actual.equilibraDonationShares ?? "0"), `${tag} equilibraDonationShares`).to.equal(
    expected.donationShares
  );
}

function assertRustStateChainContinuity(label: string, prevPost: RustTraceStateOut, curPre: RustTraceStateOut): void {
  for (const key of [
    "reserve0",
    "reserve1",
    "totalSupply",
    "e0",
    "e1",
    "protocolFee0",
    "protocolFee1",
    "anchorReserve0",
    "anchorReserve1",
  ] as const) {
    expect(BigInt(curPre[key] ?? "0"), `${label} rust chain ${key}`).to.equal(BigInt(prevPost[key] ?? "0"));
  }
  for (const key of [
    "equilibraEmaPrice",
    "equilibraLastTimestamp",
    "equilibraLastRecenterTimestamp",
    "equilibraAnchorPriceWad",
    "equilibraLpUnitValueGenesisWad",
    "equilibraLpUnitValueWad",
    "equilibraLpValueGrowthWad",
    "equilibraDonationShares",
  ] as const) {
    expect(BigInt(curPre[key] ?? "0"), `${label} rust chain ${key}`).to.equal(BigInt(prevPost[key] ?? "0"));
  }
}

// ---------------------------------------------------------------------------
// Scenario runner. Builds a sequence that exercises:
//   1. Quote parity (every swap `quoteExactIn` → actual `amountOut`).
//   2. Swaps away from anchor, toward anchor, cross anchor.
//   3. Interleaved addLiquidity / removeLiquidity that re-anchors
//      `_lpUnitValueWad` proportionally without touching the cumulative
//      `_lpValueGrowthWad` accumulator.
//   4. At least one `AnchorUpdated` repeg event after enough fee accrual.
// ---------------------------------------------------------------------------

type SwapSpec = {
  side: "base" | "quote";
  // `bps` is interpreted against the *current* reserve of `side`-token.
  bps: number;
};

const SWAP_PLAN: SwapSpec[] = [
  // "From anchor": small probes that barely perturb the curve.
  { side: "base", bps: 25 },
  { side: "quote", bps: 25 },
  // Build fee budget + push EMA off the anchor.
  { side: "base", bps: 350 },
  { side: "base", bps: 600 },
  { side: "base", bps: 800 },
  // Now swing back hard toward and across the anchor.
  { side: "quote", bps: 1200 },
  { side: "quote", bps: 1800 },
  // Cross anchor swaps exercise the k-selection / smoothstep transition.
  { side: "quote", bps: 2500 },
  { side: "base", bps: 2000 },
];

// Map a (base|quote) side spec onto the *actual* (token0|token1) side
// for the given pool (whichever address sorted lower becomes token0).
function sideForPool(ctx: PoolContext, side: "base" | "quote"): "token0" | "token1" {
  const baseIsToken0 = ctx.token0Symbol === ctx.baseSymbol;
  if (side === "base") return baseIsToken0 ? "token0" : "token1";
  return baseIsToken0 ? "token1" : "token0";
}

function bpsOfReserve(current: RecordedState, side: "token0" | "token1", bps: number): bigint {
  const reserveIn = side === "token0" ? current.reserve0 : current.reserve1;
  const amount = (reserveIn * BigInt(bps)) / 10_000n;
  return amount === 0n ? 1n : amount;
}

async function runScenario(infra: PoolInfra, baseSymbol: BaseSymbol): Promise<void> {
  const ctx = await setupPool(infra, baseSymbol);
  const steps: RecordedStep[] = [];
  let ts = ctx.initTs;
  let current: RecordedState = await captureState(ctx);

  // --- Phase 1: swap sweep (from anchor → to anchor → cross anchor). ---
  for (const spec of SWAP_PLAN) {
    const side = sideForPool(ctx, spec.side);
    const amountIn = bpsOfReserve(current, side, spec.bps);
    // 5-minute spacing lets the EMA track + keeps the per-block repeg
    // gate happy.
    ts += 300;
    await pushSwap(ctx, steps, side, amountIn, ts);
    current = steps[steps.length - 1].post;
  }

  // --- Phase 2: add liquidity mid-scenario (proportional LP-unit re-anchor). ---
  // 5% of current reserves on both sides is proportional enough that the
  // pool's min-ratio check accepts both amounts unchanged.
  const add0 = (current.reserve0 * 500n) / 10_000n;
  const add1 = (current.reserve1 * 500n) / 10_000n;
  ts += 300;
  await pushAdd(ctx, steps, add0, add1, ts);
  current = steps[steps.length - 1].post;

  // --- Phase 3: swap after add (LP-unit re-anchor must feed into quote math). ---
  {
    const side = sideForPool(ctx, "quote");
    const amountIn = bpsOfReserve(current, side, 450);
    ts += 300;
    await pushSwap(ctx, steps, side, amountIn, ts);
    current = steps[steps.length - 1].post;
  }

  // --- Phase 3b: exact-output swap mid-scenario. ---
  // Verifies that the unified `_executeExactOutWithDynamicFee` path
  // produces bit-identical Rust parity even when the pool is no
  // longer at its genesis state — LP unit value has re-anchored from
  // Phase 2's add, the EMA has been advancing, and prior swaps have
  // perturbed both reserves. Two probes (one per direction) so any
  // sign-handling drift in the gross-up + safety-bump path surfaces
  // here regardless of which side the trader is paying.
  for (const outputSpec of ["base", "quote"] as const) {
    // Input is the OPPOSITE of the requested output side.
    const inSide = sideForPool(ctx, outputSpec === "base" ? "quote" : "base");
    // The output reserve is on the side we are pulling from.
    const outputReserve = inSide === "token0" ? current.reserve1 : current.reserve0;
    const amountOut = (outputReserve * 150n) / 10_000n;
    if (amountOut === 0n) continue;
    ts += 300;
    await pushSwapExactOut(ctx, steps, inSide, amountOut, ts);
    current = steps[steps.length - 1].post;
  }

  // --- Phase 4: remove liquidity (proportional LP-unit shrink). ---
  const lpBalance = BigInt(await ctx.pool.balanceOf(ctx.infra.owner.address));
  const sharesToBurn = (lpBalance * 700n) / 10_000n;
  if (sharesToBurn > 0n) {
    ts += 300;
    await pushRemove(ctx, steps, sharesToBurn, ts);
    current = steps[steps.length - 1].post;
  }

  // --- Phase 4b: donation lifecycle. Park LP in the pool's own
  // balance (the parachute buffer), then exercise every accounting leg
  // against a LIVE buffer: swaps, the active-share mint (with its
  // proportional buffer top-up) and the active-share redemption (with
  // its proportional buffer burn). All of it must stay bit-identical
  // between the two stacks.
  {
    const donorBalance = BigInt(await ctx.pool.balanceOf(ctx.infra.owner.address));
    const donation = (donorBalance * 300n) / 10_000n;
    if (donation > 0n) {
      ts += 300;
      await pushDonate(ctx, steps, donation, ts);
      current = steps[steps.length - 1].post;

      const side = sideForPool(ctx, "quote");
      ts += 300;
      await pushSwap(ctx, steps, side, bpsOfReserve(current, side, 200), ts);
      current = steps[steps.length - 1].post;

      const addB0 = (current.reserve0 * 400n) / 10_000n;
      const addB1 = (current.reserve1 * 400n) / 10_000n;
      ts += 300;
      await pushAdd(ctx, steps, addB0, addB1, ts);
      current = steps[steps.length - 1].post;
      expect(current.donationShares, `${ctx.baseSymbol} buffer must scale UP on a mint`).to.be.greaterThan(donation);

      const lpAfterDonate = BigInt(await ctx.pool.balanceOf(ctx.infra.owner.address));
      const burnB = (lpAfterDonate * 500n) / 10_000n;
      ts += 300;
      await pushRemove(ctx, steps, burnB, ts);
      const bufferBeforeBurn = current.donationShares;
      current = steps[steps.length - 1].post;
      expect(current.donationShares, `${ctx.baseSymbol} buffer must scale DOWN on an exit`).to.be.lessThan(
        bufferBeforeBurn
      );
    }
  }

  // --- Phase 5: final swap — LP-unit shrink + k-selection smoothstep path. ---
  {
    const side = sideForPool(ctx, "base");
    const amountIn = bpsOfReserve(current, side, 300);
    ts += 300;
    await pushSwap(ctx, steps, side, amountIn, ts);
    current = steps[steps.length - 1].post;
  }

  // --- Phase 6: drive a repeg probe if none has triggered yet. The
  // goal is to observe at least one `AnchorUpdated` event so the
  // `_lastRepegTs` update + the Rust `recentered` flag parity are both
  // exercised at least once per run.
  const hasRecentered = () => steps.some((s) => s.action === "swap" && s.anchorUpdated);
  for (let probe = 0; probe < 16 && !hasRecentered(); probe++) {
    const specSide: "base" | "quote" = probe % 2 === 0 ? "base" : "quote";
    const side = sideForPool(ctx, specSide);
    const amountIn = bpsOfReserve(current, side, 900);
    ts += 300;
    await pushSwap(ctx, steps, side, amountIn, ts);
    current = steps[steps.length - 1].post;
  }

  expect(steps.length, `${ctx.baseSymbol} recorded step count`).to.be.greaterThan(SWAP_PLAN.length);
  expect(hasRecentered(), `${ctx.baseSymbol} expected at least one AnchorUpdated event in the scenario`).to.equal(true);

  await assertInvariantsAndRustParity(ctx, steps);
}

// ---------------------------------------------------------------------------
// Shared scenario tail: on-chain LP-accounting invariants, state-chain
// continuity, and the bit-exact Rust trace replay. Every scenario runner
// funnels through this so a new phase automatically inherits the full
// assertion set.
// ---------------------------------------------------------------------------
async function assertInvariantsAndRustParity(ctx: PoolContext, steps: RecordedStep[]): Promise<void> {
  // --- LP-unit-value invariants. The cumulative growth
  // accumulator must NEVER decrease (not even across a successful
  // anchor update — an `AnchorUpdated` re-anchors `_lpUnitValueWad` to
  // the post-step live value but explicitly leaves
  // `_lpValueGrowthWad` intact). At the same time `lpUnitValueWad`
  // must stay at or above `lpUnitValueGenesisWad` whenever the metric
  // is defined (post-genesis).
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].post;
    const cur = steps[i].post;
    const tag = `${ctx.baseSymbol} growth-monotonic[${i}]`;
    expect(cur.equilibraLpValueGrowthWad, `${tag} growth must be monotonic`).to.be.greaterThanOrEqual(
      prev.equilibraLpValueGrowthWad
    );
    if (cur.equilibraLpUnitValueWad > 0n) {
      expect(cur.equilibraLpUnitValueWad, `${tag} live vp >= genesis vp`).to.be.greaterThanOrEqual(
        cur.equilibraLpUnitValueGenesisWad
      );
    }
  }
  // The genesis vp must be set by the seed mint and must never change
  // afterwards — `_lpUnitValueGenesisWad` is a one-shot snapshot.
  for (let i = 1; i < steps.length; i++) {
    expect(steps[i].post.equilibraLpUnitValueGenesisWad, `${ctx.baseSymbol} genesis vp immutable`).to.equal(
      steps[0].post.equilibraLpUnitValueGenesisWad
    );
  }

  // --- Strict on-chain state-chain continuity. Every step's
  // `pre` must equal the previous step's `post` — otherwise the snapshot
  // is stale and parity checks downstream are meaningless.
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].post;
    const cur = steps[i].pre;
    const tag = `${ctx.baseSymbol} chain[${i}]`;
    expect(cur.reserve0, `${tag} reserve0`).to.equal(prev.reserve0);
    expect(cur.reserve1, `${tag} reserve1`).to.equal(prev.reserve1);
    expect(cur.totalSupply, `${tag} totalSupply`).to.equal(prev.totalSupply);
    expect(cur.protocolFee0, `${tag} protocolFee0`).to.equal(prev.protocolFee0);
    expect(cur.protocolFee1, `${tag} protocolFee1`).to.equal(prev.protocolFee1);
    expect(cur.equilibraAnchorPriceWad, `${tag} anchorPrice`).to.equal(prev.equilibraAnchorPriceWad);
    expect(cur.equilibraEmaPrice, `${tag} emaPrice`).to.equal(prev.equilibraEmaPrice);
    expect(cur.equilibraLpUnitValueGenesisWad, `${tag} lpUnitValueGenesisWad`).to.equal(
      prev.equilibraLpUnitValueGenesisWad
    );
    expect(cur.equilibraLpUnitValueWad, `${tag} lpUnitValueWad`).to.equal(prev.equilibraLpUnitValueWad);
    expect(cur.equilibraLpValueGrowthWad, `${tag} lpValueGrowthWad`).to.equal(prev.equilibraLpValueGrowthWad);
    expect(cur.equilibraLastTimestamp, `${tag} lastEmaTs`).to.equal(prev.equilibraLastTimestamp);
    expect(cur.equilibraLastRecenterTimestamp, `${tag} lastRepegTs`).to.equal(prev.equilibraLastRecenterTimestamp);
    expect(cur.donationShares, `${tag} donationShares`).to.equal(prev.donationShares);
  }

  // --- Replay the whole sequence through the Rust trace and
  // compare bit-for-bit.
  const traceInput = buildRustTraceInput(ctx, steps);
  const rust = runRustSimulatorTrace<RustTraceOutput>(traceInput);
  expect(rust.mode, `${ctx.baseSymbol} rust mode`).to.equal("trace_replay");
  expect(rust.amm, `${ctx.baseSymbol} rust amm`).to.equal("equilibra");
  expect(rust.baseSymbol, `${ctx.baseSymbol} rust baseSymbol`).to.equal(ctx.baseSymbol);
  expect(rust.steps.length, `${ctx.baseSymbol} rust step count`).to.equal(steps.length);

  for (let i = 0; i < steps.length; i++) {
    const row = steps[i];
    const r = rust.steps[i];
    const label = `${ctx.baseSymbol} step#${i}[${row.action}]`;

    let expectedRustAction: string;
    if (row.action === "add") {
      expectedRustAction = "addLiquidity";
    } else if (row.action === "remove") {
      expectedRustAction = "removeLiquidity";
    } else if (row.action === "swapExactOut") {
      expectedRustAction = "swapExactOut";
    } else if (row.action === "donate") {
      expectedRustAction = "donate";
    } else {
      expectedRustAction = "swap";
    }
    expect(r.action, `${label} action`).to.equal(expectedRustAction);
    expect(r.timestamp, `${label} timestamp`).to.equal(row.timestamp);
    if (i > 0) {
      assertRustStateChainContinuity(label, rust.steps[i - 1].post, r.pre);
    }
    assertStateMatchesRust(label, "pre", row.pre, r.pre);
    assertStateMatchesRust(label, "post", row.post, r.post);

    if (row.action === "swap") {
      expect((r.tokenIn ?? "").toLowerCase(), `${label} tokenIn`).to.equal(row.tokenIn.toLowerCase());
      expect(BigInt(r.amountIn ?? "0"), `${label} amountIn`).to.equal(row.amountIn);
      expect(BigInt(r.amountOut ?? "0"), `${label} amountOut`).to.equal(row.amountOutOnchain);
      expect(Boolean(r.equilibraRecentered), `${label} recentered flag`).to.equal(row.anchorUpdated);
    } else if (row.action === "swapExactOut") {
      expect((r.tokenIn ?? "").toLowerCase(), `${label} tokenIn`).to.equal(row.tokenIn.toLowerCase());
      // Mirror of the bit-exact identity surfaced by the standalone
      // ExactOutRustParity suite, replayed here mid-scenario so that
      // any drift introduced by an upstream stateful change (LP unit
      // value re-anchoring after add / remove, EMA update, prior
      // repeg) is caught at the integration boundary, not just on a
      // freshly initialised pool.
      expect(BigInt(r.amountIn ?? "0"), `${label} amountIn`).to.equal(row.amountInOnchain);
      expect(BigInt(r.amountOut ?? "0"), `${label} amountOut`).to.equal(row.amountOut);
      expect(Boolean(r.equilibraRecentered), `${label} recentered flag`).to.equal(row.anchorUpdated);
    } else if (row.action === "add") {
      expect(BigInt(r.amount0 ?? "0"), `${label} amount0Used`).to.equal(row.amount0UsedOnchain);
      expect(BigInt(r.amount1 ?? "0"), `${label} amount1Used`).to.equal(row.amount1UsedOnchain);
      expect(BigInt(r.mintedLiquidity ?? "0"), `${label} shares`).to.equal(row.mintedLiquidity);
    } else if (row.action === "donate") {
      expect(BigInt(r.liquidity ?? "0"), `${label} donated shares`).to.equal(row.shares);
    } else {
      expect(BigInt(r.liquidity ?? "0"), `${label} burn`).to.equal(row.shares);
      expect(BigInt(r.amount0Out ?? "0"), `${label} amount0Out`).to.equal(row.amount0OutOnchain);
      expect(BigInt(r.amount1Out ?? "0"), `${label} amount1Out`).to.equal(row.amount1OutOnchain);
    }
  }

  const lastPost = steps[steps.length - 1].post;
  assertStateMatchesRust(`${ctx.baseSymbol} final`, "final", lastPost, rust.finalState);

  // Emit a terse summary so reviewers can eyeball coverage without
  // digging through step-by-step logs.
  const swapCount = steps.filter((s) => s.action === "swap").length;
  const addCount = steps.filter((s) => s.action === "add").length;
  const removeCount = steps.filter((s) => s.action === "remove").length;
  const donateCount = steps.filter((s) => s.action === "donate").length;
  const repegCount = steps.filter((s) => s.action === "swap" && s.anchorUpdated).length;
  console.log(
    `      [${ctx.baseSymbol}] steps=${steps.length}  swaps=${swapCount}  adds=${addCount}  removes=${removeCount}  donates=${donateCount}  anchorUpdates=${repegCount}`
  );
}

// ---------------------------------------------------------------------------
// Starved-parachute scenario. Reuses the recipe of
// test/security/DonationParachute.test.ts's `starvedFixture`: a 5 bps
// flat fee crossed with a 1 bps repeg share keeps the pool's own
// spendable growth surplus permanently under `REPEG_GAS_GUARD_WAD`, and
// 1e14 dead-bands (inside the stall-guard cap `5 · 1e14`)
// put the parachute activation at `K × 1e14` (0.3%
// geometric anchor lag at the canonical creation seed K = 30, read from
// the pool — never hardcoded). Drive a large anchor lag, park a
// donation via the plain-LP-transfer primitive, then trigger: the
// commit must be PARACHUTE-funded (an exact-shortfall buffer burn that
// also shrinks totalSupply) and bit-identical between the stacks —
// including the burned buffer, the priceScale move, the latch and the
// supply, at every step.
// ---------------------------------------------------------------------------

const STARVED_DEAD_BAND_WAD = 10n ** 14n;
const REPEG_GAS_GUARD_WAD = 4n * 10n ** 10n;
const REPEG_DONATION_DUST_SHARES = 10n ** 12n;

const STARVED_OVERRIDES: PoolParamOverrides = {
  baseFee: 5,
  feeRampBps: 0,
  feeFloorBps: 0,
  repegShareBps: 1,
  emaPeriod: 1200,
  repegStepWad: 5n * 10n ** 15n,
  repegThresholdToken1UpWad: STARVED_DEAD_BAND_WAD,
  repegThresholdToken1DownWad: STARVED_DEAD_BAND_WAD,
};

function geometricDeviationWad(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi * WAD) / lo - WAD;
}

async function runStarvedParachuteScenario(infra: PoolInfra, baseSymbol: BaseSymbol): Promise<void> {
  const ctx = await setupPool(infra, baseSymbol, STARVED_OVERRIDES);
  const steps: RecordedStep[] = [];
  let ts = ctx.initTs;
  let current: RecordedState = await captureState(ctx);
  const tag = `${baseSymbol} starved-parachute`;

  // --- Phase A: build the anchor lag (mirror of the security suite's
  // `driveIntoLag`): one large base-side swap moves the spot, three EMA
  // half-lives later a dust swap mixes the (clamped) spot into the EMA.
  // Neither swap may commit — the pool has no own budget and the
  // donation buffer is still empty, so the parachute declines too.
  const side = sideForPool(ctx, "base");
  ts += 300;
  await pushSwap(ctx, steps, side, bpsOfReserve(current, side, 400), ts);
  current = steps[steps.length - 1].post;

  ts += 3600; // 3 half-lives at emaPeriod = 1200
  await pushSwap(ctx, steps, side, bpsOfReserve(current, side, 1), ts);
  current = steps[steps.length - 1].post;

  // Premise: the lag is past the parachute activation `K × band`.
  const deviationWad = geometricDeviationWad(current.equilibraEmaPrice, current.equilibraAnchorPriceWad);
  const activationWad = STARVED_DEAD_BAND_WAD * BigInt(ctx.parachuteBandMult);
  expect(deviationWad, `${tag} premise: lag past K × band`).to.be.greaterThanOrEqual(activationWad);

  // Premise: the pool's own budget is starved. protocolFee = 0 in this
  // fixture, so the stored (grossed-up) share equals the user share
  // (1 bps): the spendable slice of cumulative growth must sit at or
  // under the gas guard, which is what forces the pre-repeg gate to
  // hand over to the parachute on every attempt.
  const spendableWad = (current.equilibraLpValueGrowthWad * BigInt(ctx.repegShareBps)) / 10_000n;
  expect(spendableWad, `${tag} premise: own budget under the gas guard`).to.be.lessThanOrEqual(REPEG_GAS_GUARD_WAD);

  // --- Phase B: park the donation. The primitive: a plain LP transfer
  // to the pool's own address (the router's guarded `donate` wraps the
  // very same transfer — state-identical for the trace).
  const donorBalance = BigInt(await ctx.pool.balanceOf(ctx.infra.owner.address));
  const donation = (donorBalance * 200n) / 10_000n;
  expect(donation, `${tag} premise: donation above the dust floor`).to.be.greaterThan(REPEG_DONATION_DUST_SHARES);
  ts += 300;
  await pushDonate(ctx, steps, donation, ts);
  current = steps[steps.length - 1].post;

  // --- Phase C: trigger. A dust swap re-runs `_tryAutoRepeg`; the
  // pre-gate finds no spendable growth and hands over — the PARACHUTE
  // must commit the full damped step and burn the exact shortfall from
  // the buffer.
  ts += 300;
  await pushSwap(ctx, steps, side, bpsOfReserve(current, side, 1), ts);
  current = steps[steps.length - 1].post;

  // Every setup swap must NOT have committed: the buffer burn below is
  // therefore attributable to THE parachute commit on the trigger, and
  // the scenario cannot silently degrade into a no-commit run.
  for (let i = 0; i < steps.length - 1; i++) {
    const s = steps[i];
    if (s.action === "swap" || s.action === "swapExactOut") {
      expect(s.anchorUpdated, `${tag} setup step#${i} must not commit`).to.equal(false);
    }
  }
  const trigger = steps[steps.length - 1];
  if (trigger.action !== "swap") throw new Error(`${tag}: trigger must be a swap step`);
  expect(trigger.anchorUpdated, `${tag} trigger must commit an anchor move`).to.equal(true);
  expect(trigger.post.equilibraAnchorPriceWad, `${tag} priceScale must move`).to.not.equal(
    trigger.pre.equilibraAnchorPriceWad
  );
  const burnedShares = trigger.pre.donationShares - trigger.post.donationShares;
  expect(burnedShares, `${tag} the commit must be buffer-funded (parachute fired)`).to.be.greaterThan(0n);
  expect(trigger.pre.totalSupply - trigger.post.totalSupply, `${tag} supply falls by exactly the burn`).to.equal(
    burnedShares
  );

  // Bit-exact Rust replay of the whole sequence — donation buffer
  // before/after (the burn), priceScaleWad, the lpUnitValueWad latch,
  // totalSupply and the full per-step state set are all asserted inside.
  await assertInvariantsAndRustParity(ctx, steps);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("General on-chain ↔ Rust simulator parity (WETH + WBTC)", function () {
  this.timeout(600_000);

  it("matches bit-exactly across a full scenario (WETH preset)", async function () {
    const infra = await deployInfra();
    await runScenario(infra, "WETH");
  });

  it("matches bit-exactly across a full scenario (WBTC preset)", async function () {
    const infra = await deployInfra();
    await runScenario(infra, "WBTC");
  });

  it("matches bit-exactly through a starved-pool parachute burn (WETH curve)", async function () {
    const infra = await deployInfra();
    await runStarvedParachuteScenario(infra, "WETH");
  });

  it("matches bit-exactly through a starved-pool parachute burn (WBTC curve)", async function () {
    const infra = await deployInfra();
    await runStarvedParachuteScenario(infra, "WBTC");
  });
});
