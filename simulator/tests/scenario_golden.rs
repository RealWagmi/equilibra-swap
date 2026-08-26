use equilibra_offchain_simulator::app::config::{build_default_config, BenchmarkRunConfig};
use equilibra_offchain_simulator::common::{
    canonical_result_digest, validate_run_results_contract, RunResults, ACTOR_ALGORITHM_VERSION,
};
use equilibra_offchain_simulator::merge::merge_run_results;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

// SHA-256 of the canonical semantic trajectory (see
// `semantic_trajectory`) produced by `golden_config()` on the checked-in
// oracle fixture. Every intentional behaviour, default or result-shape
// change shifts it: re-record it together with the behavioural asserts
// below and document the cause in the commit message.
const EXPECTED_SEMANTIC_SHA256: &str =
    "611523751a6a5544adb91b2ec885f359ac59d487ccd65dbb6d7d12f5f3ae33a9";

fn unique_temp_dir() -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "equilibra-scenario-golden-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ))
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("golden-oracle")
}

fn golden_config() -> BenchmarkRunConfig {
    let mut config = build_default_config(1_000, 1_420);
    config.simulation.seed = 42;
    config.simulation.progress_interval_sec = 60;
    config.amms.equilibra.enabled = true;
    config.amms.uniswap_v2.enabled = false;
    config.amms.curve.enabled = false;
    config.parallel.max_workers = 1;
    config
}

fn semantic_trajectory(value: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "resultFormatVersion": value["resultFormatVersion"],
        "actorAlgorithmVersion": value["metadata"]["actorAlgorithmVersion"],
        "slippageSweep": value["metadata"]["slippageSweep"],
        "contexts": value["contexts"],
        "userState": value["userState"],
        "passiveLPStates": value["passiveLPStates"],
        "arbStates": value["arbStates"],
        "recenteringEvents": value["recenteringEvents"],
    })
}

fn run_simulator(
    root: &Path,
    config_path: &Path,
    data_dir: &Path,
    only_base: Option<&str>,
    shared_execution: Option<(&Path, &str)>,
) -> Vec<u8> {
    fs::create_dir_all(root).expect("create simulator output root");
    let output_path = root.join("sim_results.json");
    let mut command = Command::new(env!("CARGO_BIN_EXE_equilibra-offchain-simulator"));
    command
        .arg("--config")
        .arg(config_path)
        .arg("--output")
        .arg(&output_path)
        .arg("--data-dir")
        .arg(data_dir);
    if let Some(base) = only_base {
        command.arg("--only-bases").arg(base);
    }
    if let Some((manifest, origin)) = shared_execution {
        command
            .arg("--execution-manifest")
            .arg(manifest)
            .arg("--origin-config-hash")
            .arg(origin);
    }
    let output = command.output().expect("launch simulator");
    assert!(
        output.status.success(),
        "golden simulator failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    fs::read(output_path).expect("read sim_results")
}

#[test]
fn deterministic_actor_scenario_matches_golden_trajectory() {
    let root = unique_temp_dir();
    fs::create_dir_all(&root).expect("create test run root");
    let config_path = root.join("params.json");
    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&golden_config()).expect("serialize config"),
    )
    .expect("write config");
    let raw = run_simulator(&root, &config_path, &fixture_dir(), None, None);
    let results: RunResults = serde_json::from_slice(&raw).expect("parse sim_results");
    validate_run_results_contract(&results).expect("validate result contract");
    assert_eq!(
        results.metadata.actor_algorithm_version,
        ACTOR_ALGORITHM_VERSION
    );
    assert_eq!(results.contexts.len(), 2);
    assert!(
        results.arb_states.iter().any(|state| state.trade_count > 0),
        "fixture must exercise the arbitrage optimizer"
    );
    assert_eq!(results.user_state.trade_count, 32);
    assert_eq!(results.recentering_events.len(), 16);
    assert!(results
        .user_state
        .slippage_by_context
        .iter()
        .all(|state| state.aggregate.count == 16));

    let weth_arb = results
        .arb_states
        .iter()
        .find(|state| state.context_name == "equilibra:WETH")
        .expect("WETH arb state");
    assert_eq!(weth_arb.trade_count, 7);
    assert_eq!(
        weth_arb.trades.first().expect("first WETH arb").amount_in,
        "bigint:45806656608"
    );
    assert_eq!(
        weth_arb.trades.last().expect("last WETH arb").amount_in,
        "bigint:218283566877"
    );
    let wbtc_arb = results
        .arb_states
        .iter()
        .find(|state| state.context_name == "equilibra:WBTC")
        .expect("WBTC arb state");
    assert_eq!(wbtc_arb.trade_count, 0);

    let weth_lp = results
        .passive_lp_states
        .iter()
        .find(|state| state.context_name == "equilibra:WETH")
        .expect("WETH passive LP state");
    // Base-in-slot-0 layout: amount0 is the WETH leg, amount1 the USDT leg.
    assert_eq!(
        weth_lp.final_position.amount0,
        "bigint:160802361882517624802"
    );
    assert_eq!(weth_lp.final_position.amount1, "bigint:557984478599");
    let wbtc_lp = results
        .passive_lp_states
        .iter()
        .find(|state| state.context_name == "equilibra:WBTC")
        .expect("WBTC passive LP state");
    // Base-in-slot-0 layout: amount0 is the WBTC leg, amount1 the USDT
    // leg — the values are the bit-exact mirror of the quote-first
    // layout (no arb trades fire in this context).
    assert_eq!(wbtc_lp.final_position.amount0, "bigint:833333377");
    assert_eq!(wbtc_lp.final_position.amount1, "bigint:500000049399");

    let parsed_value = serde_json::from_slice(&raw).expect("parse semantic result value");
    let semantic = semantic_trajectory(&parsed_value);
    let digest = Sha256::digest(serde_json::to_vec(&semantic).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(
        digest, EXPECTED_SEMANTIC_SHA256,
        "intentional actor/scenario changes must re-record this digest (cause goes in the commit message)"
    );

    // A second standalone execution must reproduce the exact normalized
    // actor trajectory, not merely kernel quotes.
    let repeat_root = unique_temp_dir();
    fs::create_dir_all(&repeat_root).expect("create repeat root");
    let repeat_config = repeat_root.join("params.json");
    fs::copy(&config_path, &repeat_config).expect("copy repeat config");
    let repeat_raw = run_simulator(&repeat_root, &repeat_config, &fixture_dir(), None, None);
    let repeat_value: serde_json::Value =
        serde_json::from_slice(&repeat_raw).expect("parse repeat result");
    assert_eq!(semantic, semantic_trajectory(&repeat_value));

    // The canonical result digest is the reproducibility contract behind
    // `resultDigest` in the report marker: two executions of the same
    // config must produce the SAME digest even though their `generatedAt`
    // stamps (excluded from hashing) differ.
    let mut first_results: RunResults =
        serde_json::from_slice(&raw).expect("parse first result for digest");
    let mut repeat_results: RunResults =
        serde_json::from_slice(&repeat_raw).expect("parse repeat result for digest");
    assert!(
        !first_results.metadata.generated_at.is_empty(),
        "generatedAt must be populated in the artifact"
    );
    let first_digest = canonical_result_digest(&mut first_results).expect("digest first run");
    assert_eq!(
        first_digest,
        canonical_result_digest(&mut repeat_results).expect("digest repeat run"),
        "canonical result digest must not depend on generatedAt or map iteration order"
    );

    // Replay the same parent scenario as two base shards under the one
    // execution manifest, then require canonical equality with the
    // monolithic run. The oracle is never copied: every shard reads the
    // same shared fixture directory and its content digest must match the
    // manifest.
    let execution_manifest = root.join("inputs").join("execution.json");
    let origin = results.metadata.origin_config_hash.clone();
    let weth_raw = run_simulator(
        &root.join("shard-weth"),
        &config_path,
        &fixture_dir(),
        Some("WETH"),
        Some((&execution_manifest, &origin)),
    );
    let wbtc_raw = run_simulator(
        &root.join("shard-wbtc"),
        &config_path,
        &fixture_dir(),
        Some("WBTC"),
        Some((&execution_manifest, &origin)),
    );
    let mut merged = merge_run_results(vec![
        serde_json::from_slice(&weth_raw).expect("parse WETH shard"),
        serde_json::from_slice(&wbtc_raw).expect("parse WBTC shard"),
    ])
    .expect("merge base shards");
    // Sharded-and-merged content must carry the same canonical digest as
    // the monolithic run — the merge pipeline and the standalone report
    // path share one `resultDigest` definition.
    assert_eq!(
        first_digest,
        canonical_result_digest(&mut merged).expect("digest merged result"),
        "merged result digest must equal the monolithic run's digest"
    );
    let merged_value = serde_json::to_value(merged).expect("serialize merged result");
    assert_eq!(semantic, semantic_trajectory(&merged_value));

    fs::remove_dir_all(root).expect("cleanup golden run");
    fs::remove_dir_all(repeat_root).expect("cleanup repeat run");
}
