use crate::common::{
    validate_run_results_contract, ArbState, PassiveLpState, RecenterGateBasePeriods,
    RecenterGateCounts, RecenterGateStatsExport, RunContext, RunMetadata, RunResults,
    UserSlippageByContext, UserTrade,
};
use anyhow::{anyhow, Result};
use chrono::Utc;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct TradeKey {
    timestamp: u64,
    pool_key: String,
    direction: String,
    amount_usd_bits: u64,
}

pub fn merge_run_results(shards: Vec<RunResults>) -> Result<RunResults> {
    let mut iter = shards.into_iter();
    let mut first = iter
        .next()
        .ok_or_else(|| anyhow!("no shard results provided for merge"))?;
    validate_run_results_contract(&first).map_err(|err| anyhow!("invalid shard 0: {err}"))?;
    let result_format_version = first.result_format_version.clone();

    let mut contexts_by_name: BTreeMap<String, RunContext> = BTreeMap::new();
    let mut passive_by_context: BTreeMap<String, PassiveLpState> = BTreeMap::new();
    let mut arb_by_context: BTreeMap<String, ArbState> = BTreeMap::new();
    let mut trades_by_key: HashMap<TradeKey, UserTrade> = HashMap::new();
    let mut slippage_by_context: BTreeMap<String, UserSlippageByContext> = BTreeMap::new();

    let mut merged_metadata: RunMetadata = first.metadata.clone();
    let mut amm_set: BTreeSet<String> = first.metadata.amm_list.iter().cloned().collect();
    let mut pool_set: BTreeSet<String> = first.metadata.pool_list.iter().cloned().collect();
    // Shards are owned — move the heavyweight payloads (contexts, LP/arb
    // states, trade history, recentering events) into the aggregates
    // instead of deep-cloning them; peak RAM stays at ~one merged copy.
    let mut recentering_events = std::mem::take(&mut first.recentering_events);
    let mut equilibra_recenter_gate_stats_export = RecenterGateStatsExport::default();
    if let Some(first_stats) = &first.equilibra_recenter_gate_stats {
        merge_recenter_gate_stats(&mut equilibra_recenter_gate_stats_export, first_stats);
    }
    let mut curve_rebalance_gate_stats_export = RecenterGateStatsExport::default();
    if let Some(first_stats) = &first.curve_rebalance_gate_stats {
        merge_recenter_gate_stats(&mut curve_rebalance_gate_stats_export, first_stats);
    }

    let mut merged_trade_count = first.user_state.trade_count;

    collect_shard(
        first,
        &mut contexts_by_name,
        &mut passive_by_context,
        &mut arb_by_context,
        &mut trades_by_key,
        &mut slippage_by_context,
    )?;

    for (index, mut shard) in iter.enumerate() {
        validate_run_results_contract(&shard)
            .map_err(|err| anyhow!("invalid shard {}: {err}", index + 1))?;
        validate_metadata_compatibility(&merged_metadata, &shard.metadata)?;
        merged_trade_count = merged_trade_count
            .checked_add(shard.user_state.trade_count)
            .ok_or_else(|| anyhow!("merged user tradeCount overflows u64"))?;

        for amm in &shard.metadata.amm_list {
            amm_set.insert(amm.clone());
        }
        for pool in &shard.metadata.pool_list {
            pool_set.insert(pool.clone());
        }
        for (k, v) in &shard.metadata.fee_config {
            merged_metadata.fee_config.insert(k.clone(), *v);
        }
        for (k, v) in &shard.metadata.pool_tokens {
            merged_metadata.pool_tokens.insert(k.clone(), v.clone());
        }
        for (k, v) in &shard.metadata.pool_tokens_by_amm {
            merged_metadata
                .pool_tokens_by_amm
                .insert(k.clone(), v.clone());
        }

        recentering_events.append(&mut shard.recentering_events);

        if let Some(stats) = &shard.equilibra_recenter_gate_stats {
            merge_recenter_gate_stats(&mut equilibra_recenter_gate_stats_export, stats);
        }
        if let Some(stats) = &shard.curve_rebalance_gate_stats {
            merge_recenter_gate_stats(&mut curve_rebalance_gate_stats_export, stats);
        }

        collect_shard(
            shard,
            &mut contexts_by_name,
            &mut passive_by_context,
            &mut arb_by_context,
            &mut trades_by_key,
            &mut slippage_by_context,
        )?;
    }

    merged_metadata.amm_list = amm_set.into_iter().collect();
    merged_metadata.pool_list = pool_set.into_iter().collect();
    merged_metadata.generated_at = Utc::now().to_rfc3339();
    // The merged result represents the parent run, so it is labelled with
    // the parent's hash. Keeping the first shard's `config_hash` (an
    // effective config with flipped `enabled` flags) would mislabel the
    // report relative to `params.json` / `status.json`.
    merged_metadata.config_hash = merged_metadata.origin_config_hash.clone();

    let mut trade_history: Vec<UserTrade> = trades_by_key.into_values().collect();
    trade_history.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.pool_key.cmp(&b.pool_key))
            .then_with(|| a.direction.cmp(&b.direction))
    });
    for trade in &mut trade_history {
        trade.results.sort_by(|a, b| a.0.cmp(&b.0));
    }

    recentering_events.sort_by(|left, right| {
        (left.timestamp, &left.amm_name, &left.pool_key).cmp(&(
            right.timestamp,
            &right.amm_name,
            &right.pool_key,
        ))
    });

    let equilibra_recenter_gate_stats = if equilibra_recenter_gate_stats_export.by_base.is_empty() {
        None
    } else {
        Some(equilibra_recenter_gate_stats_export)
    };
    let curve_rebalance_gate_stats = if curve_rebalance_gate_stats_export.by_base.is_empty() {
        None
    } else {
        Some(curve_rebalance_gate_stats_export)
    };

    let merged = RunResults {
        result_format_version,
        metadata: merged_metadata,
        contexts: contexts_by_name.into_values().collect(),
        user_state: crate::common::UserState {
            trade_count: merged_trade_count,
            trade_history,
            slippage_by_context: slippage_by_context.into_values().collect(),
        },
        passive_lp_states: passive_by_context.into_values().collect(),
        arb_states: arb_by_context.into_values().collect(),
        recentering_events,
        equilibra_recenter_gate_stats,
        curve_rebalance_gate_stats,
    };
    validate_run_results_contract(&merged)
        .map_err(|err| anyhow!("merged result violates result contract: {err}"))?;
    Ok(merged)
}

/// Reject shards from different scenarios before combining their payloads.
/// AMM/pool lists are intentionally allowed to differ because sharding is
/// performed across those dimensions; run-wide inputs and overlapping map
/// entries must be identical.
///
/// `config_hash` is deliberately NOT compared: the orchestrator shards by
/// flipping the per-AMM `enabled` flags (`clone_config_for_amm`), so each
/// shard hashes a distinct effective config and the hashes legitimately
/// differ across AMM shards. Descent from one parent config is proven by
/// `origin_config_hash` instead — the hash of the pre-shard config that
/// the orchestrator stamps into every shard — which must be present and
/// identical across all shards. `execution_fingerprint` and `oracle_digest`
/// bind that parent config to the actual executables, effective options and
/// immutable feed. Manual shards therefore need a shared execution manifest,
/// not merely a caller-supplied parent label.
fn validate_metadata_compatibility(expected: &RunMetadata, candidate: &RunMetadata) -> Result<()> {
    if expected.origin_config_hash != candidate.origin_config_hash {
        return Err(anyhow!(
            "cannot merge shards from different parent configs: originConfigHash mismatch"
        ));
    }
    if expected.execution_fingerprint != candidate.execution_fingerprint {
        return Err(anyhow!(
            "cannot merge shards from different executions: executionFingerprint mismatch"
        ));
    }
    if expected.oracle_digest != candidate.oracle_digest {
        return Err(anyhow!(
            "cannot merge shards with different immutable oracle snapshots"
        ));
    }
    if expected.report_assets_digest != candidate.report_assets_digest {
        return Err(anyhow!(
            "cannot merge shards with different report asset digests"
        ));
    }
    if expected.seed != candidate.seed
        || expected.start_timestamp != candidate.start_timestamp
        || expected.end_timestamp != candidate.end_timestamp
        || expected.duration_days != candidate.duration_days
        || expected.initial_liquidity_usd.to_bits() != candidate.initial_liquidity_usd.to_bits()
        || expected.gas_price_gwei.to_bits() != candidate.gas_price_gwei.to_bits()
    {
        return Err(anyhow!(
            "cannot merge shards with different run-wide metadata"
        ));
    }
    if expected.actor_algorithm_version != candidate.actor_algorithm_version {
        return Err(anyhow!(
            "cannot merge shards with different actorAlgorithmVersion"
        ));
    }
    if expected.slippage_sweep != candidate.slippage_sweep {
        return Err(anyhow!(
            "cannot merge shards with different slippageSweep policies"
        ));
    }

    for (key, value) in &candidate.fee_config {
        if let Some(expected_value) = expected.fee_config.get(key) {
            if expected_value.to_bits() != value.to_bits() {
                return Err(anyhow!(
                    "cannot merge shards: conflicting feeConfig entry `{key}`"
                ));
            }
        }
    }
    for (key, value) in &candidate.pool_tokens {
        if let Some(expected_value) = expected.pool_tokens.get(key) {
            if expected_value != value {
                return Err(anyhow!(
                    "cannot merge shards: conflicting poolTokens entry `{key}`"
                ));
            }
        }
    }
    for (key, value) in &candidate.pool_tokens_by_amm {
        if let Some(expected_value) = expected.pool_tokens_by_amm.get(key) {
            if expected_value != value {
                return Err(anyhow!(
                    "cannot merge shards: conflicting poolTokensByAmm entry `{key}`"
                ));
            }
        }
    }
    Ok(())
}

/// Merge per-base / per-period recenter-gate counters from one shard into the
/// running aggregate. Missing (base, period) buckets are inserted as-is,
/// existing buckets are accumulated via `RecenterGateCounts::add_assign`.
fn merge_recenter_gate_stats(
    aggregate: &mut RecenterGateStatsExport,
    shard_stats: &RecenterGateStatsExport,
) {
    for (base, shard_periods) in &shard_stats.by_base {
        let dst = aggregate
            .by_base
            .entry(base.clone())
            .or_insert_with(RecenterGateBasePeriods::default);
        dst.overall.add_assign(&shard_periods.overall);
        merge_period_map(&mut dst.monthly, &shard_periods.monthly);
        merge_period_map(&mut dst.quarterly, &shard_periods.quarterly);
    }
}

fn merge_period_map(
    dst: &mut BTreeMap<String, RecenterGateCounts>,
    src: &BTreeMap<String, RecenterGateCounts>,
) {
    for (period, counts) in src {
        dst.entry(period.clone())
            .or_insert_with(RecenterGateCounts::default)
            .add_assign(counts);
    }
}

/// Fold one owned shard into the merge aggregates. Takes the shard by
/// value so contexts / LP / arb states / trades are *moved* into the maps
/// (only the map-key `String`s are cloned).
///
/// A context name may appear in exactly one shard: each context belongs to
/// a single (AMM, base) pair and sharding splits along those dimensions.
/// A repeated name means the same shard was supplied twice — silently
/// overwriting its payload while the trade/gate counters double-add would
/// corrupt the merged report, so the merge fails loudly instead.
fn collect_shard(
    shard: RunResults,
    contexts_by_name: &mut BTreeMap<String, RunContext>,
    passive_by_context: &mut BTreeMap<String, PassiveLpState>,
    arb_by_context: &mut BTreeMap<String, ArbState>,
    trades_by_key: &mut HashMap<TradeKey, UserTrade>,
    slippage_by_context: &mut BTreeMap<String, UserSlippageByContext>,
) -> Result<()> {
    for ctx in shard.contexts {
        let name = ctx.context_name.clone();
        if contexts_by_name.insert(name.clone(), ctx).is_some() {
            return Err(anyhow!(
                "cannot merge shards: duplicate context `{name}` — the same \
                 (AMM, base) shard was supplied more than once"
            ));
        }
    }
    for st in shard.passive_lp_states {
        passive_by_context.insert(st.context_name.clone(), st);
    }
    for st in shard.arb_states {
        arb_by_context.insert(st.context_name.clone(), st);
    }
    for st in shard.user_state.slippage_by_context {
        let name = st.context_name.clone();
        if slippage_by_context.insert(name.clone(), st).is_some() {
            return Err(anyhow!(
                "cannot merge shards: duplicate slippage context `{name}`"
            ));
        }
    }

    for trade in shard.user_state.trade_history {
        let key = TradeKey {
            timestamp: trade.timestamp,
            pool_key: trade.pool_key.clone(),
            direction: trade.direction.clone(),
            amount_usd_bits: trade.amount_usd.to_bits(),
        };
        match trades_by_key.get_mut(&key) {
            Some(existing) => {
                let mut result_map: BTreeMap<String, serde_json::Value> = BTreeMap::new();
                for (ctx, v) in &existing.results {
                    result_map.insert(ctx.clone(), v.clone());
                }
                for (ctx, v) in &trade.results {
                    result_map.insert(ctx.clone(), v.clone());
                }
                existing.results = result_map.into_iter().collect();
            }
            None => {
                trades_by_key.insert(key, trade);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::{
        ArbState, FinalPosition, InitialDeposit, PassiveLpState, PoolTokenConfig,
        SlippageSweepPolicy, StreamingAggregate, TradeSizeBuckets, UserSlippageByContext,
        UserState, ACTOR_ALGORITHM_VERSION, RESULT_FORMAT_VERSION, SLIPPAGE_HISTOGRAM_BUCKET_COUNT,
        SLIPPAGE_SWEEP_POLICY_VERSION,
    };

    /// Metadata exactly as a per-(AMM, base) shard emits it: a qualified
    /// `amm:base` fee key only, the per-base token map, the shard's own
    /// effective `config_hash` and the shared parent `origin_config_hash`.
    fn shard_metadata(amm: &str, base: &str, fee_rate: f64) -> RunMetadata {
        let token_config = PoolTokenConfig {
            token0_symbol: "USDT".to_string(),
            token1_symbol: base.to_string(),
            token0_decimals: 6,
            token1_decimals: if base == "WBTC" { 8 } else { 18 },
        };
        RunMetadata {
            config_hash: "1".repeat(64),
            origin_config_hash: "2".repeat(64),
            execution_fingerprint: "3".repeat(64),
            oracle_digest: "4".repeat(64),
            report_assets_digest: "5".repeat(64),
            actor_algorithm_version: ACTOR_ALGORITHM_VERSION.to_string(),
            slippage_sweep: SlippageSweepPolicy {
                policy_version: SLIPPAGE_SWEEP_POLICY_VERSION.to_string(),
                min_initial_side_bps: 1,
                max_initial_side_bps: 3_000,
                bucket_edges_bps: crate::common::build_slippage_bucket_edges_bps(1, 3_000)
                    .expect("test sweep bounds"),
            },
            seed: 42,
            start_timestamp: 100,
            end_timestamp: 200,
            duration_days: 1,
            initial_liquidity_usd: 1_000_000.0,
            gas_price_gwei: 0.05,
            amm_list: vec![amm.to_string()],
            pool_list: vec![base.to_string()],
            generated_at: "ignored".to_string(),
            fee_config: BTreeMap::from([(format!("{amm}:{base}"), fee_rate)]),
            pool_tokens: BTreeMap::from([(base.to_string(), token_config.clone())]),
            pool_tokens_by_amm: BTreeMap::from([(format!("{amm}:{base}"), token_config)]),
        }
    }

    fn shard_results(amm: &str, base: &str, fee_rate: f64) -> RunResults {
        let context_name = format!("{amm}:{base}");
        let bucket_edges_bps =
            crate::common::build_slippage_bucket_edges_bps(1, 3_000).expect("test sweep bounds");
        let bucket_count = bucket_edges_bps.len() - 1;
        RunResults {
            result_format_version: RESULT_FORMAT_VERSION.to_string(),
            metadata: shard_metadata(amm, base, fee_rate),
            contexts: vec![RunContext {
                context_name: context_name.clone(),
                amm_name: amm.to_string(),
                pool_key: base.to_string(),
                token0_symbol: "USDT".to_string(),
                token1_symbol: base.to_string(),
            }],
            user_state: UserState {
                trade_count: 0,
                trade_history: Vec::new(),
                slippage_by_context: vec![UserSlippageByContext {
                    context_name: context_name.clone(),
                    aggregate: StreamingAggregate {
                        count: 0,
                        sum: 0.0,
                        sum_squares: 0.0,
                        min: 0.0,
                        max: 0.0,
                    },
                    histogram: vec![0; SLIPPAGE_HISTOGRAM_BUCKET_COUNT],
                    samples: Vec::new(),
                    trade_size_buckets: TradeSizeBuckets {
                        bucket_edges_bps,
                        sum_slippage_bps: vec![0.0; bucket_count],
                        count: vec![0; bucket_count],
                    },
                }],
            },
            passive_lp_states: vec![PassiveLpState {
                context_name: context_name.clone(),
                initial_deposit: InitialDeposit {
                    amount0: "0".to_string(),
                    amount1: "0".to_string(),
                    value_usd: 0.0,
                    timestamp: 100,
                },
                final_position: FinalPosition {
                    amount0: "0".to_string(),
                    amount1: "0".to_string(),
                    value_usd: 0.0,
                },
                value_history: Vec::new(),
                composition_history: Vec::new(),
                impermanent_loss_actual: 0.0,
                impermanent_loss_cp: 0.0,
                net_pnl: 0.0,
                donations_usd: 0.0,
                donation_events: 0,
            }],
            arb_states: vec![ArbState {
                context_name,
                trades: Vec::new(),
                trade_count: 0,
                total_profit_usd: 0.0,
                total_gas_cost_usd: 0.0,
                net_profit_usd: 0.0,
            }],
            recentering_events: Vec::new(),
            equilibra_recenter_gate_stats: None,
            curve_rebalance_gate_stats: None,
        }
    }

    /// The production fan-out: three AMMs x two bases with distinct
    /// per-base fees (the bundled preset values). Every default dashboard
    /// run produces exactly this shard set, so it must merge.
    fn default_fanout() -> Vec<RunResults> {
        vec![
            shard_results("equilibra", "WETH", 0.0282),
            shard_results("equilibra", "WBTC", 0.017),
            shard_results("uniswapV2", "WETH", 0.003),
            shard_results("uniswapV2", "WBTC", 0.003),
            shard_results("curve", "WETH", 0.0136),
            shard_results("curve", "WBTC", 0.0146),
        ]
    }

    #[test]
    fn default_shard_fanout_merges() {
        let merged = merge_run_results(default_fanout()).expect("default fan-out must merge");
        assert_eq!(merged.contexts.len(), 6);
        assert_eq!(
            merged.metadata.amm_list,
            vec![
                "curve".to_string(),
                "equilibra".to_string(),
                "uniswapV2".to_string()
            ]
        );
        assert_eq!(
            merged.metadata.pool_list,
            vec!["WBTC".to_string(), "WETH".to_string()]
        );
        // The merged result is labelled with the parent hash, not the
        // first shard's effective (flags-flipped) hash.
        assert_eq!(merged.metadata.config_hash, "2".repeat(64));
        assert_eq!(merged.metadata.fee_config.len(), 6);
        assert_eq!(merged.metadata.fee_config["equilibra:WETH"], 0.0282);
        assert_eq!(merged.metadata.fee_config["equilibra:WBTC"], 0.017);
        assert_eq!(merged.metadata.fee_config["curve:WBTC"], 0.0146);
    }

    #[test]
    fn shard_metadata_must_match_run_wide_inputs() {
        let mut shards = default_fanout();
        shards[1].metadata.seed += 1;
        let err = merge_run_results(shards).expect_err("seed drift must fail");
        assert!(err.to_string().contains("run-wide metadata"));
    }

    #[test]
    fn shards_from_different_parent_runs_rejected() {
        let mut shards = default_fanout();
        shards[3].metadata.origin_config_hash = "9".repeat(64);
        let err = merge_run_results(shards).expect_err("foreign parent must fail");
        assert!(err.to_string().contains("originConfigHash mismatch"));
    }

    #[test]
    fn missing_origin_hash_rejected() {
        let mut shards = default_fanout();
        shards[0].metadata.origin_config_hash.clear();
        let err = merge_run_results(shards).expect_err("missing origin must fail");
        assert!(err.to_string().contains("originConfigHash"));
    }

    #[test]
    fn shards_from_different_execution_or_oracle_are_rejected() {
        let mut execution_drift = default_fanout();
        execution_drift[1].metadata.execution_fingerprint = "8".repeat(64);
        let err = merge_run_results(execution_drift).expect_err("execution drift must fail");
        assert!(err.to_string().contains("executionFingerprint"));

        let mut oracle_drift = default_fanout();
        oracle_drift[1].metadata.oracle_digest = "7".repeat(64);
        let err = merge_run_results(oracle_drift).expect_err("oracle drift must fail");
        assert!(err.to_string().contains("oracle"));
    }

    #[test]
    fn conflicting_qualified_fee_entry_rejected() {
        let mut shards = default_fanout();
        // A contract-valid shard claiming an already-merged context with a
        // DIFFERENT fee. The per-shard result contract passes (its fee map
        // matches its own context set), so the cross-shard metadata check
        // must catch the overlapping qualified key — this is the case the
        // fee-conflict branch guards: it fires before the duplicate-context
        // check, which only an identical-fee duplicate would reach.
        shards.push(shard_results("equilibra", "WETH", 0.05));
        let err = merge_run_results(shards).expect_err("conflicting fee entry must fail");
        assert!(err.to_string().contains("feeConfig"));
    }

    #[test]
    fn duplicate_shard_rejected() {
        let mut shards = default_fanout();
        shards.push(shard_results("equilibra", "WETH", 0.0282));
        let err = merge_run_results(shards).expect_err("duplicate shard must fail");
        assert!(err.to_string().contains("duplicate context"));
    }

    #[test]
    fn malformed_or_missing_slippage_payload_is_rejected() {
        let mut wrong_len = shard_results("equilibra", "WETH", 0.0282);
        wrong_len.user_state.slippage_by_context[0]
            .trade_size_buckets
            .count
            .pop();
        let err = merge_run_results(vec![wrong_len]).expect_err("wrong length must fail");
        assert!(err.to_string().contains("invalid tradeSizeBuckets lengths"));

        let mut missing = shard_results("equilibra", "WETH", 0.0282);
        missing.user_state.slippage_by_context.clear();
        let err = merge_run_results(vec![missing]).expect_err("missing context must fail");
        assert!(err.to_string().contains("is missing context"));

        let mut duplicate = shard_results("equilibra", "WETH", 0.0282);
        duplicate
            .user_state
            .slippage_by_context
            .push(duplicate.user_state.slippage_by_context[0].clone());
        let err = merge_run_results(vec![duplicate]).expect_err("duplicate context must fail");
        assert!(err.to_string().contains("contains duplicate context"));
    }

    #[test]
    fn result_and_policy_versions_are_fail_closed() {
        let mut wrong_result = shard_results("equilibra", "WETH", 0.0282);
        wrong_result.result_format_version = "legacy-unversioned".to_string();
        let err = merge_run_results(vec![wrong_result]).expect_err("version drift must fail");
        assert!(err.to_string().contains("resultFormatVersion"));

        let mut wrong_policy = shard_results("equilibra", "WETH", 0.0282);
        wrong_policy.metadata.slippage_sweep.policy_version = "slippage-sweep/v0".to_string();
        let err = merge_run_results(vec![wrong_policy]).expect_err("policy drift must fail");
        assert!(err.to_string().contains("policyVersion"));
    }

    #[test]
    fn full_slippage_sample_survives_json_and_merge() {
        let mut shard = shard_results("equilibra", "WETH", 0.0282);
        let state = &mut shard.user_state.slippage_by_context[0];
        state.aggregate.count = 1;
        state.aggregate.sum = 2.5;
        state.aggregate.sum_squares = 6.25;
        state.aggregate.min = 2.5;
        state.aggregate.max = 2.5;
        state.histogram[50] = 1;
        state.trade_size_buckets.count[2] = 1;
        state.trade_size_buckets.sum_slippage_bps[2] = 2.5;
        state.samples.push(crate::common::SlippageSample {
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
        });

        // This is the actual producer/consumer boundary: JSON removes all
        // Rust type identity before the merge parser reconstructs RunResults.
        let json = serde_json::to_string(&shard).expect("serialize shard");
        let decoded: RunResults = serde_json::from_str(&json).expect("parse shard");
        let merged = merge_run_results(vec![decoded]).expect("merge shard");
        let sample = &merged.user_state.slippage_by_context[0].samples[0];
        assert_eq!(sample.timestamp, 123);
        assert_eq!(sample.reserve0_pre, "bigint:500000000000");
        assert_eq!(sample.spot_price_wad_pre, "bigint:3000000000000000000000");
        assert_eq!(sample.slip_vs_spot_bps, 1.5);
        assert_eq!(sample.d_pre_bps, 7);
    }
}
