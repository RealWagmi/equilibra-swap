import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ethers } from "hardhat";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RUST_CARGO_MANIFEST = path.join(PROJECT_ROOT, "simulator/Cargo.toml");
const ERC20_ABI = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";

type RustTraceStep =
  | {
      action: "swap";
      tokenIn: string;
      amountIn: string;
      timestamp: number;
    }
  | {
      action: "swapExactOut";
      tokenIn: string;
      amountOut: string;
      timestamp: number;
    };

type RustTraceInput = {
  startTimestamp: number;
  pool: Record<string, unknown>;
  steps: Array<RustTraceStep>;
};

/// Post-state fields the Rust trace runner reports after every step.
/// Mirrors the `TraceStateOut` shape on the Rust side. We only model
/// the subset the TS parity tests actually compare against — the full
/// shape carries dozens of optional Curve / Uniswap fields nobody in
/// these tests reads.
export type RustTraceState = {
  reserve0?: string;
  reserve1?: string;
  totalSupply?: string;
  e0?: string;
  e1?: string;
  protocolFee0?: string;
  protocolFee1?: string;
  equilibraEmaPrice?: string;
  equilibraLastTimestamp?: string;
  equilibraLastRecenterTimestamp?: string;
  equilibraAnchorPriceWad?: string;
  equilibraLpUnitValueGenesisWad?: string;
  equilibraLpUnitValueWad?: string;
  equilibraLpValueGrowthWad?: string;
};

export type RustTraceStepOut = {
  action?: string;
  amountIn?: string;
  amountOut?: string;
  tokenIn?: string;
  equilibraRecentered?: boolean;
  equilibraRecenterBlockedBy?: string;
  pre?: RustTraceState;
  post?: RustTraceState;
};

type RustTraceOutput = {
  steps: Array<RustTraceStepOut>;
};

export type RustEquilibraPreset = {
  /** Slot of this pair's base token ("token0" = mainnet address-sort
   *  layout). Curve always keeps the quote in slot 0. */
  baseTokenPosition: "token0" | "token1";
  /** Depth-at-anchor knob `a` (WAD). Mirrors `_aWad`. */
  aWad: string;
  /** Plateau-width knob `λ` (WAD). Mirrors `_lambdaWad`. */
  lambdaWad: string;
  /** Smoothstep fee ceiling in BPS. Mirrors `PoolConfig.baseFee`. */
  feeBps: number;
  emaPeriod: number;
  repegStepWad: string;
  /** Direction-split dead-bands: `Up` applies while ema > priceScale
   *  (token1's price in token0 above the anchor), `Down` otherwise.
   *  Under the mainnet base-in-slot-0 layout a RISING base market is an
   *  internal token1-DOWN move. */
  repegThresholdToken1UpWad: string;
  repegThresholdToken1DownWad: string;
  protocolFeePercent: number;
  rebalanceEnabled: boolean;
  /** Smoothstep warm-up width in BPS. Mirrors `PoolConfig.feeRampBps`. */
  feeRampBps: number;
  /** Dynamic-fee floor in BPS. Mirrors `PoolConfig.feeFloorBps`. */
  feeFloorBps: number;
  /** Share of the LP fee routed to the repeg budget in BPS of 10_000. Mirrors `PoolConfig.repegShareBps`. */
  repegShareBps: number;
  /** Annual donation stream into the donation-parachute buffer, BPS of
   *  pool TVL per year (0 = disabled). */
  donationAprBps: number;
  /** Seconds between donation transfers (0 while the stream is off). */
  donationIntervalSec: number;
};

export type RustCurvePreset = {
  A: number;
  gamma: string;
  midFee: string;
  outFee: string;
  feeGamma: string;
  adjustmentStepMin: string;
  adjustmentStepMax: string;
  reservedProfitFraction: string;
  maTime: number;
  donationAprBps: number;
  donationIntervalSec: number;
  rebalanceEnabled: boolean;
};

export type RustBenchmarkRunConfig = {
  version: "benchmark-run-config/v11";
  simulationEngine: "ts" | "rust";
  simulation: {
    startTimestamp: number;
    endTimestamp: number;
    seed: number;
    progressIntervalSec: number;
  };
  liquidity: {
    passiveLpInitialUsd: number;
  };
  actors: {
    user: {
      minTradeUsd: number;
      maxTradeUsd: number;
    };
    arbitrageur: {
      minProfitUsd: number;
      minProfitBps: number;
      gasPriceGwei: number;
      maxSearchIterations: number;
      probeUsd: number;
      minTradeUsd: number;
      gasUsedEstimates: Record<"equilibra" | "uniswapV2" | "curve", string>;
      postArbExternalSwaps: {
        count: number;
        shareBps: number;
        minAmountUsd: number;
        abnormalLossFactor: number;
      };
    };
  };
  reporting: {
    slippageSweep: {
      minInitialSideBps: number;
      maxInitialSideBps: number;
    };
  };
  amms: {
    equilibra: {
      enabled: boolean;
      presets: Record<"WETH" | "WBTC", RustEquilibraPreset>;
    };
    uniswapV2: {
      enabled: boolean;
      feeBps: number;
      rebalanceEnabled: boolean;
    };
    curve: {
      enabled: boolean;
      mathMode: "stableswap" | "crypto";
      presets: Record<"WETH" | "WBTC", RustCurvePreset>;
    };
  };
  parallel: {
    maxWorkers: number;
  };
};

export type RustBenchmarkDefaults = {
  config: RustBenchmarkRunConfig;
  testPrices: Record<"WETH" | "WBTC", string>;
};

export type SnapshotForRustQuote = {
  poolKey: string;
  amm: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  /**
   * Token decimals, forwarded verbatim into the trace's required
   * `token0Decimals`/`token1Decimals` fields. Trace pools may use
   * synthetic symbols the simulator's canonical symbol table does not
   * know, so the trace itself must carry the decimals explicitly.
   */
  token0Decimals: number;
  token1Decimals: number;
  reserve0: bigint;
  reserve1: bigint;
  feeBps: number;
  /** Depth-at-anchor knob `a` (WAD). Required for `amm == "equilibra"`. */
  aWad?: bigint;
  /** Plateau-width knob `λ` (WAD). Required for `amm == "equilibra"`. */
  lambdaWad?: bigint;
  equilibraProtocolFeePercent?: bigint;
  equilibraEmaPeriod?: bigint;
  /** Smoothstep ramp width in BPS. Mirrors `PoolConfig.feeRampBps`. */
  equilibraFeeRampBps?: bigint;
  /** Dynamic-fee floor in BPS. Mirrors `PoolConfig.feeFloorBps`. */
  equilibraFeeFloorBps?: bigint;
  /** LP-fee share routed to the repeg budget in BPS of 10_000. Mirrors `PoolConfig.repegShareBps`. */
  equilibraRepegShareBps?: bigint;
  equilibraProtocolFee0?: bigint;
  equilibraProtocolFee1?: bigint;
  equilibraE0?: bigint;
  equilibraE1?: bigint;
  equilibraEmaPrice?: bigint;
  equilibraLastTimestamp?: bigint;
  equilibraLastRecenterTimestamp?: bigint;
  equilibraRepegStepWad?: bigint;
  /**
   * Auto-repeg activation dead-band (WAD) applied while the EMA sits
   * above `priceScale`. Mirrors `_repegThresholdToken1UpWad`. Optional
   * in the trace schema — the Rust parser defaults it to
   * `equilibraRepegStepWad` when absent.
   */
  equilibraRepegThresholdToken1UpWad?: bigint;
  /**
   * Dead-band applied while the EMA sits below `priceScale`. Mirrors
   * `_repegThresholdToken1DownWad`. Same trace-schema default as the
   * `up` band.
   */
  equilibraRepegThresholdToken1DownWad?: bigint;
  /**
   * Donation-parachute activation multiplier K (`activation = K × active
   * dead-band`). Mirrors the per-pool `_parachuteBandMult` storage —
   * read it from `pool.getFeeConfig().parachuteBandMult`, never
   * hardcode it. Optional in the trace schema: the Rust parser defaults
   * an absent field to the creation seed (30), matching pools whose
   * timelock never adjusted K.
   */
  equilibraParachuteBandMult?: bigint;
  /** Blend-invariant anchor price (WAD) = `price1 / price0`. Mirrors `_anchorPriceWad`. */
  equilibraAnchorPriceWad?: bigint;
  /**
   * Genesis LP unit value (quote-WAD per LP-token-WAD). Mirrors
   * `_lpUnitValueGenesisWad`. Snapshot taken at the very first liquidity
   * event; the cumulative growth accumulator is measured against it.
   */
  equilibraLpUnitValueGenesisWad?: bigint;
  /**
   * Live high-water LP unit value (quote-WAD per LP-token-WAD). Mirrors
   * `_lpUnitValueWad`. Updated by every swap accrual and re-anchored
   * (without resetting growth) by every proportional liquidity event.
   */
  equilibraLpUnitValueWad?: bigint;
  /**
   * Cumulative LP unit-value gain since genesis (quote-WAD). Mirrors
   * `_lpValueGrowthWad`. Strictly monotonic — never reset, not even by a
   * successful repeg — and drives the auto-repeg gate via
   * `threshold = vpGenesis + growth · (BPS - repegShareBps) / BPS`.
   */
  equilibraLpValueGrowthWad?: bigint;
  uniswapBlockTimestampLast?: bigint;
  uniswapPrice0CumulativeLast?: bigint;
  uniswapPrice1CumulativeLast?: bigint;
  uniswapKLast?: bigint;
  curveA?: bigint;
  curveGamma?: bigint;
  curveMidFee?: bigint;
  curveOutFee?: bigint;
  curveFeeGamma?: bigint;
  curvePriceScale?: bigint;
  curveD?: bigint;
  curveAdjustmentStepMin?: bigint;
  curveAdjustmentStepMax?: bigint;
  curveReservedProfitFraction?: bigint;
  curveMaTime?: bigint;
  curvePriceOracle?: bigint;
  curveLastPrices?: bigint;
  curveLastTimestamp?: bigint;
  curveVirtualPrice?: bigint;
  curveXcpProfit?: bigint;
  curveLpXcpProfit?: bigint;
  curveTotalSupply?: bigint;
  curveMathMode?: "stableswap" | "crypto";
};

let rustBuildReady = false;
const resolvedBinaries = new Map<string, string>();
let cachedDefaults: RustBenchmarkDefaults | null = null;

function withCargoPath(envIn: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...envIn };
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return env;
  const cargoBin = path.join(home, ".cargo/bin");
  const current = env.PATH ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (!parts.includes(cargoBin)) {
    env.PATH = `${cargoBin}${current ? path.delimiter : ""}${current}`;
  }
  return env;
}

function ensureRustBuildReady(): void {
  if (rustBuildReady) return;
  try {
    execFileSync("cargo", ["build", "--manifest-path", RUST_CARGO_MANIFEST, "--release", "--bins"], {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
      env: withCargoPath(process.env),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to build rust simulator artifacts: ${msg}`);
  }
  rustBuildReady = true;
}

function resolveTargetRootFromEnv(): string | null {
  const envTarget = process.env.CARGO_TARGET_DIR?.trim();
  if (!envTarget) return null;
  if (path.isAbsolute(envTarget)) return envTarget;
  return path.join(PROJECT_ROOT, envTarget);
}

function getRustBinaryCandidatePaths(binName: string): string[] {
  const targetRoots = [
    resolveTargetRootFromEnv(),
    path.join(PROJECT_ROOT, "simulator/target"),
    path.join(PROJECT_ROOT, "target"),
  ].filter((p): p is string => Boolean(p));

  return targetRoots.flatMap((root) => [path.join(root, "release", binName), path.join(root, "debug", binName)]);
}

function assertBinarySupportsFlags(candidate: string, binName: string, requiredFlags: string[]): void {
  if (requiredFlags.length === 0) return;
  let help = "";
  try {
    help = execFileSync(candidate, ["--help"], {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
      env: withCargoPath(process.env),
    }).toString("utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to query rust binary help for ${binName}: ${msg}`);
  }

  for (const flag of requiredFlags) {
    if (!help.includes(flag)) {
      throw new Error(`rust binary ${binName} does not support required flag ${flag}`);
    }
  }
}

function resolveRustBinary(binName: string, requiredFlags: string[] = []): string {
  const cached = resolvedBinaries.get(binName);
  if (cached) return cached;

  ensureRustBuildReady();
  const candidatePaths = getRustBinaryCandidatePaths(binName);
  const candidate = candidatePaths.find((p) => fs.existsSync(p)) ?? null;
  if (!candidate) {
    throw new Error(`rust binary not found after build: ${binName}`);
  }

  assertBinarySupportsFlags(candidate, binName, requiredFlags);

  resolvedBinaries.set(binName, candidate);
  return candidate;
}

export function resolveRustSimulatorBinary(): string {
  return resolveRustBinary("equilibra-offchain-simulator", ["--trace-input", "--trace-output"]);
}

export function runRustSimulatorTrace<TOut>(input: unknown): TOut {
  const bin = resolveRustSimulatorBinary();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "equilibra-rust-trace-"));
  const inPath = path.join(tmpDir, "trace.in.json");
  const outPath = path.join(tmpDir, "trace.out.json");
  try {
    fs.writeFileSync(inPath, JSON.stringify(input));
    execFileSync(
      bin,
      [
        "--config",
        inPath, // required by CLI parser in trace mode
        "--trace-input",
        inPath,
        "--trace-output",
        outPath,
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: "pipe",
        env: withCargoPath(process.env),
      }
    );
    const raw = fs.readFileSync(outPath, "utf8");
    return JSON.parse(raw) as TOut;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function loadRustBenchmarkDefaults(): RustBenchmarkDefaults {
  if (cachedDefaults) return cachedDefaults;
  const bin = resolveRustBinary("equilibra-offchain-config-defaults");
  let raw = "";
  try {
    raw = execFileSync(bin, [], {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
      env: withCargoPath(process.env),
    }).toString("utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to load rust benchmark defaults: ${msg}`);
  }
  cachedDefaults = JSON.parse(raw) as RustBenchmarkDefaults;
  return cachedDefaults;
}

type RustPoolPayload = Record<string, unknown>;

function buildBaseTracePool(
  snapshot: SnapshotForRustQuote,
  baseSymbol: "WETH" | "WBTC",
  totalSupply: bigint
): RustPoolPayload {
  return {
    contextName: snapshot.poolKey,
    amm: snapshot.amm,
    baseSymbol,
    token0: snapshot.token0,
    token1: snapshot.token1,
    token0Symbol: snapshot.token0Symbol,
    token1Symbol: snapshot.token1Symbol,
    token0Decimals: snapshot.token0Decimals,
    token1Decimals: snapshot.token1Decimals,
    reserve0: snapshot.reserve0.toString(),
    reserve1: snapshot.reserve1.toString(),
    feeBps: snapshot.feeBps,
    totalSupply: totalSupply.toString(),
  };
}

function appendEquilibraTraceFields(snapshot: SnapshotForRustQuote, pool: RustPoolPayload): void {
  const requireBigintField = (value: bigint | undefined, fieldName: string): bigint => {
    if (value === undefined) {
      throw new Error(`${snapshot.poolKey}: required equilibra field missing: ${fieldName}`);
    }
    return value;
  };

  // The two-knob kernel replaced single-knob `alpha` with `(aWad,
  // lambdaWad)`. Both are required for Equilibra trace input.
  const aWad = requireBigintField(snapshot.aWad, "aWad");
  const lambdaWad = requireBigintField(snapshot.lambdaWad, "lambdaWad");
  const protocolFeePercent = requireBigintField(snapshot.equilibraProtocolFeePercent, "equilibraProtocolFeePercent");
  const emaPeriod = requireBigintField(snapshot.equilibraEmaPeriod, "equilibraEmaPeriod");
  const equilibraProtocolFee0 = requireBigintField(snapshot.equilibraProtocolFee0, "equilibraProtocolFee0");
  const equilibraProtocolFee1 = requireBigintField(snapshot.equilibraProtocolFee1, "equilibraProtocolFee1");
  const equilibraE0 = requireBigintField(snapshot.equilibraE0, "equilibraE0");
  const equilibraE1 = requireBigintField(snapshot.equilibraE1, "equilibraE1");
  const equilibraEmaPrice = requireBigintField(snapshot.equilibraEmaPrice, "equilibraEmaPrice");
  const equilibraLastTimestamp = requireBigintField(snapshot.equilibraLastTimestamp, "equilibraLastTimestamp");
  const equilibraLastRecenterTimestamp = requireBigintField(
    snapshot.equilibraLastRecenterTimestamp,
    "equilibraLastRecenterTimestamp"
  );
  const equilibraRepegStepWad = requireBigintField(snapshot.equilibraRepegStepWad, "equilibraRepegStepWad");
  // Blend-invariant canonical state (mirrors `_anchorPriceWad` and the
  // LP-unit-value trio: `_lpUnitValueGenesisWad`, `_lpUnitValueWad`,
  // `_lpValueGrowthWad`). The Rust trace parser uses
  // `deny_unknown_fields`, so any naming drift here surfaces
  // immediately as a parse error rather than a silent default.
  const equilibraAnchorPriceWad = requireBigintField(snapshot.equilibraAnchorPriceWad, "equilibraAnchorPriceWad");
  const equilibraLpUnitValueGenesisWad = requireBigintField(
    snapshot.equilibraLpUnitValueGenesisWad,
    "equilibraLpUnitValueGenesisWad"
  );
  const equilibraLpUnitValueWad = requireBigintField(snapshot.equilibraLpUnitValueWad, "equilibraLpUnitValueWad");
  const equilibraLpValueGrowthWad = requireBigintField(snapshot.equilibraLpValueGrowthWad, "equilibraLpValueGrowthWad");

  // `TracePoolInput` accepts `aWad`/`lambdaWad` after
  // the rename (see `simulator/src/main.rs` field declarations).
  pool.aWad = aWad.toString();
  pool.lambdaWad = lambdaWad.toString();
  pool.protocolFeePercent = Number(protocolFeePercent);
  pool.emaPeriod = Number(emaPeriod);
  // Dynamic-fee parameters are optional in the trace schema — default to the
  // ramp-disabled configuration (`feeRampBps=0`) and the on-chain default
  // floor (20 BPS) / 50% repeg share when the caller does not pass them. This
  // keeps the legacy callers bit-exact with the contract's pre-dynamic-fee
  // flat `feeBps` behaviour.
  if (snapshot.equilibraFeeRampBps !== undefined) {
    pool.equilibraFeeRampBps = Number(snapshot.equilibraFeeRampBps);
  }
  if (snapshot.equilibraFeeFloorBps !== undefined) {
    pool.equilibraFeeFloorBps = Number(snapshot.equilibraFeeFloorBps);
  }
  if (snapshot.equilibraRepegShareBps !== undefined) {
    pool.equilibraRepegShareBps = Number(snapshot.equilibraRepegShareBps);
  }
  pool.equilibraProtocolFee0 = equilibraProtocolFee0.toString();
  pool.equilibraProtocolFee1 = equilibraProtocolFee1.toString();
  pool.equilibraE0 = equilibraE0.toString();
  pool.equilibraE1 = equilibraE1.toString();
  pool.equilibraEmaPrice = equilibraEmaPrice.toString();
  pool.equilibraLastTimestamp = equilibraLastTimestamp.toString();
  pool.equilibraLastRecenterTimestamp = equilibraLastRecenterTimestamp.toString();
  pool.equilibraRepegStepWad = equilibraRepegStepWad.toString();
  // The activation dead-bands are optional in the trace schema; the
  // Rust parser falls back to `equilibraRepegStepWad` for an absent side.
  if (snapshot.equilibraRepegThresholdToken1UpWad !== undefined) {
    pool.equilibraRepegThresholdToken1UpWad = snapshot.equilibraRepegThresholdToken1UpWad.toString();
  }
  if (snapshot.equilibraRepegThresholdToken1DownWad !== undefined) {
    pool.equilibraRepegThresholdToken1DownWad = snapshot.equilibraRepegThresholdToken1DownWad.toString();
  }
  // Per-pool parachute activation multiplier K — optional; the Rust
  // parser falls back to the creation seed (30) when absent.
  if (snapshot.equilibraParachuteBandMult !== undefined) {
    pool.parachuteBandMult = Number(snapshot.equilibraParachuteBandMult);
  }
  pool.equilibraAnchorPriceWad = equilibraAnchorPriceWad.toString();
  pool.equilibraLpUnitValueGenesisWad = equilibraLpUnitValueGenesisWad.toString();
  pool.equilibraLpUnitValueWad = equilibraLpUnitValueWad.toString();
  pool.equilibraLpValueGrowthWad = equilibraLpValueGrowthWad.toString();
}

function appendUniswapTraceFields(snapshot: SnapshotForRustQuote, pool: RustPoolPayload): void {
  if (snapshot.uniswapBlockTimestampLast !== undefined) {
    pool.uniswapBlockTimestampLast = snapshot.uniswapBlockTimestampLast.toString();
  }
  if (snapshot.uniswapPrice0CumulativeLast !== undefined) {
    pool.uniswapPrice0CumulativeLast = snapshot.uniswapPrice0CumulativeLast.toString();
  }
  if (snapshot.uniswapPrice1CumulativeLast !== undefined) {
    pool.uniswapPrice1CumulativeLast = snapshot.uniswapPrice1CumulativeLast.toString();
  }
  if (snapshot.uniswapKLast !== undefined) {
    pool.uniswapKLast = snapshot.uniswapKLast.toString();
  }
}

function appendCurveTraceFields(snapshot: SnapshotForRustQuote, pool: RustPoolPayload): void {
  if (
    snapshot.curveA === undefined ||
    snapshot.curveGamma === undefined ||
    snapshot.curveMidFee === undefined ||
    snapshot.curveOutFee === undefined ||
    snapshot.curveFeeGamma === undefined ||
    snapshot.curvePriceScale === undefined
  ) {
    throw new Error(`${snapshot.poolKey}: required curve params missing in snapshot`);
  }
  pool.curveA = snapshot.curveA.toString();
  pool.curveGamma = snapshot.curveGamma.toString();
  pool.curveMidFee = snapshot.curveMidFee.toString();
  pool.curveOutFee = snapshot.curveOutFee.toString();
  pool.curveFeeGamma = snapshot.curveFeeGamma.toString();
  pool.curvePriceScale = snapshot.curvePriceScale.toString();

  if (snapshot.curveD !== undefined) pool.curveD = snapshot.curveD.toString();
  if (snapshot.curveAdjustmentStepMin !== undefined) {
    pool.curveAdjustmentStepMin = snapshot.curveAdjustmentStepMin.toString();
  }
  if (snapshot.curveAdjustmentStepMax !== undefined) {
    pool.curveAdjustmentStepMax = snapshot.curveAdjustmentStepMax.toString();
  }
  if (snapshot.curveReservedProfitFraction !== undefined) {
    pool.curveReservedProfitFraction = snapshot.curveReservedProfitFraction.toString();
  }
  if (snapshot.curveMaTime !== undefined) {
    pool.curveMaTime = snapshot.curveMaTime.toString();
  }
  if (snapshot.curvePriceOracle !== undefined) {
    pool.curvePriceOracle = snapshot.curvePriceOracle.toString();
  }
  if (snapshot.curveLastPrices !== undefined) {
    pool.curveLastPrices = snapshot.curveLastPrices.toString();
  }
  if (snapshot.curveLastTimestamp !== undefined) {
    pool.curveLastTimestamp = snapshot.curveLastTimestamp.toString();
  }
  if (snapshot.curveVirtualPrice !== undefined) {
    pool.curveVirtualPrice = snapshot.curveVirtualPrice.toString();
  }
  if (snapshot.curveXcpProfit !== undefined) {
    pool.curveXcpProfit = snapshot.curveXcpProfit.toString();
  }
  if (snapshot.curveLpXcpProfit !== undefined) {
    pool.curveLpXcpProfit = snapshot.curveLpXcpProfit.toString();
  }
  if (snapshot.curveTotalSupply !== undefined) {
    pool.curveTotalSupply = snapshot.curveTotalSupply.toString();
  }
  if (snapshot.curveMathMode !== undefined) {
    pool.curveMathMode = snapshot.curveMathMode;
  }
}

function appendAmmSpecificTraceFields(snapshot: SnapshotForRustQuote, pool: RustPoolPayload): void {
  switch (snapshot.amm) {
    case "equilibra":
      appendEquilibraTraceFields(snapshot, pool);
      return;
    case "uniswapV2":
      appendUniswapTraceFields(snapshot, pool);
      return;
    case "curve":
      appendCurveTraceFields(snapshot, pool);
      return;
    default:
      throw new Error(`${snapshot.poolKey}: unsupported AMM in snapshot: ${snapshot.amm}`);
  }
}

function buildSingleSwapTraceInput(args: {
  snapshot: SnapshotForRustQuote;
  baseSymbol: "WETH" | "WBTC";
  tokenIn: string;
  amountIn: bigint;
  totalSupply: bigint;
  timestamp: number;
}): RustTraceInput {
  const { snapshot, baseSymbol, tokenIn, amountIn, totalSupply, timestamp } = args;
  const pool = buildBaseTracePool(snapshot, baseSymbol, totalSupply);
  appendAmmSpecificTraceFields(snapshot, pool);

  return {
    startTimestamp: timestamp,
    pool,
    steps: [
      {
        action: "swap",
        tokenIn,
        amountIn: amountIn.toString(),
        timestamp,
      },
    ],
  };
}

export async function quoteExactInputViaRustTrace(args: {
  snapshot: SnapshotForRustQuote;
  baseSymbol: "WETH" | "WBTC";
  tokenIn: string;
  amountIn: bigint;
  poolAddress: string;
  timestamp: number;
}): Promise<bigint> {
  const { snapshot, baseSymbol, tokenIn, amountIn, poolAddress, timestamp } = args;
  const lpToken = await ethers.getContractAt(ERC20_ABI, poolAddress);
  const totalSupply = BigInt(await lpToken.totalSupply());
  const traceInput = buildSingleSwapTraceInput({
    snapshot,
    baseSymbol,
    tokenIn,
    amountIn,
    totalSupply,
    timestamp,
  });

  const rust = runRustSimulatorTrace<RustTraceOutput>(traceInput);
  const amountOutRaw = rust.steps[0]?.amountOut;
  if (!amountOutRaw) {
    throw new Error(`${snapshot.poolKey}: rust trace output missing amountOut`);
  }
  return BigInt(amountOutRaw);
}

function buildSingleExactOutTraceInput(args: {
  snapshot: SnapshotForRustQuote;
  baseSymbol: "WETH" | "WBTC";
  tokenIn: string;
  amountOut: bigint;
  totalSupply: bigint;
  timestamp: number;
}): RustTraceInput {
  const { snapshot, baseSymbol, tokenIn, amountOut, totalSupply, timestamp } = args;
  const pool = buildBaseTracePool(snapshot, baseSymbol, totalSupply);
  appendAmmSpecificTraceFields(snapshot, pool);
  return {
    startTimestamp: timestamp,
    pool,
    steps: [
      {
        action: "swapExactOut",
        tokenIn,
        amountOut: amountOut.toString(),
        timestamp,
      },
    ],
  };
}

/**
 * Mirror of `quoteExactInputViaRustTrace` for the exact-output path.
 * Drives the Rust trace runner with a single `swapExactOut` step and
 * returns the raw `amountIn` the Rust kernel resolved (after the
 * dynamic-fee gross-up + safety bump that mirror
 * `EquilibraPool._executeExactOutWithDynamicFee`).
 */
export async function quoteExactOutputViaRustTrace(args: {
  snapshot: SnapshotForRustQuote;
  baseSymbol: "WETH" | "WBTC";
  tokenIn: string;
  amountOut: bigint;
  poolAddress: string;
  timestamp: number;
}): Promise<bigint> {
  const result = await execExactOutputViaRustTrace(args);
  return result.amountIn;
}

export type RustExactOutResult = {
  amountIn: bigint;
  step: RustTraceStepOut;
};

/// Same as `quoteExactOutputViaRustTrace` but returns the full
/// trace step (including `pre` / `post` snapshots) so callers can
/// compare the full post-state — not just the resolved `amount_in`.
export async function execExactOutputViaRustTrace(args: {
  snapshot: SnapshotForRustQuote;
  baseSymbol: "WETH" | "WBTC";
  tokenIn: string;
  amountOut: bigint;
  poolAddress: string;
  timestamp: number;
}): Promise<RustExactOutResult> {
  const { snapshot, baseSymbol, tokenIn, amountOut, poolAddress, timestamp } = args;
  const lpToken = await ethers.getContractAt(ERC20_ABI, poolAddress);
  const totalSupply = BigInt(await lpToken.totalSupply());
  const traceInput = buildSingleExactOutTraceInput({
    snapshot,
    baseSymbol,
    tokenIn,
    amountOut,
    totalSupply,
    timestamp,
  });

  const rust = runRustSimulatorTrace<RustTraceOutput>(traceInput);
  const step = rust.steps[0];
  const amountInRaw = step?.amountIn;
  if (!step || !amountInRaw) {
    throw new Error(`${snapshot.poolKey}: rust exact-out trace output missing amountIn`);
  }
  return { amountIn: BigInt(amountInRaw), step };
}
