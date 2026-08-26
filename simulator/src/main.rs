#![allow(non_snake_case)]

use anyhow::{anyhow, Context, Result};
use chrono::Datelike;
use clap::Parser;
use equilibra_offchain_simulator::app::config as app_config;
use equilibra_offchain_simulator::app::provenance::{
    binary_digest, execution_manifest_path, hash_report_assets_dir, load_execution_provenance,
    oracle_snapshot_from_bytes, parent_dir_or_current, persist_json_durable,
    resolve_effective_window, verify_binary_artifact, EffectiveExecutionOptions,
    ExecutionProvenance, ExecutionProvenanceMaterial, OracleSnapshot, EXECUTION_PROVENANCE_VERSION,
    REPORT_ALGORITHM_VERSION,
};
use equilibra_offchain_simulator::common::{
    self as common, build_slippage_bucket_edges_bps, RecenterGateBasePeriods, RecenterGateCounts,
    RecenterGateStatsExport, SlippageSample, SlippageSweepPolicy, TradeSizeBuckets,
    ACTOR_ALGORITHM_VERSION, RESULT_FORMAT_VERSION, SLIPPAGE_HISTOGRAM_BUCKET_COUNT,
    SLIPPAGE_SWEEP_POLICY_VERSION,
};
use equilibra_offchain_simulator::runtime_quoter::curve;
use equilibra_offchain_simulator::runtime_quoter::curve::CurveQuoteConfig;
use equilibra_offchain_simulator::runtime_quoter::equilibra;
use equilibra_offchain_simulator::runtime_quoter::equilibra_math;
use equilibra_offchain_simulator::runtime_quoter::uniswap_v2;
use equilibra_offchain_simulator::runtime_quoter::EquilibraStatefulConfig;
use equilibra_offchain_simulator::runtime_quoter::LocalQuoter;
// num_traits no longer needed after BigUint->U256 migration
use primitive_types::{U256, U512};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const PRECISION: u128 = 1_000_000_000_000_000_000u128;
const BPS_DENOM: u128 = 10_000u128;
const BENCHMARK_EVENT_PREFIX: &str = "[BENCHMARK_EVENT]";
const UNISWAP_MINIMUM_LIQUIDITY: u128 = 1_000u128;
const SLIPPAGE_MIN_BPS: i64 = -5000;
const SLIPPAGE_MAX_BPS: i64 = 5000;
const SLIPPAGE_BPS_PER_BUCKET: i64 =
    (SLIPPAGE_MAX_BPS - SLIPPAGE_MIN_BPS) / SLIPPAGE_HISTOGRAM_BUCKET_COUNT as i64;
const MAX_SLIPPAGE_SAMPLES: usize = 1000usize;

fn default_oracle_data_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("data")
}

#[derive(Parser, Debug)]
#[command(name = "equilibra-offchain-simulator")]
#[command(about = "Pure offchain benchmark simulator core (Rust)")]
struct Cli {
    /// Path to benchmark run config (runs/<runId>/params.json)
    #[arg(long)]
    config: PathBuf,

    /// Output file path for sim_results.json
    #[arg(long, default_value = "checkpoints/sim_results.json")]
    output: PathBuf,

    /// Oracle data directory (contains eth-usd.json and btc-usd.json)
    #[arg(long, default_value_os_t = default_oracle_data_dir())]
    data_dir: PathBuf,

    /// Disable Curve contexts
    #[arg(long, default_value_t = false)]
    no_curve: bool,

    /// Optional AMM filter (comma-separated): equilibra,uniswapV2,curve
    #[arg(long, value_delimiter = ',', num_args = 1..)]
    only_amms: Vec<String>,

    /// Optional base filter (comma-separated): WETH,WBTC
    #[arg(long, value_delimiter = ',', num_args = 1..)]
    only_bases: Vec<String>,

    /// Config hash of the parent (pre-shard) run config. This option is
    /// accepted only together with `--execution-manifest`; the manifest
    /// cryptographically binds that parent to every partition config,
    /// immutable oracle bytes, effective options and executable hashes. A
    /// bare caller-supplied origin label is rejected.
    #[arg(long)]
    origin_config_hash: Option<String>,

    /// Signed-by-content execution material produced by the dashboard
    /// orchestrator. It binds every shard to one parent config, immutable
    /// oracle snapshot, executable set and effective option set. Manual
    /// standalone runs omit it and materialize their own fingerprint.
    #[arg(long)]
    execution_manifest: Option<PathBuf>,

    /// Optional simulation duration override in seconds
    #[arg(long)]
    duration_sec: Option<u64>,

    /// Disable Equilibra automatic recentering in runtime simulation
    #[arg(long, default_value_t = false)]
    disable_equilibra_recenter: bool,

    /// Disable Curve price_scale rebalancing (tweak_price adjustment)
    #[arg(long, default_value_t = false)]
    disable_curve_rebalance: bool,

    /// Deterministic trace input (single-pool stateful replay mode)
    #[arg(long)]
    trace_input: Option<PathBuf>,

    /// Output for deterministic trace mode
    #[arg(long)]
    trace_output: Option<PathBuf>,

    /// Disable recentering in deterministic trace mode
    #[arg(long, default_value_t = false)]
    trace_disable_recenter: bool,
}

#[derive(Debug, Deserialize)]
struct RunConfig {
    simulation: SimulationCfg,
    liquidity: LiquidityCfg,
    actors: ActorsCfg,
    reporting: ReportingCfg,
    amms: AmmsCfg,
}

#[derive(Debug, Deserialize)]
struct SimulationCfg {
    startTimestamp: u64,
    endTimestamp: u64,
    seed: u64,
    // No serde default: the runtime config is built exclusively from the
    // validated `BenchmarkRunConfig` (see `runtime_run_config_from_app`),
    // where `progressIntervalSec` is a required, bounds-checked field.
    // The old `default = 2` here silently diverged from the canonical
    // default in `app/config.rs` (86_400) and could never legitimately
    // fire — a strict missing-field error is the correct behaviour.
    progressIntervalSec: u64,
}

#[derive(Debug, Deserialize)]
struct LiquidityCfg {
    passiveLpInitialUsd: f64,
}

#[derive(Debug, Deserialize)]
struct ActorsCfg {
    user: UserCfg,
    arbitrageur: ArbitrageurCfg,
}

#[derive(Debug, Deserialize)]
struct UserCfg {
    minTradeUsd: f64,
    maxTradeUsd: f64,
}

#[derive(Debug, Deserialize)]
struct ReportingCfg {
    slippageSweep: SlippageSweepCfg,
}

#[derive(Debug, Deserialize)]
struct SlippageSweepCfg {
    minInitialSideBps: u64,
    maxInitialSideBps: u64,
}

#[derive(Debug, Deserialize)]
struct ArbitrageurCfg {
    minProfitUsd: f64,
    minProfitBps: f64,
    gasPriceGwei: f64,
    maxSearchIterations: usize,
    probeUsd: f64,
    minTradeUsd: f64,
    gasUsedEstimates: HashMap<String, String>,
    postArbExternalSwaps: PostArbExternalSwapsCfg,
}

#[derive(Debug, Deserialize, Clone, Copy)]
struct PostArbExternalSwapsCfg {
    count: u64,
    shareBps: u64,
    minAmountUsd: f64,
    /// Adaptive gate multiplier vs. constant-product baseline loss.
    /// After the first probe round-trip the remaining cycles are skipped if
    /// observed loss exceeds `baseline * abnormalLossFactor`.
    abnormalLossFactor: f64,
}

#[derive(Debug, Deserialize)]
struct AmmsCfg {
    equilibra: EqAmmCfg,
    uniswapV2: UniAmmCfg,
    curve: CurveAmmCfg,
}

#[derive(Debug, Deserialize)]
struct EqAmmCfg {
    enabled: bool,
    presets: HashMap<String, EqPreset>,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
struct EqPreset {
    /// Slot of this pair's BASE token ("token0" = mainnet address-sort
    /// layout, base first; "token1" = quote first). The Curve baseline
    /// always keeps the quote in slot 0.
    baseTokenPosition: app_config::BaseTokenPosition,
    aWad: String,
    lambdaWad: String,
    feeBps: u64,
    emaPeriod: u64,
    repegStepWad: String,
    repegThresholdToken1UpWad: String,
    repegThresholdToken1DownWad: String,
    protocolFeePercent: u64,
    rebalanceEnabled: bool,
    /// Smoothstep ramp width in BPS (0 ⇒ disabled). Mirrors
    /// `PoolConfig.feeRampBps` on-chain. Required — must come from
    /// the canonical WETH / WBTC preset; no silent fallback.
    feeRampBps: u64,
    /// Lower bound of the dynamic fee ramp in BPS. Mirrors
    /// `PoolConfig.feeFloorBps`. Required — must come from the
    /// canonical preset.
    feeFloorBps: u64,
    /// Fraction of cumulative LP unit-value growth (`lpValueGrowthWad`)
    /// the auto-repeg gate is allowed to spend on anchor moves, in BPS
    /// of `BPS = 10_000`. Mirrors `PoolConfig.repegShareBps`.
    /// Required — must come from the canonical preset.
    repegShareBps: u64,
    /// Annual donation stream into the donation-parachute buffer, BPS
    /// of pool TVL per year (0 = disabled). Required in v8 configs.
    donationAprBps: u64,
    /// Seconds between consecutive donation transfers (0 while the
    /// stream is disabled).
    donationIntervalSec: u64,
}

#[derive(Debug, Deserialize)]
struct UniAmmCfg {
    enabled: bool,
    feeBps: u64,
    rebalanceEnabled: bool,
}

#[derive(Debug, Deserialize)]
struct CurveAmmCfg {
    enabled: bool,
    mathMode: String,
    presets: HashMap<String, CurvePreset>,
}

#[derive(Debug, Deserialize)]
struct CurvePreset {
    A: u64,
    gamma: String,
    midFee: String,
    outFee: String,
    feeGamma: String,
    adjustmentStepMin: String,
    adjustmentStepMax: String,
    reservedProfitFraction: String,
    maTime: u64,
    donationAprBps: u64,
    donationIntervalSec: u64,
    rebalanceEnabled: bool,
}

fn runtime_run_config_from_app(cfg: app_config::BenchmarkRunConfig) -> Result<RunConfig> {
    let max_search_iterations = usize::try_from(cfg.actors.arbitrageur.max_search_iterations)
        .map_err(|_| anyhow!("actors.arbitrageur.maxSearchIterations is too large for usize"))?;

    let eq_presets = cfg
        .amms
        .equilibra
        .presets
        .into_iter()
        .map(|(base, preset)| {
            (
                base,
                EqPreset {
                    baseTokenPosition: preset.base_token_position,
                    aWad: preset.a_wad,
                    lambdaWad: preset.lambda_wad,
                    feeBps: preset.fee_bps,
                    emaPeriod: preset.ema_period,
                    repegStepWad: preset.repeg_step_wad,
                    repegThresholdToken1UpWad: preset.repeg_threshold_token1_up_wad,
                    repegThresholdToken1DownWad: preset.repeg_threshold_token1_down_wad,
                    protocolFeePercent: preset.protocol_fee_percent,
                    rebalanceEnabled: preset.rebalance_enabled,
                    feeRampBps: preset.fee_ramp_bps,
                    feeFloorBps: preset.fee_floor_bps,
                    repegShareBps: preset.repeg_share_bps,
                    donationAprBps: preset.donation_apr_bps,
                    donationIntervalSec: preset.donation_interval_sec,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    let curve_presets = cfg
        .amms
        .curve
        .presets
        .into_iter()
        .map(|(base, preset)| {
            (
                base,
                CurvePreset {
                    A: preset.a,
                    gamma: preset.gamma,
                    midFee: preset.mid_fee,
                    outFee: preset.out_fee,
                    feeGamma: preset.fee_gamma,
                    adjustmentStepMin: preset.adjustment_step_min,
                    adjustmentStepMax: preset.adjustment_step_max,
                    reservedProfitFraction: preset.reserved_profit_fraction,
                    maTime: preset.ma_time,
                    donationAprBps: preset.donation_apr_bps,
                    donationIntervalSec: preset.donation_interval_sec,
                    rebalanceEnabled: preset.rebalance_enabled,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    Ok(RunConfig {
        simulation: SimulationCfg {
            startTimestamp: cfg.simulation.start_timestamp,
            endTimestamp: cfg.simulation.end_timestamp,
            seed: cfg.simulation.seed,
            progressIntervalSec: cfg.simulation.progress_interval_sec,
        },
        liquidity: LiquidityCfg {
            passiveLpInitialUsd: cfg.liquidity.passive_lp_initial_usd,
        },
        actors: ActorsCfg {
            user: UserCfg {
                minTradeUsd: cfg.actors.user.min_trade_usd,
                maxTradeUsd: cfg.actors.user.max_trade_usd,
            },
            arbitrageur: ArbitrageurCfg {
                minProfitUsd: cfg.actors.arbitrageur.min_profit_usd,
                minProfitBps: cfg.actors.arbitrageur.min_profit_bps,
                gasPriceGwei: cfg.actors.arbitrageur.gas_price_gwei,
                maxSearchIterations: max_search_iterations,
                probeUsd: cfg.actors.arbitrageur.probe_usd,
                minTradeUsd: cfg.actors.arbitrageur.min_trade_usd,
                gasUsedEstimates: cfg.actors.arbitrageur.gas_used_estimates,
                postArbExternalSwaps: PostArbExternalSwapsCfg {
                    count: cfg.actors.arbitrageur.post_arb_external_swaps.count,
                    shareBps: cfg.actors.arbitrageur.post_arb_external_swaps.share_bps,
                    minAmountUsd: cfg
                        .actors
                        .arbitrageur
                        .post_arb_external_swaps
                        .min_amount_usd,
                    abnormalLossFactor: cfg
                        .actors
                        .arbitrageur
                        .post_arb_external_swaps
                        .abnormal_loss_factor,
                },
            },
        },
        reporting: ReportingCfg {
            slippageSweep: SlippageSweepCfg {
                minInitialSideBps: cfg.reporting.slippage_sweep.min_initial_side_bps,
                maxInitialSideBps: cfg.reporting.slippage_sweep.max_initial_side_bps,
            },
        },
        amms: AmmsCfg {
            equilibra: EqAmmCfg {
                enabled: cfg.amms.equilibra.enabled,
                presets: eq_presets,
            },
            uniswapV2: UniAmmCfg {
                enabled: cfg.amms.uniswap_v2.enabled,
                feeBps: cfg.amms.uniswap_v2.fee_bps,
                rebalanceEnabled: cfg.amms.uniswap_v2.rebalance_enabled,
            },
            curve: CurveAmmCfg {
                enabled: cfg.amms.curve.enabled,
                mathMode: cfg.amms.curve.math_mode,
                presets: curve_presets,
            },
        },
    })
}

#[derive(Debug, Deserialize, Clone, Copy)]
struct PricePoint {
    t: u64,
    p: f64,
}

#[derive(Debug, Deserialize)]
struct PriceData {
    points: Vec<PricePoint>,
}

#[derive(Debug)]
struct PriceOracle {
    eth: Vec<PricePoint>,
    btc: Vec<PricePoint>,
}

impl PriceOracle {
    fn load(data_dir: &Path) -> Result<(Self, OracleSnapshot)> {
        let eth_path = data_dir.join("eth-usd.json");
        let btc_path = data_dir.join("btc-usd.json");

        let eth_raw =
            fs::read(&eth_path).with_context(|| format!("read {}", eth_path.display()))?;
        let btc_raw =
            fs::read(&btc_path).with_context(|| format!("read {}", btc_path.display()))?;
        let raw_files = BTreeMap::from([
            ("btc-usd.json".to_string(), btc_raw),
            ("eth-usd.json".to_string(), eth_raw),
        ]);
        let snapshot = oracle_snapshot_from_bytes(&raw_files)?;

        let mut eth: PriceData = serde_json::from_slice(&raw_files["eth-usd.json"])
            .with_context(|| format!("parse {}", eth_path.display()))?;
        let mut btc: PriceData = serde_json::from_slice(&raw_files["btc-usd.json"])
            .with_context(|| format!("parse {}", btc_path.display()))?;

        eth.points.sort_by_key(|p| p.t);
        btc.points.sort_by_key(|p| p.t);

        Ok((
            Self {
                eth: dedupe_points(eth.points),
                btc: dedupe_points(btc.points),
            },
            snapshot,
        ))
    }

    fn get_price_at(&self, symbol: &str, ts: u64) -> Result<f64> {
        let points = if symbol == "ETH" {
            &self.eth
        } else {
            &self.btc
        };
        if points.is_empty() {
            return Err(anyhow!("empty oracle points for {symbol}"));
        }
        if ts <= points[0].t {
            return Ok(points[0].p);
        }
        if ts >= points[points.len() - 1].t {
            return Ok(points[points.len() - 1].p);
        }

        let mut lo = 0usize;
        let mut hi = points.len() - 1;
        let mut idx = 0usize;
        while lo <= hi {
            let mid = (lo + hi) / 2;
            let t = points[mid].t;
            if t <= ts {
                idx = mid;
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        Ok(points[idx].p)
    }

    fn timestamps_for_asset(&self, symbol: &str, start: u64, end: u64) -> Vec<u64> {
        let points = if symbol == "ETH" {
            &self.eth
        } else {
            &self.btc
        };
        points
            .iter()
            .filter(|p| p.t >= start && p.t <= end)
            .map(|p| p.t)
            .collect()
    }

    fn range_intersection(&self) -> Option<(u64, u64)> {
        let eth_first = self.eth.first()?.t;
        let eth_last = self.eth.last()?.t;
        let btc_first = self.btc.first()?.t;
        let btc_last = self.btc.last()?.t;
        let start = if eth_first >= btc_first {
            eth_first
        } else {
            btc_first
        };
        let end = if eth_last <= btc_last {
            eth_last
        } else {
            btc_last
        };
        Some((start, end))
    }
}

fn dedupe_points(points: Vec<PricePoint>) -> Vec<PricePoint> {
    let mut map = BTreeMap::<u64, f64>::new();
    for p in points {
        map.insert(p.t, p.p);
    }
    map.into_iter().map(|(t, p)| PricePoint { t, p }).collect()
}

#[derive(Debug)]
struct KeyedRng {
    seed: u64,
    streams: HashMap<String, Mulberry32Rng>,
}

#[derive(Debug, Clone, Copy)]
struct Mulberry32Rng {
    state: u32,
}

impl Mulberry32Rng {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        // Must match test/benchmark/utils/DeterministicRNG.ts exactly.
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        let out = t ^ (t >> 14);
        (out as f64) / 4_294_967_296f64
    }
}

impl KeyedRng {
    fn new(seed: u64) -> Self {
        Self {
            seed,
            streams: HashMap::new(),
        }
    }

    fn get_stream(&mut self, key: &str) -> &mut Mulberry32Rng {
        // Double lookup instead of `entry(key.to_string())`: the entry API
        // would allocate the key String on every draw even after the stream
        // exists, and this runs once per tick per base over multi-year
        // windows. The miss path (one alloc + seed hash) runs once per key.
        if !self.streams.contains_key(key) {
            let h = hash_string_u32(&format!("{}-{}", self.seed, key));
            self.streams.insert(key.to_string(), Mulberry32Rng::new(h));
        }
        self.streams
            .get_mut(key)
            .expect("stream inserted on miss above")
    }

    fn next_f64(&mut self, key: &str) -> f64 {
        self.get_stream(key).next_f64()
    }

    fn uniform(&mut self, key: &str, min_v: f64, max_v: f64) -> f64 {
        if max_v <= min_v {
            return min_v;
        }
        min_v + self.next_f64(key) * (max_v - min_v)
    }
}

fn hash_string_u32(s: &str) -> u32 {
    // djb2 variant, exactly as in DeterministicRNG.ts
    let mut hash: u32 = 5381u32;
    for b in s.as_bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(*b as u32);
    }
    hash
}

/// Base assets the benchmark simulates, in canonical order. Index
/// positions are used for per-base slot arrays in the tick loop.
const SIM_BASES: [&str; 2] = ["WETH", "WBTC"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AmmKind {
    Equilibra,
    UniswapV2,
    Curve,
}

impl AmmKind {
    fn as_str(&self) -> &'static str {
        match self {
            AmmKind::Equilibra => "equilibra",
            AmmKind::UniswapV2 => "uniswapV2",
            AmmKind::Curve => "curve",
        }
    }
}

#[derive(Debug, Clone)]
struct EquilibraParams {
    /// Depth-at-anchor knob `a` (WAD-scaled). At `D = 0` the
    /// amplification `A = a` — larger `aWad` deepens the central
    /// plateau. Bounded by `Constants.A_MIN_WAD..A_MAX_WAD`
    /// (`1e17..99e16`, i.e. `0.1·W..0.99·W`). Decoupled from
    /// `lambda_wad`.
    a_wad: u128,
    /// Plateau-width knob `λ` (WAD-scaled). At `λ·D = W` the
    /// amplification halves (`A = a/2`). Bounded by
    /// `Constants.LAMBDA_MIN_WAD..LAMBDA_MAX_WAD`
    /// (`1e15..1e18`). Decoupled from `a_wad`.
    lambda_wad: u128,
    protocol_fee_percent: u64,
    /// Price-EMA half-life in seconds. `EquilibraStatefulConfig::new`
    /// converts it to the internal relaxation time tau exactly once.
    ema_period: u64,
    repeg_step_wad: u128,
    /// Auto-repeg activation dead-band (WAD). Mirrors
    /// direction-split dead-bands; decoupled from the per-repeg cap.
    /// `up` applies while `ema > priceScale` (token1's price in token0
    /// above the anchor); `down` otherwise.
    repeg_threshold_token1_up_wad: u128,
    repeg_threshold_token1_down_wad: u128,
    rebalance_enabled: bool,
    /// Smoothstep ramp width in BPS. `0` disables the dynamic fee ramp and
    /// keeps the flat `fee_bps` (ceiling) behaviour — identical to pools
    /// created on-chain with `PoolConfig.feeRampBps = 0`.
    fee_ramp_bps: u64,
    /// Smoothstep lower bound in BPS. Must satisfy `fee_floor_bps <= fee_bps`.
    /// Mirrors `PoolConfig.feeFloorBps`.
    fee_floor_bps: u64,
    /// Fraction of cumulative LP unit-value growth (`lpValueGrowthWad`)
    /// the auto-repeg gate is allowed to spend on anchor moves, in BPS
    /// of `BPS = 10_000`. Mirrors `PoolConfig.repegShareBps`.
    repeg_share_bps: u64,
    /// Donation-parachute activation multiplier K. Mirrors the per-pool
    /// `_parachuteBandMult` storage (seeded at
    /// `REPEG_PARACHUTE_BAND_MULT_DEFAULT`, timelock-adjustable in
    /// `[1, 255]` on-chain).
    parachute_band_mult: u128,
    /// Annual donation stream into the donation-parachute buffer, BPS
    /// of pool TVL per year (0 = disabled).
    donation_apr_bps: u64,
    /// Seconds between consecutive donation transfers.
    donation_interval_sec: u64,
    /// Market timestamp of the last donation transfer (actor cursor).
    last_donation_ts: u64,
    /// Seconds of the run window already funded by the stream — caps
    /// the prepaid schedule at `apr × window`.
    donation_accrued_sec: u64,
    /// Multiplicative donation uplift index (WAD). Each park multiplies
    /// it by `activeBefore / activeAfter`, so a claim's gross value
    /// divided by this index is its value WITHOUT any donation — exact
    /// for any number of events, interleaved mints/burns and later
    /// earnings.
    donation_uplift_index: u128,
}

#[derive(Debug, Clone)]
struct CurveParams {
    a: u128,
    gamma: u128,
    mid_fee: u128,
    out_fee: u128,
    fee_gamma: u128,
    adjustment_step_min: u128,
    adjustment_step_max: u128,
    reserved_profit_fraction: u128,
    ma_time: u64,
    math_mode: String,
    price_scale: u128,
    price_oracle: u128,
    last_prices: u128,
    last_timestamp: u64,
    virtual_price: u128,
    xcp_profit: u128,
    lp_xcp_profit: u128,
    d: u128,
    d_dirty: bool,
    rebalance_enabled: bool,
    donation: curve::CurveDonationState,
    /// Annual donation stream, BPS of pool TVL (0 = disabled).
    donation_apr_bps: u64,
    /// Seconds between consecutive donation events.
    donation_interval_sec: u64,
    /// Market timestamp of the last accrued donation (actor cursor).
    last_donation_ts: u64,
    /// Seconds of the run window already funded by the stream.
    donation_accrued_sec: u64,
    /// Multiplicative donation uplift index (WAD): each rebalance-commit
    /// burn multiplies it by `supplyBefore / supplyAfter`.
    donation_uplift_index: u128,
}

#[derive(Debug, Clone)]
struct UniswapParams {
    block_timestamp_last: u32,
    price0_cumulative_last: String,
    price1_cumulative_last: String,
    k_last: String,
    rebalance_enabled: bool,
}

#[derive(Debug, Clone)]
struct PoolState {
    context_name: String,
    amm: AmmKind,
    base_symbol: String,
    token0: String,
    token1: String,
    token0_symbol: String,
    token1_symbol: String,
    /// Per-pool token decimals. Carried in the pool state (instead of a
    /// global symbol → decimals lookup) so trace mode can replay pools
    /// whose synthetic symbols are not in the canonical table: benchmark
    /// contexts resolve these from `common::token_decimals` at build
    /// time, trace pools take them from the required `token0Decimals` /
    /// `token1Decimals` trace-input fields.
    token0_decimals: u8,
    token1_decimals: u8,

    reserve0: u128,
    reserve1: u128,

    e0: u128,
    e1: u128,
    protocol_fee0: u128,
    protocol_fee1: u128,

    /// Vestigial "target reserve in token0" — derived from
    /// `anchor_price_wad`. Kept for CSV/report backwards compatibility
    /// but no longer part of the canonical V2 contract state.
    anchor0: u128,
    /// Vestigial "target reserve in token1" — see `anchor0`.
    anchor1: u128,

    total_supply: u128,
    lp1_liquidity: u128,
    /// Equilibra donation buffer: LP shares parked on the pool's own
    /// address (counted inside `total_supply`), spendable ONLY by the
    /// repeg donation parachute. Always 0 for other AMMs.
    donation_shares: u128,

    eq: Option<EquilibraParams>,
    uni: Option<UniswapParams>,
    curve: Option<CurveParams>,

    fee_bps: u64,

    recentering_events: Vec<RecenteringEventOut>,
    last_recenter_ts: u64,
    ema_price: u128,
    last_timestamp: u64,
    /// Curve-style LP-fee budget bucket — always 0 in the hybrid model
    /// (fees are inlined into reserves). Kept for CSV schema stability.
    budget_fee0: u128,
    /// See `budget_fee0`.
    budget_fee1: u128,
    /// `priceScale` in the hybrid model (`price1 / price0`, WAD-scaled).
    /// Mirrors `_anchorPriceWad` in `EquilibraPool.sol`.
    anchor_price_wad: u128,
    /// LP unit value sealed at genesis (`2 · L_eq · √(anchor · WAD) /
    /// totalSupply`). Mirrors `_lpUnitValueGenesisWad`.
    lp_unit_value_genesis_wad: u128,
    /// Last observed LP unit value (monotone-up high-water mark). Mirrors
    /// `_lpUnitValueWad`.
    lp_unit_value_wad: u128,
    /// Cumulative `Σ max(0, ΔlpUnitValue)` accumulator. Mirrors
    /// `_lpValueGrowthWad`.
    lp_value_growth_wad: u128,
}

#[derive(Debug, Clone, Default)]
struct RecenterGateStats {
    checks_total: u64,
    recentered: u64,
    /// Subset of `recentered` committed by the donation parachute
    /// (Equilibra only; always 0 for Curve/Uniswap).
    recentered_via_parachute: u64,
    /// Per-gate counters keyed by the owning AMM's gate enum `as_str()`
    /// value (`EquilibraRecenterGateBlocked` or `CurveRebalanceGateBlocked`).
    /// Using a map keeps this future-proof against gate additions without
    /// touching every aggregator.
    blocked_counts: BTreeMap<&'static str, u64>,
}

impl RecenterGateStats {
    fn record_swap(
        &mut self,
        recentered: bool,
        via_parachute: bool,
        blocked_by: Option<&'static str>,
    ) {
        self.checks_total = self.checks_total.saturating_add(1);
        if recentered {
            self.recentered = self.recentered.saturating_add(1);
            if via_parachute {
                self.recentered_via_parachute = self.recentered_via_parachute.saturating_add(1);
            }
            return;
        }
        if let Some(reason) = blocked_by {
            let entry = self.blocked_counts.entry(reason).or_insert(0);
            *entry = entry.saturating_add(1);
        }
    }

    // Aggregate is serialized via `build_recenter_gate_stats_export`,
    // and the final per-gate log is rendered by `report::generate_report*`.
    // No local `blocked_total` / `ordered_gate_counts` helpers are needed
    // here anymore — those live in `common::RecenterGateCounts`.
}

#[derive(Debug, Clone, Default)]
struct RecenterGateStatsByBase {
    weth: RecenterGateStats,
    wbtc: RecenterGateStats,
    // Period maps are keyed by the compact numeric encodings
    // (`year*100 + month`, `year*10 + quarter`; `0` = unrepresentable
    // timestamp). Numeric order matches the lexicographic order of the
    // rendered "YYYY-MM" / "YYYY-Qn" strings, so the export (which
    // renders the strings once per period) is byte-identical to the
    // historical String-keyed maps — without a chrono conversion plus
    // two format! allocations on every executed swap.
    weth_monthly: BTreeMap<u32, RecenterGateStats>,
    wbtc_monthly: BTreeMap<u32, RecenterGateStats>,
    weth_quarterly: BTreeMap<u32, RecenterGateStats>,
    wbtc_quarterly: BTreeMap<u32, RecenterGateStats>,
    // (utc_day, month_key, quarter_key) of the last recorded swap: swaps
    // arrive in near-monotone time order, so the chrono conversion runs
    // roughly once per simulated day instead of once per swap.
    period_key_cache: Option<(u64, u32, u32)>,
}

impl RecenterGateStatsByBase {
    fn period_keys(&mut self, timestamp: u64) -> (u32, u32) {
        let day = timestamp / 86_400;
        if let Some((cached_day, month, quarter)) = self.period_key_cache {
            if cached_day == day {
                return (month, quarter);
            }
        }
        let (month, quarter) = gate_period_keys(timestamp);
        self.period_key_cache = Some((day, month, quarter));
        (month, quarter)
    }

    fn record_swap(
        &mut self,
        base_symbol: &str,
        timestamp: u64,
        recentered: bool,
        via_parachute: bool,
        blocked_by: Option<&'static str>,
    ) {
        let (month_key, quarter_key) = self.period_keys(timestamp);
        match base_symbol {
            "WETH" => {
                self.weth.record_swap(recentered, via_parachute, blocked_by);
                self.weth_monthly.entry(month_key).or_default().record_swap(
                    recentered,
                    via_parachute,
                    blocked_by,
                );
                self.weth_quarterly
                    .entry(quarter_key)
                    .or_default()
                    .record_swap(recentered, via_parachute, blocked_by);
            }
            "WBTC" => {
                self.wbtc.record_swap(recentered, via_parachute, blocked_by);
                self.wbtc_monthly.entry(month_key).or_default().record_swap(
                    recentered,
                    via_parachute,
                    blocked_by,
                );
                self.wbtc_quarterly
                    .entry(quarter_key)
                    .or_default()
                    .record_swap(recentered, via_parachute, blocked_by);
            }
            _ => {}
        }
    }

    fn get_for_base(&self, base_symbol: &str) -> Option<&RecenterGateStats> {
        match base_symbol {
            "WETH" => Some(&self.weth),
            "WBTC" => Some(&self.wbtc),
            _ => None,
        }
    }

    fn get_monthly_for_base(&self, base_symbol: &str) -> Option<&BTreeMap<u32, RecenterGateStats>> {
        match base_symbol {
            "WETH" => Some(&self.weth_monthly),
            "WBTC" => Some(&self.wbtc_monthly),
            _ => None,
        }
    }

    fn get_quarterly_for_base(
        &self,
        base_symbol: &str,
    ) -> Option<&BTreeMap<u32, RecenterGateStats>> {
        match base_symbol {
            "WETH" => Some(&self.weth_quarterly),
            "WBTC" => Some(&self.wbtc_quarterly),
            _ => None,
        }
    }
}

/// Both per-AMM gate-statistics aggregates, threaded together through the
/// swap execution paths so each AMM branch records into its own half.
#[derive(Debug, Default)]
struct RecenterGateStatsBundle {
    equilibra: RecenterGateStatsByBase,
    curve: RecenterGateStatsByBase,
}

/// Compact numeric period keys for a swap timestamp:
/// `(year*100 + month, year*10 + quarter)`; `(0, 0)` when the timestamp
/// is unrepresentable (rendered as "unknown", matching the historical
/// String keys).
fn gate_period_keys(timestamp: u64) -> (u32, u32) {
    let Some(dt) = chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp as i64, 0) else {
        return (0, 0);
    };
    let year = dt.year() as u32;
    let month = dt.month();
    let quarter = ((month - 1) / 3) + 1;
    (year * 100 + month, year * 10 + quarter)
}

fn format_gate_month_key(key: u32) -> String {
    if key == 0 {
        return "unknown".to_string();
    }
    format!("{:04}-{:02}", key / 100, key % 100)
}

fn format_gate_quarter_key(key: u32) -> String {
    if key == 0 {
        return "unknown".to_string();
    }
    format!("{:04}-Q{}", key / 10, key % 10)
}

#[derive(Debug, Clone, Serialize)]
struct RecenteringEventOut {
    timestamp: u64,
    ammName: String,
    poolKey: String,
    ilEstimate: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    oldPriceScale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    newPriceScale: Option<String>,
}

#[derive(Debug, Clone)]
struct EquilibraExchangeStatefulOut {
    amount_out: u128,
    reserve0: u128,
    reserve1: u128,
    /// Vestigial — see `PoolState::anchor0`.
    anchor0: u128,
    anchor1: u128,
    protocol_fee0: u128,
    protocol_fee1: u128,
    e0: u128,
    e1: u128,
    ema_price: u128,
    last_timestamp: u64,
    last_recenter_ts: u64,
    /// Vestigial — see `PoolState::budget_fee0`.
    budget_fee0: u128,
    budget_fee1: u128,
    /// Cost of the just-attempted recenter step, in the loss-token of the step.
    recenter_cost_loss_token: u128,
    /// Fee that was actually charged on this swap, in raw `token_in`
    /// units. Mirrors `runtime_quoter::equilibra::EquilibraExchangeStatefulOut::fee_amount_raw`.
    /// Surfaced so per-trade reporting can populate `feePaidUsd` /
    /// `actualFeeBps` with the dynamic smoothstep value rather than the
    /// static `pool.fee_bps` ceiling.
    fee_amount_raw: u128,
    recentered: bool,
    recenter_blocked_by: Option<equilibra::EquilibraRecenterGateBlocked>,
    /// New hybrid-model state fields mirrored from the stateful pool.
    anchor_price_wad: u128,
    /// LP unit value sealed at genesis (quote-WAD).
    lp_unit_value_genesis_wad: u128,
    /// Live LP unit value high-water mark (quote-WAD).
    lp_unit_value_wad: u128,
    /// Cumulative LP-unit-value growth accumulator (quote-WAD).
    lp_value_growth_wad: u128,
    /// Post-swap LP total supply — a parachute commit BURNS donated
    /// shares, so supply can shrink inside a swap.
    total_supply: u128,
    /// Post-swap donation buffer (LP shares parked on the pool).
    donation_shares: u128,
    /// True when this swap's commit came from the donation parachute.
    recentered_via_parachute: bool,
}

#[derive(Debug, Clone, Copy)]
struct EquilibraSwapExecOut {
    amount_out: u128,
    /// Actual fee charged on the swap, expressed in raw `token_in` units
    /// (mirrors `EquilibraExchangeStatefulOut::fee_amount_raw`). For
    /// dynamic-fee Equilibra pools this reflects the smoothstep fee that
    /// was actually applied — NOT the static `pool.fee_bps` (smoothstep
    /// ceiling). Used by the arb-trade reporting path to populate
    /// `feePaidUsd` and `actualFeeBps` so the headline fee metrics track
    /// the dynamic ramp instead of degenerating into `arbVolume × baseFee`.
    fee_amount_raw: u128,
    recentered: bool,
    recenter_blocked_by: Option<equilibra::EquilibraRecenterGateBlocked>,
}

#[derive(Debug, Clone, Copy)]
struct CurveExchangeStatefulOut {
    amount_out: u128,
    reserve0: u128,
    reserve1: u128,
    curve_d: u128,
    curve_price_scale: u128,
    curve_price_oracle: u128,
    curve_last_prices: u128,
    curve_last_timestamp: u64,
    curve_virtual_price: u128,
    curve_xcp_profit: u128,
    curve_lp_xcp_profit: u128,
    curve_total_supply: u128,
    /// Fee actually charged on this swap, denominated in raw `token_out`
    /// units (Curve takes its fee on the OUTPUT side). Mirrors
    /// `runtime_quoter::curve::CurveExchangeStatefulOut::fee_amount_out`
    /// and is consumed by the per-swap reporting path so headline
    /// metrics track the dynamic `mid_fee → out_fee` ramp instead of
    /// always being equal to `pool.fee_bps × volume`.
    fee_amount_out: u128,
    /// Effective fee BPS that was actually applied — derived from
    /// `curve_fee` (`fee_rate_1e10 / 1e6`). Equal to `pool.fee_bps`
    /// (i.e. `mid_fee` in BPS) only at perfect balance; otherwise larger.
    fee_bps_effective: u64,
    /// Whether this exchange committed a `price_scale` rebalance.
    rebalanced: bool,
    /// First gate that blocked the rebalance when `rebalanced == false`.
    rebalance_blocked_by: Option<curve::CurveRebalanceGateBlocked>,
    /// Exact donation shares burned by this exchange's rebalance commit
    /// (0 when none). Feeds the uplift-index fold in
    /// `apply_curve_runtime_state`.
    donation_shares_burned: u128,
    /// Donation bookkeeping after this exchange.
    curve_donation: curve::CurveDonationState,
}

#[derive(Debug, Clone, Copy)]
struct CurveAddLiquidityStatefulOut {
    minted_liquidity: u128,
    amount0_used: u128,
    amount1_used: u128,
    reserve0: u128,
    reserve1: u128,
    curve_d: u128,
    curve_price_scale: u128,
    curve_price_oracle: u128,
    curve_last_prices: u128,
    curve_last_timestamp: u64,
    curve_virtual_price: u128,
    curve_xcp_profit: u128,
    curve_lp_xcp_profit: u128,
    curve_total_supply: u128,
    /// Exact donation shares burned by this event's rebalance commit
    /// (0 when none). A donation add can mint into the buffer AND burn
    /// older unlocked shares in the SAME event, so the buffer's net
    /// share change cannot recover this amount.
    donation_shares_burned: u128,
    curve_donation: curve::CurveDonationState,
}

#[derive(Debug, Clone, Copy)]
struct CurveRemoveLiquidityStatefulOut {
    amount0_out: u128,
    amount1_out: u128,
    reserve0: u128,
    reserve1: u128,
    curve_d: u128,
    curve_price_scale: u128,
    curve_price_oracle: u128,
    curve_last_prices: u128,
    curve_last_timestamp: u64,
    curve_virtual_price: u128,
    curve_xcp_profit: u128,
    curve_lp_xcp_profit: u128,
    curve_total_supply: u128,
    curve_donation: curve::CurveDonationState,
}

#[derive(Debug, Clone)]
struct UniswapV2SwapStatefulOut {
    amount_out: u128,
    reserve0: u128,
    reserve1: u128,
    block_timestamp_last: u32,
    price0_cumulative_last: String,
    price1_cumulative_last: String,
    k_last: String,
}

#[derive(Debug)]
struct QuoterClient {
    inner: LocalQuoter,
    // The legacy `equilibra_quote_cache` (single-knob
    // stateless config) was retired — stateless quotes now use the
    // stateful cfg cache below and call
    // `equilibra_math::quote_exact_in_forward` directly.
    equilibra_stateful_cfg_cache: HashMap<String, EquilibraStatefulConfig>,
    curve_quote_cache: HashMap<String, CurveQuoteConfig>,
    uniswap_quote_cache: HashMap<String, uniswap_v2::UniswapV2QuoteConfig>,
}

impl QuoterClient {
    fn new() -> Result<Self> {
        Ok(Self {
            inner: LocalQuoter::new(),
            equilibra_stateful_cfg_cache: HashMap::new(),
            curve_quote_cache: HashMap::new(),
            uniswap_quote_cache: HashMap::new(),
        })
    }

    /// The legacy `EquilibraQuoteConfig` (single-knob, fee-aware
    /// stateless config) was retired. Stateless quotes now lift to
    /// math-space and call `equilibra_math::quote_exact_in_forward`
    /// directly — the stateful config cache
    /// (`equilibra_stateful_cfg_cache`) already carries every
    /// scaling factor we need (`a_wad`, `lambda_wad`, `token0_scale`,
    /// `token1_scale`).

    fn curve_quote_config_from_pool(pool: &PoolState) -> Result<CurveQuoteConfig> {
        let curve = pool
            .curve
            .as_ref()
            .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
        let precisions = [
            pow10_u128((18 - pool.token0_decimals) as u32),
            pow10_u128((18 - pool.token1_decimals) as u32),
        ];
        Ok(CurveQuoteConfig::new(
            &pool.token0,
            &pool.token1,
            curve.math_mode.clone(),
            curve.a,
            curve.gamma,
            curve.mid_fee,
            curve.out_fee,
            curve.fee_gamma,
            precisions,
        ))
    }

    fn uniswap_quote_config_from_pool(
        pool: &PoolState,
    ) -> Result<uniswap_v2::UniswapV2QuoteConfig> {
        uniswap_v2::UniswapV2QuoteConfig::new(&pool.token0, &pool.token1, pool.fee_bps)
    }

    fn quote_exact_input_pool(
        &mut self,
        pool: &PoolState,
        token_in: &str,
        amount_in: u128,
    ) -> Result<u128> {
        match pool.amm {
            AmmKind::Equilibra => {
                self.ensure_equilibra_stateful_cfg(pool)?;
                let cfg = self
                    .equilibra_stateful_cfg_cache
                    .get(&pool.context_name)
                    .unwrap();
                quote_equilibra_exact_in_stateless(
                    cfg,
                    pool.reserve0,
                    pool.reserve1,
                    pool.anchor_price_wad,
                    token_in,
                    amount_in,
                )
            }
            AmmKind::Curve => {
                if !self.curve_quote_cache.contains_key(&pool.context_name) {
                    let cfg = Self::curve_quote_config_from_pool(pool)?;
                    self.curve_quote_cache
                        .insert(pool.context_name.clone(), cfg);
                }
                let cfg = self.curve_quote_cache.get(&pool.context_name).unwrap();
                let curve = pool
                    .curve
                    .as_ref()
                    .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
                let state = curve::CurveQuoteState {
                    reserve0: pool.reserve0,
                    reserve1: pool.reserve1,
                    price_scale: curve.price_scale,
                    d: curve.d,
                };
                self.inner
                    .quote_curve_exact_input(cfg, &state, token_in, amount_in)
            }
            AmmKind::UniswapV2 => {
                if !self.uniswap_quote_cache.contains_key(&pool.context_name) {
                    let cfg = Self::uniswap_quote_config_from_pool(pool)?;
                    self.uniswap_quote_cache
                        .insert(pool.context_name.clone(), cfg);
                }
                let cfg = self.uniswap_quote_cache.get(&pool.context_name).unwrap();
                let state = uniswap_v2::UniswapV2QuoteState {
                    reserve0: pool.reserve0,
                    reserve1: pool.reserve1,
                };
                self.inner
                    .quote_uniswap_v2_exact_input(cfg, &state, token_in, amount_in)
            }
        }
    }

    #[allow(dead_code)]
    fn quote_exact_output_input(
        &mut self,
        pool: &PoolState,
        token_in: &str,
        amount_out: u128,
    ) -> Result<u128> {
        self.ensure_equilibra_stateful_cfg(pool)?;
        let cfg = self
            .equilibra_stateful_cfg_cache
            .get(&pool.context_name)
            .unwrap();
        quote_equilibra_exact_out_stateless(
            cfg,
            pool.reserve0,
            pool.reserve1,
            pool.anchor_price_wad,
            token_in,
            amount_out,
        )
    }

    fn curve_compute_d(&mut self, pool: &PoolState) -> Result<u128> {
        // Borrow the cached config in place (miss path allocates once per
        // context) — the previous `cache_key.clone()` + `cfg.clone()` pair
        // re-allocated the key and the 3-String config on every invariant
        // refresh.
        if !self.curve_quote_cache.contains_key(&pool.context_name) {
            let cfg = Self::curve_quote_config_from_pool(pool)?;
            self.curve_quote_cache
                .insert(pool.context_name.clone(), cfg);
        }
        let cfg = self.curve_quote_cache.get(&pool.context_name).unwrap();
        let curve = pool
            .curve
            .as_ref()
            .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
        let state = curve::CurveQuoteState {
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            price_scale: curve.price_scale,
            d: curve.d,
        };
        self.inner.curve_compute_d(cfg, &state)
    }

    fn curve_exchange_stateful(
        &mut self,
        pool: &PoolState,
        token_in: &str,
        amount_in: u128,
        timestamp: u64,
        disable_rebalance: bool,
    ) -> Result<CurveExchangeStatefulOut> {
        let cache_key = pool.context_name.clone();
        let quote_cfg = if let Some(cfg) = self.curve_quote_cache.get(&cache_key) {
            cfg.clone()
        } else {
            let cfg = Self::curve_quote_config_from_pool(pool)?;
            self.curve_quote_cache
                .insert(cache_key.clone(), cfg.clone());
            cfg
        };
        let curve = pool
            .curve
            .as_ref()
            .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
        let cfg = curve::CurveStatefulConfig::new(
            quote_cfg,
            curve.adjustment_step_min,
            curve.adjustment_step_max,
            curve.reserved_profit_fraction,
            u128::from(curve.ma_time),
        );
        let state = curve::CurveStatefulState {
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            d: curve.d,
            price_scale: curve.price_scale,
            price_oracle: curve.price_oracle,
            last_prices: curve.last_prices,
            last_timestamp: curve.last_timestamp,
            virtual_price: curve.virtual_price,
            xcp_profit: curve.xcp_profit,
            lp_xcp_profit: curve.lp_xcp_profit,
            total_supply: pool.total_supply,
            donation: curve.donation,
        };
        let out = self.inner.curve_exchange_stateful(
            &cfg,
            state,
            token_in,
            amount_in,
            timestamp,
            disable_rebalance,
        )?;
        Ok(CurveExchangeStatefulOut {
            amount_out: out.amount_out,
            reserve0: out.reserve0,
            reserve1: out.reserve1,
            curve_d: out.curve_d,
            curve_price_scale: out.curve_price_scale,
            curve_price_oracle: out.curve_price_oracle,
            curve_last_prices: out.curve_last_prices,
            curve_last_timestamp: out.curve_last_timestamp,
            curve_virtual_price: out.curve_virtual_price,
            curve_xcp_profit: out.curve_xcp_profit,
            curve_lp_xcp_profit: out.curve_lp_xcp_profit,
            curve_total_supply: out.curve_total_supply,
            fee_amount_out: out.fee_amount_out,
            fee_bps_effective: out.fee_bps_effective,
            rebalanced: out.rebalanced,
            rebalance_blocked_by: out.rebalance_blocked_by,
            donation_shares_burned: out.donation_shares_burned,
            curve_donation: out.curve_donation,
        })
    }

    fn curve_add_liquidity_stateful(
        &mut self,
        pool: &PoolState,
        amount0: u128,
        amount1: u128,
        timestamp: u64,
        disable_rebalance: bool,
    ) -> Result<CurveAddLiquidityStatefulOut> {
        let cache_key = pool.context_name.clone();
        let quote_cfg = if let Some(cfg) = self.curve_quote_cache.get(&cache_key) {
            cfg.clone()
        } else {
            let cfg = Self::curve_quote_config_from_pool(pool)?;
            self.curve_quote_cache
                .insert(cache_key.clone(), cfg.clone());
            cfg
        };
        let curve = pool
            .curve
            .as_ref()
            .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
        let cfg = curve::CurveStatefulConfig::new(
            quote_cfg,
            curve.adjustment_step_min,
            curve.adjustment_step_max,
            curve.reserved_profit_fraction,
            u128::from(curve.ma_time),
        );
        let state = curve::CurveStatefulState {
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            d: curve.d,
            price_scale: curve.price_scale,
            price_oracle: curve.price_oracle,
            last_prices: curve.last_prices,
            last_timestamp: curve.last_timestamp,
            virtual_price: curve.virtual_price,
            xcp_profit: curve.xcp_profit,
            lp_xcp_profit: curve.lp_xcp_profit,
            total_supply: pool.total_supply,
            donation: curve.donation,
        };
        let out = self.inner.curve_add_liquidity_stateful(
            &cfg,
            state,
            amount0,
            amount1,
            timestamp,
            disable_rebalance,
        )?;
        Ok(CurveAddLiquidityStatefulOut {
            minted_liquidity: out.minted_liquidity,
            amount0_used: out.amount0_used,
            amount1_used: out.amount1_used,
            reserve0: out.reserve0,
            reserve1: out.reserve1,
            curve_d: out.curve_d,
            curve_price_scale: out.curve_price_scale,
            curve_price_oracle: out.curve_price_oracle,
            curve_last_prices: out.curve_last_prices,
            curve_last_timestamp: out.curve_last_timestamp,
            curve_virtual_price: out.curve_virtual_price,
            curve_xcp_profit: out.curve_xcp_profit,
            curve_lp_xcp_profit: out.curve_lp_xcp_profit,
            curve_total_supply: out.curve_total_supply,
            donation_shares_burned: out.donation_shares_burned,
            curve_donation: out.curve_donation,
        })
    }

    /// Donation variant of `curve_add_liquidity_stateful`: liquidity is
    /// credited to the pool's donation buffer (no LP mint to a receiver).
    fn curve_donate_stateful(
        &mut self,
        pool: &PoolState,
        amount0: u128,
        amount1: u128,
        timestamp: u64,
        disable_rebalance: bool,
    ) -> Result<CurveAddLiquidityStatefulOut> {
        let cache_key = pool.context_name.clone();
        let quote_cfg = if let Some(cfg) = self.curve_quote_cache.get(&cache_key) {
            cfg.clone()
        } else {
            let cfg = Self::curve_quote_config_from_pool(pool)?;
            self.curve_quote_cache
                .insert(cache_key.clone(), cfg.clone());
            cfg
        };
        let curve = pool
            .curve
            .as_ref()
            .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
        let cfg = curve::CurveStatefulConfig::new(
            quote_cfg,
            curve.adjustment_step_min,
            curve.adjustment_step_max,
            curve.reserved_profit_fraction,
            u128::from(curve.ma_time),
        );
        let state = curve::CurveStatefulState {
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            d: curve.d,
            price_scale: curve.price_scale,
            price_oracle: curve.price_oracle,
            last_prices: curve.last_prices,
            last_timestamp: curve.last_timestamp,
            virtual_price: curve.virtual_price,
            xcp_profit: curve.xcp_profit,
            lp_xcp_profit: curve.lp_xcp_profit,
            total_supply: pool.total_supply,
            donation: curve.donation,
        };
        let out = self.inner.curve_donate_stateful(
            &cfg,
            state,
            amount0,
            amount1,
            timestamp,
            disable_rebalance,
        )?;
        Ok(CurveAddLiquidityStatefulOut {
            minted_liquidity: out.minted_liquidity,
            amount0_used: out.amount0_used,
            amount1_used: out.amount1_used,
            reserve0: out.reserve0,
            reserve1: out.reserve1,
            curve_d: out.curve_d,
            curve_price_scale: out.curve_price_scale,
            curve_price_oracle: out.curve_price_oracle,
            curve_last_prices: out.curve_last_prices,
            curve_last_timestamp: out.curve_last_timestamp,
            curve_virtual_price: out.curve_virtual_price,
            curve_xcp_profit: out.curve_xcp_profit,
            curve_lp_xcp_profit: out.curve_lp_xcp_profit,
            curve_total_supply: out.curve_total_supply,
            donation_shares_burned: out.donation_shares_burned,
            curve_donation: out.curve_donation,
        })
    }

    fn curve_remove_liquidity_stateful(
        &mut self,
        pool: &PoolState,
        liquidity: u128,
    ) -> Result<CurveRemoveLiquidityStatefulOut> {
        let curve = pool
            .curve
            .as_ref()
            .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
        let state = curve::CurveStatefulState {
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            d: curve.d,
            price_scale: curve.price_scale,
            price_oracle: curve.price_oracle,
            last_prices: curve.last_prices,
            last_timestamp: curve.last_timestamp,
            virtual_price: curve.virtual_price,
            xcp_profit: curve.xcp_profit,
            lp_xcp_profit: curve.lp_xcp_profit,
            total_supply: pool.total_supply,
            donation: curve.donation,
        };
        let out = self
            .inner
            .curve_remove_liquidity_stateful(state, liquidity)?;
        Ok(CurveRemoveLiquidityStatefulOut {
            amount0_out: out.amount0_out,
            amount1_out: out.amount1_out,
            reserve0: out.reserve0,
            reserve1: out.reserve1,
            curve_d: out.curve_d,
            curve_price_scale: out.curve_price_scale,
            curve_price_oracle: out.curve_price_oracle,
            curve_last_prices: out.curve_last_prices,
            curve_last_timestamp: out.curve_last_timestamp,
            curve_virtual_price: out.curve_virtual_price,
            curve_xcp_profit: out.curve_xcp_profit,
            curve_lp_xcp_profit: out.curve_lp_xcp_profit,
            curve_total_supply: out.curve_total_supply,
            curve_donation: out.curve_donation,
        })
    }

    /// Lazily materialise the stateful config for an Equilibra pool and
    /// cache it by `context_name`. Downstream callers can then pull it out
    /// of `equilibra_stateful_cfg_cache` without worrying about ordering.
    fn ensure_equilibra_stateful_cfg(&mut self, pool: &PoolState) -> Result<()> {
        if pool.amm != AmmKind::Equilibra {
            return Err(anyhow!(
                "ensure_equilibra_stateful_cfg called for non-equilibra pool {}",
                pool.context_name
            ));
        }
        if self
            .equilibra_stateful_cfg_cache
            .contains_key(&pool.context_name)
        {
            return Ok(());
        }
        let eq = pool
            .eq
            .as_ref()
            .ok_or_else(|| anyhow!("equilibra params missing for {}", pool.context_name))?;
        let mut cfg = equilibra::EquilibraStatefulConfig::new(
            &pool.token0,
            &pool.token1,
            pool.token0_decimals,
            pool.token1_decimals,
            pool.fee_bps as u128,
            eq.a_wad,
            eq.lambda_wad,
            u128::from(eq.protocol_fee_percent),
            u128::from(eq.ema_period),
            eq.repeg_step_wad,
            eq.repeg_threshold_token1_up_wad,
            eq.repeg_threshold_token1_down_wad,
            u128::from(eq.fee_ramp_bps),
            u128::from(eq.fee_floor_bps),
            u128::from(eq.repeg_share_bps),
        )?;
        // K is not a constructor parameter (mirroring `initialize`,
        // which seeds it from Constants rather than PoolConfig):
        // `new()` seeds the canonical default, the per-pool value —
        // e.g. a trace of a timelock-adjusted pool — overrides it here.
        cfg.parachute_band_mult = eq.parachute_band_mult;
        self.equilibra_stateful_cfg_cache
            .insert(pool.context_name.clone(), cfg);
        Ok(())
    }

    fn equilibra_swap_stateful(
        &mut self,
        pool: &PoolState,
        token_in: &str,
        amount_in: u128,
        timestamp: u64,
        disable_recenter: bool,
    ) -> Result<EquilibraExchangeStatefulOut> {
        self.ensure_equilibra_stateful_cfg(pool)?;
        let cfg = self
            .equilibra_stateful_cfg_cache
            .get(&pool.context_name)
            .unwrap();
        let state = equilibra_state_from_pool(pool);
        let out = self.inner.equilibra_swap_stateful(
            cfg,
            state,
            token_in,
            amount_in,
            timestamp,
            disable_recenter,
        )?;
        // Derive legacy anchor0/anchor1 as the balanced target reserves that
        // satisfy the post-swap invariant on the current anchor price. This
        // preserves the CSV schema and any downstream reporting that still
        // references the anchor balances as tokens.
        // The runtime quoter renamed `anchor_price_wad` →
        // `price_scale_wad` (same scalar, new label after the
        // symmetric coord-change rollout). The local CSV-export
        // struct here keeps the old name so the report layer's
        // schema stays bit-stable.
        let (legacy_anchor0, legacy_anchor1) = derive_legacy_anchor_balances(
            out.reserve0,
            out.reserve1,
            out.price_scale_wad,
            pool.token0_decimals,
            pool.token1_decimals,
        );
        Ok(EquilibraExchangeStatefulOut {
            amount_out: out.amount_out,
            reserve0: out.reserve0,
            reserve1: out.reserve1,
            anchor0: legacy_anchor0,
            anchor1: legacy_anchor1,
            protocol_fee0: out.protocol_fee0,
            protocol_fee1: out.protocol_fee1,
            e0: out.e0,
            e1: out.e1,
            ema_price: out.ema_price_wad,
            last_timestamp: out.last_ema_ts,
            last_recenter_ts: out.last_repeg_ts,
            budget_fee0: 0,
            budget_fee1: 0,
            // The hybrid model gates auto-repeg on LP-unit-value health
            // (see `try_auto_repeg`), so the legacy single-side IL cost
            // export is no longer meaningful. The cumulative growth
            // accumulator is exposed below for parity dashboards.
            recenter_cost_loss_token: 0,
            fee_amount_raw: out.fee_amount_raw,
            recentered: out.recentered,
            recenter_blocked_by: out.recenter_blocked_by,
            anchor_price_wad: out.price_scale_wad,
            lp_unit_value_genesis_wad: out.lp_unit_value_genesis_wad,
            lp_unit_value_wad: out.lp_unit_value_wad,
            lp_value_growth_wad: out.lp_value_growth_wad,
            total_supply: out.total_supply,
            donation_shares: out.donation_shares,
            recentered_via_parachute: out.recentered_via_parachute,
        })
    }

    fn equilibra_swap_stateful_exact_out(
        &mut self,
        pool: &PoolState,
        token_in: &str,
        amount_out: u128,
        timestamp: u64,
        disable_recenter: bool,
    ) -> Result<(u128, EquilibraExchangeStatefulOut)> {
        self.ensure_equilibra_stateful_cfg(pool)?;
        let cfg = self
            .equilibra_stateful_cfg_cache
            .get(&pool.context_name)
            .unwrap();
        let state = equilibra_state_from_pool(pool);
        let wrapped = self.inner.equilibra_swap_stateful_exact_out(
            cfg,
            state,
            token_in,
            amount_out,
            timestamp,
            disable_recenter,
        )?;
        let amount_in = wrapped.amount_in;
        let out = wrapped.state;
        // See exact-in branch — the runtime quoter renamed
        // `anchor_price_wad → price_scale_wad` at the runtime quoter
        // boundary; CSV-export label below stays for schema
        // stability.
        let (legacy_anchor0, legacy_anchor1) = derive_legacy_anchor_balances(
            out.reserve0,
            out.reserve1,
            out.price_scale_wad,
            pool.token0_decimals,
            pool.token1_decimals,
        );
        Ok((
            amount_in,
            EquilibraExchangeStatefulOut {
                amount_out: out.amount_out,
                reserve0: out.reserve0,
                reserve1: out.reserve1,
                anchor0: legacy_anchor0,
                anchor1: legacy_anchor1,
                protocol_fee0: out.protocol_fee0,
                protocol_fee1: out.protocol_fee1,
                e0: out.e0,
                e1: out.e1,
                ema_price: out.ema_price_wad,
                last_timestamp: out.last_ema_ts,
                last_recenter_ts: out.last_repeg_ts,
                budget_fee0: 0,
                budget_fee1: 0,
                recenter_cost_loss_token: 0,
                fee_amount_raw: out.fee_amount_raw,
                recentered: out.recentered,
                recenter_blocked_by: out.recenter_blocked_by,
                anchor_price_wad: out.price_scale_wad,
                lp_unit_value_genesis_wad: out.lp_unit_value_genesis_wad,
                lp_unit_value_wad: out.lp_unit_value_wad,
                lp_value_growth_wad: out.lp_value_growth_wad,
                total_supply: out.total_supply,
                donation_shares: out.donation_shares,
                recentered_via_parachute: out.recentered_via_parachute,
            },
        ))
    }

    fn uniswap_v2_swap_stateful(
        &mut self,
        pool: &PoolState,
        token_in: &str,
        amount_in: u128,
        timestamp: u64,
    ) -> Result<UniswapV2SwapStatefulOut> {
        let cache_key = pool.context_name.clone();
        let cfg = if let Some(cfg) = self.uniswap_quote_cache.get(&cache_key) {
            cfg.clone()
        } else {
            let cfg = Self::uniswap_quote_config_from_pool(pool)?;
            self.uniswap_quote_cache
                .insert(cache_key.clone(), cfg.clone());
            cfg
        };
        let uni = pool
            .uni
            .as_ref()
            .ok_or_else(|| anyhow!("uniswap params missing for {}", pool.context_name))?;
        let state = uniswap_v2::UniswapV2StatefulState {
            reserve0: pool.reserve0,
            reserve1: pool.reserve1,
            block_timestamp_last: uni.block_timestamp_last,
            price0_cumulative_last: uni.price0_cumulative_last.clone(),
            price1_cumulative_last: uni.price1_cumulative_last.clone(),
            k_last: uni.k_last.clone(),
        };
        let out = self
            .inner
            .uniswap_v2_swap_stateful(&cfg, &state, token_in, amount_in, timestamp)?;
        Ok(UniswapV2SwapStatefulOut {
            amount_out: out.amount_out,
            reserve0: out.reserve0,
            reserve1: out.reserve1,
            block_timestamp_last: out.block_timestamp_last,
            price0_cumulative_last: out.price0_cumulative_last,
            price1_cumulative_last: out.price1_cumulative_last,
            k_last: out.k_last,
        })
    }
}

#[derive(Debug, Clone)]
struct PassiveLpState {
    context_name: String,
    initial_amount0: u128,
    initial_amount1: u128,
    initial_value_usd: f64,
    initial_ts: u64,

    final_amount0: u128,
    final_amount1: u128,
    final_value_usd: f64,

    value_history: Vec<(u64, f64)>,
    composition_history: Vec<(u64, u128, u128)>,

    impermanent_loss_actual: f64,
    impermanent_loss_cp: f64,
    net_pnl: f64,
    /// Total exogenous subsidy donated into this context (USD) and the
    /// number of donation events. `net_pnl` and the report's
    /// delta-vs-hold are computed NET of this amount.
    donations_usd: f64,
    donation_events: u64,
}

#[derive(Debug, Clone)]
struct ArbTrade {
    timestamp: u64,
    context_name: String,
    direction: String,
    amount_in: u128,
    amount_out: u128,
    gross_profit_usd: f64,
    gas_cost_usd: f64,
    net_profit_usd: f64,
    actual_fee_bps: u64,
    fee_paid_usd: f64,
    price_deviation: i64,
    probe_price: u128,
}

#[derive(Debug, Clone)]
struct ArbState {
    context_name: String,
    trades: Vec<ArbTrade>,
    trade_count: u64,
    total_profit_usd: f64,
    total_gas_usd: f64,
    net_profit_usd: f64,
}

#[derive(Debug, Clone)]
struct UserSlippageState {
    context_name: String,
    aggregate_count: u64,
    aggregate_sum: f64,
    aggregate_sum_squares: f64,
    aggregate_min: f64,
    aggregate_max: f64,
    histogram: Vec<u64>,
    samples: Vec<SlippageSample>,
    bucket_edges_bps: Vec<u64>,
    trade_size_sum_bps: Vec<f64>,
    trade_size_count: Vec<u64>,
}

#[derive(Debug, Clone)]
struct UserSlippageBasis {
    expected_output_norm_1e18: U256,
    amount_usd: f64,
}

#[derive(Debug, Clone)]
struct UserQuotePlan {
    token_in: String,
    token_out: String,
    amount_in: u128,
    trade_size_bps: u64,
    basis: UserSlippageBasis,
    direction: String,
}

#[derive(Debug, Serialize)]
struct RunResultsOut {
    resultFormatVersion: &'static str,
    metadata: MetadataOut,
    contexts: Vec<ContextOut>,
    userState: UserStateOut,
    passiveLPStates: Vec<PassiveLPOut>,
    arbStates: Vec<ArbStateOut>,
    recenteringEvents: Vec<RecenteringEventOut>,
    /// Per-base and per-period recenter-gate statistics for the Equilibra
    /// pool. Round-trips through `sim_results.json` -> merge -> `report_data_dir`,
    /// where it is finally rendered into a plain-text log file next to
    /// `metrics.json`. Replaces the previous per-period `eprintln!` spam that
    /// used to leak into the dashboard tail log.
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRecenterGateStats: Option<RecenterGateStatsExport>,
    /// Per-base and per-period rebalance-gate statistics for the Curve
    /// pool, same shape and pipeline as `equilibraRecenterGateStats`.
    #[serde(skip_serializing_if = "Option::is_none")]
    curveRebalanceGateStats: Option<RecenterGateStatsExport>,
}

#[derive(Debug, Serialize)]
struct ContextOut {
    contextName: String,
    ammName: String,
    poolKey: String,
    token0Symbol: String,
    token1Symbol: String,
}

#[derive(Debug, Serialize)]
struct UserStateOut {
    tradeCount: u64,
    tradeHistory: Vec<common::UserTrade>,
    slippageByContext: Vec<UserSlippageStateOut>,
}

#[derive(Debug, Clone, Serialize)]
struct StreamingAggregateOut {
    count: u64,
    sum: f64,
    sumSquares: f64,
    min: f64,
    max: f64,
}

#[derive(Debug, Clone, Serialize)]
struct UserSlippageStateOut {
    contextName: String,
    aggregate: StreamingAggregateOut,
    histogram: Vec<u64>,
    samples: Vec<SlippageSample>,
    tradeSizeBuckets: TradeSizeBuckets,
}

#[derive(Debug, Serialize)]
struct PassiveLPOut {
    contextName: String,
    initialDeposit: InitialDepositOut,
    finalPosition: FinalPositionOut,
    valueHistory: Vec<ValueSnapOut>,
    compositionHistory: Vec<CompositionSnapOut>,
    impermanentLossActual: f64,
    impermanentLossCP: f64,
    netPnl: f64,
    donationsUsd: f64,
    donationEvents: u64,
}

#[derive(Debug, Serialize)]
struct ArbStateOut {
    contextName: String,
    trades: Vec<ArbTradeOut>,
    tradeCount: u64,
    totalProfitUsd: f64,
    totalGasCostUsd: f64,
    netProfitUsd: f64,
}

#[derive(Debug, Serialize)]
struct ArbTradeOut {
    timestamp: u64,
    contextName: String,
    direction: String,
    amountIn: String,
    amountOut: String,
    grossProfitUsd: f64,
    gasCostUsd: f64,
    netProfitUsd: f64,
    actualFeeBps: u64,
    feePaidUsd: f64,
    priceDeviation: i64,
    probePrice: String,
}

#[derive(Debug, Serialize)]
struct InitialDepositOut {
    amount0: String,
    amount1: String,
    valueUsd: f64,
    timestamp: u64,
}

#[derive(Debug, Serialize)]
struct FinalPositionOut {
    amount0: String,
    amount1: String,
    valueUsd: f64,
}

#[derive(Debug, Serialize)]
struct ValueSnapOut {
    timestamp: u64,
    valueUsd: f64,
}

#[derive(Debug, Serialize)]
struct CompositionSnapOut {
    timestamp: u64,
    amount0: String,
    amount1: String,
}

#[derive(Debug, Serialize)]
struct MetadataOut {
    configHash: String,
    originConfigHash: String,
    executionFingerprint: String,
    oracleDigest: String,
    reportAssetsDigest: String,
    actorAlgorithmVersion: &'static str,
    slippageSweep: SlippageSweepPolicy,
    seed: u64,
    startTimestamp: u64,
    endTimestamp: u64,
    durationDays: u64,
    initialLiquidityUsd: f64,
    gasPriceGwei: f64,
    ammList: Vec<String>,
    poolList: Vec<String>,
    generatedAt: String,
    // BTreeMap keeps shard-file keys sorted — the merged result feeds
    // `canonical_result_digest`, which requires order-stable maps.
    feeConfig: BTreeMap<String, f64>,
    poolTokens: BTreeMap<String, PoolTokenConfigOut>,
    poolTokensByAmm: BTreeMap<String, PoolTokenConfigOut>,
}

#[derive(Debug, Serialize)]
struct PoolTokenConfigOut {
    token0Symbol: String,
    token1Symbol: String,
    token0Decimals: u8,
    token1Decimals: u8,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TraceInput {
    pool: TracePoolInput,
    steps: Vec<TraceStepInput>,
    #[serde(default)]
    startTimestamp: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TracePoolInput {
    contextName: String,
    amm: String,
    baseSymbol: String,
    token0: String,
    token1: String,
    token0Symbol: String,
    token1Symbol: String,
    /// Required: trace pools may carry synthetic symbols that are not in
    /// the canonical `common::token_decimals` table, so the trace itself
    /// is the only source of truth for decimals. No default — a trace
    /// without explicit decimals is rejected at parse time.
    token0Decimals: u8,
    token1Decimals: u8,
    reserve0: String,
    reserve1: String,
    feeBps: u64,
    #[serde(default)]
    totalSupply: Option<String>,
    #[serde(default)]
    uniswapBlockTimestampLast: Option<String>,
    #[serde(default)]
    uniswapPrice0CumulativeLast: Option<String>,
    #[serde(default)]
    uniswapPrice1CumulativeLast: Option<String>,
    #[serde(default)]
    uniswapKLast: Option<String>,
    #[serde(default)]
    anchorReserve0: Option<String>,
    #[serde(default)]
    anchorReserve1: Option<String>,
    /// Two-knob depth-at-anchor and plateau-width parameters.
    /// Replace the legacy single-knob `alpha`; required for any
    /// Equilibra trace.
    #[serde(default)]
    aWad: Option<String>,
    #[serde(default)]
    lambdaWad: Option<String>,
    #[serde(default)]
    protocolFeePercent: Option<u64>,
    #[serde(default)]
    emaPeriod: Option<u64>,
    /// Smoothstep dynamic-fee ramp width in BPS (0 ⇒ disabled). Mirrors
    /// `PoolConfig.feeRampBps`. `Option<>` only because this same struct is
    /// reused across all AMMs; for an Equilibra trace `resolve_pool_context`
    /// requires the field and errors out if it is missing — no silent
    /// fallback.
    #[serde(default)]
    equilibraFeeRampBps: Option<u64>,
    /// Dynamic-fee floor in BPS. Mirrors `PoolConfig.feeFloorBps`. Same
    /// strict-required semantics as `equilibraFeeRampBps` for Equilibra
    /// traces.
    #[serde(default)]
    equilibraFeeFloorBps: Option<u64>,
    /// Fraction of cumulative LP unit-value growth the auto-repeg gate
    /// is allowed to spend on anchor moves, in BPS of `BPS = 10_000`.
    /// Mirrors `PoolConfig.repegShareBps`. Same strict-required semantics
    /// as `equilibraFeeRampBps`.
    #[serde(default)]
    equilibraRepegShareBps: Option<u64>,
    #[serde(default)]
    equilibraRepegStepWad: Option<String>,
    #[serde(default)]
    equilibraRepegThresholdWad: Option<String>,
    #[serde(default)]
    equilibraRepegThresholdToken1UpWad: Option<String>,
    #[serde(default)]
    equilibraRepegThresholdToken1DownWad: Option<String>,
    /// Donation-parachute activation multiplier K (`activation =
    /// K × active dead-band`). Mirrors the per-pool `_parachuteBandMult`
    /// storage slot exposed as the last field of `getFeeConfig()`.
    /// Optional: absent ⇒ the creation seed
    /// `REPEG_PARACHUTE_BAND_MULT_DEFAULT` (30), matching pools that
    /// never executed a timelock adjustment. On-chain range `[1, 255]`.
    #[serde(default)]
    parachuteBandMult: Option<u64>,
    #[serde(default)]
    equilibraProtocolFee0: Option<String>,
    #[serde(default)]
    equilibraProtocolFee1: Option<String>,
    #[serde(default)]
    equilibraE0: Option<String>,
    #[serde(default)]
    equilibraE1: Option<String>,
    #[serde(default)]
    equilibraEmaPrice: Option<String>,
    #[serde(default)]
    equilibraLastTimestamp: Option<String>,
    #[serde(default)]
    equilibraLastRecenterTimestamp: Option<String>,
    /// Canonical hybrid-invariant anchor price (WAD) = `price1 / price0`.
    #[serde(default)]
    equilibraAnchorPriceWad: Option<String>,
    /// Genesis LP unit value (quote-WAD per LP-token-WAD). Snapshot taken at
    /// the very first liquidity event; defines the base-line that the
    /// cumulative growth accumulator is measured against.
    #[serde(default)]
    equilibraLpUnitValueGenesisWad: Option<String>,
    /// Live high-water LP unit value (quote-WAD per LP-token-WAD). Updated by
    /// every swap accrual and re-anchored (without resetting growth) by every
    /// proportional liquidity event so that LP-quantity changes do not leak
    /// into the gain accumulator.
    #[serde(default)]
    equilibraLpUnitValueWad: Option<String>,
    /// Cumulative LP unit-value gain since genesis (quote-WAD). Strictly
    /// monotonic — never reset, not even by a successful repeg — and
    /// drives the auto-repeg gate via `threshold = vpGenesis +
    /// growth · keepBps / BPS`, where `keepBps = BPS - repegShareBps`.
    #[serde(default)]
    equilibraLpValueGrowthWad: Option<String>,
    /// Optional pre-seeded Equilibra donation buffer (parked LP shares
    /// on the pool's own address). Defaults to 0 so pre-donation traces
    /// stay valid; required to round-trip a snapshot taken after a
    /// donate step.
    equilibraDonationShares: Option<String>,
    #[serde(default)]
    curveA: Option<String>,
    #[serde(default)]
    curveGamma: Option<String>,
    #[serde(default)]
    curveD: Option<String>,
    #[serde(default)]
    curvePriceScale: Option<String>,
    #[serde(default)]
    curveMidFee: Option<String>,
    #[serde(default)]
    curveOutFee: Option<String>,
    #[serde(default)]
    curveFeeGamma: Option<String>,
    #[serde(default)]
    curveAdjustmentStepMin: Option<String>,
    #[serde(default)]
    curveAdjustmentStepMax: Option<String>,
    #[serde(default)]
    curveReservedProfitFraction: Option<String>,
    #[serde(default)]
    curveMaTime: Option<String>,
    #[serde(default)]
    curvePriceOracle: Option<String>,
    #[serde(default)]
    curveLastPrices: Option<String>,
    #[serde(default)]
    curveLastTimestamp: Option<String>,
    #[serde(default)]
    curveVirtualPrice: Option<String>,
    #[serde(default)]
    curveXcpProfit: Option<String>,
    #[serde(default)]
    curveLpXcpProfit: Option<String>,
    #[serde(default)]
    curveTotalSupply: Option<String>,
    #[serde(default)]
    curveMathMode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TraceStepInput {
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    tokenIn: Option<String>,
    #[serde(default)]
    amountIn: Option<String>,
    /// Target output amount for `swapExactOut` actions. Must be present
    /// (and `amountIn` absent) when `action == "swapExactOut"`.
    #[serde(default)]
    amountOut: Option<String>,
    #[serde(default)]
    amount0: Option<String>,
    #[serde(default)]
    amount1: Option<String>,
    #[serde(default)]
    liquidity: Option<String>,
    #[serde(default)]
    timestamp: Option<u64>,
}

#[derive(Debug, Serialize)]
struct TraceStateOut {
    reserve0: String,
    reserve1: String,
    totalSupply: String,
    e0: String,
    e1: String,
    protocolFee0: String,
    protocolFee1: String,
    anchorReserve0: String,
    anchorReserve1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    uniswapBlockTimestampLast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uniswapPrice0CumulativeLast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uniswapPrice1CumulativeLast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uniswapKLast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curveD: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curvePriceScale: Option<String>,
    /// Live Curve oracle EMA (`price_oracle()` on the Vyper pool).
    /// Decayed up to the trace step's timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    curvePriceOracle: Option<String>,
    /// Last spot price observed by the Curve oracle (`last_prices()`).
    #[serde(skip_serializing_if = "Option::is_none")]
    curveLastPrices: Option<String>,
    /// Timestamp of the last EMA update on the Curve oracle
    /// (`last_timestamp()`).
    #[serde(skip_serializing_if = "Option::is_none")]
    curveLastTimestamp: Option<String>,
    /// `virtual_price()` — LP-share virtual price (1e18 scale).
    #[serde(skip_serializing_if = "Option::is_none")]
    curveVirtualPrice: Option<String>,
    /// `xcp_profit()` — cumulative LP value growth multiplier.
    #[serde(skip_serializing_if = "Option::is_none")]
    curveXcpProfit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    curveLpXcpProfit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraEmaPrice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraLastTimestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraLastRecenterTimestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRepegStepWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRepegThresholdToken1UpWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRepegThresholdToken1DownWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraAnchorPriceWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraLpUnitValueGenesisWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraLpUnitValueWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraLpValueGrowthWad: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraDonationShares: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraFeeRampBps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraFeeFloorBps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRepegShareBps: Option<u64>,
}

#[derive(Debug, Serialize)]
struct TraceStepOut {
    index: usize,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokenIn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amountIn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amountOut: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount0: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount1: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    liquidity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mintedLiquidity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount0Out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount1Out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRecentered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibraRecenterBlockedBy: Option<String>,
    timestamp: u64,
    pre: TraceStateOut,
    post: TraceStateOut,
}

#[derive(Debug, Serialize)]
struct TraceOutput {
    mode: String,
    contextName: String,
    amm: String,
    baseSymbol: String,
    steps: Vec<TraceStepOut>,
    finalState: TraceStateOut,
}

/// Hot-path wrapper over the canonical `common::token_decimals` table
/// (single source of truth — do not duplicate the map here). Symbols in
/// the simulation are fixed at context-build time, so an unknown symbol
/// is an internal invariant violation: fail loudly instead of silently
/// assuming 18 decimals (which corrupts every USD conversion).
fn token_decimals(symbol: &str) -> u8 {
    common::token_decimals(symbol)
        .expect("token_decimals: symbol not in the canonical common:: map")
}

fn usd18_from_f64(usd: f64) -> u128 {
    if !usd.is_finite() || usd <= 0.0 {
        return 0;
    }
    (usd * 1e18f64).floor() as u128
}

fn usd_to_token_amount(usd_amount_1e18: u128, token_symbol: &str, oracle_price_1e18: u128) -> u128 {
    let decimals = token_decimals(token_symbol) as u32;
    if token_symbol == "USDT" {
        return usd_amount_1e18 / 1_000_000_000_000u128;
    }
    if oracle_price_1e18 == 0 {
        return 0;
    }
    mul_div_floor(usd_amount_1e18, pow10_u128(decimals), oracle_price_1e18)
}

fn token_to_usd_amount_1e18(
    token_amount: u128,
    token_symbol: &str,
    oracle_price_1e18: u128,
) -> u128 {
    let decimals = token_decimals(token_symbol) as u32;
    if token_symbol == "USDT" {
        return mul_div_floor(token_amount, 1_000_000_000_000u128, 1u128);
    }
    let div = pow10_u128(decimals);
    if div == 0 {
        return 0;
    }
    mul_div_floor(token_amount, oracle_price_1e18, div)
}

#[inline]
fn u512_to_f64(v: U512) -> f64 {
    // Convert little-endian 64-bit limbs into f64 without intermediate integer narrowing.
    let mut out = 0.0f64;
    for i in (0..8).rev() {
        out = out * 18_446_744_073_709_551_616.0 + (v.0[i] as f64); // 2^64
    }
    out
}

fn pow10_u128(exp: u32) -> u128 {
    let mut out = 1u128;
    for _ in 0..exp {
        out = out.checked_mul(10u128).expect("pow10_u128 overflow");
    }
    out
}

fn bigint_pref(v: u128) -> String {
    format!("bigint:{}", v)
}

/// Compute informational "anchor balances" in raw token units for a pool that
/// has reserves `(reserve0, reserve1)` and anchor price `anchor_price_wad`
/// (price of 1 WAD-scaled token0 in WAD-scaled token1). These balances
/// Stateless exact-in quoter — **fee-inclusive**, mirroring the
/// stateful `equilibra_swap_stateful` output bit-for-bit. The
/// arbitrageur model uses this to evaluate profitability; if the
/// quote skipped the fee, every arb would over-estimate output by
/// `feeWad / WAD` and over-trade on every cycle, driving the pool
/// into a `priceScale` runaway (see the
/// `stateless_quote_matches_stateful_output_after_fees` regression
/// in `equilibra::ema_cap_tests`).
fn quote_equilibra_exact_in_stateless(
    cfg: &equilibra::EquilibraStatefulConfig,
    reserve0: u128,
    reserve1: u128,
    price_scale_wad: u128,
    token_in: &str,
    amount_in: u128,
) -> Result<u128> {
    if amount_in == 0 {
        return Ok(0);
    }
    let zero_for_one = if token_in.eq_ignore_ascii_case(cfg.token0()) {
        true
    } else if token_in.eq_ignore_ascii_case(cfg.token1()) {
        false
    } else {
        return Err(anyhow!("equilibra_quote: tokenIn not in pool"));
    };
    let price_scale = U256::from(price_scale_wad);
    let x_wad = U256::from(reserve1) * cfg.token1_scale;
    let y_wad = U256::from(reserve0) * cfg.token0_scale;
    if x_wad.is_zero() || y_wad.is_zero() {
        return Ok(0);
    }
    // Asymmetric coord change: xMath = xWad, yMath = yWad·WAD/priceScale.
    let (x_math, y_math) = equilibra_math::to_math_space(x_wad, y_wad, price_scale)?;
    let (in_scale, out_scale) = if zero_for_one {
        (cfg.token0_scale, cfg.token1_scale)
    } else {
        (cfg.token1_scale, cfg.token0_scale)
    };
    // Apply the dynamic fee EXACTLY as the stateful executor does,
    // before lifting input into math space. The on-chain pool
    // subtracts `fee_amount = amount_in · feeWad / WAD` from
    // `amount_in` and routes only `clean_amount_in` through the
    // curve. Quoting without the fee gives the arb an inflated
    // estimate equal to `1 / (1 − feeWad/WAD)` × the true output,
    // which is the divergence pinned by
    // `equilibra::stateless_quote_matches_stateful_output_after_fees`.
    let stateless_state = equilibra::EquilibraStatefulState {
        reserve0,
        reserve1,
        price_scale_wad,
        ..equilibra::EquilibraStatefulState::empty()
    };
    let fee_wad_effective =
        equilibra::resolve_dynamic_fee_wad_from_cp(cfg, &stateless_state, zero_for_one, amount_in)?;
    let fee_amount = equilibra_math::mul_div_floor(
        U256::from(amount_in),
        U256::from(fee_wad_effective),
        U256::from(equilibra_math::WAD),
    )?;
    let amount_in_after_fee_u = U256::from(amount_in).saturating_sub(fee_amount);
    let amount_in_after_fee: u128 = amount_in_after_fee_u
        .try_into()
        .map_err(|_| anyhow!("amountInPostFee exceeds u128"))?;
    if amount_in_after_fee == 0 {
        return Ok(0);
    }
    let amount_in_wad = U256::from(amount_in_after_fee) * in_scale;
    if amount_in_wad.is_zero() {
        return Ok(0);
    }
    // Asymmetric lift: zfo (quote) → yMath = divWad; !zfo (base) → xMath identity.
    let amount_in_math = if zero_for_one {
        equilibra_math::mul_div_floor(amount_in_wad, U256::from(equilibra_math::WAD), price_scale)?
    } else {
        amount_in_wad
    };
    if amount_in_math.is_zero() {
        return Ok(0);
    }
    let amount_out_wad = if zero_for_one {
        let (out_math, _) = equilibra_math::quote_exact_in_forward(
            y_math,
            x_math,
            amount_in_math,
            U256::from(cfg.a_wad),
            U256::from(cfg.lambda_wad),
        )?;
        if out_math >= x_math {
            return Ok(0);
        }
        // Output is xMath → token1 (base) wad identity.
        out_math
    } else {
        let (out_math, _) = equilibra_math::quote_exact_in_forward(
            x_math,
            y_math,
            amount_in_math,
            U256::from(cfg.a_wad),
            U256::from(cfg.lambda_wad),
        )?;
        if out_math >= y_math {
            return Ok(0);
        }
        // Output is yMath → token0 (quote) wad: math · priceScale / WAD (floor).
        equilibra_math::mul_wad(out_math, price_scale)?
    };
    let out_raw = amount_out_wad / out_scale;
    out_raw
        .try_into()
        .map_err(|_| anyhow!("amountOut exceeds u128"))
}

/// Stateless exact-out quoter — **fee-inclusive**, mirrors the
/// stateful `equilibra_swap_stateful_exact_out` output bit-for-bit.
/// On-chain exact-out fee is grossed up on the input side:
/// `amount_in = clean_in / (1 − feeWad/WAD)` (ceil), so a fee-free
/// quote would tell the arbitrageur the trade needs LESS input than
/// it actually does. The earlier fee-free version of this helper
/// drove the simulator's `priceScale` runaway alongside the
/// equally fee-free exact-in path.
fn quote_equilibra_exact_out_stateless(
    cfg: &equilibra::EquilibraStatefulConfig,
    reserve0: u128,
    reserve1: u128,
    price_scale_wad: u128,
    token_in: &str,
    amount_out: u128,
) -> Result<u128> {
    if amount_out == 0 {
        return Ok(0);
    }
    let zero_for_one = if token_in.eq_ignore_ascii_case(cfg.token0()) {
        true
    } else if token_in.eq_ignore_ascii_case(cfg.token1()) {
        false
    } else {
        return Err(anyhow!("equilibra_quote_out: tokenIn not in pool"));
    };
    let price_scale = U256::from(price_scale_wad);
    let x_wad = U256::from(reserve1) * cfg.token1_scale;
    let y_wad = U256::from(reserve0) * cfg.token0_scale;
    if x_wad.is_zero() || y_wad.is_zero() {
        return Ok(0);
    }
    // Asymmetric coord change: xMath = xWad, yMath = yWad·WAD/priceScale.
    let (x_math, y_math) = equilibra_math::to_math_space(x_wad, y_wad, price_scale)?;
    let (in_scale, out_scale) = if zero_for_one {
        (cfg.token0_scale, cfg.token1_scale)
    } else {
        (cfg.token1_scale, cfg.token0_scale)
    };
    let amount_out_wad = U256::from(amount_out) * out_scale;
    if amount_out_wad.is_zero() {
        return Ok(0);
    }
    // Asymmetric output lift (ceil for pool-favourable rounding):
    //   zfo: token1 (base) output → xMath identity.
    //   !zfo: token0 (quote) output → yMath = mulDivUp(out, WAD, priceScale).
    let amount_out_math = if zero_for_one {
        amount_out_wad
    } else {
        equilibra_math::mul_div_ceil(amount_out_wad, U256::from(equilibra_math::WAD), price_scale)?
    };
    if amount_out_math.is_zero() {
        return Ok(0);
    }
    let amount_in_wad = if zero_for_one {
        let (in_math, _) = equilibra_math::quote_exact_out_forward(
            y_math,
            x_math,
            amount_out_math,
            U256::from(cfg.a_wad),
            U256::from(cfg.lambda_wad),
        )?;
        // Input on yMath → token0 (quote) wad: math · priceScale / WAD (ceil).
        equilibra_math::mul_div_ceil(in_math, price_scale, U256::from(equilibra_math::WAD))?
    } else {
        let (in_math, _) = equilibra_math::quote_exact_out_forward(
            x_math,
            y_math,
            amount_out_math,
            U256::from(cfg.a_wad),
            U256::from(cfg.lambda_wad),
        )?;
        // Input on xMath → token1 (base) wad identity.
        in_math
    };
    let clean_in_raw_u = amount_in_wad / in_scale;
    let clean_in_raw: u128 = clean_in_raw_u
        .try_into()
        .map_err(|_| anyhow!("amountIn exceeds u128"))?;
    if clean_in_raw == 0 {
        return Ok(0);
    }
    // Gross up by the dynamic fee (resolved from the POST-swap state
    // is what the stateful executor does — but for arb estimation we
    // approximate with the PRE-swap state, same as exact-in). The
    // ceil rounding matches the contract's pool-favourable bias:
    // `amount_in = ceil(clean_in × WAD / (WAD − feeWad))`.
    let stateless_state = equilibra::EquilibraStatefulState {
        reserve0,
        reserve1,
        price_scale_wad,
        ..equilibra::EquilibraStatefulState::empty()
    };
    let fee_wad_effective = equilibra::resolve_dynamic_fee_wad_from_cp(
        cfg,
        &stateless_state,
        zero_for_one,
        clean_in_raw,
    )?;
    let wad_u = U256::from(equilibra_math::WAD);
    let denom = wad_u - U256::from(fee_wad_effective);
    if denom.is_zero() {
        return Err(anyhow!("equilibra_quote_out: fee == WAD"));
    }
    let gross_in_u = equilibra_math::mul_div_ceil(U256::from(clean_in_raw), wad_u, denom)?;
    gross_in_u
        .try_into()
        .map_err(|_| anyhow!("amountIn (gross) exceeds u128"))
}

/// describe the balanced-at-anchor composition holding the same total value
/// as the current reserves and are only used for CSV/reporting backwards
/// compatibility — the canonical anchor is now `anchor_price_wad` itself.
fn derive_legacy_anchor_balances(
    reserve0: u128,
    reserve1: u128,
    anchor_price_wad: u128,
    token0_decimals: u8,
    token1_decimals: u8,
) -> (u128, u128) {
    if anchor_price_wad == 0 {
        return (0, 0);
    }
    let scale0 = pow10_u128(18u32.saturating_sub(token0_decimals as u32));
    let scale1 = pow10_u128(18u32.saturating_sub(token1_decimals as u32));
    if scale0 == 0 || scale1 == 0 {
        return (0, 0);
    }
    let x_math = reserve0.saturating_mul(scale0);
    let y_math = reserve1.saturating_mul(scale1);
    // value_in_y_wad = x_math * anchor_price_wad / WAD + y_math
    let value_from_x = mul_div_floor(x_math, anchor_price_wad, PRECISION);
    let total_value_in_y = value_from_x.saturating_add(y_math);
    let anchor_y_math = total_value_in_y / 2;
    // anchor_x_math = totalValue * WAD / (2 * anchor_price_wad)
    let anchor_x_math = mul_div_floor(
        total_value_in_y,
        PRECISION,
        anchor_price_wad.saturating_mul(2).max(1),
    );
    let anchor0 = anchor_x_math / scale0;
    let anchor1 = anchor_y_math / scale1;
    (anchor0, anchor1)
}

fn emit_benchmark_event(event_type: &str, payload: Value) {
    let evt = json!({
        "type": event_type,
        "timestamp": now_iso_utc(),
        "payload": payload
    });
    println!("{}{}", BENCHMARK_EVENT_PREFIX, evt);
}

fn amount_to_float(amount: u128, token_symbol: &str) -> f64 {
    let decimals = token_decimals(token_symbol) as i32;
    amount as f64 / 10f64.powi(decimals)
}

fn price_from_amounts_1e18(
    amount_num: u128,
    token_num_symbol: &str,
    amount_den: u128,
    token_den_symbol: &str,
) -> u128 {
    if amount_num == 0 || amount_den == 0 {
        return 0;
    }
    let num = amount_to_float(amount_num, token_num_symbol);
    let den = amount_to_float(amount_den, token_den_symbol);
    if !num.is_finite() || !den.is_finite() || den <= 0.0 {
        return 0;
    }
    let price = num / den;
    if !price.is_finite() || price <= 0.0 {
        return 0;
    }
    let scaled = price * 1e18f64;
    if !scaled.is_finite() || scaled <= 0.0 {
        return 0;
    }
    if scaled >= u128::MAX as f64 {
        return u128::MAX;
    }
    scaled.floor() as u128
}

fn to_i128_saturated(v: u128) -> i128 {
    if v > i128::MAX as u128 {
        i128::MAX
    } else {
        v as i128
    }
}

fn oracle_price_to_1e18_rounded(oracle_price: f64) -> u128 {
    if !oracle_price.is_finite() || oracle_price <= 0.0 {
        return 0;
    }
    let scaled = (oracle_price * 1e18f64).round();
    if !scaled.is_finite() || scaled <= 0.0 {
        return 0;
    }
    if scaled >= u128::MAX as f64 {
        return u128::MAX;
    }
    scaled as u128
}

fn normalize_token_amount_to_1e18(amount: u128, token_symbol: &str) -> U256 {
    let decimals = token_decimals(token_symbol) as u32;
    if decimals == 18 {
        return U256::from(amount);
    }
    if decimals < 18 {
        let scale = pow10_u128(18 - decimals);
        return U256::from(amount) * U256::from(scale);
    }
    let scale = pow10_u128(decimals - 18);
    U256::from(amount) / U256::from(scale)
}

fn build_user_slippage_basis(
    amount_in: u128,
    token_in_symbol: &str,
    oracle_price: f64,
) -> UserSlippageBasis {
    let oracle_price_scaled = oracle_price_to_1e18_rounded(oracle_price);
    let amount_in_norm = normalize_token_amount_to_1e18(amount_in, token_in_symbol);

    let expected_output_norm_1e18 = if oracle_price_scaled == 0 {
        U256::zero()
    } else if token_in_symbol == "USDT" {
        (amount_in_norm * U256::from(PRECISION)) / U256::from(oracle_price_scaled)
    } else {
        (amount_in_norm * U256::from(oracle_price_scaled)) / U256::from(PRECISION)
    };

    let amount_usd = if oracle_price_scaled > 0 {
        token_to_usd_amount_1e18(amount_in, token_in_symbol, oracle_price_scaled) as f64 / 1e18f64
    } else {
        0.0
    };

    UserSlippageBasis {
        expected_output_norm_1e18,
        amount_usd,
    }
}

fn calculate_user_slippage_bps_from_basis(
    amount_out: u128,
    token_out_symbol: &str,
    basis: &UserSlippageBasis,
) -> f64 {
    if basis.expected_output_norm_1e18.is_zero() {
        return 0.0;
    }

    let amount_out_norm = normalize_token_amount_to_1e18(amount_out, token_out_symbol);
    let (negative, diff_abs) = if amount_out_norm > basis.expected_output_norm_1e18 {
        (true, amount_out_norm - basis.expected_output_norm_1e18)
    } else {
        (false, basis.expected_output_norm_1e18 - amount_out_norm)
    };

    if diff_abs.is_zero() {
        return 0.0;
    }

    // Compute |slippage| in BPS on integer domain first, then convert to f64 once.
    // This avoids precision loss from dividing two very large f64 values.
    const SLIPPAGE_BPS_SCALE: u128 = 1_000_000_000u128;
    let numerator = U512::from(diff_abs) * U512::from(BPS_DENOM) * U512::from(SLIPPAGE_BPS_SCALE);
    let denominator = U512::from(basis.expected_output_norm_1e18);
    if denominator.is_zero() {
        return 0.0;
    }
    let scaled_bps = numerator / denominator;
    let abs_slippage_bps = u512_to_f64(scaled_bps) / SLIPPAGE_BPS_SCALE as f64;
    if !abs_slippage_bps.is_finite() {
        return 0.0;
    }

    let signed = if negative { -1.0 } else { 1.0 };
    let slippage_bps = signed * abs_slippage_bps;
    if slippage_bps.is_finite() {
        slippage_bps
    } else {
        0.0
    }
}

fn deterministic_draw(sample_index: u64, modulo: usize) -> usize {
    if modulo == 0 {
        return 0;
    }
    let mut x = sample_index as u32;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    (x as usize) % modulo
}

fn slippage_histogram_bucket(slippage_bps: f64) -> usize {
    let hi = (SLIPPAGE_MAX_BPS - 1) as f64;
    let clamped = slippage_bps.max(SLIPPAGE_MIN_BPS as f64).min(hi);
    let idx = ((clamped - SLIPPAGE_MIN_BPS as f64) / SLIPPAGE_BPS_PER_BUCKET as f64).floor() as i64;
    idx.clamp(0, (SLIPPAGE_HISTOGRAM_BUCKET_COUNT as i64) - 1) as usize
}

fn trade_size_bucket_index(trade_size_reserve_in_bps: u64, bucket_edges_bps: &[u64]) -> usize {
    debug_assert!(bucket_edges_bps.len() >= 2);
    let bucket_count = bucket_edges_bps.len() - 1;
    for i in 0..bucket_count {
        let lo = bucket_edges_bps[i];
        let hi = bucket_edges_bps[i + 1];
        if trade_size_reserve_in_bps >= lo && trade_size_reserve_in_bps < hi {
            return i;
        }
    }
    if trade_size_reserve_in_bps >= bucket_edges_bps[bucket_count] {
        return bucket_count - 1;
    }
    0
}

/// Compute `|2·p − 1|` in BPS where `p = v_base / (v_base + v_quote)`.
/// `spot_price_1e18` is `price(base in quote)` (USDT per base) at WAD
/// precision — the orientation `mid_spot_from_probe_pair` produces for
/// every layout — and is applied to whichever slot holds the BASE
/// reserve (`token0_symbol != "USDT"` ⇒ slot 0 is base). Valuing by
/// base/quote meaning rather than slot number keeps the metric
/// comparable across base-in-slot-0 (Equilibra) and quote-in-slot-0
/// (Curve / Uniswap V2) layouts, and a mirrored pool state produces the
/// identical skew. Returns 0 when spot or reserves are degenerate.
fn compute_value_skew_bps(
    reserve0: u128,
    reserve1: u128,
    token0_symbol: &str,
    token1_symbol: &str,
    spot_price_1e18: u128,
) -> u64 {
    if spot_price_1e18 == 0 {
        return 0;
    }
    let r0_norm = normalize_token_amount_to_1e18(reserve0, token0_symbol);
    let r1_norm = normalize_token_amount_to_1e18(reserve1, token1_symbol);
    if r0_norm.is_zero() && r1_norm.is_zero() {
        return 0;
    }
    let (base_norm, quote_norm) = if token0_symbol == "USDT" {
        (r1_norm, r0_norm)
    } else {
        (r0_norm, r1_norm)
    };
    let v0 = base_norm * U256::from(spot_price_1e18) / U256::from(PRECISION);
    let v1 = quote_norm;
    let total = v0 + v1;
    if total.is_zero() {
        return 0;
    }
    let p_bps = (v0 * U256::from(BPS_DENOM)) / total;
    let p_bps_i = p_bps.as_u128() as i128;
    let diff = (2 * p_bps_i - BPS_DENOM as i128).abs();
    diff.min(BPS_DENOM as i128) as u64
}

/// Same shape as `calculate_user_slippage_bps_from_basis` but compares
/// the executed output against the user's hypothetical output at the
/// pool's pre-trade spot price (i.e. pure curve impact, no fee, no
/// oracle-vs-pool drift). Returns signed BPS where positive means the
/// curve gave less than the spot-extrapolated amount.
fn calculate_slip_vs_spot_bps(
    amount_in: u128,
    amount_out: u128,
    token_in_symbol: &str,
    token_out_symbol: &str,
    spot_price_1e18: u128,
) -> f64 {
    if spot_price_1e18 == 0 || amount_in == 0 {
        return 0.0;
    }
    let amount_in_norm = normalize_token_amount_to_1e18(amount_in, token_in_symbol);
    // expected_at_spot is what the user would receive if the pool kept
    // its spot price flat throughout the trade (frictionless reference).
    let expected_at_spot_norm = if token_in_symbol == "USDT" {
        (amount_in_norm * U256::from(PRECISION)) / U256::from(spot_price_1e18)
    } else {
        (amount_in_norm * U256::from(spot_price_1e18)) / U256::from(PRECISION)
    };
    if expected_at_spot_norm.is_zero() {
        return 0.0;
    }
    let actual_norm = normalize_token_amount_to_1e18(amount_out, token_out_symbol);
    let (negative, diff_abs) = if actual_norm > expected_at_spot_norm {
        (true, actual_norm - expected_at_spot_norm)
    } else {
        (false, expected_at_spot_norm - actual_norm)
    };
    if diff_abs.is_zero() {
        return 0.0;
    }
    const SLIPPAGE_BPS_SCALE: u128 = 1_000_000_000u128;
    let numerator = U512::from(diff_abs) * U512::from(BPS_DENOM) * U512::from(SLIPPAGE_BPS_SCALE);
    let denominator = U512::from(expected_at_spot_norm);
    if denominator.is_zero() {
        return 0.0;
    }
    let scaled_bps = numerator / denominator;
    let abs = u512_to_f64(scaled_bps) / SLIPPAGE_BPS_SCALE as f64;
    if !abs.is_finite() {
        return 0.0;
    }
    let signed = if negative { -1.0 } else { 1.0 };
    signed * abs
}

#[allow(clippy::too_many_arguments)]
fn record_user_slippage_sample(
    state: &mut UserSlippageState,
    pool: &PoolState,
    ts: u64,
    direction: &str,
    token_in_symbol: &str,
    token_out_symbol: &str,
    amount_in: u128,
    amount_out: u128,
    trade_size_reserve_in_bps: u64,
    basis: &UserSlippageBasis,
    spot_price_1e18_pre: u128,
    oracle_price_1e18: u128,
) {
    let slippage_bps = calculate_user_slippage_bps_from_basis(amount_out, token_out_symbol, basis);

    state.aggregate_count = state.aggregate_count.saturating_add(1);
    state.aggregate_sum += slippage_bps;
    state.aggregate_sum_squares += slippage_bps * slippage_bps;
    state.aggregate_min = state.aggregate_min.min(slippage_bps);
    state.aggregate_max = state.aggregate_max.max(slippage_bps);

    let bucket = slippage_histogram_bucket(slippage_bps);
    state.histogram[bucket] = state.histogram[bucket].saturating_add(1);

    let size_bucket = trade_size_bucket_index(trade_size_reserve_in_bps, &state.bucket_edges_bps);
    state.trade_size_sum_bps[size_bucket] += slippage_bps;
    state.trade_size_count[size_bucket] = state.trade_size_count[size_bucket].saturating_add(1);

    // Resolve the reservoir slot BEFORE materialising the sample: once the
    // 1000-slot reservoir is warm, the keep probability drops to
    // ~1000/aggregate_count, so building the 9-String `SlippageSample`
    // (plus the U512 slip-vs-spot and value-skew metrics) for every
    // discarded sample wastes tens of millions of allocations per run.
    // The draw depends only on `aggregate_count` (already incremented
    // above) and the moved metrics are pure functions of the arguments,
    // so the stored reservoir content is bit-identical to the historical
    // build-then-discard order.
    enum ReservoirSlot {
        Push,
        Replace(usize),
    }
    let slot = if state.samples.len() < MAX_SLIPPAGE_SAMPLES {
        ReservoirSlot::Push
    } else {
        let total_samples = usize::try_from(state.aggregate_count).unwrap_or(usize::MAX);
        let draw = deterministic_draw(state.aggregate_count, total_samples);
        if draw < MAX_SLIPPAGE_SAMPLES {
            ReservoirSlot::Replace(draw)
        } else {
            return;
        }
    };

    let staleness_bps = if oracle_price_1e18 == 0 {
        0.0
    } else {
        // Signed: positive = pool spot lags below oracle (sell-side disadvantage,
        // buy-side advantage relative to oracle).
        let diff = oracle_price_1e18 as i128 - spot_price_1e18_pre as i128;
        (diff as f64) * (BPS_DENOM as f64) / (oracle_price_1e18 as f64)
    };

    let slip_vs_spot_bps = calculate_slip_vs_spot_bps(
        amount_in,
        amount_out,
        token_in_symbol,
        token_out_symbol,
        spot_price_1e18_pre,
    );

    let d_pre_bps = compute_value_skew_bps(
        pool.reserve0,
        pool.reserve1,
        &pool.token0_symbol,
        &pool.token1_symbol,
        spot_price_1e18_pre,
    );

    let sample = SlippageSample {
        timestamp: ts,
        direction: direction.to_string(),
        token_in_symbol: token_in_symbol.to_string(),
        token_out_symbol: token_out_symbol.to_string(),
        amount_in: bigint_pref(amount_in),
        amount_out: bigint_pref(amount_out),
        amount_usd: basis.amount_usd,
        trade_size_reserve_in_bps,
        slippage_bps,
        slip_vs_spot_bps,
        staleness_bps,
        reserve0_pre: bigint_pref(pool.reserve0),
        reserve1_pre: bigint_pref(pool.reserve1),
        spot_price_wad_pre: bigint_pref(spot_price_1e18_pre),
        oracle_price_wad: bigint_pref(oracle_price_1e18),
        fee_bps: pool.fee_bps,
        d_pre_bps,
    };

    match slot {
        ReservoirSlot::Push => state.samples.push(sample),
        ReservoirSlot::Replace(draw) => state.samples[draw] = sample,
    }
}

fn build_user_quote_plan_for_context(
    pool: &PoolState,
    base_symbol: &str,
    oracle_price_1e18: u128,
    slippage_reference_oracle: f64,
    usd_amount_1e18: u128,
    initial_side_liquidity_usd_1e18: u128,
    direction: &str,
) -> Result<Option<UserQuotePlan>> {
    if initial_side_liquidity_usd_1e18 == 0 {
        return Err(anyhow!(
            "initial side liquidity in USD is zero; cannot compute trade-size buckets"
        ));
    }

    let is_buy = match direction {
        "buy" => true,
        "sell" => false,
        other => {
            return Err(anyhow!(
                "unsupported shared user quote direction '{}', expected 'buy' or 'sell'",
                other
            ))
        }
    };
    let token_in = if is_buy {
        "USDT".to_string()
    } else {
        base_symbol.to_string()
    };
    let token_out = if is_buy {
        base_symbol.to_string()
    } else {
        "USDT".to_string()
    };
    let amount_in = usd_to_token_amount(usd_amount_1e18, &token_in, oracle_price_1e18);
    if amount_in == 0 {
        return Ok(None);
    }

    let trade_size_bps_u128 =
        mul_div_floor(usd_amount_1e18, BPS_DENOM, initial_side_liquidity_usd_1e18);
    let trade_size_bps = u64::try_from(trade_size_bps_u128).with_context(|| {
        format!(
            "trade_size_bps exceeds u64 for {} (usd_amount_1e18={}, initial_side_liquidity_usd_1e18={}, bps={})",
            pool.context_name, usd_amount_1e18, initial_side_liquidity_usd_1e18, trade_size_bps_u128
        )
    })?;
    let basis = build_user_slippage_basis(amount_in, &token_in, slippage_reference_oracle);

    Ok(Some(UserQuotePlan {
        token_in,
        token_out,
        amount_in,
        trade_size_bps,
        basis,
        direction: if is_buy {
            "buy".to_string()
        } else {
            "sell".to_string()
        },
    }))
}

/// Dust-probe quote pair shared by the user mid-spot estimate and the
/// arbitrageur trigger check within a single (tick, context) visit.
/// Quotes are pure functions of the frozen pool state and the two probe
/// amounts (both derived from the tick's oracle price), so evaluating
/// the pair once and reusing the raw outputs is bit-identical to
/// re-quoting at every site — each site keeps its own zero-output and
/// derived-value handling. Previously the same two quotes were issued
/// up to three times per tick per context (mid-spot for the buy-plan,
/// mid-spot for the sell-plan, arb trigger probes); on Equilibra/Curve
/// shards each probe is a full kernel solve, so the dedup removes up to
/// two thirds of the steady-state per-tick quoting work.
struct ProbeQuotePair {
    probe_quote: u128,
    probe_base: u128,
    buy_out: u128,
    sell_out: u128,
}

/// Compute the dust-probe pair once. Returns `Ok(None)` when either
/// probe amount rounds to zero (the callers' previous early-exit).
/// `ensure_curve_d` runs before the quotes so a dirty Curve invariant
/// is settled exactly as it was when each site quoted independently.
fn compute_probe_quote_pair(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    base_symbol: &str,
    oracle_price_1e18: u128,
    probe_usd_1e18: u128,
) -> Result<Option<ProbeQuotePair>> {
    if oracle_price_1e18 == 0 || probe_usd_1e18 == 0 {
        return Ok(None);
    }
    let probe_quote = usd_to_token_amount(probe_usd_1e18, "USDT", oracle_price_1e18);
    let probe_base = usd_to_token_amount(probe_usd_1e18, base_symbol, oracle_price_1e18);
    if probe_quote == 0 || probe_base == 0 {
        return Ok(None);
    }
    ensure_curve_d(pool, quoter)
        .with_context(|| format!("ensure curve D for {}", pool.context_name))?;
    let buy_out = quote_exact_input(pool, quoter, "USDT", probe_quote)
        .with_context(|| format!("probe buy quote failed for {}", pool.context_name))?;
    let sell_out = quote_exact_input(pool, quoter, base_symbol, probe_base)
        .with_context(|| format!("probe sell quote failed for {}", pool.context_name))?;
    Ok(Some(ProbeQuotePair {
        probe_quote,
        probe_base,
        buy_out,
        sell_out,
    }))
}

/// Approximates the pool's pre-trade mid spot price as the average of
/// the cached dust-sized buy/sell probe quotes. Returns 0 when either
/// probe produced no output (e.g. degenerate reserves) so the caller
/// can fall back to the oracle — same contract as the historical
/// `pool_mid_spot_1e18` this arithmetic was lifted from.
fn mid_spot_from_probe_pair(pair: &ProbeQuotePair, base_symbol: &str) -> u128 {
    if pair.buy_out == 0 || pair.sell_out == 0 {
        return 0;
    }
    // buy_price = USDT_in / base_out = price(base in USDT) at WAD.
    let buy_price = price_from_amounts_1e18(pair.probe_quote, "USDT", pair.buy_out, base_symbol);
    // sell_price = USDT_out / base_in = price(base in USDT) at WAD.
    let sell_price = price_from_amounts_1e18(pair.sell_out, "USDT", pair.probe_base, base_symbol);
    if buy_price == 0 || sell_price == 0 {
        return 0;
    }
    let mid = (U256::from(buy_price) + U256::from(sell_price)) / U256::from(2);
    mid.as_u128()
}

fn execute_user_quote_plan_for_context(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    user_slippage_states: &mut HashMap<String, UserSlippageState>,
    ts: u64,
    plan: &UserQuotePlan,
    oracle_price_1e18: u128,
    // Pre-trade mid spot derived from the tick's cached probe pair
    // (`mid_spot_from_probe_pair`). Passing it in lets both directions
    // share one probe evaluation; the pool state is frozen between the
    // probe fill and this quote (debug-asserted below), so the value is
    // bit-identical to an inline re-probe.
    spot_price_1e18_pre: u128,
) -> Result<()> {
    let ctx_name = pool.context_name.clone();
    ensure_curve_d(pool, quoter).with_context(|| format!("ensure curve D for {}", ctx_name))?;

    // Snapshot reserves BEFORE the user quote so the breakdown reflects
    // the actual pool state the user would see.
    let reserve0_pre = pool.reserve0;
    let reserve1_pre = pool.reserve1;

    let amount_out = quote_exact_input(pool, quoter, &plan.token_in, plan.amount_in)
        .with_context(|| format!("user quote failed for {}", pool.context_name))?;

    debug_assert_eq!(
        reserve0_pre, pool.reserve0,
        "user quote must not mutate state"
    );
    debug_assert_eq!(
        reserve1_pre, pool.reserve1,
        "user quote must not mutate state"
    );

    let state = user_slippage_states
        .get_mut(&pool.context_name)
        .ok_or_else(|| anyhow!("missing user slippage state for {}", pool.context_name))?;
    record_user_slippage_sample(
        state,
        pool,
        ts,
        &plan.direction,
        &plan.token_in,
        &plan.token_out,
        plan.amount_in,
        amount_out,
        plan.trade_size_bps,
        &plan.basis,
        spot_price_1e18_pre,
        oracle_price_1e18,
    );

    Ok(())
}

fn integer_sqrt(n: u128) -> u128 {
    if n <= 1 {
        return n;
    }
    let mut x0 = n / 2;
    let mut x1 = (x0 + n / x0) / 2;
    while x1 < x0 {
        x0 = x1;
        x1 = (x0 + n / x0) / 2;
    }
    x0
}

fn parse_u128_decimal(s: &str, field: &str) -> Result<u128> {
    s.parse::<u128>()
        .with_context(|| format!("parse {} as u128: {}", field, s))
}

fn parse_u128_opt_decimal(v: Option<&String>, field: &str) -> Result<Option<u128>> {
    match v {
        Some(s) => Ok(Some(parse_u128_decimal(s, field)?)),
        None => Ok(None),
    }
}

fn parse_u64_opt_decimal(v: Option<&String>, field: &str) -> Result<Option<u64>> {
    let Some(raw) = v else {
        return Ok(None);
    };
    let parsed = parse_u128_decimal(raw, field)?;
    if parsed > u64::MAX as u128 {
        return Err(anyhow!("{} overflows u64: {}", field, raw));
    }
    Ok(Some(parsed as u64))
}

fn parse_u32_opt_decimal(v: Option<&String>, field: &str) -> Result<Option<u32>> {
    let Some(raw) = v else {
        return Ok(None);
    };
    let parsed = parse_u128_decimal(raw, field)?;
    if parsed > u32::MAX as u128 {
        return Err(anyhow!("{} overflows u32: {}", field, raw));
    }
    Ok(Some(parsed as u32))
}

fn trace_state_out(pool: &PoolState) -> TraceStateOut {
    TraceStateOut {
        reserve0: pool.reserve0.to_string(),
        reserve1: pool.reserve1.to_string(),
        totalSupply: pool.total_supply.to_string(),
        e0: pool.e0.to_string(),
        e1: pool.e1.to_string(),
        protocolFee0: pool.protocol_fee0.to_string(),
        protocolFee1: pool.protocol_fee1.to_string(),
        anchorReserve0: pool.anchor0.to_string(),
        anchorReserve1: pool.anchor1.to_string(),
        uniswapBlockTimestampLast: pool
            .uni
            .as_ref()
            .map(|u| u.block_timestamp_last.to_string()),
        uniswapPrice0CumulativeLast: pool.uni.as_ref().map(|u| u.price0_cumulative_last.clone()),
        uniswapPrice1CumulativeLast: pool.uni.as_ref().map(|u| u.price1_cumulative_last.clone()),
        uniswapKLast: pool.uni.as_ref().map(|u| u.k_last.clone()),
        curveD: pool.curve.as_ref().map(|c| c.d.to_string()),
        curvePriceScale: pool.curve.as_ref().map(|c| c.price_scale.to_string()),
        curvePriceOracle: pool.curve.as_ref().map(|c| c.price_oracle.to_string()),
        curveLastPrices: pool.curve.as_ref().map(|c| c.last_prices.to_string()),
        curveLastTimestamp: pool.curve.as_ref().map(|c| c.last_timestamp.to_string()),
        curveVirtualPrice: pool.curve.as_ref().map(|c| c.virtual_price.to_string()),
        curveXcpProfit: pool.curve.as_ref().map(|c| c.xcp_profit.to_string()),
        curveLpXcpProfit: pool.curve.as_ref().map(|c| c.lp_xcp_profit.to_string()),
        equilibraEmaPrice: if pool.amm == AmmKind::Equilibra {
            Some(pool.ema_price.to_string())
        } else {
            None
        },
        equilibraLastTimestamp: if pool.amm == AmmKind::Equilibra {
            Some(pool.last_timestamp.to_string())
        } else {
            None
        },
        equilibraLastRecenterTimestamp: if pool.amm == AmmKind::Equilibra {
            Some(pool.last_recenter_ts.to_string())
        } else {
            None
        },
        equilibraRepegStepWad: if let Some(eq) = pool.eq.as_ref() {
            Some(eq.repeg_step_wad.to_string())
        } else {
            None
        },
        equilibraRepegThresholdToken1UpWad: if let Some(eq) = pool.eq.as_ref() {
            Some(eq.repeg_threshold_token1_up_wad.to_string())
        } else {
            None
        },
        equilibraRepegThresholdToken1DownWad: if let Some(eq) = pool.eq.as_ref() {
            Some(eq.repeg_threshold_token1_down_wad.to_string())
        } else {
            None
        },
        equilibraAnchorPriceWad: if pool.amm == AmmKind::Equilibra {
            Some(pool.anchor_price_wad.to_string())
        } else {
            None
        },
        equilibraLpUnitValueGenesisWad: if pool.amm == AmmKind::Equilibra {
            Some(pool.lp_unit_value_genesis_wad.to_string())
        } else {
            None
        },
        equilibraLpUnitValueWad: if pool.amm == AmmKind::Equilibra {
            Some(pool.lp_unit_value_wad.to_string())
        } else {
            None
        },
        equilibraLpValueGrowthWad: if pool.amm == AmmKind::Equilibra {
            Some(pool.lp_value_growth_wad.to_string())
        } else {
            None
        },
        equilibraDonationShares: if pool.amm == AmmKind::Equilibra {
            Some(pool.donation_shares.to_string())
        } else {
            None
        },
        equilibraFeeRampBps: pool.eq.as_ref().map(|eq| eq.fee_ramp_bps),
        equilibraFeeFloorBps: pool.eq.as_ref().map(|eq| eq.fee_floor_bps),
        equilibraRepegShareBps: pool.eq.as_ref().map(|eq| eq.repeg_share_bps),
    }
}

fn build_trace_pool(input: &TracePoolInput, start_ts: u64) -> Result<PoolState> {
    let amm = match input.amm.as_str() {
        "equilibra" => AmmKind::Equilibra,
        "uniswapV2" => AmmKind::UniswapV2,
        "curve" => AmmKind::Curve,
        other => return Err(anyhow!("unsupported trace amm: {}", other)),
    };

    let reserve0 = parse_u128_decimal(&input.reserve0, "trace.pool.reserve0")?;
    let reserve1 = parse_u128_decimal(&input.reserve1, "trace.pool.reserve1")?;
    let total_supply =
        parse_u128_opt_decimal(input.totalSupply.as_ref(), "trace.pool.totalSupply")?.unwrap_or(0);

    let mut pool = PoolState {
        context_name: input.contextName.clone(),
        amm,
        base_symbol: input.baseSymbol.clone(),
        token0: input.token0.clone(),
        token1: input.token1.clone(),
        token0_symbol: input.token0Symbol.clone(),
        token1_symbol: input.token1Symbol.clone(),
        token0_decimals: input.token0Decimals,
        token1_decimals: input.token1Decimals,
        reserve0,
        reserve1,
        e0: reserve0,
        e1: reserve1,
        protocol_fee0: 0,
        protocol_fee1: 0,
        anchor0: parse_u128_opt_decimal(
            input.anchorReserve0.as_ref(),
            "trace.pool.anchorReserve0",
        )?
        .unwrap_or(reserve0),
        anchor1: parse_u128_opt_decimal(
            input.anchorReserve1.as_ref(),
            "trace.pool.anchorReserve1",
        )?
        .unwrap_or(reserve1),
        total_supply,
        lp1_liquidity: 0,
        donation_shares: 0,
        eq: None,
        uni: None,
        curve: None,
        fee_bps: input.feeBps,
        recentering_events: Vec::new(),
        last_recenter_ts: 0,
        ema_price: 0,
        last_timestamp: 0,
        budget_fee0: 0,
        budget_fee1: 0,
        anchor_price_wad: 0,
        lp_unit_value_genesis_wad: 0,
        lp_unit_value_wad: 0,
        lp_value_growth_wad: 0,
    };

    if amm == AmmKind::Equilibra {
        // Two-knob `(a, λ)` replaces the legacy single-knob
        // `alpha`. Both fields are required for an Equilibra trace.
        let a_wad = parse_u128_opt_decimal(input.aWad.as_ref(), "trace.pool.aWad")?
            .ok_or_else(|| anyhow!("trace.pool.aWad missing for equilibra"))?;
        let lambda_wad = parse_u128_opt_decimal(input.lambdaWad.as_ref(), "trace.pool.lambdaWad")?
            .ok_or_else(|| anyhow!("trace.pool.lambdaWad missing for equilibra"))?;
        let anchor0 =
            parse_u128_opt_decimal(input.anchorReserve0.as_ref(), "trace.pool.anchorReserve0")?
                .unwrap_or(reserve0);
        let anchor1 =
            parse_u128_opt_decimal(input.anchorReserve1.as_ref(), "trace.pool.anchorReserve1")?
                .unwrap_or(reserve1);
        let protocol_fee0 = parse_u128_opt_decimal(
            input.equilibraProtocolFee0.as_ref(),
            "trace.pool.equilibraProtocolFee0",
        )?
        .unwrap_or(0);
        let protocol_fee1 = parse_u128_opt_decimal(
            input.equilibraProtocolFee1.as_ref(),
            "trace.pool.equilibraProtocolFee1",
        )?
        .unwrap_or(0);
        let protocol_fee_percent = input
            .protocolFeePercent
            .ok_or_else(|| anyhow!("trace.pool.protocolFeePercent missing for equilibra"))?;
        let ema_period = input
            .emaPeriod
            .ok_or_else(|| anyhow!("trace.pool.emaPeriod missing for equilibra"))?;
        let fee_ramp_bps = input
            .equilibraFeeRampBps
            .ok_or_else(|| anyhow!("trace.pool.equilibraFeeRampBps missing for equilibra"))?;
        let fee_floor_bps = input
            .equilibraFeeFloorBps
            .ok_or_else(|| anyhow!("trace.pool.equilibraFeeFloorBps missing for equilibra"))?;
        let repeg_share_bps = input
            .equilibraRepegShareBps
            .ok_or_else(|| anyhow!("trace.pool.equilibraRepegShareBps missing for equilibra"))?;
        if repeg_share_bps > equilibra::MAX_REPEG_SHARE_BPS as u64 {
            return Err(anyhow!(
                "trace.pool.equilibraRepegShareBps ({}) exceeds MAX_REPEG_SHARE_BPS ({})",
                repeg_share_bps,
                equilibra::MAX_REPEG_SHARE_BPS,
            ));
        }
        let ema_price = parse_u128_opt_decimal(
            input.equilibraEmaPrice.as_ref(),
            "trace.pool.equilibraEmaPrice",
        )?
        .unwrap_or(0);
        let last_timestamp = parse_u64_opt_decimal(
            input.equilibraLastTimestamp.as_ref(),
            "trace.pool.equilibraLastTimestamp",
        )?
        .unwrap_or(start_ts);
        let last_recenter_ts = parse_u64_opt_decimal(
            input.equilibraLastRecenterTimestamp.as_ref(),
            "trace.pool.equilibraLastRecenterTimestamp",
        )?
        .unwrap_or(0);
        let e0 = parse_u128_opt_decimal(input.equilibraE0.as_ref(), "trace.pool.equilibraE0")?
            .unwrap_or(reserve0);
        let e1 = parse_u128_opt_decimal(input.equilibraE1.as_ref(), "trace.pool.equilibraE1")?
            .unwrap_or(reserve1);
        let repeg_step_wad = parse_u128_opt_decimal(
            input.equilibraRepegStepWad.as_ref(),
            "trace.pool.equilibraRepegStepWad",
        )?
        .ok_or_else(|| anyhow!("trace.pool.equilibraRepegStepWad missing for equilibra"))?;
        // Direction-split dead-bands; the legacy symmetric
        // `equilibraRepegThresholdWad` seeds BOTH sides when the split
        // fields are absent (then the step, as before).
        let legacy_threshold_wad = parse_u128_opt_decimal(
            input.equilibraRepegThresholdWad.as_ref(),
            "trace.pool.equilibraRepegThresholdWad",
        )?
        .unwrap_or(repeg_step_wad);
        let repeg_threshold_token1_up_wad = parse_u128_opt_decimal(
            input.equilibraRepegThresholdToken1UpWad.as_ref(),
            "trace.pool.equilibraRepegThresholdToken1UpWad",
        )?
        .unwrap_or(legacy_threshold_wad);
        let repeg_threshold_token1_down_wad = parse_u128_opt_decimal(
            input.equilibraRepegThresholdToken1DownWad.as_ref(),
            "trace.pool.equilibraRepegThresholdToken1DownWad",
        )?
        .unwrap_or(legacy_threshold_wad);
        // Per-pool parachute activation multiplier K. Optional in the
        // trace schema; absent ⇒ the creation seed (30), exactly like a
        // pool whose timelock never adjusted `_parachuteBandMult`.
        let parachute_band_mult = match input.parachuteBandMult {
            Some(k) => {
                if k == 0 || k > 255 {
                    return Err(anyhow!(
                        "trace.pool.parachuteBandMult ({}) outside the on-chain range [1, 255]",
                        k
                    ));
                }
                u128::from(k)
            }
            None => equilibra::REPEG_PARACHUTE_BAND_MULT_DEFAULT,
        };
        // New hybrid-invariant state (optional for back-compat). If missing we
        // derive a decimal-aware default from the legacy `anchorReserve0/1`
        // fields (power-curve trace format). This keeps old snapshots usable
        // without forcing every caller to migrate in lock-step.
        let tok0_decimals = input.token0Decimals;
        let tok1_decimals = input.token1Decimals;
        let anchor_price_wad = parse_u128_opt_decimal(
            input.equilibraAnchorPriceWad.as_ref(),
            "trace.pool.equilibraAnchorPriceWad",
        )?
        .unwrap_or_else(|| {
            let s0 = pow10_u128(18u32.saturating_sub(tok0_decimals as u32));
            let s1 = pow10_u128(18u32.saturating_sub(tok1_decimals as u32));
            let a0 = anchor0.saturating_mul(s0);
            let a1 = anchor1.saturating_mul(s1);
            if a0 == 0 {
                0
            } else {
                mul_div_floor(a1, PRECISION, a0)
            }
        });
        let lp_unit_value_genesis_wad = parse_u128_opt_decimal(
            input.equilibraLpUnitValueGenesisWad.as_ref(),
            "trace.pool.equilibraLpUnitValueGenesisWad",
        )?
        .unwrap_or(0);
        let lp_unit_value_wad = parse_u128_opt_decimal(
            input.equilibraLpUnitValueWad.as_ref(),
            "trace.pool.equilibraLpUnitValueWad",
        )?
        .unwrap_or(lp_unit_value_genesis_wad);
        let lp_value_growth_wad = parse_u128_opt_decimal(
            input.equilibraLpValueGrowthWad.as_ref(),
            "trace.pool.equilibraLpValueGrowthWad",
        )?
        .unwrap_or(0);
        pool.eq = Some(EquilibraParams {
            a_wad,
            lambda_wad,
            protocol_fee_percent,
            ema_period,
            repeg_step_wad,
            repeg_threshold_token1_up_wad,
            repeg_threshold_token1_down_wad,
            rebalance_enabled: true,
            fee_ramp_bps,
            fee_floor_bps,
            repeg_share_bps,
            parachute_band_mult,
            donation_apr_bps: 0,
            donation_interval_sec: 0,
            last_donation_ts: 0,
            donation_accrued_sec: 0,
            donation_uplift_index: PRECISION,
        });
        pool.anchor0 = anchor0;
        pool.anchor1 = anchor1;
        pool.protocol_fee0 = protocol_fee0;
        pool.protocol_fee1 = protocol_fee1;
        pool.e0 = e0;
        pool.e1 = e1;
        pool.ema_price = ema_price;
        pool.last_timestamp = last_timestamp;
        pool.last_recenter_ts = last_recenter_ts;
        pool.budget_fee0 = 0;
        pool.budget_fee1 = 0;
        pool.anchor_price_wad = anchor_price_wad;
        pool.lp_unit_value_genesis_wad = lp_unit_value_genesis_wad;
        pool.lp_unit_value_wad = lp_unit_value_wad;
        pool.donation_shares = parse_u128_opt_decimal(
            input.equilibraDonationShares.as_ref(),
            "trace.pool.equilibraDonationShares",
        )?
        .unwrap_or(0);
        pool.lp_value_growth_wad = lp_value_growth_wad;
    }

    if amm == AmmKind::UniswapV2 {
        let block_timestamp_last = parse_u32_opt_decimal(
            input.uniswapBlockTimestampLast.as_ref(),
            "trace.pool.uniswapBlockTimestampLast",
        )?
        .unwrap_or((start_ts % (1u64 << 32)) as u32);
        let price0_cumulative_last = input
            .uniswapPrice0CumulativeLast
            .clone()
            .unwrap_or_else(|| "0".to_string());
        let price1_cumulative_last = input
            .uniswapPrice1CumulativeLast
            .clone()
            .unwrap_or_else(|| "0".to_string());
        let k_last = input
            .uniswapKLast
            .clone()
            .unwrap_or_else(|| "0".to_string());
        pool.uni = Some(UniswapParams {
            block_timestamp_last,
            price0_cumulative_last,
            price1_cumulative_last,
            k_last,
            rebalance_enabled: true,
        });
    }

    if amm == AmmKind::Curve {
        let a = parse_u128_opt_decimal(input.curveA.as_ref(), "trace.pool.curveA")?
            .ok_or_else(|| anyhow!("trace.pool.curveA missing for curve"))?;
        let gamma = parse_u128_opt_decimal(input.curveGamma.as_ref(), "trace.pool.curveGamma")?
            .ok_or_else(|| anyhow!("trace.pool.curveGamma missing for curve"))?;
        let mid_fee = parse_u128_opt_decimal(input.curveMidFee.as_ref(), "trace.pool.curveMidFee")?
            .ok_or_else(|| anyhow!("trace.pool.curveMidFee missing for curve"))?;
        let out_fee = parse_u128_opt_decimal(input.curveOutFee.as_ref(), "trace.pool.curveOutFee")?
            .ok_or_else(|| anyhow!("trace.pool.curveOutFee missing for curve"))?;
        let fee_gamma =
            parse_u128_opt_decimal(input.curveFeeGamma.as_ref(), "trace.pool.curveFeeGamma")?
                .ok_or_else(|| anyhow!("trace.pool.curveFeeGamma missing for curve"))?;
        let adjustment_step_min = parse_u128_opt_decimal(
            input.curveAdjustmentStepMin.as_ref(),
            "trace.pool.curveAdjustmentStepMin",
        )?
        .unwrap_or(0);
        let adjustment_step_max = parse_u128_opt_decimal(
            input.curveAdjustmentStepMax.as_ref(),
            "trace.pool.curveAdjustmentStepMax",
        )?
        .unwrap_or(0);
        let reserved_profit_fraction = parse_u128_opt_decimal(
            input.curveReservedProfitFraction.as_ref(),
            "trace.pool.curveReservedProfitFraction",
        )?
        .unwrap_or(0);
        // Required — no silent default: `ma_time` sets the EMA speed, and a
        // fallback here would let a parity/replay trace that forgot the
        // field pass while running a different oracle than the pool under
        // test.
        let ma_time = parse_u64_opt_decimal(input.curveMaTime.as_ref(), "trace.pool.curveMaTime")?
            .ok_or_else(|| anyhow!("trace.pool.curveMaTime missing for curve"))?;
        let price_scale =
            parse_u128_opt_decimal(input.curvePriceScale.as_ref(), "trace.pool.curvePriceScale")?
                .ok_or_else(|| anyhow!("trace.pool.curvePriceScale missing for curve"))?;
        let d = parse_u128_opt_decimal(input.curveD.as_ref(), "trace.pool.curveD")?.unwrap_or(0);
        let price_oracle = parse_u128_opt_decimal(
            input.curvePriceOracle.as_ref(),
            "trace.pool.curvePriceOracle",
        )?
        .unwrap_or(price_scale);
        let last_prices =
            parse_u128_opt_decimal(input.curveLastPrices.as_ref(), "trace.pool.curveLastPrices")?
                .unwrap_or(price_scale);
        let curve_last_ts = parse_u64_opt_decimal(
            input.curveLastTimestamp.as_ref(),
            "trace.pool.curveLastTimestamp",
        )?
        .unwrap_or(start_ts);
        let virtual_price = parse_u128_opt_decimal(
            input.curveVirtualPrice.as_ref(),
            "trace.pool.curveVirtualPrice",
        )?
        .unwrap_or(PRECISION);
        let xcp_profit =
            parse_u128_opt_decimal(input.curveXcpProfit.as_ref(), "trace.pool.curveXcpProfit")?
                .unwrap_or(PRECISION);
        let lp_xcp_profit = parse_u128_opt_decimal(
            input.curveLpXcpProfit.as_ref(),
            "trace.pool.curveLpXcpProfit",
        )?
        .unwrap_or(PRECISION);
        let curve_total_supply = parse_u128_opt_decimal(
            input.curveTotalSupply.as_ref(),
            "trace.pool.curveTotalSupply",
        )?
        .unwrap_or(pool.total_supply);
        let mode = input
            .curveMathMode
            .clone()
            .unwrap_or_else(|| "stableswap".to_string());
        pool.total_supply = curve_total_supply;
        pool.curve = Some(CurveParams {
            a,
            gamma,
            mid_fee,
            out_fee,
            fee_gamma,
            adjustment_step_min,
            adjustment_step_max,
            reserved_profit_fraction,
            ma_time,
            math_mode: mode,
            price_scale,
            price_oracle,
            last_prices,
            last_timestamp: curve_last_ts,
            virtual_price,
            xcp_profit,
            lp_xcp_profit,
            d,
            d_dirty: d == 0,
            rebalance_enabled: true,
            donation: curve::CurveDonationState::default(),
            donation_apr_bps: 0,
            donation_interval_sec: 0,
            last_donation_ts: 0,
            donation_accrued_sec: 0,
            donation_uplift_index: PRECISION,
        });
    }

    // Trace replay models a single LP account owning the active float
    // ABOVE the genesis dead shares. Neither the donation buffer nor
    // the dead shares are the account's to spend, and no on-chain pool
    // can hold an active float below `MIN_INITIAL_LIQUIDITY` (the dead
    // shares are unburnable and never donatable) — reject such seeds
    // instead of replaying an on-chain-unreachable state.
    if pool.total_supply == 0 {
        if pool.donation_shares != 0 {
            return Err(anyhow!(
                "trace seed: donation buffer without outstanding supply"
            ));
        }
    } else {
        let active = checked_sub_u128(
            pool.total_supply,
            pool.donation_shares,
            "trace seed: donation buffer exceeds total supply",
        )?;
        if active < equilibra::MIN_INITIAL_LIQUIDITY {
            return Err(anyhow!(
                "trace seed: active float {} below the unburnable genesis floor {}",
                active,
                equilibra::MIN_INITIAL_LIQUIDITY
            ));
        }
        pool.lp1_liquidity = active - equilibra::MIN_INITIAL_LIQUIDITY;
    }

    Ok(pool)
}

fn run_trace_mode(cli: &Cli) -> Result<()> {
    let input_path = cli
        .trace_input
        .as_ref()
        .ok_or_else(|| anyhow!("trace_input is required for trace mode"))?;
    let raw = fs::read_to_string(input_path)
        .with_context(|| format!("read trace input {}", input_path.display()))?;
    let trace_in: TraceInput = serde_json::from_str(&raw)
        .with_context(|| format!("parse trace input {}", input_path.display()))?;

    let base_ts = trace_in.startTimestamp.unwrap_or(1);
    let mut pool = build_trace_pool(&trace_in.pool, base_ts)?;
    let mut quoter = QuoterClient::new()?;
    ensure_curve_d(&mut pool, &mut quoter)?;

    let mut steps: Vec<TraceStepOut> = Vec::with_capacity(trace_in.steps.len());
    let mut eq_recenter_gate_stats = RecenterGateStatsByBase::default();
    let mut curve_rebalance_gate_stats = RecenterGateStatsByBase::default();

    for (idx, step) in trace_in.steps.iter().enumerate() {
        let action = step.action.as_deref().unwrap_or("swap");
        let ts = step
            .timestamp
            .unwrap_or(base_ts.saturating_add((idx as u64) + 1));

        ensure_curve_d(&mut pool, &mut quoter)?;
        let pre = trace_state_out(&pool);

        let mut token_in_out: Option<String> = None;
        let mut amount_in_out: Option<String> = None;
        let mut amount_out_out: Option<String> = None;
        let mut amount0_out: Option<String> = None;
        let mut amount1_out: Option<String> = None;
        let mut liquidity_out: Option<String> = None;
        let mut minted_liquidity_out: Option<String> = None;
        let mut remove_amount0_out: Option<String> = None;
        let mut remove_amount1_out: Option<String> = None;
        let mut equilibra_recentered_out: Option<bool> = None;
        let mut equilibra_recenter_blocked_by_out: Option<String> = None;

        match action {
            "swap" => {
                let token_in = step
                    .tokenIn
                    .as_deref()
                    .ok_or_else(|| anyhow!("trace.steps[].tokenIn is required for swap action"))?;
                if !token_in.eq_ignore_ascii_case(&pool.token0)
                    && !token_in.eq_ignore_ascii_case(&pool.token1)
                {
                    return Err(anyhow!(
                        "trace step tokenIn {} is not pool token0/token1",
                        token_in
                    ));
                }
                let amount_in_raw = step
                    .amountIn
                    .as_deref()
                    .ok_or_else(|| anyhow!("trace.steps[].amountIn is required for swap action"))?;
                let amount_in = parse_u128_decimal(amount_in_raw, "trace.steps[].amountIn")?;
                let amount_out = if pool.amm == AmmKind::Curve {
                    let disable_curve =
                        is_curve_rebalance_disabled(&pool, cli.disable_curve_rebalance);
                    execute_curve_stateful_swap(
                        &mut pool,
                        &mut quoter,
                        token_in,
                        amount_in,
                        ts,
                        disable_curve,
                        &mut curve_rebalance_gate_stats,
                    )?
                    .amount_out
                } else if pool.amm == AmmKind::UniswapV2 {
                    execute_uniswap_v2_stateful_swap(
                        &mut pool,
                        &mut quoter,
                        token_in,
                        amount_in,
                        ts,
                    )?
                } else {
                    let disable_recenter =
                        is_equilibra_recenter_disabled(&pool, cli.disable_equilibra_recenter);
                    let eq_out = execute_equilibra_stateful_swap(
                        &mut pool,
                        &mut quoter,
                        token_in,
                        amount_in,
                        ts,
                        cli.trace_disable_recenter || disable_recenter,
                        &mut eq_recenter_gate_stats,
                    )?;
                    equilibra_recentered_out = Some(eq_out.recentered);
                    equilibra_recenter_blocked_by_out = eq_out
                        .recenter_blocked_by
                        .map(|reason| reason.as_str().to_string());
                    eq_out.amount_out
                };
                token_in_out = Some(token_in.to_string());
                amount_in_out = Some(amount_in.to_string());
                amount_out_out = Some(amount_out.to_string());
            }
            "swapExactOut" => {
                // Exact-output replay — only Equilibra is implemented
                // (the contract under test). Curve and UniswapV2 traces
                // would have to model their own exact-out paths first.
                if pool.amm != AmmKind::Equilibra {
                    return Err(anyhow!(
                        "trace step 'swapExactOut' is only supported for Equilibra pools (got {:?})",
                        pool.amm
                    ));
                }
                let token_in = step.tokenIn.as_deref().ok_or_else(|| {
                    anyhow!("trace.steps[].tokenIn is required for swapExactOut action")
                })?;
                if !token_in.eq_ignore_ascii_case(&pool.token0)
                    && !token_in.eq_ignore_ascii_case(&pool.token1)
                {
                    return Err(anyhow!(
                        "trace step tokenIn {} is not pool token0/token1",
                        token_in
                    ));
                }
                let amount_out_raw = step.amountOut.as_deref().ok_or_else(|| {
                    anyhow!("trace.steps[].amountOut is required for swapExactOut action")
                })?;
                let amount_out = parse_u128_decimal(amount_out_raw, "trace.steps[].amountOut")?;
                let disable_recenter =
                    is_equilibra_recenter_disabled(&pool, cli.disable_equilibra_recenter);
                let exec = execute_equilibra_stateful_swap_exact_out(
                    &mut pool,
                    &mut quoter,
                    token_in,
                    amount_out,
                    ts,
                    cli.trace_disable_recenter || disable_recenter,
                    &mut eq_recenter_gate_stats,
                )?;
                token_in_out = Some(token_in.to_string());
                amount_in_out = Some(exec.amount_in.to_string());
                amount_out_out = Some(amount_out.to_string());
                equilibra_recentered_out = Some(exec.recentered);
                equilibra_recenter_blocked_by_out = exec
                    .recenter_blocked_by
                    .map(|reason| reason.as_str().to_string());
            }
            "add" | "addLiquidity" => {
                let amount0_raw = step
                    .amount0
                    .as_deref()
                    .ok_or_else(|| anyhow!("trace.steps[].amount0 is required for add action"))?;
                let amount1_raw = step
                    .amount1
                    .as_deref()
                    .ok_or_else(|| anyhow!("trace.steps[].amount1 is required for add action"))?;
                let amount0 = parse_u128_decimal(amount0_raw, "trace.steps[].amount0")?;
                let amount1 = parse_u128_decimal(amount1_raw, "trace.steps[].amount1")?;
                let disable_curve = is_curve_rebalance_disabled(&pool, cli.disable_curve_rebalance);
                let (minted, used0, used1) =
                    add_liquidity(&mut pool, &mut quoter, amount0, amount1, ts, disable_curve)?;
                amount0_out = Some(used0.to_string());
                amount1_out = Some(used1.to_string());
                minted_liquidity_out = Some(minted.to_string());
            }
            "donate" => {
                if pool.amm == AmmKind::Equilibra {
                    // Equilibra donation = the passive LP transfers
                    // `liquidity` shares to the pool's own address:
                    // supply unchanged, the parked amount becomes the
                    // parachute's emergency fund (mirrors a plain LP
                    // `transfer(pool, shares)` on-chain).
                    let liquidity_raw = step.liquidity.as_deref().ok_or_else(|| {
                        anyhow!("trace.steps[].liquidity is required for equilibra donate")
                    })?;
                    let shares = parse_u128_decimal(liquidity_raw, "trace.steps[].liquidity")?;
                    if shares == 0 || shares > pool.lp1_liquidity {
                        return Err(anyhow!(
                            "equilibra donate: {} shares outside the passive LP balance {}",
                            shares,
                            pool.lp1_liquidity
                        ));
                    }
                    pool.lp1_liquidity -= shares;
                    let mut eq_state = equilibra_state_from_pool(&pool);
                    quoter
                        .inner
                        .equilibra_donate_lp_stateful(&mut eq_state, shares)?;
                    pool.donation_shares = eq_state.donation_shares;
                    liquidity_out = Some(shares.to_string());
                } else if pool.amm != AmmKind::Curve {
                    return Err(anyhow!(
                        "trace step 'donate' is only supported for Curve and Equilibra pools (got {:?})",
                        pool.amm
                    ));
                } else {
                    let amount0 = match step.amount0.as_deref() {
                        Some(raw) => parse_u128_decimal(raw, "trace.steps[].amount0")?,
                        None => 0,
                    };
                    let amount1 = match step.amount1.as_deref() {
                        Some(raw) => parse_u128_decimal(raw, "trace.steps[].amount1")?,
                        None => 0,
                    };
                    let disable_curve =
                        is_curve_rebalance_disabled(&pool, cli.disable_curve_rebalance);
                    let minted = execute_curve_donation(
                        &mut pool,
                        &mut quoter,
                        amount0,
                        amount1,
                        ts,
                        disable_curve,
                    )?;
                    amount0_out = Some(amount0.to_string());
                    amount1_out = Some(amount1.to_string());
                    minted_liquidity_out = Some(minted.to_string());
                }
            }
            "remove" | "removeLiquidity" => {
                let liquidity_raw = step.liquidity.as_deref().ok_or_else(|| {
                    anyhow!("trace.steps[].liquidity is required for remove action")
                })?;
                let liquidity = parse_u128_decimal(liquidity_raw, "trace.steps[].liquidity")?;
                let (out0, out1) = remove_liquidity(&mut pool, &mut quoter, liquidity, ts)?;
                liquidity_out = Some(liquidity.to_string());
                remove_amount0_out = Some(out0.to_string());
                remove_amount1_out = Some(out1.to_string());
            }
            other => {
                return Err(anyhow!("unsupported trace step action: {}", other));
            }
        };

        ensure_curve_d(&mut pool, &mut quoter)?;
        let post = trace_state_out(&pool);

        steps.push(TraceStepOut {
            index: idx,
            action: action.to_string(),
            tokenIn: token_in_out,
            amountIn: amount_in_out,
            amountOut: amount_out_out,
            amount0: amount0_out,
            amount1: amount1_out,
            liquidity: liquidity_out,
            mintedLiquidity: minted_liquidity_out,
            amount0Out: remove_amount0_out,
            amount1Out: remove_amount1_out,
            equilibraRecentered: equilibra_recentered_out,
            equilibraRecenterBlockedBy: equilibra_recenter_blocked_by_out,
            timestamp: ts,
            pre,
            post,
        });
    }

    let out = TraceOutput {
        mode: "trace_replay".to_string(),
        contextName: pool.context_name.clone(),
        amm: pool.amm.as_str().to_string(),
        baseSymbol: pool.base_symbol.clone(),
        steps,
        finalState: trace_state_out(&pool),
    };

    let out_path = cli
        .trace_output
        .clone()
        .or_else(|| {
            cli.trace_input
                .clone()
                .map(|p| p.with_extension("out.json"))
        })
        .unwrap_or_else(|| cli.output.clone());
    persist_json_durable(&out_path, &out)
        .with_context(|| format!("persist trace output {}", out_path.display()))?;
    println!("[simulator] trace done: {}", out_path.display());
    Ok(())
}

fn now_iso_utc() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn build_initial_deposit_amounts(
    base_symbol: &str,
    oracle_price: f64,
    usd_value: f64,
) -> (u128, u128) {
    let half = usd_value / 2.0;
    let amount_base = if oracle_price > 0.0 {
        (half / oracle_price * 10f64.powi(token_decimals(base_symbol) as i32)).floor() as u128
    } else {
        0
    };
    let amount_quote = (half * 1_000_000f64).floor() as u128;
    (amount_base, amount_quote)
}

fn curve_price_scale_from_base_oracle(base_oracle: f64) -> u128 {
    if !base_oracle.is_finite() || base_oracle <= 0.0 {
        return 0;
    }
    // In simulator WETH/WBTC pools are modeled as:
    // token0 = USDT (quote), token1 = base (WETH/WBTC).
    // Twocrypto xp normalization uses priceScale in token0/token1 units,
    // so priceScale equals oracle(base in quote) expressed in 1e18.
    let price_in_18 = base_oracle * 1e18f64;
    if !price_in_18.is_finite() || price_in_18 <= 0.0 {
        return 0;
    }
    price_in_18.floor().max(0.0) as u128
}

fn context_key(amm: &str, base: &str) -> String {
    format!("{}:{}", amm, base)
}

fn oracle_symbol_for_base(base: &str) -> &'static str {
    if base == "WBTC" {
        "BTC"
    } else {
        "ETH"
    }
}

fn amm_enabled(cfg: &RunConfig, kind: AmmKind, no_curve: bool) -> bool {
    match kind {
        AmmKind::Equilibra => cfg.amms.equilibra.enabled,
        AmmKind::UniswapV2 => cfg.amms.uniswapV2.enabled,
        AmmKind::Curve => cfg.amms.curve.enabled && !no_curve,
    }
}

fn canonical_amm_filter_name(raw: &str) -> Option<&'static str> {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "equilibra" => Some("equilibra"),
        "uniswapv2" | "uniswap_v2" | "uniswap-v2" => Some("uniswapv2"),
        "curve" => Some("curve"),
        _ => None,
    }
}

fn canonical_base_filter_name(raw: &str) -> Option<&'static str> {
    let normalized = raw.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "WETH" | "ETH" => Some("WETH"),
        "WBTC" | "BTC" => Some("WBTC"),
        _ => None,
    }
}

fn parse_amm_filter(values: &[String]) -> Result<HashSet<String>> {
    let mut out = HashSet::<String>::new();
    for value in values {
        let name = canonical_amm_filter_name(value).ok_or_else(|| {
            anyhow!(
                "unsupported --only-amms value '{}'; allowed: equilibra,uniswapV2,curve",
                value
            )
        })?;
        out.insert(name.to_string());
    }
    Ok(out)
}

fn parse_base_filter(values: &[String]) -> Result<HashSet<String>> {
    let mut out = HashSet::<String>::new();
    for value in values {
        let name = canonical_base_filter_name(value).ok_or_else(|| {
            anyhow!(
                "unsupported --only-bases value '{}'; allowed: WETH,WBTC",
                value
            )
        })?;
        out.insert(name.to_string());
    }
    Ok(out)
}

fn kind_filter_name(kind: AmmKind) -> &'static str {
    match kind {
        AmmKind::Equilibra => "equilibra",
        AmmKind::UniswapV2 => "uniswapv2",
        AmmKind::Curve => "curve",
    }
}

fn amm_selected(kind: AmmKind, only_amms: &HashSet<String>) -> bool {
    only_amms.is_empty() || only_amms.contains(kind_filter_name(kind))
}

fn base_selected(base: &str, only_bases: &HashSet<String>) -> bool {
    only_bases.is_empty() || only_bases.contains(base)
}

fn quote_exact_input(
    pool: &PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    amount_in: u128,
) -> Result<u128> {
    quoter.quote_exact_input_pool(pool, token_in, amount_in)
}

fn apply_equilibra_stateful_out(
    pool: &mut PoolState,
    out: &EquilibraExchangeStatefulOut,
) -> Result<()> {
    if pool.amm != AmmKind::Equilibra {
        return Err(anyhow!(
            "apply_equilibra_stateful_out called for non-equilibra pool {}",
            pool.context_name
        ));
    }
    pool.reserve0 = out.reserve0;
    pool.reserve1 = out.reserve1;
    pool.anchor0 = out.anchor0;
    pool.anchor1 = out.anchor1;
    pool.protocol_fee0 = out.protocol_fee0;
    pool.protocol_fee1 = out.protocol_fee1;
    pool.e0 = out.e0;
    pool.e1 = out.e1;
    pool.ema_price = out.ema_price;
    pool.last_timestamp = out.last_timestamp;
    pool.last_recenter_ts = out.last_recenter_ts;
    pool.budget_fee0 = out.budget_fee0;
    pool.budget_fee1 = out.budget_fee1;
    pool.anchor_price_wad = out.anchor_price_wad;
    pool.lp_unit_value_genesis_wad = out.lp_unit_value_genesis_wad;
    pool.lp_unit_value_wad = out.lp_unit_value_wad;
    pool.lp_value_growth_wad = out.lp_value_growth_wad;
    // A parachute commit burns donated shares inside the swap — the
    // supply and buffer must follow the stateful out.
    pool.total_supply = out.total_supply;
    pool.donation_shares = out.donation_shares;
    Ok(())
}

fn execute_equilibra_stateful_swap(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
    disable_recenter: bool,
    eq_recenter_gate_stats: &mut RecenterGateStatsByBase,
) -> Result<EquilibraSwapExecOut> {
    if pool.amm != AmmKind::Equilibra {
        return Err(anyhow!(
            "execute_equilibra_stateful_swap called for non-equilibra pool {}",
            pool.context_name
        ));
    }

    let out =
        quoter.equilibra_swap_stateful(pool, token_in, amount_in, timestamp, disable_recenter)?;
    eq_recenter_gate_stats.record_swap(
        pool.base_symbol.as_str(),
        timestamp,
        out.recentered,
        out.recentered_via_parachute,
        out.recenter_blocked_by.map(|reason| reason.as_str()),
    );
    if out.recentered {
        pool.recentering_events.push(RecenteringEventOut {
            timestamp: out.last_recenter_ts,
            ammName: "equilibra".to_string(),
            poolKey: pool.base_symbol.clone(),
            ilEstimate: bigint_pref(out.recenter_cost_loss_token),
            // Pre-apply pool state still carries the OLD anchor; `out`
            // carries the post-repeg one. Consumed by the report's
            // anchor-deviation metric.
            oldPriceScale: Some(pool.anchor_price_wad.to_string()),
            newPriceScale: Some(out.anchor_price_wad.to_string()),
        });
    }
    // Debug-trace gated on env var. Set `EQUILIBRA_DEBUG_TRACE=WBTC`
    // (or `WETH`) to emit a CSV line for every swap in that pool to
    // stderr. Format: `ts,ammName,poolKey,priceScale,ema,r0,r1,
    //                  recentered,blocked_by`.
    // Read once per process (`OnceLock`): this runs on every executed
    // swap and `env::var` takes a global lock per call.
    static DEBUG_TRACE_TARGET: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let debug_trace_target =
        DEBUG_TRACE_TARGET.get_or_init(|| std::env::var("EQUILIBRA_DEBUG_TRACE").ok());
    if let Some(target) = debug_trace_target.as_deref() {
        if pool.base_symbol == target {
            eprintln!(
                "EQ_TRACE,{},equilibra,{},{},{},{},{},{},{:?}",
                timestamp,
                pool.base_symbol,
                out.anchor_price_wad, // priceScale, kept under legacy name
                out.ema_price,        // emaPriceWad, kept under legacy name
                out.reserve0,
                out.reserve1,
                out.recentered,
                out.recenter_blocked_by,
            );
        }
    }
    let exec_out = EquilibraSwapExecOut {
        amount_out: out.amount_out,
        fee_amount_raw: out.fee_amount_raw,
        recentered: out.recentered,
        recenter_blocked_by: out.recenter_blocked_by,
    };
    apply_equilibra_stateful_out(pool, &out)?;
    Ok(exec_out)
}

/// Exact-output mirror of `execute_equilibra_stateful_swap`. Returns
/// the realised `amount_in` (raw, dynamic-fee inclusive) so callers can
/// log it alongside the requested `amount_out`. Mirrors the on-chain
/// `exactOutputSingle` behaviour: input is pulled via
/// `_executeExactOutWithDynamicFee`, output equals the requested
/// target exactly, EMA + auto-repeg run after the reserves commit.
#[derive(Debug, Clone, Copy)]
struct EquilibraSwapExactOutExecOut {
    amount_in: u128,
    recentered: bool,
    recenter_blocked_by: Option<equilibra::EquilibraRecenterGateBlocked>,
}

fn execute_equilibra_stateful_swap_exact_out(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    amount_out: u128,
    timestamp: u64,
    disable_recenter: bool,
    eq_recenter_gate_stats: &mut RecenterGateStatsByBase,
) -> Result<EquilibraSwapExactOutExecOut> {
    if pool.amm != AmmKind::Equilibra {
        return Err(anyhow!(
            "execute_equilibra_stateful_swap_exact_out called for non-equilibra pool {}",
            pool.context_name
        ));
    }
    let (amount_in, out) = quoter.equilibra_swap_stateful_exact_out(
        pool,
        token_in,
        amount_out,
        timestamp,
        disable_recenter,
    )?;
    eq_recenter_gate_stats.record_swap(
        pool.base_symbol.as_str(),
        timestamp,
        out.recentered,
        out.recentered_via_parachute,
        out.recenter_blocked_by.map(|reason| reason.as_str()),
    );
    if out.recentered {
        pool.recentering_events.push(RecenteringEventOut {
            timestamp: out.last_recenter_ts,
            ammName: "equilibra".to_string(),
            poolKey: pool.base_symbol.clone(),
            ilEstimate: bigint_pref(out.recenter_cost_loss_token),
            // Pre-apply pool state still carries the OLD anchor; `out`
            // carries the post-repeg one. Consumed by the report's
            // anchor-deviation metric.
            oldPriceScale: Some(pool.anchor_price_wad.to_string()),
            newPriceScale: Some(out.anchor_price_wad.to_string()),
        });
    }
    apply_equilibra_stateful_out(pool, &out)?;
    Ok(EquilibraSwapExactOutExecOut {
        amount_in,
        recentered: out.recentered,
        recenter_blocked_by: out.recenter_blocked_by,
    })
}

/// Convert an in-memory `RecenterGateStats` sample into the
/// serializable `RecenterGateCounts` shape used by the shard JSON
/// output and the report merger. The `&'static str` keys from
/// `EquilibraRecenterGateBlocked::as_str()` are promoted to owned `String`
/// on the serialization boundary so the map round-trips through serde.
fn gate_stats_to_counts(stats: &RecenterGateStats) -> RecenterGateCounts {
    let mut blocked_counts: BTreeMap<String, u64> = BTreeMap::new();
    for (gate, count) in &stats.blocked_counts {
        blocked_counts.insert((*gate).to_string(), *count);
    }
    RecenterGateCounts {
        checks_total: stats.checks_total,
        recentered: stats.recentered,
        recentered_via_parachute: stats.recentered_via_parachute,
        blocked_counts,
    }
}

/// Build the serializable export (`RecenterGateStatsExport`) from
/// the in-memory aggregator. Only bases with non-zero activity make it into
/// the output to keep the final log file compact.
fn build_recenter_gate_stats_export(
    stats_by_base: &RecenterGateStatsByBase,
) -> Option<RecenterGateStatsExport> {
    let mut export = RecenterGateStatsExport::default();
    for base_symbol in ["WETH", "WBTC"] {
        let overall = stats_by_base.get_for_base(base_symbol);
        let monthly = stats_by_base.get_monthly_for_base(base_symbol);
        let quarterly = stats_by_base.get_quarterly_for_base(base_symbol);
        let has_overall = overall.map(|s| s.checks_total > 0).unwrap_or(false);
        let has_monthly = monthly
            .map(|m| m.values().any(|s| s.checks_total > 0))
            .unwrap_or(false);
        let has_quarterly = quarterly
            .map(|m| m.values().any(|s| s.checks_total > 0))
            .unwrap_or(false);
        if !has_overall && !has_monthly && !has_quarterly {
            continue;
        }

        let mut periods = RecenterGateBasePeriods::default();
        if let Some(overall) = overall {
            periods.overall = gate_stats_to_counts(overall);
        }
        if let Some(monthly) = monthly {
            for (period, stats) in monthly {
                if stats.checks_total == 0 {
                    continue;
                }
                periods
                    .monthly
                    .insert(format_gate_month_key(*period), gate_stats_to_counts(stats));
            }
        }
        if let Some(quarterly) = quarterly {
            for (period, stats) in quarterly {
                if stats.checks_total == 0 {
                    continue;
                }
                periods.quarterly.insert(
                    format_gate_quarter_key(*period),
                    gate_stats_to_counts(stats),
                );
            }
        }
        export.by_base.insert(base_symbol.to_string(), periods);
    }
    if export.by_base.is_empty() {
        None
    } else {
        Some(export)
    }
}

fn ensure_curve_d(pool: &mut PoolState, quoter: &mut QuoterClient) -> Result<()> {
    if pool.amm != AmmKind::Curve {
        return Ok(());
    }
    let needs_recompute = match pool.curve.as_ref() {
        Some(curve) => curve.d_dirty || curve.d == 0,
        None => false,
    };
    if !needs_recompute {
        return Ok(());
    }

    let d = quoter.curve_compute_d(pool)?;
    let curve = pool
        .curve
        .as_mut()
        .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
    curve.d = d;
    curve.d_dirty = false;
    Ok(())
}

fn apply_curve_runtime_state(
    pool: &mut PoolState,
    reserve0: u128,
    reserve1: u128,
    total_supply: u128,
    curve_d: u128,
    curve_price_scale: u128,
    curve_price_oracle: u128,
    curve_last_prices: u128,
    curve_last_timestamp: u64,
    curve_virtual_price: u128,
    curve_xcp_profit: u128,
    curve_lp_xcp_profit: u128,
    curve_donation: curve::CurveDonationState,
    donation_shares_burned: u128,
) -> Result<()> {
    if pool.amm != AmmKind::Curve {
        return Err(anyhow!(
            "apply_curve_runtime_state called for non-curve pool {}",
            pool.context_name
        ));
    }
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    pool.e0 = reserve0;
    pool.e1 = reserve1;
    pool.total_supply = total_supply;

    let curve = pool
        .curve
        .as_mut()
        .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?;
    curve.d = curve_d;
    curve.price_scale = curve_price_scale;
    curve.price_oracle = curve_price_oracle;
    curve.last_prices = curve_last_prices;
    curve.last_timestamp = curve_last_timestamp;
    curve.virtual_price = curve_virtual_price;
    curve.xcp_profit = curve_xcp_profit;
    curve.lp_xcp_profit = curve_lp_xcp_profit;
    // `donation_shares_burned` is the quoter's exact per-event burn at
    // the rebalance commit. The buffer's net share change cannot stand
    // in for it: a donation add mints into the buffer and its own
    // `tweak_price` may burn older unlocked shares in the SAME event,
    // leaving the net change positive while a burn still happened.
    // Report-only accepted approximation: the index folds the
    // burn-lift ONLY — the transient dilution while donated shares sit
    // parked (minted into supply, not yet burned) stays inside the net
    // numbers. Measured at ~0.06% of TVL on the smoke calibration;
    // Curve baseline only.
    if donation_shares_burned > 0 {
        // The burn lifted every surviving claim by
        // `supplyBefore / supplyAfter` (supply shrank, reserves did
        // not): fold that exact factor into the uplift index that
        // drives the share-based donation subtraction at finalize.
        let supply_before = total_supply.saturating_add(donation_shares_burned);
        if total_supply > 0 && supply_before > total_supply {
            curve.donation_uplift_index =
                mul_div_floor(curve.donation_uplift_index, supply_before, total_supply);
        }
    }
    curve.donation = curve_donation;
    curve.d_dirty = false;
    Ok(())
}

fn apply_curve_stateful_out(pool: &mut PoolState, out: CurveExchangeStatefulOut) -> Result<()> {
    apply_curve_runtime_state(
        pool,
        out.reserve0,
        out.reserve1,
        out.curve_total_supply,
        out.curve_d,
        out.curve_price_scale,
        out.curve_price_oracle,
        out.curve_last_prices,
        out.curve_last_timestamp,
        out.curve_virtual_price,
        out.curve_xcp_profit,
        out.curve_lp_xcp_profit,
        out.curve_donation,
        out.donation_shares_burned,
    )
}

/// Result of `execute_curve_stateful_swap`. Carries the dynamic fee info
/// alongside the trade output so that the simulator's per-swap reporting
/// can accurately populate `feePaidUsd` / `actualFeeBps` for Curve. Curve
/// charges its fee on the OUTPUT side, so `fee_amount_out` is in raw
/// `token_out` units.
#[derive(Debug, Clone, Copy)]
struct CurveSwapExecOut {
    amount_out: u128,
    fee_amount_out: u128,
    fee_bps_effective: u64,
}

fn execute_curve_stateful_swap(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
    disable_rebalance: bool,
    curve_rebalance_gate_stats: &mut RecenterGateStatsByBase,
) -> Result<CurveSwapExecOut> {
    if pool.amm != AmmKind::Curve {
        return Err(anyhow!(
            "execute_curve_stateful_swap called for non-curve pool {}",
            pool.context_name
        ));
    }
    ensure_curve_d(pool, quoter)?;
    let old_price_scale = pool
        .curve
        .as_ref()
        .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?
        .price_scale;
    let out =
        quoter.curve_exchange_stateful(pool, token_in, amount_in, timestamp, disable_rebalance)?;
    curve_rebalance_gate_stats.record_swap(
        pool.base_symbol.as_str(),
        timestamp,
        out.rebalanced,
        false,
        out.rebalance_blocked_by.map(|reason| reason.as_str()),
    );
    let amount_out = out.amount_out;
    let fee_amount_out = out.fee_amount_out;
    let fee_bps_effective = out.fee_bps_effective;
    let new_price_scale = out.curve_price_scale;
    apply_curve_stateful_out(pool, out)?;
    maybe_record_curve_rebalance_event(pool, timestamp, old_price_scale, new_price_scale);
    Ok(CurveSwapExecOut {
        amount_out,
        fee_amount_out,
        fee_bps_effective,
    })
}

fn execute_curve_add_liquidity_stateful(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
    disable_rebalance: bool,
) -> Result<(u128, u128, u128)> {
    if pool.amm != AmmKind::Curve {
        return Err(anyhow!(
            "execute_curve_add_liquidity_stateful called for non-curve pool {}",
            pool.context_name
        ));
    }
    if pool.total_supply > 0 && pool.reserve0 > 0 && pool.reserve1 > 0 {
        ensure_curve_d(pool, quoter)?;
    }
    let old_price_scale = pool
        .curve
        .as_ref()
        .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?
        .price_scale;
    let out = quoter.curve_add_liquidity_stateful(
        pool,
        amount0,
        amount1,
        timestamp,
        disable_rebalance,
    )?;
    let minted = out.minted_liquidity;
    let used0 = out.amount0_used;
    let used1 = out.amount1_used;
    let new_price_scale = out.curve_price_scale;
    apply_curve_runtime_state(
        pool,
        out.reserve0,
        out.reserve1,
        out.curve_total_supply,
        out.curve_d,
        out.curve_price_scale,
        out.curve_price_oracle,
        out.curve_last_prices,
        out.curve_last_timestamp,
        out.curve_virtual_price,
        out.curve_xcp_profit,
        out.curve_lp_xcp_profit,
        out.curve_donation,
        out.donation_shares_burned,
    )?;
    maybe_record_curve_rebalance_event(pool, timestamp, old_price_scale, new_price_scale);
    Ok((minted, used0, used1))
}

/// Execute one donation event: quote-side liquidity credited to the
/// pool's donation buffer. Returns the donation shares minted. The
/// donation's own `tweak_price` may commit a rebalance, so the price-scale
/// diff is recorded like any other liquidity event.
fn execute_curve_donation(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
    disable_rebalance: bool,
) -> Result<u128> {
    if pool.amm != AmmKind::Curve {
        return Err(anyhow!(
            "execute_curve_donation called for non-curve pool {}",
            pool.context_name
        ));
    }
    ensure_curve_d(pool, quoter)?;
    let old_price_scale = pool
        .curve
        .as_ref()
        .ok_or_else(|| anyhow!("curve params missing for {}", pool.context_name))?
        .price_scale;
    let out = quoter.curve_donate_stateful(pool, amount0, amount1, timestamp, disable_rebalance)?;
    let minted = out.minted_liquidity;
    let new_price_scale = out.curve_price_scale;
    apply_curve_runtime_state(
        pool,
        out.reserve0,
        out.reserve1,
        out.curve_total_supply,
        out.curve_d,
        out.curve_price_scale,
        out.curve_price_oracle,
        out.curve_last_prices,
        out.curve_last_timestamp,
        out.curve_virtual_price,
        out.curve_xcp_profit,
        out.curve_lp_xcp_profit,
        out.curve_donation,
        out.donation_shares_burned,
    )?;
    maybe_record_curve_rebalance_event(pool, timestamp, old_price_scale, new_price_scale);
    Ok(minted)
}

fn execute_curve_remove_liquidity_stateful(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    liquidity: u128,
) -> Result<(u128, u128)> {
    if pool.amm != AmmKind::Curve {
        return Err(anyhow!(
            "execute_curve_remove_liquidity_stateful called for non-curve pool {}",
            pool.context_name
        ));
    }
    ensure_curve_d(pool, quoter)?;
    let out = quoter.curve_remove_liquidity_stateful(pool, liquidity)?;
    let amount0_out = out.amount0_out;
    let amount1_out = out.amount1_out;
    apply_curve_runtime_state(
        pool,
        out.reserve0,
        out.reserve1,
        out.curve_total_supply,
        out.curve_d,
        out.curve_price_scale,
        out.curve_price_oracle,
        out.curve_last_prices,
        out.curve_last_timestamp,
        out.curve_virtual_price,
        out.curve_xcp_profit,
        out.curve_lp_xcp_profit,
        out.curve_donation,
        // Proportional remove never runs `tweak_price`, so it can never
        // burn donation shares.
        0,
    )?;
    Ok((amount0_out, amount1_out))
}

fn maybe_record_curve_rebalance_event(
    pool: &mut PoolState,
    timestamp: u64,
    old_price_scale: u128,
    new_price_scale: u128,
) {
    if old_price_scale == 0 || new_price_scale == 0 || old_price_scale == new_price_scale {
        return;
    }
    pool.recentering_events.push(RecenteringEventOut {
        timestamp,
        ammName: "curve".to_string(),
        poolKey: pool.base_symbol.clone(),
        ilEstimate: "0".to_string(),
        oldPriceScale: Some(old_price_scale.to_string()),
        newPriceScale: Some(new_price_scale.to_string()),
    });
}

fn mul_div_floor(a: u128, b: u128, den: u128) -> u128 {
    if den == 0 {
        return 0;
    }
    let q = (U256::from(a) * U256::from(b)) / U256::from(den);
    q.low_u128()
}

/// Ceiling variant of `mul_div_floor`: returns `ceil(a * b / den)`. Used
/// to derive the effective fee BPS from a sub-bps `fee_amount_raw` so
/// that `fee_amount_raw == 1` still reports `≥ 1` BPS in metrics. Returns
/// 0 when `den == 0` (mirrors floor variant).
fn mul_div_ceil(a: u128, b: u128, den: u128) -> u128 {
    if den == 0 {
        return 0;
    }
    let prod = U256::from(a) * U256::from(b);
    let den_u = U256::from(den);
    let q = (prod + den_u - U256::one()) / den_u;
    q.low_u128()
}

fn checked_add_u128(a: u128, b: u128, context: &str) -> Result<u128> {
    a.checked_add(b)
        .ok_or_else(|| anyhow!("u128 overflow in {context}: {a} + {b}"))
}

fn checked_sub_u128(a: u128, b: u128, context: &str) -> Result<u128> {
    a.checked_sub(b)
        .ok_or_else(|| anyhow!("u128 underflow in {context}: {a} - {b}"))
}

fn checked_mul_u128(a: u128, b: u128, context: &str) -> Result<u128> {
    a.checked_mul(b)
        .ok_or_else(|| anyhow!("u128 overflow in {context}: {a} * {b}"))
}

fn apply_uniswap_v2_stateful_out(
    pool: &mut PoolState,
    out: UniswapV2SwapStatefulOut,
) -> Result<()> {
    if pool.amm != AmmKind::UniswapV2 {
        return Err(anyhow!(
            "apply_uniswap_v2_stateful_out called for non-uniswap pool {}",
            pool.context_name
        ));
    }
    pool.reserve0 = out.reserve0;
    pool.reserve1 = out.reserve1;
    pool.e0 = out.reserve0;
    pool.e1 = out.reserve1;

    let uni = pool
        .uni
        .as_mut()
        .ok_or_else(|| anyhow!("uniswap params missing for {}", pool.context_name))?;
    uni.block_timestamp_last = out.block_timestamp_last;
    uni.price0_cumulative_last = out.price0_cumulative_last;
    uni.price1_cumulative_last = out.price1_cumulative_last;
    uni.k_last = out.k_last;
    Ok(())
}

fn execute_uniswap_v2_stateful_swap(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
) -> Result<u128> {
    if pool.amm != AmmKind::UniswapV2 {
        return Err(anyhow!(
            "execute_uniswap_v2_stateful_swap called for non-uniswap pool {}",
            pool.context_name
        ));
    }
    let out = quoter.uniswap_v2_swap_stateful(pool, token_in, amount_in, timestamp)?;
    let amount_out = out.amount_out;
    apply_uniswap_v2_stateful_out(pool, out)?;
    Ok(amount_out)
}

fn next_execution_timestamp(cursor: &mut u64, market_ts: u64) -> u64 {
    let ts = if market_ts > *cursor {
        market_ts
    } else {
        cursor.saturating_add(1)
    };
    *cursor = ts;
    ts
}

/// Unified swap-execution result emitted by `execute_stateful_swap_for_context`.
/// Carries enough information to populate the per-swap reporting fields
/// (`feePaidUsd` / `actualFeeBps`) accurately for every supported AMM,
/// including those with dynamic fees (Equilibra smoothstep, Curve V2
/// `mid_fee → out_fee` ramp).
///
/// `fee_amount_raw` is denominated in raw units of `fee_token_symbol`,
/// which differs by AMM:
///   * Equilibra & UniswapV2 — fee is taken from `amount_in` ⇒ `token_in`.
///   * Curve — fee is taken from `amount_out` ⇒ `token_out`.
///
/// `actual_fee_bps` is the BPS rate that was *actually* applied on this
/// swap (smoothstep value for Equilibra, dynamic `curve_fee` for Curve,
/// static `pool.fee_bps` for UniswapV2). It is meaningful even when
/// `amount_in == 0` (then `fee_amount_raw == 0`).
#[derive(Debug, Clone)]
struct StatefulSwapExecOut {
    amount_out: u128,
    fee_amount_raw: u128,
    fee_token_symbol: String,
    actual_fee_bps: u64,
}

fn execute_stateful_swap_for_context(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
    cli: &Cli,
    gate_stats: &mut RecenterGateStatsBundle,
) -> Result<StatefulSwapExecOut> {
    // Symbol Strings are allocated inside the branch that actually reports
    // them, and error contexts read `pool.context_name` only AFTER the
    // execution call returned (the mutable borrow has ended by then) — this
    // function runs for every executed swap, so the previous eager
    // clone-per-call pattern allocated 3-4 Strings even on paths that
    // discard the fee fields entirely.
    if opposite_pool_token_symbol(pool, token_in).is_none() {
        return Err(anyhow!(
            "execute_stateful_swap_for_context: token_in {} not in pool {}",
            token_in,
            pool.context_name,
        ));
    }

    if pool.amm == AmmKind::Curve {
        let disable_curve = is_curve_rebalance_disabled(pool, cli.disable_curve_rebalance);
        let curve_out = match execute_curve_stateful_swap(
            pool,
            quoter,
            token_in,
            amount_in,
            timestamp,
            disable_curve,
            &mut gate_stats.curve,
        ) {
            Ok(v) => v,
            Err(e) => {
                return Err(e.context(format!(
                    "curve execution stateful swap failed for {}",
                    pool.context_name
                )))
            }
        };
        let token_out_symbol = opposite_pool_token_symbol(pool, token_in)
            .expect("membership checked above")
            .to_string();
        Ok(StatefulSwapExecOut {
            amount_out: curve_out.amount_out,
            // Curve charges the fee on the OUTPUT side, so this amount
            // is denominated in `token_out` units. The reporting helper
            // converts to USD using the matching oracle.
            fee_amount_raw: curve_out.fee_amount_out,
            fee_token_symbol: token_out_symbol,
            actual_fee_bps: curve_out.fee_bps_effective,
        })
    } else if pool.amm == AmmKind::UniswapV2 {
        let amount_out =
            match execute_uniswap_v2_stateful_swap(pool, quoter, token_in, amount_in, timestamp) {
                Ok(v) => v,
                Err(e) => {
                    return Err(e.context(format!(
                        "uniswap execution stateful swap failed for {}",
                        pool.context_name
                    )))
                }
            };
        // UniswapV2 has a flat fee taken from `amount_in`. Mirror the
        // on-chain `amountInWithFee = amountIn * (10000 - fee)` convention
        // by reporting the complement on the input side.
        let fee_amount_in = mul_div_floor(amount_in, pool.fee_bps as u128, BPS_DENOM);
        Ok(StatefulSwapExecOut {
            amount_out,
            fee_amount_raw: fee_amount_in,
            fee_token_symbol: token_in.to_string(),
            actual_fee_bps: pool.fee_bps,
        })
    } else {
        let disable_recenter = is_equilibra_recenter_disabled(pool, cli.disable_equilibra_recenter);
        let eq_out = match execute_equilibra_stateful_swap(
            pool,
            quoter,
            token_in,
            amount_in,
            timestamp,
            disable_recenter,
            &mut gate_stats.equilibra,
        ) {
            Ok(v) => v,
            Err(e) => {
                return Err(e.context(format!(
                    "equilibra execution stateful swap failed for {}",
                    pool.context_name
                )))
            }
        };
        // Equilibra charges its fee on the INPUT side. The effective
        // rate can range from `feeFloorBps` (≈ 0 distance) through
        // `feeBps` (≥ ramp width). Recover it from the actually applied
        // `fee_amount_raw` so dynamic-fee runs are reported faithfully.
        // Defensive `if amount_in == 0` fallback keeps the call safe for
        // zero-amount swaps (the simulator should never send those, but
        // we don't want a panic if it does).
        let actual_fee_bps = if amount_in == 0 {
            pool.fee_bps
        } else {
            // Round up so the on-chain `fee = ceil(amount_in * bps / 1e4)`
            // semantics survive the round-trip (very small swaps with
            // `fee_amount_raw == 1` should still report ≥ 1 BPS).
            let derived = mul_div_ceil(eq_out.fee_amount_raw, BPS_DENOM, amount_in);
            u64::try_from(derived).unwrap_or(u64::MAX)
        };
        Ok(StatefulSwapExecOut {
            amount_out: eq_out.amount_out,
            fee_amount_raw: eq_out.fee_amount_raw,
            fee_token_symbol: token_in.to_string(),
            actual_fee_bps,
        })
    }
}

/// Per-context aggregate for the noise-trader adaptive gate. Counters are kept
/// outside of the per-pool mutable state so they survive across round-trip
/// invocations and can be surfaced in a single compact tail-log line at the
/// end of the run. Nothing about these counters feeds back into simulation
/// math — they are purely observational and must never gate or bias swap
/// execution. See `emit_post_arb_gate_summary` for the output format.
#[derive(Default, Debug, Clone)]
struct PostArbGateStatsPerContext {
    /// Sum of `cycle_count` across every invocation of the round-trip loop
    /// (i.e. the maximum number of cycles that could have been attempted if
    /// the adaptive gate had never fired and no probe ever failed).
    cycles_possible: u64,
    /// Cycles skipped by the adaptive `abnormalLossFactor` gate after the
    /// first probe round-trip came back worse than
    /// `baseline × abnormalLossFactor`.
    cycles_aborted_by_gate: u64,
    /// Cycles skipped because the probe round-trip itself failed to quote /
    /// execute (forward or backward leg errored or returned zero on probe).
    cycles_aborted_by_probe_failure: u64,
    /// Non-fatal leg failures that are not gate aborts (pair mismatch,
    /// forward/backward leg errored or returned zero outside the probe path).
    leg_warnings: u64,
}

#[derive(Default, Debug, Clone)]
struct PostArbGateStatsByContext {
    per_context: BTreeMap<String, PostArbGateStatsPerContext>,
}

impl PostArbGateStatsByContext {
    fn entry_mut(&mut self, ctx: &str) -> &mut PostArbGateStatsPerContext {
        self.per_context.entry(ctx.to_string()).or_default()
    }
}

/// Emit a one-line-per-context summary of the adaptive post-arb gate. Writes
/// to `stderr` so it stays out of the structured JSON artifacts and simply
/// streams into the dashboard tail log. Nothing is printed for contexts that
/// never attempted a round-trip (e.g. post-arb disabled, count=0).
fn emit_post_arb_gate_summary(stats: &PostArbGateStatsByContext) {
    let mut any = false;
    for (context_name, s) in &stats.per_context {
        if s.cycles_possible == 0 && s.leg_warnings == 0 {
            continue;
        }
        let aborted = s
            .cycles_aborted_by_gate
            .saturating_add(s.cycles_aborted_by_probe_failure);
        let executed = s.cycles_possible.saturating_sub(aborted);
        let pct = if s.cycles_possible > 0 {
            (aborted as f64) * 100.0 / (s.cycles_possible as f64)
        } else {
            0.0
        };
        eprintln!(
            "[simulator][post-arb-summary] {}: aborted {} / {} cycles ({:.2}% aborted, {} executed) \
             [adaptive_gate={} probe_failure={} leg_warnings={}]",
            context_name,
            aborted,
            s.cycles_possible,
            pct,
            executed,
            s.cycles_aborted_by_gate,
            s.cycles_aborted_by_probe_failure,
            s.leg_warnings,
        );
        any = true;
    }
    if !any {
        eprintln!(
            "[simulator][post-arb-summary] no post-arb external round-trips executed \
             (post-arb disabled or count=0)"
        );
    }
}

/// Constant-product (`x * y = k`) baseline round-trip loss for a noise-trader
/// probe round, expressed in basis points of the forward amount. Uses the
/// explicit closed form so that the approximation stays accurate even for
/// chunk sizes that are non-negligible relative to pool depth:
///
/// ```text
/// out_fwd = y * A * (1-f) / (x + A * (1-f))
/// out_bwd = (x + A) * out_fwd * (1-f) / ((y - out_fwd) + out_fwd * (1-f))
/// loss    = (A - out_bwd) / A
/// ```
///
/// Returns `2*fee_bps` when any input is degenerate, which is the limit for
/// infinitesimal chunks and keeps the gate permissive in pathological cases.
fn constant_product_baseline_loss_bps(
    fee_bps: u64,
    amount_in: u128,
    reserve_input_side: u128,
    reserve_output_side: u128,
) -> f64 {
    let fee_leg = (fee_bps as f64) / 10_000.0;
    let minimum = 2.0 * (fee_bps as f64);
    if amount_in == 0 || reserve_input_side == 0 || reserve_output_side == 0 {
        return minimum;
    }
    let one_minus_f = 1.0 - fee_leg;
    if one_minus_f <= 0.0 {
        return 10_000.0;
    }
    let a = amount_in as f64;
    let x = reserve_input_side as f64;
    let y = reserve_output_side as f64;
    let out_fwd_denom = x + a * one_minus_f;
    if out_fwd_denom <= 0.0 {
        return minimum;
    }
    let out_fwd = y * a * one_minus_f / out_fwd_denom;
    if out_fwd <= 0.0 || out_fwd >= y {
        return minimum;
    }
    let x_after = x + a;
    let y_after = (y - out_fwd).max(f64::EPSILON);
    let out_bwd_denom = y_after + out_fwd * one_minus_f;
    if out_bwd_denom <= 0.0 {
        return minimum;
    }
    let out_bwd = x_after * out_fwd * one_minus_f / out_bwd_denom;
    if out_bwd >= a {
        return minimum;
    }
    let ratio = (a - out_bwd) / a;
    (ratio * 10_000.0).max(minimum)
}

fn is_post_arb_external_swaps_enabled(pool: &PoolState, cli: &Cli) -> bool {
    if pool.amm == AmmKind::Curve {
        return !is_curve_rebalance_disabled(pool, cli.disable_curve_rebalance);
    }
    if pool.amm == AmmKind::Equilibra {
        return !is_equilibra_recenter_disabled(pool, cli.disable_equilibra_recenter);
    }
    pool.uni
        .as_ref()
        .map(|uni| uni.rebalance_enabled)
        .unwrap_or(false)
}

fn opposite_pool_token_symbol<'a>(pool: &'a PoolState, token_in_symbol: &str) -> Option<&'a str> {
    if token_in_symbol == pool.token0_symbol {
        return Some(pool.token1_symbol.as_str());
    }
    if token_in_symbol == pool.token1_symbol {
        return Some(pool.token0_symbol.as_str());
    }
    None
}

fn run_post_arb_external_round_trips(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    cli: &Cli,
    market_ts: u64,
    execution_ts_cursor: &mut u64,
    arb_token_in_symbol: &str,
    arb_amount_in: u128,
    oracle_price_1e18: u128,
    cfg: PostArbExternalSwapsCfg,
    gate_stats: &mut RecenterGateStatsBundle,
    post_arb_stats: &mut PostArbGateStatsByContext,
) {
    if !is_post_arb_external_swaps_enabled(pool, cli) {
        return;
    }
    let cycle_count = cfg.count.min(1_000);
    if cycle_count == 0 || cfg.shareBps == 0 || arb_amount_in == 0 {
        return;
    }

    let token_out_symbol = match opposite_pool_token_symbol(pool, arb_token_in_symbol) {
        Some(v) => v.to_string(),
        None => {
            eprintln!(
                "[simulator][warning] post-arb external swaps skipped for {}: token_in {} is not part of the pool pair {} / {}",
                pool.context_name, arb_token_in_symbol, pool.token0_symbol, pool.token1_symbol
            );
            post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
            return;
        }
    };

    let share_bps = cfg.shareBps.min(BPS_DENOM as u64) as u128;
    let share_amount_in = mul_div_floor(arb_amount_in, share_bps, BPS_DENOM);
    if share_amount_in == 0 {
        return;
    }

    let mut per_swap_amount_in = share_amount_in / (cycle_count as u128);
    let min_swap_amount_in = usd_to_token_amount(
        usd18_from_f64(cfg.minAmountUsd.max(0.0)),
        arb_token_in_symbol,
        oracle_price_1e18,
    );
    if per_swap_amount_in < min_swap_amount_in {
        per_swap_amount_in = min_swap_amount_in;
    }
    if per_swap_amount_in == 0 {
        return;
    }

    // Adaptive gate: after the first probe cycle we compare the observed
    // round-trip loss against a constant-product baseline scaled by
    // `abnormalLossFactor`. If the probe came out much worse than a vanilla
    // CPM would yield, the noise trader "walks away" and we skip the
    // remaining cycles. The gate runs only when there is more than one cycle
    // (otherwise there's nothing to skip) and the factor is positive.
    let abnormal_factor = cfg.abnormalLossFactor;
    let probe_enabled = abnormal_factor > 0.0 && cycle_count > 1;
    let (baseline_reserve_in, baseline_reserve_out) = if probe_enabled {
        if arb_token_in_symbol == pool.token0_symbol {
            (pool.reserve0, pool.reserve1)
        } else {
            (pool.reserve1, pool.reserve0)
        }
    } else {
        (0u128, 0u128)
    };
    let pool_fee_bps = pool.fee_bps;

    // Record the theoretical maximum number of cycles for this invocation.
    // Any cycles we skip below (via the adaptive gate or because the probe
    // failed) are accounted against this budget in the summary line emitted
    // at the end of `run_simulation`.
    post_arb_stats.entry_mut(&pool.context_name).cycles_possible += cycle_count;

    for cycle_i in 0..cycle_count {
        let forward_ts = next_execution_timestamp(execution_ts_cursor, market_ts);
        let forward_result = execute_stateful_swap_for_context(
            pool,
            quoter,
            arb_token_in_symbol,
            per_swap_amount_in,
            forward_ts,
            cli,
            gate_stats,
        );
        let forward_out = match forward_result {
            Ok(ref out) if out.amount_out > 0 => Some(out.amount_out),
            Ok(_) => {
                eprintln!(
                    "[simulator][warning] post-arb external forward swap returned zero for {} (cycle {}/{}) at ts {}",
                    pool.context_name,
                    cycle_i + 1,
                    cycle_count,
                    forward_ts
                );
                post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
                None
            }
            Err(err) => {
                eprintln!(
                    "[simulator][warning] post-arb external forward swap failed for {} (cycle {}/{}) at ts {}: {}",
                    pool.context_name,
                    cycle_i + 1,
                    cycle_count,
                    forward_ts,
                    err
                );
                post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
                None
            }
        };

        let backward_ts = next_execution_timestamp(execution_ts_cursor, market_ts);
        let backward_out = if let Some(backward_amount_in) = forward_out {
            let backward_result = execute_stateful_swap_for_context(
                pool,
                quoter,
                &token_out_symbol,
                backward_amount_in,
                backward_ts,
                cli,
                gate_stats,
            );
            match backward_result {
                Ok(out) => Some(out.amount_out),
                Err(err) => {
                    eprintln!(
                        "[simulator][warning] post-arb external backward swap failed for {} (cycle {}/{}) at ts {}: {}",
                        pool.context_name,
                        cycle_i + 1,
                        cycle_count,
                        backward_ts,
                        err
                    );
                    post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
                    None
                }
            }
        } else {
            eprintln!(
                "[simulator][warning] post-arb external backward swap skipped for {} (cycle {}/{}) at ts {} because forward leg failed",
                pool.context_name,
                cycle_i + 1,
                cycle_count,
                backward_ts
            );
            post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
            None
        };

        if probe_enabled && cycle_i == 0 {
            let remaining = cycle_count.saturating_sub(cycle_i as u64 + 1);
            match backward_out {
                Some(out) if out < per_swap_amount_in => {
                    let loss = (per_swap_amount_in - out) as f64;
                    let observed_loss_bps = loss * 10_000.0 / (per_swap_amount_in as f64);
                    let baseline_loss_bps = constant_product_baseline_loss_bps(
                        pool_fee_bps,
                        per_swap_amount_in,
                        baseline_reserve_in,
                        baseline_reserve_out,
                    );
                    let threshold = baseline_loss_bps * abnormal_factor;
                    if observed_loss_bps > threshold {
                        post_arb_stats
                            .entry_mut(&pool.context_name)
                            .cycles_aborted_by_gate += remaining;
                        break;
                    }
                }
                Some(_) => {
                    // Backward leg returned at least the forward amount (e.g.
                    // thanks to a free TOWARD-recenter between the two legs).
                    // That is not a "trader got burnt" signal, keep cycling.
                }
                None => {
                    // Probe could not complete. Walk away defensively rather
                    // than hammering a pool that just failed to quote.
                    post_arb_stats
                        .entry_mut(&pool.context_name)
                        .cycles_aborted_by_probe_failure += remaining;
                    break;
                }
            }
        }
    }
}

fn run_min_post_arb_external_round_trip_without_arb(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    cli: &Cli,
    market_ts: u64,
    execution_ts_cursor: &mut u64,
    oracle_price_1e18: u128,
    cfg: PostArbExternalSwapsCfg,
    gate_stats: &mut RecenterGateStatsBundle,
    post_arb_stats: &mut PostArbGateStatsByContext,
) {
    if !is_post_arb_external_swaps_enabled(pool, cli) {
        return;
    }
    if cfg.count == 0 || cfg.minAmountUsd <= 0.0 {
        return;
    }

    let forward_token_in_symbol = if pool.token0_symbol == "USDT" {
        pool.token0_symbol.clone()
    } else if pool.token1_symbol == "USDT" {
        pool.token1_symbol.clone()
    } else {
        pool.token0_symbol.clone()
    };
    let backward_token_in_symbol = match opposite_pool_token_symbol(
        pool,
        forward_token_in_symbol.as_str(),
    ) {
        Some(v) => v.to_string(),
        None => {
            eprintln!(
                    "[simulator][warning] post-arb minimal round-trip skipped for {}: token_in {} is not part of the pool pair {} / {}",
                    pool.context_name,
                    forward_token_in_symbol,
                    pool.token0_symbol,
                    pool.token1_symbol
                );
            post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
            return;
        }
    };

    let min_swap_amount_in = usd_to_token_amount(
        usd18_from_f64(cfg.minAmountUsd),
        forward_token_in_symbol.as_str(),
        oracle_price_1e18,
    );
    if min_swap_amount_in == 0 {
        return;
    }

    let forward_ts = next_execution_timestamp(execution_ts_cursor, market_ts);
    let forward_result = execute_stateful_swap_for_context(
        pool,
        quoter,
        forward_token_in_symbol.as_str(),
        min_swap_amount_in,
        forward_ts,
        cli,
        gate_stats,
    );
    let forward_out = match forward_result {
        Ok(ref out) if out.amount_out > 0 => Some(out.amount_out),
        Ok(_) => {
            eprintln!(
                "[simulator][warning] post-arb minimal forward swap returned zero for {} at ts {}",
                pool.context_name, forward_ts
            );
            post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
            None
        }
        Err(err) => {
            eprintln!(
                "[simulator][warning] post-arb minimal forward swap failed for {} at ts {}: {}",
                pool.context_name, forward_ts, err
            );
            post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
            None
        }
    };

    let backward_ts = next_execution_timestamp(execution_ts_cursor, market_ts);
    if let Some(backward_amount_in) = forward_out {
        let backward_result = execute_stateful_swap_for_context(
            pool,
            quoter,
            backward_token_in_symbol.as_str(),
            backward_amount_in,
            backward_ts,
            cli,
            gate_stats,
        );
        if let Err(err) = backward_result {
            eprintln!(
                "[simulator][warning] post-arb minimal backward swap failed for {} at ts {}: {}",
                pool.context_name, backward_ts, err
            );
            post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
        }
    } else {
        eprintln!(
            "[simulator][warning] post-arb minimal backward swap skipped for {} at ts {} because forward leg failed",
            pool.context_name, backward_ts
        );
        post_arb_stats.entry_mut(&pool.context_name).leg_warnings += 1;
    }
}

fn is_curve_rebalance_disabled(pool: &PoolState, disable_curve_rebalance: bool) -> bool {
    disable_curve_rebalance
        || pool
            .curve
            .as_ref()
            .map(|curve| !curve.rebalance_enabled)
            .unwrap_or(false)
}

fn is_equilibra_recenter_disabled(pool: &PoolState, disable_equilibra_recenter: bool) -> bool {
    disable_equilibra_recenter
        || pool
            .eq
            .as_ref()
            .map(|eq| !eq.rebalance_enabled)
            .unwrap_or(false)
}

fn lp_assets_for_mint_burn(pool: &PoolState) -> (u128, u128) {
    if pool.amm == AmmKind::Equilibra {
        (pool.e0, pool.e1)
    } else {
        (pool.reserve0, pool.reserve1)
    }
}

fn add_liquidity(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
    disable_curve_rebalance: bool,
) -> Result<(u128, u128, u128)> {
    if pool.amm == AmmKind::Curve {
        if amount0 == 0 && amount1 == 0 {
            return Ok((0, 0, 0));
        }
        let (minted, used0, used1) = execute_curve_add_liquidity_stateful(
            pool,
            quoter,
            amount0,
            amount1,
            timestamp,
            disable_curve_rebalance,
        )?;
        if minted == 0 {
            return Ok((0, 0, 0));
        }
        pool.lp1_liquidity = checked_add_u128(
            pool.lp1_liquidity,
            minted,
            "add_liquidity curve lp1_liquidity + minted",
        )?;
        return Ok((minted, used0, used1));
    }

    if pool.amm == AmmKind::Equilibra {
        return equilibra_add_liquidity(pool, quoter, amount0, amount1, timestamp);
    }

    let old_supply = pool.total_supply;
    let (asset0, asset1) = lp_assets_for_mint_burn(pool);
    let minted_total = if old_supply == 0 {
        integer_sqrt(checked_mul_u128(
            amount0,
            amount1,
            "add_liquidity initial mint amount0 * amount1",
        )?)
    } else {
        let l0 = if asset0 > 0 {
            mul_div_floor(amount0, old_supply, asset0)
        } else {
            0
        };
        let l1 = if asset1 > 0 {
            mul_div_floor(amount1, old_supply, asset1)
        } else {
            0
        };
        if l0 <= l1 {
            l0
        } else {
            l1
        }
    };

    if old_supply == 0 && pool.amm == AmmKind::UniswapV2 {
        let min_liquidity = UNISWAP_MINIMUM_LIQUIDITY;
        if minted_total <= min_liquidity {
            return Ok((0, 0, 0));
        }
        let minted_user = minted_total - min_liquidity;
        pool.total_supply = checked_add_u128(
            pool.total_supply,
            minted_total,
            "add_liquidity initial total_supply + minted_total",
        )?;
        pool.lp1_liquidity = checked_add_u128(
            pool.lp1_liquidity,
            minted_user,
            "add_liquidity initial lp1_liquidity + minted_user",
        )?;
        pool.reserve0 = checked_add_u128(
            pool.reserve0,
            amount0,
            "add_liquidity initial reserve0 + amount0",
        )?;
        pool.reserve1 = checked_add_u128(
            pool.reserve1,
            amount1,
            "add_liquidity initial reserve1 + amount1",
        )?;
        pool.e0 = pool.reserve0;
        pool.e1 = pool.reserve1;
        pool.anchor0 = pool.reserve0;
        pool.anchor1 = pool.reserve1;
        return Ok((minted_user, amount0, amount1));
    }

    if minted_total == 0 {
        return Ok((0, 0, 0));
    }
    let minted = minted_total;

    pool.total_supply = checked_add_u128(
        pool.total_supply,
        minted,
        "add_liquidity total_supply + minted",
    )?;
    pool.lp1_liquidity = checked_add_u128(
        pool.lp1_liquidity,
        minted,
        "add_liquidity lp1_liquidity + minted",
    )?;

    if old_supply == 0 {
        pool.reserve0 = checked_add_u128(
            pool.reserve0,
            amount0,
            "add_liquidity zero-supply reserve0 + amount0",
        )?;
        pool.reserve1 = checked_add_u128(
            pool.reserve1,
            amount1,
            "add_liquidity zero-supply reserve1 + amount1",
        )?;
        pool.e0 = pool.reserve0;
        pool.e1 = pool.reserve1;
        pool.anchor0 = pool.reserve0;
        pool.anchor1 = pool.reserve1;
        if let Some(curve) = pool.curve.as_mut() {
            curve.d_dirty = true;
        }
        return Ok((minted, amount0, amount1));
    }

    let used0 = mul_div_floor(minted, asset0, old_supply);
    let used1 = mul_div_floor(minted, asset1, old_supply);

    pool.reserve0 = checked_add_u128(pool.reserve0, used0, "add_liquidity reserve0 + used0")?;
    pool.reserve1 = checked_add_u128(pool.reserve1, used1, "add_liquidity reserve1 + used1")?;
    pool.e0 = pool.reserve0;
    pool.e1 = pool.reserve1;
    if let Some(curve) = pool.curve.as_mut() {
        curve.d_dirty = true;
    }

    Ok((minted, used0, used1))
}

/// Add liquidity to an Equilibra pool, mirroring the canonical two-branch
/// flow from `EquilibraPool.addLiquidity`:
///
///   * **Genesis branch** (`totalSupply == 0`): delegate to
///     `equilibra::init_genesis`, which seeds `anchor_price_wad` and the
///     VP tracking fields exactly the way the on-chain constructor does.
///   * **Proportional branch** (`totalSupply > 0`): delegate to
///     `equilibra::add_liquidity_proportional`, which preserves the
///     invariant ray and re-anchors the VP checkpoint without touching
///     cumulative profit.
fn equilibra_add_liquidity(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
) -> Result<(u128, u128, u128)> {
    if amount0 == 0 || amount1 == 0 {
        return Ok((0, 0, 0));
    }
    // Ensure the cached stateful config is populated.
    let _ = quoter.ensure_equilibra_stateful_cfg(pool)?;
    let cfg = quoter
        .equilibra_stateful_cfg_cache
        .get(&pool.context_name)
        .ok_or_else(|| anyhow!("equilibra stateful cfg missing for {}", pool.context_name))?;

    if pool.total_supply == 0 {
        let genesis = equilibra::init_genesis(cfg, amount0, amount1, timestamp)?;
        pool.reserve0 = genesis.reserve0;
        pool.reserve1 = genesis.reserve1;
        pool.total_supply = genesis.total_supply;
        pool.lp1_liquidity = checked_add_u128(
            pool.lp1_liquidity,
            genesis.shares_out,
            "eq_add_liquidity genesis lp1_liquidity + shares",
        )?;
        pool.e0 = genesis.reserve0;
        pool.e1 = genesis.reserve1;
        pool.protocol_fee0 = 0;
        pool.protocol_fee1 = 0;
        pool.anchor_price_wad = genesis.price_scale_wad;
        pool.ema_price = genesis.ema_price_wad;
        pool.last_timestamp = genesis.last_ema_ts;
        pool.last_recenter_ts = genesis.last_repeg_ts;
        pool.lp_unit_value_genesis_wad = genesis.lp_unit_value_genesis_wad;
        pool.lp_unit_value_wad = genesis.lp_unit_value_genesis_wad;
        pool.lp_value_growth_wad = 0;
        pool.budget_fee0 = 0;
        pool.budget_fee1 = 0;
        let (anchor0, anchor1) = derive_legacy_anchor_balances(
            pool.reserve0,
            pool.reserve1,
            pool.anchor_price_wad,
            pool.token0_decimals,
            pool.token1_decimals,
        );
        pool.anchor0 = anchor0;
        pool.anchor1 = anchor1;
        return Ok((genesis.shares_out, genesis.reserve0, genesis.reserve1));
    }

    let state_before = equilibra_state_from_pool(pool);
    let (a0_used, a1_used, shares_out, r0_new, r1_new, total_new, lp_unit_value_new, donation_new) =
        equilibra::add_liquidity_proportional(&state_before, amount0, amount1, cfg)?;
    pool.reserve0 = r0_new;
    pool.reserve1 = r1_new;
    pool.total_supply = total_new;
    pool.donation_shares = donation_new;
    pool.lp1_liquidity = checked_add_u128(
        pool.lp1_liquidity,
        shares_out,
        "eq_add_liquidity proportional lp1_liquidity + shares",
    )?;
    pool.e0 = r0_new;
    pool.e1 = r1_new;
    pool.lp_unit_value_wad = lp_unit_value_new;
    let (anchor0, anchor1) = derive_legacy_anchor_balances(
        pool.reserve0,
        pool.reserve1,
        pool.anchor_price_wad,
        pool.token0_decimals,
        pool.token1_decimals,
    );
    pool.anchor0 = anchor0;
    pool.anchor1 = anchor1;
    Ok((shares_out, a0_used, a1_used))
}

/// Convert a `PoolState` snapshot into the runtime_quoter
/// representation used by the math kernel.
fn equilibra_state_from_pool(pool: &PoolState) -> equilibra::EquilibraStatefulState {
    equilibra::EquilibraStatefulState {
        reserve0: pool.reserve0,
        reserve1: pool.reserve1,
        price_scale_wad: pool.anchor_price_wad,
        total_supply: pool.total_supply,
        protocol_fee0: pool.protocol_fee0,
        protocol_fee1: pool.protocol_fee1,
        e0: pool.e0,
        e1: pool.e1,
        ema_price_wad: pool.ema_price,
        last_ema_ts: pool.last_timestamp,
        last_repeg_ts: pool.last_recenter_ts,
        lp_unit_value_genesis_wad: pool.lp_unit_value_genesis_wad,
        lp_unit_value_wad: pool.lp_unit_value_wad,
        lp_value_growth_wad: pool.lp_value_growth_wad,
        donation_shares: pool.donation_shares,
    }
}

fn remove_liquidity(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    liquidity: u128,
    _timestamp: u64,
) -> Result<(u128, u128)> {
    if liquidity == 0 || pool.total_supply == 0 {
        return Ok((0, 0));
    }

    let burn = if liquidity <= pool.lp1_liquidity {
        liquidity
    } else {
        pool.lp1_liquidity
    };
    if burn == 0 {
        return Ok((0, 0));
    }

    if pool.amm == AmmKind::Curve {
        let (amount0_out, amount1_out) =
            execute_curve_remove_liquidity_stateful(pool, quoter, burn)?;
        pool.lp1_liquidity = checked_sub_u128(
            pool.lp1_liquidity,
            burn,
            "remove_liquidity curve lp1_liquidity - burn",
        )?;
        return Ok((amount0_out, amount1_out));
    }

    if pool.amm == AmmKind::Equilibra {
        return equilibra_remove_liquidity(pool, quoter, burn);
    }

    let old_supply = pool.total_supply;
    let r0_out = mul_div_floor(pool.reserve0, burn, old_supply);
    let r1_out = mul_div_floor(pool.reserve1, burn, old_supply);

    pool.total_supply = checked_sub_u128(
        pool.total_supply,
        burn,
        "remove_liquidity total_supply - burn",
    )?;
    pool.lp1_liquidity = checked_sub_u128(
        pool.lp1_liquidity,
        burn,
        "remove_liquidity lp1_liquidity - burn",
    )?;

    pool.reserve0 = checked_sub_u128(pool.reserve0, r0_out, "remove_liquidity reserve0 - r0_out")?;
    pool.reserve1 = checked_sub_u128(pool.reserve1, r1_out, "remove_liquidity reserve1 - r1_out")?;
    pool.e0 = pool.reserve0;
    pool.e1 = pool.reserve1;
    pool.anchor0 = pool.reserve0;
    pool.anchor1 = pool.reserve1;
    if let Some(curve) = pool.curve.as_mut() {
        curve.d_dirty = true;
    }
    Ok((r0_out, r1_out))
}

/// Remove liquidity from an Equilibra pool using the hybrid-invariant
/// proportional burn. Mirrors `equilibra::remove_liquidity_proportional` and
/// re-anchors the VP checkpoint without touching cumulative profit.
fn equilibra_remove_liquidity(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    burn: u128,
) -> Result<(u128, u128)> {
    if burn == 0 || pool.total_supply == 0 {
        return Ok((0, 0));
    }
    quoter.ensure_equilibra_stateful_cfg(pool)?;
    let cfg = quoter
        .equilibra_stateful_cfg_cache
        .get(&pool.context_name)
        .ok_or_else(|| anyhow!("equilibra stateful cfg missing for {}", pool.context_name))?;
    let state_before = equilibra_state_from_pool(pool);
    let (a0, a1, r0_new, r1_new, total_new, lp_unit_value_new, donation_new) =
        equilibra::remove_liquidity_proportional(&state_before, burn, cfg)?;
    pool.reserve0 = r0_new;
    pool.reserve1 = r1_new;
    pool.total_supply = total_new;
    pool.donation_shares = donation_new;
    pool.lp1_liquidity = checked_sub_u128(
        pool.lp1_liquidity,
        burn,
        "eq_remove_liquidity lp1_liquidity - burn",
    )?;
    pool.e0 = r0_new;
    pool.e1 = r1_new;
    pool.lp_unit_value_wad = lp_unit_value_new;
    if total_new == 0 {
        // Post full-burn the pool has no LPs to protect with a budget and the
        // legacy anchor-balance mirrors are conventionally zeroed along with
        // the reserves. `_anchorPrice`, `_emaPrice`, `_lastEmaTs`, and
        // `_lastRepegTs` are deliberately preserved so that a follow-up
        // `addLiquidity` picks up from the same oracle state the contract
        // keeps around.
        pool.anchor0 = 0;
        pool.anchor1 = 0;
    } else {
        let (anchor0, anchor1) = derive_legacy_anchor_balances(
            pool.reserve0,
            pool.reserve1,
            pool.anchor_price_wad,
            pool.token0_decimals,
            pool.token1_decimals,
        );
        pool.anchor0 = anchor0;
        pool.anchor1 = anchor1;
    }
    pool.budget_fee0 = 0;
    pool.budget_fee1 = 0;
    Ok((a0, a1))
}

fn value_usd(pool: &PoolState, amount0: u128, amount1: u128, oracle_price: f64) -> f64 {
    let d0 = 10f64.powi(pool.token0_decimals as i32);
    let d1 = 10f64.powi(pool.token1_decimals as i32);
    if pool.token0_symbol == "USDT" {
        let usdt = amount0 as f64 / d0;
        let base = amount1 as f64 / d1;
        usdt + base * oracle_price
    } else {
        let base = amount0 as f64 / d0;
        let usdt = amount1 as f64 / d1;
        base * oracle_price + usdt
    }
}

/// Fraction of the passive LP's CURRENT position value attributable to
/// the donation stream. Derived from the multiplicative uplift index:
/// a claim's value WITHOUT any donation is `gross / index`, so the
/// donated share is `1 − 1/index`. Exact for any number of events,
/// interleaved mints/burns and later earnings — unlike a
/// shares-over-supply ratio, which only holds for a single event.
fn donation_value_fraction(pool: &PoolState) -> f64 {
    let index = match pool.amm {
        AmmKind::Equilibra => pool.eq.as_ref().map(|e| e.donation_uplift_index),
        AmmKind::Curve => pool.curve.as_ref().map(|c| c.donation_uplift_index),
        AmmKind::UniswapV2 => None,
    }
    .unwrap_or(PRECISION);
    if index <= PRECISION {
        0.0
    } else {
        1.0 - (PRECISION as f64 / index as f64)
    }
}

fn lp_share_amounts(pool: &PoolState) -> (u128, u128) {
    // Active-share redemption: Equilibra's parked donation shares
    // (`pool.donation_shares`, always 0 for other AMMs — the Curve
    // buffer lives inside `curve.donation` and DOES hold a claim) are
    // excluded from the denominator, matching
    // `remove_liquidity_proportional` so the daily value/composition
    // snapshots agree with what the passive LP would actually redeem.
    let active = pool.total_supply.saturating_sub(pool.donation_shares);
    if active == 0 {
        return (0, 0);
    }
    let lp = pool.lp1_liquidity;
    if lp == 0 {
        return (0, 0);
    }
    let (a0, a1) = lp_assets_for_mint_burn(pool);
    (mul_div_floor(a0, lp, active), mul_div_floor(a1, lp, active))
}

fn calc_profit_usd(
    amount_in: u128,
    amount_out: u128,
    direction: &str,
    base_symbol: &str,
    oracle_price_1e18: u128,
    gas_cost_usd: f64,
) -> f64 {
    let gross = if direction == "buy" {
        let amount_in_usd = amount_in as f64 / 1e6;
        let base_dec = 10f64.powi(token_decimals(base_symbol) as i32);
        let base_units = amount_out as f64 / base_dec;
        let oracle = oracle_price_1e18 as f64 / 1e18;
        base_units * oracle - amount_in_usd
    } else {
        let base_dec = 10f64.powi(token_decimals(base_symbol) as i32);
        let base_units = amount_in as f64 / base_dec;
        let oracle = oracle_price_1e18 as f64 / 1e18;
        let out_usd = amount_out as f64 / 1e6;
        out_usd - base_units * oracle
    };
    gross - gas_cost_usd
}

fn estimate_trade_value_usd(
    amount_native: u128,
    direction: &str,
    base_symbol: &str,
    oracle_price: f64,
) -> f64 {
    if direction == "buy" {
        amount_native as f64 / 1e6
    } else {
        amount_native as f64 / 10f64.powi(token_decimals(base_symbol) as i32) * oracle_price
    }
}

fn get_max_trade_size(pool: &PoolState, direction: &str, oracle_price_1e18: u128) -> u128 {
    let is_token0_quote = pool.token0_symbol == "USDT";
    let output_reserve = if direction == "buy" {
        if is_token0_quote {
            pool.reserve1
        } else {
            pool.reserve0
        }
    } else if is_token0_quote {
        pool.reserve0
    } else {
        pool.reserve1
    };

    let max_output = mul_div_floor(output_reserve, 90u128, 100u128);
    let base_dec = token_decimals(&pool.base_symbol) as u32;
    let quote_dec = token_decimals("USDT") as u32;

    if direction == "buy" {
        if base_dec > quote_dec {
            let scale = pow10_u128(base_dec - quote_dec);
            let den = PRECISION
                .checked_mul(scale)
                .expect("get_max_trade_size overflow: buy denominator");
            mul_div_floor(max_output, oracle_price_1e18, den)
        } else if quote_dec > base_dec {
            let value_1e18 = mul_div_floor(max_output, oracle_price_1e18, PRECISION);
            value_1e18
                .checked_mul(pow10_u128(quote_dec - base_dec))
                .expect("get_max_trade_size overflow: buy scale-up")
        } else {
            mul_div_floor(max_output, oracle_price_1e18, PRECISION)
        }
    } else {
        let value_1e18 = if oracle_price_1e18 > 0 {
            mul_div_floor(max_output, PRECISION, oracle_price_1e18)
        } else {
            0
        };
        if quote_dec > base_dec {
            value_1e18 / pow10_u128(quote_dec - base_dec)
        } else {
            value_1e18
                .checked_mul(pow10_u128(base_dec - quote_dec))
                .expect("get_max_trade_size overflow: sell scale-up")
        }
    }
}

fn evaluate_profit_for_size(
    pool: &PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    size: u128,
    direction: &str,
    base_symbol: &str,
    oracle_price_1e18: u128,
    gas_cost_usd: f64,
) -> f64 {
    if size == 0 {
        return f64::NEG_INFINITY;
    }
    let amount_out = match quote_exact_input(pool, quoter, token_in, size) {
        Ok(v) if v > 0 => v,
        _ => return f64::NEG_INFINITY,
    };
    calc_profit_usd(
        size,
        amount_out,
        direction,
        base_symbol,
        oracle_price_1e18,
        gas_cost_usd,
    )
}

#[derive(Debug, Clone, Copy)]
struct GoldenSearchOutcome {
    size: u128,
    profit: f64,
    #[cfg_attr(not(test), allow(dead_code))]
    refinements: usize,
}

/// Maximize an evaluator over an integer interval with golden-section
/// refinement. `max_search_iterations` is solely an operator-configured cap;
/// convergence is decided from the live interval (`~1%` of its lower bound,
/// with a 1000-raw-unit dust floor).  The cap is deliberately not derived
/// from `ln(max/min)`: that estimate undercounts the refinements the
/// interval tolerance needs and would stop the search while the interval
/// is still ~38% wide.
fn maximize_trade_size<F>(
    min_native: u128,
    max_native: u128,
    max_search_iterations: usize,
    eval_profit: &mut F,
) -> GoldenSearchOutcome
where
    F: FnMut(u128) -> f64,
{
    debug_assert!(max_native > min_native);
    let profit_at_min = eval_profit(min_native);
    let profit_at_max = eval_profit(max_native);

    // No hidden clamp: the validator bounds the configured cap, and any
    // cap >= ~185 is inert for a u128 bracket (the interval shrinks below
    // the tolerance first), so the canonical 1000 means "exit on
    // convergence only".
    let max_iterations = max_search_iterations;
    let mut low = min_native;
    let mut high = max_native;
    let mut range = high
        .checked_sub(low)
        .expect("maximize_trade_size invariant violated: high < low at init");
    let mut x1 = high
        .checked_sub(mul_div_floor(range, 618u128, 1000u128))
        .expect("maximize_trade_size underflow computing x1 at init");
    let mut x2 = low
        .checked_add(mul_div_floor(range, 618u128, 1000u128))
        .expect("maximize_trade_size overflow computing x2 at init");

    let mut f1 = eval_profit(x1);
    let mut f2 = eval_profit(x2);
    let mut refinements = 0usize;

    for _ in 0..max_iterations {
        range = high
            .checked_sub(low)
            .expect("maximize_trade_size invariant violated: high < low in loop");
        let tolerance = (low / 100u128).max(1_000u128);
        if range < tolerance {
            break;
        }

        if f1 < f2 {
            low = x1;
            x1 = x2;
            f1 = f2;
            x2 = low
                .checked_add(mul_div_floor(
                    high.checked_sub(low)
                        .expect("maximize_trade_size invariant violated before x2"),
                    618u128,
                    1000u128,
                ))
                .expect("maximize_trade_size overflow computing x2");
            f2 = eval_profit(x2);
        } else {
            high = x2;
            x2 = x1;
            f2 = f1;
            x1 = high
                .checked_sub(mul_div_floor(
                    high.checked_sub(low)
                        .expect("maximize_trade_size invariant violated before x1"),
                    618u128,
                    1000u128,
                ))
                .expect("maximize_trade_size underflow computing x1");
            f1 = eval_profit(x1);
        }
        refinements += 1;
    }

    let search_size = if f1 > f2 { x1 } else { x2 };
    let search_profit = f1.max(f2);
    let boundary_profit = profit_at_min.max(profit_at_max);
    let boundary_size = if profit_at_min > profit_at_max {
        min_native
    } else {
        max_native
    };
    if boundary_profit > search_profit {
        GoldenSearchOutcome {
            size: boundary_size,
            profit: boundary_profit,
            refinements,
        }
    } else {
        GoldenSearchOutcome {
            size: search_size,
            profit: search_profit,
            refinements,
        }
    }
}

fn find_optimal_trade_size(
    pool: &PoolState,
    quoter: &mut QuoterClient,
    token_in: &str,
    direction: &str,
    base_symbol: &str,
    oracle_price_1e18: u128,
    gas_cost_usd: f64,
    min_trade_usd: f64,
    max_search_iterations: usize,
) -> Option<(u128, f64)> {
    let min_usd_1e18 = usd18_from_f64(min_trade_usd);
    let min_native = usd_to_token_amount(min_usd_1e18, token_in, oracle_price_1e18);
    let max_native = get_max_trade_size(pool, direction, oracle_price_1e18);
    if min_native == 0 || max_native <= min_native {
        return None;
    }

    let mut eval_profit = |size: u128| -> f64 {
        evaluate_profit_for_size(
            pool,
            quoter,
            token_in,
            size,
            direction,
            base_symbol,
            oracle_price_1e18,
            gas_cost_usd,
        )
    };
    let outcome = maximize_trade_size(
        min_native,
        max_native,
        max_search_iterations,
        &mut eval_profit,
    );

    // Fixed gas commonly makes both interval boundaries unprofitable while
    // an interior trade remains profitable. The search result itself is the
    // acceptance criterion; gating on boundary signs silently discarded that
    // valid optimum and changed the whole benchmark trajectory.
    if !(outcome.profit.is_finite()) || outcome.profit <= 0.0 {
        return None;
    }
    Some((outcome.size, outcome.profit))
}

/// Prepaid donation schedule. Returns the seconds this tick should
/// fund, or `None` when nothing is due. The first tick of a run fires
/// immediately and prepays one full interval (prorated by the window);
/// every later tick funds the EXACT elapsed span since the previous
/// tranche. When `interval` is not a multiple of the candle grid,
/// events land on the first candle at or after `last + interval` —
/// funding the true gap (instead of a flat `interval`, which silently
/// underfunded the APR by the grid misalignment) keeps the cumulative
/// funded time equal to the elapsed window, so the run total is
/// `apr × window` up to one candle spacing. The cumulative funded time
/// is capped at the run window so a run never funds more than
/// `apr × window`, and the final tranche is prorated.
fn donation_due_dt(
    ts: u64,
    last_donation_ts: u64,
    interval: u64,
    accrued_sec: u64,
    window_sec: u64,
) -> Option<u64> {
    if window_sec == 0 {
        return None;
    }
    if accrued_sec == 0 {
        // First tranche, keyed off the funded-time cursor rather than
        // the timestamp comparison below: the "cursor one interval
        // before the window" initialisation saturates at 0 when the
        // window's start timestamp is below the interval (synthetic
        // windows), and the timestamp test would then silently push
        // the first tick past the window end.
        return Some(interval.min(window_sec));
    }
    if ts < last_donation_ts.saturating_add(interval) {
        return None;
    }
    let remaining = window_sec.saturating_sub(accrued_sec);
    if remaining == 0 {
        return None;
    }
    Some((ts - last_donation_ts).min(remaining))
}

/// Pool TVL in USD (1e18-scaled), quote leg + base leg at the oracle.
fn donation_tvl_usd18(
    base_symbol: &str,
    token0_symbol: &str,
    reserve0: u128,
    reserve1: u128,
    oracle_price_1e18: u128,
) -> u128 {
    let (usdt_reserve, base_reserve) = if token0_symbol == "USDT" {
        (reserve0, reserve1)
    } else {
        (reserve1, reserve0)
    };
    token_to_usd_amount_1e18(usdt_reserve, "USDT", 0).saturating_add(token_to_usd_amount_1e18(
        base_reserve,
        base_symbol,
        oracle_price_1e18,
    ))
}

/// `tvl · (apr_bps / 1e4) · dt / year`, 1e18-scaled USD.
fn donation_accrual_usd18(tvl_usd18: u128, apr_bps: u64, dt: u64) -> u128 {
    mul_div_floor(
        mul_div_floor(tvl_usd18, apr_bps as u128, BPS_DENOM),
        dt as u128,
        365u128 * 86_400u128,
    )
}

/// One Equilibra donation event, modelled exactly like the on-chain
/// flow a donor would use: a proportional `addLiquidity` (tokens enter
/// reserves at the fair active-share price) followed by parking every
/// minted share into the pool's own balance. No donor stake survives
/// the event, and multiplies the pool's donation uplift index by
/// `activeBefore / activeAfter` — the exact, order-independent factor
/// by which this park lifted every surviving active claim. Returns the
/// parked share count.
fn equilibra_buy_and_park_donation(
    pool: &mut PoolState,
    quoter: &mut QuoterClient,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
) -> Result<u128> {
    let (minted, _, _) = equilibra_add_liquidity(pool, quoter, amount0, amount1, timestamp)
        .with_context(|| format!("donation add_liquidity failed for {}", pool.context_name))?;
    if minted == 0 {
        return Ok(0);
    }
    // The add credited the passive ledger — pull the shares back out;
    // they belong to the donation event, not the passive LP.
    pool.lp1_liquidity = checked_sub_u128(
        pool.lp1_liquidity,
        minted,
        "donation shares out of the passive ledger",
    )?;
    // Park: shrinks the active float, lifting every surviving active
    // claim by exactly `active_pre / active_post`.
    let parked = pool.donation_shares;
    let active_pre = pool
        .total_supply
        .checked_sub(parked)
        .ok_or_else(|| anyhow!("donation park: parked > totalSupply"))?;
    if active_pre <= minted {
        return Err(anyhow!("donation park would empty the active float"));
    }
    let active_post = active_pre - minted;
    pool.donation_shares = checked_add_u128(parked, minted, "donation buffer + parked")?;
    if let Some(eq) = pool.eq.as_mut() {
        eq.donation_uplift_index = mul_div_floor(eq.donation_uplift_index, active_pre, active_post);
    }
    Ok(minted)
}

fn build_contexts(
    cfg: &RunConfig,
    no_curve: bool,
    only_amms: &HashSet<String>,
    only_bases: &HashSet<String>,
    disable_curve_rebalance: bool,
    oracle: &PriceOracle,
    sim_start: u64,
    quoter: &mut QuoterClient,
) -> Result<Vec<PoolState>> {
    let bases = ["WETH", "WBTC"];
    let mut contexts = Vec::new();

    let kinds = [AmmKind::Equilibra, AmmKind::UniswapV2, AmmKind::Curve];
    for kind in kinds {
        if !amm_enabled(cfg, kind, no_curve) {
            continue;
        }
        if !amm_selected(kind, only_amms) {
            continue;
        }

        for base in bases {
            if !base_selected(base, only_bases) {
                continue;
            }
            let base_oracle = oracle.get_price_at(oracle_symbol_for_base(base), sim_start)?;
            let (pass_base, pass_quote) =
                build_initial_deposit_amounts(base, base_oracle, cfg.liquidity.passiveLpInitialUsd);

            // Slot layout: Equilibra follows the configured base position
            // (mainnet address sort puts WETH / WBTC before USDT, so the
            // canonical default is base-in-slot-0); the Curve baseline and
            // the UniswapV2 reference always model the quote as token0,
            // matching the live Curve reference pools.
            let base_is_token0 =
                matches!(kind, AmmKind::Equilibra)
                    && cfg.amms.equilibra.presets.get(base).is_some_and(|p| {
                        p.baseTokenPosition == app_config::BaseTokenPosition::Token0
                    });
            let (amount0_pass, amount1_pass) = if base_is_token0 {
                (pass_base, pass_quote)
            } else {
                (pass_quote, pass_base)
            };

            let fee_bps = match kind {
                AmmKind::Equilibra => {
                    cfg.amms
                        .equilibra
                        .presets
                        .get(base)
                        .ok_or_else(|| anyhow!("missing equilibra preset for {}", base))?
                        .feeBps
                }
                AmmKind::UniswapV2 => cfg.amms.uniswapV2.feeBps,
                AmmKind::Curve => {
                    let p = cfg
                        .amms
                        .curve
                        .presets
                        .get(base)
                        .ok_or_else(|| anyhow!("missing curve preset for {}", base))?;
                    // midFee 1e10 scale, return in bps.
                    let mid = parse_u128_decimal(&p.midFee, "curve.midFee")?;
                    (mid / 1_000_000u128) as u64
                }
            };

            let (slot0_sym, slot1_sym) = if base_is_token0 {
                (base.to_string(), "USDT".to_string())
            } else {
                ("USDT".to_string(), base.to_string())
            };
            let mut pool = PoolState {
                context_name: context_key(kind.as_str(), base),
                amm: kind,
                base_symbol: base.to_string(),
                token0: slot0_sym.clone(),
                token1: slot1_sym.clone(),
                token0_decimals: token_decimals(&slot0_sym),
                token1_decimals: token_decimals(&slot1_sym),
                token0_symbol: slot0_sym,
                token1_symbol: slot1_sym,

                reserve0: 0,
                reserve1: 0,
                e0: 0,
                e1: 0,
                protocol_fee0: 0,
                protocol_fee1: 0,
                anchor0: 0,
                anchor1: 0,

                total_supply: 0,
                lp1_liquidity: 0,
                donation_shares: 0,

                eq: None,
                uni: None,
                curve: None,
                fee_bps,
                recentering_events: Vec::new(),
                last_recenter_ts: 0,
                ema_price: 0,
                last_timestamp: 0,
                budget_fee0: 0,
                budget_fee1: 0,
                anchor_price_wad: 0,
                lp_unit_value_genesis_wad: 0,
                lp_unit_value_wad: 0,
                lp_value_growth_wad: 0,
            };

            if kind == AmmKind::Equilibra {
                let p = cfg
                    .amms
                    .equilibra
                    .presets
                    .get(base)
                    .ok_or_else(|| anyhow!("missing equilibra preset for {}", base))?;
                pool.eq = Some(EquilibraParams {
                    a_wad: parse_u128_decimal(&p.aWad, "eq.aWad")?,
                    lambda_wad: parse_u128_decimal(&p.lambdaWad, "eq.lambdaWad")?,
                    protocol_fee_percent: p.protocolFeePercent,
                    ema_period: p.emaPeriod,
                    repeg_step_wad: parse_u128_decimal(&p.repegStepWad, "eq.repegStepWad")?,
                    repeg_threshold_token1_up_wad: parse_u128_decimal(
                        &p.repegThresholdToken1UpWad,
                        "eq.repegThresholdToken1UpWad",
                    )?,
                    repeg_threshold_token1_down_wad: parse_u128_decimal(
                        &p.repegThresholdToken1DownWad,
                        "eq.repegThresholdToken1DownWad",
                    )?,
                    rebalance_enabled: p.rebalanceEnabled,
                    fee_ramp_bps: p.feeRampBps,
                    fee_floor_bps: p.feeFloorBps,
                    repeg_share_bps: p.repegShareBps,
                    // Benchmark presets carry no K knob — every pool
                    // runs at the creation seed, exactly like on-chain
                    // pools whose timelock never touched it.
                    parachute_band_mult: equilibra::REPEG_PARACHUTE_BAND_MULT_DEFAULT,
                    donation_apr_bps: p.donationAprBps,
                    donation_interval_sec: p.donationIntervalSec,
                    // First stream tick fires at t = 0: the cursor
                    // starts one interval BEFORE the window so the
                    // first accrual (one interval's worth) is delivered
                    // on the very first tick.
                    last_donation_ts: sim_start.saturating_sub(p.donationIntervalSec),
                    donation_accrued_sec: 0,
                    donation_uplift_index: PRECISION,
                });
            }

            if kind == AmmKind::UniswapV2 {
                pool.uni = Some(UniswapParams {
                    block_timestamp_last: (sim_start % (1u64 << 32)) as u32,
                    price0_cumulative_last: "0".to_string(),
                    price1_cumulative_last: "0".to_string(),
                    k_last: "0".to_string(),
                    rebalance_enabled: cfg.amms.uniswapV2.rebalanceEnabled,
                });
            }

            if kind == AmmKind::Curve {
                let p = cfg
                    .amms
                    .curve
                    .presets
                    .get(base)
                    .ok_or_else(|| anyhow!("missing curve preset for {}", base))?;
                let price_scale = curve_price_scale_from_base_oracle(base_oracle);
                pool.curve = Some(CurveParams {
                    a: p.A as u128,
                    gamma: parse_u128_decimal(&p.gamma, "curve.gamma")?,
                    mid_fee: parse_u128_decimal(&p.midFee, "curve.midFee")?,
                    out_fee: parse_u128_decimal(&p.outFee, "curve.outFee")?,
                    fee_gamma: parse_u128_decimal(&p.feeGamma, "curve.feeGamma")?,
                    adjustment_step_min: parse_u128_decimal(
                        &p.adjustmentStepMin,
                        "curve.adjustmentStepMin",
                    )?,
                    adjustment_step_max: parse_u128_decimal(
                        &p.adjustmentStepMax,
                        "curve.adjustmentStepMax",
                    )?,
                    reserved_profit_fraction: parse_u128_decimal(
                        &p.reservedProfitFraction,
                        "curve.reservedProfitFraction",
                    )?,
                    ma_time: p.maTime,
                    math_mode: cfg.amms.curve.mathMode.clone(),
                    price_scale,
                    price_oracle: price_scale,
                    last_prices: price_scale,
                    last_timestamp: sim_start,
                    virtual_price: PRECISION,
                    xcp_profit: PRECISION,
                    lp_xcp_profit: PRECISION,
                    d: 0,
                    d_dirty: true,
                    rebalance_enabled: p.rebalanceEnabled,
                    donation: curve::CurveDonationState::default(),
                    donation_apr_bps: p.donationAprBps,
                    donation_interval_sec: p.donationIntervalSec,
                    // First stream tick at t = 0 — see the Equilibra
                    // constructor note.
                    last_donation_ts: sim_start.saturating_sub(p.donationIntervalSec),
                    donation_accrued_sec: 0,
                    donation_uplift_index: PRECISION,
                });
            }

            // Initial LP deposit (passive LP).
            let disable_curve_rebalance_for_pool =
                is_curve_rebalance_disabled(&pool, disable_curve_rebalance);
            let _ = add_liquidity(
                &mut pool,
                quoter,
                amount0_pass,
                amount1_pass,
                sim_start,
                disable_curve_rebalance_for_pool,
            )
            .with_context(|| {
                format!(
                    "initial passive add_liquidity failed for {}",
                    pool.context_name
                )
            })?;

            contexts.push(pool);
        }
    }

    Ok(contexts)
}

/// Build the metadata fee map from per-context `(amm, base, fee_bps)`
/// triples. Keys are fully qualified `amm:base` ONLY: fees are
/// per-(AMM, base) preset, so a bare AMM key cannot represent them — two
/// base shards of the same AMM would publish conflicting values under it
/// and the merge compatibility check would reject a valid run.
fn build_fee_config<'a>(
    entries: impl Iterator<Item = (&'a str, &'a str, u64)>,
) -> BTreeMap<String, f64> {
    let mut fee_config = BTreeMap::new();
    for (amm, base, fee_bps) in entries {
        fee_config.insert(format!("{amm}:{base}"), fee_bps as f64 / 10000.0);
    }
    fee_config
}

fn selected_context_names(contexts: &[PoolState]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut amms = contexts
        .iter()
        .map(|context| context.amm.as_str().to_string())
        .collect::<Vec<_>>();
    amms.sort_unstable();
    amms.dedup();
    let mut bases = contexts
        .iter()
        .map(|context| context.base_symbol.clone())
        .collect::<Vec<_>>();
    bases.sort_unstable();
    bases.dedup();
    let mut context_names = contexts
        .iter()
        .map(|context| context.context_name.clone())
        .collect::<Vec<_>>();
    context_names.sort_unstable();
    context_names.dedup();
    (amms, bases, context_names)
}

#[allow(clippy::too_many_arguments)]
fn resolve_execution_provenance(
    cli: &Cli,
    config_hash: &str,
    oracle_snapshot: &OracleSnapshot,
    simulator_binary: &equilibra_offchain_simulator::app::provenance::BinaryArtifactDigest,
    expected: Option<&ExecutionProvenance>,
    sim_start: u64,
    sim_end: u64,
    selected_amms: &[String],
    selected_bases: &[String],
    selected_contexts: &[String],
    report_assets_digest: &str,
) -> Result<ExecutionProvenance> {
    if let Some(expected) = expected {
        expected.verify()?;
        let origin = cli.origin_config_hash.as_deref().ok_or_else(|| {
            anyhow!("--execution-manifest requires the matching --origin-config-hash")
        })?;
        if origin != expected.material.config_hash {
            return Err(anyhow!(
                "origin config hash does not match execution manifest: origin={origin}, manifest={}",
                expected.material.config_hash
            ));
        }
        if &expected.material.oracle_snapshot != oracle_snapshot {
            return Err(anyhow!(
                "oracle directory digest {} does not match execution manifest digest {}",
                oracle_snapshot.oracle_digest,
                expected.material.oracle_snapshot.oracle_digest
            ));
        }
        if expected.material.actor_algorithm_version != ACTOR_ALGORITHM_VERSION
            || expected.material.result_format_version != RESULT_FORMAT_VERSION
            || expected.material.report_algorithm_version != REPORT_ALGORITHM_VERSION
            || expected.material.report_assets_digest != report_assets_digest
        {
            return Err(anyhow!(
                "execution manifest algorithm/schema versions do not match this binary"
            ));
        }
        let options = &expected.material.effective_options;
        if options.start_timestamp != sim_start
            || options.end_timestamp != sim_end
            || options.duration_sec != cli.duration_sec
            || options.no_curve != cli.no_curve
            || options.disable_equilibra_recenter != cli.disable_equilibra_recenter
            || options.disable_curve_rebalance != cli.disable_curve_rebalance
            || !options.arbitrage_enabled
        {
            return Err(anyhow!(
                "effective CLI/window options do not match execution manifest"
            ));
        }
        for amm in selected_amms {
            if !options.selected_amms.contains(amm) {
                return Err(anyhow!(
                    "selected AMM '{amm}' is outside execution manifest scope"
                ));
            }
        }
        for base in selected_bases {
            if !options.selected_bases.contains(base) {
                return Err(anyhow!(
                    "selected base '{base}' is outside execution manifest scope"
                ));
            }
        }
        for context in selected_contexts {
            match expected.material.partition_config_hashes.get(context) {
                Some(expected_hash) if expected_hash == config_hash => {}
                Some(expected_hash) => {
                    return Err(anyhow!(
                        "partition '{context}' config hash mismatch: expected {expected_hash}, got {config_hash}"
                    ))
                }
                None => {
                    return Err(anyhow!(
                        "partition '{context}' is absent from execution manifest"
                    ))
                }
            }
        }
        return Ok(expected.clone());
    }

    ExecutionProvenance::new(ExecutionProvenanceMaterial {
        version: EXECUTION_PROVENANCE_VERSION.to_string(),
        config_hash: config_hash.to_string(),
        oracle_snapshot: oracle_snapshot.clone(),
        effective_options: EffectiveExecutionOptions {
            mode: "standalone".to_string(),
            start_timestamp: sim_start,
            end_timestamp: sim_end,
            duration_sec: cli.duration_sec,
            no_curve: cli.no_curve,
            disable_equilibra_recenter: cli.disable_equilibra_recenter,
            disable_curve_rebalance: cli.disable_curve_rebalance,
            arbitrage_enabled: true,
            selected_amms: selected_amms.to_vec(),
            selected_bases: selected_bases.to_vec(),
        },
        partition_config_hashes: selected_contexts
            .iter()
            .map(|context| (context.clone(), config_hash.to_string()))
            .collect(),
        binaries: vec![simulator_binary.clone()],
        report_assets_digest: report_assets_digest.to_string(),
        actor_algorithm_version: ACTOR_ALGORITHM_VERSION.to_string(),
        result_format_version: RESULT_FORMAT_VERSION.to_string(),
        report_algorithm_version: REPORT_ALGORITHM_VERSION.to_string(),
    })
}

fn run_simulation(
    cli: &Cli,
    cfg: &RunConfig,
    config_hash: &str,
    oracle: &PriceOracle,
    oracle_snapshot: &OracleSnapshot,
    simulator_binary: &equilibra_offchain_simulator::app::provenance::BinaryArtifactDigest,
    expected_provenance: Option<&ExecutionProvenance>,
    report_assets_digest: &str,
    standalone_execution_manifest: Option<&Path>,
) -> Result<RunResultsOut> {
    let (oracle_start, oracle_end) = oracle
        .range_intersection()
        .ok_or_else(|| anyhow!("oracle range intersection unavailable"))?;

    let (sim_start, sim_end) = resolve_effective_window(
        cfg.simulation.startTimestamp,
        cfg.simulation.endTimestamp,
        oracle_start,
        oracle_end,
        cli.duration_sec,
    )?;

    let only_amms = parse_amm_filter(&cli.only_amms)?;
    let only_bases = parse_base_filter(&cli.only_bases)?;

    // Local Rust quoter/runtime kernel
    let mut quoter = QuoterClient::new()?;

    let mut contexts = build_contexts(
        cfg,
        cli.no_curve,
        &only_amms,
        &only_bases,
        cli.disable_curve_rebalance,
        oracle,
        sim_start,
        &mut quoter,
    )?;
    if contexts.is_empty() {
        return Err(anyhow!(
            "no AMM contexts selected (check --only-amms/--only-bases filters)"
        ));
    }
    let (selected_amms, selected_bases, selected_contexts) = selected_context_names(&contexts);
    let execution_provenance = resolve_execution_provenance(
        cli,
        config_hash,
        oracle_snapshot,
        simulator_binary,
        expected_provenance,
        sim_start,
        sim_end,
        &selected_amms,
        &selected_bases,
        &selected_contexts,
        report_assets_digest,
    )?;
    if let Some(path) = standalone_execution_manifest {
        persist_json_durable(path, &execution_provenance)?;
    }

    // Prime curve invariant D once at start.
    for ctx in &mut contexts {
        if ctx.amm == AmmKind::Curve {
            ensure_curve_d(ctx, &mut quoter)?;
        }
    }
    let mut execution_ts_cursor: Vec<u64> = vec![sim_start.saturating_sub(1); contexts.len()];

    // Actors state
    let mut rng = KeyedRng::new(cfg.simulation.seed);

    let mut passive_states = HashMap::<String, PassiveLpState>::new();
    let mut arb_states = HashMap::<String, ArbState>::new();
    let mut user_slippage_states = HashMap::<String, UserSlippageState>::new();
    let mut user_trade_event_count: u64 = 0;
    let mut gate_stats = RecenterGateStatsBundle::default();
    let mut post_arb_gate_stats = PostArbGateStatsByContext::default();
    // Per-context donation stream totals: (events, usd).
    let mut donation_totals: BTreeMap<String, (u64, f64)> = BTreeMap::new();
    let slippage_bucket_edges_bps = build_slippage_bucket_edges_bps(
        cfg.reporting.slippageSweep.minInitialSideBps,
        cfg.reporting.slippageSweep.maxInitialSideBps,
    )?;
    let slippage_bucket_count = slippage_bucket_edges_bps.len() - 1;

    for ctx in &contexts {
        let base = &ctx.base_symbol;
        let base_oracle = oracle.get_price_at(oracle_symbol_for_base(base), sim_start)?;

        // Passive initial amounts are first deposit values (before active add).
        let (p_base, p_quote) =
            build_initial_deposit_amounts(base, base_oracle, cfg.liquidity.passiveLpInitialUsd);
        let (p0, p1) = if ctx.token0_symbol == "USDT" {
            (p_quote, p_base)
        } else {
            (p_base, p_quote)
        };
        let p_init_val = cfg.liquidity.passiveLpInitialUsd;

        passive_states.insert(
            ctx.context_name.clone(),
            PassiveLpState {
                context_name: ctx.context_name.clone(),
                initial_amount0: p0,
                initial_amount1: p1,
                initial_value_usd: p_init_val,
                initial_ts: sim_start,
                final_amount0: 0,
                final_amount1: 0,
                final_value_usd: p_init_val,
                value_history: Vec::new(),
                composition_history: Vec::new(),
                impermanent_loss_actual: 0.0,
                impermanent_loss_cp: 0.0,
                net_pnl: 0.0,
                donations_usd: 0.0,
                donation_events: 0,
            },
        );

        arb_states.insert(
            ctx.context_name.clone(),
            ArbState {
                context_name: ctx.context_name.clone(),
                trades: Vec::new(),
                trade_count: 0,
                total_profit_usd: 0.0,
                total_gas_usd: 0.0,
                net_profit_usd: 0.0,
            },
        );

        user_slippage_states.insert(
            ctx.context_name.clone(),
            UserSlippageState {
                context_name: ctx.context_name.clone(),
                aggregate_count: 0,
                aggregate_sum: 0.0,
                aggregate_sum_squares: 0.0,
                aggregate_min: f64::INFINITY,
                aggregate_max: f64::NEG_INFINITY,
                histogram: vec![0u64; SLIPPAGE_HISTOGRAM_BUCKET_COUNT],
                samples: Vec::new(),
                bucket_edges_bps: slippage_bucket_edges_bps.clone(),
                trade_size_sum_bps: vec![0.0f64; slippage_bucket_count],
                trade_size_count: vec![0u64; slippage_bucket_count],
            },
        );
    }

    let mut last_passive_day_by_asset: HashMap<String, i64> = HashMap::new();
    last_passive_day_by_asset.insert("WETH".to_string(), -1);
    last_passive_day_by_asset.insert("WBTC".to_string(), -1);

    let eth_ts = oracle.timestamps_for_asset("ETH", sim_start, sim_end);
    let btc_ts = oracle.timestamps_for_asset("BTC", sim_start, sim_end);

    let mut ts_map: BTreeMap<u64, (bool, bool)> = BTreeMap::new();
    for t in eth_ts {
        ts_map
            .entry(t)
            .and_modify(|v| v.0 = true)
            .or_insert((true, false));
    }
    for t in btc_ts {
        ts_map
            .entry(t)
            .and_modify(|v| v.1 = true)
            .or_insert((false, true));
    }

    let all_ticks: Vec<(u64, bool, bool)> = ts_map
        .into_iter()
        .map(|(t, (eth, btc))| (t, eth, btc))
        .collect();
    let total_ticks = all_ticks.len() as u64;
    let progress_interval = cfg.simulation.progressIntervalSec.max(1);
    let t0 = Instant::now();
    let mut last_progress_emit_ts = 0u64;

    let probe_trigger_usd = (cfg.actors.arbitrageur.probeUsd * 100f64) / 10000f64; // 1%
    if !cfg.actors.user.minTradeUsd.is_finite() || !cfg.actors.user.maxTradeUsd.is_finite() {
        return Err(anyhow!(
            "actors.user min/max trade USD must be finite numbers"
        ));
    }
    let initial_side_liquidity_usd = cfg.liquidity.passiveLpInitialUsd / 2.0;
    if !initial_side_liquidity_usd.is_finite() || initial_side_liquidity_usd <= 0.0 {
        return Err(anyhow!(
            "invalid passiveLpInitialUsd for user slippage sizing: {}",
            cfg.liquidity.passiveLpInitialUsd
        ));
    }
    let initial_side_liquidity_usd_1e18 = usd18_from_f64(initial_side_liquidity_usd);
    if initial_side_liquidity_usd_1e18 == 0 {
        return Err(anyhow!(
            "initial side liquidity in 1e18 is zero for passiveLpInitialUsd={}",
            cfg.liquidity.passiveLpInitialUsd
        ));
    }
    let user_quote_min_usd_1e18 = mul_div_floor(
        initial_side_liquidity_usd_1e18,
        cfg.reporting.slippageSweep.minInitialSideBps as u128,
        BPS_DENOM,
    );
    let user_quote_max_usd_1e18 = mul_div_floor(
        initial_side_liquidity_usd_1e18,
        cfg.reporting.slippageSweep.maxInitialSideBps as u128,
        BPS_DENOM,
    );
    if user_quote_max_usd_1e18 < user_quote_min_usd_1e18 {
        return Err(anyhow!(
            "invalid user quote sizing bounds from initial liquidity: min={} max={}",
            user_quote_min_usd_1e18,
            user_quote_max_usd_1e18
        ));
    }
    // Report-only quote coverage is deliberately independent of the
    // stateful user actor.  Conflating it with `actors.user.maxTradeUsd`
    // would truncate the diagnostic chart while keeping the full axis.
    // The envelope lives under `reporting.slippageSweep`, and the
    // effective policy is stamped into every result artifact below.
    let user_quote_min_usd = user_quote_min_usd_1e18 as f64 / 1e18f64;
    let user_quote_max_usd = user_quote_max_usd_1e18 as f64 / 1e18f64;

    emit_benchmark_event(
        "phase",
        json!({
            "phase": "simulation:run",
            "totalTicks": total_ticks
        }),
    );

    let usdt_string = "USDT".to_string();
    let user_key_weth = "user:WETH".to_string();
    let user_key_wbtc = "user:WBTC".to_string();
    // Loop-invariant hoists. `std::env::var` takes a process-global lock on
    // every call and the gas-used estimates arrive as decimal strings from
    // config — resolving either inside the per-tick context loop repeats
    // millions of redundant lookups/parses over a multi-year window. The
    // gas pre-parse also moves the "missing/invalid gasUsedEstimates"
    // failure from the first tick to startup (fail-fast, same error text).
    let probe_usd_1e18 = usd18_from_f64(cfg.actors.arbitrageur.probeUsd);
    let gas_used_by_ctx: Vec<u128> = contexts
        .iter()
        .map(|c| {
            cfg.actors
                .arbitrageur
                .gasUsedEstimates
                .get(c.amm.as_str())
                .ok_or_else(|| anyhow!("missing gasUsedEstimates entry for {}", c.amm.as_str()))?
                .parse::<u128>()
                .with_context(|| format!("invalid gasUsedEstimates value for {}", c.amm.as_str()))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut active_indices: Vec<usize> = Vec::with_capacity(contexts.len());
    // Per-tick shared user quote amounts, one slot per entry of
    // `SIM_BASES` (index-aligned). A fixed array instead of a
    // HashMap<String, _>: the map re-allocated its key Strings on every
    // tick of a multi-year window for a two-entry table.
    let mut shared_user_quote_amount_by_base: [Option<(f64, u128)>; SIM_BASES.len()];
    for (tick_i, (ts, eth_tick, btc_tick)) in all_ticks.into_iter().enumerate() {
        active_indices.clear();
        for (i, ctx) in contexts.iter().enumerate() {
            let is_eth = ctx.base_symbol == "WETH";
            let is_btc = ctx.base_symbol == "WBTC";
            if (is_eth && eth_tick) || (is_btc && btc_tick) {
                active_indices.push(i);
            }
        }

        if active_indices.is_empty() {
            continue;
        }
        // Prepare shared user quote plan inputs for this tick.
        // Amount is deterministic random per base (seeded) and reused by all AMMs.
        // Quotes are executed before arbitrage checks, in both directions.
        shared_user_quote_amount_by_base = [None; SIM_BASES.len()];
        for (slot, base) in SIM_BASES.iter().enumerate() {
            let has_active = active_indices
                .iter()
                .any(|idx| contexts[*idx].base_symbol == *base);
            if !has_active {
                continue;
            }
            let key = if *base == "WETH" {
                &user_key_weth
            } else {
                &user_key_wbtc
            };
            let amount_usd = rng.uniform(key, user_quote_min_usd, user_quote_max_usd);
            let usd_amount_1e18 = usd18_from_f64(amount_usd);
            if usd_amount_1e18 == 0 {
                continue;
            }
            shared_user_quote_amount_by_base[slot] = Some((amount_usd, usd_amount_1e18));
        }

        let donation_window_sec = sim_end.saturating_sub(sim_start);

        // 0) Donation streams. One schedule helper, two strictly typed
        //    loops — mixing AMM state in a shared loop silently disabled
        //    both streams once, so the dispatch stays explicit per AMM
        //    and never touches another pool kind's fields.
        //
        //    Accrual is PREPAID: the first tranche lands at t = 0 (one
        //    interval's worth) and every later tick funds the exact gap
        //    since the previous tranche (equal to the interval on an
        //    aligned candle grid), with the total accrued time capped
        //    at the run window so a run never funds more than
        //    `apr × window`.
        for &idx in &active_indices {
            let (apr_bps, interval, last_donation_ts, accrued_sec) =
                match contexts[idx].curve.as_ref() {
                    Some(c) if c.donation_apr_bps > 0 && c.donation_interval_sec > 0 => (
                        c.donation_apr_bps,
                        c.donation_interval_sec,
                        c.last_donation_ts,
                        c.donation_accrued_sec,
                    ),
                    _ => continue,
                };
            let dt = match donation_due_dt(
                ts,
                last_donation_ts,
                interval,
                accrued_sec,
                donation_window_sec,
            ) {
                Some(dt) => dt,
                None => continue,
            };
            let (context_name, base_symbol, token0_symbol, reserve0, reserve1) = {
                let c = &contexts[idx];
                (
                    c.context_name.clone(),
                    c.base_symbol.clone(),
                    c.token0_symbol.clone(),
                    c.reserve0,
                    c.reserve1,
                )
            };
            let base_oracle = oracle.get_price_at(oracle_symbol_for_base(&base_symbol), ts)?;
            let oracle_price_1e18 = (base_oracle * 1e18f64).floor() as u128;
            let tvl_usd18 = donation_tvl_usd18(
                &base_symbol,
                &token0_symbol,
                reserve0,
                reserve1,
                oracle_price_1e18,
            );
            let amount_usd18 = donation_accrual_usd18(tvl_usd18, apr_bps, dt);
            // The cursor advances even when the accrued amount rounds to
            // zero, so dust never accumulates into a same-timestamp burst.
            if let Some(c) = contexts[idx].curve.as_mut() {
                c.last_donation_ts = ts;
                c.donation_accrued_sec = c.donation_accrued_sec.saturating_add(dt);
            }
            if amount_usd18 == 0 {
                continue;
            }
            let donate_usdt = usd_to_token_amount(amount_usd18, "USDT", 0);
            if donate_usdt == 0 {
                continue;
            }
            let (amount0, amount1) = if token0_symbol == "USDT" {
                (donate_usdt, 0u128)
            } else {
                (0u128, donate_usdt)
            };
            let disable_curve =
                is_curve_rebalance_disabled(&contexts[idx], cli.disable_curve_rebalance);
            let donate_ts = next_execution_timestamp(&mut execution_ts_cursor[idx], ts);
            match execute_curve_donation(
                &mut contexts[idx],
                &mut quoter,
                amount0,
                amount1,
                donate_ts,
                disable_curve,
            ) {
                Ok(_) => {
                    let entry = donation_totals.entry(context_name).or_insert((0u64, 0f64));
                    entry.0 += 1;
                    entry.1 += amount_usd18 as f64 / 1e18f64;
                }
                Err(err) => {
                    eprintln!(
                        "[simulator][warning] curve donation failed for {} at ts {}: {}",
                        context_name, donate_ts, err
                    );
                }
            }
        }

        // 0b) Equilibra donation stream: buy+park events — the accrued
        //     USD enters reserves as a proportional deposit and every
        //     minted share is parked into the donation buffer in the
        //     same event, so no donor ever holds an active, fee-earning
        //     stake between events.
        for &idx in &active_indices {
            let (apr_bps, interval, last_donation_ts, accrued_sec) = match contexts[idx].eq.as_ref()
            {
                Some(e) if e.donation_apr_bps > 0 && e.donation_interval_sec > 0 => (
                    e.donation_apr_bps,
                    e.donation_interval_sec,
                    e.last_donation_ts,
                    e.donation_accrued_sec,
                ),
                _ => continue,
            };
            let dt = match donation_due_dt(
                ts,
                last_donation_ts,
                interval,
                accrued_sec,
                donation_window_sec,
            ) {
                Some(dt) => dt,
                None => continue,
            };
            let (context_name, base_symbol, token0_symbol, reserve0, reserve1) = {
                let c = &contexts[idx];
                (
                    c.context_name.clone(),
                    c.base_symbol.clone(),
                    c.token0_symbol.clone(),
                    c.reserve0,
                    c.reserve1,
                )
            };
            let base_oracle = oracle.get_price_at(oracle_symbol_for_base(&base_symbol), ts)?;
            let oracle_price_1e18 = (base_oracle * 1e18f64).floor() as u128;
            let tvl_usd18 = donation_tvl_usd18(
                &base_symbol,
                &token0_symbol,
                reserve0,
                reserve1,
                oracle_price_1e18,
            );
            let amount_usd18 = donation_accrual_usd18(tvl_usd18, apr_bps, dt);
            if let Some(e) = contexts[idx].eq.as_mut() {
                e.last_donation_ts = ts;
                e.donation_accrued_sec = e.donation_accrued_sec.saturating_add(dt);
            }
            if amount_usd18 == 0 || tvl_usd18 == 0 {
                continue;
            }
            let a0 = mul_div_floor(reserve0, amount_usd18, tvl_usd18);
            let a1 = mul_div_floor(reserve1, amount_usd18, tvl_usd18);
            if a0 == 0 || a1 == 0 {
                continue;
            }
            let donate_ts = next_execution_timestamp(&mut execution_ts_cursor[idx], ts);
            match equilibra_buy_and_park_donation(
                &mut contexts[idx],
                &mut quoter,
                a0,
                a1,
                donate_ts,
            ) {
                Ok(_) => {
                    let entry = donation_totals.entry(context_name).or_insert((0u64, 0f64));
                    entry.0 += 1;
                    entry.1 += amount_usd18 as f64 / 1e18f64;
                }
                Err(err) => {
                    eprintln!(
                        "[simulator][warning] equilibra donation failed for {} at ts {}: {}",
                        context_name, donate_ts, err
                    );
                }
            }
        }

        // 1) Arbitrageur
        for &idx in &active_indices {
            // Static `c.fee_bps` is intentionally NOT propagated here:
            // the arb-execution path now reads the dynamic effective rate
            // back from `StatefulSwapExecOut.actual_fee_bps`. Surfacing
            // the static base fee in this scope would invite a regression
            // back to `arbVolume × baseFee` reporting.
            let (context_name, base_symbol) = {
                let c = &contexts[idx];
                (c.context_name.clone(), c.base_symbol.clone())
            };
            let base_oracle = oracle.get_price_at(oracle_symbol_for_base(&base_symbol), ts)?;
            let eth_oracle = oracle.get_price_at("ETH", ts)?;
            let oracle_price_1e18 = (base_oracle * 1e18f64).floor() as u128;

            let gas_used = gas_used_by_ctx[idx];
            let gas_cost_usd =
                gas_used as f64 * cfg.actors.arbitrageur.gasPriceGwei / 1e9f64 * eth_oracle;

            // Per-(tick, context) dust-probe cache. Outer `None` = not yet
            // evaluated; inner `None` = probe amounts rounded to zero (the
            // historical early-exit). Filled lazily on first use so ticks
            // where neither the user plans nor the arbitrageur need probes
            // stay quote-free, exactly as before.
            let mut probe_pair: Option<Option<ProbeQuotePair>> = None;

            if let Some((_amount_usd, usd_amount_1e18)) = SIM_BASES
                .iter()
                .position(|b| *b == base_symbol)
                .and_then(|slot| shared_user_quote_amount_by_base[slot])
            {
                for direction in ["buy", "sell"] {
                    let plan_opt = build_user_quote_plan_for_context(
                        &contexts[idx],
                        &base_symbol,
                        oracle_price_1e18,
                        base_oracle,
                        usd_amount_1e18,
                        initial_side_liquidity_usd_1e18,
                        direction,
                    )?;
                    if let Some(plan) = plan_opt {
                        if probe_pair.is_none() {
                            probe_pair = Some(compute_probe_quote_pair(
                                &mut contexts[idx],
                                &mut quoter,
                                &base_symbol,
                                oracle_price_1e18,
                                probe_usd_1e18,
                            )?);
                        }
                        let spot_price_1e18_pre = probe_pair
                            .as_ref()
                            .and_then(|p| p.as_ref())
                            .map(|p| mid_spot_from_probe_pair(p, &base_symbol))
                            .unwrap_or(0);
                        execute_user_quote_plan_for_context(
                            &mut contexts[idx],
                            &mut quoter,
                            &mut user_slippage_states,
                            ts,
                            &plan,
                            oracle_price_1e18,
                            spot_price_1e18_pre,
                        )?;
                        user_trade_event_count = user_trade_event_count.saturating_add(1);
                    }
                }
            }

            let quote_token: &str = usdt_string.as_str();
            let base_token: &str = base_symbol.as_str();
            let mut arb_trade_executed_on_tick = false;
            'arb_search_and_execute: {
                // Reuse the tick's cached dust probes (or fill them now if
                // no user plan ran) — the pool state has not changed since
                // the fill, so the quotes are bit-identical to re-probing.
                if probe_pair.is_none() {
                    probe_pair = Some(compute_probe_quote_pair(
                        &mut contexts[idx],
                        &mut quoter,
                        &base_symbol,
                        oracle_price_1e18,
                        probe_usd_1e18,
                    )?);
                }
                let pair = match probe_pair.as_ref().and_then(|p| p.as_ref()) {
                    Some(p) => p,
                    // Probe amounts rounded to zero — the historical
                    // `probe_quote == 0 || probe_base == 0` early exit.
                    None => break 'arb_search_and_execute,
                };
                let probe_quote = pair.probe_quote;
                let probe_base = pair.probe_base;
                let buy_out = pair.buy_out;
                let sell_out = pair.sell_out;

                // The invariant must be clean before the stateful swap below;
                // a no-op re-check after the probe fill above.
                ensure_curve_d(&mut contexts[idx], &mut quoter)
                    .with_context(|| format!("ensure curve D for {}", context_name))?;

                if buy_out == 0 || sell_out == 0 {
                    break 'arb_search_and_execute;
                }

                let buy_price = price_from_amounts_1e18(probe_quote, "USDT", buy_out, &base_symbol);
                let sell_price =
                    price_from_amounts_1e18(sell_out, "USDT", probe_base, &base_symbol);
                if buy_price == 0 || sell_price == 0 {
                    break 'arb_search_and_execute;
                }

                let probe_buy_gross = calc_profit_usd(
                    probe_quote,
                    buy_out,
                    "buy",
                    &base_symbol,
                    oracle_price_1e18,
                    0.0,
                );
                let probe_sell_gross = calc_profit_usd(
                    probe_base,
                    sell_out,
                    "sell",
                    &base_symbol,
                    oracle_price_1e18,
                    0.0,
                );
                let probe_best = probe_buy_gross.max(probe_sell_gross);
                if probe_best <= probe_trigger_usd {
                    break 'arb_search_and_execute;
                }

                let direction = if probe_buy_gross >= probe_sell_gross {
                    "buy"
                } else {
                    "sell"
                };

                let token_in: &str = if direction == "buy" {
                    quote_token
                } else {
                    base_token
                };
                // `token_in_symbol` removed: per-trade USD fee is now
                // derived from `StatefulSwapExecOut.fee_token_symbol`,
                // which already encodes the correct side (input for
                // Equilibra/Uniswap, output for Curve).

                let optimal = find_optimal_trade_size(
                    &contexts[idx],
                    &mut quoter,
                    &token_in,
                    direction,
                    &base_symbol,
                    oracle_price_1e18,
                    gas_cost_usd,
                    cfg.actors.arbitrageur.minTradeUsd,
                    cfg.actors.arbitrageur.maxSearchIterations,
                );
                let (best_size, best_profit) = match optimal {
                    Some(v) => v,
                    None => break 'arb_search_and_execute,
                };
                if !(best_profit.is_finite()) || best_profit <= 0.0 {
                    break 'arb_search_and_execute;
                }

                let trade_value =
                    estimate_trade_value_usd(best_size, direction, &base_symbol, base_oracle);
                let min_profit_by_bps =
                    trade_value * cfg.actors.arbitrageur.minProfitBps / 10000f64;
                let min_profit = cfg.actors.arbitrageur.minProfitUsd.max(min_profit_by_bps);
                if best_profit < min_profit {
                    break 'arb_search_and_execute;
                }

                // Execute arbitrage swap against state.
                let arb_exec_ts = next_execution_timestamp(&mut execution_ts_cursor[idx], ts);
                let exec_result = execute_stateful_swap_for_context(
                    &mut contexts[idx],
                    &mut quoter,
                    &token_in,
                    best_size,
                    arb_exec_ts,
                    cli,
                    &mut gate_stats,
                );
                let exec = exec_result?;
                let out = exec.amount_out;
                if out == 0 {
                    break 'arb_search_and_execute;
                }
                arb_trade_executed_on_tick = true;

                let gross = calc_profit_usd(
                    best_size,
                    out,
                    direction,
                    &base_symbol,
                    oracle_price_1e18,
                    0.0,
                );
                // Use the dynamic fee that was *actually* applied by the
                // pool — `ctx_fee_bps` only equals the static base fee
                // (`pool.fee_bps`) and would mask both the Equilibra
                // smoothstep and the Curve `mid_fee → out_fee` ramp,
                // making `totalFeesUsd` look like `arbVolume × baseFee`
                // regardless of the actual dynamic-fee config.
                let actual_fee_bps = exec.actual_fee_bps;
                let oracle_price_for_fee_token = if exec.fee_token_symbol == base_symbol {
                    oracle_price_1e18
                } else {
                    // For the quote token (USDT) the helper ignores the
                    // oracle price (USDT is treated as $1). Pass any
                    // value — `0` is fine — to keep the call total.
                    0
                };
                let fee_paid_usd = token_to_usd_amount_1e18(
                    exec.fee_amount_raw,
                    &exec.fee_token_symbol,
                    oracle_price_for_fee_token,
                ) as f64
                    / 1e18;

                let oracle_i = to_i128_saturated(oracle_price_1e18);
                let buy_i = to_i128_saturated(buy_price);
                let sell_i = to_i128_saturated(sell_price);
                let dev_buy_bps = if oracle_i > 0 {
                    ((oracle_i - buy_i) * 10000 / oracle_i) as i64
                } else {
                    0
                };
                let dev_sell_bps = if oracle_i > 0 {
                    ((sell_i - oracle_i) * 10000 / oracle_i) as i64
                } else {
                    0
                };
                let price_deviation = if direction == "buy" {
                    -dev_buy_bps
                } else {
                    dev_sell_bps
                };

                let probe_mid = (buy_price / 2)
                    .checked_add(sell_price / 2)
                    .ok_or_else(|| anyhow!("overflow computing probe_mid for {}", context_name))?;

                {
                    let st = arb_states
                        .get_mut(&context_name)
                        .ok_or_else(|| anyhow!("missing arb state for {}", context_name))?;
                    st.trade_count += 1;
                    st.total_profit_usd += gross;
                    st.total_gas_usd += gas_cost_usd;
                    st.net_profit_usd += gross - gas_cost_usd;
                    st.trades.push(ArbTrade {
                        timestamp: arb_exec_ts,
                        context_name: context_name.clone(),
                        direction: direction.to_string(),
                        amount_in: best_size,
                        amount_out: out,
                        gross_profit_usd: gross,
                        gas_cost_usd,
                        net_profit_usd: gross - gas_cost_usd,
                        actual_fee_bps,
                        fee_paid_usd,
                        price_deviation,
                        probe_price: probe_mid,
                    });
                }
                run_post_arb_external_round_trips(
                    &mut contexts[idx],
                    &mut quoter,
                    cli,
                    ts,
                    &mut execution_ts_cursor[idx],
                    &token_in,
                    best_size,
                    oracle_price_1e18,
                    cfg.actors.arbitrageur.postArbExternalSwaps,
                    &mut gate_stats,
                    &mut post_arb_gate_stats,
                );
            }

            if !arb_trade_executed_on_tick {
                run_min_post_arb_external_round_trip_without_arb(
                    &mut contexts[idx],
                    &mut quoter,
                    cli,
                    ts,
                    &mut execution_ts_cursor[idx],
                    oracle_price_1e18,
                    cfg.actors.arbitrageur.postArbExternalSwaps,
                    &mut gate_stats,
                    &mut post_arb_gate_stats,
                );
            }
        }

        // 2) Passive LP daily snapshots per base
        for base in SIM_BASES {
            // Cheap once-per-day guard FIRST: on a 1-minute candle stream
            // ~1439/1440 ticks fail it, so the per-base active scan below
            // used to run (and allocate) only to be discarded. `last_day`
            // still advances only when the base actually has an active
            // context on the snapshot tick — same semantics as before,
            // just checked in the cheap-to-expensive order.
            let day = (ts / 86400) as i64;
            let last_day = *last_passive_day_by_asset
                .get(base)
                .ok_or_else(|| anyhow!("missing passive-day state for {}", base))?;
            if day <= last_day {
                continue;
            }
            let group_active: Vec<usize> = active_indices
                .iter()
                .copied()
                .filter(|idx| contexts[*idx].base_symbol == base)
                .collect();
            if group_active.is_empty() {
                continue;
            }
            last_passive_day_by_asset.insert(base.to_string(), day);

            let base_oracle = oracle.get_price_at(oracle_symbol_for_base(base), ts)?;
            for idx in group_active {
                let (share0, share1) = lp_share_amounts(&contexts[idx]);
                // NET of donations: the series must agree with the
                // finalize-time subtraction or the value / delta-vs-hold
                // curves drift above the headline numbers while a
                // donation stream is live.
                let v = value_usd(&contexts[idx], share0, share1, base_oracle)
                    * (1.0 - donation_value_fraction(&contexts[idx]));
                let st = passive_states
                    .get_mut(&contexts[idx].context_name)
                    .ok_or_else(|| {
                        anyhow!("missing passive state for {}", contexts[idx].context_name)
                    })?;
                st.value_history.push((ts, v));
                st.composition_history.push((ts, share0, share1));
            }
        }

        let should_emit_progress = (ts >= last_progress_emit_ts.saturating_add(progress_interval))
            || (tick_i + 1 == total_ticks as usize);
        if should_emit_progress {
            last_progress_emit_ts = ts;

            let done_ticks = (tick_i + 1) as u64;
            let percent = if total_ticks > 0 {
                (done_ticks as f64) * 100.0 / (total_ticks as f64)
            } else {
                100.0
            };
            let elapsed = t0.elapsed().as_secs_f64();
            let eta_sec = if done_ticks > 0 && total_ticks > done_ticks {
                let per_tick = elapsed / (done_ticks as f64);
                ((total_ticks - done_ticks) as f64) * per_tick
            } else {
                0.0
            };

            let mut base_oracles = HashMap::new();
            for c in &contexts {
                if base_oracles.contains_key(&c.base_symbol) {
                    continue;
                }
                if let Ok(base_oracle) =
                    oracle.get_price_at(oracle_symbol_for_base(&c.base_symbol), ts)
                {
                    base_oracles.insert(c.base_symbol.clone(), base_oracle);
                }
            }

            let mut base_prices_usd = serde_json::Map::new();
            for (base_symbol, base_oracle) in &base_oracles {
                base_prices_usd.insert(base_symbol.clone(), json!(*base_oracle));
            }

            let mut lp_values = serde_json::Map::new();
            let mut lp_delta_vs_hold_percent = serde_json::Map::new();
            for c in &contexts {
                if let Some(base_oracle) = base_oracles.get(&c.base_symbol) {
                    let oracle_price = *base_oracle;
                    let (share0, share1) = lp_share_amounts(c);
                    // NET of donations — see the daily snapshot note.
                    let v = value_usd(c, share0, share1, oracle_price)
                        * (1.0 - donation_value_fraction(c));
                    lp_values.insert(c.context_name.clone(), json!(v));

                    if let Some(st) = passive_states.get(&c.context_name) {
                        let hold_v =
                            value_usd(c, st.initial_amount0, st.initial_amount1, oracle_price);
                        if hold_v.is_finite() && hold_v > 0.0 && v.is_finite() {
                            let delta_vs_hold_percent = (v - hold_v) / hold_v * 100.0;
                            lp_delta_vs_hold_percent
                                .insert(c.context_name.clone(), json!(delta_vs_hold_percent));
                        }
                    }
                }
            }

            emit_benchmark_event(
                "progress",
                json!({
                    "phase": "simulation",
                    "percent": percent,
                    "currentTick": done_ticks,
                    "totalTicks": total_ticks,
                    "currentTimestamp": ts,
                    "day": (ts.saturating_sub(sim_start)) / 86400,
                    "etaSec": eta_sec,
                    "lpValuesUsd": lp_values,
                    "lpDeltaVsHoldPercent": lp_delta_vs_hold_percent,
                    "oracleBasePricesUsd": base_prices_usd
                }),
            );
        }
    }

    // Finalize LP states
    for ctx in &mut contexts {
        let base = ctx.base_symbol.clone();
        let oracle_end = oracle.get_price_at(oracle_symbol_for_base(&base), sim_end)?;
        let oracle_start = oracle.get_price_at(oracle_symbol_for_base(&base), sim_start)?;

        // Passive LP final
        {
            let lp = ctx.lp1_liquidity;
            // Donation attribution via the multiplicative uplift index,
            // snapshotted BEFORE the exit (the exit itself burns the
            // Equilibra buffer proportionally and shrinks the float).
            // Donated value reaches the passive LP through exactly ONE
            // channel per AMM — Equilibra: buffer parks shrink the
            // active float; Curve: rebalance commits burn buffer shares
            // out of the supply — and each such event folds its exact
            // `activeBefore / activeAfter` (resp. `supplyBefore /
            // supplyAfter`) lift into the index. A claim's value
            // WITHOUT any donation is `gross / index`, so the
            // donation-attributable slice of the final position is
            // `1 − 1/index` — priced by the very same end-of-run
            // valuation as `final_v` itself, so no price-mixing error
            // can arise.
            let donation_fraction = donation_value_fraction(ctx);
            let (out0, out1) = if lp > 0 {
                remove_liquidity(ctx, &mut quoter, lp, sim_end)?
            } else {
                (0, 0)
            };
            let final_v = value_usd(ctx, out0, out1, oracle_end);
            let hold_v = value_usd(
                ctx,
                passive_states[&ctx.context_name].initial_amount0,
                passive_states[&ctx.context_name].initial_amount1,
                oracle_end,
            );
            let price_ratio = if oracle_start > 0.0 {
                oracle_end / oracle_start
            } else {
                1.0
            };
            let cp_il = if price_ratio > 0.0 {
                let s = price_ratio.sqrt();
                (2.0 * s) / (1.0 + price_ratio) - 1.0
            } else {
                0.0
            };

            let (donation_events, _stream_usd_logged) = donation_totals
                .get(&ctx.context_name)
                .copied()
                .unwrap_or((0, 0.0));
            // The subtracted amount is the uplift-index attribution
            // computed above — NOT the per-event USD stream log, which
            // mixes prices of different moments. `1 − 1/index` is the
            // exact fraction of the final position the donation events
            // produced.
            let donations_usd = final_v * donation_fraction;
            let st = passive_states
                .get_mut(&ctx.context_name)
                .ok_or_else(|| anyhow!("missing passive finalize state {}", ctx.context_name))?;
            st.final_amount0 = out0;
            st.final_amount1 = out1;
            st.final_value_usd = final_v;
            st.donations_usd = donations_usd;
            st.donation_events = donation_events;
            // Deliberately GROSS of donations, unlike `net_pnl`, the
            // report's delta-vs-hold and the value series (all NET of
            // `donations_usd`): IL measures the price-move loss of the
            // redeemed position against hold, not the exogenous
            // subsidy.
            st.impermanent_loss_actual = if hold_v > 0.0 {
                (final_v - hold_v) / hold_v
            } else {
                0.0
            };
            st.impermanent_loss_cp = cp_il;
            // Exogenous donations are a subsidy, not pool performance:
            // Net PnL is reported NET of the donated USD (the report's
            // delta-vs-hold applies the same subtraction).
            st.net_pnl = if st.initial_value_usd > 0.0 {
                (final_v - donations_usd - st.initial_value_usd) / st.initial_value_usd
            } else {
                0.0
            };
            // Final series point is NET of donations, matching every
            // prior snapshot and the headline numbers.
            st.value_history.push((sim_end, final_v - donations_usd));
            st.composition_history.push((sim_end, out0, out1));
        }
    }

    // Build outputs
    let mut contexts_out: Vec<ContextOut> = contexts
        .iter()
        .map(|c| ContextOut {
            contextName: c.context_name.clone(),
            ammName: c.amm.as_str().to_string(),
            poolKey: c.base_symbol.clone(),
            token0Symbol: c.token0_symbol.clone(),
            token1Symbol: c.token1_symbol.clone(),
        })
        .collect();
    contexts_out.sort_by(|a, b| a.contextName.cmp(&b.contextName));

    let fee_config = build_fee_config(
        contexts
            .iter()
            .map(|c| (c.amm.as_str(), c.base_symbol.as_str(), c.fee_bps)),
    );

    // Per-base LABELING map in canonical quote-first order — deliberately
    // NOT a slot map (AMMs on the same base may use different slot
    // layouts; the per-context slot truth lives in `poolTokensByAmm`).
    // The report frontend classifies quote/base itself via
    // `quoteSymbols`, so only the symbol pair matters here.
    let mut pool_tokens = BTreeMap::<String, PoolTokenConfigOut>::new();
    for base in &selected_bases {
        pool_tokens.insert(
            base.to_string(),
            PoolTokenConfigOut {
                token0Symbol: "USDT".to_string(),
                token1Symbol: base.to_string(),
                token0Decimals: token_decimals("USDT"),
                token1Decimals: token_decimals(base),
            },
        );
    }
    let mut pool_tokens_by_amm = BTreeMap::<String, PoolTokenConfigOut>::new();
    for context in &contexts {
        pool_tokens_by_amm.insert(
            context.context_name.clone(),
            PoolTokenConfigOut {
                token0Symbol: context.token0_symbol.clone(),
                token1Symbol: context.token1_symbol.clone(),
                token0Decimals: token_decimals(&context.token0_symbol),
                token1Decimals: token_decimals(&context.token1_symbol),
            },
        );
    }

    let metadata = MetadataOut {
        configHash: config_hash.to_string(),
        originConfigHash: cli
            .origin_config_hash
            .clone()
            .unwrap_or_else(|| config_hash.to_string()),
        executionFingerprint: execution_provenance.execution_fingerprint.clone(),
        oracleDigest: execution_provenance
            .material
            .oracle_snapshot
            .oracle_digest
            .clone(),
        reportAssetsDigest: execution_provenance.material.report_assets_digest.clone(),
        actorAlgorithmVersion: ACTOR_ALGORITHM_VERSION,
        slippageSweep: SlippageSweepPolicy {
            policy_version: SLIPPAGE_SWEEP_POLICY_VERSION.to_string(),
            min_initial_side_bps: cfg.reporting.slippageSweep.minInitialSideBps,
            max_initial_side_bps: cfg.reporting.slippageSweep.maxInitialSideBps,
            bucket_edges_bps: slippage_bucket_edges_bps.clone(),
        },
        seed: cfg.simulation.seed,
        startTimestamp: sim_start,
        endTimestamp: sim_end,
        durationDays: sim_end
            .checked_sub(sim_start)
            .expect("metadata durationDays underflow: sim_end < sim_start")
            / 86400,
        initialLiquidityUsd: cfg.liquidity.passiveLpInitialUsd,
        gasPriceGwei: cfg.actors.arbitrageur.gasPriceGwei,
        ammList: selected_amms,
        poolList: selected_bases.clone(),
        generatedAt: now_iso_utc(),
        feeConfig: fee_config,
        poolTokens: pool_tokens,
        poolTokensByAmm: pool_tokens_by_amm,
    };

    let mut user_slippage_out: Vec<UserSlippageStateOut> = user_slippage_states
        .into_values()
        .map(|s| {
            let (min_v, max_v) = if s.aggregate_count > 0 {
                (s.aggregate_min, s.aggregate_max)
            } else {
                (0.0, 0.0)
            };
            UserSlippageStateOut {
                contextName: s.context_name,
                aggregate: StreamingAggregateOut {
                    count: s.aggregate_count,
                    sum: s.aggregate_sum,
                    sumSquares: s.aggregate_sum_squares,
                    min: min_v,
                    max: max_v,
                },
                histogram: s.histogram,
                samples: s.samples,
                tradeSizeBuckets: TradeSizeBuckets {
                    bucket_edges_bps: s.bucket_edges_bps,
                    sum_slippage_bps: s.trade_size_sum_bps,
                    count: s.trade_size_count,
                },
            }
        })
        .collect();
    user_slippage_out.sort_by(|a, b| a.contextName.cmp(&b.contextName));

    let user_out = UserStateOut {
        tradeCount: user_trade_event_count,
        tradeHistory: Vec::new(),
        slippageByContext: user_slippage_out,
    };

    let passive_out: Vec<PassiveLPOut> = passive_states
        .into_values()
        .map(|s| PassiveLPOut {
            contextName: s.context_name,
            initialDeposit: InitialDepositOut {
                amount0: bigint_pref(s.initial_amount0),
                amount1: bigint_pref(s.initial_amount1),
                valueUsd: s.initial_value_usd,
                timestamp: s.initial_ts,
            },
            finalPosition: FinalPositionOut {
                amount0: bigint_pref(s.final_amount0),
                amount1: bigint_pref(s.final_amount1),
                valueUsd: s.final_value_usd,
            },
            valueHistory: s
                .value_history
                .into_iter()
                .map(|(ts, v)| ValueSnapOut {
                    timestamp: ts,
                    valueUsd: v,
                })
                .collect(),
            compositionHistory: s
                .composition_history
                .into_iter()
                .map(|(ts, a0, a1)| CompositionSnapOut {
                    timestamp: ts,
                    amount0: bigint_pref(a0),
                    amount1: bigint_pref(a1),
                })
                .collect(),
            impermanentLossActual: s.impermanent_loss_actual,
            impermanentLossCP: s.impermanent_loss_cp,
            netPnl: s.net_pnl,
            donationsUsd: s.donations_usd,
            donationEvents: s.donation_events,
        })
        .collect();
    // Deterministic output order. These vectors previously materialised in
    // HashMap iteration order, which is randomized per process — two runs
    // of the same binary on the same params produced differently-ordered
    // (byte-unequal) sim_results.json. Sorting makes result comparisons
    // stable; `config_hash` itself identifies parameters only and is not a
    // proof that the binary, oracle contents, or runtime flags matched.
    // Sorted by contextName like `user_slippage_out` above.
    let mut passive_out = passive_out;
    passive_out.sort_by(|a, b| a.contextName.cmp(&b.contextName));

    let arb_out: Vec<ArbStateOut> = arb_states
        .into_values()
        .map(|s| ArbStateOut {
            contextName: s.context_name,
            trades: s
                .trades
                .into_iter()
                .map(|t| ArbTradeOut {
                    timestamp: t.timestamp,
                    contextName: t.context_name,
                    direction: t.direction,
                    amountIn: bigint_pref(t.amount_in),
                    amountOut: bigint_pref(t.amount_out),
                    grossProfitUsd: t.gross_profit_usd,
                    gasCostUsd: t.gas_cost_usd,
                    netProfitUsd: t.net_profit_usd,
                    actualFeeBps: t.actual_fee_bps,
                    feePaidUsd: t.fee_paid_usd,
                    priceDeviation: t.price_deviation,
                    probePrice: bigint_pref(t.probe_price),
                })
                .collect(),
            tradeCount: s.trade_count,
            totalProfitUsd: s.total_profit_usd,
            totalGasCostUsd: s.total_gas_usd,
            netProfitUsd: s.net_profit_usd,
        })
        .collect();
    // Same deterministic-order rationale as `passive_out` above.
    let mut arb_out = arb_out;
    arb_out.sort_by(|a, b| a.contextName.cmp(&b.contextName));

    let mut recenter_events = Vec::new();
    for c in &contexts {
        recenter_events.extend(c.recentering_events.clone());
    }
    recenter_events.sort_by(|left, right| {
        (left.timestamp, &left.ammName, &left.poolKey).cmp(&(
            right.timestamp,
            &right.ammName,
            &right.poolKey,
        ))
    });

    let equilibra_recenter_gate_stats_export =
        build_recenter_gate_stats_export(&gate_stats.equilibra);
    let curve_rebalance_gate_stats_export = build_recenter_gate_stats_export(&gate_stats.curve);

    emit_post_arb_gate_summary(&post_arb_gate_stats);

    for (context_name, (events, usd)) in &donation_totals {
        eprintln!(
            "[simulator] donations for {}: {} events, {:.2} USD total",
            context_name, events, usd
        );
    }

    Ok(RunResultsOut {
        resultFormatVersion: RESULT_FORMAT_VERSION,
        metadata,
        contexts: contexts_out,
        userState: user_out,
        passiveLPStates: passive_out,
        arbStates: arb_out,
        recenteringEvents: recenter_events,
        equilibraRecenterGateStats: equilibra_recenter_gate_stats_export,
        curveRebalanceGateStats: curve_rebalance_gate_stats_export,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replay the donation cursor over a candle grid and return the
    /// total funded seconds.
    fn replay_donation_schedule(interval: u64, grid: u64, window: u64) -> u64 {
        let start = 1_000u64;
        let mut last = start.saturating_sub(interval);
        let mut accrued = 0u64;
        let mut ts = start;
        while ts < start + window {
            if let Some(dt) = donation_due_dt(ts, last, interval, accrued, window) {
                last = ts;
                accrued += dt;
            }
            ts += grid;
        }
        accrued
    }

    #[test]
    fn donation_schedule_funds_full_window_on_aligned_interval() {
        // interval = 30 grid steps: every event funds exactly one
        // interval and the cap prorates the final tranche.
        let window = 10 * 86_400;
        assert_eq!(replay_donation_schedule(1_800, 60, window), window);
    }

    #[test]
    fn donation_schedule_funds_full_window_off_grid() {
        // interval = 90s on a 60s grid: events land every 120s. The
        // flat-`interval` schedule funded only 90/120 = 75% of the
        // window; the elapsed-gap tranche keeps the total within one
        // candle spacing of the window.
        let window = 10 * 86_400;
        let funded = replay_donation_schedule(90, 60, window);
        assert!(
            funded >= window - 60 && funded <= window,
            "off-grid schedule funded {funded} of {window} seconds"
        );
    }

    #[test]
    fn donation_schedule_first_tick_prepays_one_interval() {
        let window = 86_400u64;
        let start = 1_000u64;
        let dt = donation_due_dt(start, start - 90, 90, 0, window);
        assert_eq!(dt, Some(90));
    }

    #[test]
    fn donation_schedule_first_tick_fires_on_sub_interval_start() {
        // Synthetic window whose start timestamp is below the interval:
        // the cursor init `start.saturating_sub(interval)` saturates at
        // 0, so a timestamp-based first-tick test would defer the first
        // tranche past the window end. The funded-time-cursor arm must
        // fire it on the first tick regardless, prorated by the window.
        let dt = donation_due_dt(1_000, 0, 2_592_000, 0, 420);
        assert_eq!(dt, Some(420));
    }

    #[test]
    fn value_skew_is_layout_invariant_and_zero_when_balanced() {
        // Balanced WETH pool at spot 2000 USDT/WETH: 500k USDT vs 250
        // WETH hold equal value, so the skew must be 0 in BOTH slot
        // layouts and identical between them.
        let spot = 2_000 * PRECISION; // USDT per WETH, WAD
        let usdt_raw = 500_000u128 * 1_000_000; // 6 decimals
        let weth_raw = 250u128 * 10u128.pow(18); // 18 decimals

        let quote_first = compute_value_skew_bps(usdt_raw, weth_raw, "USDT", "WETH", spot);
        let base_first = compute_value_skew_bps(weth_raw, usdt_raw, "WETH", "USDT", spot);
        assert_eq!(quote_first, 0);
        assert_eq!(base_first, 0);
    }

    #[test]
    fn value_skew_matches_across_mirrored_layouts_when_imbalanced() {
        // 75% of value on the base side: v_base = 3 · v_quote ⇒
        // p = 0.75 ⇒ |2p − 1| = 5000 bps — same number from either
        // layout of the same economic state.
        let spot = 2_000 * PRECISION;
        let usdt_raw = 250_000u128 * 1_000_000; // $250k quote
        let weth_raw = 375u128 * 10u128.pow(18); // $750k base

        let quote_first = compute_value_skew_bps(usdt_raw, weth_raw, "USDT", "WETH", spot);
        let base_first = compute_value_skew_bps(weth_raw, usdt_raw, "WETH", "USDT", spot);
        assert_eq!(quote_first, 5_000);
        assert_eq!(base_first, 5_000);
    }

    #[test]
    fn value_skew_degenerate_inputs_return_zero() {
        let spot = 2_000 * PRECISION;
        assert_eq!(compute_value_skew_bps(0, 0, "USDT", "WETH", spot), 0);
        assert_eq!(compute_value_skew_bps(1, 1, "USDT", "WETH", 0), 0);
    }

    #[test]
    fn fee_config_keys_are_qualified_only() {
        let fee_config = build_fee_config(
            [("equilibra", "WETH", 282u64), ("equilibra", "WBTC", 170u64)].into_iter(),
        );
        assert_eq!(fee_config.len(), 2);
        assert_eq!(fee_config["equilibra:WETH"], 0.0282);
        assert_eq!(fee_config["equilibra:WBTC"], 0.017);
        // No bare AMM key: two base shards of one AMM would publish
        // conflicting values under it and the merge would reject the run.
        assert!(!fee_config.contains_key("equilibra"));
    }

    fn make_curve_pool(
        base_symbol: &str,
        reserve0: u128,
        reserve1: u128,
        price_scale: u128,
    ) -> PoolState {
        PoolState {
            context_name: format!("curve:{base_symbol}:test"),
            amm: AmmKind::Curve,
            base_symbol: base_symbol.to_string(),
            token0: "USDT".to_string(),
            token1: base_symbol.to_string(),
            token0_symbol: "USDT".to_string(),
            token1_symbol: base_symbol.to_string(),
            token0_decimals: token_decimals("USDT"),
            token1_decimals: token_decimals(base_symbol),
            reserve0,
            reserve1,
            e0: reserve0,
            e1: reserve1,
            protocol_fee0: 0,
            protocol_fee1: 0,
            anchor0: reserve0,
            anchor1: reserve1,
            total_supply: 1_000_000u128,
            lp1_liquidity: 500_000u128,
            donation_shares: 0,
            eq: None,
            uni: None,
            curve: Some(CurveParams {
                a: 1,
                gamma: 1,
                mid_fee: 1,
                out_fee: 1,
                fee_gamma: 1,
                adjustment_step_min: 0,
                adjustment_step_max: 0,
                reserved_profit_fraction: 0,
                ma_time: 600,
                math_mode: "stableswap".to_string(),
                price_scale,
                price_oracle: price_scale,
                last_prices: price_scale,
                last_timestamp: 0,
                virtual_price: 0,
                xcp_profit: 0,
                lp_xcp_profit: 0,
                d: 1,
                d_dirty: false,
                rebalance_enabled: true,
                donation: curve::CurveDonationState::default(),
                donation_apr_bps: 0,
                donation_interval_sec: 0,
                last_donation_ts: 0,
                donation_accrued_sec: 0,
                donation_uplift_index: PRECISION,
            }),
            fee_bps: 60,
            recentering_events: Vec::new(),
            last_recenter_ts: 0,
            ema_price: 0,
            last_timestamp: 0,
            budget_fee0: 0,
            budget_fee1: 0,
            anchor_price_wad: 0,
            lp_unit_value_genesis_wad: 0,
            lp_unit_value_wad: 0,
            lp_value_growth_wad: 0,
        }
    }

    #[test]
    fn keyed_rng_matches_ts_reference_sequence() {
        let mut rng = KeyedRng::new(42);
        let expected = [
            0.11278190184384584f64,
            0.939753680722788f64,
            0.9072710874024779f64,
            0.9263178710825741f64,
            0.725070474203676f64,
            0.5369617962278426f64,
            0.15142767247743905f64,
            0.4292469024658203f64,
        ];
        for v in expected {
            let got = rng.next_f64("user:WETH");
            assert!(
                (got - v).abs() < 1e-15,
                "rng mismatch: expected {v}, got {got}"
            );
        }
    }

    fn concave_reference_profit(size: u128, target: u128) -> f64 {
        let distance = size.abs_diff(target) as f64 / 1_000.0;
        1_000_000.0 - distance * distance
    }

    #[test]
    fn golden_search_uses_configured_cap_and_live_tolerance() {
        // max/min == 2 made the regressed ln(max/min)/ln(phi) formula stop
        // after two refinements.  That leaves ~38% of the original interval,
        // nowhere near the live 1% tolerance.
        let mut calls = 0usize;
        let target = 1_700_000u128;
        let mut evaluator = |size| {
            calls += 1;
            concave_reference_profit(size, target)
        };
        let outcome = maximize_trade_size(1_000_000, 2_000_000, 20, &mut evaluator);

        assert!(
            outcome.refinements > 2,
            "search regressed to ratio-derived early stop"
        );
        assert!(
            outcome.refinements < 20,
            "live tolerance should stop before the configured cap"
        );
        assert_eq!(calls, 4 + outcome.refinements);
        assert!(
            outcome.size.abs_diff(target) <= target / 100,
            "size {} is not within 1% of reference optimum {}",
            outcome.size,
            target
        );
    }

    #[test]
    fn golden_search_caps_are_monotonic_and_exact() {
        let target = 73_000_000u128;
        let mut prior_profit = f64::NEG_INFINITY;
        for cap in [1usize, 5, 20, 50, 1000] {
            let mut calls = 0usize;
            let mut evaluator = |size| {
                calls += 1;
                concave_reference_profit(size, target)
            };
            let outcome = maximize_trade_size(10_000_000, 100_000_000, cap, &mut evaluator);
            assert!(outcome.refinements <= cap);
            assert_eq!(calls, 4 + outcome.refinements);
            assert!(
                outcome.profit >= prior_profit,
                "raising cap from prior value to {cap} reduced best profit"
            );
            prior_profit = outcome.profit;
        }
    }

    #[test]
    fn golden_search_keeps_profitable_interior_when_both_boundaries_lose() {
        let mut evaluator = |size: u128| {
            let distance = size.abs_diff(50_000) as f64;
            1_000.0 - distance * distance / 100.0
        };
        assert!(evaluator(1_000) < 0.0);
        assert!(evaluator(100_000) < 0.0);
        let outcome = maximize_trade_size(1_000, 100_000, 50, &mut evaluator);
        assert!(outcome.profit.is_finite() && outcome.profit > 0.0);
        assert!(outcome.size.abs_diff(50_000) < 1_000);
    }

    #[test]
    fn max_trade_size_weth_buy_uses_wide_math_without_overflow_clamp() {
        let pool = make_curve_pool(
            "WETH",
            505_000_000_000u128,
            155_000_000_000_000_000_000u128,
            3_200_000_000_000_000_000_000u128,
        );
        let oracle_price_1e18 = 3_200_000_000_000_000_000_000u128;
        let actual = get_max_trade_size(&pool, "buy", oracle_price_1e18);

        let max_output = mul_div_floor(pool.reserve1, 90u128, 100u128);
        let expected = {
            let num = U256::from(max_output) * U256::from(oracle_price_1e18);
            let den = U256::from(PRECISION) * U256::from(pow10_u128(12u32));
            (num / den).low_u128()
        };

        assert_eq!(
            actual, expected,
            "weth buy max size must match wide reference"
        );
        assert!(
            actual > 1_000_000_000u128,
            "unexpectedly tiny cap for WETH buy path"
        );
        assert_ne!(
            actual, 340_282_366u128,
            "legacy overflow-clamped value detected"
        );
    }

    #[test]
    fn usd_to_token_amount_uses_wide_math_for_large_weth_amounts() {
        // Chosen so that usd * 10^18 overflows u128, while final quotient fits into u128.
        let usd_amount_1e18 = "300000000000000000000000000000000000"
            .parse::<u128>()
            .expect("parse usd amount");
        let oracle_price_1e18 = 3_200_000_000_000_000_000_000u128; // $3200
        let actual = usd_to_token_amount(usd_amount_1e18, "WETH", oracle_price_1e18);

        let expected = {
            let num = U256::from(usd_amount_1e18) * U256::from(pow10_u128(18u32));
            let den = U256::from(oracle_price_1e18);
            (num / den).low_u128()
        };

        assert_eq!(
            actual, expected,
            "usd->token conversion must match wide reference"
        );
        assert!(actual > 0, "usd->token conversion unexpectedly zero");
    }

    #[test]
    fn token_to_usd_amount_uses_wide_math_for_large_wbtc_amounts() {
        // Chosen so that token * oracle overflows u128, while final quotient fits into u128.
        let token_amount = "120000000000000000000000"
            .parse::<u128>()
            .expect("parse token amount");
        let oracle_price_1e18 = 30_000_000_000_000_000_000_000u128; // $30k
        let actual = token_to_usd_amount_1e18(token_amount, "WBTC", oracle_price_1e18);

        let expected = {
            let num = U256::from(token_amount) * U256::from(oracle_price_1e18);
            let den = U256::from(pow10_u128(8u32));
            (num / den).low_u128()
        };

        assert_eq!(
            actual, expected,
            "token->usd conversion must match wide reference"
        );
        assert!(actual > 0, "token->usd conversion unexpectedly zero");
    }

    #[test]
    fn curve_rebalance_event_is_recorded_with_price_scales() {
        let mut pool = make_curve_pool(
            "WETH",
            30_000_000_000u128,
            10_000_000_000_000_000_000u128,
            1_000u128,
        );
        maybe_record_curve_rebalance_event(&mut pool, 123u64, 1_000u128, 1_250u128);
        assert_eq!(pool.recentering_events.len(), 1usize);
        let evt = &pool.recentering_events[0];
        assert_eq!(evt.ammName, "curve");
        assert_eq!(evt.poolKey, "WETH");
        assert_eq!(evt.ilEstimate, "0");
        assert_eq!(evt.oldPriceScale.as_deref(), Some("1000"));
        assert_eq!(evt.newPriceScale.as_deref(), Some("1250"));

        maybe_record_curve_rebalance_event(&mut pool, 124u64, 1_250u128, 1_250u128);
        assert_eq!(pool.recentering_events.len(), 1usize);
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.trace_input.is_some() {
        return run_trace_mode(&cli);
    }

    emit_benchmark_event("phase", json!({ "phase": "config:load" }));

    let raw_cfg = fs::read_to_string(&cli.config)
        .with_context(|| format!("read run config: {}", cli.config.display()))?;
    let cfg_value: Value = serde_json::from_str(&raw_cfg)
        .with_context(|| format!("parse run config JSON: {}", cli.config.display()))?;
    let validated_cfg = app_config::validate_run_config(&cfg_value)
        .with_context(|| format!("validate run config: {}", cli.config.display()))?;
    let config_hash = app_config::compute_config_hash(&validated_cfg)
        .with_context(|| format!("hash effective run config: {}", cli.config.display()))?;
    // V2 has a single deterministic kernel — there is no aSeg policy to
    // surface anymore. The phase event still fires so external tooling
    // can key its phase machine off `config:loaded`.
    emit_benchmark_event(
        "phase",
        json!({
            "phase": "config:loaded",
            "kernel": "v2-blend",
        }),
    );
    println!("[simulator] kernel = v2-blend");
    let cfg = runtime_run_config_from_app(validated_cfg)
        .with_context(|| format!("normalize run config: {}", cli.config.display()))?;

    let expected_provenance = cli
        .execution_manifest
        .as_deref()
        .map(load_execution_provenance)
        .transpose()?;
    if expected_provenance.is_none() && cli.origin_config_hash.is_some() {
        return Err(anyhow!(
            "--origin-config-hash requires --execution-manifest; a bare parent hash is not sufficient provenance"
        ));
    }

    // Both modes read the SHARED feed directory: the oracle is digested,
    // not copied — `PriceOracle::load` fingerprints the exact bytes it
    // parses, the digest lands in the execution manifest / result
    // metadata, and every later consumer (merge, report) re-digests the
    // same directory and fails closed on drift. Standalone runs still get
    // a durable execution sidecar for their provenance.
    let mut standalone_execution_path = None;
    if expected_provenance.is_none() {
        standalone_execution_path =
            Some(execution_manifest_path(parent_dir_or_current(&cli.output)));
    }
    let effective_oracle_dir = cli.data_dir.clone();

    emit_benchmark_event("phase", json!({ "phase": "oracle:load" }));
    let (oracle, oracle_snapshot) = PriceOracle::load(&effective_oracle_dir)?;
    let simulator_path = std::env::current_exe().with_context(|| "resolve current executable")?;
    let simulator_binary = binary_digest("simulator", &simulator_path)?;
    let report_assets_digest =
        hash_report_assets_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("report-web"))?;
    if let Some(expected) = &expected_provenance {
        verify_binary_artifact(expected, "simulator", &simulator_path)?;
    }

    emit_benchmark_event("phase", json!({ "phase": "simulation:create" }));
    let results = run_simulation(
        &cli,
        &cfg,
        &config_hash,
        &oracle,
        &oracle_snapshot,
        &simulator_binary,
        expected_provenance.as_ref(),
        &report_assets_digest,
        standalone_execution_path.as_deref(),
    )?;

    // Stream to a sibling temporary file, fsync it and atomically publish it.
    // This retains the low-memory behaviour of `to_writer_pretty` while a
    // crash or a killed shard can no longer leave a partial file at the final
    // `sim_results.json` path.
    persist_json_durable(&cli.output, &results)
        .with_context(|| format!("persist output {}", cli.output.display()))?;

    emit_benchmark_event(
        "phase",
        json!({
            "phase": "results:saved",
            "resultsPath": cli.output.display().to_string()
        }),
    );

    println!(
        "[simulator] done: output={} contexts={} trades(user)={}",
        cli.output.display(),
        results.contexts.len(),
        results.userState.tradeCount
    );

    Ok(())
}
