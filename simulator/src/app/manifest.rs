use crate::app::config::{compute_config_hash, BenchmarkRunConfig, BENCHMARK_RUN_CONFIG_VERSION};
use crate::app::layout::{build_run_paths, RunPaths};
use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const RUN_MANIFEST_VERSION: &str = "run-manifest/v2";

fn unknown_binary_version() -> String {
    "unknown".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tick: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_ticks: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunErrorInfo {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunManifest {
    pub version: String,
    pub run_id: String,
    pub status: RunStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub config_version: String,
    /// SHA-256 over the canonicalized config JSON only. It identifies the
    /// PARAMETERS, not the full scenario. `execution_fingerprint` below is
    /// the reproducibility identity that additionally binds the immutable
    /// oracle bytes, effective window/options, executable hashes and
    /// actor/result/report algorithm versions.
    pub config_hash: String,
    /// Version of the simulator binary that created the run (cargo
    /// package version) — a named scenario-drift source distinct from
    /// the config. Older v1 manifests predate this field.
    #[serde(default = "unknown_binary_version")]
    pub binary_version: String,
    /// SHA-256 content identity of the immutable oracle snapshot stored in
    /// `runs/<id>/inputs/oracle`. Legacy v1 manifests did not have one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oracle_digest: Option<String>,
    /// Identity of the complete effective execution (materialized config,
    /// immutable oracle, effective window/options, executable hashes and
    /// algorithm/schema versions). It is populated after the Rust binaries
    /// have been built and before the first shard is launched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_fingerprint: Option<String>,
    pub run_paths: RunPaths,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RunErrorInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<RunProgress>,
}

impl RunManifest {
    pub fn set_status(&mut self, status: RunStatus) {
        self.status = status;
        let now = Utc::now().to_rfc3339();
        if status == RunStatus::Running && self.started_at.is_none() {
            self.started_at = Some(now.clone());
        }
        if matches!(
            status,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Canceled
        ) && self.finished_at.is_none()
        {
            self.finished_at = Some(now);
        }
    }
}

pub fn create_initial_manifest(
    base_dir: &Path,
    run_id: &str,
    config: &BenchmarkRunConfig,
) -> Result<RunManifest> {
    Ok(RunManifest {
        version: RUN_MANIFEST_VERSION.to_string(),
        run_id: run_id.to_string(),
        status: RunStatus::Queued,
        created_at: Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        config_version: BENCHMARK_RUN_CONFIG_VERSION.to_string(),
        config_hash: compute_config_hash(config)?,
        binary_version: env!("CARGO_PKG_VERSION").to_string(),
        oracle_digest: None,
        execution_fingerprint: None,
        run_paths: build_run_paths(base_dir, run_id),
        error: None,
        progress: None,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub status: RunStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub config_hash: String,
    pub oracle_digest: Option<String>,
    pub execution_fingerprint: Option<String>,
}

impl From<&RunManifest> for RunSummary {
    fn from(value: &RunManifest) -> Self {
        Self {
            run_id: value.run_id.clone(),
            status: value.status,
            created_at: value.created_at.clone(),
            started_at: value.started_at.clone(),
            finished_at: value.finished_at.clone(),
            config_hash: value.config_hash.clone(),
            oracle_digest: value.oracle_digest.clone(),
            execution_fingerprint: value.execution_fingerprint.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_without_binary_version_deserializes_as_unknown() {
        let manifest = RunManifest {
            version: RUN_MANIFEST_VERSION.to_string(),
            run_id: "run_legacy".to_string(),
            status: RunStatus::Completed,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            config_version: BENCHMARK_RUN_CONFIG_VERSION.to_string(),
            config_hash: "legacy-hash".to_string(),
            binary_version: "0.1.0".to_string(),
            oracle_digest: None,
            execution_fingerprint: None,
            run_paths: build_run_paths(Path::new("/tmp/legacy"), "run_legacy"),
            error: None,
            progress: None,
        };
        let mut value = serde_json::to_value(manifest).expect("serialize manifest");
        value
            .as_object_mut()
            .expect("manifest JSON object")
            .remove("binaryVersion");

        let decoded: RunManifest =
            serde_json::from_value(value).expect("legacy manifest must deserialize");

        assert_eq!(decoded.binary_version, "unknown");
    }
}
