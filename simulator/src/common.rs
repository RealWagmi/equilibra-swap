use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Schema identifier for `sim_results.json`.  This is deliberately required:
/// merge/report must never guess how to interpret an unversioned legacy file.
/// v2: per-context slot layouts may differ across AMMs on one base
/// (Equilibra supports base-in-slot-0), so `metadata.poolTokens` is a
/// canonical quote-first LABELING map while `poolTokensByAmm` carries the
/// per-context slot truth.
pub const RESULT_FORMAT_VERSION: &str = "equilibra-run-results/v3";

/// Actor-policy identifier.  Under v2 the configured iteration count is a
/// pure cap; the live interval tolerance is the convergence criterion.
pub const ACTOR_ALGORITHM_VERSION: &str = "arb-golden-search/v2";

/// Versioned meaning of the report-only slippage sweep.  The sweep is
/// independent of the stateful `actors.user` range and is expressed in BPS of
/// the initial one-side pool depth.
pub const SLIPPAGE_SWEEP_POLICY_VERSION: &str = "slippage-sweep/v1";

/// Canonical breakpoints retained from the historical 0.01%..30% chart.
/// `build_slippage_bucket_edges_bps` clips/extends these to the configured
/// sweep envelope, so custom v6 envelopes cannot be mislabeled as 30% data.
pub const CANONICAL_SLIPPAGE_BUCKET_EDGES_BPS: [u64; 10] =
    [1, 5, 10, 50, 100, 500, 1_000, 1_500, 2_000, 3_000];
pub const SLIPPAGE_HISTOGRAM_BUCKET_COUNT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunResults {
    pub result_format_version: String,
    pub metadata: RunMetadata,
    pub contexts: Vec<RunContext>,
    pub user_state: UserState,
    #[serde(rename = "passiveLPStates")]
    pub passive_lp_states: Vec<PassiveLpState>,
    pub arb_states: Vec<ArbState>,
    pub recentering_events: Vec<RecenteringEvent>,
    /// Per-base and per-period recenter-gate statistics for the Equilibra
    /// pool. Kept inside `RunResults` so it round-trips through the shard /
    /// merge / report pipeline without needing extra output files in the
    /// shard directory. The final report writer emits a single human-readable
    /// log next to `metrics.json` instead of spamming the dashboard tail log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equilibra_recenter_gate_stats: Option<RecenterGateStatsExport>,
    /// Per-base and per-period rebalance-gate statistics for the Curve
    /// pool, in the same shape as `equilibra_recenter_gate_stats`. Blocked
    /// reasons are keyed by
    /// `runtime_quoter::curve::CurveRebalanceGateBlocked::as_str()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve_rebalance_gate_stats: Option<RecenterGateStatsExport>,
}

/// Serializable recenter-gate statistics shaped as `base -> { overall,
/// monthly, quarterly }`. Keys stay sorted alphabetically both for stable
/// JSON output and for deterministic merge ordering.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecenterGateStatsExport {
    pub by_base: BTreeMap<String, RecenterGateBasePeriods>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecenterGateBasePeriods {
    pub overall: RecenterGateCounts,
    pub monthly: BTreeMap<String, RecenterGateCounts>,
    pub quarterly: BTreeMap<String, RecenterGateCounts>,
}

/// All recenter/rebalance-gate counters for a single (base, period) bucket.
/// Blocked reasons live in a map keyed by the owning AMM's gate enum
/// (`EquilibraRecenterGateBlocked::as_str()` or
/// `CurveRebalanceGateBlocked::as_str()`), so adding a new gate in
/// `runtime_quoter` does not require touching this file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecenterGateCounts {
    pub checks_total: u64,
    pub recentered: u64,
    /// Subset of `recentered` committed by the donation parachute
    /// (Equilibra only; always 0 for other AMMs).
    #[serde(default)]
    pub recentered_via_parachute: u64,
    pub blocked_counts: BTreeMap<String, u64>,
}

impl RecenterGateCounts {
    pub fn blocked_total(&self) -> u64 {
        self.checks_total.saturating_sub(self.recentered)
    }

    /// Add all counters from `other` into `self` (saturating). Used by the
    /// shard merge step to aggregate identical (base, period) buckets across
    /// shards.
    pub fn add_assign(&mut self, other: &Self) {
        self.checks_total = self.checks_total.saturating_add(other.checks_total);
        self.recentered = self.recentered.saturating_add(other.recentered);
        self.recentered_via_parachute = self
            .recentered_via_parachute
            .saturating_add(other.recentered_via_parachute);
        debug_assert!(
            self.recentered_via_parachute <= self.recentered,
            "viaParachute must never exceed recentered"
        );
        for (gate, count) in &other.blocked_counts {
            let entry = self.blocked_counts.entry(gate.clone()).or_insert(0);
            *entry = entry.saturating_add(*count);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunMetadata {
    /// SHA-256 of this process' fully materialized config. A shard's hash
    /// legitimately differs from the parent because its AMM enabled flags
    /// are narrowed by the orchestrator.
    pub config_hash: String,
    /// Hash of the parent (pre-shard) run config. Every shard of one run
    /// carries the same value, so the merge step can verify all shards
    /// descend from the same parent and publish this hash on the merged
    /// result. `config_hash` above is the hash of the *effective* per-shard
    /// config (AMM `enabled` flags flipped by the orchestrator), which
    /// legitimately differs across shards of one run.
    pub origin_config_hash: String,
    /// SHA-256 of the complete parent execution material (config, immutable
    /// oracle, effective window/flags, executable hashes and schema/algorithm
    /// versions). Every shard of one report must carry the same value.
    pub execution_fingerprint: String,
    /// SHA-256 identity of the immutable run-local oracle descriptor.
    pub oracle_digest: String,
    /// Content digest of the exact static report assets expected to be
    /// copied into the durable report bundle.
    pub report_assets_digest: String,
    /// Required actor-policy provenance.  A result generated with different
    /// trade-selection semantics must not be merged under one report.
    pub actor_algorithm_version: String,
    /// Effective, report-only slippage sampling policy materialized from the
    /// validated run config.  Bucket edges are carried by each bucket payload
    /// and checked against this envelope before merge/report.
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
    // BTreeMap (sorted keys), NOT HashMap: these maps feed
    // `canonical_result_digest`, and HashMap iteration order is
    // randomized per process — the same logical result would hash
    // differently on every run.
    pub fee_config: BTreeMap<String, f64>,
    pub pool_tokens: BTreeMap<String, PoolTokenConfig>,
    pub pool_tokens_by_amm: BTreeMap<String, PoolTokenConfig>,
}

/// THE one definition of `resultDigest`: SHA-256 of the compact serde-JSON
/// stream of the parsed result with the volatile `metadata.generatedAt`
/// blanked for the duration of hashing. Every producer (merge pipeline,
/// standalone report regeneration) must use this function — hashing file
/// bytes is not equivalent (formatting differs) and hashing with
/// `generatedAt` included would give two identical runs different
/// digests. All maps inside `RunResults` are `BTreeMap`, so the stream is
/// canonical and the digest is reproducible from any faithful copy of the
/// result. Takes `&mut` only to swap `generatedAt` out and back — the
/// value is unchanged on return.
pub fn canonical_result_digest(results: &mut RunResults) -> Result<String> {
    use sha2::{Digest, Sha256};
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.update(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let generated_at = std::mem::take(&mut results.metadata.generated_at);
    let mut writer = HashWriter(Sha256::new());
    let streamed = serde_json::to_writer(&mut writer, results)
        .with_context(|| "stream run results into hasher");
    results.metadata.generated_at = generated_at;
    streamed?;
    let digest = writer.0.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(out, "{byte:02x}").expect("write hex digest");
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlippageSweepPolicy {
    pub policy_version: String,
    pub min_initial_side_bps: u64,
    pub max_initial_side_bps: u64,
    /// Materialized presentation/aggregation contract. It is derived from
    /// the two endpoints by `build_slippage_bucket_edges_bps` and validated
    /// on every read, so it is an auditable artifact rather than an
    /// independent source of truth.
    pub bucket_edges_bps: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolTokenConfig {
    pub token0_symbol: String,
    pub token1_symbol: String,
    pub token0_decimals: u8,
    pub token1_decimals: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunContext {
    pub context_name: String,
    pub amm_name: String,
    pub pool_key: String,
    pub token0_symbol: String,
    pub token1_symbol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserState {
    pub trade_count: u64,
    pub trade_history: Vec<UserTrade>,
    pub slippage_by_context: Vec<UserSlippageByContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserTrade {
    pub timestamp: u64,
    pub pool_key: String,
    pub amount_usd: f64,
    pub direction: String,
    pub results: Vec<(String, serde_json::Value)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserSlippageByContext {
    pub context_name: String,
    pub aggregate: StreamingAggregate,
    pub histogram: Vec<u64>,
    pub samples: Vec<SlippageSample>,
    pub trade_size_buckets: TradeSizeBuckets,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingAggregate {
    pub count: u64,
    pub sum: f64,
    pub sum_squares: f64,
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlippageSample {
    pub timestamp: u64,
    pub direction: String,
    pub token_in_symbol: String,
    pub token_out_symbol: String,
    pub amount_in: String,
    pub amount_out: String,
    pub amount_usd: f64,
    pub trade_size_reserve_in_bps: u64,
    pub slippage_bps: f64,
    pub slip_vs_spot_bps: f64,
    pub staleness_bps: f64,
    pub reserve0_pre: String,
    pub reserve1_pre: String,
    pub spot_price_wad_pre: String,
    pub oracle_price_wad: String,
    pub fee_bps: u64,
    pub d_pre_bps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TradeSizeBuckets {
    pub bucket_edges_bps: Vec<u64>,
    pub sum_slippage_bps: Vec<f64>,
    pub count: Vec<u64>,
}

/// Build the exact bucket contract for one effective slippage sweep.
/// Configured endpoints are always present.  Historical breakpoints strictly
/// inside the interval are retained, and a custom maximum above 30% becomes a
/// real final edge instead of being silently folded into the 20%-30% label.
pub fn build_slippage_bucket_edges_bps(min_bps: u64, max_bps: u64) -> Result<Vec<u64>> {
    if min_bps < 1 || min_bps >= max_bps || max_bps > 10_000 {
        return Err(anyhow!(
            "slippage sweep must satisfy 1 <= minInitialSideBps < maxInitialSideBps <= 10000"
        ));
    }

    let mut edges = Vec::with_capacity(CANONICAL_SLIPPAGE_BUCKET_EDGES_BPS.len() + 2);
    edges.push(min_bps);
    edges.extend(
        CANONICAL_SLIPPAGE_BUCKET_EDGES_BPS
            .iter()
            .copied()
            .filter(|edge| *edge > min_bps && *edge < max_bps),
    );
    edges.push(max_bps);
    Ok(edges)
}

/// Validate all invariants needed by both the shard merger and report
/// generator.  Corrupt or version-skewed payloads fail closed instead of
/// producing plausible-looking zero-padded charts.
pub fn validate_run_results_contract(results: &RunResults) -> Result<()> {
    if results.result_format_version != RESULT_FORMAT_VERSION {
        return Err(anyhow!(
            "unsupported resultFormatVersion {:?}; expected {:?}",
            results.result_format_version,
            RESULT_FORMAT_VERSION
        ));
    }
    if results.metadata.slippage_sweep.policy_version != SLIPPAGE_SWEEP_POLICY_VERSION {
        return Err(anyhow!(
            "unsupported slippage sweep policyVersion {:?}; expected {:?}",
            results.metadata.slippage_sweep.policy_version,
            SLIPPAGE_SWEEP_POLICY_VERSION
        ));
    }
    if results.metadata.actor_algorithm_version != ACTOR_ALGORITHM_VERSION {
        return Err(anyhow!(
            "unsupported actorAlgorithmVersion {:?}; expected {:?}",
            results.metadata.actor_algorithm_version,
            ACTOR_ALGORITHM_VERSION
        ));
    }
    for (label, value) in [
        ("metadata.configHash", results.metadata.config_hash.as_str()),
        (
            "metadata.originConfigHash",
            results.metadata.origin_config_hash.as_str(),
        ),
        (
            "metadata.executionFingerprint",
            results.metadata.execution_fingerprint.as_str(),
        ),
        (
            "metadata.oracleDigest",
            results.metadata.oracle_digest.as_str(),
        ),
        (
            "metadata.reportAssetsDigest",
            results.metadata.report_assets_digest.as_str(),
        ),
    ] {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(anyhow!(
                "{label} must be a 64-character hexadecimal SHA-256 digest"
            ));
        }
    }

    let expected_edges = build_slippage_bucket_edges_bps(
        results.metadata.slippage_sweep.min_initial_side_bps,
        results.metadata.slippage_sweep.max_initial_side_bps,
    )?;
    if results.metadata.slippage_sweep.bucket_edges_bps != expected_edges {
        return Err(anyhow!(
            "metadata.slippageSweep.bucketEdgesBps {:?} do not match materialized policy {:?}",
            results.metadata.slippage_sweep.bucket_edges_bps,
            expected_edges
        ));
    }

    let mut contexts = std::collections::BTreeSet::<&str>::new();
    for context in &results.contexts {
        if !contexts.insert(context.context_name.as_str()) {
            return Err(anyhow!(
                "duplicate context `{}` in contexts",
                context.context_name
            ));
        }
    }
    if contexts.is_empty() {
        return Err(anyhow!("results contain no contexts"));
    }

    let expected_amms = results
        .contexts
        .iter()
        .map(|context| context.amm_name.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let metadata_amms = results
        .metadata
        .amm_list
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let expected_pools = results
        .contexts
        .iter()
        .map(|context| context.pool_key.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let metadata_pools = results
        .metadata
        .pool_list
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    if expected_amms != metadata_amms || expected_pools != metadata_pools {
        return Err(anyhow!(
            "metadata AMM/pool lists do not match the exact context set"
        ));
    }
    let fee_keys = results
        .metadata
        .fee_config
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let token_by_amm_keys = results
        .metadata
        .pool_tokens_by_amm
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let pool_token_keys = results
        .metadata
        .pool_tokens
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    if fee_keys != contexts || token_by_amm_keys != contexts || pool_token_keys != expected_pools {
        return Err(anyhow!(
            "metadata fee/token maps do not exactly match result contexts"
        ));
    }
    for context in &results.contexts {
        let qualified = format!("{}:{}", context.amm_name, context.pool_key);
        if context.context_name != qualified {
            return Err(anyhow!(
                "contextName '{}' must equal canonical amm:pool key '{qualified}'",
                context.context_name
            ));
        }
        let expected = PoolTokenConfig {
            token0_symbol: context.token0_symbol.clone(),
            token1_symbol: context.token1_symbol.clone(),
            token0_decimals: token_decimals(&context.token0_symbol)?,
            token1_decimals: token_decimals(&context.token1_symbol)?,
        };
        if results.metadata.pool_tokens_by_amm.get(&qualified) != Some(&expected) {
            return Err(anyhow!(
                "metadata token configuration does not match context '{qualified}'"
            ));
        }
        // `poolTokens` is the canonical quote-first labeling map, NOT a
        // slot map: contexts of different AMMs on one base may carry
        // different slot layouts, so the per-base entry must match the
        // context's pair with the quote (USDT) side listed first.
        let expected_canonical = if expected.token1_symbol == "USDT" {
            PoolTokenConfig {
                token0_symbol: expected.token1_symbol.clone(),
                token1_symbol: expected.token0_symbol.clone(),
                token0_decimals: expected.token1_decimals,
                token1_decimals: expected.token0_decimals,
            }
        } else {
            expected.clone()
        };
        if results.metadata.pool_tokens.get(&context.pool_key) != Some(&expected_canonical) {
            return Err(anyhow!(
                "metadata poolTokens (canonical quote-first) does not match context '{qualified}'"
            ));
        }
    }

    validate_exact_context_ownership(
        "passiveLPStates",
        results
            .passive_lp_states
            .iter()
            .map(|state| state.context_name.as_str()),
        &contexts,
    )?;

    for state in &results.arb_states {
        if state.trade_count != state.trades.len() as u64 {
            return Err(anyhow!(
                "context `{}` arb tradeCount {} does not match trades length {}",
                state.context_name,
                state.trade_count,
                state.trades.len()
            ));
        }
        for trade in &state.trades {
            if trade.context_name != state.context_name {
                return Err(anyhow!(
                    "arb trade context '{}' does not match owning state '{}'",
                    trade.context_name,
                    state.context_name
                ));
            }
            if !matches!(trade.direction.as_str(), "buy" | "sell") {
                return Err(anyhow!(
                    "context '{}' has unsupported arb direction '{}'",
                    state.context_name,
                    trade.direction
                ));
            }
            if !trade.gross_profit_usd.is_finite()
                || !trade.gas_cost_usd.is_finite()
                || !trade.net_profit_usd.is_finite()
                || !trade.fee_paid_usd.is_finite()
            {
                return Err(anyhow!(
                    "context '{}' contains non-finite arb trade metrics",
                    state.context_name
                ));
            }
        }
    }
    validate_exact_context_ownership(
        "arbStates",
        results
            .arb_states
            .iter()
            .map(|state| state.context_name.as_str()),
        &contexts,
    )?;
    validate_exact_context_ownership(
        "userState.slippageByContext",
        results
            .user_state
            .slippage_by_context
            .iter()
            .map(|state| state.context_name.as_str()),
        &contexts,
    )?;

    for state in &results.user_state.slippage_by_context {
        let buckets = &state.trade_size_buckets;
        if buckets.bucket_edges_bps != expected_edges {
            return Err(anyhow!(
                "context `{}` bucketEdgesBps {:?} do not match effective policy {:?}",
                state.context_name,
                buckets.bucket_edges_bps,
                expected_edges
            ));
        }
        let expected_len = expected_edges.len() - 1;
        if buckets.sum_slippage_bps.len() != expected_len || buckets.count.len() != expected_len {
            return Err(anyhow!(
                "context `{}` has invalid tradeSizeBuckets lengths: edges={}, sums={}, counts={} (expected sums=counts=edges-1={})",
                state.context_name,
                buckets.bucket_edges_bps.len(),
                buckets.sum_slippage_bps.len(),
                buckets.count.len(),
                expected_len
            ));
        }
        if state.histogram.len() != SLIPPAGE_HISTOGRAM_BUCKET_COUNT {
            return Err(anyhow!(
                "context `{}` histogram length is {}, expected {}",
                state.context_name,
                state.histogram.len(),
                SLIPPAGE_HISTOGRAM_BUCKET_COUNT
            ));
        }
        let checked_sum = |label: &str, values: &[u64]| -> Result<u64> {
            values.iter().try_fold(0u64, |sum, value| {
                sum.checked_add(*value).ok_or_else(|| {
                    anyhow!(
                        "context `{}` {label} population overflows u64",
                        state.context_name
                    )
                })
            })
        };
        let bucket_population = checked_sum("bucket", &buckets.count)?;
        let histogram_population = checked_sum("histogram", &state.histogram)?;
        if bucket_population != state.aggregate.count
            || histogram_population != state.aggregate.count
        {
            return Err(anyhow!(
                "context `{}` slippage population mismatch: aggregate={}, buckets={}, histogram={}",
                state.context_name,
                state.aggregate.count,
                bucket_population,
                histogram_population
            ));
        }
        if state.samples.len() as u64 > state.aggregate.count {
            return Err(anyhow!(
                "context `{}` retains {} samples for an aggregate population of {}",
                state.context_name,
                state.samples.len(),
                state.aggregate.count
            ));
        }
    }

    for trade in &results.user_state.trade_history {
        let mut seen = std::collections::BTreeSet::<&str>::new();
        for (context_name, _) in &trade.results {
            if !contexts.contains(context_name.as_str()) {
                return Err(anyhow!(
                    "user trade at {} references unknown context `{}`",
                    trade.timestamp,
                    context_name
                ));
            }
            if !seen.insert(context_name.as_str()) {
                return Err(anyhow!(
                    "user trade at {} contains duplicate result for context `{}`",
                    trade.timestamp,
                    context_name
                ));
            }
        }
    }

    Ok(())
}

fn validate_exact_context_ownership<'a>(
    label: &str,
    names: impl Iterator<Item = &'a str>,
    expected: &std::collections::BTreeSet<&str>,
) -> Result<()> {
    let mut seen = std::collections::BTreeSet::<&str>::new();
    for name in names {
        if !expected.contains(name) {
            return Err(anyhow!("{label} references unknown context `{name}`"));
        }
        if !seen.insert(name) {
            return Err(anyhow!("{label} contains duplicate context `{name}`"));
        }
    }
    let missing = expected
        .iter()
        .filter(|name| !seen.contains(**name))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(anyhow!(
            "{label} is missing context(s): {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassiveLpState {
    pub context_name: String,
    pub initial_deposit: InitialDeposit,
    pub final_position: FinalPosition,
    pub value_history: Vec<ValueSnap>,
    pub composition_history: Vec<CompositionSnap>,
    pub impermanent_loss_actual: f64,
    #[serde(rename = "impermanentLossCP")]
    pub impermanent_loss_cp: f64,
    /// Reported NET of `donations_usd` — exogenous subsidy is not pool
    /// performance.
    pub net_pnl: f64,
    /// Total exogenous subsidy donated into this context over the run
    /// (USD) and the number of donation events.
    pub donations_usd: f64,
    pub donation_events: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialDeposit {
    pub amount0: String,
    pub amount1: String,
    pub value_usd: f64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalPosition {
    pub amount0: String,
    pub amount1: String,
    pub value_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValueSnap {
    pub timestamp: u64,
    pub value_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompositionSnap {
    pub timestamp: u64,
    pub amount0: String,
    pub amount1: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArbState {
    pub context_name: String,
    pub trades: Vec<ArbTrade>,
    pub trade_count: u64,
    pub total_profit_usd: f64,
    pub total_gas_cost_usd: f64,
    pub net_profit_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArbTrade {
    pub timestamp: u64,
    pub context_name: String,
    pub direction: String,
    pub amount_in: String,
    pub amount_out: String,
    pub gross_profit_usd: f64,
    pub gas_cost_usd: f64,
    pub net_profit_usd: f64,
    pub actual_fee_bps: u64,
    pub fee_paid_usd: f64,
    pub price_deviation: i64,
    pub probe_price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecenteringEvent {
    pub timestamp: u64,
    pub pool_key: String,
    pub il_estimate: String,
    /// Required: the producer (simulator `RecenteringEventOut`) always
    /// stamps the owning AMM name. A results file missing this tag is
    /// corrupted input — serde fails loudly at parse time instead of the
    /// report silently mis-attributing the event to a default AMM.
    pub amm_name: String,
    /// Genuinely optional: only emitted for rebalance events that carry a
    /// price-scale move (`skip_serializing_if` in the producer).
    #[serde(default)]
    pub old_price_scale: Option<String>,
    #[serde(default)]
    pub new_price_scale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleData {
    pub points: Vec<OraclePoint>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OraclePoint {
    pub t: u64,
    pub p: f64,
}

/// Canonical token-symbol → decimals map, shared by every binary in the
/// simulator workspace (single source of truth; do not duplicate this table).
///
/// Hard-errors on unknown symbols instead of silently assuming 18 decimals:
/// a wrong decimals guess corrupts every USD/token conversion (LP positions,
/// composition history, IL estimates) by orders of magnitude, so an unknown
/// symbol must fail the run loudly at the point of use.
pub fn token_decimals(symbol: &str) -> Result<u8> {
    match symbol {
        "USDT" => Ok(6),
        "WBTC" => Ok(8),
        "WETH" => Ok(18),
        other => Err(anyhow!(
            "unknown token symbol '{other}': no entry in common::token_decimals — \
             add the symbol to the canonical map instead of assuming a default"
        )),
    }
}

pub fn parse_u128_string(value: &str, field: &str) -> Result<u128> {
    let trimmed = value.trim();
    let normalized = trimmed
        .strip_prefix("bigint:")
        .or_else(|| trimmed.strip_prefix("BigInt:"))
        .unwrap_or(trimmed);
    normalized
        .parse::<u128>()
        .with_context(|| format!("parse {field} as u128"))
}

pub fn as_u128_from_json(v: &serde_json::Value, field: &str) -> Result<u128> {
    let raw = v
        .as_str()
        .ok_or_else(|| anyhow!("missing string field '{field}'"))?;
    parse_u128_string(raw, field)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slippage_bucket_edges_materialize_custom_envelope() {
        assert_eq!(
            build_slippage_bucket_edges_bps(1, 3_000).expect("default envelope"),
            CANONICAL_SLIPPAGE_BUCKET_EDGES_BPS
        );
        assert_eq!(
            build_slippage_bucket_edges_bps(7, 8_000).expect("custom envelope"),
            vec![7, 10, 50, 100, 500, 1_000, 1_500, 2_000, 3_000, 8_000]
        );
        assert!(build_slippage_bucket_edges_bps(0, 100).is_err());
        assert!(build_slippage_bucket_edges_bps(100, 100).is_err());
        assert!(build_slippage_bucket_edges_bps(100, 10_001).is_err());
    }

    #[test]
    fn full_slippage_sample_round_trips_and_rejects_unknown_fields() {
        let sample = SlippageSample {
            timestamp: 1_650_000_000,
            direction: "buy".to_string(),
            token_in_symbol: "USDT".to_string(),
            token_out_symbol: "WETH".to_string(),
            amount_in: "bigint:123000000".to_string(),
            amount_out: "bigint:42000000000000000".to_string(),
            amount_usd: 123.0,
            trade_size_reserve_in_bps: 17,
            slippage_bps: 2.5,
            slip_vs_spot_bps: 1.25,
            staleness_bps: 1.25,
            reserve0_pre: "bigint:500000000000".to_string(),
            reserve1_pre: "bigint:170000000000000000000".to_string(),
            spot_price_wad_pre: "bigint:3000000000000000000000".to_string(),
            oracle_price_wad: "bigint:3001000000000000000000".to_string(),
            fee_bps: 30,
            d_pre_bps: 9,
        };

        let value = serde_json::to_value(&sample).expect("serialize full sample");
        let decoded: SlippageSample =
            serde_json::from_value(value.clone()).expect("deserialize full sample");
        assert_eq!(decoded.timestamp, sample.timestamp);
        assert_eq!(decoded.amount_in, sample.amount_in);
        assert_eq!(decoded.reserve0_pre, sample.reserve0_pre);
        assert_eq!(decoded.slip_vs_spot_bps, sample.slip_vs_spot_bps);
        assert_eq!(decoded.d_pre_bps, sample.d_pre_bps);

        let mut corrupt = value;
        corrupt
            .as_object_mut()
            .expect("sample object")
            .insert("futureSilentField".to_string(), serde_json::json!(1));
        assert!(serde_json::from_value::<SlippageSample>(corrupt).is_err());
    }

    #[test]
    fn producer_owned_nested_fields_are_required_and_unknown_fields_fail() {
        let missing_history = serde_json::json!({
            "tradeCount": 0,
            "slippageByContext": []
        });
        assert!(serde_json::from_value::<UserState>(missing_history).is_err());

        let missing_trades = serde_json::json!({
            "contextName": "equilibra:WETH",
            "tradeCount": 0,
            "totalProfitUsd": 0.0,
            "totalGasCostUsd": 0.0,
            "netProfitUsd": 0.0
        });
        assert!(serde_json::from_value::<ArbState>(missing_trades).is_err());

        let unknown_nested = serde_json::json!({
            "amount0": "bigint:1",
            "amount1": "bigint:1",
            "valueUsd": 1.0,
            "timestamp": 1,
            "legacyFallback": true
        });
        assert!(serde_json::from_value::<InitialDeposit>(unknown_nested).is_err());
    }
}
