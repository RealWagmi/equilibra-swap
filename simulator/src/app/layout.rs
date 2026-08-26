use chrono::{Datelike, Timelike, Utc};
use rand::random;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const RUNS_ROOT_DIR: &str = "runs";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPaths {
    pub root: String,
    pub params_file: String,
    pub status_file: String,
    pub checkpoints_dir: String,
    pub logs_dir: String,
    pub report_dir: String,
    pub report_web_dir: String,
    pub report_data_dir: String,
    pub sim_results_file: String,
}

fn format_utc_timestamp(now: chrono::DateTime<Utc>) -> String {
    format!(
        "{:04}{:02}{:02}_{:02}{:02}{:02}",
        now.year(),
        now.month(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

pub fn generate_run_id(seed: u64, suffix: Option<&str>) -> String {
    let ts = format_utc_timestamp(Utc::now());
    let rand_hex = format!("{:06x}", random::<u32>() & 0x00ff_ffff);
    let suffix_norm = suffix
        .and_then(|s| {
            let v = s
                .trim()
                .to_ascii_lowercase()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        })
        .map(|s| format!("_{s}"))
        .unwrap_or_default();
    format!("run_{ts}_s{seed}{suffix_norm}_{rand_hex}")
}

pub fn build_run_paths(base_dir: &Path, run_id: &str) -> RunPaths {
    let root = base_dir.join(RUNS_ROOT_DIR).join(run_id);
    let report_dir = root.join("report");
    let report_web_dir = report_dir.join("web");
    let report_data_dir = report_web_dir.join("data");
    RunPaths {
        root: root.display().to_string(),
        params_file: root.join("params.json").display().to_string(),
        status_file: root.join("status.json").display().to_string(),
        checkpoints_dir: root.join("checkpoints").display().to_string(),
        logs_dir: root.join("logs").display().to_string(),
        report_dir: report_dir.display().to_string(),
        report_web_dir: report_web_dir.display().to_string(),
        report_data_dir: report_data_dir.display().to_string(),
        sim_results_file: root.join("sim_results.json").display().to_string(),
    }
}

pub fn root_dir_from_paths(paths: &RunPaths) -> PathBuf {
    PathBuf::from(&paths.root)
}
