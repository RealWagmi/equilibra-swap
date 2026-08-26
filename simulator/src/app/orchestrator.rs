use crate::app::config::{
    compute_config_hash, validate_run_config, BenchmarkRunConfig, SimulationEngine, SUPPORTED_BASES,
};
use crate::app::layout::{build_run_paths, generate_run_id, RUNS_ROOT_DIR};
use crate::app::manifest::{
    create_initial_manifest, RunErrorInfo, RunManifest, RunProgress, RunStatus, RunSummary,
};
use crate::app::provenance::{
    binary_digest, execution_manifest_path, hash_report_assets_dir, inspect_oracle_dir,
    EffectiveExecutionOptions, ExecutionProvenance, ExecutionProvenanceMaterial,
    EXECUTION_PROVENANCE_VERSION, REPORT_ALGORITHM_VERSION,
};
use crate::common::{ACTOR_ALGORITHM_VERSION, RESULT_FORMAT_VERSION};
use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::process::Command;
use tokio::sync::{broadcast, mpsc, Mutex, Semaphore};
use tokio::time::Duration;

const EVENT_CHANNEL_CAPACITY: usize = 2048;
/// Capacity of the child stdout/stderr line channel. Bounded so a chatty
/// or misbehaving simulator process cannot grow the queue (and RAM)
/// without bound: when full, the line pump blocks, the OS pipe fills and
/// the child throttles — the correct fail-loud backpressure. The consumer
/// loop drains until the channel closes and never sends into it, so the
/// bound cannot deadlock.
const LINE_CHANNEL_CAPACITY: usize = 2048;
const BENCHMARK_EVENT_PREFIX: &str = "[BENCHMARK_EVENT]";
const OUTPUT_TAIL_LIMIT: usize = 8000;
/// Minimum spacing between durable status.json writes triggered by aggregate
/// progress. Terminal transitions never use this debounced path. Keeping the
/// interval in wall-clock seconds prevents a fast simulation from turning
/// every logical-day telemetry sample into a file + directory fsync.
const STATUS_PERSIST_DEBOUNCE: Duration = Duration::from_secs(2);
/// Aggregate run progress changes once per shard sample, but the UI does not
/// benefit from receiving the same average hundreds of times per second.
/// Raw shard telemetry remains unthrottled (it feeds the live charts); only
/// the derived run-level aggregate is coalesced.
const AGGREGATE_EVENT_DEBOUNCE: Duration = Duration::from_millis(100);
/// Per-shard recoverable history. When it overflows, every other point is
/// retained (including first/latest), preserving the full time span with
/// progressively coarser older samples instead of keeping only a stale tail.
const TELEMETRY_HISTORY_MAX_POINTS: usize = 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub timestamp: String,
    pub run_id: String,
    pub payload: Value,
}

/// Recoverable, in-memory live telemetry. This deliberately lives outside
/// `RunManifest`: shard samples are ephemeral UI data and must never replace
/// the durable run-level progress scope in status.json.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTelemetrySnapshot {
    pub run_progress: Option<Value>,
    pub shard_progress: HashMap<String, Value>,
    pub shard_history: HashMap<String, Vec<Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunResult {
    pub run_id: String,
    pub manifest: RunManifest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRunResult {
    pub run_id: String,
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearFinishedResult {
    pub removed_run_ids: Vec<String>,
    pub kept_active_run_ids: Vec<String>,
    pub removed_orphan_dirs: Vec<String>,
    /// Finished runs whose directory could not be removed. They stay
    /// listed (and re-clearable) instead of being reported as cleared.
    pub retained_run_ids: Vec<String>,
}

#[derive(Debug)]
struct RunRecord {
    manifest: RunManifest,
    config: Option<BenchmarkRunConfig>,
    sender: broadcast::Sender<RunEvent>,
    cancel_flag: Arc<AtomicBool>,
    /// Set only by an explicit user `cancel_run` on a Running run.
    /// Distinguishes user cancellation (record + run dir are removed by
    /// `execute_run` once every child process has exited) from the
    /// internal shard-failure cancellation that also raises
    /// `cancel_flag`.
    user_cancel: Arc<AtomicBool>,
    /// Debounce state for status.json persistence (progress events only).
    last_status_persist: Option<std::time::Instant>,
    /// Broadcast throttle for the derived aggregate progress event.
    last_aggregate_emit: Option<std::time::Instant>,
    /// Latest aggregate + per-shard payloads used by SSE reconnect/resync.
    telemetry: RunTelemetrySnapshot,
}

impl RunRecord {
    fn new(
        manifest: RunManifest,
        config: Option<BenchmarkRunConfig>,
        sender: broadcast::Sender<RunEvent>,
    ) -> Self {
        Self {
            manifest,
            config,
            sender,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            user_cancel: Arc::new(AtomicBool::new(false)),
            last_status_persist: None,
            last_aggregate_emit: None,
            telemetry: RunTelemetrySnapshot::default(),
        }
    }
}

#[derive(Debug, Default)]
struct InnerState {
    runs: HashMap<String, RunRecord>,
    queue: VecDeque<String>,
    running_count: usize,
}

#[derive(Debug, Clone)]
enum ProcessLine {
    Line { is_stderr: bool, line: String },
    ReadError { is_stderr: bool, message: String },
}

#[derive(Debug, Clone)]
struct CommandOutput {
    success: bool,
    code: Option<i32>,
    signal: Option<i32>,
    stdout_tail: String,
    stderr_tail: String,
}

#[derive(Debug, Clone)]
struct ShardSpec {
    id: String,
    amm: String,
    base: Option<String>,
    params_path: PathBuf,
    results_path: PathBuf,
    /// Hash of the parent (pre-shard) run config. It is forwarded together
    /// with the shared execution manifest; the hash labels the parent
    /// parameters while the manifest binds those parameters to this exact
    /// oracle/options/binary execution.
    origin_config_hash: String,
}

#[derive(Debug)]
struct ShardAggregate {
    phase: String,
    shards: HashMap<String, f64>,
    completed: HashSet<String>,
    failed: HashSet<String>,
    total: usize,
}

impl ShardAggregate {
    fn mark_success(&mut self, shard: &str) {
        self.failed.remove(shard);
        self.completed.insert(shard.to_string());
        self.shards.insert(shard.to_string(), 100.0);
    }

    fn mark_failed(&mut self, shard: &str) {
        if !self.completed.contains(shard) {
            self.failed.insert(shard.to_string());
        }
    }

    fn payload(&self) -> Value {
        let total = self.total.max(1) as f64;
        let avg = self.shards.values().copied().sum::<f64>() / total;
        let mut failed_shards = self.failed.iter().cloned().collect::<Vec<_>>();
        failed_shards.sort();
        json!({
            "phase": self.phase,
            "percent": avg,
            "shards": self.shards,
            "completedShards": self.completed.len(),
            "failedShards": failed_shards,
            "totalShards": self.total,
            "engine": "rust"
        })
    }
}

fn normalize_terminal_progress(manifest: &mut RunManifest) {
    let Some(progress) = manifest.progress.as_mut() else {
        if manifest.status == RunStatus::Completed {
            manifest.progress = Some(RunProgress {
                phase: Some("completed".to_string()),
                current_tick: None,
                total_ticks: None,
                percent: Some(100.0),
                eta_sec: Some(0.0),
                message: Some("Run completed".to_string()),
            });
        }
        return;
    };

    if manifest.status == RunStatus::Completed {
        progress.phase = Some("completed".to_string());
        progress.percent = Some(100.0);
        progress.eta_sec = Some(0.0);
        // Preserve a real total if one exists, but never retain a shard
        // current tick beside terminal run progress.
        progress.current_tick = progress.total_ticks;
    } else {
        // ETA has no meaning after failure/cancellation.
        progress.eta_sec = None;
    }
}

fn push_telemetry_history(history: &mut Vec<Value>, payload: Value) {
    history.push(payload);
    if history.len() > TELEMETRY_HISTORY_MAX_POINTS {
        let compacted = history
            .drain(..)
            .enumerate()
            .filter_map(|(index, point)| (index % 2 == 0).then_some(point))
            .collect();
        *history = compacted;
    }
}

#[derive(Debug, Clone)]
pub struct RunOrchestrator {
    base_dir: Arc<PathBuf>,
    max_concurrent_runs: usize,
    inner: Arc<Mutex<InnerState>>,
    /// Serializes every run-directory removal lifecycle (delete, cancel,
    /// clear incl. its orphan sweep, and the deferred cancel cleanup)
    /// end-to-end: check → remove → possible re-insert happen atomically
    /// with respect to each other. Without it a sweep can observe the
    /// transient record-absence inside another deletion (record pulled,
    /// disk removal fails, record re-inserted) and delete the directory
    /// of a run that is about to be re-listed. Always acquired BEFORE
    /// `inner`, never while holding it.
    removal_gate: Arc<Mutex<()>>,
    trigger_tx: mpsc::UnboundedSender<()>,
}

impl RunOrchestrator {
    pub async fn new(base_dir: PathBuf, max_concurrent_runs: usize) -> Self {
        let (trigger_tx, mut trigger_rx) = mpsc::unbounded_channel::<()>();
        let orchestrator = Self {
            base_dir: Arc::new(base_dir),
            max_concurrent_runs: max_concurrent_runs.max(1),
            inner: Arc::new(Mutex::new(InnerState::default())),
            removal_gate: Arc::new(Mutex::new(())),
            trigger_tx,
        };
        orchestrator.hydrate_runs_from_disk().await;
        let dispatcher = orchestrator.clone();
        tokio::spawn(async move {
            while trigger_rx.recv().await.is_some() {
                dispatcher.start_queued_runs().await;
            }
        });
        orchestrator
    }

    fn request_queue_start(&self) {
        let _ = self.trigger_tx.send(());
    }

    pub async fn list_runs(&self) -> Vec<RunSummary> {
        let inner = self.inner.lock().await;
        let mut out: Vec<RunSummary> = inner
            .runs
            .values()
            .map(|r| RunSummary::from(&r.manifest))
            .collect();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    pub async fn get_run(&self, run_id: &str) -> Option<RunManifest> {
        let inner = self.inner.lock().await;
        inner.runs.get(run_id).map(|r| r.manifest.clone())
    }

    pub async fn subscribe(
        &self,
        run_id: &str,
    ) -> Option<(
        RunManifest,
        RunTelemetrySnapshot,
        broadcast::Receiver<RunEvent>,
    )> {
        let inner = self.inner.lock().await;
        inner.runs.get(run_id).map(|r| {
            (
                r.manifest.clone(),
                r.telemetry.clone(),
                r.sender.subscribe(),
            )
        })
    }

    pub async fn telemetry_snapshot(&self, run_id: &str) -> Option<RunTelemetrySnapshot> {
        let inner = self.inner.lock().await;
        inner.runs.get(run_id).map(|r| r.telemetry.clone())
    }

    pub async fn create_run(&self, input: Value) -> Result<CreateRunResult> {
        let config = validate_run_config(&input)?;
        if config.simulation_engine != SimulationEngine::Rust {
            return Err(anyhow!("Only Rust engine is supported in Rust app"));
        }

        self.prune_completed_run_artifacts_before_new_run().await;

        let run_id = generate_run_id(config.simulation.seed, Some("rust"));
        let mut manifest = create_initial_manifest(self.base_dir.as_path(), &run_id, &config)?;
        let run_paths = manifest.run_paths.clone();
        // Resolve the mutable source before registering the run. An invalid
        // override must not leave a Queued record with no directory.
        let oracle_source = resolve_oracle_data_dir()?;

        // Register the record BEFORE any disk write: the orphan sweep in
        // `clear_finished_runs` protects exactly the runs the live map
        // knows, so a run directory must never exist ahead of its record.
        // The queue push is deferred until the files exist, so the
        // scheduler cannot start the run against a half-written directory.
        //
        // The whole insert → file-writes → queue sequence holds the removal
        // gate, so delete/cancel/clear cannot interleave with a run that is
        // mid-creation (e.g. pull the record while the files are written,
        // fail the disk removal, re-insert it as Canceled — which the queue
        // push below would then enqueue as a ghost). The prune call above
        // takes the same gate internally, so it stays outside this scope.
        let (sender, _) = broadcast::channel::<RunEvent>(EVENT_CHANNEL_CAPACITY);
        let record = RunRecord::new(manifest.clone(), Some(config.clone()), sender);
        let _removal_gate = self.removal_gate.lock().await;
        {
            let mut inner = self.inner.lock().await;
            // A generated id collision would silently replace a live
            // record (leaking its worker slot and sharing its directory);
            // astronomically unlikely, but the check costs one map probe.
            if inner.runs.contains_key(&run_id) {
                return Err(anyhow!("Run id collision: {run_id} already exists — retry"));
            }
            inner.runs.insert(run_id.clone(), record);
        }

        let run_root = PathBuf::from(&run_paths.root);
        let files_written: Result<()> = async {
            ensure_dir(&run_root)?;
            ensure_dir(Path::new(&run_paths.report_dir))?;
            write_json_pretty(Path::new(&run_paths.params_file), &config)?;

            // Digest the shared feed once, before queue publication — no
            // copy is kept. Every later consumer (shards, merge, report)
            // re-digests the same shared directory and fails closed on any
            // drift, so a mutated feed stops the run instead of being
            // consumed silently. Hashing ~100MB of candles is blocking
            // I/O, so keep it off Tokio workers.
            let source = oracle_source.clone();
            let oracle_snapshot =
                tokio::task::spawn_blocking(move || inspect_oracle_dir(source.as_path()))
                    .await
                    .map_err(|err| anyhow!("oracle digest task failed: {err}"))??;

            manifest.oracle_digest = Some(oracle_snapshot.oracle_digest.clone());
            {
                let mut inner = self.inner.lock().await;
                let rec = inner
                    .runs
                    .get_mut(&run_id)
                    .ok_or_else(|| anyhow!("Run disappeared while creating snapshot: {run_id}"))?;
                rec.manifest = manifest.clone();
            }
            write_json_pretty(Path::new(&run_paths.status_file), &manifest)?;
            // The runs root gets a new directory entry for this run;
            // without an fsync of the root itself a power loss can drop
            // the entire just-created run directory.
            fsync_parent_dir(&run_root)?;
            // The runs root itself may also be new (first run after a
            // fresh base dir) — its own directory entry needs the same
            // treatment, one level up.
            if let Some(runs_root) = run_root.parent() {
                fsync_parent_dir(runs_root)?;
            }
            Ok(())
        }
        .await;
        if let Err(err) = files_written {
            {
                let mut inner = self.inner.lock().await;
                inner.runs.remove(&run_id);
            }
            remove_run_dir_guarded(&self.base_dir, &run_id);
            return Err(err);
        }

        {
            // Still under the gate, so the record inserted above cannot
            // have been removed or replaced in between.
            let mut inner = self.inner.lock().await;
            inner.queue.push_back(run_id.clone());
        }

        self.emit_status_from_manifest(&run_id).await;
        self.request_queue_start();

        Ok(CreateRunResult { run_id, manifest })
    }

    pub async fn delete_run(&self, run_id: &str) -> Result<RemoveRunResult> {
        let _removal_gate = self.removal_gate.lock().await;
        let rec = {
            let mut inner = self.inner.lock().await;
            let rec = inner
                .runs
                .get(run_id)
                .ok_or_else(|| anyhow!("Run not found: {run_id}"))?;
            if rec.manifest.status == RunStatus::Running {
                return Err(anyhow!(
                    "Cannot delete running run: {run_id}. Cancel it first."
                ));
            }
            inner.queue.retain(|id| id != run_id);
            inner
                .runs
                .remove(run_id)
                .ok_or_else(|| anyhow!("Run not found: {run_id}"))?
        };
        // Root reconstructed from trusted inputs, never from the manifest.
        let removed = remove_run_dir_guarded(&self.base_dir, run_id);
        if !removed {
            // A directory that refuses to go must keep its run addressable:
            // dropping the record would report success, 404 every retry,
            // and resurrect the run from disk on the next server restart.
            // The record is intentionally not re-queued; a formerly queued
            // run is re-listed as Canceled — it left the queue for good, so
            // a Queued label would show a run that can never start.
            let mut rec = rec;
            if rec.manifest.status == RunStatus::Queued {
                rec.manifest.set_status(RunStatus::Canceled);
            }
            // `remove_dir_all` is not atomic: the failed removal may have
            // unlinked status.json before erring on a later entry. The
            // retained record must stay hydratable across a restart, so
            // its manifest is rewritten unconditionally (best-effort).
            if let Err(err) = write_json_pretty(
                Path::new(&rec.manifest.run_paths.status_file),
                &rec.manifest,
            ) {
                eprintln!(
                    "[orchestrator] run {run_id}: failed to persist retained status.json at {}: {err}",
                    rec.manifest.run_paths.status_file
                );
            }
            let mut inner = self.inner.lock().await;
            inner.runs.insert(run_id.to_string(), rec);
        }
        Ok(RemoveRunResult {
            run_id: run_id.to_string(),
            removed,
        })
    }

    pub async fn cancel_run(&self, run_id: &str) -> Result<RemoveRunResult> {
        let _removal_gate = self.removal_gate.lock().await;
        let removed_rec = {
            let mut inner = self.inner.lock().await;
            let rec = inner
                .runs
                .get(run_id)
                .ok_or_else(|| anyhow!("Run not found: {run_id}"))?;
            let was_running = rec.manifest.status == RunStatus::Running;
            rec.cancel_flag.store(true, Ordering::SeqCst);
            if was_running {
                // A live run owns child processes. Deleting the run tree or
                // freeing the worker slot here would race the up-to-200ms
                // kill heartbeat in `run_simulator_process` — a still-alive
                // shard could recreate files inside the deleted tree, and a
                // queued run could start on a slot whose processes are not
                // dead yet. Mark the cancel and let `execute_run` remove the
                // record, decrement `running_count` and delete the tree only
                // AFTER `run_workflow` has returned (i.e. after every shard
                // child was killed and awaited).
                rec.user_cancel.store(true, Ordering::SeqCst);
            }
            inner.queue.retain(|id| id != run_id);
            if was_running {
                None
            } else {
                // Queued / finished runs own no processes — remove
                // immediately.
                Some(
                    inner
                        .runs
                        .remove(run_id)
                        .ok_or_else(|| anyhow!("Run not found: {run_id}"))?,
                )
            }
        };
        let removed = match removed_rec {
            Some(rec) => {
                let removed = remove_run_dir_guarded(&self.base_dir, run_id);
                if !removed {
                    // Same retryability guarantee as `delete_run`: a
                    // directory that refuses to go keeps its run listed.
                    // Intentionally not re-queued — the user asked for the
                    // run to stop, so a formerly queued record is re-listed
                    // as Canceled rather than as a Queued run that can
                    // never start.
                    let mut rec = rec;
                    if rec.manifest.status == RunStatus::Queued {
                        rec.manifest.set_status(RunStatus::Canceled);
                    }
                    // Unconditional for the same reason as `delete_run`: a
                    // partial `remove_dir_all` may have taken status.json
                    // with it before failing.
                    if let Err(err) = write_json_pretty(
                        Path::new(&rec.manifest.run_paths.status_file),
                        &rec.manifest,
                    ) {
                        eprintln!(
                            "[orchestrator] run {run_id}: failed to persist retained status.json at {}: {err}",
                            rec.manifest.run_paths.status_file
                        );
                    }
                    let mut inner = self.inner.lock().await;
                    inner.runs.insert(run_id.to_string(), rec);
                }
                self.request_queue_start();
                removed
            }
            // A live run defers record and directory removal to
            // `execute_run` after its child processes are dead; the cancel
            // itself is accepted.
            None => true,
        };
        Ok(RemoveRunResult {
            run_id: run_id.to_string(),
            removed,
        })
    }

    pub async fn clear_finished_runs(&self) -> ClearFinishedResult {
        let _removal_gate = self.removal_gate.lock().await;
        let (removed_recs, kept_active_run_ids) = {
            let mut inner = self.inner.lock().await;
            let mut removed = Vec::<(String, RunRecord)>::new();
            let mut kept_active = Vec::<String>::new();
            let keys: Vec<String> = inner.runs.keys().cloned().collect();
            for run_id in keys {
                let status = inner
                    .runs
                    .get(&run_id)
                    .map(|r| r.manifest.status)
                    .unwrap_or(RunStatus::Failed);
                if status == RunStatus::Running || status == RunStatus::Queued {
                    kept_active.push(run_id);
                    continue;
                }
                if let Some(rec) = inner.runs.remove(&run_id) {
                    removed.push((run_id, rec));
                }
            }
            (removed, kept_active)
        };

        let mut removed_run_ids = Vec::<String>::new();
        let mut retained = Vec::<(String, RunRecord)>::new();
        for (id, rec) in removed_recs {
            if remove_run_dir_guarded(&self.base_dir, &id) {
                removed_run_ids.push(id);
            } else {
                retained.push((id, rec));
            }
        }
        let retained_run_ids: Vec<String> = retained.iter().map(|(id, _)| id.clone()).collect();

        let runs_root = self.base_dir.join(RUNS_ROOT_DIR);
        // Re-insert runs whose directory refused to go — they stay listed
        // (and retryable) instead of being reported as cleared. Their
        // manifests are rewritten first: a partial `remove_dir_all` may
        // have unlinked status.json before failing, and a retained record
        // must stay hydratable across a restart.
        for (id, rec) in &retained {
            if let Err(err) = write_json_pretty(
                Path::new(&rec.manifest.run_paths.status_file),
                &rec.manifest,
            ) {
                eprintln!(
                    "[orchestrator] run {id}: failed to persist retained status.json at {}: {err}",
                    rec.manifest.run_paths.status_file
                );
            }
        }
        {
            let mut inner = self.inner.lock().await;
            for (id, rec) in retained {
                inner.runs.insert(id, rec);
            }
        }
        let mut removed_orphan_dirs = Vec::<String>::new();
        if runs_root.exists() && runs_root.is_dir() {
            if let Ok(read_dir) = fs::read_dir(&runs_root) {
                for entry in read_dir.flatten() {
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };
                    if !file_type.is_dir() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with("run_") {
                        continue;
                    }
                    // The live map is consulted immediately before EACH
                    // deletion, never from a snapshot: `create_run`
                    // registers the record before creating its directory,
                    // so a directory whose run the map does not know at
                    // this exact moment is genuinely orphaned — a snapshot
                    // taken before the loop would race a concurrent create.
                    let known = { self.inner.lock().await.runs.contains_key(&name) };
                    if known {
                        continue;
                    }
                    if remove_dir_if_exists(&entry.path()) {
                        removed_orphan_dirs.push(name);
                    }
                }
            }
        }

        ClearFinishedResult {
            removed_run_ids,
            kept_active_run_ids,
            removed_orphan_dirs,
            retained_run_ids,
        }
    }

    async fn hydrate_runs_from_disk(&self) {
        let runs_root = self.base_dir.join(RUNS_ROOT_DIR);
        if !runs_root.exists() || !runs_root.is_dir() {
            return;
        }

        let mut hydrated = Vec::<RunRecord>::new();
        let Ok(entries) = fs::read_dir(&runs_root) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if !ft.is_dir() {
                continue;
            }
            let name = match entry.file_name().into_string() {
                Ok(name) => name,
                Err(_) => {
                    eprintln!(
                        "[orchestrator] hydration: skipping run dir {} — name is not valid UTF-8",
                        entry.path().display()
                    );
                    continue;
                }
            };
            if !is_safe_run_id(&name) {
                eprintln!(
                    "[orchestrator] hydration: skipping run dir {} — unsafe run id",
                    entry.path().display()
                );
                continue;
            }
            let status_file = entry.path().join("status.json");
            if !status_file.exists() || !status_file.is_file() {
                continue;
            }
            let raw = match fs::read_to_string(&status_file) {
                Ok(v) => v,
                Err(err) => {
                    eprintln!(
                        "[orchestrator] hydration: skipping run dir {} — cannot read {}: {err}",
                        entry.path().display(),
                        status_file.display()
                    );
                    continue;
                }
            };
            let mut manifest: RunManifest = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(err) => {
                    eprintln!(
                        "[orchestrator] hydration: skipping run dir {} — corrupted {}: {err}",
                        entry.path().display(),
                        status_file.display()
                    );
                    continue;
                }
            };
            if let Err(err) =
                rebind_hydrated_manifest_paths(self.base_dir.as_path(), &name, &mut manifest)
            {
                eprintln!(
                    "[orchestrator] hydration: skipping run dir {} — {err}",
                    entry.path().display()
                );
                continue;
            }

            if manifest.status == RunStatus::Running {
                let marker_manifest = manifest.clone();
                let report_complete = tokio::task::spawn_blocking(move || {
                    has_valid_report_completion_marker(&marker_manifest)
                })
                .await
                .unwrap_or(false);
                manifest.set_status(if report_complete {
                    RunStatus::Completed
                } else {
                    RunStatus::Failed
                });
                manifest.progress = Some(RunProgress {
                    phase: Some(if report_complete {
                        "recovered:completed".to_string()
                    } else {
                        "recovered:failed".to_string()
                    }),
                    current_tick: manifest.progress.as_ref().and_then(|p| p.current_tick),
                    total_ticks: manifest.progress.as_ref().and_then(|p| p.total_ticks),
                    percent: manifest.progress.as_ref().and_then(|p| p.percent),
                    eta_sec: None,
                    message: Some(if report_complete {
                        "Recovered completed run after app restart".to_string()
                    } else {
                        "Recovered failed run after app restart".to_string()
                    }),
                });
                normalize_terminal_progress(&mut manifest);
                if !report_complete {
                    manifest.error = Some(RunErrorInfo {
                        message: "Benchmark app stopped before compact report was fully written."
                            .to_string(),
                        stack: None,
                    });
                }
                if let Err(err) =
                    write_json_pretty(Path::new(&manifest.run_paths.status_file), &manifest)
                {
                    eprintln!(
                        "[orchestrator] run {}: failed to persist recovered status.json at {}: {err}",
                        manifest.run_id, manifest.run_paths.status_file
                    );
                }
            } else if manifest.status == RunStatus::Queued {
                // The queue lives only in memory and is never resumed
                // across restarts, so a hydrated Queued run can never
                // start — surface it as Canceled instead of a run that
                // waits forever.
                manifest.set_status(RunStatus::Canceled);
                if let Err(err) =
                    write_json_pretty(Path::new(&manifest.run_paths.status_file), &manifest)
                {
                    eprintln!(
                        "[orchestrator] run {}: failed to persist recovered status.json at {}: {err}",
                        manifest.run_id, manifest.run_paths.status_file
                    );
                }
            }

            if manifest.status == RunStatus::Completed {
                self.prune_run_raw_artifacts(&manifest).await;
            }

            let (sender, _) = broadcast::channel::<RunEvent>(EVENT_CHANNEL_CAPACITY);
            hydrated.push(RunRecord::new(manifest, None, sender));
        }

        let mut inner = self.inner.lock().await;
        for rec in hydrated {
            inner.runs.insert(rec.manifest.run_id.clone(), rec);
        }
    }

    async fn start_queued_runs(&self) {
        loop {
            enum StartDecision {
                Start(
                    String,
                    RunManifest,
                    Option<BenchmarkRunConfig>,
                    Arc<AtomicBool>,
                ),
                Break,
                Continue,
            }
            let decision = {
                let mut inner = self.inner.lock().await;
                if inner.running_count >= self.max_concurrent_runs {
                    StartDecision::Break
                } else if let Some(run_id) = inner.queue.pop_front() {
                    if let Some(rec) = inner.runs.get_mut(&run_id) {
                        if rec.manifest.status == RunStatus::Queued {
                            rec.cancel_flag.store(false, Ordering::SeqCst);
                            rec.manifest.set_status(RunStatus::Running);
                            rec.manifest.progress = Some(RunProgress {
                                phase: Some("starting".to_string()),
                                current_tick: None,
                                total_ticks: None,
                                percent: Some(0.0),
                                eta_sec: None,
                                message: Some("Runner process starting".to_string()),
                            });
                            let manifest = rec.manifest.clone();
                            let cfg_opt = rec.config.clone();
                            let cancel_flag = rec.cancel_flag.clone();
                            inner.running_count += 1;
                            StartDecision::Start(run_id, manifest, cfg_opt, cancel_flag)
                        } else {
                            StartDecision::Continue
                        }
                    } else {
                        StartDecision::Continue
                    }
                } else {
                    StartDecision::Break
                }
            };
            let (run_id, manifest, cfg_opt, cancel_flag) = match decision {
                StartDecision::Start(run_id, manifest, cfg_opt, cancel_flag) => {
                    (run_id, manifest, cfg_opt, cancel_flag)
                }
                StartDecision::Break => break,
                StartDecision::Continue => continue,
            };

            let config = if let Some(cfg) = cfg_opt {
                cfg
            } else {
                let cfg_raw = match fs::read_to_string(&manifest.run_paths.params_file) {
                    Ok(v) => v,
                    Err(err) => {
                        self.finalize_failed_to_start(
                            run_id.as_str(),
                            format!("Read params failed: {err}"),
                        )
                        .await;
                        continue;
                    }
                };
                let cfg_val: Value = match serde_json::from_str(&cfg_raw) {
                    Ok(v) => v,
                    Err(err) => {
                        self.finalize_failed_to_start(
                            run_id.as_str(),
                            format!("Parse params failed: {err}"),
                        )
                        .await;
                        continue;
                    }
                };
                match validate_run_config(&cfg_val) {
                    Ok(v) => v,
                    Err(err) => {
                        self.finalize_failed_to_start(
                            run_id.as_str(),
                            format!("Validate params failed: {err}"),
                        )
                        .await;
                        continue;
                    }
                }
            };
            if let Err(err) =
                write_json_pretty(Path::new(&manifest.run_paths.status_file), &manifest)
            {
                eprintln!(
                    "[orchestrator] run {run_id}: failed to persist starting status.json at {}: {err}",
                    manifest.run_paths.status_file
                );
            }
            self.emit_status_from_manifest(&run_id).await;

            let this = self.clone();
            tokio::spawn(async move {
                this.execute_run(run_id, config, cancel_flag).await;
            });
        }
    }

    async fn execute_run(
        &self,
        run_id: String,
        config: BenchmarkRunConfig,
        cancel_flag: Arc<AtomicBool>,
    ) {
        let result = self
            .run_workflow(&run_id, &config, cancel_flag.clone())
            .await;

        // Everything from reading the cancel flag to the deferred deletion
        // runs under the removal gate. `cancel_run` takes the same gate, so
        // the flag cannot change while it is held — one read is final and
        // no late-cancel re-check is needed; deleters cannot observe a
        // half-finalized run; and {commit_terminal_state} writes the
        // on-disk manifest BEFORE the terminal state becomes visible in
        // memory, so a crash in the window rehydrates exactly the status
        // the API would have served.
        let _removal_gate = self.removal_gate.lock().await;
        let mut persisted_manifest: Option<RunManifest> = None;
        let mut pending_error_event: Option<String> = None;
        let mut user_canceled = false;
        {
            let inner = self.inner.lock().await;
            if let Some(rec) = inner.runs.get(&run_id) {
                if rec.manifest.status == RunStatus::Running {
                    user_canceled = rec.user_cancel.load(Ordering::SeqCst);
                    // Status priority: an explicit user cancel wins, then a
                    // workflow error must surface as Failed. The shared
                    // `cancel_flag` is consulted LAST — the shard fan-out
                    // sets it to stop sibling shards when one shard fails,
                    // so the flag alone cannot distinguish a crash from a
                    // cancel and must never mask a real error as Canceled.
                    let final_status = if user_canceled {
                        RunStatus::Canceled
                    } else if result.is_err() {
                        RunStatus::Failed
                    } else if cancel_flag.load(Ordering::SeqCst) {
                        RunStatus::Canceled
                    } else {
                        RunStatus::Completed
                    };
                    let mut manifest = rec.manifest.clone();
                    manifest.set_status(final_status);
                    if final_status == RunStatus::Failed {
                        let msg = result
                            .as_ref()
                            .err()
                            .map(std::string::ToString::to_string)
                            .unwrap_or_else(|| "Unknown error".to_string());
                        manifest.error = Some(RunErrorInfo {
                            message: msg.clone(),
                            stack: None,
                        });
                        pending_error_event = Some(msg);
                    }
                    normalize_terminal_progress(&mut manifest);
                    persisted_manifest = Some(manifest);
                }
            }
        }

        if let Some(manifest) = persisted_manifest {
            self.commit_terminal_state(&run_id, manifest, pending_error_event, user_canceled)
                .await;
        }
        self.request_queue_start();
    }

    /// Shared terminal-commit tail for {execute_run} and
    /// {finalize_failed_to_start}. MUST be called with the removal gate
    /// held: the gate keeps `cancel_run` from flipping the cancel flag
    /// mid-commit and keeps deleters from observing a half-finalized run,
    /// which is what makes the persist → publish → events → prune →
    /// deferred-deletion ordering crash-consistent.
    async fn commit_terminal_state(
        &self,
        run_id: &str,
        manifest: RunManifest,
        pending_error_event: Option<String>,
        user_canceled: bool,
    ) {
        // Persist BEFORE publish: a crash between the two rehydrates
        // exactly the terminal status the API is about to serve.
        // Publishing on a failed write is deliberate — holding the record
        // at Running forever would make the run unmanageable (cancel has
        // already returned and delete rejects Running); hydration resolves
        // a stale Running status.json from the presence of the report
        // metrics.
        if let Err(err) = write_json_pretty(Path::new(&manifest.run_paths.status_file), &manifest) {
            eprintln!(
                "[orchestrator] run {run_id}: failed to persist terminal status.json at {}: {err}",
                manifest.run_paths.status_file
            );
        }
        {
            let mut inner = self.inner.lock().await;
            if let Some(rec) = inner.runs.get_mut(run_id) {
                rec.manifest = manifest.clone();
            }
            inner.running_count = inner.running_count.saturating_sub(1);
        }
        if let Some(msg) = pending_error_event {
            self.emit_error_event(run_id, json!({ "message": msg }))
                .await;
        }
        self.emit_status_from_manifest(run_id).await;
        if manifest.status == RunStatus::Completed {
            // Still under the removal gate: pruning must not walk the tree
            // concurrently with a delete's `remove_dir_all`.
            self.prune_run_raw_artifacts(&manifest).await;
        }
        // Deferred half of a user cancel: the run's child processes are
        // dead by the time a finalizer runs, so the tree can go. The
        // record is dropped only after a successful removal — on failure
        // the run stays listed as Canceled and the deletion can be
        // retried through the API instead of resurrecting on restart.
        if user_canceled {
            if remove_run_dir_guarded(&self.base_dir, run_id) {
                let mut inner = self.inner.lock().await;
                inner.runs.remove(run_id);
            } else {
                // A partial removal may have taken status.json with it;
                // rewrite so the retained record stays hydratable.
                if let Err(err) =
                    write_json_pretty(Path::new(&manifest.run_paths.status_file), &manifest)
                {
                    eprintln!(
                        "[orchestrator] run {run_id}: failed to persist retained status.json at {}: {err}",
                        manifest.run_paths.status_file
                    );
                }
                eprintln!(
                    "[orchestrator] run {run_id}: canceled run tree was not removed; \
                     the run stays listed as Canceled — retry via delete"
                );
            }
        }
    }

    async fn finalize_failed_to_start(&self, run_id: &str, message: String) {
        // Same gate-first ordering as `execute_run`: the cancel flag is
        // read once under the gate (`cancel_run` serializes on it), the
        // terminal manifest is built here and persisted before it becomes
        // visible, and the deferred cancel deletion happens in the same
        // critical section — all via {commit_terminal_state}.
        let _removal_gate = self.removal_gate.lock().await;
        let mut persisted_manifest: Option<RunManifest> = None;
        let mut user_canceled = false;
        {
            let inner = self.inner.lock().await;
            if let Some(rec) = inner.runs.get(run_id) {
                user_canceled = rec.user_cancel.load(Ordering::SeqCst);
                let mut manifest = rec.manifest.clone();
                // A cancel that raced the failed start already answered
                // removed:true and expects the deferred deletion; no
                // `execute_run` exists for this record, so the commit
                // below performs it and the run publishes as Canceled
                // rather than Failed.
                manifest.set_status(if user_canceled {
                    RunStatus::Canceled
                } else {
                    RunStatus::Failed
                });
                manifest.error = Some(RunErrorInfo {
                    message: message.clone(),
                    stack: None,
                });
                normalize_terminal_progress(&mut manifest);
                persisted_manifest = Some(manifest);
            }
        }
        match persisted_manifest {
            Some(manifest) => {
                self.commit_terminal_state(run_id, manifest, Some(message), user_canceled)
                    .await;
            }
            None => {
                {
                    let mut inner = self.inner.lock().await;
                    inner.running_count = inner.running_count.saturating_sub(1);
                }
                self.emit_error_event(run_id, json!({ "message": message }))
                    .await;
                self.emit_status_from_manifest(run_id).await;
            }
        }
    }

    async fn run_workflow(
        &self,
        run_id: &str,
        config: &BenchmarkRunConfig,
        cancel_flag: Arc<AtomicBool>,
    ) -> Result<()> {
        self.prepare_rust_build(run_id).await?;
        let provenance = self.prepare_execution_provenance(run_id, config).await?;
        self.run_parallel_by_context(run_id, config, cancel_flag, &provenance)
            .await
    }

    async fn prepare_execution_provenance(
        &self,
        run_id: &str,
        config: &BenchmarkRunConfig,
    ) -> Result<ExecutionProvenance> {
        let manifest = self
            .get_run(run_id)
            .await
            .ok_or_else(|| anyhow!("Run disappeared: {run_id}"))?;
        let run_root = PathBuf::from(&manifest.run_paths.root);
        let oracle_dir = resolve_oracle_data_dir()?;
        let expected_oracle_digest = manifest.oracle_digest.clone();
        let simulator_bin = resolve_sibling_binary("equilibra-offchain-simulator")?;
        let merge_bin = resolve_sibling_binary("equilibra-offchain-merge")?;
        let config_hash = compute_config_hash(config)?;
        let mut partition_config_hashes = BTreeMap::new();
        for amm in enabled_amms(config) {
            let shard_hash = compute_config_hash(&clone_config_for_amm(config, &amm))?;
            for base in SUPPORTED_BASES {
                partition_config_hashes.insert(format!("{amm}:{base}"), shard_hash.clone());
            }
        }
        let report_assets_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("report-web");
        let options = EffectiveExecutionOptions {
            mode: "orchestrated-by-context".to_string(),
            start_timestamp: config.simulation.start_timestamp,
            end_timestamp: config.simulation.end_timestamp,
            duration_sec: None,
            no_curve: false,
            disable_equilibra_recenter: false,
            disable_curve_rebalance: false,
            arbitrage_enabled: true,
            selected_amms: enabled_amms(config),
            selected_bases: SUPPORTED_BASES
                .iter()
                .map(|base| (*base).to_string())
                .collect(),
        };

        let provenance = tokio::task::spawn_blocking(move || -> Result<ExecutionProvenance> {
            // Re-digest the shared feed at start time and require it to
            // still match the digest taken at run creation: a feed mutated
            // while the run sat in the queue must fail here, not surface
            // as a shard-side mismatch mid-run.
            let oracle_snapshot = inspect_oracle_dir(&oracle_dir)?;
            if let Some(expected) = expected_oracle_digest {
                if oracle_snapshot.oracle_digest != expected {
                    return Err(anyhow!(
                        "oracle feed changed between run creation and start: digest {} != {}",
                        oracle_snapshot.oracle_digest,
                        expected
                    ));
                }
            }
            ExecutionProvenance::new(ExecutionProvenanceMaterial {
                version: EXECUTION_PROVENANCE_VERSION.to_string(),
                config_hash,
                oracle_snapshot,
                effective_options: options,
                partition_config_hashes,
                binaries: vec![
                    binary_digest("simulator", &simulator_bin)?,
                    binary_digest("merge-report", &merge_bin)?,
                ],
                report_assets_digest: hash_report_assets_dir(&report_assets_dir)?,
                actor_algorithm_version: ACTOR_ALGORITHM_VERSION.to_string(),
                result_format_version: RESULT_FORMAT_VERSION.to_string(),
                report_algorithm_version: REPORT_ALGORITHM_VERSION.to_string(),
            })
        })
        .await
        .map_err(|err| anyhow!("execution provenance task failed: {err}"))??;

        let execution_path = execution_manifest_path(&run_root);
        write_json_pretty(&execution_path, &provenance)?;

        // Persist-before-publish: a shard can only start after both the
        // execution manifest and the matching status.json are durable.
        let mut updated_manifest = manifest;
        updated_manifest.oracle_digest =
            Some(provenance.material.oracle_snapshot.oracle_digest.clone());
        updated_manifest.execution_fingerprint = Some(provenance.execution_fingerprint.clone());
        write_json_pretty(
            Path::new(&updated_manifest.run_paths.status_file),
            &updated_manifest,
        )?;
        {
            let mut inner = self.inner.lock().await;
            let rec = inner
                .runs
                .get_mut(run_id)
                .ok_or_else(|| anyhow!("Run disappeared while publishing provenance: {run_id}"))?;
            rec.manifest = updated_manifest;
        }
        self.emit_event(
            run_id,
            "provenance",
            json!({
                "executionFingerprint": provenance.execution_fingerprint,
                "oracleDigest": provenance.material.oracle_snapshot.oracle_digest,
                "actorAlgorithmVersion": provenance.material.actor_algorithm_version,
                "resultFormatVersion": provenance.material.result_format_version,
            }),
        )
        .await;
        self.emit_status_from_manifest(run_id).await;
        Ok(provenance)
    }

    async fn run_parallel_by_context(
        &self,
        run_id: &str,
        config: &BenchmarkRunConfig,
        cancel_flag: Arc<AtomicBool>,
        provenance: &ExecutionProvenance,
    ) -> Result<()> {
        let run_manifest = self
            .get_run(run_id)
            .await
            .ok_or_else(|| anyhow!("Run disappeared: {run_id}"))?;
        let run_paths = run_manifest.run_paths.clone();
        ensure_dir(Path::new(&run_paths.report_dir))?;

        let amms = enabled_amms(config);
        let origin_config_hash = compute_config_hash(config)?;
        let mut shards = Vec::<ShardSpec>::new();
        for amm in amms {
            for base in SUPPORTED_BASES {
                let id = format!("{amm}:{base}");
                let shard_dir = Path::new(&run_paths.root)
                    .join("shards_ctx_rust")
                    .join(format!("{amm}_{base}"));
                ensure_dir(&shard_dir)?;
                let shard_cfg = clone_config_for_amm(config, &amm);
                let params_path = shard_dir.join("params.json");
                let results_path = shard_dir.join("sim_results.json");
                write_json_pretty(&params_path, &shard_cfg)?;
                shards.push(ShardSpec {
                    id,
                    amm: amm.clone(),
                    base: Some(base.to_string()),
                    params_path,
                    results_path,
                    origin_config_hash: origin_config_hash.clone(),
                });
            }
        }

        let max_workers = std::cmp::max(
            1usize,
            std::cmp::min(config.parallel.max_workers as usize, shards.len()),
        );
        if run_manifest.execution_fingerprint.as_deref()
            != Some(provenance.execution_fingerprint.as_str())
        {
            return Err(anyhow!(
                "run manifest execution fingerprint does not match prepared provenance"
            ));
        }
        let run_root = PathBuf::from(&run_paths.root);
        let oracle_data_dir = resolve_oracle_data_dir()?;
        let execution_path = execution_manifest_path(&run_root);

        self.run_sharded(
            run_id,
            "parallel_fast_by_context",
            "parallel_ctx:shard_start",
            "parallel_ctx:merge_report",
            shards.as_slice(),
            max_workers,
            cancel_flag.clone(),
            Path::new(&run_paths.report_dir),
            oracle_data_dir.as_path(),
            execution_path.as_path(),
        )
        .await?;

        self.emit_done_event(run_id, json!({ "status": "ok", "engine": "rust" }))
            .await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_sharded(
        &self,
        run_id: &str,
        aggregate_phase: &str,
        shard_start_phase: &str,
        merge_report_phase: &str,
        shards: &[ShardSpec],
        max_workers: usize,
        cancel_flag: Arc<AtomicBool>,
        report_output_dir: &Path,
        oracle_data_dir: &Path,
        execution_manifest: &Path,
    ) -> Result<()> {
        let semaphore = Arc::new(Semaphore::new(max_workers));
        let aggregate = Arc::new(Mutex::new(ShardAggregate {
            phase: aggregate_phase.to_string(),
            shards: shards.iter().map(|s| (s.id.clone(), 0.0)).collect(),
            completed: HashSet::new(),
            failed: HashSet::new(),
            total: shards.len(),
        }));

        let mut join_set = tokio::task::JoinSet::new();
        for shard in shards {
            let semaphore = semaphore.clone();
            let this = self.clone();
            let run_id_owned = run_id.to_string();
            let shard_owned = shard.clone();
            let aggregate_owned = aggregate.clone();
            let cancel_owned = cancel_flag.clone();
            let start_phase = shard_start_phase.to_string();
            let aggregate_phase_owned = aggregate_phase.to_string();
            let oracle_data_dir_owned = oracle_data_dir.to_path_buf();
            let execution_manifest_owned = execution_manifest.to_path_buf();
            join_set.spawn(async move {
                // The permit is acquired INSIDE the task: the launch loop
                // spawns every shard immediately and the drain below runs
                // from the first completion. Waiting for permits in the
                // launch loop instead can wedge the whole run — with more
                // shards than workers, a failed shard's result sits
                // undrained while the loop waits on a permit that hung
                // shards never release, so the cancel flag is never raised.
                let _permit = match semaphore.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        return (
                            shard_owned.id.clone(),
                            Err(anyhow!("shard semaphore closed unexpectedly")),
                        );
                    }
                };
                if cancel_owned.load(Ordering::SeqCst) {
                    // Best-effort: usually avoids starting a doomed
                    // simulator process after a sibling failed or the user
                    // canceled. A task that wins a permit before the drain
                    // loop stores the flag still starts one — the cancel
                    // heartbeat inside `run_simulator_process` kills it
                    // moments later.
                    return (
                        shard_owned.id.clone(),
                        Err(anyhow!("shard canceled before start")),
                    );
                }
                this.emit_phase_event(
                    &run_id_owned,
                    &start_phase,
                    json!({ "shard": shard_owned.id, "engine": "rust" }),
                )
                .await;
                this.emit_log_event(
                    &run_id_owned,
                    "stdout",
                    format!(
                        "[RustEngine] Starting shard {} params={}",
                        shard_owned.id,
                        shard_owned.params_path.display()
                    ),
                    Some(shard_owned.id.clone()),
                )
                .await;
                let out = this
                    .run_simulator_process(
                        &run_id_owned,
                        shard_owned.params_path.as_path(),
                        shard_owned.results_path.as_path(),
                        Some(shard_owned.amm.as_str()),
                        shard_owned.base.as_deref(),
                        Some(shard_owned.origin_config_hash.as_str()),
                        oracle_data_dir_owned.as_path(),
                        execution_manifest_owned.as_path(),
                        Some(shard_owned.id.as_str()),
                        cancel_owned,
                        Some(aggregate_owned),
                        Some(aggregate_phase_owned.as_str()),
                    )
                    .await;
                (shard_owned.id.clone(), out)
            });
        }

        let mut first_error: Option<anyhow::Error> = None;
        // Completion-order drain: `join_next` yields whichever shard task
        // finishes (or panics) first, so a failure raises the cancel flag
        // immediately instead of waiting behind slower earlier shards. A
        // JoinError (panicked/aborted task) is treated exactly like a
        // shard failure, and the drain always continues to the last handle
        // so no shard task outlives the run's finalization.
        while let Some(joined) = join_set.join_next().await {
            let (shard_id, shard_result) = match joined {
                Ok((shard_id, result)) => (shard_id, result),
                Err(join_err) => (
                    "<join-error>".to_string(),
                    Err(anyhow!("Shard task join error: {join_err}")),
                ),
            };
            if let Err(err) = shard_result {
                let aggregate_payload = {
                    let mut state = aggregate.lock().await;
                    state.mark_failed(&shard_id);
                    state.payload()
                };
                self.publish_aggregate_progress(run_id, aggregate_payload, true)
                    .await;
                if first_error.is_none() {
                    first_error = Some(err);
                    cancel_flag.store(true, Ordering::SeqCst);
                }
            }
        }
        if let Some(err) = first_error {
            return Err(err);
        }

        self.emit_phase_event(run_id, merge_report_phase, json!({ "engine": "rust" }))
            .await;
        let merge_bin = resolve_sibling_binary("equilibra-offchain-merge")?;
        let mut merge_args = Vec::<String>::new();
        for shard in shards {
            merge_args.push("--input".to_string());
            merge_args.push(shard.results_path.display().to_string());
        }
        merge_args.push("--report-output".to_string());
        merge_args.push(report_output_dir.display().to_string());
        merge_args.push("--oracle-data-dir".to_string());
        merge_args.push(oracle_data_dir.display().to_string());
        merge_args.push("--execution-manifest".to_string());
        merge_args.push(execution_manifest.display().to_string());
        let merge_out =
            run_command_capture(merge_bin.as_path(), merge_args.as_slice(), None).await?;
        if !merge_out.success {
            return Err(anyhow!(
                "[RustMergeReport] process failed with code={}, signal={}\n{}\n{}",
                merge_out.code.unwrap_or(-1),
                merge_out.signal.unwrap_or_default(),
                merge_out.stderr_tail,
                merge_out.stdout_tail
            ));
        }
        Ok(())
    }

    async fn prepare_rust_build(&self, run_id: &str) -> Result<()> {
        self.emit_phase_event(run_id, "rust:build:start", json!({ "engine": "rust" }))
            .await;
        let started = std::time::Instant::now();
        let profile = rust_target_profile();
        let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let mut build_args = vec![
            "build".to_string(),
            "--manifest-path".to_string(),
            manifest_path.display().to_string(),
            "--bin".to_string(),
            "equilibra-offchain-simulator".to_string(),
            "--bin".to_string(),
            "equilibra-offchain-merge".to_string(),
            "--quiet".to_string(),
        ];
        if profile == "release" {
            build_args.push("--release".to_string());
        } else if profile != "debug" {
            build_args.push("--profile".to_string());
            build_args.push(profile.clone());
        }
        let build_out = run_command_capture(
            Path::new("cargo"),
            build_args.as_slice(),
            Some(self.base_dir.as_path()),
        )
        .await?;
        if !build_out.success {
            return Err(anyhow!(
                "[RustBuild] cargo build failed\n{}\n{}",
                build_out.stderr_tail,
                build_out.stdout_tail
            ));
        }
        let _sim_bin = resolve_sibling_binary("equilibra-offchain-simulator")
            .with_context(|| "resolve simulator binary")?;
        let _merge_bin = resolve_sibling_binary("equilibra-offchain-merge")
            .with_context(|| "resolve merge binary")?;
        self.emit_log_event(
            run_id,
            "stdout",
            format!(
                "[RustEngine] Rust binaries ({profile}) ready in {:.2}s",
                started.elapsed().as_secs_f64(),
            ),
            None,
        )
        .await;
        self.emit_phase_event(run_id, "rust:build:done", json!({ "engine": "rust" }))
            .await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_simulator_process(
        &self,
        run_id: &str,
        config_path: &Path,
        output_path: &Path,
        only_amm: Option<&str>,
        only_base: Option<&str>,
        origin_config_hash: Option<&str>,
        oracle_data_dir: &Path,
        execution_manifest: &Path,
        shard: Option<&str>,
        cancel_flag: Arc<AtomicBool>,
        aggregate: Option<Arc<Mutex<ShardAggregate>>>,
        aggregate_phase: Option<&str>,
    ) -> Result<()> {
        let simulator_bin = resolve_sibling_binary("equilibra-offchain-simulator")?;
        let mut args = vec![
            "--config".to_string(),
            config_path.display().to_string(),
            "--output".to_string(),
            output_path.display().to_string(),
            "--data-dir".to_string(),
            oracle_data_dir.display().to_string(),
            "--execution-manifest".to_string(),
            execution_manifest.display().to_string(),
        ];
        if let Some(amm) = only_amm {
            args.push("--only-amms".to_string());
            args.push(amm.to_string());
        }
        if let Some(base) = only_base {
            args.push("--only-bases".to_string());
            args.push(base.to_string());
        }
        if let Some(origin) = origin_config_hash {
            args.push("--origin-config-hash".to_string());
            args.push(origin.to_string());
        }

        let mut child = Command::new(simulator_bin)
            .args(args)
            .current_dir(self.base_dir.as_path())
            // If this shard task panics/aborts, the Child is dropped during
            // unwind and the cancel-flag kill heartbeat below dies with the
            // task — kill-on-drop is the only thing that stops the orphan
            // simulator process from writing into the run tree for hours.
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .with_context(|| "spawn Rust simulator process")?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("missing simulator stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("missing simulator stderr pipe"))?;
        let (line_tx, mut line_rx) = mpsc::channel::<ProcessLine>(LINE_CHANNEL_CAPACITY);
        spawn_line_pump(stdout, false, line_tx.clone());
        spawn_line_pump(stderr, true, line_tx);

        let mut stdout_tail = String::new();
        let mut stderr_tail = String::new();
        let mut killed = false;
        let mut pipe_read_error: Option<String> = None;
        let mut exit_status: Option<std::process::ExitStatus> = None;
        let mut heartbeat = tokio::time::interval(Duration::from_millis(200));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            if exit_status.is_none() {
                if let Some(status) = child
                    .try_wait()
                    .with_context(|| "poll Rust simulator process")?
                {
                    exit_status = Some(status);
                    if line_rx.is_closed() {
                        break;
                    }
                }
            }
            tokio::select! {
                _ = heartbeat.tick() => {
                    if cancel_flag.load(Ordering::SeqCst) && !killed {
                        let _ = child.start_kill();
                        killed = true;
                    }
                    if exit_status.is_some() && line_rx.is_closed() {
                        break;
                    }
                }
                process_line = line_rx.recv() => {
                    let Some(process_line) = process_line else {
                        if exit_status.is_some() {
                            break;
                        }
                        continue;
                    };
                    match process_line {
                        ProcessLine::Line { is_stderr, line } => {
                            if is_stderr {
                                tail_concat_in_place(&mut stderr_tail, &line, OUTPUT_TAIL_LIMIT);
                            } else {
                                tail_concat_in_place(&mut stdout_tail, &line, OUTPUT_TAIL_LIMIT);
                            }
                            self.process_simulator_line(
                                run_id,
                                line.as_str(),
                                is_stderr,
                                shard,
                                aggregate.clone(),
                                aggregate_phase,
                            )
                            .await;
                        }
                        ProcessLine::ReadError { is_stderr, message } => {
                            let stream = if is_stderr { "stderr" } else { "stdout" };
                            let detail = format!("failed to read simulator {stream}: {message}");
                            if pipe_read_error.is_none() {
                                pipe_read_error = Some(detail.clone());
                                self.emit_error_event(
                                    run_id,
                                    json!({
                                        "message": detail,
                                        "stream": stream,
                                        "shard": shard,
                                        "engine": "rust"
                                    }),
                                )
                                .await;
                            }
                            // Continuing after a broken pipe would make a
                            // successful exit indistinguishable from silently
                            // truncated telemetry. Fail the shard loudly.
                            if !killed {
                                let _ = child.start_kill();
                                killed = true;
                            }
                        }
                    }
                }
            }
        }

        if exit_status.is_none() {
            exit_status = Some(
                child
                    .wait()
                    .await
                    .with_context(|| "wait for Rust simulator process")?,
            );
        }

        let status =
            exit_status.ok_or_else(|| anyhow!("Rust simulator process exited without status"))?;
        if let Some(read_error) = pipe_read_error {
            return Err(anyhow!(read_error));
        }
        if status.success() {
            // A shard becomes completed only after its process exit code has
            // been checked. A final 100% telemetry sample is not success.
            if let (Some(shard_name), Some(aggregate_state)) = (shard, aggregate) {
                let aggregate_payload = {
                    let mut state = aggregate_state.lock().await;
                    state.mark_success(shard_name);
                    state.payload()
                };
                self.publish_aggregate_progress(run_id, aggregate_payload, true)
                    .await;
            }
            self.emit_done_event(
                run_id,
                json!({
                    "code": status.code().unwrap_or(0),
                    "signal": signal_number(&status),
                    "shard": shard,
                    "engine": "rust"
                }),
            )
            .await;
            Ok(())
        } else {
            let msg = format!(
                "Runner exited with code={}, signal={}",
                status.code().unwrap_or(-1),
                signal_number(&status).unwrap_or(0)
            );
            self.emit_error_event(
                run_id,
                json!({
                    "message": msg,
                    "code": status.code(),
                    "signal": signal_number(&status),
                    "stderrTail": if stderr_tail.is_empty() { Value::Null } else { Value::String(stderr_tail.clone()) },
                    "stdoutTail": if stdout_tail.is_empty() { Value::Null } else { Value::String(stdout_tail.clone()) },
                    "shard": shard,
                    "engine": "rust"
                }),
            )
            .await;
            Err(anyhow!(
                "Rust simulator failed: code={:?} signal={:?}\n{}\n{}",
                status.code(),
                signal_number(&status),
                stderr_tail,
                stdout_tail
            ))
        }
    }

    async fn process_simulator_line(
        &self,
        run_id: &str,
        line: &str,
        is_stderr: bool,
        shard: Option<&str>,
        aggregate: Option<Arc<Mutex<ShardAggregate>>>,
        aggregate_phase: Option<&str>,
    ) {
        if line.trim().is_empty() {
            return;
        }
        if let Some((kind, payload)) = parse_benchmark_event_line(line) {
            if kind == "phase" {
                let mut obj = payload.as_object().cloned().unwrap_or_default();
                obj.insert("engine".to_string(), Value::String("rust".to_string()));
                if let Some(shard_name) = shard {
                    obj.insert("shard".to_string(), Value::String(shard_name.to_string()));
                    // A child phase is shard telemetry, not the workflow
                    // phase of the whole run. Forward it without touching
                    // the manifest (and therefore without an fsync).
                    self.emit_event(run_id, "shard-phase", Value::Object(obj))
                        .await;
                } else if let Some(phase) = obj.get("phase").and_then(|v| v.as_str()) {
                    self.emit_phase_event(run_id, phase, Value::Object(obj.clone()))
                        .await;
                } else {
                    self.emit_event(run_id, "phase", Value::Object(obj)).await;
                }
                return;
            }
            if kind == "progress" {
                let mut obj = payload.as_object().cloned().unwrap_or_default();
                obj.insert("engine".to_string(), Value::String("rust".to_string()));
                if let Some(shard_name) = shard {
                    obj.insert("shard".to_string(), Value::String(shard_name.to_string()));
                    self.publish_shard_progress(run_id, shard_name, Value::Object(obj.clone()))
                        .await;
                } else {
                    self.emit_progress_event(run_id, Value::Object(obj.clone()))
                        .await;
                }
                if let (Some(agg), Some(shard_name), Some(phase_name)) =
                    (aggregate, shard, aggregate_phase)
                {
                    if let Some(percent) = obj.get("percent").and_then(|v| v.as_f64()) {
                        let aggregate_payload = {
                            let mut state = agg.lock().await;
                            state.phase = phase_name.to_string();
                            state
                                .shards
                                .insert(shard_name.to_string(), percent.clamp(0.0, 100.0));
                            state.payload()
                        };
                        self.publish_aggregate_progress(run_id, aggregate_payload, false)
                            .await;
                    }
                }
                return;
            }
            if kind == "error" {
                let mut obj = payload.as_object().cloned().unwrap_or_default();
                obj.insert("engine".to_string(), Value::String("rust".to_string()));
                if let Some(shard_name) = shard {
                    obj.insert("shard".to_string(), Value::String(shard_name.to_string()));
                }
                self.emit_error_event(run_id, Value::Object(obj)).await;
                return;
            }
        }

        let normalized = normalize_rust_log_line(line);
        if normalized.is_empty() {
            return;
        }
        self.emit_log_event(
            run_id,
            if is_stderr { "stderr" } else { "stdout" },
            normalized,
            shard.map(std::string::ToString::to_string),
        )
        .await;
    }

    async fn publish_shard_progress(&self, run_id: &str, shard: &str, payload: Value) {
        {
            let mut inner = self.inner.lock().await;
            let Some(rec) = inner.runs.get_mut(run_id) else {
                return;
            };
            rec.telemetry
                .shard_progress
                .insert(shard.to_string(), payload.clone());
            let history = rec
                .telemetry
                .shard_history
                .entry(shard.to_string())
                .or_default();
            push_telemetry_history(history, payload.clone());
        }
        self.emit_event(run_id, "shard-progress", payload).await;
    }

    async fn publish_aggregate_progress(&self, run_id: &str, payload: Value, force: bool) {
        let should_emit = {
            let mut inner = self.inner.lock().await;
            let Some(rec) = inner.runs.get_mut(run_id) else {
                return;
            };
            rec.telemetry.run_progress = Some(payload.clone());
            let now = std::time::Instant::now();
            let due = force
                || rec.last_aggregate_emit.map_or(true, |last| {
                    now.duration_since(last) >= AGGREGATE_EVENT_DEBOUNCE
                });
            if due {
                rec.last_aggregate_emit = Some(now);
            }
            due
        };
        if should_emit {
            self.emit_progress_event(run_id, payload).await;
        }
    }

    async fn emit_phase_event(&self, run_id: &str, phase: &str, payload: Value) {
        let mut progress = self
            .get_run(run_id)
            .await
            .and_then(|m| m.progress)
            .unwrap_or(RunProgress {
                phase: None,
                current_tick: None,
                total_ticks: None,
                percent: None,
                eta_sec: None,
                message: None,
            });
        progress.phase = Some(phase.to_string());
        self.update_manifest_progress(run_id, progress, true).await;
        self.emit_event(run_id, "phase", payload).await;
    }

    async fn emit_progress_event(&self, run_id: &str, payload: Value) {
        let mut progress = self
            .get_run(run_id)
            .await
            .and_then(|m| m.progress)
            .unwrap_or(RunProgress {
                phase: None,
                current_tick: None,
                total_ticks: None,
                percent: None,
                eta_sec: None,
                message: None,
            });
        if let Some(phase) = payload.get("phase").and_then(|v| v.as_str()) {
            progress.phase = Some(phase.to_string());
        }
        if let Some(v) = payload.get("currentTick").and_then(|v| v.as_u64()) {
            progress.current_tick = Some(v);
        }
        if let Some(v) = payload.get("totalTicks").and_then(|v| v.as_u64()) {
            progress.total_ticks = Some(v);
        }
        if let Some(v) = payload.get("percent").and_then(|v| v.as_f64()) {
            progress.percent = Some(v);
        }
        if let Some(v) = payload.get("etaSec").and_then(|v| v.as_f64()) {
            progress.eta_sec = Some(v);
        }
        // Aggregate progress intentionally drops shard-scoped tick/ETA
        // fields. Keeping an old shard's `432001/2282384` beside a new
        // run-level percentage produces an internally impossible manifest.
        progress.current_tick = None;
        progress.total_ticks = None;
        progress.eta_sec = None;
        self.update_manifest_progress(run_id, progress, false).await;
        self.emit_event(run_id, "progress", payload).await;
    }

    async fn emit_log_event(
        &self,
        run_id: &str,
        stream: &str,
        line: String,
        shard: Option<String>,
    ) {
        let mut payload = json!({
            "stream": stream,
            "line": line,
            "engine": "rust"
        });
        if let Some(shard_name) = shard {
            payload["shard"] = Value::String(shard_name);
        }
        self.emit_event(run_id, "log", payload).await;
    }

    async fn emit_done_event(&self, run_id: &str, payload: Value) {
        self.emit_event(run_id, "done", payload).await;
    }

    async fn update_manifest_progress(
        &self,
        run_id: &str,
        progress: RunProgress,
        persist_immediately: bool,
    ) {
        // The in-memory manifest (served by the API and SSE) is always
        // updated. Aggregate progress writes are wall-clock debounced;
        // orchestrator-owned workflow phase transitions can request one
        // immediate durable write. Shard phases never reach this function.
        let maybe_manifest = {
            let mut inner = self.inner.lock().await;
            let Some(rec) = inner.runs.get_mut(run_id) else {
                return;
            };
            rec.manifest.progress = Some(progress);
            let now = std::time::Instant::now();
            let due = persist_immediately
                || rec
                    .last_status_persist
                    .map_or(true, |t| now.duration_since(t) >= STATUS_PERSIST_DEBOUNCE);
            if due {
                rec.last_status_persist = Some(now);
                Some(rec.manifest.clone())
            } else {
                None
            }
        };
        if let Some(manifest) = maybe_manifest {
            let status_path = PathBuf::from(&manifest.run_paths.status_file);
            let persisted = tokio::task::spawn_blocking(move || {
                write_json_pretty(status_path.as_path(), &manifest)
            })
            .await;
            let persist_error = match persisted {
                Ok(Ok(())) => None,
                Ok(Err(err)) => Some(err.to_string()),
                Err(err) => Some(format!("progress status writer task failed: {err}")),
            };
            if let Some(err) = persist_error {
                eprintln!(
                    "[orchestrator] run {run_id}: failed to persist progress status.json: {err}"
                );
            }
        }
    }

    async fn emit_event(&self, run_id: &str, kind: &str, payload: Value) {
        let sender = {
            let inner = self.inner.lock().await;
            inner.runs.get(run_id).map(|r| r.sender.clone())
        };
        if let Some(sender) = sender {
            let _ = sender.send(RunEvent {
                kind: kind.to_string(),
                timestamp: Utc::now().to_rfc3339(),
                run_id: run_id.to_string(),
                payload,
            });
        }
    }

    async fn emit_error_event(&self, run_id: &str, payload: Value) {
        self.emit_event(run_id, "error", payload).await;
    }

    async fn emit_status_from_manifest(&self, run_id: &str) {
        let manifest = self.get_run(run_id).await;
        if let Some(manifest) = manifest {
            self.emit_event(
                run_id,
                "status",
                json!({
                    "status": manifest.status,
                    "progress": manifest.progress
                }),
            )
            .await;
        }
    }

    async fn prune_completed_run_artifacts_before_new_run(&self) {
        // Under the removal gate: pruning walks the same subtrees that
        // delete/clear recursively remove, and an ungated concurrent walk
        // can make their `remove_dir_all` fail mid-way (spurious
        // removed:false with a half-gutted directory).
        let _removal_gate = self.removal_gate.lock().await;
        let runs: Vec<RunManifest> = {
            let inner = self.inner.lock().await;
            inner.runs.values().map(|r| r.manifest.clone()).collect()
        };
        for run in runs {
            if run.status == RunStatus::Completed {
                self.prune_run_raw_artifacts(&run).await;
            }
        }
    }

    async fn prune_run_raw_artifacts(&self, manifest: &RunManifest) {
        let run_root = Path::new(&manifest.run_paths.root);
        // `inputs/oracle` is reclaimed too: the feed is digested in place,
        // so a run-local candle copy (hundreds of MB) is pure redundancy
        // next to the shared directory.
        let removable = [
            "checkpoints",
            "logs",
            "shards",
            "shards_ctx",
            "shards_rust",
            "shards_ctx_rust",
            "inputs/oracle",
        ];
        let sim_results_path = Path::new(&manifest.run_paths.sim_results_file);
        if !removable.iter().any(|name| run_root.join(name).exists()) && !sim_results_path.exists()
        {
            return;
        }
        if !has_valid_report_completion_marker(manifest) {
            eprintln!(
                "[orchestrator] refusing to prune run {}: durable report completion marker is missing or mismatched",
                manifest.run_id
            );
            return;
        }
        for name in removable {
            remove_dir_if_exists(&run_root.join(name));
        }
        // A raw result file can exceed a gigabyte per run; the report
        // bundle (with the result digest in its completion marker) is the
        // retained artifact.
        match fs::remove_file(sim_results_path) {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                eprintln!(
                    "[orchestrator] failed to prune raw result {}: {err}",
                    sim_results_path.display()
                );
            }
        }
    }
}

fn has_valid_report_completion_marker(manifest: &RunManifest) -> bool {
    let Some(execution_fingerprint) = manifest.execution_fingerprint.as_deref() else {
        return false;
    };
    let Some(oracle_digest) = manifest.oracle_digest.as_deref() else {
        return false;
    };
    let run_root = Path::new(&manifest.run_paths.root);
    let marker_path = run_root.join("report").join("REPORT_COMPLETE.json");
    let metrics_path = run_root
        .join("report")
        .join("web")
        .join("data")
        .join("metrics.json");
    let Ok(raw) = fs::read(&marker_path) else {
        return false;
    };
    let Ok(marker) = serde_json::from_slice::<Value>(&raw) else {
        return false;
    };
    // The marker's resultDigest is the canonical content digest
    // (`common::canonical_result_digest`) of the result the report was
    // generated from; the raw sim_results file is deliberately not
    // retained (it can exceed a gigabyte per run), so only the digest's
    // shape is checked here.
    let Some(result_digest) = marker.get("resultDigest").and_then(Value::as_str) else {
        return false;
    };
    if result_digest.len() != 64
        || !result_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    marker.get("reportAlgorithmVersion").and_then(Value::as_str) == Some(REPORT_ALGORITHM_VERSION)
        && marker.get("resultFormatVersion").and_then(Value::as_str) == Some(RESULT_FORMAT_VERSION)
        && marker.get("executionFingerprint").and_then(Value::as_str) == Some(execution_fingerprint)
        && marker.get("oracleDigest").and_then(Value::as_str) == Some(oracle_digest)
        && metrics_path.is_file()
}

fn enabled_amms(cfg: &BenchmarkRunConfig) -> Vec<String> {
    let mut out = Vec::<String>::new();
    if cfg.amms.equilibra.enabled {
        out.push("equilibra".to_string());
    }
    if cfg.amms.uniswap_v2.enabled {
        out.push("uniswapV2".to_string());
    }
    if cfg.amms.curve.enabled {
        out.push("curve".to_string());
    }
    out
}

fn clone_config_for_amm(cfg: &BenchmarkRunConfig, amm: &str) -> BenchmarkRunConfig {
    let mut copy = cfg.clone();
    copy.amms.equilibra.enabled = amm == "equilibra";
    copy.amms.uniswap_v2.enabled = amm == "uniswapV2";
    copy.amms.curve.enabled = amm == "curve";
    copy
}

fn rust_target_profile() -> String {
    let raw = std::env::var("BENCHMARK_RUST_PROFILE").unwrap_or_else(|_| "release".to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "release".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_sibling_binary(bin_name: &str) -> Result<PathBuf> {
    let profile = rust_target_profile();
    let target_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(profile.as_str());
    let filename = if cfg!(windows) {
        format!("{bin_name}.exe")
    } else {
        bin_name.to_string()
    };
    let candidate = target_dir.join(filename);
    if candidate.exists() && candidate.is_file() {
        Ok(candidate)
    } else {
        Err(anyhow!("Rust binary not found: {}", candidate.display()))
    }
}

fn signal_number(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

/// Char-boundary-safe suffix: return the tail of `s` starting at the
/// first UTF-8 char boundary at or after `s.len() - max_bytes`. Never
/// panics on a multibyte character straddling the cutoff (a naive
/// `&s[s.len() - max_bytes..]` byte slice would).
fn tail_on_char_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let keep_from = s.len() - max_bytes;
    let idx = s
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= keep_from)
        .unwrap_or(s.len());
    s[idx..].to_string()
}

fn tail_concat_in_place(buf: &mut String, chunk: &str, max_chars: usize) {
    if chunk.is_empty() {
        return;
    }
    buf.push_str(chunk);
    if buf.len() > max_chars {
        let keep_from = buf.len() - max_chars;
        let idx = buf
            .char_indices()
            .map(|(i, _)| i)
            .find(|&i| i >= keep_from)
            .unwrap_or(buf.len());
        *buf = buf[idx..].to_string();
    }
}

fn parse_benchmark_event_line(line: &str) -> Option<(String, Value)> {
    let idx = line.find(BENCHMARK_EVENT_PREFIX)?;
    let raw = line[idx + BENCHMARK_EVENT_PREFIX.len()..].trim();
    if raw.is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let kind = parsed.get("type")?.as_str()?.to_string();
    let payload = parsed.get("payload").cloned().unwrap_or_else(|| json!({}));
    Some((kind, payload))
}

fn normalize_rust_log_line(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with("Blocking waiting for file lock on") {
        return String::new();
    }
    if trimmed.starts_with("Finished `release` profile") {
        return String::new();
    }
    trimmed.to_string()
}

fn spawn_line_pump<R>(reader: R, is_stderr: bool, tx: mpsc::Sender<ProcessLine>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    // Bounded send: when the consumer lags, the pump blocks
                    // here, the OS pipe fills and the child process
                    // throttles — deliberate backpressure instead of
                    // unbounded queue growth. Lines are never dropped.
                    if tx
                        .send(ProcessLine::Line { is_stderr, line })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    // A read failure is not EOF. Surface it to the process
                    // owner so the shard fails instead of quietly producing
                    // a truncated telemetry/log stream.
                    let _ = tx
                        .send(ProcessLine::ReadError {
                            is_stderr,
                            message: err.to_string(),
                        })
                        .await;
                    break;
                }
            }
        }
    });
}

async fn run_command_capture(
    command: &Path,
    args: &[String],
    cwd: Option<&Path>,
) -> Result<CommandOutput> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let output = cmd
        .output()
        .await
        .with_context(|| format!("run command {}", command.display()))?;
    let stdout_lossy = String::from_utf8_lossy(&output.stdout);
    let stdout_tail = tail_on_char_boundary(&stdout_lossy, OUTPUT_TAIL_LIMIT);
    let stderr_lossy = String::from_utf8_lossy(&output.stderr);
    let stderr_tail = tail_on_char_boundary(&stderr_lossy, OUTPUT_TAIL_LIMIT);
    Ok(CommandOutput {
        success: output.status.success(),
        code: output.status.code(),
        signal: signal_number(&output.status),
        stdout_tail,
        stderr_tail,
    })
}

fn ensure_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("create dir {}", path.display()))
}

/// A run id used as a single path component: `run_`-prefixed and free of
/// separators or parent refs, so joining it to the runs root cannot
/// escape the directory.
fn is_safe_run_id(run_id: &str) -> bool {
    run_id.strip_prefix("run_").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

/// Validate the identity loaded from an on-disk run directory and replace
/// every serialized path with one derived from the configured base directory.
/// No path from `status.json` is used after this function returns.
fn rebind_hydrated_manifest_paths(
    base_dir: &Path,
    directory_name: &str,
    manifest: &mut RunManifest,
) -> Result<()> {
    if !is_safe_run_id(directory_name) {
        return Err(anyhow!("unsafe run directory name `{directory_name}`"));
    }
    if manifest.run_id != directory_name {
        return Err(anyhow!(
            "manifest runId `{}` does not match directory name `{directory_name}`",
            manifest.run_id
        ));
    }
    manifest.run_paths = build_run_paths(base_dir, directory_name);
    Ok(())
}

/// Remove a run directory reconstructed from TRUSTED inputs
/// (`base_dir/runs/<run_id>`), never from a path stored in a possibly
/// tampered manifest, and only after confirming the canonical target is
/// contained under the canonical runs root. Prevents an imported/edited
/// `status.json` from directing recursive deletion outside `runs/`.
///
/// Deletion itself operates on the lexical `runs/<run_id>` path rather
/// than the pre-resolved canonical one: if the entry is swapped for a
/// symlink between the checks and the deletion, `remove_dir_all` unlinks
/// only the link instead of recursing into whatever it points at.
///
/// Returns `true` when the entry is absent on return (removed, or never
/// existed), `false` when removal was refused or failed — callers surface
/// that to the API instead of reporting success for a directory that is
/// still on disk.
fn remove_run_dir_guarded(base_dir: &Path, run_id: &str) -> bool {
    if !is_safe_run_id(run_id) {
        eprintln!("[orchestrator] refusing to remove unsafe run id: {run_id}");
        return false;
    }
    let runs_root = base_dir.join(RUNS_ROOT_DIR);
    let target = runs_root.join(run_id);
    // Refuse to follow a symlink AT the run-dir entry itself. Without this,
    // a planted `runs/<run_id>` symlink pointing at the runs root (or a
    // sibling run) canonicalizes to that target, the reflexive
    // `starts_with` containment check passes, and `remove_dir_all` wipes
    // the whole runs tree (or another run). A legitimate run dir is a real
    // directory, never a link.
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            eprintln!(
                "[orchestrator] refusing to remove {} — run dir entry is a symlink",
                target.display()
            );
            return false;
        }
        Ok(_) => {}
        // Only a genuinely missing entry counts as "already gone" — and
        // even then the absence must be COMMITTED: a prior removal whose
        // parent fsync failed is still un-persisted, so a retry that finds
        // ENOENT re-attempts the fsync instead of assuming it happened.
        // An EACCES/EIO-style stat failure must not be reported as a
        // successful removal (the directory is still on disk).
        Err(err) if err.kind() == ErrorKind::NotFound => return persist_absence_reporting(&target),
        Err(err) => {
            eprintln!("[orchestrator] cannot stat {}: {err}", target.display());
            return false;
        }
    }
    let canon_root = match runs_root.canonicalize() {
        Ok(p) => p,
        // The runs root itself is gone: commit ITS absence into the base
        // directory before reporting the entry as removed.
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return persist_absence_reporting(&runs_root)
        }
        Err(err) => {
            eprintln!(
                "[orchestrator] cannot canonicalize runs root {}: {err}",
                runs_root.display()
            );
            return false;
        }
    };
    match target.canonicalize() {
        Ok(canon_target) if canon_target != canon_root && canon_target.starts_with(&canon_root) => {
            remove_dir_if_exists(&target)
        }
        Ok(canon_target) => {
            eprintln!(
                "[orchestrator] refusing to remove {} — outside runs root {}",
                canon_target.display(),
                canon_root.display()
            );
            false
        }
        Err(err) if err.kind() == ErrorKind::NotFound => persist_absence_reporting(&target),
        Err(err) => {
            eprintln!(
                "[orchestrator] cannot canonicalize {}: {err}",
                target.display()
            );
            false
        }
    }
}

/// {persist_absence} with the boolean-and-log calling convention the
/// removal helpers use: `true` only when the absence is committed.
fn persist_absence_reporting(path: &Path) -> bool {
    match persist_absence(path) {
        Ok(()) => true,
        Err(err) => {
            eprintln!(
                "[orchestrator] failed to persist absence of {}: {err}",
                path.display()
            );
            false
        }
    }
}

/// Persist the ABSENCE of `path`: fsync the nearest existing ancestor
/// directory. ENOENT alone only proves the entry is absent from the
/// filesystem's current in-memory state — an earlier removal whose
/// parent-directory fsync failed (e.g. with EIO) is not yet committed and
/// can roll back on power loss, so "already gone" answers must re-attempt
/// the fsync rather than assume it ever happened.
fn persist_absence(path: &Path) -> Result<()> {
    let mut current = path
        .parent()
        .ok_or_else(|| anyhow!("path has no parent: {}", path.display()))?;
    loop {
        match fs::File::open(current).and_then(|dir| dir.sync_all()) {
            Ok(()) => return Ok(()),
            // The ancestor is gone too — commit its absence one level up.
            Err(err) if err.kind() == ErrorKind::NotFound => {
                current = current
                    .parent()
                    .ok_or_else(|| anyhow!("no existing ancestor for {}", path.display()))?;
            }
            Err(err) if is_unsupported_dir_fsync(&err) => {
                warn_dir_fsync_once(current, &err);
                return Ok(());
            }
            Err(err) => {
                return Err(err).with_context(|| format!("persist absence of {}", path.display()));
            }
        }
    }
}

/// Returns `true` when the directory is DURABLY absent on return: either
/// removed here with the removal fsynced into the parent, or already
/// absent with that absence re-committed via {persist_absence} (an
/// earlier removal's failed fsync must not be mistaken for a persisted
/// one). Returns `false` when removal or its persistence failed. Attempts
/// `remove_dir_all` directly instead of probing first — a probe both
/// races the filesystem and swallows non-ENOENT stat errors as
/// "nothing to do".
fn remove_dir_if_exists(path: &Path) -> bool {
    remove_dir_if_exists_with_sync(path, fsync_parent_dir, persist_absence)
}

/// {remove_dir_if_exists} with the two fsync steps injectable, so tests
/// can drive the failure branches without a fault-injecting filesystem.
fn remove_dir_if_exists_with_sync<S, A>(
    path: &Path,
    mut sync_removal: S,
    mut sync_absence: A,
) -> bool
where
    S: FnMut(&Path) -> Result<()>,
    A: FnMut(&Path) -> Result<()>,
{
    match fs::remove_dir_all(path) {
        // The unlinked directory entry lives in the parent: without a
        // parent fsync a power loss can bring a "removed" directory back
        // after the API already answered removed:true.
        Ok(()) => match sync_removal(path) {
            Ok(()) => true,
            Err(err) => {
                eprintln!(
                    "[orchestrator] failed to persist removal of {}: {err}",
                    path.display()
                );
                false
            }
        },
        Err(err) if err.kind() == ErrorKind::NotFound => match sync_absence(path) {
            Ok(()) => true,
            Err(err) => {
                eprintln!(
                    "[orchestrator] failed to persist absence of {}: {err}",
                    path.display()
                );
                false
            }
        },
        // Best-effort semantics are intentional (callers must not fail on
        // cleanup), but the error is logged and reported so a permission
        // problem or a busy mount does not vanish silently.
        Err(err) => {
            eprintln!(
                "[orchestrator] failed to remove directory {}: {err}",
                path.display()
            );
            false
        }
    }
}

fn write_json_pretty<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let payload = serde_json::to_string_pretty(value)?;
    // Atomic publish (write-temp + fsync + rename): a crash, power loss or
    // ENOSPC mid-write must never leave truncated JSON at the final path —
    // hydration skips an unparseable status.json instead of recovering the
    // run. The fsync matters: without it a journaled rename can survive a
    // power loss whose data blocks never reached disk, leaving a
    // zero-length file at the final path. The temp name is process- and
    // sequence-unique so concurrent writers of the same file (debounced
    // progress vs. finalizer) cannot collide; a temp stranded by a hard
    // crash is inert (never read, unique name, tiny).
    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(
        "{}.tmp-{}-{seq}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("json"),
        std::process::id(),
    ));
    let write_result = fs::File::create(&tmp).and_then(|mut file| {
        file.write_all(payload.as_bytes())?;
        file.sync_all()
    });
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("write {}", tmp.display()));
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("publish {}", path.display()));
    }
    // Make the rename itself durable: without a parent-directory fsync a
    // power loss can roll the rename back (or drop a first-ever file) even
    // though the file data was synced above.
    fsync_parent_dir(path)
}

/// Kinds that mean "this platform or filesystem cannot fsync a
/// directory". `PermissionDenied` counts only on Windows, where opening
/// a directory as a file is refused by design; on Unix an EACCES here is
/// a genuine permission problem and must propagate.
fn is_unsupported_dir_fsync(err: &std::io::Error) -> bool {
    match err.kind() {
        ErrorKind::Unsupported | ErrorKind::InvalidInput => true,
        #[cfg(windows)]
        ErrorKind::PermissionDenied => true,
        _ => false,
    }
}

/// Fsync the parent directory of `path` so a just-created, just-renamed
/// or just-removed entry survives a power loss. Unsupported-platform
/// failures (see {is_unsupported_dir_fsync}) degrade to a warning
/// deduplicated per (directory, error kind); genuine storage errors
/// (EIO, ENOSPC, a read-only remount, Unix EACCES) propagate to the
/// caller.
fn fsync_parent_dir(path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    match fs::File::open(parent).and_then(|dir| dir.sync_all()) {
        Ok(()) => Ok(()),
        Err(err) if is_unsupported_dir_fsync(&err) => {
            warn_dir_fsync_once(parent, &err);
            Ok(())
        }
        Err(err) => Err(err).with_context(|| format!("fsync directory {}", parent.display())),
    }
}

/// Warn once per (directory, error kind) that this platform or filesystem
/// cannot fsync the directory; repeated identical failures stay silent.
fn warn_dir_fsync_once(dir: &Path, err: &std::io::Error) {
    static WARNED: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashSet<(PathBuf, ErrorKind)>>,
    > = std::sync::OnceLock::new();
    let warned = WARNED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    let first = warned
        .lock()
        .map(|mut set| set.insert((dir.to_path_buf(), err.kind())))
        .unwrap_or(false);
    if first {
        eprintln!(
            "[orchestrator] directory fsync unsupported for {} (reported once per directory and error kind): {err}",
            dir.display()
        );
    }
}

pub fn resolve_oracle_data_dir() -> Result<PathBuf> {
    // An explicit BENCHMARK_ORACLE_DATA_DIR override is authoritative:
    // if it is set but unusable, fail loudly instead of silently falling
    // back to the compiled-in default (a typo'd or unmounted override
    // must never make a run consume the wrong oracle feed).
    match std::env::var("BENCHMARK_ORACLE_DATA_DIR") {
        Ok(path) => {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return Err(anyhow!(
                    "BENCHMARK_ORACLE_DATA_DIR is set but empty; unset it to use the default simulator/data directory"
                ));
            }
            let p = PathBuf::from(trimmed);
            if !p.exists() {
                return Err(anyhow!(
                    "BENCHMARK_ORACLE_DATA_DIR is set to '{}' but the path does not exist",
                    p.display()
                ));
            }
            if !p.is_dir() {
                return Err(anyhow!(
                    "BENCHMARK_ORACLE_DATA_DIR is set to '{}' but it is not a directory",
                    p.display()
                ));
            }
            return Ok(p);
        }
        Err(std::env::VarError::NotPresent) => {}
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(anyhow!(
                "BENCHMARK_ORACLE_DATA_DIR is set but is not valid unicode"
            ));
        }
    }
    let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("data");
    if local.exists() && local.is_dir() {
        return Ok(local);
    }
    Err(anyhow!(
        "Oracle data directory was not found. Set BENCHMARK_ORACLE_DATA_DIR or create simulator/data."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::manifest::RUN_MANIFEST_VERSION;
    use std::pin::Pin;
    use std::task::{Context as TaskContext, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    fn test_manifest(run_id: &str) -> RunManifest {
        RunManifest {
            version: RUN_MANIFEST_VERSION.to_string(),
            run_id: run_id.to_string(),
            status: RunStatus::Completed,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            config_version: "benchmark-run-config/test".to_string(),
            config_hash: "hash".to_string(),
            binary_version: "unknown".to_string(),
            oracle_digest: None,
            execution_fingerprint: None,
            run_paths: build_run_paths(Path::new("/untrusted"), run_id),
            error: None,
            progress: None,
        }
    }

    #[test]
    fn hydrated_manifest_paths_are_rebuilt_from_directory_name() {
        let base_dir = Path::new("/trusted/base");
        let mut manifest = test_manifest("run_safe-1");

        rebind_hydrated_manifest_paths(base_dir, "run_safe-1", &mut manifest)
            .expect("safe matching manifest");

        let expected = build_run_paths(base_dir, "run_safe-1");
        assert_eq!(
            serde_json::to_value(&manifest.run_paths).expect("serialize paths"),
            serde_json::to_value(expected).expect("serialize expected paths")
        );
    }

    #[test]
    fn hydrated_manifest_rejects_mismatched_or_unsafe_identity() {
        let base_dir = Path::new("/trusted/base");
        let mut mismatch = test_manifest("run_other");
        assert!(rebind_hydrated_manifest_paths(base_dir, "run_safe", &mut mismatch).is_err());

        let mut unsafe_name = test_manifest("run_../escape");
        assert!(
            rebind_hydrated_manifest_paths(base_dir, "run_../escape", &mut unsafe_name).is_err()
        );
        assert!(!is_safe_run_id("run_contains space"));
        assert!(is_safe_run_id("run_20260718_s42_rust_a1b2c3"));
    }

    #[test]
    fn output_tails_never_split_utf8_code_points() {
        for (input, limit) in [("aaaaé", 1), ("ab€z", 3), ("x💣y", 4)] {
            let tail = tail_on_char_boundary(input, limit);
            assert!(tail.len() <= limit);
            assert!(input.ends_with(&tail));

            let mut concatenated = String::new();
            tail_concat_in_place(&mut concatenated, input, limit);
            assert!(concatenated.len() <= limit);
            assert!(input.ends_with(&concatenated));
        }
    }

    #[test]
    fn terminal_success_progress_is_coherent() {
        let mut manifest = test_manifest("run_terminal");
        manifest.progress = Some(RunProgress {
            phase: Some("parallel_fast_by_context".to_string()),
            current_tick: Some(123),
            total_ticks: Some(600),
            percent: Some(20.5),
            eta_sec: Some(90.0),
            message: None,
        });

        normalize_terminal_progress(&mut manifest);

        let progress = manifest.progress.expect("terminal progress");
        assert_eq!(progress.phase.as_deref(), Some("completed"));
        assert_eq!(progress.current_tick, Some(600));
        assert_eq!(progress.total_ticks, Some(600));
        assert_eq!(progress.percent, Some(100.0));
        assert_eq!(progress.eta_sec, Some(0.0));
    }

    #[test]
    fn telemetry_history_is_bounded_and_keeps_full_span_and_latest_point() {
        let mut history = Vec::new();
        for timestamp in 0..(TELEMETRY_HISTORY_MAX_POINTS as u64 * 3) {
            push_telemetry_history(
                &mut history,
                json!({ "currentTimestamp": timestamp, "percent": timestamp as f64 }),
            );
        }
        assert!(history.len() <= TELEMETRY_HISTORY_MAX_POINTS);
        assert_eq!(history.first().unwrap()["currentTimestamp"], 0);
        assert_eq!(
            history.last().unwrap()["currentTimestamp"],
            TELEMETRY_HISTORY_MAX_POINTS as u64 * 3 - 1
        );
    }

    #[test]
    fn shard_is_completed_only_by_explicit_success_transition() {
        let mut aggregate = ShardAggregate {
            phase: "simulation".to_string(),
            shards: HashMap::from([("equilibra:WETH".to_string(), 100.0)]),
            completed: HashSet::new(),
            failed: HashSet::new(),
            total: 1,
        };

        // A raw 100% sample is not a successful process exit.
        assert_eq!(aggregate.payload()["completedShards"], 0);
        aggregate.mark_failed("equilibra:WETH");
        assert_eq!(aggregate.payload()["completedShards"], 0);
        assert_eq!(aggregate.payload()["failedShards"][0], "equilibra:WETH");

        aggregate.mark_success("equilibra:WETH");
        assert_eq!(aggregate.payload()["completedShards"], 1);
        assert!(aggregate.payload()["failedShards"]
            .as_array()
            .expect("failed list")
            .is_empty());
    }

    #[tokio::test]
    async fn raw_shard_progress_cannot_replace_run_progress() {
        let base = std::env::temp_dir().join(format!(
            "eq_orch_progress_scope_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let orchestrator = RunOrchestrator::new(base.clone(), 1).await;
        let run_id = "run_progress_scope";
        let mut manifest = test_manifest(run_id);
        manifest.status = RunStatus::Running;
        manifest.run_paths = build_run_paths(&base, run_id);
        let (sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        {
            let mut inner = orchestrator.inner.lock().await;
            inner
                .runs
                .insert(run_id.to_string(), RunRecord::new(manifest, None, sender));
        }

        orchestrator
            .publish_aggregate_progress(
                run_id,
                json!({
                    "phase": "parallel_fast_by_context",
                    "percent": 70.0,
                    "shards": { "equilibra:WETH": 40.0, "curve:WETH": 100.0 },
                    "completedShards": 1,
                    "totalShards": 2,
                }),
                true,
            )
            .await;
        orchestrator
            .publish_shard_progress(
                run_id,
                "equilibra:WETH",
                json!({
                    "shard": "equilibra:WETH",
                    "percent": 10.0,
                    "currentTick": 10,
                    "totalTicks": 100,
                }),
            )
            .await;

        let current = orchestrator.get_run(run_id).await.expect("live run");
        let progress = current.progress.expect("aggregate progress");
        assert_eq!(progress.percent, Some(70.0));
        assert_eq!(progress.current_tick, None);
        assert_eq!(progress.total_ticks, None);
        let snapshot = orchestrator
            .telemetry_snapshot(run_id)
            .await
            .expect("telemetry snapshot");
        assert_eq!(
            snapshot.run_progress.expect("run progress")["percent"],
            70.0
        );
        assert_eq!(snapshot.shard_progress["equilibra:WETH"]["percent"], 10.0);

        let _ = fs::remove_dir_all(&base);
    }

    struct FailingReader;

    impl AsyncRead for FailingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Err(std::io::Error::new(
                ErrorKind::Other,
                "injected read failure",
            )))
        }
    }

    #[tokio::test]
    async fn line_pump_surfaces_read_errors() {
        let (tx, mut rx) = mpsc::channel(1);
        spawn_line_pump(FailingReader, false, tx);
        let received = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("line pump timeout")
            .expect("line pump message");
        match received {
            ProcessLine::ReadError { is_stderr, message } => {
                assert!(!is_stderr);
                assert!(message.contains("injected read failure"));
            }
            ProcessLine::Line { .. } => panic!("read error was misreported as a line"),
        }
    }

    #[test]
    fn dir_fsync_error_classification() {
        use std::io::Error as IoError;
        assert!(is_unsupported_dir_fsync(&IoError::new(
            ErrorKind::Unsupported,
            "x"
        )));
        assert!(is_unsupported_dir_fsync(&IoError::new(
            ErrorKind::InvalidInput,
            "x"
        )));
        assert!(!is_unsupported_dir_fsync(&IoError::new(
            ErrorKind::NotFound,
            "x"
        )));
        assert!(!is_unsupported_dir_fsync(&IoError::new(
            ErrorKind::Other,
            "eio"
        )));
        // PermissionDenied is "unsupported" only on Windows (a directory
        // cannot be opened as a file there); on Unix it is a genuine
        // EACCES and must propagate.
        let denied = IoError::new(ErrorKind::PermissionDenied, "x");
        assert_eq!(is_unsupported_dir_fsync(&denied), cfg!(windows));
    }

    #[test]
    fn remove_dir_if_exists_persists_and_reports() {
        let base = std::env::temp_dir().join(format!("eq_orch_rmdir_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let victim = base.join("victim");
        fs::create_dir_all(&victim).unwrap();
        fs::write(victim.join("f.txt"), b"x").unwrap();

        // Removal succeeds (including the parent-dir fsync) and reports
        // the entry as durably absent.
        assert!(remove_dir_if_exists(&victim));
        assert!(!victim.exists());
        // Removing an already-absent entry is also success.
        assert!(remove_dir_if_exists(&victim));
        // A plain file is not a directory — removal fails and says so
        // instead of reporting a successful delete.
        let file = base.join("plain.txt");
        fs::write(&file, b"x").unwrap();
        assert!(!remove_dir_if_exists(&file));
        assert!(file.exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn removal_reports_true_only_when_persisted() {
        let base =
            std::env::temp_dir().join(format!("eq_orch_persist_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let victim = base.join("victim");
        fs::create_dir_all(&victim).unwrap();

        // A successful removal whose fsync fails must NOT report success.
        assert!(!remove_dir_if_exists_with_sync(
            &victim,
            |_| Err(anyhow!("injected eio")),
            |_| panic!("absence branch must not run"),
        ));
        assert!(!victim.exists());

        // The retry finds the entry absent; a failing absence-fsync still
        // reports false — the earlier removal is not committed yet...
        assert!(!remove_dir_if_exists_with_sync(
            &victim,
            |_| panic!("removal branch must not run"),
            |_| Err(anyhow!("injected eio")),
        ));
        // ...and only a successful absence-fsync finally reports true.
        assert!(remove_dir_if_exists_with_sync(
            &victim,
            |_| panic!("removal branch must not run"),
            |_| Ok(()),
        ));

        // Happy path: removal and persisted fsync in one call.
        fs::create_dir_all(&victim).unwrap();
        assert!(remove_dir_if_exists_with_sync(
            &victim,
            |_| Ok(()),
            |_| panic!("absence branch must not run"),
        ));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn persist_absence_climbs_to_the_nearest_existing_ancestor() {
        let base =
            std::env::temp_dir().join(format!("eq_orch_absence_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        // Both the entry and its parent are missing: the fsync lands on
        // `base`, the nearest existing ancestor, and succeeds.
        let missing = base.join("gone_parent").join("gone_child");
        assert!(persist_absence(&missing).is_ok());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn remove_run_dir_refuses_symlinked_run_entry() {
        use std::os::unix::fs::symlink;

        // Unique temp base under the system temp dir (no external crates).
        let base = std::env::temp_dir().join(format!(
            "eq_orch_symlink_test_{}_{}",
            std::process::id(),
            RUNS_ROOT_DIR
        ));
        let _ = fs::remove_dir_all(&base);
        let runs_root = base.join(RUNS_ROOT_DIR);
        let victim = runs_root.join("run_victim_keepme");
        fs::create_dir_all(&victim).unwrap();
        let canary = victim.join("canary.txt");
        fs::write(&canary, b"do not delete").unwrap();

        // A planted run-dir entry that is a symlink to the runs root.
        let malicious = "run_symlink_to_root";
        symlink(&runs_root, runs_root.join(malicious)).unwrap();

        assert!(
            !remove_run_dir_guarded(&base, malicious),
            "guard must report the refusal instead of success"
        );

        // The symlink target (the whole runs tree, incl. the victim run)
        // must be untouched.
        assert!(
            canary.exists(),
            "guard followed a symlink and deleted the runs root"
        );
        assert!(victim.exists());

        let _ = fs::remove_dir_all(&base);
    }
}
