use anyhow::{Context, Result};
use clap::Parser;
use equilibra_offchain_simulator::app::orchestrator::resolve_oracle_data_dir;
use equilibra_offchain_simulator::app::provenance::{
    execution_manifest_path, hash_report_assets_dir, load_execution_provenance,
    parent_dir_or_current, verify_oracle_dir,
};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "equilibra-offchain-report")]
#[command(about = "Generate dashboard-compatible compact report from sim_results.json")]
struct Cli {
    #[arg(long)]
    results: PathBuf,

    #[arg(long)]
    output: PathBuf,

    /// Shared oracle candle directory. When omitted, resolved exactly like
    /// the dashboard / main simulator binary. Its content digest must
    /// still match the execution manifest — regeneration fails closed if
    /// the feed's consumed window was rewritten since the run.
    #[arg(long)]
    oracle_data_dir: Option<PathBuf>,

    /// Execution sidecar. Defaults to
    /// `<results-parent>/inputs/execution.json`.
    #[arg(long)]
    execution_manifest: Option<PathBuf>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let run_root = parent_dir_or_current(&cli.results);
    let oracle_data_dir = match cli.oracle_data_dir {
        Some(dir) => dir,
        None => resolve_oracle_data_dir()?,
    };
    let execution_path = cli
        .execution_manifest
        .unwrap_or_else(|| execution_manifest_path(run_root));
    let provenance = load_execution_provenance(&execution_path)?;
    if provenance.material.report_algorithm_version
        != equilibra_offchain_simulator::app::provenance::REPORT_ALGORITHM_VERSION
    {
        anyhow::bail!("execution manifest report algorithm version is incompatible");
    }
    verify_oracle_dir(&oracle_data_dir, &provenance.material.oracle_snapshot)?;
    let assets_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("report-web");
    let assets_digest = hash_report_assets_dir(&assets_dir)?;
    if assets_digest != provenance.material.report_assets_digest {
        anyhow::bail!(
            "report-web assets do not match execution manifest: expected {}, got {}",
            provenance.material.report_assets_digest,
            assets_digest
        );
    }
    println!(
        "[RustReport] start: results={} output={} oracle={}",
        cli.results.display(),
        cli.output.display(),
        oracle_data_dir.display()
    );
    equilibra_offchain_simulator::report::generate_report_from_results(
        &cli.results,
        &cli.output,
        &oracle_data_dir,
        &provenance,
    )
    .with_context(|| "generate Rust compact report failed")?;
    println!("[RustReport] done: {}", cli.output.display());
    Ok(())
}
