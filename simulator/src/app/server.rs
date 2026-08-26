use crate::app::config::{
    build_default_config, compute_config_hash, A_MAX_WAD, A_MIN_WAD, BENCHMARK_RUN_CONFIG_VERSION,
    LAMBDA_MAX_WAD, LAMBDA_MIN_WAD, MAX_BASE_FEE_BPS, MAX_EMA_HALF_LIFE_SEC, MAX_FEE_FLOOR_BPS,
    MAX_FEE_RAMP_BPS, MAX_MAX_WORKERS, MAX_PROGRESS_INTERVAL_SEC, MAX_PROTOCOL_FEE_PERCENT,
    MAX_REPEG_SHARE_BPS, MIN_BASE_FEE_BPS, MIN_EMA_PERIOD_SEC, MIN_FEE_FLOOR_BPS, MIN_FEE_RAMP_BPS,
    MIN_MAX_WORKERS, MIN_PROGRESS_INTERVAL_SEC, MIN_PROTOCOL_FEE_PERCENT, MIN_REPEG_SHARE_BPS,
    REPEG_STEP_MAX_WAD, REPEG_STEP_MIN_WAD,
};
use crate::app::manifest::RunStatus;
use crate::app::orchestrator::{
    resolve_oracle_data_dir, CreateRunResult, RemoveRunResult, RunEvent, RunOrchestrator,
};
use crate::app::visualizer::build_visualizer_series;
use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, StreamExt};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::fs::File;
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;

#[derive(Clone)]
pub struct BenchmarkServerState {
    pub base_dir: Arc<PathBuf>,
    pub app_web_dir: Arc<PathBuf>,
    pub visualizer_dir: Arc<PathBuf>,
    pub info_dir: Arc<PathBuf>,
    pub orchestrator: RunOrchestrator,
}

pub async fn build_state(
    base_dir: PathBuf,
    max_concurrent_runs: usize,
) -> Result<BenchmarkServerState> {
    let orchestrator = RunOrchestrator::new(base_dir.clone(), max_concurrent_runs).await;
    let simulator_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let app_web_dir = simulator_dir.join("app-web");
    let visualizer_dir = simulator_dir.join("visualizer");
    let info_dir = simulator_dir.join("Info");

    if !app_web_dir.exists() || !app_web_dir.is_dir() {
        return Err(anyhow!(
            "Missing app web assets at {}",
            app_web_dir.display()
        ));
    }
    if !visualizer_dir.exists() || !visualizer_dir.is_dir() {
        return Err(anyhow!(
            "Missing visualizer assets at {}",
            visualizer_dir.display()
        ));
    }
    if !info_dir.exists() || !info_dir.is_dir() {
        return Err(anyhow!("Missing info assets at {}", info_dir.display()));
    }
    Ok(BenchmarkServerState {
        base_dir: Arc::new(base_dir),
        app_web_dir: Arc::new(app_web_dir),
        visualizer_dir: Arc::new(visualizer_dir),
        info_dir: Arc::new(info_dir),
        orchestrator,
    })
}

pub fn build_router(state: BenchmarkServerState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/favicon.ico", get(favicon))
        .route("/api/config/default", get(api_default_config))
        .route("/api/config/limits", get(api_config_limits))
        .route("/api/visualizer/series", post(api_visualizer_series))
        .route("/api/runs", get(api_list_runs).post(api_create_run))
        .route("/api/runs/clear-finished", post(api_clear_finished))
        .route(
            "/api/runs/{run_id}",
            get(api_get_run).delete(api_delete_run),
        )
        .route("/api/runs/{run_id}/cancel", post(api_cancel_run))
        .route("/api/runs/{run_id}/telemetry", get(api_run_telemetry))
        .route("/api/runs/{run_id}/events", get(api_run_events))
        .route("/api/runs/{run_id}/report/{*asset}", get(api_report_asset))
        .route(
            "/api/runs/{run_id}/results/metrics",
            get(api_report_metrics),
        )
        .route("/app.js", get(static_app_js))
        .route("/app.css", get(static_app_css))
        // SPA route for dashboard page with top navigation.
        // Standalone visualizer assets are served via /visualizer/{*asset}.
        .route("/visualizer", get(static_app_index))
        .route("/visualizer/", get(static_app_index))
        .route("/visualizer/{*asset}", get(static_visualizer_asset))
        .route("/info", get(static_app_index))
        .route("/info/", get(static_app_index))
        .route("/info-assets/{*asset}", get(static_info_asset))
        .route("/", get(static_app_index))
        .route("/setup", get(static_app_index))
        .route("/runs", get(static_app_index))
        .route("/run/{id}", get(static_app_index))
        .route("/results/{id}", get(static_app_index))
        .with_state(state)
}

fn json_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (
        status,
        Json(json!({
            "error": message.into()
        })),
    )
}

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "equilibra-offchain-app",
        "ts": chrono::Utc::now().to_rfc3339(),
    }))
}

async fn favicon() -> impl IntoResponse {
    StatusCode::NO_CONTENT
}

async fn api_default_config(
    State(state): State<BenchmarkServerState>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let data_dir = resolve_oracle_data_dir()
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (start_ts, end_ts) = resolve_common_oracle_window(&data_dir)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let cfg = build_default_config(start_ts, end_ts);
    let defaults_hash = compute_config_hash(&cfg)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let cfg_value = serde_json::to_value(cfg)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let _ = state;
    Ok(Json(json!({
        "config": cfg_value,
        "defaultsHash": defaults_hash,
    })))
}

/// Published bounds for every knob the Setup UI edits. All values come
/// straight from the `app::config` bound-mirror constants — this handler
/// contains no literals, so a bound change in `config.rs` is reflected
/// here automatically. WAD-scaled limits are decimal strings (they exceed
/// the JSON-safe integer range).
async fn api_config_limits() -> Json<Value> {
    Json(json!({
        "version": BENCHMARK_RUN_CONFIG_VERSION,
        "limits": {
            "baseFee": { "min": MIN_BASE_FEE_BPS, "max": MAX_BASE_FEE_BPS },
            "feeRampBps": { "min": MIN_FEE_RAMP_BPS, "max": MAX_FEE_RAMP_BPS },
            "feeFloorBps": { "min": MIN_FEE_FLOOR_BPS, "max": MAX_FEE_FLOOR_BPS },
            "repegShareBps": { "min": MIN_REPEG_SHARE_BPS, "max": MAX_REPEG_SHARE_BPS },
            "protocolFeePercent": { "min": MIN_PROTOCOL_FEE_PERCENT, "max": MAX_PROTOCOL_FEE_PERCENT },
            // The published maximum is the largest accepted half-life INPUT
            // (419731 s) — NOT the internal tau cap (604800 s): the UI
            // clamps the user-facing field, and everything the UI lets
            // through must survive validate_run_config.
            "emaPeriod": { "min": MIN_EMA_PERIOD_SEC, "max": MAX_EMA_HALF_LIFE_SEC },
            "aWad": { "min": A_MIN_WAD.to_string(), "max": A_MAX_WAD.to_string() },
            "lambdaWad": { "min": LAMBDA_MIN_WAD.to_string(), "max": LAMBDA_MAX_WAD.to_string() },
            "repegStepWad": { "min": REPEG_STEP_MIN_WAD.to_string(), "max": REPEG_STEP_MAX_WAD.to_string() },
            // Shared absolute range for both direction dead-bands; the
            // per-side stall guard vs the fee scale stays in
            // `validate_run_config` (it needs the preset's fee fields).
            "repegThresholdWad": { "min": REPEG_STEP_MIN_WAD.to_string(), "max": REPEG_STEP_MAX_WAD.to_string() },
            "maxWorkers": { "min": MIN_MAX_WORKERS, "max": MAX_MAX_WORKERS },
            "progressIntervalSec": { "min": MIN_PROGRESS_INTERVAL_SEC, "max": MAX_PROGRESS_INTERVAL_SEC },
        }
    }))
}

async fn api_visualizer_series(
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // The series build is pure CPU (up to ~400 samples × 3 AMMs of U256
    // secant math, plus adaptive refinement) — tens to hundreds of ms.
    // Run it on the blocking pool so it cannot stall the async workers
    // that serve SSE streams and the run API.
    let series = tokio::task::spawn_blocking(move || build_visualizer_series(body))
        .await
        .map_err(|e| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("visualizer series task failed: {e}"),
            )
        })?
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
    let payload = serde_json::to_value(series)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(payload))
}

async fn api_create_run(
    State(state): State<BenchmarkServerState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<CreateRunResult>), (StatusCode, Json<Value>)> {
    let created = state
        .orchestrator
        .create_run(body)
        .await
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn api_list_runs(
    State(state): State<BenchmarkServerState>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let runs = state.orchestrator.list_runs().await;
    Ok(Json(json!({ "runs": runs })))
}

async fn api_clear_finished(
    State(state): State<BenchmarkServerState>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let out = state.orchestrator.clear_finished_runs().await;
    let payload = serde_json::to_value(out)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(payload))
}

async fn api_get_run(
    State(state): State<BenchmarkServerState>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let run = state
        .orchestrator
        .get_run(&run_id)
        .await
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, format!("Run not found: {run_id}")))?;
    let payload = serde_json::to_value(run)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(payload))
}

async fn api_delete_run(
    State(state): State<BenchmarkServerState>,
    Path(run_id): Path<String>,
) -> Result<Json<RemoveRunResult>, (StatusCode, Json<Value>)> {
    let out = state
        .orchestrator
        .delete_run(&run_id)
        .await
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(out))
}

async fn api_cancel_run(
    State(state): State<BenchmarkServerState>,
    Path(run_id): Path<String>,
) -> Result<Json<RemoveRunResult>, (StatusCode, Json<Value>)> {
    let out = state
        .orchestrator
        .cancel_run(&run_id)
        .await
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(out))
}

async fn api_run_telemetry(
    State(state): State<BenchmarkServerState>,
    Path(run_id): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let snapshot = state
        .orchestrator
        .telemetry_snapshot(&run_id)
        .await
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, format!("Run not found: {run_id}")))?;
    let payload = serde_json::to_value(snapshot)
        .map_err(|e| json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(payload))
}

async fn api_run_events(
    State(state): State<BenchmarkServerState>,
    Path(run_id): Path<String>,
) -> Result<
    Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>,
    (StatusCode, Json<Value>),
> {
    let (manifest, telemetry, rx) = state
        .orchestrator
        .subscribe(&run_id)
        .await
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, format!("Run not found: {run_id}")))?;

    let initial = RunEvent {
        kind: "status".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        run_id: run_id.clone(),
        payload: json!({
            "status": manifest.status,
            "progress": manifest.progress,
        }),
    };
    let telemetry_initial = RunEvent {
        kind: "telemetry-snapshot".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        run_id: run_id.clone(),
        payload: serde_json::to_value(telemetry).unwrap_or_else(|_| json!({})),
    };
    // Subscribe and clone the snapshot under the same orchestrator lock,
    // then send both before draining the receiver. Events produced after
    // that snapshot remain queued, so reconnect cannot miss the boundary.
    let initial_stream = stream::iter([
        Ok::<Event, Infallible>(to_sse_event(initial)),
        Ok::<Event, Infallible>(to_sse_event(telemetry_initial)),
    ]);
    // On lag, emit exactly one explicit marker and then end this response.
    // EventSource reconnects automatically and receives an atomic fresh
    // snapshot + a newly subscribed receiver. Continuing to drain retained
    // pre-lag events after an async snapshot fetch could otherwise regress
    // the UI back to older aggregate progress.
    let event_stream = recoverable_broadcast_stream(rx, run_id.clone());
    let merged = initial_stream.chain(event_stream);
    Ok(Sse::new(merged).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(10))
            .text("keep-alive"),
    ))
}

fn recoverable_broadcast_stream(
    rx: tokio::sync::broadcast::Receiver<RunEvent>,
    run_id: String,
) -> impl futures_util::Stream<Item = Result<Event, Infallible>> {
    stream::unfold(
        (BroadcastStream::new(rx), run_id, false),
        |(mut events, lag_run_id, terminated)| async move {
            if terminated {
                return None;
            }
            match events.next().await {
                Some(Ok(event)) => Some((
                    Ok::<Event, Infallible>(to_sse_event(event)),
                    (events, lag_run_id, false),
                )),
                Some(Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(
                    skipped,
                ))) => Some((
                    Ok::<Event, Infallible>(to_sse_event(lagged_run_event(&lag_run_id, skipped))),
                    (events, lag_run_id, true),
                )),
                None => None,
            }
        },
    )
}

fn lagged_run_event(run_id: &str, skipped: u64) -> RunEvent {
    RunEvent {
        kind: "resync-required".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        run_id: run_id.to_string(),
        payload: json!({
            "reason": "broadcast-lagged",
            "skippedEvents": skipped,
        }),
    }
}

fn to_sse_event(event: RunEvent) -> Event {
    let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    Event::default().event(event.kind).data(data)
}

async fn api_report_metrics(
    State(state): State<BenchmarkServerState>,
    Path(run_id): Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let manifest = state
        .orchestrator
        .get_run(&run_id)
        .await
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, format!("Run not found: {run_id}")))?;
    if manifest.status != RunStatus::Completed {
        return Err(json_error(
            StatusCode::CONFLICT,
            format!("Report is not durably completed for run: {run_id}"),
        ));
    }
    let path = FsPath::new(&manifest.run_paths.report_data_dir).join("metrics.json");
    serve_file(path.as_path()).await
}

async fn api_report_asset(
    State(state): State<BenchmarkServerState>,
    Path((run_id, asset)): Path<(String, String)>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let manifest = state
        .orchestrator
        .get_run(&run_id)
        .await
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, format!("Run not found: {run_id}")))?;
    if manifest.status != RunStatus::Completed {
        return Err(json_error(
            StatusCode::CONFLICT,
            format!("Report is not durably completed for run: {run_id}"),
        ));
    }

    let rel = sanitize_rel_path(if asset.is_empty() {
        "index.html"
    } else {
        &asset
    })
    .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "Invalid report asset path"))?;

    let runtime_path = FsPath::new(&manifest.run_paths.report_web_dir).join(&rel);

    if runtime_path.exists() && runtime_path.is_file() {
        return serve_file(runtime_path.as_path()).await;
    }
    Err(json_error(
        StatusCode::NOT_FOUND,
        format!("Report asset not found: {}", rel.display()),
    ))
}

async fn static_app_index(
    State(state): State<BenchmarkServerState>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    serve_file(state.app_web_dir.join("index.html").as_path()).await
}

async fn static_app_js(
    State(state): State<BenchmarkServerState>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    serve_file(state.app_web_dir.join("app.js").as_path()).await
}

async fn static_app_css(
    State(state): State<BenchmarkServerState>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    serve_file(state.app_web_dir.join("app.css").as_path()).await
}

async fn static_visualizer_asset(
    State(state): State<BenchmarkServerState>,
    Path(asset): Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let rel = sanitize_rel_path(asset.as_str())
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "Invalid visualizer asset path"))?;
    let path = state.visualizer_dir.join(rel);
    serve_file(path.as_path()).await
}

async fn static_info_asset(
    State(state): State<BenchmarkServerState>,
    Path(asset): Path<String>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let rel = sanitize_rel_path(asset.as_str())
        .ok_or_else(|| json_error(StatusCode::BAD_REQUEST, "Invalid info asset path"))?;
    let path = state.info_dir.join(rel);
    serve_file(path.as_path()).await
}

fn sanitize_rel_path(input: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for segment in input.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        // Reject backslashes outright: on Windows `PathBuf::push` treats
        // `\` as a separator, so a segment like `..\..\secret` would pass
        // the `..` check below yet still escape the asset root.
        if segment.contains('\\') {
            return None;
        }
        if segment == ".." {
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

async fn serve_file(path: &FsPath) -> Result<Response, (StatusCode, Json<Value>)> {
    let bytes = tokio::fs::read(path).await.map_err(|_| {
        json_error(
            StatusCode::NOT_FOUND,
            format!("File not found: {}", path.display()),
        )
    })?;

    let mime = mime_for_path(path);
    let mut resp = Response::new(Body::from(bytes));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    Ok(resp)
}

fn mime_for_path(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "cjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn extract_u64_after_key(text: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{key}\"");
    let idx = text.find(pattern.as_str())?;
    let after = &text[idx + pattern.len()..];
    let colon_idx = after.find(':')?;
    let tail = &after[colon_idx + 1..];
    let digits: String = tail
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u64>().ok()
}

fn read_oracle_window_from_metadata(path: &FsPath) -> Result<(u64, u64)> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut head = vec![0u8; 256 * 1024];
    let read = file
        .read(head.as_mut_slice())
        .with_context(|| format!("read {}", path.display()))?;
    head.truncate(read);
    let text = String::from_utf8_lossy(head.as_slice()).to_string();
    let start = extract_u64_after_key(text.as_str(), "startTimestamp")
        .ok_or_else(|| anyhow!("startTimestamp is missing in {}", path.display()))?;
    let end = extract_u64_after_key(text.as_str(), "endTimestamp")
        .ok_or_else(|| anyhow!("endTimestamp is missing in {}", path.display()))?;
    Ok((start, end))
}

fn resolve_common_oracle_window(data_dir: &FsPath) -> Result<(u64, u64)> {
    let eth_file = data_dir.join("eth-usd.json");
    let btc_file = data_dir.join("btc-usd.json");
    if !eth_file.exists() {
        return Err(anyhow!("Missing oracle file: {}", eth_file.display()));
    }
    if !btc_file.exists() {
        return Err(anyhow!("Missing oracle file: {}", btc_file.display()));
    }
    let (eth_start, eth_end) = read_oracle_window_from_metadata(eth_file.as_path())?;
    let (btc_start, btc_end) = read_oracle_window_from_metadata(btc_file.as_path())?;
    let start = eth_start.max(btc_start);
    let end = eth_end.min(btc_end);
    if end <= start {
        return Err(anyhow!(
            "Invalid oracle intersection window: start={} end={}",
            start,
            end
        ));
    }
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn lagged_sse_receiver_gets_explicit_resync_event() {
        let (tx, rx) = broadcast::channel(1);
        for n in 0..3 {
            tx.send(RunEvent {
                kind: "progress".to_string(),
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                run_id: "run_test".to_string(),
                payload: json!({ "percent": n }),
            })
            .expect("receiver stays subscribed");
        }

        let mut stream = BroadcastStream::new(rx);
        let skipped = match stream.next().await.expect("lag notification") {
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(skipped)) => {
                skipped
            }
            Ok(_) => panic!("slow receiver must report lag before the retained event"),
        };
        assert!(skipped > 0);

        let event = lagged_run_event("run_test", skipped);
        assert_eq!(event.kind, "resync-required");
        assert_eq!(event.payload["reason"], "broadcast-lagged");
        assert_eq!(event.payload["skippedEvents"], skipped);
    }

    #[tokio::test]
    async fn lagged_sse_response_ends_after_resync_instead_of_replaying_old_events() {
        let (tx, rx) = broadcast::channel(1);
        for n in 0..3 {
            tx.send(RunEvent {
                kind: "progress".to_string(),
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                run_id: "run_test".to_string(),
                payload: json!({ "percent": n }),
            })
            .expect("receiver stays subscribed");
        }
        let stream = recoverable_broadcast_stream(rx, "run_test".to_string());
        futures_util::pin_mut!(stream);
        assert!(
            stream.next().await.is_some(),
            "resync marker must be emitted"
        );
        assert!(
            stream.next().await.is_none(),
            "response must end so EventSource reconnects at a fresh snapshot boundary"
        );
    }
}
