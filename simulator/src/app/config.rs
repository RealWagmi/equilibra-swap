use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

// v11: the accepted config set gains the tightened floors
// `feeBps >= 5` and `emaPeriod >= 60 s` (mirrors
// `Constants.{MIN_BASE_FEE, MIN_EMA_PERIOD}`), so previously-valid
// dust-fee / fast-EMA presets are now rejected. Schema unchanged.
// v10: the Equilibra dynamic fee is resolved and applied as a WAD
// fraction (`1 bps == 1e14`) instead of integer bps — same schema,
// different trajectories for every ramp-enabled run — and the accepted
// config set gained the ramp monotonicity guard
// (`fee_ramp_guard_ok`), rejecting previously-valid narrow-ramp
// presets. v9 modelled the donation stream as per-event buy+park
// with the first tick at t = 0 and a one-year interval cap. v8 added
// the required donation-stream pair `donationAprBps` /
// `donationIntervalSec` (0/0 = disabled, the default). v7 added the
// required `baseTokenPosition`. Older versions are rejected — there is
// deliberately no migrator.
pub const BENCHMARK_RUN_CONFIG_VERSION: &str = "benchmark-run-config/v11";
/// Base assets the benchmark supports. Single source for preset-map
/// validation here AND for shard fan-out in the orchestrator — adding a
/// base in one place must add it everywhere.
pub const SUPPORTED_BASES: [&str; 2] = ["WETH", "WBTC"];

const PRECISION: u128 = 1_000_000_000_000_000_000u128; // 1e18 (WAD)

// ---------------------------------------------------------------------------
// On-chain bound mirrors — the single Rust-side source for every limit that
// `validate_run_config` enforces and that `GET /api/config/limits` publishes
// to the Setup UI. Each constant mirrors `contracts/libraries/Constants.sol`
// / `EquilibraFactory._validatePoolConfig`; when a bound changes on chain,
// change it here (and only here).
// ---------------------------------------------------------------------------

/// `baseFee` ∈ [5, 2000] bps. Mirrors `Constants.{MIN_BASE_FEE, MAX_BASE_FEE}`
/// enforced by `EquilibraFactory._validatePoolConfig`.
pub const MIN_BASE_FEE_BPS: u64 = 5;
pub const MAX_BASE_FEE_BPS: u64 = 2_000;
/// `feeRampBps` ∈ [0, 10000]. Mirrors `Constants.MAX_FEE_RAMP_BPS`.
pub const MIN_FEE_RAMP_BPS: u64 = 0;
pub const MAX_FEE_RAMP_BPS: u64 = 10_000;
/// `feeFloorBps` ∈ [0, MAX_BASE_FEE]; additionally capped by the live
/// `baseFee` (relational check in `validate_run_config`).
pub const MIN_FEE_FLOOR_BPS: u64 = 0;
pub const MAX_FEE_FLOOR_BPS: u64 = MAX_BASE_FEE_BPS;
/// Ramp monotonicity guard: a live ramp must satisfy `feeRampBps ·
/// (10000 − feeBps)² ≥ FEE_RAMP_GUARD_MULT · 10000 · (feeBps −
/// feeFloorBps)²`. Mirrors `Constants.FEE_RAMP_GUARD_MULT`; the check
/// itself is `runtime_quoter::equilibra::fee_ramp_guard_ok`.
pub const FEE_RAMP_GUARD_MULT: u128 = 12;
/// `repegShareBps` ∈ [0, BPS]. Mirrors `Constants.MAX_REPEG_SHARE_BPS`.
pub const MIN_REPEG_SHARE_BPS: u64 = 0;
pub const MAX_REPEG_SHARE_BPS: u64 = 10_000;
/// `protocolFeePercent` ∈ [0, 25] (percent, NOT bps). Mirrors
/// `Constants.MAX_PROTOCOL_FEE`.
pub const MIN_PROTOCOL_FEE_PERCENT: u64 = 0;
pub const MAX_PROTOCOL_FEE_PERCENT: u64 = 25;
/// `emaPeriod` half-life ∈ [60 s, 419731 s]. The floor mirrors
/// `Constants.MIN_EMA_PERIOD`; the ceiling bounds the STORED internal
/// tau = ceil(emaPeriod·1000/694) at `Constants.MAX_EMA_PERIOD`
/// (7 days), so the largest accepted half-life INPUT is the exact
/// floor inverse below.
pub const MIN_EMA_PERIOD_SEC: u64 = 60;
pub const MAX_EMA_PERIOD_SEC: u64 = 7 * 24 * 60 * 60; // 604_800
/// Largest accepted half-life input: `⌊MAX_EMA_PERIOD_SEC · 694 / 1000⌋`.
/// This — not the tau cap — is the user-facing input maximum the
/// dashboard limits must publish.
pub const MAX_EMA_HALF_LIFE_SEC: u64 = MAX_EMA_PERIOD_SEC * 694 / 1000; // 419_731
/// `aWad` ∈ [1e17, 99e16] (0.1·W .. 0.99·W). Mirrors
/// `Constants.A_MIN_WAD..A_MAX_WAD`.
pub const A_MIN_WAD: u128 = 100_000_000_000_000_000u128;
pub const A_MAX_WAD: u128 = 990_000_000_000_000_000u128;
/// `lambdaWad` ∈ [1e15, 1e18]. Mirrors
/// `Constants.LAMBDA_MIN_WAD..LAMBDA_MAX_WAD`.
pub const LAMBDA_MIN_WAD: u128 = 1_000_000_000_000_000u128;
pub const LAMBDA_MAX_WAD: u128 = 1_000_000_000_000_000_000u128;
/// `repegStepWad` ∈ [1, WAD]. Mirrors `Constants.{MIN,MAX}_REPEG_STEP`.
pub const REPEG_STEP_MIN_WAD: u128 = 1;
pub const REPEG_STEP_MAX_WAD: u128 = PRECISION;
/// Simulator-side scheduling limits (not on-chain, but published through
/// the same `/api/config/limits` contract).
pub const MIN_MAX_WORKERS: u64 = 1;
pub const MAX_MAX_WORKERS: u64 = 128;
pub const MIN_PROGRESS_INTERVAL_SEC: u64 = 1;
pub const MAX_PROGRESS_INTERVAL_SEC: u64 = 86_400;

const MAX_USD_INPUT: f64 = 1_000_000_000.0;
const MAX_GAS_PRICE_GWEI: f64 = 1_000_000.0;
const MAX_GAS_USED_ESTIMATE: u128 = 100_000_000;
const CURVE_MIN_A: u64 = 4_000;
const CURVE_MAX_A: u64 = 40_000_000;
const CURVE_MIN_GAMMA: u128 = 10_000_000_000;
const CURVE_MAX_GAMMA: u128 = 199_000_000_000_000_000;
const CURVE_MIN_FEE: u128 = 100_000;
const CURVE_FEE_PRECISION: u128 = 10_000_000_000;

/// Total USD the passive LP seeds into every benchmark pool. Split evenly
/// across the two sides by `build_initial_deposit_amounts` in the
/// simulator; the visualizer derives its synthetic pool depth from the
/// same constant via [`visualizer_pool_half_depth_usd`].
pub const PASSIVE_LP_INITIAL_USD: f64 = 1_000_000.0;

/// Per-side USD depth of the synthetic visualizer pool — exactly half of
/// [`PASSIVE_LP_INITIAL_USD`], matching how the benchmark splits the
/// passive-LP deposit across the two sides. Fails loudly if the constant
/// no longer splits into a whole positive USD amount per side (the
/// visualizer seeds integer token amounts).
pub fn visualizer_pool_half_depth_usd() -> Result<u128> {
    let half = PASSIVE_LP_INITIAL_USD / 2.0;
    if !half.is_finite() || half <= 0.0 || half.fract() != 0.0 || half >= u128::MAX as f64 {
        return Err(anyhow!(
            "PASSIVE_LP_INITIAL_USD ({PASSIVE_LP_INITIAL_USD}) does not split into a whole positive USD amount per side"
        ));
    }
    Ok(half as u128)
}

/// Canonical WAD-scaled display/test price for a supported base asset.
/// Consumed by the `equilibra-offchain-config-defaults` binary (which the
/// TypeScript fixtures shell out to) and by the visualizer's per-preset
/// fallback price — one definition, no silent zero for unknown bases.
pub fn reference_test_price_wad(base: &str) -> Result<u128> {
    match base {
        "WETH" => Ok(3_260u128 * PRECISION),
        "WBTC" => Ok(102_354u128 * PRECISION),
        _ => Err(anyhow!(
            "unsupported base `{base}` (allowed: {})",
            SUPPORTED_BASES.join(", ")
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SimulationEngine {
    Ts,
    Rust,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BenchmarkRunConfig {
    pub version: String,
    pub simulation_engine: SimulationEngine,
    pub simulation: SimulationCfg,
    pub liquidity: LiquidityCfg,
    pub actors: ActorsCfg,
    pub reporting: ReportingCfg,
    pub amms: AmmsCfg,
    pub parallel: ParallelCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulationCfg {
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub seed: u64,
    pub progress_interval_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityCfg {
    pub passive_lp_initial_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorsCfg {
    pub user: UserCfg,
    pub arbitrageur: ArbitrageurCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserCfg {
    pub min_trade_usd: f64,
    pub max_trade_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArbitrageurCfg {
    pub min_profit_usd: f64,
    pub min_profit_bps: f64,
    pub gas_price_gwei: f64,
    pub max_search_iterations: u64,
    pub probe_usd: f64,
    pub min_trade_usd: f64,
    pub gas_used_estimates: HashMap<String, String>,
    pub post_arb_external_swaps: PostArbExternalSwapsCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostArbExternalSwapsCfg {
    pub count: u64,
    pub share_bps: u64,
    pub min_amount_usd: f64,
    /// Multiplier against the constant-product baseline loss used by the
    /// noise-trader adaptive gate. After the first probe round-trip the
    /// simulator compares observed loss against `baseline * factor`; if the
    /// observation exceeds the threshold the remaining cycles are skipped.
    /// Default `1.5` mimics "user tried once, got burnt, walked away".
    pub abnormal_loss_factor: f64,
}

/// Report-only policies that must not be inferred from stateful actor
/// parameters. Keeping the diagnostic sweep explicit makes two runs with
/// the same materialized config produce directly comparable report samples.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportingCfg {
    pub slippage_sweep: SlippageSweepCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlippageSweepCfg {
    /// Smallest quote size, in BPS of the pool's initial one-side depth.
    pub min_initial_side_bps: u64,
    /// Largest quote size, in BPS of the pool's initial one-side depth.
    pub max_initial_side_bps: u64,
}

impl Default for PostArbExternalSwapsCfg {
    fn default() -> Self {
        Self {
            count: default_post_arb_external_swaps_count(),
            share_bps: default_post_arb_external_swaps_share_bps(),
            min_amount_usd: default_post_arb_external_swaps_min_amount_usd(),
            abnormal_loss_factor: default_post_arb_external_swaps_abnormal_loss_factor(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmmsCfg {
    pub equilibra: EquilibraAmmCfg,
    pub uniswap_v2: UniswapV2AmmCfg,
    pub curve: CurveAmmCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EquilibraAmmCfg {
    pub enabled: bool,
    pub presets: HashMap<String, EquilibraPresetCfg>,
}

/// Slot assignment for the base token of an Equilibra pool pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BaseTokenPosition {
    #[serde(rename = "token0")]
    Token0,
    #[serde(rename = "token1")]
    Token1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EquilibraPresetCfg {
    /// Which slot the BASE token of this pair occupies in the Equilibra
    /// pool. On mainnet the pair order is fixed by address sort, and
    /// both WETH (0xC02a…) and WBTC (0x2260…) sort BEFORE USDT
    /// (0xdAC1…), so the realistic layout is `token0` (the default):
    /// base in slot 0, USDT quote in slot 1, priceScale =
    /// base-per-quote. `token1` keeps the quote in slot 0. Equilibra
    /// only — the Curve baseline always models the quote as token0,
    /// matching its live reference pools.
    pub base_token_position: BaseTokenPosition,
    /// Depth-at-anchor knob `a` (WAD-scaled). At `D = 0` the
    /// amplification `A = a` — larger `aWad` deepens the central
    /// plateau. Decoupled from `lambdaWad`. Bounded by
    /// `Constants.A_MIN_WAD..A_MAX_WAD` (`1e17 .. 99e16`, i.e.
    /// `0.1·W .. 0.99·W`); `a == W` is forbidden because it makes
    /// the L-quadratic ill-conditioned.
    pub a_wad: String,
    /// Plateau-width knob `λ` (WAD-scaled). At `λ·D = W` the
    /// amplification halves (`A = a/2`). Larger `lambdaWad` narrows
    /// the plateau (faster transition to CP tail); smaller widens
    /// it. Bounded by `Constants.LAMBDA_MIN_WAD..LAMBDA_MAX_WAD`
    /// (`1e15 .. 1e18`).
    pub lambda_wad: String,
    /// Ceiling of the dynamic-fee smoothstep ramp in BPS. Mirrors
    /// `PoolConfig.baseFee` on-chain.
    pub fee_bps: u64,
    /// Price-EMA half-life in seconds. Mirrors `PoolConfig.emaPeriod`
    /// on-chain: the factory converts the half-life to the internal
    /// relaxation time `tau = ceil(emaPeriod * 1000 / 694)` at deploy,
    /// and the Rust quoter constructor applies the same conversion.
    pub ema_period: u64,
    pub repeg_step_wad: String,
    /// Auto-repeg activation dead-band for the UPWARD direction (WAD
    /// decimal string): applies while `ema > priceScale`, i.e. token1's
    /// price expressed in token0 sits ABOVE the anchor. Decoupled from
    /// the per-repeg cap. NOTE the layout mapping: with the mainnet
    /// base-in-slot-0 layout, a RISING base market is an internal
    /// token1-DOWN move — bull-market catch-up is tuned by the Down
    /// knob, not this one.
    pub repeg_threshold_token1_up_wad: String,
    /// Auto-repeg activation dead-band for the DOWNWARD direction (WAD
    /// decimal string): applies while `ema < priceScale` (token1's
    /// price in token0 below the anchor). See the layout note above.
    pub repeg_threshold_token1_down_wad: String,
    pub protocol_fee_percent: u64,
    pub rebalance_enabled: bool,
    /// Smoothstep ramp width in BPS (0 ⇒ disabled ⇒ flat `fee_bps`).
    /// Mirrors `PoolConfig.feeRampBps`. Required — must come from the
    /// canonical WETH / WBTC preset in `build_default_config`; no
    /// silent fallback.
    pub fee_ramp_bps: u64,
    /// Dynamic-fee floor in BPS. Mirrors `PoolConfig.feeFloorBps`.
    /// Required — must come from the canonical preset; missing field
    /// is a hard parse error.
    pub fee_floor_bps: u64,
    /// Fraction of cumulative LP unit-value growth the auto-repeg gate
    /// is allowed to spend on anchor moves, in BPS of `BPS = 10_000`.
    /// Mirrors `PoolConfig.repegShareBps`. The complementary share
    /// `BPS - repegShareBps` stays committed to LPs as part of the
    /// gate threshold. `0` disables auto-repeg entirely; `10_000`
    /// lets every accrued unit fund repegs. Required — must come
    /// from the canonical preset. Calibration: without a donation
    /// stream (or with a dust-scale one, as in the WBTC preset)
    /// prefer ~70%; with a donation stream of 3–4% of TVL per year
    /// prefer ~50–55%.
    pub repeg_share_bps: u64,
    /// Annual donation stream into the pool's donation-parachute
    /// buffer, in BPS of pool TVL per year (0 = disabled — the
    /// default). v9 semantics — per-event buy+park: at every stream
    /// tick (first tick at t = 0, then each `donationIntervalSec`,
    /// funding the exact elapsed gap since the previous tranche) the
    /// exogenous donor performs a fresh proportional deposit at the
    /// live active-share price and immediately parks the minted shares
    /// on the pool's own balance — mirroring the on-chain flow (mint,
    /// then a plain LP `transfer` to the pool address). There is no
    /// prepaid share pool acquired at simulation start (that was the
    /// v8 model).
    pub donation_apr_bps: u64,
    /// Seconds between consecutive donation transfers. Meaningful only
    /// while `donationAprBps > 0`; normalized to 0 otherwise so
    /// equivalent executions share a config hash.
    pub donation_interval_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UniswapV2AmmCfg {
    pub enabled: bool,
    pub fee_bps: u64,
    pub rebalance_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurveAmmCfg {
    pub enabled: bool,
    pub math_mode: String,
    pub presets: HashMap<String, CurvePresetCfg>,
}

/// Mirrors the live 2026-05 twocrypto deployment (0x3136…729a,
/// 0x3136…729a, 2026-05): `price_scale` moves by
/// `min(norm/5, adjustment_step_max)` at most once per block, gated by
/// the LP-protected profit floor (`lp_xcp_profit`), with
/// `adjustment_step_min` as the dust dead-band and
/// `reserved_profit_fraction` (FEE_PRECISION = 1e10 units) as the share
/// of profit growth locked into that floor. `donation_apr_bps` streams
/// quote-side donations into the pool's donation buffer (BPS of pool TVL
/// per year, one donation every `donation_interval_sec`); donation shares
/// unlock linearly over 7 days and are burned by the rebalance path to
/// pay for `price_scale` moves. `0` disables donations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurvePresetCfg {
    #[serde(rename = "A", alias = "a")]
    pub a: u64,
    pub gamma: String,
    pub mid_fee: String,
    pub out_fee: String,
    pub fee_gamma: String,
    pub adjustment_step_min: String,
    pub adjustment_step_max: String,
    pub reserved_profit_fraction: String,
    /// EMA half-life in seconds, matching the ON-CHAIN `ma_time()` view of
    /// the reference pools (which reports internal tau * 694/1000). The
    /// quoter converts back to the internal relaxation time tau via the
    /// exact integer inverse `ceil(maTime * 1000 / 694)`, so "600" here
    /// behaves identically to a live pool whose view shows 600.
    pub ma_time: u64,
    /// Annual donation stream as BPS of pool TVL (quote side only).
    pub donation_apr_bps: u64,
    /// Seconds between consecutive donation events.
    pub donation_interval_sec: u64,
    pub rebalance_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParallelCfg {
    pub max_workers: u64,
}

fn default_post_arb_external_swaps_count() -> u64 {
    3
}

fn default_post_arb_external_swaps_share_bps() -> u64 {
    2_500
}

fn default_post_arb_external_swaps_min_amount_usd() -> f64 {
    0.1
}

fn default_post_arb_external_swaps_abnormal_loss_factor() -> f64 {
    1.5
}

fn string_u256(v: u128) -> String {
    v.to_string()
}

fn parse_u128_decimal(value: &str, label: &str) -> Result<u128> {
    value
        .parse::<u128>()
        .map_err(|_| anyhow!("{label} must be a valid u128 decimal string"))
}

pub fn build_default_config(oracle_start_ts: u64, oracle_end_ts: u64) -> BenchmarkRunConfig {
    let mut gas_used_estimates = HashMap::<String, String>::new();
    gas_used_estimates.insert("equilibra".to_string(), string_u256(160_475));
    gas_used_estimates.insert("uniswapV2".to_string(), string_u256(80_543));
    gas_used_estimates.insert("curve".to_string(), string_u256(170_329));

    let mut eq_presets = HashMap::<String, EquilibraPresetCfg>::new();
    eq_presets.insert(
        "WETH".to_string(),
        EquilibraPresetCfg {
            // Two-knob cubic kernel
            // `K = A·L·(x+y)/2 + (W−A)·xy` with `A = a·W/(W+λ·D)`.
            // `aWad` sets the depth-at-anchor; `lambdaWad` sets the
            // plateau width (half-amplification distance). The two
            // knobs decouple — moving `a` shifts centre depth without
            // moving the cliff; moving `λ` shifts the cliff without
            // moving centre depth. Pick calibrated values via the
            // visualizer before deployment. The TypeScript side
            // (`simulator/test_helpers/config.ts`) has no hard-coded
            // copy of these values — it shells out to the
            // `equilibra-offchain-config-defaults` binary, so this
            // function is the single source the TS fixtures consume.
            // Calibrated to the reference-pool fee band (floor = its
            // mid_fee 1.36 %, ceiling = its out_fee 2.82 %) — the
            // configuration of the 2026-07 benchmark runs.
            base_token_position: BaseTokenPosition::Token0,
            a_wad: string_u256(909_610_000_000_000_030), // ≈0.9096 · W
            lambda_wad: string_u256(16_780_000_000_000_000), // 0.01678 · W
            fee_bps: 282,
            // Half-life (s); internal tau = 865. Calibrated under the
            // geometric (log-domain) EMA by the 2026-07 full-window
            // runs, where 600 outperforms 450 for WETH.
            ema_period: 600,
            repeg_step_wad: string_u256(5_000_000_000_000_000), // 5e15 = 0.5%/block cap
            // Asymmetric dead-bands (2026-07 calibration runs): token1
            // price falling in token0 terms = the base asset rising
            // under the mainnet token0-base layout, so the smaller
            // `down` band chases base-asset rallies eagerly while the
            // larger `up` band damps drawdown tracking.
            repeg_threshold_token1_up_wad: string_u256(2_500_000_000_000_000), // 0.25%
            repeg_threshold_token1_down_wad: string_u256(1_500_000_000_000_000), // 0.15%
            protocol_fee_percent: 0,
            rebalance_enabled: true,
            fee_ramp_bps: 5000,
            fee_floor_bps: 136,
            repeg_share_bps: 5_500, // 55/45 repeg-budget vs retained-growth split
            donation_apr_bps: 344,
            donation_interval_sec: 2_592_000,
        },
    );
    // Constant-product reference preset. Not inserted — kept here as the
    // known-good starting point for a pool meant to behave like a plain
    // `x·y = k` venue with a flat 0.30 % fee, since the two knobs reach
    // that shape at the edges of their range rather than through a
    // dedicated mode:
    //
    //     EquilibraPresetCfg {
    //         base_token_position: BaseTokenPosition::Token0,
    //         a_wad: string_u256(100_000_000_000_000_000),       // 0.1 · W = A_MIN_WAD
    //         lambda_wad: string_u256(1_000_000_000_000_000_000), // 1.0 · W = LAMBDA_MAX_WAD
    //         fee_bps: 30,                                       // flat 0.30 %
    //         fee_floor_bps: 30,                                 // == fee_bps: no ramp headroom
    //         fee_ramp_bps: 0,                                   // ramp off, so the equality is legal
    //         ema_period: 600,
    //         repeg_share_bps: 0,                                // auto-repeg off
    //         repeg_step_wad: string_u256(1),
    //         repeg_threshold_token1_up_wad: string_u256(1),
    //         repeg_threshold_token1_down_wad: string_u256(1),
    //         protocol_fee_percent: 0,
    //         rebalance_enabled: false,
    //         donation_apr_bps: 0,
    //         donation_interval_sec: 0,
    //     }
    //
    // Why these values: `a` at its floor with `λ` at its ceiling leaves the
    // narrowest plateau the factory accepts, so the kernel spends nearly
    // the whole range on its constant-product asymptote `K → W · x · y`.
    // Measured against `x·y = k` from a balanced pool, output runs +0.05 %
    // at a trade of 1 % of the reserve, +0.46 % at 10 % and +1.02 % at 50 %
    // — marginally deeper than plain CP throughout, never shallower,
    // because `a` bottoms out at `0.1 · W` rather than at zero. Relaxing
    // `λ` to `1e17` widens that gap (+2.16 % at a full-reserve trade), so
    // the ceiling is the right end of the range for this shape.
    // With `repeg_share_bps = 0` the anchor never moves, which is what
    // makes the shape stable — the step and both dead-bands are then inert
    // and sit at their minimum legal value rather than at a meaningful one.
    // `fee_floor_bps == fee_bps` is accepted only because the ramp is off;
    // pairing it with `fee_ramp_bps != 0` is rejected at deploy time
    // (`FeeRampNoHeadroom`). Every field is required — a partial preset is
    // a parse error, not a merge with the defaults.
    //
    // Pinned by `constant_product_hint_preset_validates`.
    eq_presets.insert(
        "WBTC".to_string(),
        EquilibraPresetCfg {
            // Floor matches the reference pool's mid_fee (1.46 %); the
            // ceiling is recalibrated above its out_fee (1.90 % vs
            // 1.70 %) with a slightly tighter ramp — the 2026-07
            // benchmark configuration. Curve knobs
            // match the WETH preset: the 2026-07 A/B run (seed 42)
            // showed +3.3 pp LP PnL and −134 bps average slippage for
            // WBTC on this curve versus the WBTC-specific fit.
            base_token_position: BaseTokenPosition::Token0,
            a_wad: string_u256(909_610_000_000_000_030), // ≈0.9096 · W
            lambda_wad: string_u256(16_780_000_000_000_000), // 0.01678 · W
            fee_bps: 190,
            ema_period: 600, // half-life (s); internal tau = 865
            repeg_step_wad: string_u256(5_000_000_000_000_000), // 5e15 = 0.5%/block cap, matches the live reference pool's adjustment_step_max
            // Asymmetric dead-bands (2026-07 calibration runs): token1
            // price falling in token0 terms = the base asset rising
            // under the mainnet token0-base layout, so the smaller
            // `down` band chases base-asset rallies eagerly while the
            // larger `up` band damps drawdown tracking.
            repeg_threshold_token1_up_wad: string_u256(2_500_000_000_000_000), // 0.25%
            repeg_threshold_token1_down_wad: string_u256(1_500_000_000_000_000), // 0.15%
            protocol_fee_percent: 0,
            rebalance_enabled: true,
            fee_ramp_bps: 4000,
            fee_floor_bps: 146,
            repeg_share_bps: 7_000, // 70/30 repeg-budget vs LP split (mirrors the live reference pool's 30.1% reserved fraction)
            donation_apr_bps: 41,
            donation_interval_sec: 2_592_000,
        },
    );

    let mut curve_presets = HashMap::<String, CurvePresetCfg>::new();
    // Live reference twocrypto pool parameters (0x6563…b9f3, read 2026-07).
    curve_presets.insert(
        "WETH".to_string(),
        CurvePresetCfg {
            a: 50_000,
            gamma: string_u256(11_111_111_111),
            mid_fee: string_u256(136_000_000),
            out_fee: string_u256(282_000_000),
            fee_gamma: string_u256(4_961_947_600_000_000),
            adjustment_step_min: string_u256(100_000_000), // 1e-10: no dead-band
            adjustment_step_max: string_u256(5_000_000_000_000_000), // 0.5%/block cap
            reserved_profit_fraction: string_u256(4_500_000_000), // 45% to LP floor
            ma_time: 600,
            donation_apr_bps: 344, // live 30d-average donation inflow, % of pool TVL
            donation_interval_sec: 1_800,
            rebalance_enabled: true,
        },
    );
    // Live reference twocrypto pool parameters (0x3136…729a, read 2026-07).
    curve_presets.insert(
        "WBTC".to_string(),
        CurvePresetCfg {
            a: 50_000,
            gamma: string_u256(11_111_111_111),
            mid_fee: string_u256(146_000_000),
            out_fee: string_u256(170_000_000),
            fee_gamma: string_u256(54_202_748_000_000_000),
            adjustment_step_min: string_u256(100_000_000), // 1e-10: no dead-band
            adjustment_step_max: string_u256(5_000_000_000_000_000), // 0.5%/block cap
            reserved_profit_fraction: string_u256(3_010_101_009), // ~30.1% to LP floor
            ma_time: 600,
            donation_apr_bps: 41, // live 30d-average donation inflow, % of pool TVL
            donation_interval_sec: 1_800,
            rebalance_enabled: true,
        },
    );

    BenchmarkRunConfig {
        version: BENCHMARK_RUN_CONFIG_VERSION.to_string(),
        simulation_engine: SimulationEngine::Rust,
        simulation: SimulationCfg {
            start_timestamp: oracle_start_ts,
            end_timestamp: oracle_end_ts,
            seed: 42,
            progress_interval_sec: 86_400,
        },
        liquidity: LiquidityCfg {
            passive_lp_initial_usd: PASSIVE_LP_INITIAL_USD,
        },
        actors: ActorsCfg {
            user: UserCfg {
                min_trade_usd: 100.0,
                max_trade_usd: 50_000.0,
            },
            arbitrageur: ArbitrageurCfg {
                min_profit_usd: 1.0,
                min_profit_bps: 5.0,
                gas_price_gwei: 0.05,
                // Cap on golden-section refinements (arb-golden-search/v2:
                // the tolerance break is the real stop, this is only the
                // ceiling). 1000 makes the ceiling inert by construction:
                // golden-section over a u128 bracket shrinks the interval
                // below any tolerance within ~185 refinements, so every
                // search exits on the 1% interval-convergence criterion and
                // never on the iteration cap.
                max_search_iterations: 1000,
                probe_usd: 100.0,
                min_trade_usd: 50.0,
                gas_used_estimates,
                post_arb_external_swaps: PostArbExternalSwapsCfg::default(),
            },
        },
        reporting: ReportingCfg {
            slippage_sweep: SlippageSweepCfg {
                min_initial_side_bps: 1,
                max_initial_side_bps: 3_000,
            },
        },
        amms: AmmsCfg {
            equilibra: EquilibraAmmCfg {
                enabled: true,
                presets: eq_presets,
            },
            uniswap_v2: UniswapV2AmmCfg {
                enabled: true,
                fee_bps: 30,
                rebalance_enabled: true,
            },
            curve: CurveAmmCfg {
                enabled: true,
                // The live reference pools inject StableswapMath into the twocrypto
                // shell (gamma is stored but unused by the invariant); the
                // crypto kernel stays available for research configs.
                math_mode: "stableswap".to_string(),
                presets: curve_presets,
            },
        },
        parallel: ParallelCfg { max_workers: 6 },
    }
}

pub fn validate_run_config(value: &Value) -> Result<BenchmarkRunConfig> {
    let mut cfg: BenchmarkRunConfig = serde_json::from_value(value.clone())
        .map_err(|e| anyhow!("Invalid run config JSON: {e}"))?;
    if cfg.version != BENCHMARK_RUN_CONFIG_VERSION {
        return Err(anyhow!(
            "Invalid version: expected {}",
            BENCHMARK_RUN_CONFIG_VERSION
        ));
    }
    if cfg.simulation_engine != SimulationEngine::Rust {
        return Err(anyhow!(
            "Only Rust simulation engine is supported in simulator app"
        ));
    }
    if cfg.simulation.end_timestamp <= cfg.simulation.start_timestamp {
        return Err(anyhow!(
            "simulation.endTimestamp must be greater than simulation.startTimestamp"
        ));
    }
    if !(MIN_PROGRESS_INTERVAL_SEC..=MAX_PROGRESS_INTERVAL_SEC)
        .contains(&cfg.simulation.progress_interval_sec)
    {
        return Err(anyhow!(
            "simulation.progressIntervalSec must be in [{MIN_PROGRESS_INTERVAL_SEC},{MAX_PROGRESS_INTERVAL_SEC}]"
        ));
    }
    if !(100.0..=100_000_000.0).contains(&cfg.liquidity.passive_lp_initial_usd) {
        return Err(anyhow!(
            "liquidity.passiveLpInitialUsd must be in [100,100000000]"
        ));
    }
    if cfg.actors.user.max_trade_usd < cfg.actors.user.min_trade_usd {
        return Err(anyhow!(
            "actors.user.maxTradeUsd must be >= actors.user.minTradeUsd"
        ));
    }
    // Numeric sanity: every value that reaches a size / cost / profit
    // computation must be finite and in a sane range, so a negative or
    // NaN input can never silently corrupt a run (e.g. a negative gas
    // price reaching the arbitrage profit calculation as negative cost).
    for (label, v) in [
        ("actors.user.minTradeUsd", cfg.actors.user.min_trade_usd),
        ("actors.user.maxTradeUsd", cfg.actors.user.max_trade_usd),
        (
            "actors.arbitrageur.minTradeUsd",
            cfg.actors.arbitrageur.min_trade_usd,
        ),
        (
            "actors.arbitrageur.minProfitUsd",
            cfg.actors.arbitrageur.min_profit_usd,
        ),
        (
            "actors.arbitrageur.minProfitBps",
            cfg.actors.arbitrageur.min_profit_bps,
        ),
        (
            "actors.arbitrageur.gasPriceGwei",
            cfg.actors.arbitrageur.gas_price_gwei,
        ),
        (
            "actors.arbitrageur.probeUsd",
            cfg.actors.arbitrageur.probe_usd,
        ),
    ] {
        if !v.is_finite() || v < 0.0 {
            return Err(anyhow!("{label} must be a finite, non-negative number"));
        }
    }
    for (label, v, max) in [
        (
            "actors.user.minTradeUsd",
            cfg.actors.user.min_trade_usd,
            MAX_USD_INPUT,
        ),
        (
            "actors.user.maxTradeUsd",
            cfg.actors.user.max_trade_usd,
            MAX_USD_INPUT,
        ),
        (
            "actors.arbitrageur.minTradeUsd",
            cfg.actors.arbitrageur.min_trade_usd,
            MAX_USD_INPUT,
        ),
        (
            "actors.arbitrageur.minProfitUsd",
            cfg.actors.arbitrageur.min_profit_usd,
            MAX_USD_INPUT,
        ),
        (
            "actors.arbitrageur.probeUsd",
            cfg.actors.arbitrageur.probe_usd,
            MAX_USD_INPUT,
        ),
        (
            "actors.arbitrageur.minProfitBps",
            cfg.actors.arbitrageur.min_profit_bps,
            10_000.0,
        ),
        (
            "actors.arbitrageur.gasPriceGwei",
            cfg.actors.arbitrageur.gas_price_gwei,
            MAX_GAS_PRICE_GWEI,
        ),
    ] {
        if v > max {
            return Err(anyhow!("{label} must be <= {max}"));
        }
    }
    if cfg.actors.arbitrageur.probe_usd == 0.0 {
        return Err(anyhow!(
            "actors.arbitrageur.probeUsd must be greater than zero"
        ));
    }
    // Sanity bound only (typo guard): golden-section over a u128 bracket
    // converges within ~185 refinements, so any cap above that is already
    // "exit by tolerance only".
    if !(1..=10_000).contains(&cfg.actors.arbitrageur.max_search_iterations) {
        return Err(anyhow!(
            "actors.arbitrageur.maxSearchIterations must be in [1,10000]"
        ));
    }
    let sweep = &cfg.reporting.slippage_sweep;
    if sweep.min_initial_side_bps < 1
        || sweep.min_initial_side_bps >= sweep.max_initial_side_bps
        || sweep.max_initial_side_bps > 10_000
    {
        return Err(anyhow!(
            "reporting.slippageSweep must satisfy 1 <= minInitialSideBps < maxInitialSideBps <= 10000"
        ));
    }
    if cfg.actors.arbitrageur.post_arb_external_swaps.count > 1_000 {
        return Err(anyhow!(
            "actors.arbitrageur.postArbExternalSwaps.count must be in [0,1000]"
        ));
    }
    if cfg.actors.arbitrageur.post_arb_external_swaps.share_bps > 10_000 {
        return Err(anyhow!(
            "actors.arbitrageur.postArbExternalSwaps.shareBps must be in [0,10000]"
        ));
    }
    if !(0.0..=1_000_000_000.0).contains(
        &cfg.actors
            .arbitrageur
            .post_arb_external_swaps
            .min_amount_usd,
    ) {
        return Err(anyhow!(
            "actors.arbitrageur.postArbExternalSwaps.minAmountUsd must be in [0,1000000000]"
        ));
    }
    if !(0.5..=100.0).contains(
        &cfg.actors
            .arbitrageur
            .post_arb_external_swaps
            .abnormal_loss_factor,
    ) {
        return Err(anyhow!(
            "actors.arbitrageur.postArbExternalSwaps.abnormalLossFactor must be in [0.5,100.0]"
        ));
    }
    if !(MIN_MAX_WORKERS..=MAX_MAX_WORKERS).contains(&cfg.parallel.max_workers) {
        return Err(anyhow!(
            "parallel.maxWorkers must be in [{MIN_MAX_WORKERS},{MAX_MAX_WORKERS}]"
        ));
    }
    if cfg.amms.uniswap_v2.fee_bps >= 10_000 {
        return Err(anyhow!("amms.uniswapV2.feeBps must be in [0,9999]"));
    }
    const GAS_KEYS: [&str; 3] = ["equilibra", "uniswapV2", "curve"];
    for key in cfg.actors.arbitrageur.gas_used_estimates.keys() {
        if !GAS_KEYS.contains(&key.as_str()) {
            return Err(anyhow!(
                "actors.arbitrageur.gasUsedEstimates contains unsupported key `{key}`"
            ));
        }
    }
    for key in GAS_KEYS {
        let raw = cfg
            .actors
            .arbitrageur
            .gas_used_estimates
            .get(key)
            .ok_or_else(|| {
                anyhow!("actors.arbitrageur.gasUsedEstimates is missing required key `{key}`")
            })?;
        let gas = parse_u128_decimal(raw, &format!("actors.arbitrageur.gasUsedEstimates.{key}"))?;
        if gas == 0 || gas > MAX_GAS_USED_ESTIMATE {
            return Err(anyhow!(
                "actors.arbitrageur.gasUsedEstimates.{key} must be in [1,{MAX_GAS_USED_ESTIMATE}]"
            ));
        }
    }
    let enabled_count = u8::from(cfg.amms.equilibra.enabled)
        + u8::from(cfg.amms.uniswap_v2.enabled)
        + u8::from(cfg.amms.curve.enabled);
    if enabled_count == 0 {
        return Err(anyhow!("At least one AMM must be enabled"));
    }
    validate_preset_map(
        &cfg.amms.equilibra.presets,
        "amms.equilibra.presets",
        &SUPPORTED_BASES,
    )?;
    validate_preset_map(
        &cfg.amms.curve.presets,
        "amms.curve.presets",
        &SUPPORTED_BASES,
    )?;
    if !matches!(cfg.amms.curve.math_mode.as_str(), "stableswap" | "crypto") {
        return Err(anyhow!(
            "amms.curve.mathMode must be either `stableswap` or `crypto`"
        ));
    }
    for base in SUPPORTED_BASES {
        let curve = cfg
            .amms
            .curve
            .presets
            .get_mut(base)
            .ok_or_else(|| anyhow!("amms.curve.presets is missing required key `{}`", base))?;
        if !(CURVE_MIN_A..=CURVE_MAX_A).contains(&curve.a) {
            return Err(anyhow!(
                "amms.curve.presets.{base}.A must be in [{CURVE_MIN_A},{CURVE_MAX_A}]"
            ));
        }
        let gamma = parse_u128_decimal(&curve.gamma, &format!("amms.curve.presets.{base}.gamma"))?;
        if !(CURVE_MIN_GAMMA..=CURVE_MAX_GAMMA).contains(&gamma) {
            return Err(anyhow!(
                "amms.curve.presets.{base}.gamma must be in [{CURVE_MIN_GAMMA},{CURVE_MAX_GAMMA}]"
            ));
        }
        let mid_fee =
            parse_u128_decimal(&curve.mid_fee, &format!("amms.curve.presets.{base}.midFee"))?;
        let out_fee =
            parse_u128_decimal(&curve.out_fee, &format!("amms.curve.presets.{base}.outFee"))?;
        if !(CURVE_MIN_FEE..=CURVE_FEE_PRECISION).contains(&mid_fee)
            || !(CURVE_MIN_FEE..=CURVE_FEE_PRECISION).contains(&out_fee)
            || mid_fee > out_fee
        {
            return Err(anyhow!(
                "amms.curve.presets.{base} fees must satisfy {CURVE_MIN_FEE} <= midFee <= outFee <= {CURVE_FEE_PRECISION}"
            ));
        }
        let fee_gamma = parse_u128_decimal(
            &curve.fee_gamma,
            &format!("amms.curve.presets.{base}.feeGamma"),
        )?;
        if fee_gamma > PRECISION {
            return Err(anyhow!(
                "amms.curve.presets.{base}.feeGamma must be <= 1e18"
            ));
        }
        if !(1..=MAX_EMA_PERIOD_SEC).contains(&curve.ma_time) {
            return Err(anyhow!(
                "amms.curve.presets.{base}.maTime must be in [1,{MAX_EMA_PERIOD_SEC}]"
            ));
        }
        let step_min = parse_u128_decimal(
            &curve.adjustment_step_min,
            &format!("amms.curve.presets.{base}.adjustmentStepMin"),
        )?;
        let step_max = parse_u128_decimal(
            &curve.adjustment_step_max,
            &format!("amms.curve.presets.{base}.adjustmentStepMax"),
        )?;
        if step_min >= step_max || step_max > 1_000_000_000_000_000_000u128 {
            return Err(anyhow!(
                "amms.curve.presets.{}.adjustmentStep pair must satisfy min < max <= 1e18",
                base
            ));
        }
        let reserved = parse_u128_decimal(
            &curve.reserved_profit_fraction,
            &format!("amms.curve.presets.{base}.reservedProfitFraction"),
        )?;
        if reserved > CURVE_FEE_PRECISION {
            return Err(anyhow!(
                "amms.curve.presets.{}.reservedProfitFraction must be <= 1e10 (FEE_PRECISION)",
                base
            ));
        }
        if curve.donation_apr_bps > 10_000 {
            return Err(anyhow!(
                "amms.curve.presets.{}.donationAprBps must be <= 10000 (100% of TVL per year)",
                base
            ));
        }
        if curve.donation_apr_bps == 0 {
            // The interval has no runtime meaning while donations are off;
            // normalize it so equivalent executions have the same hash.
            curve.donation_interval_sec = 0;
        } else if !(60..=31_536_000).contains(&curve.donation_interval_sec) {
            return Err(anyhow!(
                "amms.curve.presets.{}.donationIntervalSec must be within [60, 31536000] (one minute .. one year) when donations are enabled",
                base
            ));
        }
    }
    for base in SUPPORTED_BASES {
        let preset =
            cfg.amms.equilibra.presets.get(base).ok_or_else(|| {
                anyhow!("amms.equilibra.presets is missing required key `{}`", base)
            })?;
        let repeg_step_wad = preset.repeg_step_wad.parse::<u128>().map_err(|_| {
            anyhow!(
                "amms.equilibra.presets.{}.repegStepWad must be a valid u128 decimal string",
                base
            )
        })?;
        if !(REPEG_STEP_MIN_WAD..=REPEG_STEP_MAX_WAD).contains(&repeg_step_wad) {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.repegStepWad must be in [1, 1e18]",
                base
            ));
        }
        let repeg_threshold_up_wad =
            preset
                .repeg_threshold_token1_up_wad
                .parse::<u128>()
                .map_err(|_| {
                    anyhow!(
                        "amms.equilibra.presets.{}.repegThresholdToken1UpWad must be a valid u128 decimal string",
                        base
                    )
                })?;
        let repeg_threshold_down_wad =
            preset
                .repeg_threshold_token1_down_wad
                .parse::<u128>()
                .map_err(|_| {
                    anyhow!(
                        "amms.equilibra.presets.{}.repegThresholdToken1DownWad must be a valid u128 decimal string",
                        base
                    )
                })?;
        for (label, value) in [
            ("repegThresholdToken1UpWad", repeg_threshold_up_wad),
            ("repegThresholdToken1DownWad", repeg_threshold_down_wad),
        ] {
            if !(REPEG_STEP_MIN_WAD..=REPEG_STEP_MAX_WAD).contains(&value) {
                return Err(anyhow!(
                    "amms.equilibra.presets.{}.{} must be in [1, 1e18]",
                    base,
                    label
                ));
            }
        }
        // Two-knob bounds mirror `Constants.{A_MIN_WAD..A_MAX_WAD,
        // LAMBDA_MIN_WAD..LAMBDA_MAX_WAD}` on-chain. The kernel uses
        // `A = a·W / (W + λ·D)` — `aWad` ∈ [1e17, 99e16] (0.1·W .. 0.99·W),
        // `lambdaWad` ∈ [1e15, 1e18].
        let a_wad = preset.a_wad.parse::<u128>().map_err(|_| {
            anyhow!(
                "amms.equilibra.presets.{}.aWad must be a valid u128 decimal string",
                base
            )
        })?;
        if !(A_MIN_WAD..=A_MAX_WAD).contains(&a_wad) {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.aWad must be in [1e17, 99e16] (0.1·W .. 0.99·W)",
                base
            ));
        }
        let lambda_wad = preset.lambda_wad.parse::<u128>().map_err(|_| {
            anyhow!(
                "amms.equilibra.presets.{}.lambdaWad must be a valid u128 decimal string",
                base
            )
        })?;
        if !(LAMBDA_MIN_WAD..=LAMBDA_MAX_WAD).contains(&lambda_wad) {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.lambdaWad must be in [1e15, 1e18]",
                base
            ));
        }
        // Dynamic-fee bounds mirror `EquilibraFactory._validatePoolConfig`:
        //   feeBps ∈ [MIN_BASE_FEE, MAX_BASE_FEE]
        //   feeRampBps ∈ [0, MAX_FEE_RAMP_BPS]
        //   feeFloorBps ≤ feeBps (ceiling)
        //   feeRampBps != 0 ⇒ feeBps > feeFloorBps (strict headroom)
        //   repegShareBps ∈ [0, MAX_REPEG_SHARE_BPS]
        //   emaPeriod ∈ [MIN_EMA_PERIOD, MAX_EMA_PERIOD]
        if !(MIN_BASE_FEE_BPS..=MAX_BASE_FEE_BPS).contains(&preset.fee_bps) {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.feeBps ({}) must be in [{MIN_BASE_FEE_BPS}, {MAX_BASE_FEE_BPS}] (Constants.{{MIN_BASE_FEE, MAX_BASE_FEE}})",
                base,
                preset.fee_bps
            ));
        }
        // `emaPeriod` is the half-life; the factory bounds the input from
        // below and the converted internal relaxation time `tau =
        // ceil(emaPeriod * 1000 / 694)` from above (Constants.MIN /
        // MAX_EMA_PERIOD). Mirror both checks bit-for-bit.
        let ema_tau = preset.ema_period.saturating_mul(1000).div_ceil(694);
        if preset.ema_period < MIN_EMA_PERIOD_SEC || ema_tau > MAX_EMA_PERIOD_SEC {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.emaPeriod ({}) must be a half-life >= {MIN_EMA_PERIOD_SEC} s whose internal tau = ceil(emaPeriod*1000/694) stays <= {MAX_EMA_PERIOD_SEC} s (max valid input 419731)",
                base,
                preset.ema_period
            ));
        }
        if preset.fee_ramp_bps > MAX_FEE_RAMP_BPS {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.feeRampBps must be in [0, {MAX_FEE_RAMP_BPS}]",
                base
            ));
        }
        if preset.fee_floor_bps > preset.fee_bps {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.feeFloorBps ({}) must be <= feeBps ({})",
                base,
                preset.fee_floor_bps,
                preset.fee_bps
            ));
        }
        // Smoothstep ramp requires strict headroom: `baseFee > feeFloorBps`
        // whenever `feeRampBps != 0`. Mirrors {EquilibraFactory.FeeRampNoHeadroom};
        // a config the contract would refuse must not survive setup here either.
        if preset.fee_ramp_bps != 0 && preset.fee_bps == preset.fee_floor_bps {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.feeRampBps ({}) requires feeBps ({}) > feeFloorBps ({}); the smoothstep ramp has no headroom to interpolate",
                base,
                preset.fee_ramp_bps,
                preset.fee_bps,
                preset.fee_floor_bps
            ));
        }
        // Mirrors `EquilibraFactory.FeeRampTooNarrow` (monotonicity
        // guard, shared helper with the runtime quoter): a live ramp
        // must satisfy `feeRampBps · (10000 − feeBps)² ≥
        // FEE_RAMP_GUARD_MULT · 10000 · (feeBps − feeFloorBps)²`,
        // otherwise the terminal rate climbs faster than the gross
        // input grows and a larger exact-in trade returns less output.
        if !crate::runtime_quoter::equilibra::fee_ramp_guard_ok(
            preset.fee_bps as u128,
            preset.fee_floor_bps as u128,
            preset.fee_ramp_bps as u128,
        ) {
            let span = (preset.fee_bps - preset.fee_floor_bps) as u128;
            let inv = 10_000u128 - preset.fee_bps as u128;
            return Err(anyhow!(
                "amms.equilibra.presets.{}.feeRampBps ({}) is too narrow for the fee span \
                 ({} bps at ceiling {} bps): the minimum monotone ramp is \
                 ceil({FEE_RAMP_GUARD_MULT} · 10000 · span² / (10000 − feeBps)²) = {}",
                base,
                preset.fee_ramp_bps,
                span,
                preset.fee_bps,
                (FEE_RAMP_GUARD_MULT * 10_000 * span * span).div_ceil(inv * inv)
            ));
        }
        if preset.repeg_share_bps > MAX_REPEG_SHARE_BPS {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.repegShareBps ({}) must be in [0, {MAX_REPEG_SHARE_BPS}]",
                base,
                preset.repeg_share_bps
            ));
        }
        // Mirrors `Constants.MAX_PROTOCOL_FEE = 25`.
        if preset.protocol_fee_percent > MAX_PROTOCOL_FEE_PERCENT {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.protocolFeePercent ({}) must be in [0, {MAX_PROTOCOL_FEE_PERCENT}]",
                base,
                preset.protocol_fee_percent
            ));
        }
        // Mirrors `EquilibraFactory.RepegShareExceedsBudget`.
        if preset.repeg_share_bps + preset.protocol_fee_percent * 100 > 10_000 {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.repegShareBps ({}) + protocolFeePercent ({}) × 100 must not exceed 10000",
                base,
                preset.repeg_share_bps,
                preset.protocol_fee_percent
            ));
        }
        // Mirrors `EquilibraFactory.RepegThresholdExceedsFeeScale` (stall
        // guard): with auto-repeg live, the activation threshold must
        // stay at or below the fee scale — the floor when the smoothstep
        // ramp is live, the flat base fee otherwise (1 bps == 1e14
        // WAD). A threshold above the fee scale yields a pool whose
        // repeg can never afford its first permitted move from its own
        // flow. Skipped when `repegShareBps == 0` (threshold is inert).
        if preset.repeg_share_bps != 0 {
            let fee_scale_bps = if preset.fee_ramp_bps == 0 {
                preset.fee_bps
            } else {
                preset.fee_floor_bps
            };
            let threshold_cap_wad = (fee_scale_bps as u128) * 100_000_000_000_000u128; // bps → WAD
            for (label, value) in [
                ("repegThresholdToken1UpWad", repeg_threshold_up_wad),
                ("repegThresholdToken1DownWad", repeg_threshold_down_wad),
            ] {
                if value > threshold_cap_wad {
                    return Err(anyhow!(
                        "amms.equilibra.presets.{}.{} ({}) exceeds the fee scale \
                         ({} bps → cap {}): a threshold above the fee scale can never fund its \
                         first repeg — lower the threshold, raise the fee, or disable \
                         auto-repeg (repegShareBps = 0)",
                        base,
                        label,
                        value,
                        fee_scale_bps,
                        threshold_cap_wad
                    ));
                }
            }
        }
        if preset.donation_apr_bps > 10_000 {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.donationAprBps must be <= 10000 (100% of TVL per year)",
                base
            ));
        }
        if preset.donation_apr_bps != 0
            && !(60..=31_536_000).contains(&preset.donation_interval_sec)
        {
            return Err(anyhow!(
                "amms.equilibra.presets.{}.donationIntervalSec must be within [60, 31536000] (one minute .. one year) when donations are enabled",
                base
            ));
        }
    }
    // Normalize the inert interval (donations off) so equivalent
    // executions share a config hash — mirrors the Curve preset pass.
    for base in SUPPORTED_BASES {
        if let Some(preset) = cfg.amms.equilibra.presets.get_mut(base) {
            if preset.donation_apr_bps == 0 {
                preset.donation_interval_sec = 0;
            }
        }
    }
    validate_global_rebalance_policy(&cfg)?;
    Ok(cfg)
}

fn validate_preset_map<T>(
    presets: &HashMap<String, T>,
    path: &str,
    required_bases: &[&str],
) -> Result<()> {
    for key in presets.keys() {
        if !required_bases.contains(&key.as_str()) {
            return Err(anyhow!(
                "{} contains unsupported key `{}` (allowed: {})",
                path,
                key,
                required_bases.join(", ")
            ));
        }
    }
    for base in required_bases {
        if !presets.contains_key(*base) {
            return Err(anyhow!("{} is missing required key `{}`", path, base));
        }
    }
    Ok(())
}

fn validate_global_rebalance_policy(cfg: &BenchmarkRunConfig) -> Result<()> {
    let expected = cfg.amms.uniswap_v2.rebalance_enabled;
    for base in SUPPORTED_BASES {
        let eq =
            cfg.amms.equilibra.presets.get(base).ok_or_else(|| {
                anyhow!("amms.equilibra.presets is missing required key `{}`", base)
            })?;
        let curve = cfg
            .amms
            .curve
            .presets
            .get(base)
            .ok_or_else(|| anyhow!("amms.curve.presets is missing required key `{}`", base))?;
        if eq.rebalance_enabled != expected || curve.rebalance_enabled != expected {
            return Err(anyhow!(
                "rebalanceEnabled is a global run policy: amms.uniswapV2 and every Equilibra/Curve preset must use the same value"
            ));
        }
    }
    Ok(())
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.iter().map(canonicalize_json).collect()),
        Value::Object(obj) => {
            let mut ordered = Map::<String, Value>::new();
            let mut keys: Vec<String> = obj.keys().cloned().collect();
            keys.sort();
            for key in keys {
                if let Some(v) = obj.get(&key) {
                    ordered.insert(key, canonicalize_json(v));
                }
            }
            Value::Object(ordered)
        }
        _ => value.clone(),
    }
}

pub fn canonical_json_string(cfg: &BenchmarkRunConfig) -> Result<String> {
    let value = serde_json::to_value(cfg)?;
    let canonical = canonicalize_json(&value);
    Ok(serde_json::to_string(&canonical)?)
}

pub fn compute_config_hash(cfg: &BenchmarkRunConfig) -> Result<String> {
    let canonical = canonical_json_string(cfg)?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(format!("{byte:02x}").as_str());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config_value() -> Value {
        serde_json::to_value(build_default_config(1, 2)).expect("serialize default config")
    }

    fn remove_required_field(mut value: Value, pointer: &str, field: &str) -> Value {
        value
            .pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("test pointer must resolve to an object: {pointer}"))
            .remove(field)
            .unwrap_or_else(|| panic!("test field must exist: {pointer}/{field}"));
        value
    }

    #[test]
    fn canonical_defaults_pass_validation() {
        let value = default_config_value();
        validate_run_config(&value).expect("canonical defaults must validate");
    }

    #[test]
    fn v6_rejects_every_missing_post_arb_field_instead_of_defaulting() {
        let parent = "/actors/arbitrageur/postArbExternalSwaps";
        for field in ["count", "shareBps", "minAmountUsd", "abnormalLossFactor"] {
            let value = remove_required_field(default_config_value(), parent, field);
            let err =
                validate_run_config(&value).expect_err("v6 must reject a missing post-arb field");
            assert!(
                err.to_string().contains(field),
                "missing {field} produced an unrelated error: {err}"
            );
        }

        let value = remove_required_field(
            default_config_value(),
            "/actors/arbitrageur",
            "postArbExternalSwaps",
        );
        let err = validate_run_config(&value).expect_err("v6 must require the post-arb block");
        assert!(err.to_string().contains("postArbExternalSwaps"));
    }

    #[test]
    fn v6_rejects_missing_reporting_policy_and_invalid_sweep_bounds() {
        let value = remove_required_field(default_config_value(), "", "reporting");
        let err = validate_run_config(&value).expect_err("v6 must require reporting policy");
        assert!(err.to_string().contains("reporting"));

        let value = remove_required_field(default_config_value(), "/reporting", "slippageSweep");
        let err = validate_run_config(&value).expect_err("v6 must require slippage sweep");
        assert!(err.to_string().contains("slippageSweep"));

        for (min, max) in [(0, 3_000), (1, 1), (5_000, 4_999), (1, 10_001)] {
            let mut value = default_config_value();
            value["reporting"]["slippageSweep"]["minInitialSideBps"] = Value::from(min);
            value["reporting"]["slippageSweep"]["maxInitialSideBps"] = Value::from(max);
            let err = validate_run_config(&value).expect_err("invalid sweep bounds must fail");
            assert!(err.to_string().contains("reporting.slippageSweep"));
        }

        let mut boundary = default_config_value();
        boundary["reporting"]["slippageSweep"]["minInitialSideBps"] = Value::from(1);
        boundary["reporting"]["slippageSweep"]["maxInitialSideBps"] = Value::from(10_000);
        validate_run_config(&boundary).expect("inclusive sweep boundaries must validate");
    }

    #[test]
    fn v6_requires_all_rebalance_flags_and_rejects_mixed_policy() {
        let required = [
            ("/amms/uniswapV2", "rebalanceEnabled"),
            ("/amms/equilibra/presets/WETH", "rebalanceEnabled"),
            ("/amms/equilibra/presets/WBTC", "rebalanceEnabled"),
            ("/amms/curve/presets/WETH", "rebalanceEnabled"),
            ("/amms/curve/presets/WBTC", "rebalanceEnabled"),
        ];
        for (parent, field) in required {
            let value = remove_required_field(default_config_value(), parent, field);
            let err = validate_run_config(&value)
                .expect_err("v6 must reject a missing rebalance policy flag");
            assert!(
                err.to_string().contains("rebalanceEnabled"),
                "missing {parent}/{field} produced an unrelated error: {err}"
            );
        }

        let mut mixed = default_config_value();
        mixed["amms"]["equilibra"]["presets"]["WETH"]["rebalanceEnabled"] = Value::from(false);
        let err = validate_run_config(&mixed).expect_err("mixed global policy must fail");
        assert!(err.to_string().contains("global run policy"));

        let mut all_disabled = default_config_value();
        all_disabled["amms"]["uniswapV2"]["rebalanceEnabled"] = Value::from(false);
        for amm in ["equilibra", "curve"] {
            for base in SUPPORTED_BASES {
                all_disabled["amms"][amm]["presets"][base]["rebalanceEnabled"] = Value::from(false);
            }
        }
        let cfg = validate_run_config(&all_disabled).expect("uniform false policy must validate");
        assert!(!cfg.amms.uniswap_v2.rebalance_enabled);
        assert!(cfg
            .amms
            .equilibra
            .presets
            .values()
            .all(|preset| !preset.rebalance_enabled));
        assert!(cfg
            .amms
            .curve
            .presets
            .values()
            .all(|preset| !preset.rebalance_enabled));
    }

    #[test]
    fn v5_is_rejected_instead_of_silently_migrated() {
        let mut value = default_config_value();
        value["version"] = Value::from("benchmark-run-config/v5");
        let err = validate_run_config(&value).expect_err("v5 requires an explicit migration");
        assert!(err.to_string().contains(BENCHMARK_RUN_CONFIG_VERSION));
    }

    #[test]
    fn base_fee_bounds_are_enforced() {
        for (bad, expect_fragment) in [(0u64, "feeBps"), (4u64, "feeBps"), (2_001u64, "feeBps")] {
            let mut value = default_config_value();
            value["amms"]["equilibra"]["presets"]["WETH"]["feeBps"] = Value::from(bad);
            // Keep floor <= ceiling so we exercise the range check, not the
            // relational one.
            value["amms"]["equilibra"]["presets"]["WETH"]["feeFloorBps"] = Value::from(0u64);
            let err = validate_run_config(&value).expect_err("out-of-range feeBps must fail");
            assert!(
                err.to_string().contains(expect_fragment),
                "unexpected error for feeBps={bad}: {err}"
            );
        }
        // Boundary values mirror the on-chain [MIN_BASE_FEE, MAX_BASE_FEE]
        // envelope.
        // `repegShareBps = 0` keeps the stall guard out of the way: a zero
        // floor with a live ramp and auto-repeg enabled is rejected by the
        // guard (cap = 0), which is not what this test exercises. Flat-fee
        // mode (`feeRampBps = 0`) likewise keeps the ramp monotonicity
        // guard inert — a max-span live ramp needs a far wider warm-up
        // than the preset ships.
        for good in [MIN_BASE_FEE_BPS, MAX_BASE_FEE_BPS] {
            let mut value = default_config_value();
            value["amms"]["equilibra"]["presets"]["WETH"]["feeBps"] = Value::from(good);
            value["amms"]["equilibra"]["presets"]["WETH"]["feeFloorBps"] = Value::from(0u64);
            value["amms"]["equilibra"]["presets"]["WETH"]["feeRampBps"] = Value::from(0u64);
            value["amms"]["equilibra"]["presets"]["WETH"]["repegShareBps"] = Value::from(0u64);
            validate_run_config(&value)
                .unwrap_or_else(|e| panic!("feeBps={good} must validate: {e}"));
        }
    }

    #[test]
    fn repeg_stall_guard_mirrors_factory() {
        // Live ramp: cap = feeFloorBps · 1e14. WETH preset floor =
        // 136 bps → cap 1.36e16; a threshold just above must fail, the
        // boundary must pass. The step cap itself is NOT stall-guarded.
        // Each direction-split threshold is guarded independently.
        for key in ["repegThresholdToken1UpWad", "repegThresholdToken1DownWad"] {
            let mut value = default_config_value();
            value["amms"]["equilibra"]["presets"]["WETH"][key] = Value::from("13600000000000001");
            let err = validate_run_config(&value).expect_err("threshold above floor cap must fail");
            assert!(err.to_string().contains(key), "unexpected error: {err}");

            let mut value = default_config_value();
            value["amms"]["equilibra"]["presets"]["WETH"][key] = Value::from("13600000000000000"); // == cap, inclusive
            validate_run_config(&value).expect("boundary threshold must validate");
        }

        // The per-repeg step cap is free of the fee-scale guard: only
        // the [1, 1e18] range applies.
        let mut value = default_config_value();
        value["amms"]["equilibra"]["presets"]["WETH"]["repegStepWad"] =
            Value::from("500000000000000000");
        validate_run_config(&value).expect("large step cap must validate");

        // Flat fee (ramp = 0): cap = baseFee · 1e14. WBTC forced flat
        // (ramp 0, ceiling 190 bps) → cap 1.9e16.
        let mut value = default_config_value();
        value["amms"]["equilibra"]["presets"]["WBTC"]["feeRampBps"] = Value::from(0u64);
        value["amms"]["equilibra"]["presets"]["WBTC"]["repegThresholdToken1UpWad"] =
            Value::from("19000000000000001");
        let err = validate_run_config(&value).expect_err("threshold above flat cap must fail");
        assert!(
            err.to_string().contains("repegThresholdToken1UpWad"),
            "unexpected error: {err}"
        );

        // Auto-repeg disabled: the threshold is inert, any in-bounds
        // value passes.
        let mut value = default_config_value();
        value["amms"]["equilibra"]["presets"]["WETH"]["repegShareBps"] = Value::from(0u64);
        value["amms"]["equilibra"]["presets"]["WETH"]["repegThresholdToken1UpWad"] =
            Value::from("500000000000000000");
        value["amms"]["equilibra"]["presets"]["WETH"]["repegThresholdToken1DownWad"] =
            Value::from("500000000000000000");
        validate_run_config(&value).expect("share=0 must skip the stall guard");
    }

    #[test]
    fn ema_period_bounds_are_enforced() {
        // 419_731 is the largest half-life whose internal tau =
        // ceil(h*1000/694) still fits Constants.MAX_EMA_PERIOD (604800).
        for bad in [0u64, MIN_EMA_PERIOD_SEC - 1, 419_732, MAX_EMA_PERIOD_SEC] {
            let mut value = default_config_value();
            value["amms"]["equilibra"]["presets"]["WBTC"]["emaPeriod"] = Value::from(bad);
            let err = validate_run_config(&value).expect_err("out-of-range emaPeriod must fail");
            assert!(
                err.to_string().contains("emaPeriod"),
                "unexpected error for emaPeriod={bad}: {err}"
            );
        }
        for good in [MIN_EMA_PERIOD_SEC, 419_731] {
            let mut value = default_config_value();
            value["amms"]["equilibra"]["presets"]["WBTC"]["emaPeriod"] = Value::from(good);
            validate_run_config(&value)
                .unwrap_or_else(|e| panic!("emaPeriod={good} must validate: {e}"));
        }
    }

    #[test]
    fn reference_test_price_rejects_unknown_base() {
        assert_eq!(
            reference_test_price_wad("WETH").expect("WETH price"),
            3_260u128 * PRECISION
        );
        assert_eq!(
            reference_test_price_wad("WBTC").expect("WBTC price"),
            102_354u128 * PRECISION
        );
        assert!(reference_test_price_wad("DOGE").is_err());
    }

    #[test]
    fn visualizer_half_depth_matches_passive_lp_split() {
        let half = visualizer_pool_half_depth_usd().expect("half depth");
        assert_eq!(half as f64 * 2.0, PASSIVE_LP_INITIAL_USD);
    }

    #[test]
    fn default_config_round_trips_through_validation() {
        let cfg = build_default_config(1_600_000_000, 1_700_000_000);
        let value = serde_json::to_value(&cfg).expect("serialize");
        // The canonical config must survive strict validation, including
        // `deny_unknown_fields`.
        validate_run_config(&value).expect("default config must validate");
    }

    #[test]
    fn validation_rejects_unknown_field() {
        let cfg = build_default_config(1_600_000_000, 1_700_000_000);
        let mut value = serde_json::to_value(&cfg).expect("serialize");
        value["thisFieldDoesNotExist"] = serde_json::json!(1);
        assert!(
            validate_run_config(&value).is_err(),
            "unknown top-level field must be rejected"
        );
    }

    #[test]
    fn validation_rejects_unknown_nested_and_removed_fields() {
        for path in ["simulation", "liquidity", "parallel"] {
            let mut value = default_config_value();
            value[path]["unexpected"] = serde_json::json!(1);
            assert!(
                validate_run_config(&value).is_err(),
                "unknown nested field under {path} must be rejected"
            );
        }

        for (parent, removed) in [
            ("equilibra", "slippageToleranceBps"),
            ("curve", "adminFeePercent"),
            ("curve", "implementationId"),
        ] {
            let mut value = default_config_value();
            value["amms"][parent][removed] = serde_json::json!(1);
            assert!(
                validate_run_config(&value).is_err(),
                "removed no-op field amms.{parent}.{removed} must be rejected"
            );
        }

        let mut value = default_config_value();
        value["actors"]["arbitrageur"]["safetyBps"] = serde_json::json!(2);
        assert!(validate_run_config(&value).is_err());

        let mut value = default_config_value();
        value["checkpoint"] = serde_json::json!({
            "intervalSec": 86_400,
            "basePath": "./ignored"
        });
        assert!(validate_run_config(&value).is_err());
    }

    #[test]
    fn validation_rejects_invalid_gas_map_and_curve_parameters() {
        let mut value = default_config_value();
        value["actors"]["arbitrageur"]["gasUsedEstimates"]
            .as_object_mut()
            .expect("gas map")
            .remove("curve");
        assert!(validate_run_config(&value).is_err());

        let mut value = default_config_value();
        value["actors"]["arbitrageur"]["gasUsedEstimates"]["curve"] = serde_json::json!("0");
        assert!(validate_run_config(&value).is_err());

        let mut value = default_config_value();
        value["amms"]["curve"]["mathMode"] = serde_json::json!("typo");
        assert!(validate_run_config(&value).is_err());

        let mut value = default_config_value();
        value["amms"]["curve"]["presets"]["WETH"]["midFee"] = serde_json::json!("9999999999");
        value["amms"]["curve"]["presets"]["WETH"]["outFee"] = serde_json::json!("100000");
        assert!(validate_run_config(&value).is_err());

        let mut value = default_config_value();
        value["amms"]["curve"]["presets"]["WBTC"]["gamma"] = serde_json::json!("1");
        assert!(validate_run_config(&value).is_err());
    }

    #[test]
    fn disabled_donation_interval_is_canonicalized() {
        let mut value = default_config_value();
        value["amms"]["curve"]["presets"]["WETH"]["donationAprBps"] = serde_json::json!(0);
        value["amms"]["curve"]["presets"]["WETH"]["donationIntervalSec"] = serde_json::json!(12345);
        let cfg = validate_run_config(&value).expect("disabled donations must validate");
        assert_eq!(cfg.amms.curve.presets["WETH"].donation_interval_sec, 0);
    }

    #[test]
    fn validation_rejects_negative_gas_price() {
        let cfg = build_default_config(1_600_000_000, 1_700_000_000);
        let mut value = serde_json::to_value(&cfg).expect("serialize");
        value["actors"]["arbitrageur"]["gasPriceGwei"] = serde_json::json!(-1.0);
        assert!(
            validate_run_config(&value).is_err(),
            "negative gas price must be rejected before it reaches profit math"
        );
    }

    #[test]
    fn validation_rejects_out_of_range_search_iterations() {
        let cfg = build_default_config(1_600_000_000, 1_700_000_000);
        let mut value = serde_json::to_value(&cfg).expect("serialize");
        value["actors"]["arbitrageur"]["maxSearchIterations"] = serde_json::json!(0);
        assert!(validate_run_config(&value).is_err(), "0 iterations invalid");
        let mut value2 = serde_json::to_value(&cfg).expect("serialize");
        value2["actors"]["arbitrageur"]["maxSearchIterations"] = serde_json::json!(10_001);
        assert!(
            validate_run_config(&value2).is_err(),
            ">50 iterations invalid"
        );
    }

    /// The commented constant-product preset above the WBTC insert is a
    /// deployable configuration, not an illustration: every value sits
    /// inside the factory's bounds and the combination passes the same
    /// validator a dashboard run goes through. Keeps the hint from rotting
    /// if a bound moves.
    #[test]
    fn constant_product_hint_preset_validates() {
        let mut value = default_config_value();
        for base in ["WETH", "WBTC"] {
            let preset = &mut value["amms"]["equilibra"]["presets"][base];
            preset["aWad"] = serde_json::json!("100000000000000000");
            preset["lambdaWad"] = serde_json::json!("1000000000000000000");
            preset["feeBps"] = serde_json::json!(30);
            preset["feeFloorBps"] = serde_json::json!(30);
            preset["feeRampBps"] = serde_json::json!(0);
            preset["emaPeriod"] = serde_json::json!(600);
            preset["repegShareBps"] = serde_json::json!(0);
            preset["repegStepWad"] = serde_json::json!("1");
            preset["repegThresholdToken1UpWad"] = serde_json::json!("1");
            preset["repegThresholdToken1DownWad"] = serde_json::json!("1");
            preset["protocolFeePercent"] = serde_json::json!(0);
            preset["rebalanceEnabled"] = serde_json::json!(false);
            preset["donationAprBps"] = serde_json::json!(0);
            preset["donationIntervalSec"] = serde_json::json!(0);
        }
        // The five legacy-shaped rebalance flags are one global policy and
        // validation requires them to agree.
        value["amms"]["uniswapV2"]["rebalanceEnabled"] = serde_json::json!(false);
        value["amms"]["curve"]["presets"]["WETH"]["rebalanceEnabled"] = serde_json::json!(false);
        value["amms"]["curve"]["presets"]["WBTC"]["rebalanceEnabled"] = serde_json::json!(false);

        let cfg = validate_run_config(&value)
            .expect("the documented constant-product preset must validate");
        let weth = &cfg.amms.equilibra.presets["WETH"];
        assert_eq!(weth.a_wad, "100000000000000000");
        assert_eq!(weth.lambda_wad, "1000000000000000000");
        assert_eq!(weth.fee_bps, 30);
        assert_eq!(weth.repeg_share_bps, 0);
    }
}
