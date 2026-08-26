use crate::app::provenance::{
    binary_digest, create_directory_all_durable, derive_report_fingerprint, hash_report_assets_dir,
    oracle_snapshot_from_bytes, parent_dir_or_current, ExecutionProvenance, OracleSnapshot,
    REPORT_ALGORITHM_VERSION,
};
use crate::common::{
    build_slippage_bucket_edges_bps, canonical_result_digest, parse_u128_string, token_decimals,
    validate_run_results_contract, ArbTrade, OracleData, OraclePoint, PoolTokenConfig,
    RecenterGateCounts, RecenterGateStatsExport, RecenteringEvent, RunContext, RunResults,
    SlippageSample, SlippageSweepPolicy, StreamingAggregate, UserSlippageByContext,
};
use crate::runtime_quoter::{CurveRebalanceGateBlocked, EquilibraRecenterGateBlocked};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_POINTS_PER_SERIES: usize = 500usize;
const MAX_MARKER_POINTS_PER_SERIES: usize = 5000usize;
const EMA_PERIODS: [u32; 5] = [0, 10, 30, 60, 120];

/// Canonical set of quote-token symbols understood by the USD conversion
/// helpers in this module. Exported into `metrics.json` metadata
/// (`quoteSymbols`) so the dashboard derives quote/base classification from
/// report data instead of duplicating this list in JavaScript. Restricted to
/// symbols `common::token_decimals` actually knows, so quote detection and
/// decimals resolution can never diverge.
const QUOTE_SYMBOLS: [&str; 1] = ["USDT"];

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ChartPoint {
    pub x: i64,
    pub y: f64,
}

#[derive(Debug, Clone)]
struct OracleStore {
    eth: Vec<OraclePoint>,
    btc: Vec<OraclePoint>,
}

impl OracleStore {
    fn load(dir: &Path) -> Result<(Self, OracleSnapshot)> {
        let eth_path = dir.join("eth-usd.json");
        let btc_path = dir.join("btc-usd.json");
        let raw_files = BTreeMap::from([
            (
                "btc-usd.json".to_string(),
                fs::read(&btc_path).with_context(|| format!("read {}", btc_path.display()))?,
            ),
            (
                "eth-usd.json".to_string(),
                fs::read(&eth_path).with_context(|| format!("read {}", eth_path.display()))?,
            ),
        ]);
        let snapshot = oracle_snapshot_from_bytes(&raw_files)?;
        let mut eth: OracleData = serde_json::from_slice(&raw_files["eth-usd.json"])
            .with_context(|| format!("parse {}", eth_path.display()))?;
        let mut btc: OracleData = serde_json::from_slice(&raw_files["btc-usd.json"])
            .with_context(|| format!("parse {}", btc_path.display()))?;
        eth.points.sort_by_key(|p| p.t);
        btc.points.sort_by_key(|p| p.t);
        Ok((
            Self {
                eth: dedupe_oracle_points(eth.points),
                btc: dedupe_oracle_points(btc.points),
            },
            snapshot,
        ))
    }

    fn get_points(&self, symbol: &str) -> Result<&[OraclePoint]> {
        match symbol {
            "ETH" => Ok(&self.eth),
            "BTC" => Ok(&self.btc),
            other => Err(anyhow!("unsupported oracle symbol '{other}'")),
        }
    }

    fn get_price_at(&self, symbol: &str, ts: u64) -> Result<f64> {
        let points = self.get_points(symbol)?;
        if points.is_empty() {
            return Err(anyhow!("empty oracle for {symbol}"));
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

    fn timestamps(&self, symbol: &str, start: u64, end: u64) -> Result<Vec<u64>> {
        let points = self.get_points(symbol)?;
        Ok(points
            .iter()
            .filter(|p| p.t >= start && p.t <= end)
            .map(|p| p.t)
            .collect())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRunMetadata {
    pub result_format_version: String,
    pub report_algorithm_version: String,
    pub config_hash: String,
    pub origin_config_hash: String,
    pub execution_fingerprint: String,
    pub oracle_digest: String,
    pub report_assets_digest: String,
    pub result_digest: String,
    pub report_generator_sha256: String,
    pub report_fingerprint: String,
    pub actor_algorithm_version: String,
    pub slippage_sweep: SlippageSweepPolicy,
    pub seed: u64,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub duration_days: u64,
    pub initial_liquidity_usd: f64,
    pub gas_price_gwei: f64,
    pub amm_list: Vec<String>,
    pub pool_list: Vec<String>,
    pub generated_at: String,
    pub fee_config: BTreeMap<String, f64>,
    pub pool_tokens: BTreeMap<String, PoolTokenConfig>,
    pub pool_tokens_by_amm: BTreeMap<String, PoolTokenConfig>,
    /// Canonical quote-token symbol set (see `QUOTE_SYMBOLS`). The dashboard
    /// classifies each pool's quote/base side from this list.
    pub quote_symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LpPositions {
    pub lp1_initial_token0: f64,
    pub lp1_initial_token1: f64,
    pub lp1_initial_usd: f64,
    pub lp1_final_token0: f64,
    pub lp1_final_token1: f64,
    pub lp1_final_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmmSummary {
    pub amm_name: String,
    pub pool_key: String,
    pub token0_symbol: String,
    pub token1_symbol: String,
    pub lp1_il_percent: f64,
    pub lp1_delta_vs_hold_percent: f64,
    pub lp1_net_pnl_percent: f64,
    /// Exogenous subsidy donated into the pool over the run (USD) and
    /// as a percent of the initial passive deposit. Already subtracted
    /// from `lp1_net_pnl_percent` and `lp1_delta_vs_hold_percent`.
    pub donations_usd: f64,
    pub donations_percent_of_initial: f64,
    /// Donation-attributable share of the passive LP's FINAL position,
    /// percent (`donationsUsd / finalValue`). This is the exact
    /// share-based attribution fraction the netPnl subtraction used.
    pub donations_percent_of_final: f64,
    pub donation_events: u64,
    pub arb_trade_count: u64,
    pub arb_total_profit_usd: f64,
    pub arb_gas_cost_usd: f64,
    pub total_volume_usd: f64,
    pub arb_volume_usd: f64,
    pub total_fees_usd: f64,
    pub avg_slippage_bps: f64,
    pub min_slippage_bps: f64,
    pub max_slippage_bps: f64,
    pub recentering_count: u64,
    /// USD estimate of the impermanent-loss cost attributed to recentering
    /// events (Equilibra only; zero for AMMs that do not report an IL
    /// estimate per event). This is the only recentering cost metric —
    /// there is no separate "fees used" accumulator.
    pub recentering_estimated_il_usd: f64,
    pub lp_positions: LpPositions,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsExport {
    pub metadata: ReportRunMetadata,
    pub summaries: Vec<AmmSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactSeriesExport {
    pub format: String,
    pub metadata: CompactSeriesMeta,
    pub charts: CompactCharts,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactSeriesMeta {
    pub result_format_version: String,
    pub actor_algorithm_version: String,
    pub execution_fingerprint: String,
    pub oracle_digest: String,
    pub slippage_sweep: SlippageSweepPolicy,
    pub pool_key: String,
    /// Upper bound on points per line series after LTTB decimation. Every
    /// series in this file is decimated down to at most this many points;
    /// there is no fixed-interval time bucketing anywhere in the export.
    pub max_points_per_series: usize,
    /// EMA smoothing windows emitted under `charts.deviation.ema` (key "0"
    /// is the raw, unsmoothed series). The dashboard builds its smoothing
    /// selector from this list — it is the single source of truth for
    /// which EMA sets exist in this run's report.
    pub ema_periods: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactCharts {
    pub deviation: CompactDeviationChart,
    pub lp_value: CompactLpValueChart,
    pub live_lp_delta_vs_hold: CompactLiveLpDeltaVsHoldChart,
    pub lp_composition: CompactLpCompositionChart,
    pub slippage: CompactSlippageChart,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactDeviationChart {
    pub ema: BTreeMap<String, CompactDeviationEmaSet>,
    pub recentering_markers: CompactRecenteringMarkers,
    pub recentering_stats: BTreeMap<String, CompactRecenteringStats>,
    /// Boost LP-oracle error in bps over time (see
    /// `CompactRecenteringStats::avg_lp_oracle_err_bps` for the
    /// formula), one LTTB-decimated series per anchor-bearing AMM
    /// (equilibra, curve). The global maximum point is force-included
    /// so the deepest mispricing episode survives decimation. Rendered
    /// as the strip under Price History.
    pub lp_oracle_err: BTreeMap<String, Vec<ChartPoint>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactDeviationEmaSet {
    pub oracle: Vec<ChartPoint>,
    pub pools: BTreeMap<String, Vec<ChartPoint>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRecenteringMarkers {
    pub equilibra: Vec<ChartPoint>,
    pub curve: Vec<ChartPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRecenteringStats {
    pub count: u64,
    pub estimated_il_usd: f64,
    /// Mean |last trade price − oracle| / oracle (bps) over all oracle
    /// candles, LOCF between trades: measures fee-corridor width plus
    /// trade sparsity, NOT the anchor.
    pub avg_abs_deviation_bps: f64,
    /// Mean Boost LP-oracle error in bps: `sqrt(max(anchor, oracle) /
    /// min(anchor, oracle)) − 1`. The anchor-pinned LP oracle prices
    /// collateral as `vp·sqrt(priceScale)`, so this is the relative
    /// collateral mispricing a leveraged wrapper would carry; the
    /// geometric ratio makes crash and rally lags read symmetrically
    /// (matching the pool's own repeg deviation metric). `None` for
    /// AMMs without an anchor (uniswapV2).
    pub avg_lp_oracle_err_bps: Option<f64>,
    /// Worst-case LP-oracle error (bps) over the run — the deepest
    /// collateral mispricing episode.
    pub max_lp_oracle_err_bps: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactLpValueChart {
    pub passive_usd_by_amm: BTreeMap<String, Vec<ChartPoint>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactLiveLpDeltaVsHoldChart {
    pub percent_by_amm: BTreeMap<String, Vec<ChartPoint>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactLpCompositionChart {
    pub quote_by_amm: BTreeMap<String, Vec<ChartPoint>>,
    pub base_by_amm: BTreeMap<String, Vec<ChartPoint>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactSlippageChart {
    pub bucket_edges_bps: Vec<u64>,
    pub by_amm: BTreeMap<String, CompactSlippageByAmm>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactSlippageByAmm {
    pub avg_slippage_percent: Vec<Option<f64>>,
    pub amm_min: Option<f64>,
    pub amm_max: Option<f64>,
}

#[derive(Debug, Clone)]
struct ContextAccumulator {
    context: RunContext,
    initial_amount0: u128,
    initial_amount1: u128,
    initial_value_usd: f64,
    final_amount0: u128,
    final_amount1: u128,
    final_value_usd: f64,
    net_pnl_percent_fraction: f64,
    delta_vs_hold_fraction: f64,
    donations_usd: f64,
    donation_events: u64,
    il_loss_only_fraction: f64,
    value_history: Vec<(u64, f64)>,
    composition_history: Vec<(u64, f64, f64)>,
    arb_trade_count: u64,
    arb_total_profit_usd: f64,
    arb_gas_cost_usd: f64,
    user_total_volume_usd: f64,
    total_volume_usd: f64,
    total_fees_usd: f64,
    slippage_aggregate: StreamingAggregate,
    slippage_bucket_sum_bps: Vec<f64>,
    slippage_bucket_count: Vec<u64>,
    recentering_timestamps: Vec<u64>,
    recentering_estimated_il_usd: f64,
    /// (timestamp, anchor as f64 USD-per-base) committed by each
    /// recentering event — base-in-slot-0 contexts store the reciprocal
    /// of the raw priceScale so every context lands in the same
    /// USD-per-base frame. The anchor is constant between commits, so
    /// this step function reconstructs it exactly.
    anchor_scale_points: Vec<(u64, f64)>,
    avg_lp_oracle_err_bps: Option<f64>,
    max_lp_oracle_err_bps: Option<f64>,
    anchor_dev_points: Vec<ChartPoint>,
    trade_prices_by_ts: HashMap<u64, f64>,
    price_series: Vec<(u64, f64, f64)>,
    avg_abs_deviation_bps: f64,
}

impl ContextAccumulator {
    fn new(context: RunContext, slippage_bucket_count: usize) -> Self {
        Self {
            context,
            initial_amount0: 0,
            initial_amount1: 0,
            initial_value_usd: 0.0,
            final_amount0: 0,
            final_amount1: 0,
            final_value_usd: 0.0,
            net_pnl_percent_fraction: 0.0,
            delta_vs_hold_fraction: 0.0,
            donations_usd: 0.0,
            donation_events: 0,
            il_loss_only_fraction: 0.0,
            value_history: Vec::new(),
            composition_history: Vec::new(),
            arb_trade_count: 0,
            arb_total_profit_usd: 0.0,
            arb_gas_cost_usd: 0.0,
            user_total_volume_usd: 0.0,
            total_volume_usd: 0.0,
            total_fees_usd: 0.0,
            slippage_aggregate: StreamingAggregate {
                count: 0,
                sum: 0.0,
                sum_squares: 0.0,
                min: 0.0,
                max: 0.0,
            },
            slippage_bucket_sum_bps: vec![0.0; slippage_bucket_count],
            slippage_bucket_count: vec![0u64; slippage_bucket_count],
            recentering_timestamps: Vec::new(),
            recentering_estimated_il_usd: 0.0,
            anchor_scale_points: Vec::new(),
            avg_lp_oracle_err_bps: None,
            max_lp_oracle_err_bps: None,
            anchor_dev_points: Vec::new(),
            trade_prices_by_ts: HashMap::new(),
            price_series: Vec::new(),
            avg_abs_deviation_bps: 0.0,
        }
    }
}

pub fn generate_report_from_results(
    results_path: &Path,
    output_dir: &Path,
    oracle_data_dir: &Path,
    provenance: &ExecutionProvenance,
) -> Result<()> {
    // Read ONCE and derive both the parsed result and (below) its
    // canonical digest from this single buffer — re-opening the file for
    // hashing would let a concurrent rewrite make the marker attest bytes
    // the report was not built from.
    let raw = fs::read_to_string(results_path)
        .with_context(|| format!("read results file {}", results_path.display()))?;
    let mut results: RunResults = serde_json::from_str(&raw)
        .with_context(|| format!("parse results file {}", results_path.display()))?;
    drop(raw);
    if results.metadata.execution_fingerprint != provenance.execution_fingerprint
        || results.metadata.oracle_digest != provenance.material.oracle_snapshot.oracle_digest
        || results.metadata.origin_config_hash != provenance.material.config_hash
    {
        return Err(anyhow!(
            "sim_results metadata does not match the supplied execution manifest"
        ));
    }
    let actual_contexts = results
        .contexts
        .iter()
        .map(|context| context.context_name.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let expected_contexts = provenance
        .material
        .partition_config_hashes
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    if actual_contexts != expected_contexts {
        return Err(anyhow!(
            "sim_results context set does not match execution manifest partitions"
        ));
    }
    // Same canonical content digest as the merge pipeline (sorted maps,
    // compact stream, volatile generatedAt excluded) — NOT a hash of the
    // file bytes, so the digest is comparable across both report paths
    // and reproducible regardless of on-disk formatting.
    let result_digest = canonical_result_digest(&mut results)?;
    generate_report_from_run_results(results, output_dir, oracle_data_dir, &result_digest)
}

pub fn generate_report_from_run_results(
    results: RunResults,
    output_dir: &Path,
    oracle_data_dir: &Path,
    result_digest: &str,
) -> Result<()> {
    static REPORT_SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = parent_dir_or_current(output_dir);
    create_directory_all_durable(parent)
        .with_context(|| format!("create report parent {}", parent.display()))?;
    let name = output_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("report output has a non-UTF8/empty name"))?;
    let staging = parent.join(format!(
        ".{name}.staging-{}-{}",
        std::process::id(),
        REPORT_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&staging)
        .with_context(|| format!("create report staging dir {}", staging.display()))?;
    let completion = json!({
        "reportAlgorithmVersion": REPORT_ALGORITHM_VERSION,
        "resultFormatVersion": results.result_format_version.clone(),
        "executionFingerprint": results.metadata.execution_fingerprint.clone(),
        "oracleDigest": results.metadata.oracle_digest.clone(),
        "resultDigest": result_digest,
    });
    let generated = (|| -> Result<()> {
        generate_report_into_directory(results, &staging, oracle_data_dir, result_digest)?;
        write_json_atomic(&staging.join("REPORT_COMPLETE.json"), &completion)?;
        sync_directory_tree(&staging)?;
        publish_report_directory(&staging, output_dir)?;
        Ok(())
    })();
    if generated.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    generated
}

fn generate_report_into_directory(
    results: RunResults,
    output_dir: &Path,
    oracle_data_dir: &Path,
    result_digest: &str,
) -> Result<()> {
    validate_run_results_contract(&results)
        .with_context(|| "validate sim_results schema before report generation")?;
    let (oracle, actual_oracle) = OracleStore::load(oracle_data_dir)
        .with_context(|| format!("load oracle data from {}", oracle_data_dir.display()))?;
    if actual_oracle.oracle_digest != results.metadata.oracle_digest {
        return Err(anyhow!(
            "report oracle digest mismatch: results={}, directory={}",
            results.metadata.oracle_digest,
            actual_oracle.oracle_digest
        ));
    }
    let bucket_edges_bps = build_slippage_bucket_edges_bps(
        results.metadata.slippage_sweep.min_initial_side_bps,
        results.metadata.slippage_sweep.max_initial_side_bps,
    )?;
    let slippage_bucket_count = bucket_edges_bps.len() - 1;
    let mut context_by_name: HashMap<String, RunContext> = HashMap::new();
    let mut accumulators: BTreeMap<String, ContextAccumulator> = BTreeMap::new();
    for ctx in &results.contexts {
        context_by_name.insert(ctx.context_name.clone(), ctx.clone());
        accumulators.insert(
            ctx.context_name.clone(),
            ContextAccumulator::new(ctx.clone(), slippage_bucket_count),
        );
    }

    // Passive LP state.
    for st in &results.passive_lp_states {
        let Some(acc) = accumulators.get_mut(&st.context_name) else {
            continue;
        };
        let amount0 = parse_u128_string(&st.initial_deposit.amount0, "initialDeposit.amount0")?;
        let amount1 = parse_u128_string(&st.initial_deposit.amount1, "initialDeposit.amount1")?;
        let final0 = parse_u128_string(&st.final_position.amount0, "finalPosition.amount0")?;
        let final1 = parse_u128_string(&st.final_position.amount1, "finalPosition.amount1")?;

        acc.initial_amount0 = amount0;
        acc.initial_amount1 = amount1;
        acc.initial_value_usd = st.initial_deposit.value_usd;
        acc.final_amount0 = final0;
        acc.final_amount1 = final1;
        acc.final_value_usd = st.final_position.value_usd;
        acc.net_pnl_percent_fraction = st.net_pnl;
        acc.donations_usd = st.donations_usd;
        acc.donation_events = st.donation_events;

        acc.value_history = st
            .value_history
            .iter()
            .map(|snap| (snap.timestamp, snap.value_usd))
            .collect();

        let d0 = 10f64.powi(token_decimals(&acc.context.token0_symbol)? as i32);
        let d1 = 10f64.powi(token_decimals(&acc.context.token1_symbol)? as i32);
        let mut composition = Vec::with_capacity(st.composition_history.len());
        for snap in &st.composition_history {
            let a0 = parse_u128_string(&snap.amount0, "compositionHistory.amount0")?;
            let a1 = parse_u128_string(&snap.amount1, "compositionHistory.amount1")?;
            composition.push((snap.timestamp, a0 as f64 / d0, a1 as f64 / d1));
        }
        acc.composition_history = composition;

        let oracle_symbol = oracle_symbol_for_pool(&acc.context.pool_key);
        let oracle_end = oracle.get_price_at(oracle_symbol, results.metadata.end_timestamp)?;
        let hold_value = compute_usd_value(
            &acc.context.token0_symbol,
            &acc.context.token1_symbol,
            acc.initial_amount0,
            acc.initial_amount1,
            oracle_end,
        )?;
        // Exogenous donations are a subsidy, not pool performance —
        // delta-vs-hold is computed NET of them, mirroring the netPnl
        // subtraction the simulator applies at finalize. The raw
        // result's `impermanentLossActual` is deliberately GROSS of
        // donations (it measures the price-move loss of the redeemed
        // position, not the subsidy) and is not used here.
        let delta_vs_hold = if hold_value > 0.0 {
            (acc.final_value_usd - acc.donations_usd - hold_value) / hold_value
        } else {
            0.0
        };
        acc.delta_vs_hold_fraction = delta_vs_hold;
        acc.il_loss_only_fraction = if delta_vs_hold > 0.0 {
            0.0
        } else {
            delta_vs_hold
        };
    }

    // User volume/fees from debug trade history, if present.
    for trade in &results.user_state.trade_history {
        for (context_name, swap_result) in &trade.results {
            let Some(acc) = accumulators.get_mut(context_name) else {
                continue;
            };
            acc.user_total_volume_usd += trade.amount_usd;
            acc.total_volume_usd += trade.amount_usd;
            let fee_paid = swap_result
                .get("feePaidUsd")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            acc.total_fees_usd += fee_paid;
        }
    }

    // Precomputed slippage. `validate_run_results_contract` has already
    // proven exact one-to-one context ownership, identical edges and exact
    // edges-1 vector lengths, so this is a direct copy: no zero padding,
    // truncation, ignored unknown context or duplicate overwrite remains.
    for state in &results.user_state.slippage_by_context {
        let acc = accumulators.get_mut(&state.context_name).ok_or_else(|| {
            anyhow!(
                "validated slippage context `{}` has no accumulator",
                state.context_name
            )
        })?;
        acc.slippage_aggregate = state.aggregate.clone();
        acc.slippage_bucket_sum_bps = state.trade_size_buckets.sum_slippage_bps.clone();
        acc.slippage_bucket_count = state.trade_size_buckets.count.clone();
    }

    // Arbitrage trades.
    for state in &results.arb_states {
        let Some(acc) = accumulators.get_mut(&state.context_name) else {
            continue;
        };
        acc.arb_trade_count = state.trade_count;
        acc.arb_total_profit_usd = state.total_profit_usd;
        acc.arb_gas_cost_usd = state.total_gas_cost_usd;

        for trade in &state.trades {
            let oracle_symbol = oracle_symbol_for_pool(&acc.context.pool_key);
            let oracle_price = oracle.get_price_at(oracle_symbol, trade.timestamp)?;
            let volume_usd = compute_trade_volume_usd(trade, &acc.context.pool_key, oracle_price)?;
            acc.total_volume_usd += volume_usd;
            acc.total_fees_usd += trade.fee_paid_usd;

            if let Some(price) = pool_price_from_trade(trade, &acc.context.pool_key) {
                if price.is_finite() && price > 0.0 {
                    acc.trade_prices_by_ts.insert(trade.timestamp, price);
                }
            }
        }
    }

    // Recentering / rebalance events.
    for evt in &results.recentering_events {
        apply_recentering_event(evt, &context_by_name, &mut accumulators, &oracle)?;
    }

    // Price LOCF series + deviation.
    for acc in accumulators.values_mut() {
        let oracle_symbol = oracle_symbol_for_pool(&acc.context.pool_key);
        let timestamps = oracle.timestamps(
            oracle_symbol,
            results.metadata.start_timestamp,
            results.metadata.end_timestamp,
        )?;
        if timestamps.is_empty() {
            continue;
        }
        let mut last_known_price =
            oracle.get_price_at(oracle_symbol, results.metadata.start_timestamp)?;
        // Anchor step function: pools seed `priceScale` from the oracle
        // price at genesis; every recentering event carries the newly
        // committed value. Only anchor-bearing AMMs get the metric.
        let has_anchor = matches!(acc.context.amm_name.as_str(), "equilibra" | "curve");
        let mut anchor_points = acc.anchor_scale_points.clone();
        anchor_points.sort_by_key(|(ts, _)| *ts);
        let mut anchor_idx = 0usize;
        let mut anchor_price = last_known_price;
        let mut anchor_dev_sum = 0.0f64;
        let mut anchor_dev_max = 0.0f64;
        let mut deviation_sum = 0.0f64;
        let mut deviation_count = 0u64;
        let mut series = Vec::<(u64, f64, f64)>::with_capacity(timestamps.len());
        for ts in timestamps {
            if let Some(trade_price) = acc.trade_prices_by_ts.get(&ts) {
                last_known_price = *trade_price;
            }
            while anchor_idx < anchor_points.len() && anchor_points[anchor_idx].0 <= ts {
                anchor_price = anchor_points[anchor_idx].1;
                anchor_idx += 1;
            }
            let oracle_price = oracle.get_price_at(oracle_symbol, ts)?;
            if oracle_price > 0.0 {
                deviation_sum +=
                    ((last_known_price - oracle_price) / oracle_price * 10_000.0).abs();
                let ratio = if anchor_price >= oracle_price {
                    anchor_price / oracle_price
                } else {
                    oracle_price / anchor_price
                };
                let anchor_dev = (ratio.sqrt() - 1.0) * 10_000.0;
                anchor_dev_sum += anchor_dev;
                if anchor_dev > anchor_dev_max {
                    anchor_dev_max = anchor_dev;
                }
                if has_anchor {
                    acc.anchor_dev_points.push(ChartPoint {
                        x: (ts as i64) * 1000,
                        y: anchor_dev,
                    });
                }
                deviation_count = deviation_count.saturating_add(1);
            }
            series.push((ts, last_known_price, oracle_price));
        }
        acc.price_series = series;
        acc.avg_abs_deviation_bps = if deviation_count > 0 {
            deviation_sum / deviation_count as f64
        } else {
            0.0
        };
        acc.avg_lp_oracle_err_bps = if has_anchor && deviation_count > 0 {
            Some(anchor_dev_sum / deviation_count as f64)
        } else {
            None
        };
        acc.max_lp_oracle_err_bps = if has_anchor && deviation_count > 0 {
            Some(anchor_dev_max)
        } else {
            None
        };
    }

    // Build output files.
    sync_report_web_template(output_dir)?;
    let copied_assets_digest = hash_report_assets_dir(&output_dir.join("web"))?;
    if copied_assets_digest != results.metadata.report_assets_digest {
        return Err(anyhow!(
            "copied report asset digest mismatch: results={}, staging={}",
            results.metadata.report_assets_digest,
            copied_assets_digest
        ));
    }

    let report_generator_sha256 = binary_digest(
        "report-generator",
        &std::env::current_exe().with_context(|| "resolve report generator executable")?,
    )?
    .sha256;
    let report_fingerprint = derive_report_fingerprint(
        &results.metadata.execution_fingerprint,
        result_digest,
        &report_generator_sha256,
        &results.metadata.report_assets_digest,
    )?;
    let report_metadata = ReportRunMetadata {
        result_format_version: results.result_format_version.clone(),
        report_algorithm_version: REPORT_ALGORITHM_VERSION.to_string(),
        config_hash: results.metadata.config_hash.clone(),
        origin_config_hash: results.metadata.origin_config_hash.clone(),
        execution_fingerprint: results.metadata.execution_fingerprint.clone(),
        oracle_digest: results.metadata.oracle_digest.clone(),
        report_assets_digest: results.metadata.report_assets_digest.clone(),
        result_digest: result_digest.to_string(),
        report_generator_sha256,
        report_fingerprint,
        actor_algorithm_version: results.metadata.actor_algorithm_version.clone(),
        slippage_sweep: results.metadata.slippage_sweep.clone(),
        quote_symbols: QUOTE_SYMBOLS.iter().map(|s| s.to_string()).collect(),
        seed: results.metadata.seed,
        start_timestamp: results.metadata.start_timestamp,
        end_timestamp: results.metadata.end_timestamp,
        duration_days: results.metadata.duration_days,
        initial_liquidity_usd: results.metadata.initial_liquidity_usd,
        gas_price_gwei: results.metadata.gas_price_gwei,
        amm_list: results.metadata.amm_list.clone(),
        pool_list: results.metadata.pool_list.clone(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        fee_config: results.metadata.fee_config.clone(),
        pool_tokens: results.metadata.pool_tokens.clone(),
        pool_tokens_by_amm: results.metadata.pool_tokens_by_amm.clone(),
    };

    let summaries = build_summaries(&accumulators)?;
    let metrics = MetricsExport {
        metadata: report_metadata.clone(),
        summaries,
    };

    let web_data_dir = output_dir.join("web").join("data");
    fs::create_dir_all(&web_data_dir)
        .with_context(|| format!("create report data dir {}", web_data_dir.display()))?;

    write_json_atomic(&web_data_dir.join("metrics.json"), &metrics)?;

    // Per-quote slippage samples with full breakdown (reserves, spot,
    // staleness, value-skew, …). Exported as a standalone artifact so
    // the raw sim_results.json (which is deleted post-report to save
    // disk) is no longer required for ad-hoc analysis.
    write_slippage_samples_export(
        &web_data_dir.join("slippage-samples.json"),
        &results.user_state.slippage_by_context,
        &report_metadata,
    )?;

    for pool_key in &report_metadata.pool_list {
        // `pool_key` originates in `sim_results.json` metadata, which the
        // report CLI may be pointed at for untrusted input. Reject any key
        // that is not a plain filename token so it cannot traverse out of
        // the data dir via `series-{key}.json`.
        if !is_safe_pool_key(pool_key) {
            return Err(anyhow!(
                "unsafe pool key {:?} in metadata.pool_list (expected [A-Za-z0-9._-])",
                pool_key
            ));
        }
        let series =
            build_compact_series(pool_key, &accumulators, &bucket_edges_bps, &report_metadata)?;
        write_json_atomic(
            &web_data_dir.join(format!("series-{pool_key}.json")),
            &series,
        )?;
    }

    if results.equilibra_recenter_gate_stats.is_some()
        || results.curve_rebalance_gate_stats.is_some()
    {
        write_recenter_gate_log(
            &web_data_dir,
            results.equilibra_recenter_gate_stats.as_ref(),
            results.curve_rebalance_gate_stats.as_ref(),
        )
        .with_context(|| "write recenter-gates.log next to metrics.json")?;
    }

    Ok(())
}

/// Per-context wrapper around the raw `SlippageSample` slice for the
/// `slippage-samples.json` artifact. The samples are the deterministic-
/// reservoir copies that the simulator already maintains in
/// `UserSlippageState::samples` (capped at `MAX_SLIPPAGE_SAMPLES`), so no
/// additional storage is allocated by this exporter.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlippageSamplesContextExport<'a> {
    /// Total quotes that fed the streaming aggregate (population size,
    /// not the number of samples physically retained).
    aggregate_count: u64,
    sample_count: usize,
    samples: &'a [SlippageSample],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlippageSamplesExport<'a> {
    metadata: &'a ReportRunMetadata,
    /// Short human-readable description of the schema, kept inside the
    /// file so downstream consumers (Python, dashboards) can introspect
    /// what each field means without grepping the simulator source.
    description: &'static str,
    by_context: BTreeMap<String, SlippageSamplesContextExport<'a>>,
}

/// A pool key safe to interpolate into a `series-<key>.json` filename:
/// non-empty and limited to `[A-Za-z0-9._-]`, so it carries no path
/// separators or parent references.
fn is_safe_pool_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Persist the raw per-quote slippage samples (with full breakdown) as a
/// standalone JSON artifact next to `metrics.json`. Decoupled from the
/// large `sim_results.json` (which is removed once the report finishes)
/// so any future analysis still has direct access to the breakdown.
fn write_slippage_samples_export(
    path: &Path,
    contexts: &[UserSlippageByContext],
    metadata: &ReportRunMetadata,
) -> Result<()> {
    let mut by_context: BTreeMap<String, SlippageSamplesContextExport<'_>> = BTreeMap::new();
    for state in contexts {
        by_context.insert(
            state.context_name.clone(),
            SlippageSamplesContextExport {
                aggregate_count: state.aggregate.count,
                sample_count: state.samples.len(),
                samples: &state.samples,
            },
        );
    }
    let export = SlippageSamplesExport {
        metadata,
        description: "Per-quote slippage samples with full breakdown. \
             Each sample exposes the executed amounts, the pool's \
             pre-trade reserves and mid spot price, the oracle price, \
             three slippage flavours (vs oracle, vs pool spot, oracle\
             -spot lag) and the value-skew dPreBps. Up to 1000 \
             reservoir samples per context.",
        by_context,
    };
    write_json_atomic(path, &export)
}

/// Render the aggregated recenter/rebalance-gate statistics into a single
/// human-readable text file (`recenter-gates.log`) located next to
/// `metrics.json`: one section per AMM, each walking its own canonical gate
/// order so the columns stay stable regardless of which gates fired.
fn write_recenter_gate_log(
    web_data_dir: &Path,
    equilibra: Option<&RecenterGateStatsExport>,
    curve: Option<&RecenterGateStatsExport>,
) -> Result<()> {
    let equilibra_gate_keys: Vec<&'static str> = EquilibraRecenterGateBlocked::all()
        .iter()
        .map(|gate| gate.as_str())
        .collect();
    let curve_gate_keys: Vec<&'static str> = CurveRebalanceGateBlocked::all()
        .iter()
        .map(|gate| gate.as_str())
        .collect();

    let mut out = String::new();
    if let Some(export) = equilibra {
        render_gate_section(
            &mut out,
            "Equilibra recenter-gate statistics",
            &equilibra_gate_keys,
            export,
        )?;
    }
    if let Some(export) = curve {
        render_gate_section(
            &mut out,
            "Curve rebalance-gate statistics",
            &curve_gate_keys,
            export,
        )?;
    }
    if out.is_empty() {
        out.push_str("# (no recenter-gate activity recorded)\n");
    }

    let path = web_data_dir.join("recenter-gates.log");
    fs::write(&path, out).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Append one AMM's gate-statistics section (`overall` + `monthly` +
/// `quarterly` blocks per base) to the log body.
fn render_gate_section(
    out: &mut String,
    title: &str,
    gate_keys: &[&'static str],
    export: &RecenterGateStatsExport,
) -> Result<()> {
    use std::fmt::Write as _;

    writeln!(out, "# {}", title)?;
    let mut wrote_any = false;
    for (base, periods) in &export.by_base {
        let overall = &periods.overall;
        if overall.checks_total == 0
            && periods.monthly.values().all(|s| s.checks_total == 0)
            && periods.quarterly.values().all(|s| s.checks_total == 0)
        {
            continue;
        }
        wrote_any = true;
        writeln!(out, "[{}] overall", base)?;
        append_gate_block(out, overall, gate_keys)?;
        out.push('\n');

        if periods.monthly.values().any(|s| s.checks_total > 0) {
            writeln!(out, "[{}] monthly", base)?;
            for (period, counts) in &periods.monthly {
                if counts.checks_total == 0 {
                    continue;
                }
                writeln!(out, "  {}:", period)?;
                append_gate_block_indented(out, counts, "    ", gate_keys)?;
            }
            out.push('\n');
        }

        if periods.quarterly.values().any(|s| s.checks_total > 0) {
            writeln!(out, "[{}] quarterly", base)?;
            for (period, counts) in &periods.quarterly {
                if counts.checks_total == 0 {
                    continue;
                }
                writeln!(out, "  {}:", period)?;
                append_gate_block_indented(out, counts, "    ", gate_keys)?;
            }
            out.push('\n');
        }
    }

    if !wrote_any {
        out.push_str("# (no gate activity recorded for this AMM)\n\n");
    }
    Ok(())
}

fn append_gate_block(
    out: &mut String,
    counts: &RecenterGateCounts,
    gate_keys: &[&'static str],
) -> std::fmt::Result {
    append_gate_block_indented(out, counts, "  ", gate_keys)
}

fn append_gate_block_indented(
    out: &mut String,
    counts: &RecenterGateCounts,
    indent: &str,
    gate_keys: &[&'static str],
) -> std::fmt::Result {
    use std::fmt::Write as _;
    let checks = counts.checks_total;
    let blocked = counts.blocked_total();
    let pct = |num: u64, den: u64| -> f64 {
        if den == 0 {
            0.0
        } else {
            (num as f64) * 100.0 / (den as f64)
        }
    };
    writeln!(
        out,
        "{indent}checks={} recentered={} ({:.4}% of checks, viaParachute={} = {:.4}% of recentered) blocked={} ({:.4}% of checks)",
        checks,
        counts.recentered,
        pct(counts.recentered, checks),
        counts.recentered_via_parachute,
        pct(counts.recentered_via_parachute, counts.recentered),
        blocked,
        pct(blocked, checks),
    )?;
    // Iterate the canonical gate order coming from the owning AMM's enum so
    // the report always shows the same columns regardless of which gates
    // fired. Missing keys render as zero.
    for &key in gate_keys {
        let count = counts.blocked_counts.get(key).copied().unwrap_or(0);
        writeln!(
            out,
            "{indent}  gate={} blocked={} ({:.4}% of blocked)",
            key,
            count,
            pct(count, blocked),
        )?;
    }
    Ok(())
}

fn build_summaries(accumulators: &BTreeMap<String, ContextAccumulator>) -> Result<Vec<AmmSummary>> {
    let mut rows = Vec::with_capacity(accumulators.len());
    for acc in accumulators.values() {
        let token0_dec = token_decimals(&acc.context.token0_symbol)? as i32;
        let token1_dec = token_decimals(&acc.context.token1_symbol)? as i32;
        let lp_positions = LpPositions {
            lp1_initial_token0: acc.initial_amount0 as f64 / 10f64.powi(token0_dec),
            lp1_initial_token1: acc.initial_amount1 as f64 / 10f64.powi(token1_dec),
            lp1_initial_usd: acc.initial_value_usd,
            lp1_final_token0: acc.final_amount0 as f64 / 10f64.powi(token0_dec),
            lp1_final_token1: acc.final_amount1 as f64 / 10f64.powi(token1_dec),
            lp1_final_usd: acc.final_value_usd,
        };
        let avg_slippage_bps = if acc.slippage_aggregate.count > 0 {
            acc.slippage_aggregate.sum / acc.slippage_aggregate.count as f64
        } else {
            0.0
        };
        let min_slippage_bps = if acc.slippage_aggregate.count > 0 {
            acc.slippage_aggregate.min
        } else {
            0.0
        };
        let max_slippage_bps = if acc.slippage_aggregate.count > 0 {
            acc.slippage_aggregate.max
        } else {
            0.0
        };
        rows.push(AmmSummary {
            amm_name: acc.context.amm_name.clone(),
            pool_key: acc.context.pool_key.clone(),
            token0_symbol: acc.context.token0_symbol.clone(),
            token1_symbol: acc.context.token1_symbol.clone(),
            lp1_il_percent: acc.il_loss_only_fraction * 100.0,
            lp1_delta_vs_hold_percent: acc.delta_vs_hold_fraction * 100.0,
            lp1_net_pnl_percent: acc.net_pnl_percent_fraction * 100.0,
            donations_usd: acc.donations_usd,
            donations_percent_of_initial: if acc.initial_value_usd > 0.0 {
                acc.donations_usd / acc.initial_value_usd * 100.0
            } else {
                0.0
            },
            donations_percent_of_final: if acc.final_value_usd > 0.0 {
                acc.donations_usd / acc.final_value_usd * 100.0
            } else {
                0.0
            },
            donation_events: acc.donation_events,
            arb_trade_count: acc.arb_trade_count,
            arb_total_profit_usd: acc.arb_total_profit_usd,
            arb_gas_cost_usd: acc.arb_gas_cost_usd,
            total_volume_usd: acc.total_volume_usd,
            arb_volume_usd: (acc.total_volume_usd - acc.user_total_volume_usd).max(0.0),
            total_fees_usd: acc.total_fees_usd,
            avg_slippage_bps,
            min_slippage_bps,
            max_slippage_bps,
            recentering_count: acc.recentering_timestamps.len() as u64,
            recentering_estimated_il_usd: acc.recentering_estimated_il_usd,
            lp_positions,
        });
    }
    rows.sort_by(|a, b| {
        a.pool_key
            .cmp(&b.pool_key)
            .then_with(|| a.amm_name.cmp(&b.amm_name))
    });
    Ok(rows)
}

fn build_compact_series(
    pool_key: &str,
    accumulators: &BTreeMap<String, ContextAccumulator>,
    bucket_edges_bps: &[u64],
    report_metadata: &ReportRunMetadata,
) -> Result<CompactSeriesExport> {
    let mut pool_accs: Vec<&ContextAccumulator> = accumulators
        .values()
        .filter(|acc| acc.context.pool_key == pool_key)
        .collect();
    pool_accs.sort_by(|a, b| a.context.amm_name.cmp(&b.context.amm_name));

    let (oracle_timestamps, oracle_prices): (Vec<u64>, Vec<f64>) =
        if let Some(first) = pool_accs.first() {
            let ts = first.price_series.iter().map(|(t, _, _)| *t).collect();
            let ps = first.price_series.iter().map(|(_, _, o)| *o).collect();
            (ts, ps)
        } else {
            (Vec::new(), Vec::new())
        };

    let oracle_decimated =
        decimate_series_to_points(&oracle_timestamps, &oracle_prices, MAX_POINTS_PER_SERIES);

    // The decimated pool price series is period-independent — extract and
    // LTTB-decimate it once per AMM (mirroring the `oracle_decimated` hoist
    // above) instead of redoing the O(N) pass for every EMA period. Only
    // `compute_ema` differs across periods; the emitted series are
    // byte-identical to the per-period recomputation.
    let decimated_by_amm: Vec<(String, Vec<ChartPoint>)> = pool_accs
        .iter()
        .map(|acc| {
            let ts: Vec<u64> = acc.price_series.iter().map(|(t, _, _)| *t).collect();
            let px: Vec<f64> = acc.price_series.iter().map(|(_, p, _)| *p).collect();
            (
                acc.context.amm_name.clone(),
                decimate_series_to_points(&ts, &px, MAX_POINTS_PER_SERIES),
            )
        })
        .collect();

    let mut ema_map: BTreeMap<String, CompactDeviationEmaSet> = BTreeMap::new();
    for period in EMA_PERIODS {
        let oracle_ema = compute_ema(&oracle_decimated, period);
        let mut pools = BTreeMap::new();
        for (amm_name, decimated) in &decimated_by_amm {
            pools.insert(amm_name.clone(), compute_ema(decimated, period));
        }
        ema_map.insert(
            period.to_string(),
            CompactDeviationEmaSet {
                oracle: oracle_ema,
                pools,
            },
        );
    }

    let mut lp_value_by_amm = BTreeMap::new();
    let mut live_lp_delta_vs_hold_by_amm = BTreeMap::new();
    let mut quote_by_amm = BTreeMap::new();
    let mut base_by_amm = BTreeMap::new();
    let mut recenter_stats = BTreeMap::new();
    let mut lp_oracle_err_series = BTreeMap::<String, Vec<ChartPoint>>::new();
    let mut slippage_by_amm = BTreeMap::new();

    let mut eq_markers = Vec::<ChartPoint>::new();
    let mut curve_markers = Vec::<ChartPoint>::new();

    for acc in &pool_accs {
        let value_ts: Vec<u64> = acc.value_history.iter().map(|(t, _)| *t).collect();
        let value_v: Vec<f64> = acc.value_history.iter().map(|(_, v)| *v).collect();
        lp_value_by_amm.insert(
            acc.context.amm_name.clone(),
            decimate_series_to_points(&value_ts, &value_v, MAX_POINTS_PER_SERIES),
        );
        let mut delta_vs_hold_ts = Vec::<u64>::with_capacity(acc.value_history.len());
        let mut delta_vs_hold_v = Vec::<f64>::with_capacity(acc.value_history.len());
        for (ts, lp_value) in &acc.value_history {
            let Some(oracle_price) = oracle_price_from_series_at(&acc.price_series, *ts) else {
                continue;
            };
            if !lp_value.is_finite() || !oracle_price.is_finite() || oracle_price <= 0.0 {
                continue;
            }
            let hold_value = compute_usd_value(
                &acc.context.token0_symbol,
                &acc.context.token1_symbol,
                acc.initial_amount0,
                acc.initial_amount1,
                oracle_price,
            )?;
            if !hold_value.is_finite() || hold_value <= 0.0 {
                continue;
            }
            let delta_vs_hold_percent = (*lp_value - hold_value) / hold_value * 100.0;
            if delta_vs_hold_percent.is_finite() {
                delta_vs_hold_ts.push(*ts);
                delta_vs_hold_v.push(delta_vs_hold_percent);
            }
        }
        live_lp_delta_vs_hold_by_amm.insert(
            acc.context.amm_name.clone(),
            decimate_series_to_points(&delta_vs_hold_ts, &delta_vs_hold_v, MAX_POINTS_PER_SERIES),
        );

        let token0_is_quote = is_quote_symbol(&acc.context.token0_symbol);
        let mut comp_ts = Vec::<u64>::with_capacity(acc.composition_history.len());
        let mut quote_values = Vec::<f64>::with_capacity(acc.composition_history.len());
        let mut base_values = Vec::<f64>::with_capacity(acc.composition_history.len());
        for (ts, a0, a1) in &acc.composition_history {
            comp_ts.push(*ts);
            if token0_is_quote {
                quote_values.push(*a0);
                base_values.push(*a1);
            } else {
                quote_values.push(*a1);
                base_values.push(*a0);
            }
        }
        quote_by_amm.insert(
            acc.context.amm_name.clone(),
            decimate_series_to_points(&comp_ts, &quote_values, MAX_POINTS_PER_SERIES),
        );
        base_by_amm.insert(
            acc.context.amm_name.clone(),
            decimate_series_to_points(&comp_ts, &base_values, MAX_POINTS_PER_SERIES),
        );

        recenter_stats.insert(
            acc.context.amm_name.clone(),
            CompactRecenteringStats {
                count: acc.recentering_timestamps.len() as u64,
                estimated_il_usd: acc.recentering_estimated_il_usd,
                avg_abs_deviation_bps: acc.avg_abs_deviation_bps,
                avg_lp_oracle_err_bps: acc.avg_lp_oracle_err_bps,
                max_lp_oracle_err_bps: acc.max_lp_oracle_err_bps,
            },
        );

        if !acc.anchor_dev_points.is_empty() {
            let max_point =
                acc.anchor_dev_points
                    .iter()
                    .copied()
                    .fold(
                        acc.anchor_dev_points[0],
                        |m, p| if p.y > m.y { p } else { m },
                    );
            let mut sampled = lttb_decimate_points(&acc.anchor_dev_points, MAX_POINTS_PER_SERIES);
            // LTTB keeps most extremes but not provably the global max —
            // re-insert it so the deepest stall is always on the chart.
            if !sampled.iter().any(|p| p.x == max_point.x) {
                sampled.push(max_point);
                sampled.sort_by_key(|p| p.x);
            }
            lp_oracle_err_series.insert(acc.context.amm_name.clone(), sampled);
        }

        let mut avg_slippage_percent = Vec::<Option<f64>>::new();
        let mut valid = Vec::<f64>::new();
        for i in 0..(bucket_edges_bps.len() - 1) {
            // The result contract guarantees exact lengths; direct indexing
            // makes any internal invariant violation loud rather than
            // manufacturing a zero/`null` bucket.
            let count = acc.slippage_bucket_count[i];
            let sum = acc.slippage_bucket_sum_bps[i];
            if count > 0 {
                let v = sum / count as f64 / 100.0;
                avg_slippage_percent.push(Some(v));
                valid.push(v);
            } else {
                avg_slippage_percent.push(None);
            }
        }
        slippage_by_amm.insert(
            acc.context.amm_name.clone(),
            CompactSlippageByAmm {
                avg_slippage_percent,
                amm_min: valid.iter().copied().reduce(f64::min),
                amm_max: valid.iter().copied().reduce(f64::max),
            },
        );

        let markers = map_event_timestamps_to_oracle_points(
            &acc.recentering_timestamps,
            &oracle_timestamps,
            &oracle_prices,
        );
        if acc.context.amm_name == "equilibra" {
            eq_markers.extend(markers);
        } else if acc.context.amm_name == "curve" {
            curve_markers.extend(markers);
        }
    }

    Ok(CompactSeriesExport {
        format: "dashboard-compact-v2".to_string(),
        metadata: CompactSeriesMeta {
            result_format_version: report_metadata.result_format_version.clone(),
            actor_algorithm_version: report_metadata.actor_algorithm_version.clone(),
            execution_fingerprint: report_metadata.execution_fingerprint.clone(),
            oracle_digest: report_metadata.oracle_digest.clone(),
            slippage_sweep: report_metadata.slippage_sweep.clone(),
            pool_key: pool_key.to_string(),
            max_points_per_series: MAX_POINTS_PER_SERIES,
            ema_periods: EMA_PERIODS.to_vec(),
        },
        charts: CompactCharts {
            deviation: CompactDeviationChart {
                ema: ema_map,
                recentering_markers: CompactRecenteringMarkers {
                    equilibra: downsample_recentering_markers(
                        &eq_markers,
                        MAX_MARKER_POINTS_PER_SERIES,
                    ),
                    curve: downsample_recentering_markers(
                        &curve_markers,
                        MAX_MARKER_POINTS_PER_SERIES,
                    ),
                },
                recentering_stats: recenter_stats,
                lp_oracle_err: lp_oracle_err_series,
            },
            lp_value: CompactLpValueChart {
                passive_usd_by_amm: lp_value_by_amm,
            },
            live_lp_delta_vs_hold: CompactLiveLpDeltaVsHoldChart {
                percent_by_amm: live_lp_delta_vs_hold_by_amm,
            },
            lp_composition: CompactLpCompositionChart {
                quote_by_amm,
                base_by_amm,
            },
            slippage: CompactSlippageChart {
                bucket_edges_bps: bucket_edges_bps.to_vec(),
                by_amm: slippage_by_amm,
            },
        },
    })
}

fn apply_recentering_event(
    evt: &RecenteringEvent,
    context_by_name: &HashMap<String, RunContext>,
    accumulators: &mut BTreeMap<String, ContextAccumulator>,
    oracle: &OracleStore,
) -> Result<()> {
    // A recentering event that does not match a known (amm, pool) context is
    // corrupted input: the producer only ever emits events for contexts it
    // ran. Fail loudly instead of silently dropping it from the recentering
    // counts / IL attribution.
    let amm_name = evt.amm_name.as_str();
    let context = context_by_name
        .values()
        .find(|ctx| ctx.amm_name == amm_name && ctx.pool_key == evt.pool_key)
        .ok_or_else(|| {
            anyhow!(
                "recentering event references unknown context (amm={}, pool={}, ts={})",
                amm_name,
                evt.pool_key,
                evt.timestamp
            )
        })?;
    let acc = accumulators.get_mut(&context.context_name).ok_or_else(|| {
        anyhow!(
            "no accumulator for context {} (amm={}, pool={}, ts={})",
            context.context_name,
            amm_name,
            evt.pool_key,
            evt.timestamp
        )
    })?;

    let mut il_usd = 0.0;
    if amm_name == "equilibra" {
        let il_raw = parse_u128_string(&evt.il_estimate, "recentering.ilEstimate")?;
        let token1_decimals = token_decimals(&context.token1_symbol)?;
        let il_float = il_raw as f64 / 10f64.powi(token1_decimals as i32);
        if is_quote_symbol(&context.token1_symbol) {
            il_usd = il_float;
        } else {
            let oracle_symbol = oracle_symbol_for_pool(&context.pool_key);
            let px = oracle.get_price_at(oracle_symbol, evt.timestamp)?;
            il_usd = il_float * px;
        }
    }

    acc.recentering_timestamps.push(evt.timestamp);
    acc.recentering_estimated_il_usd += il_usd;
    if let Some(ps) = evt.new_price_scale.as_deref() {
        let ps_wad = parse_u128_string(ps, "recentering.newPriceScale")?;
        if ps_wad == 0 {
            return Err(anyhow!("recentering.newPriceScale is zero"));
        }
        // priceScale is token0-per-token1. The anchor chart and the
        // anchor-deviation metric are in USD-per-base, so a
        // base-in-slot-0 layout (quote in slot 1) takes the reciprocal.
        let ps_float = ps_wad as f64 / 1e18;
        let anchor_usd_per_base = if is_quote_symbol(&context.token0_symbol) {
            ps_float
        } else {
            1.0 / ps_float
        };
        acc.anchor_scale_points
            .push((evt.timestamp, anchor_usd_per_base));
    }
    Ok(())
}

fn compute_trade_volume_usd(trade: &ArbTrade, pool_key: &str, oracle_price: f64) -> Result<f64> {
    let amount_in = parse_u128_string(&trade.amount_in, "arbTrade.amountIn")?;
    let token_in_symbol = if trade.direction == "buy" {
        "USDT"
    } else {
        pool_key
    };
    token_amount_to_usd_float(amount_in, token_in_symbol, oracle_price)
}

fn pool_price_from_trade(trade: &ArbTrade, pool_key: &str) -> Option<f64> {
    let probe = parse_u128_string(&trade.probe_price, "arbTrade.probePrice").ok()?;
    if probe > 0 {
        return Some(probe as f64 / 1e18f64);
    }

    let amount_in = parse_u128_string(&trade.amount_in, "arbTrade.amountIn").ok()?;
    let amount_out = parse_u128_string(&trade.amount_out, "arbTrade.amountOut").ok()?;
    // `pool_key` comes from a validated context, so the canonical map always
    // knows it; treat the impossible miss as "no price" (this helper is the
    // best-effort probe-price fallback and already maps bad input to None).
    let base_dec = token_decimals(pool_key).ok()? as i32;
    if trade.direction == "buy" {
        let base_units = amount_out as f64 / 10f64.powi(base_dec);
        let quote_units = amount_in as f64 / 1e6f64;
        if base_units > 0.0 {
            Some(quote_units / base_units)
        } else {
            None
        }
    } else {
        let base_units = amount_in as f64 / 10f64.powi(base_dec);
        let quote_units = amount_out as f64 / 1e6f64;
        if base_units > 0.0 {
            Some(quote_units / base_units)
        } else {
            None
        }
    }
}

fn token_amount_to_usd_float(amount_native: u128, symbol: &str, oracle_price: f64) -> Result<f64> {
    let dec = token_decimals(symbol)? as i32;
    let units = amount_native as f64 / 10f64.powi(dec);
    Ok(if symbol == "USDT" {
        units
    } else {
        units * oracle_price
    })
}

fn compute_usd_value(
    token0_symbol: &str,
    token1_symbol: &str,
    amount0: u128,
    amount1: u128,
    oracle_price: f64,
) -> Result<f64> {
    let d0 = 10f64.powi(token_decimals(token0_symbol)? as i32);
    let d1 = 10f64.powi(token_decimals(token1_symbol)? as i32);
    Ok(if token0_symbol == "USDT" {
        amount0 as f64 / d0 + (amount1 as f64 / d1) * oracle_price
    } else {
        (amount0 as f64 / d0) * oracle_price + amount1 as f64 / d1
    })
}

fn oracle_price_from_series_at(price_series: &[(u64, f64, f64)], ts: u64) -> Option<f64> {
    if price_series.is_empty() {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = price_series.len();
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if price_series[mid].0 <= ts {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let idx = if lo == 0 { 0 } else { lo - 1 };
    let oracle_price = price_series[idx].2;
    if oracle_price.is_finite() && oracle_price > 0.0 {
        Some(oracle_price)
    } else {
        None
    }
}

/// Quote classification is driven by the canonical `QUOTE_SYMBOLS` list —
/// the same list exported to the dashboard via `metrics.json` metadata — so
/// the server-side quote/base series split and the JS labels can never
/// diverge. Any symbol outside `common::token_decimals` already hard-errors
/// long before this predicate runs.
fn is_quote_symbol(symbol: &str) -> bool {
    QUOTE_SYMBOLS.contains(&symbol)
}

fn oracle_symbol_for_pool(pool_key: &str) -> &str {
    if pool_key == "WBTC" {
        "BTC"
    } else {
        "ETH"
    }
}

fn dedupe_oracle_points(points: Vec<OraclePoint>) -> Vec<OraclePoint> {
    let mut map = BTreeMap::<u64, f64>::new();
    for p in points {
        map.insert(p.t, p.p);
    }
    map.into_iter().map(|(t, p)| OraclePoint { t, p }).collect()
}

fn decimate_series_to_points(
    timestamps: &[u64],
    values: &[f64],
    max_points: usize,
) -> Vec<ChartPoint> {
    let len = timestamps.len().min(values.len());
    let mut points = Vec::with_capacity(len);
    for i in 0..len {
        let x = timestamps[i] as i64 * 1000i64;
        let y = values[i];
        if y.is_finite() {
            points.push(ChartPoint { x, y });
        }
    }
    lttb_decimate_points(&points, max_points)
}

fn compute_ema(points: &[ChartPoint], period: u32) -> Vec<ChartPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    if period == 0 {
        return points.to_vec();
    }
    let alpha = 2.0f64 / (period as f64 + 1.0);
    let mut out = Vec::with_capacity(points.len());
    let mut ema = points[0].y;
    for (idx, p) in points.iter().enumerate() {
        if idx == 0 {
            ema = p.y;
        } else {
            ema = alpha * p.y + (1.0 - alpha) * ema;
        }
        out.push(ChartPoint { x: p.x, y: ema });
    }
    out
}

fn lttb_decimate_points(points: &[ChartPoint], threshold: usize) -> Vec<ChartPoint> {
    if points.len() <= threshold || threshold < 3 {
        return points.to_vec();
    }
    let mut sampled = Vec::with_capacity(threshold);
    let bucket_size = (points.len() - 2) as f64 / (threshold - 2) as f64;
    sampled.push(points[0]);
    let mut a = 0usize;

    for i in 0..(threshold - 2) {
        let bucket_start = ((i + 1) as f64 * bucket_size).floor() as usize + 1;
        let bucket_end =
            (((i + 2) as f64 * bucket_size).floor() as usize + 1).min(points.len() - 1);

        let next_start = (((i + 2) as f64 * bucket_size).floor() as usize + 1).min(points.len());
        let next_end = (((i + 3) as f64 * bucket_size).floor() as usize + 1).min(points.len());

        let (avg_x, avg_y) = if next_end > next_start {
            let mut sx = 0f64;
            let mut sy = 0f64;
            for p in &points[next_start..next_end] {
                sx += p.x as f64;
                sy += p.y;
            }
            let n = (next_end - next_start) as f64;
            (sx / n, sy / n)
        } else {
            let last = points[points.len() - 1];
            (last.x as f64, last.y)
        };

        let point_a = points[a];
        let mut max_area = -1f64;
        let mut max_idx = bucket_start.min(points.len() - 1);

        for (j, p) in points[bucket_start..bucket_end].iter().enumerate() {
            let px = p.x as f64;
            let py = p.y;
            let area = ((point_a.x as f64 - avg_x) * (py - point_a.y)
                - (point_a.x as f64 - px) * (avg_y - point_a.y))
                .abs()
                * 0.5;
            if area > max_area {
                max_area = area;
                max_idx = bucket_start + j;
            }
        }
        sampled.push(points[max_idx]);
        a = max_idx;
    }

    sampled.push(points[points.len() - 1]);
    sampled
}

fn downsample_recentering_markers(points: &[ChartPoint], max_points: usize) -> Vec<ChartPoint> {
    if points.is_empty() || max_points == 0 {
        return Vec::new();
    }

    let mut sorted = points.to_vec();
    sorted.sort_by_key(|p| p.x);
    if sorted.len() <= max_points {
        return sorted;
    }
    if max_points == 1 {
        return vec![sorted[0]];
    }
    if max_points == 2 {
        return vec![sorted[0], sorted[sorted.len() - 1]];
    }

    let first = sorted[0];
    let last = sorted[sorted.len() - 1];
    let interior = &sorted[1..sorted.len() - 1];
    let interior_target = max_points - 2;
    let bucket_size = interior.len().div_ceil(interior_target);

    let mut out = Vec::with_capacity(max_points);
    out.push(first);

    for chunk in interior.chunks(bucket_size) {
        let n = chunk.len() as i128;
        if n == 0 {
            continue;
        }
        let sum_x: i128 = chunk.iter().map(|p| p.x as i128).sum();
        let sum_y: f64 = chunk.iter().map(|p| p.y).sum();
        let avg_x = ((sum_x + (n / 2)) / n) as i64;
        let avg_y = sum_y / chunk.len() as f64;
        out.push(ChartPoint { x: avg_x, y: avg_y });
    }

    out.push(last);
    out
}

fn map_event_timestamps_to_oracle_points(
    event_timestamps: &[u64],
    oracle_timestamps: &[u64],
    oracle_prices: &[f64],
) -> Vec<ChartPoint> {
    if event_timestamps.is_empty() || oracle_timestamps.is_empty() || oracle_prices.is_empty() {
        return Vec::new();
    }
    let len = oracle_timestamps.len().min(oracle_prices.len());
    let mut points = Vec::new();
    for ts in event_timestamps {
        let mut lo = 0usize;
        let mut hi = len - 1;
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if oracle_timestamps[mid] < *ts {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let mut idx = lo;
        if idx > 0 {
            let prev = (oracle_timestamps[idx - 1] as i128 - *ts as i128).abs();
            let cur = (oracle_timestamps[idx] as i128 - *ts as i128).abs();
            if prev < cur {
                idx -= 1;
            }
        }
        let y = oracle_prices[idx];
        if y.is_finite() {
            points.push(ChartPoint {
                x: oracle_timestamps[idx] as i64 * 1000i64,
                y,
            });
        }
    }
    points
}

fn sync_report_web_template(output_dir: &Path) -> Result<()> {
    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("report-web");
    if !src_root.exists() {
        return Err(anyhow!(
            "missing Rust report web template at {}",
            src_root.display()
        ));
    }
    let dst_root = output_dir.join("web");
    copy_dir_recursive(&src_root, &dst_root, true)?;
    fs::create_dir_all(dst_root.join("data"))?;
    Ok(())
}

fn copy_dir_recursive(src_dir: &Path, dst_dir: &Path, skip_data_dir: bool) -> Result<()> {
    if !src_dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst_dir)?;
    for entry in fs::read_dir(src_dir)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst_dir.join(entry.file_name());
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            if skip_data_dir && entry.file_name() == "data" {
                fs::create_dir_all(&dst_path)?;
                continue;
            }
            copy_dir_recursive(&src_path, &dst_path, skip_data_dir)?;
        } else if metadata.is_file() {
            fs::copy(&src_path, &dst_path).with_context(|| {
                format!(
                    "copy report template {} -> {}",
                    src_path.display(),
                    dst_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn sync_directory_tree(root: &Path) -> Result<()> {
    fn walk(dir: &Path, dirs: &mut Vec<PathBuf>) -> Result<()> {
        dirs.push(dir.to_path_buf());
        for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(anyhow!(
                    "report staging tree contains a symlink: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                walk(&path, dirs)?;
            } else if metadata.is_file() {
                fs::File::open(&path)
                    .and_then(|file| file.sync_all())
                    .with_context(|| format!("sync report file {}", path.display()))?;
            } else {
                return Err(anyhow!(
                    "report staging tree contains a non-regular entry: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let mut dirs = Vec::new();
    walk(root, &mut dirs)?;
    for dir in dirs.into_iter().rev() {
        sync_report_directory(&dir)?;
    }
    Ok(())
}

fn sync_report_directory(dir: &Path) -> Result<()> {
    match fs::File::open(dir).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(err)
            if matches!(err.kind(), ErrorKind::Unsupported | ErrorKind::InvalidInput)
                || (cfg!(windows) && err.kind() == ErrorKind::PermissionDenied) =>
        {
            Ok(())
        }
        Err(err) => Err(err).with_context(|| format!("sync report directory {}", dir.display())),
    }
}

fn publish_report_directory(staging: &Path, output: &Path) -> Result<()> {
    static PUBLISH_SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = parent_dir_or_current(output);
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("report output has a non-UTF8/empty name"))?;
    let backup = parent.join(format!(
        ".{name}.previous-{}-{}",
        std::process::id(),
        PUBLISH_SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    let had_previous = match fs::symlink_metadata(output) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(anyhow!(
                    "existing report output is not a regular directory: {}",
                    output.display()
                ));
            }
            fs::rename(output, &backup).with_context(|| {
                format!(
                    "move previous report {} to {}",
                    output.display(),
                    backup.display()
                )
            })?;
            if let Err(err) = sync_report_directory(parent) {
                let _ = fs::rename(&backup, output);
                let _ = sync_report_directory(parent);
                return Err(err).with_context(|| {
                    "persist move of previous report before publishing replacement"
                });
            }
            true
        }
        Err(err) if err.kind() == ErrorKind::NotFound => false,
        Err(err) => return Err(err).with_context(|| format!("stat report {}", output.display())),
    };

    if let Err(err) = fs::rename(staging, output) {
        if had_previous {
            let _ = fs::rename(&backup, output);
            let _ = sync_report_directory(parent);
        }
        return Err(err).with_context(|| {
            format!(
                "atomically publish report {} from {}",
                output.display(),
                staging.display()
            )
        });
    }
    if let Err(err) = sync_report_directory(parent) {
        // Publication has not been durably committed. Restore the old
        // report when possible and return failure while all raw inputs are
        // still retained by the orchestrator.
        if had_previous {
            let _ = fs::rename(output, staging);
            let _ = fs::rename(&backup, output);
            let _ = sync_report_directory(parent);
        } else {
            let _ = fs::rename(output, staging);
        }
        return Err(err).with_context(|| "persist newly published report directory");
    }
    if had_previous {
        if let Err(err) = fs::remove_dir_all(&backup) {
            // The new output was already renamed and its parent fsynced;
            // backup cleanup is no longer part of correctness. Do not turn
            // a valid durable report into a Failed run.
            eprintln!(
                "[report] published report successfully but could not remove backup {}: {err}",
                backup.display()
            );
        } else if let Err(err) = sync_report_directory(parent) {
            eprintln!(
                "[report] published report successfully; backup cleanup fsync failed for {}: {err}",
                parent.display()
            );
        }
    }
    Ok(())
}

/// Serialize `value` and atomically publish it at `path`.
///
/// Durability + atomicity: the payload is written in full to a unique temp
/// file in the destination directory and flushed to disk via `sync_all`
/// (fsync — `File::write_all` has no userspace buffer, so fsync is the only
/// flush that matters) *before* the atomic `rename`. Readers therefore see
/// either the previous file or the complete new one, never a torn write.
///
/// No post-write re-parse is performed: `serde_json::to_vec` already fails
/// loudly on any serialization error, so the bytes are valid JSON by
/// construction. A re-read would only be served from the page cache — it
/// cannot detect disk-level corruption — while doubling the write-side I/O
/// and adding a full `Value`-tree parse for the large per-pool series and
/// slippage-sample artifacts.
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = parent_dir_or_current(path);
    fs::create_dir_all(parent)?;
    let payload = serde_json::to_vec(value)?;
    let tmp_path = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    {
        let mut file = fs::File::create(&tmp_path)
            .with_context(|| format!("create temp report file {}", tmp_path.display()))?;
        file.write_all(&payload)?;
        file.sync_all()?;
    }
    fs::rename(&tmp_path, path)
        .with_context(|| format!("rename temp report file to {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::{
        TradeSizeBuckets, ACTOR_ALGORITHM_VERSION, RESULT_FORMAT_VERSION,
        SLIPPAGE_HISTOGRAM_BUCKET_COUNT, SLIPPAGE_SWEEP_POLICY_VERSION,
    };

    #[test]
    fn slippage_export_keeps_full_sample_breakdown_and_versions() {
        let metadata = ReportRunMetadata {
            result_format_version: RESULT_FORMAT_VERSION.to_string(),
            report_algorithm_version: REPORT_ALGORITHM_VERSION.to_string(),
            config_hash: "1".repeat(64),
            origin_config_hash: "2".repeat(64),
            execution_fingerprint: "3".repeat(64),
            oracle_digest: "4".repeat(64),
            report_assets_digest: "5".repeat(64),
            result_digest: "8".repeat(64),
            report_generator_sha256: "6".repeat(64),
            report_fingerprint: "7".repeat(64),
            actor_algorithm_version: ACTOR_ALGORITHM_VERSION.to_string(),
            slippage_sweep: SlippageSweepPolicy {
                policy_version: SLIPPAGE_SWEEP_POLICY_VERSION.to_string(),
                min_initial_side_bps: 1,
                max_initial_side_bps: 3_000,
                bucket_edges_bps: build_slippage_bucket_edges_bps(1, 3_000).expect("edges"),
            },
            seed: 42,
            start_timestamp: 100,
            end_timestamp: 200,
            duration_days: 0,
            initial_liquidity_usd: 1_000_000.0,
            gas_price_gwei: 0.05,
            amm_list: vec!["equilibra".to_string()],
            pool_list: vec!["WETH".to_string()],
            generated_at: "test".to_string(),
            fee_config: BTreeMap::new(),
            pool_tokens: BTreeMap::new(),
            pool_tokens_by_amm: BTreeMap::new(),
            quote_symbols: vec!["USDT".to_string()],
        };
        let edges = build_slippage_bucket_edges_bps(1, 3_000).expect("edges");
        let bucket_count = edges.len() - 1;
        let contexts = vec![UserSlippageByContext {
            context_name: "equilibra:WETH".to_string(),
            aggregate: StreamingAggregate {
                count: 1,
                sum: 2.5,
                sum_squares: 6.25,
                min: 2.5,
                max: 2.5,
            },
            histogram: {
                let mut histogram = vec![0; SLIPPAGE_HISTOGRAM_BUCKET_COUNT];
                histogram[50] = 1;
                histogram
            },
            samples: vec![SlippageSample {
                timestamp: 123,
                direction: "buy".to_string(),
                token_in_symbol: "USDT".to_string(),
                token_out_symbol: "WETH".to_string(),
                amount_in: "bigint:100000000".to_string(),
                amount_out: "bigint:33000000000000000".to_string(),
                amount_usd: 100.0,
                trade_size_reserve_in_bps: 12,
                slippage_bps: 2.5,
                slip_vs_spot_bps: 1.5,
                staleness_bps: 1.0,
                reserve0_pre: "bigint:500000000000".to_string(),
                reserve1_pre: "bigint:170000000000000000000".to_string(),
                spot_price_wad_pre: "bigint:3000000000000000000000".to_string(),
                oracle_price_wad: "bigint:3001000000000000000000".to_string(),
                fee_bps: 28,
                d_pre_bps: 7,
            }],
            trade_size_buckets: TradeSizeBuckets {
                bucket_edges_bps: edges,
                sum_slippage_bps: vec![0.0; bucket_count],
                count: vec![0; bucket_count],
            },
        }];

        let unique = format!(
            "equilibra-report-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let dir = std::env::temp_dir().join(unique);
        let path = dir.join("slippage-samples.json");
        write_slippage_samples_export(&path, &contexts, &metadata).expect("write export");
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read export")).expect("parse export");

        assert_eq!(
            value["metadata"]["resultFormatVersion"],
            RESULT_FORMAT_VERSION
        );
        assert_eq!(
            value["metadata"]["slippageSweep"]["maxInitialSideBps"],
            3_000
        );
        let sample = &value["byContext"]["equilibra:WETH"]["samples"][0];
        assert_eq!(sample["reserve0Pre"], "bigint:500000000000");
        assert_eq!(sample["slipVsSpotBps"], 1.5);
        assert_eq!(sample["dPreBps"], 7);

        let _ = fs::remove_dir_all(dir);
    }
}
