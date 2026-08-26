//! Canonical JSON exporter for the `BenchmarkRunConfig` defaults.
//!
//! TypeScript tests (`simulator/test_helpers/config.ts`) shell out to
//! this binary on first import to pull the production preset library
//! straight from `simulator/src/app/config.rs::build_default_config`.
//! That keeps `simulator/src/app/config.rs` as **the** source of truth
//! for `(aWad, lambdaWad)` and every other tunable — no parallel
//! hard-coded preset list on the TS side.

use anyhow::Result;
use clap::Parser;
use equilibra_offchain_simulator::app::config::{
    build_default_config, reference_test_price_wad, BenchmarkRunConfig, SUPPORTED_BASES,
};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Parser, Debug)]
#[command(name = "equilibra-offchain-config-defaults")]
#[command(about = "Print Rust benchmark default config snapshot as JSON")]
struct Cli {
    #[arg(long, default_value_t = 1)]
    oracle_start_ts: u64,
    #[arg(long, default_value_t = 2)]
    oracle_end_ts: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DefaultsOut {
    /// The exact production type, serialized without a hand-maintained
    /// projection. Adding a required config field therefore updates this
    /// exporter automatically instead of silently omitting it from TS tests.
    config: BenchmarkRunConfig,
    test_prices: HashMap<String, String>,
}

fn build_defaults_out(oracle_start_ts: u64, oracle_end_ts: u64) -> Result<DefaultsOut> {
    let config = build_default_config(oracle_start_ts, oracle_end_ts);
    let test_prices = SUPPORTED_BASES
        .iter()
        .map(|base| {
            Ok((
                (*base).to_string(),
                reference_test_price_wad(base)?.to_string(),
            ))
        })
        .collect::<Result<HashMap<_, _>>>()?;
    Ok(DefaultsOut {
        config,
        test_prices,
    })
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let out = build_defaults_out(cli.oracle_start_ts, cli.oracle_end_ts)?;

    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use equilibra_offchain_simulator::app::config::BENCHMARK_RUN_CONFIG_VERSION;

    #[test]
    fn exporter_contains_the_complete_typed_config() {
        let out = build_defaults_out(11, 22).expect("build defaults export");
        let exported = serde_json::to_value(&out).expect("serialize defaults export");
        let expected =
            serde_json::to_value(build_default_config(11, 22)).expect("serialize canonical config");

        assert_eq!(exported["config"], expected);
        assert_eq!(exported["config"]["version"], BENCHMARK_RUN_CONFIG_VERSION);
        assert_eq!(
            exported["config"]["actors"]["arbitrageur"]["gasUsedEstimates"]["curve"],
            "170329"
        );
        assert_eq!(
            exported["config"]["amms"]["curve"]["presets"]["WETH"]["donationAprBps"],
            344
        );
        assert_eq!(
            exported["config"]["reporting"]["slippageSweep"]["maxInitialSideBps"],
            3_000
        );
        assert_eq!(
            exported["testPrices"]["WETH"],
            (3_260u128 * 10u128.pow(18)).to_string()
        );
    }
}
