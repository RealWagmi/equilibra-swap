/**
 * Test benchmark config sourced from the Rust simulator defaults.
 *
 * Single source of truth (do NOT add a parallel hard-coded preset list
 * in this file — the user has flagged that explicitly):
 * - `simulator/src/app/config.rs::build_default_config`
 *
 * The Rust `equilibra-offchain-config-defaults` binary serialises that
 * config to JSON on stdout; `loadRustBenchmarkDefaults` shells out to
 * it once per process and caches the parsed result. Every TypeScript
 * preset / price / gas-estimate consumed by the test suite or the
 * dashboard flows through this loader, so a change in `config.rs`
 * propagates everywhere on the next test run.
 */
import { loadRustBenchmarkDefaults, type RustCurvePreset, type RustEquilibraPreset } from "./rustTestUtils";

const RUST_DEFAULTS = loadRustBenchmarkDefaults();
const RUST_CONFIG = RUST_DEFAULTS.config;

export const LIQUIDITY = {
  passiveLpInitialUsd: RUST_CONFIG.liquidity.passiveLpInitialUsd,
};

export const TEST_PRICES = {
  WETH: BigInt(RUST_DEFAULTS.testPrices.WETH),
  WBTC: BigInt(RUST_DEFAULTS.testPrices.WBTC),
};

export interface EquilibraPoolParams {
  /** Depth-at-anchor knob `a` (WAD). Range `[A_MIN_WAD, A_MAX_WAD]`
   *  = `[1e17, 99e16]` on-chain (Constants.sol). */
  aWad: bigint;
  /** Plateau-width knob `λ` (WAD). Range `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`
   *  = `[1e15, 1e18]` on-chain. */
  lambdaWad: bigint;
  /** Smoothstep fee ceiling in BPS. Mirrors `PoolConfig.baseFee`. */
  feeBps: number;
  emaPeriod: number;
  repegStepWad: bigint;
  /**
   * Auto-repeg activation dead-band (WAD) applied while the EMA sits
   * ABOVE `priceScale` (token1 price rising in token0 terms). Mirrors
   * `PoolConfig.repegThresholdToken1UpWad`.
   */
  repegThresholdToken1UpWad: bigint;
  /**
   * Dead-band applied while the EMA sits BELOW `priceScale` (token1
   * price falling = the base asset rising under the mainnet
   * token0-base layout). Mirrors `PoolConfig.repegThresholdToken1DownWad`.
   */
  repegThresholdToken1DownWad: bigint;
  protocolFeePercent: number;
  rebalanceEnabled: boolean;
  /** Smoothstep warm-up width in BPS (0 disables the dynamic fee ramp). */
  feeRampBps: number;
  /** Lower bound of the dynamic fee ramp in BPS (defaults to 20 on-chain). */
  feeFloorBps: number;
  /** Share of the LP fee routed to the repeg budget in BPS (default 5_000 = 50%). */
  repegShareBps: number;
}

function mapEquilibraPreset(preset: RustEquilibraPreset): EquilibraPoolParams {
  return {
    aWad: BigInt(preset.aWad),
    lambdaWad: BigInt(preset.lambdaWad),
    feeBps: preset.feeBps,
    emaPeriod: preset.emaPeriod,
    repegStepWad: BigInt(preset.repegStepWad),
    repegThresholdToken1UpWad: BigInt(preset.repegThresholdToken1UpWad),
    repegThresholdToken1DownWad: BigInt(preset.repegThresholdToken1DownWad),
    protocolFeePercent: preset.protocolFeePercent,
    rebalanceEnabled: preset.rebalanceEnabled,
    feeRampBps: preset.feeRampBps,
    feeFloorBps: preset.feeFloorBps,
    repegShareBps: preset.repegShareBps,
  };
}

export const EQUILIBRA_PRESETS: Record<"WETH" | "WBTC", EquilibraPoolParams> = {
  WETH: mapEquilibraPreset(RUST_CONFIG.amms.equilibra.presets.WETH),
  WBTC: mapEquilibraPreset(RUST_CONFIG.amms.equilibra.presets.WBTC),
};

export const UNISWAP_V2 = {
  feeBps: RUST_CONFIG.amms.uniswapV2.feeBps,
  rebalanceEnabled: RUST_CONFIG.amms.uniswapV2.rebalanceEnabled,
};

export const GAS_USED_ESTIMATES = {
  equilibra: BigInt(RUST_CONFIG.actors.arbitrageur.gasUsedEstimates.equilibra),
  uniswapV2: BigInt(RUST_CONFIG.actors.arbitrageur.gasUsedEstimates.uniswapV2),
  curve: BigInt(RUST_CONFIG.actors.arbitrageur.gasUsedEstimates.curve),
};

export interface CurvePoolParams {
  A: number;
  gamma: bigint;
  midFee: bigint;
  outFee: bigint;
  feeGamma: bigint;
  adjustmentStepMin: bigint;
  adjustmentStepMax: bigint;
  reservedProfitFraction: bigint;
  maTime: number;
  donationAprBps: number;
  donationIntervalSec: number;
  rebalanceEnabled: boolean;
}

function mapCurvePreset(preset: RustCurvePreset): CurvePoolParams {
  return {
    A: preset.A,
    gamma: BigInt(preset.gamma),
    midFee: BigInt(preset.midFee),
    outFee: BigInt(preset.outFee),
    feeGamma: BigInt(preset.feeGamma),
    adjustmentStepMin: BigInt(preset.adjustmentStepMin),
    adjustmentStepMax: BigInt(preset.adjustmentStepMax),
    reservedProfitFraction: BigInt(preset.reservedProfitFraction),
    maTime: preset.maTime,
    donationAprBps: preset.donationAprBps,
    donationIntervalSec: preset.donationIntervalSec,
    rebalanceEnabled: preset.rebalanceEnabled,
  };
}

export const CURVE_PRESETS: Record<"WETH" | "WBTC", CurvePoolParams> = {
  WETH: mapCurvePreset(RUST_CONFIG.amms.curve.presets.WETH),
  WBTC: mapCurvePreset(RUST_CONFIG.amms.curve.presets.WBTC),
};

export const CURVE = {
  presets: CURVE_PRESETS,
  implementationId: 0n,
  mathMode: RUST_CONFIG.amms.curve.mathMode,
} as const;

export type LiquidityConfig = typeof LIQUIDITY;
export type UniswapV2Config = typeof UNISWAP_V2;
export type CurveConfig = typeof CURVE;
