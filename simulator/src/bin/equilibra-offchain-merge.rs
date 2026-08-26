use anyhow::{Context, Result};
use clap::Parser;
use equilibra_offchain_simulator::app::orchestrator::resolve_oracle_data_dir;
use equilibra_offchain_simulator::app::provenance::{
    hash_report_assets_dir, load_execution_provenance, verify_binary_artifact, verify_oracle_dir,
};
use equilibra_offchain_simulator::common::{canonical_result_digest, RunResults};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "equilibra-offchain-merge")]
#[command(about = "Merge Rust shard sim_results and generate compact report in one pass")]
struct Cli {
    #[arg(long = "input", required = true)]
    inputs: Vec<PathBuf>,

    #[arg(long)]
    report_output: PathBuf,

    /// Shared oracle candle directory. When omitted, resolved exactly like
    /// the dashboard / main simulator binary. The directory's content
    /// digest must match the execution manifest — the feed is verified,
    /// not copied.
    #[arg(long)]
    oracle_data_dir: Option<PathBuf>,

    /// Shared execution manifest produced before shard launch. Required so
    /// merge/report cannot accept matching caller-provided labels while
    /// reading a different binary or mutable oracle directory.
    #[arg(long)]
    execution_manifest: PathBuf,
}

fn validate_shard_provenance(
    shard: &RunResults,
    provenance: &equilibra_offchain_simulator::app::provenance::ExecutionProvenance,
    path: &std::path::Path,
) -> Result<()> {
    if shard.metadata.execution_fingerprint != provenance.execution_fingerprint
        || shard.metadata.oracle_digest != provenance.material.oracle_snapshot.oracle_digest
        || shard.metadata.origin_config_hash != provenance.material.config_hash
        || shard.metadata.report_assets_digest != provenance.material.report_assets_digest
    {
        anyhow::bail!(
            "shard {} metadata does not match execution manifest",
            path.display()
        );
    }
    if shard.contexts.is_empty() {
        anyhow::bail!("shard {} contains no contexts", path.display());
    }
    for context in &shard.contexts {
        let expected_hash = provenance
            .material
            .partition_config_hashes
            .get(&context.context_name)
            .with_context(|| {
                format!(
                    "shard {} context '{}' is outside execution manifest",
                    path.display(),
                    context.context_name
                )
            })?;
        if expected_hash != &shard.metadata.config_hash {
            anyhow::bail!(
                "shard {} configHash does not match partition '{}': expected {}, got {}",
                path.display(),
                context.context_name,
                expected_hash,
                shard.metadata.config_hash
            );
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let oracle_data_dir = match cli.oracle_data_dir {
        Some(dir) => dir,
        None => resolve_oracle_data_dir()?,
    };
    let provenance = load_execution_provenance(&cli.execution_manifest)?;
    if provenance.material.report_algorithm_version
        != equilibra_offchain_simulator::app::provenance::REPORT_ALGORITHM_VERSION
    {
        anyhow::bail!("execution manifest report algorithm version is incompatible");
    }
    let current_exe = std::env::current_exe().with_context(|| "resolve merge executable")?;
    verify_binary_artifact(&provenance, "merge-report", &current_exe)?;
    verify_oracle_dir(&oracle_data_dir, &provenance.material.oracle_snapshot)?;
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("report-web");
    let assets_digest = hash_report_assets_dir(&assets)?;
    if assets_digest != provenance.material.report_assets_digest {
        anyhow::bail!(
            "report-web assets do not match execution manifest: expected {}, got {}",
            provenance.material.report_assets_digest,
            assets_digest
        );
    }
    println!(
        "[RustMerge] start: shards={} reportOutput={} oracle={}",
        cli.inputs.len(),
        cli.report_output.display(),
        oracle_data_dir.display()
    );

    let mut shards = Vec::<RunResults>::with_capacity(cli.inputs.len());
    for path in &cli.inputs {
        let raw =
            fs::read_to_string(path).with_context(|| format!("read shard {}", path.display()))?;
        let parsed: RunResults = serde_json::from_str(&raw)
            .with_context(|| format!("parse shard {}", path.display()))?;
        validate_shard_provenance(&parsed, &provenance, path)?;
        shards.push(parsed);
    }

    let mut merged = equilibra_offchain_simulator::merge::merge_run_results(shards)?;
    if merged.metadata.execution_fingerprint != provenance.execution_fingerprint
        || merged.metadata.oracle_digest != provenance.material.oracle_snapshot.oracle_digest
        || merged.metadata.origin_config_hash != provenance.material.config_hash
    {
        anyhow::bail!("merged result metadata does not match the supplied execution manifest");
    }
    let actual_contexts = merged
        .contexts
        .iter()
        .map(|context| context.context_name.clone())
        .collect::<BTreeSet<_>>();
    let expected_contexts = provenance
        .material
        .partition_config_hashes
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    if actual_contexts != expected_contexts {
        anyhow::bail!(
            "merged context set does not match execution manifest partitions: expected {:?}, got {:?}",
            expected_contexts,
            actual_contexts
        );
    }
    // The merged result is fingerprinted by the canonical content digest
    // (sorted maps, compact stream, volatile generatedAt excluded) and is
    // NOT retained on disk — a full run's raw result exceeds a gigabyte,
    // and the durable report bundle (which records this digest in its
    // completion marker) is the kept artifact. The standalone report path
    // computes the exact same digest from its parsed copy, so the two
    // paths agree on what `resultDigest` means.
    let result_digest = canonical_result_digest(&mut merged)?;
    equilibra_offchain_simulator::report::generate_report_from_run_results(
        merged,
        &cli.report_output,
        &oracle_data_dir,
        &result_digest,
    )
    .with_context(|| "generate compact report from merged shards")?;

    println!("[RustMerge] done: {}", cli.report_output.display());
    Ok(())
}
