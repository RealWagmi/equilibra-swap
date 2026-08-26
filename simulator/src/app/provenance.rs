use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const ORACLE_SNAPSHOT_VERSION: &str = "oracle-snapshot/v1";
pub const EXECUTION_PROVENANCE_VERSION: &str = "execution-provenance/v1";
// v2: `resultDigest` is the canonical content digest
// (`common::canonical_result_digest`) in both report paths.
pub const REPORT_ALGORITHM_VERSION: &str = "equilibra-report/v2";
pub const ORACLE_FILE_NAMES: [&str; 2] = ["btc-usd.json", "eth-usd.json"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDigest {
    pub file_name: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleSnapshot {
    pub version: String,
    pub files: Vec<FileDigest>,
    pub oracle_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EffectiveExecutionOptions {
    pub mode: String,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub duration_sec: Option<u64>,
    pub no_curve: bool,
    pub disable_equilibra_recenter: bool,
    pub disable_curve_rebalance: bool,
    pub arbitrage_enabled: bool,
    pub selected_amms: Vec<String>,
    pub selected_bases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BinaryArtifactDigest {
    pub role: String,
    pub file_name: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionProvenanceMaterial {
    pub version: String,
    pub config_hash: String,
    pub oracle_snapshot: OracleSnapshot,
    pub effective_options: EffectiveExecutionOptions,
    /// Exact config hash expected from every execution partition. Keys are
    /// canonical `amm:base` context names in both dashboard and standalone
    /// modes. This prevents a shard from changing fee/preset values while
    /// merely copying the parent's fingerprint label.
    pub partition_config_hashes: BTreeMap<String, String>,
    pub binaries: Vec<BinaryArtifactDigest>,
    /// Content digest of the report-web asset tree consumed at report time.
    pub report_assets_digest: String,
    pub actor_algorithm_version: String,
    pub result_format_version: String,
    pub report_algorithm_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionProvenance {
    pub material: ExecutionProvenanceMaterial,
    pub execution_fingerprint: String,
}

impl ExecutionProvenance {
    pub fn new(mut material: ExecutionProvenanceMaterial) -> Result<Self> {
        normalize_material(&mut material);
        validate_material(&material)?;
        let execution_fingerprint = sha256_bytes(&serde_json::to_vec(&material)?);
        Ok(Self {
            material,
            execution_fingerprint,
        })
    }

    pub fn verify(&self) -> Result<()> {
        let rebuilt = Self::new(self.material.clone())?;
        if rebuilt.execution_fingerprint != self.execution_fingerprint {
            return Err(anyhow!(
                "execution provenance fingerprint mismatch: declared={}, computed={}",
                self.execution_fingerprint,
                rebuilt.execution_fingerprint
            ));
        }
        Ok(())
    }
}

pub fn load_execution_provenance(path: &Path) -> Result<ExecutionProvenance> {
    let raw =
        fs::read(path).with_context(|| format!("read execution manifest {}", path.display()))?;
    let provenance: ExecutionProvenance = serde_json::from_slice(&raw)
        .with_context(|| format!("parse execution manifest {}", path.display()))?;
    provenance
        .verify()
        .with_context(|| format!("verify execution manifest {}", path.display()))?;
    Ok(provenance)
}

pub fn verify_binary_artifact(
    provenance: &ExecutionProvenance,
    role: &str,
    path: &Path,
) -> Result<()> {
    let expected = provenance
        .material
        .binaries
        .iter()
        .find(|entry| entry.role == role)
        .ok_or_else(|| anyhow!("execution manifest has no binary with role '{role}'"))?;
    let actual = binary_digest(role, path)?;
    if &actual != expected {
        return Err(anyhow!(
            "binary provenance mismatch for role '{role}' at {}: expected sha256={} bytes={}, got sha256={} bytes={}",
            path.display(),
            expected.sha256,
            expected.byte_length,
            actual.sha256,
            actual.byte_length
        ));
    }
    Ok(())
}

fn normalize_material(material: &mut ExecutionProvenanceMaterial) {
    material.effective_options.selected_amms.sort_unstable();
    material.effective_options.selected_amms.dedup();
    material.effective_options.selected_bases.sort_unstable();
    material.effective_options.selected_bases.dedup();
    material.binaries.sort_by(|a, b| {
        a.role
            .cmp(&b.role)
            .then_with(|| a.file_name.cmp(&b.file_name))
    });
}

fn validate_material(material: &ExecutionProvenanceMaterial) -> Result<()> {
    if material.version != EXECUTION_PROVENANCE_VERSION {
        return Err(anyhow!(
            "unsupported execution provenance version '{}' (expected '{}')",
            material.version,
            EXECUTION_PROVENANCE_VERSION
        ));
    }
    if !is_sha256(&material.config_hash)
        || material.actor_algorithm_version.is_empty()
        || material.result_format_version.is_empty()
        || material.report_algorithm_version.is_empty()
        || !is_sha256(&material.report_assets_digest)
    {
        return Err(anyhow!(
            "execution provenance contains an empty required version/hash field"
        ));
    }
    if material.effective_options.end_timestamp <= material.effective_options.start_timestamp {
        return Err(anyhow!(
            "invalid effective execution window {}..{}",
            material.effective_options.start_timestamp,
            material.effective_options.end_timestamp
        ));
    }
    if material.binaries.is_empty() {
        return Err(anyhow!(
            "execution provenance must identify at least one executable"
        ));
    }
    if material.partition_config_hashes.is_empty() {
        return Err(anyhow!(
            "execution provenance must contain at least one partition config hash"
        ));
    }
    for (partition, hash) in &material.partition_config_hashes {
        if partition.is_empty() || !is_sha256(hash) {
            return Err(anyhow!("invalid partition config hash for '{partition}'"));
        }
    }
    let mut roles = std::collections::BTreeSet::new();
    for binary in &material.binaries {
        if binary.role.is_empty()
            || binary.file_name.is_empty()
            || !is_sha256(&binary.sha256)
            || !roles.insert(binary.role.as_str())
        {
            return Err(anyhow!(
                "execution provenance contains an invalid or duplicate binary role '{}': {}",
                binary.role,
                binary.file_name
            ));
        }
    }
    verify_oracle_descriptor(&material.oracle_snapshot)
}

fn verify_oracle_descriptor(snapshot: &OracleSnapshot) -> Result<()> {
    if snapshot.version != ORACLE_SNAPSHOT_VERSION {
        return Err(anyhow!(
            "unsupported oracle snapshot version '{}' (expected '{}')",
            snapshot.version,
            ORACLE_SNAPSHOT_VERSION
        ));
    }
    let expected_names = ORACLE_FILE_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    let actual_names = snapshot
        .files
        .iter()
        .map(|entry| entry.file_name.clone())
        .collect::<Vec<_>>();
    if actual_names != expected_names {
        return Err(anyhow!(
            "oracle snapshot files mismatch: expected {:?}, got {:?}",
            expected_names,
            actual_names
        ));
    }
    if snapshot.files.iter().any(|entry| !is_sha256(&entry.sha256))
        || !is_sha256(&snapshot.oracle_digest)
    {
        return Err(anyhow!(
            "oracle descriptor contains a malformed SHA-256 digest"
        ));
    }
    let expected_digest = oracle_digest(&snapshot.files)?;
    if expected_digest != snapshot.oracle_digest {
        return Err(anyhow!(
            "oracle descriptor digest mismatch: declared={}, computed={}",
            snapshot.oracle_digest,
            expected_digest
        ));
    }
    Ok(())
}

pub fn hash_file(path: &Path) -> Result<FileDigest> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("stat provenance input {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(anyhow!(
            "provenance input {} must be a regular non-symlink file",
            path.display()
        ));
    }
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut byte_length = 0u64;
    let mut buf = [0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .with_context(|| format!("hash {}", path.display()))?;
        if read == 0 {
            break;
        }
        byte_length = byte_length
            .checked_add(read as u64)
            .ok_or_else(|| anyhow!("file length overflow while hashing {}", path.display()))?;
        hasher.update(&buf[..read]);
    }
    Ok(FileDigest {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| anyhow!("non-UTF8 provenance file name: {}", path.display()))?
            .to_string(),
        byte_length,
        sha256: hex_digest(hasher.finalize().as_slice()),
    })
}

pub fn binary_digest(role: &str, path: &Path) -> Result<BinaryArtifactDigest> {
    if role.trim().is_empty() {
        return Err(anyhow!("binary provenance role must not be empty"));
    }
    let file = hash_file(path)?;
    Ok(BinaryArtifactDigest {
        role: role.to_string(),
        file_name: file.file_name,
        byte_length: file.byte_length,
        sha256: file.sha256,
    })
}

pub fn inspect_oracle_dir(dir: &Path) -> Result<OracleSnapshot> {
    let metadata = fs::symlink_metadata(dir)
        .with_context(|| format!("stat oracle directory {}", dir.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "oracle path {} must be a non-symlink directory",
            dir.display()
        ));
    }
    let mut files = Vec::with_capacity(ORACLE_FILE_NAMES.len());
    for file_name in ORACLE_FILE_NAMES {
        files.push(hash_file(&dir.join(file_name))?);
    }
    let oracle_digest = oracle_digest(&files)?;
    let snapshot = OracleSnapshot {
        version: ORACLE_SNAPSHOT_VERSION.to_string(),
        files,
        oracle_digest,
    };
    verify_oracle_descriptor(&snapshot)?;
    Ok(snapshot)
}

pub fn oracle_snapshot_from_bytes(
    files_by_name: &BTreeMap<String, Vec<u8>>,
) -> Result<OracleSnapshot> {
    let expected_names = ORACLE_FILE_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    if files_by_name.keys().cloned().collect::<Vec<_>>() != expected_names {
        return Err(anyhow!(
            "oracle byte inputs must contain exactly {:?}",
            expected_names
        ));
    }
    let files = files_by_name
        .iter()
        .map(|(file_name, bytes)| FileDigest {
            file_name: file_name.clone(),
            byte_length: bytes.len() as u64,
            sha256: sha256_bytes(bytes),
        })
        .collect::<Vec<_>>();
    let snapshot = OracleSnapshot {
        version: ORACLE_SNAPSHOT_VERSION.to_string(),
        oracle_digest: oracle_digest(&files)?,
        files,
    };
    verify_oracle_descriptor(&snapshot)?;
    Ok(snapshot)
}

/// Hash a directory as a sorted list of `(relative path, file digest)`.
/// Symlinks and non-regular entries are rejected so the digest cannot change
/// meaning through path indirection between fingerprinting and consumption.
pub fn hash_directory_tree(root: &Path) -> Result<String> {
    hash_directory_tree_filtered(root, None)
}

/// Hash report template assets while excluding the generated top-level
/// `data/` directory. The source template has no data today, but the copied
/// staging tree does; both therefore yield the same digest.
pub fn hash_report_assets_dir(root: &Path) -> Result<String> {
    hash_directory_tree_filtered(root, Some("data"))
}

fn hash_directory_tree_filtered(root: &Path, skip_top_level_dir: Option<&str>) -> Result<String> {
    let metadata = fs::symlink_metadata(root)
        .with_context(|| format!("stat directory tree {}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(anyhow!(
            "directory tree root {} must be a non-symlink directory",
            root.display()
        ));
    }
    fn collect(
        root: &Path,
        dir: &Path,
        skip_top_level_dir: Option<&str>,
        out: &mut Vec<(String, FileDigest)>,
    ) -> Result<()> {
        let mut entries = fs::read_dir(dir)
            .with_context(|| format!("read directory {}", dir.display()))?
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if dir == root && skip_top_level_dir.is_some_and(|skip| entry.file_name() == skip) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)
                .with_context(|| format!("stat tree entry {}", path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(anyhow!(
                    "symlink is not allowed in hashed tree: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                collect(root, &path, skip_top_level_dir, out)?;
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .expect("collected path is below root")
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((relative, hash_file(&path)?));
            } else {
                return Err(anyhow!(
                    "non-regular entry is not allowed in hashed tree: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    collect(root, root, skip_top_level_dir, &mut entries)?;
    Ok(sha256_bytes(&serde_json::to_vec(&entries)?))
}

pub fn verify_oracle_dir(dir: &Path, expected: &OracleSnapshot) -> Result<()> {
    verify_oracle_descriptor(expected)?;
    let actual = inspect_oracle_dir(dir)?;
    if &actual != expected {
        return Err(anyhow!(
            "oracle snapshot at {} no longer matches its descriptor: expected digest {}, got {}",
            dir.display(),
            expected.oracle_digest,
            actual.oracle_digest
        ));
    }
    Ok(())
}

fn oracle_digest(files: &[FileDigest]) -> Result<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DigestMaterial<'a> {
        version: &'a str,
        files: &'a [FileDigest],
    }
    Ok(sha256_bytes(&serde_json::to_vec(&DigestMaterial {
        version: ORACLE_SNAPSHOT_VERSION,
        files,
    })?))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_digest(hasher.finalize().as_slice())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

fn sync_directory(dir: &Path) -> Result<()> {
    match File::open(dir).and_then(|file| file.sync_all()) {
        Ok(()) => Ok(()),
        Err(err) if is_unsupported_dir_sync(&err) => Ok(()),
        Err(err) => Err(err).with_context(|| format!("sync directory {}", dir.display())),
    }
}

// NOTE: run results are fingerprinted exclusively by
// `common::canonical_result_digest` — do not add a second generic
// JSON-stream hasher here; a second definition makes the recorded
// digest ambiguous.

/// `Path::parent()` returns an empty path for a plain basename. Treat that as
/// the current directory so callers can safely accept `--output result.json`.
pub fn parent_dir_or_current(path: &Path) -> &Path {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    }
}

pub fn create_directory_all_durable(dir: &Path) -> Result<()> {
    let mut cursor = dir;
    let mut to_sync = Vec::<PathBuf>::new();
    while !cursor.exists() {
        to_sync.push(cursor.to_path_buf());
        cursor = match cursor.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
    }
    fs::create_dir_all(dir)
        .with_context(|| format!("create durable JSON directory {}", dir.display()))?;
    if !to_sync.is_empty() {
        // Persist every newly-created directory entry, including the first
        // one in the previously-existing ancestor. The final file rename
        // below separately fsyncs `dir` after publishing the JSON file.
        for created in &to_sync {
            sync_directory(created)?;
        }
        sync_directory(cursor)?;
    }
    Ok(())
}

pub fn persist_json_durable<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = parent_dir_or_current(path);
    create_directory_all_durable(parent)?;
    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}-{seq}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("json"),
        std::process::id()
    ));
    let result = (|| -> Result<()> {
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .with_context(|| format!("create durable JSON temp {}", tmp.display()))?;
        let mut writer = std::io::BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, value)
            .with_context(|| format!("serialize durable JSON {}", tmp.display()))?;
        writer
            .flush()
            .with_context(|| format!("flush durable JSON temp {}", tmp.display()))?;
        writer
            .get_ref()
            .sync_all()
            .with_context(|| format!("sync durable JSON temp {}", tmp.display()))?;
        drop(writer);
        fs::rename(&tmp, path)
            .with_context(|| format!("publish durable JSON {}", path.display()))?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

pub fn derive_report_fingerprint(
    execution_fingerprint: &str,
    result_digest: &str,
    report_generator_sha256: &str,
    report_assets_digest: &str,
) -> Result<String> {
    if !is_sha256(execution_fingerprint)
        || !is_sha256(result_digest)
        || !is_sha256(report_generator_sha256)
        || !is_sha256(report_assets_digest)
    {
        return Err(anyhow!(
            "report fingerprint inputs must be lowercase SHA-256 digests"
        ));
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ReportFingerprintMaterial<'a> {
        report_algorithm_version: &'a str,
        execution_fingerprint: &'a str,
        result_digest: &'a str,
        report_generator_sha256: &'a str,
        report_assets_digest: &'a str,
    }
    Ok(sha256_bytes(&serde_json::to_vec(
        &ReportFingerprintMaterial {
            report_algorithm_version: REPORT_ALGORITHM_VERSION,
            execution_fingerprint,
            result_digest,
            report_generator_sha256,
            report_assets_digest,
        },
    )?))
}

fn is_unsupported_dir_sync(err: &std::io::Error) -> bool {
    match err.kind() {
        ErrorKind::Unsupported | ErrorKind::InvalidInput => true,
        #[cfg(windows)]
        ErrorKind::PermissionDenied => true,
        _ => false,
    }
}

pub fn execution_manifest_path(run_root: &Path) -> PathBuf {
    run_root.join("inputs").join("execution.json")
}

/// Resolve the window that is part of the execution fingerprint. Oracle
/// coverage is fail-closed: silently clipping a requested interval would
/// make the same params.json identify two different scenarios.
pub fn resolve_effective_window(
    requested_start: u64,
    requested_end: u64,
    oracle_start: u64,
    oracle_end: u64,
    duration_sec: Option<u64>,
) -> Result<(u64, u64)> {
    if requested_end <= requested_start {
        return Err(anyhow!(
            "invalid requested simulation window {requested_start}..{requested_end}"
        ));
    }
    let effective_end = match duration_sec {
        Some(0) => return Err(anyhow!("--duration-sec must be greater than zero")),
        Some(duration) => requested_end.min(
            requested_start
                .checked_add(duration)
                .ok_or_else(|| anyhow!("--duration-sec overflows the simulation timestamp"))?,
        ),
        None => requested_end,
    };
    if effective_end <= requested_start {
        return Err(anyhow!(
            "invalid effective simulation window {requested_start}..{effective_end}"
        ));
    }
    if requested_start < oracle_start || effective_end > oracle_end {
        return Err(anyhow!(
            "effective simulation window {requested_start}..{effective_end} is not fully covered by immutable oracle range {oracle_start}..{oracle_end}; refusing silent clipping"
        ));
    }
    Ok((requested_start, effective_end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "equilibra-provenance-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write_oracle_fixture(dir: &Path) {
        fs::create_dir_all(dir).expect("create fixture dir");
        for name in ORACLE_FILE_NAMES {
            fs::write(
                dir.join(name),
                format!("{{\"points\":[{{\"t\":1,\"p\":1}}],\"name\":\"{name}\"}}"),
            )
            .expect("write fixture");
        }
    }

    #[test]
    fn durable_json_accepts_a_plain_basename() {
        static BASENAME_SEQ: AtomicU64 = AtomicU64::new(0);
        let path = PathBuf::from(format!(
            ".equilibra-durable-basename-{}-{}.json",
            std::process::id(),
            BASENAME_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        assert_eq!(parent_dir_or_current(&path), Path::new("."));
        persist_json_durable(&path, &serde_json::json!({ "ok": true })).expect("persist basename");
        let parsed: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read basename"))
                .expect("parse basename");
        assert_eq!(parsed["ok"], true);
        fs::remove_file(path).expect("cleanup basename");
    }

    #[test]
    fn oracle_digest_is_content_addressed_and_detects_mutation() {
        let root = unique_temp_dir("oracle");
        let source = root.join("source");
        write_oracle_fixture(&source);

        // The shared feed is digested in place — never copied. The same
        // descriptor must verify against unchanged bytes and fail closed
        // the moment any feed file is rewritten.
        let descriptor = inspect_oracle_dir(&source).expect("digest oracle dir");
        verify_oracle_dir(&source, &descriptor).expect("verify unchanged feed");
        fs::write(source.join("eth-usd.json"), "changed").expect("mutate feed");
        assert!(verify_oracle_dir(&source, &descriptor).is_err());

        fs::remove_dir_all(root).expect("cleanup fixture");
    }

    #[test]
    fn fingerprint_is_order_independent_for_set_like_fields() {
        let oracle = OracleSnapshot {
            version: ORACLE_SNAPSHOT_VERSION.to_string(),
            files: ORACLE_FILE_NAMES
                .iter()
                .map(|name| FileDigest {
                    file_name: (*name).to_string(),
                    byte_length: 1,
                    sha256: "a".repeat(64),
                })
                .collect(),
            oracle_digest: String::new(),
        };
        let mut oracle = oracle;
        oracle.oracle_digest = oracle_digest(&oracle.files).expect("oracle digest");
        let material = ExecutionProvenanceMaterial {
            version: EXECUTION_PROVENANCE_VERSION.to_string(),
            config_hash: "e".repeat(64),
            oracle_snapshot: oracle,
            effective_options: EffectiveExecutionOptions {
                mode: "standalone".to_string(),
                start_timestamp: 1,
                end_timestamp: 2,
                duration_sec: None,
                no_curve: false,
                disable_equilibra_recenter: false,
                disable_curve_rebalance: false,
                arbitrage_enabled: true,
                selected_amms: vec!["uniswapV2".to_string(), "equilibra".to_string()],
                selected_bases: vec!["WETH".to_string(), "WBTC".to_string()],
            },
            partition_config_hashes: BTreeMap::from([("standalone".to_string(), "c".repeat(64))]),
            binaries: vec![BinaryArtifactDigest {
                role: "simulator".to_string(),
                file_name: "sim".to_string(),
                byte_length: 1,
                sha256: "b".repeat(64),
            }],
            report_assets_digest: "d".repeat(64),
            actor_algorithm_version: "actor/v1".to_string(),
            result_format_version: "result/v1".to_string(),
            report_algorithm_version: REPORT_ALGORITHM_VERSION.to_string(),
        };
        let first = ExecutionProvenance::new(material.clone()).expect("first provenance");
        let mut reordered = material;
        reordered.effective_options.selected_amms.reverse();
        reordered.effective_options.selected_bases.reverse();
        let second = ExecutionProvenance::new(reordered).expect("second provenance");
        assert_eq!(first.execution_fingerprint, second.execution_fingerprint);
        first.verify().expect("verify fingerprint");
    }

    #[test]
    fn effective_window_rejects_oracle_clipping_and_materializes_duration() {
        assert!(resolve_effective_window(99, 200, 100, 200, None).is_err());
        assert!(resolve_effective_window(100, 201, 100, 200, None).is_err());
        assert_eq!(
            resolve_effective_window(100, 200, 100, 200, Some(25)).expect("duration"),
            (100, 125)
        );
        assert_eq!(
            resolve_effective_window(1, 100, 1, 10, Some(9)).expect("short covered duration"),
            (1, 10)
        );
        assert!(resolve_effective_window(100, 200, 100, 200, Some(0)).is_err());
    }
}
