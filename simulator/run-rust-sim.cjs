#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`[simulator] ${msg}`);
  process.exit(1);
}

const config = process.env.BENCHMARK_RUN_CONFIG_PATH;
if (!config) {
  fail("BENCHMARK_RUN_CONFIG_PATH is required (example: runs/<runId>/params.json)");
}

const output = process.env.BENCHMARK_RUST_OUTPUT || "checkpoints/sim_results.json";
const defaultDataDir = path.resolve(__dirname, "data");
const dataDir = process.env.BENCHMARK_ORACLE_DATA_DIR || defaultDataDir;

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveCargoBin() {
  const candidates = [];
  const explicit = process.env.CARGO_BIN || process.env.CARGO;
  if (explicit && String(explicit).trim().length > 0) {
    candidates.push(String(explicit).trim());
  }

  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    candidates.push(path.join(home, ".cargo", "bin", "cargo"));
    candidates.push(path.join(home, ".cargo", "bin", "cargo.exe"));
  }

  candidates.push("/usr/local/bin/cargo");
  candidates.push("/usr/bin/cargo");
  candidates.push("cargo");

  for (const candidate of candidates) {
    if (!candidate.includes(path.sep)) {
      return { bin: candidate, tried: candidates };
    }
    if (existsFile(candidate)) {
      return { bin: candidate, tried: candidates };
    }
  }

  return { bin: "cargo", tried: candidates };
}

const simArgs = [
  "--config",
  config,
  "--output",
  output,
  "--data-dir",
  dataDir,
];

if (process.env.BENCHMARK_NO_CURVE === "1") {
  simArgs.push("--no-curve");
}

if (process.env.BENCHMARK_ONLY_AMMS) {
  simArgs.push("--only-amms", process.env.BENCHMARK_ONLY_AMMS);
}

if (process.env.BENCHMARK_ONLY_BASES) {
  simArgs.push("--only-bases", process.env.BENCHMARK_ONLY_BASES);
}

if (process.env.BENCHMARK_DURATION) {
  simArgs.push("--duration-sec", process.env.BENCHMARK_DURATION);
}

if (process.env.BENCHMARK_DISABLE_EQUILIBRA_RECENTER === "1") {
  simArgs.push("--disable-equilibra-recenter");
}

if (process.env.BENCHMARK_DISABLE_CURVE_REBALANCE === "1") {
  simArgs.push("--disable-curve-rebalance");
}

function resolveSimulatorBin() {
  const explicit = process.env.BENCHMARK_RUST_BIN;
  if (explicit && existsFile(explicit)) {
    return explicit;
  }

  const binName =
    process.platform === "win32"
      ? "equilibra-offchain-simulator.exe"
      : "equilibra-offchain-simulator";
  const localDefault = path.join("simulator", "target", "release", binName);
  if (existsFile(localDefault)) {
    return localDefault;
  }

  return null;
}

const resolved = resolveCargoBin();
const cargoBin = resolved.bin;
const home = process.env.HOME || process.env.USERPROFILE;
const cargoHomeBin = home ? path.join(home, ".cargo", "bin") : "";
const env = { ...process.env };
if (!env.CARGO_TERM_PROGRESS_WHEN) {
  env.CARGO_TERM_PROGRESS_WHEN = "never";
}
if (!env.CARGO_TERM_COLOR) {
  env.CARGO_TERM_COLOR = "never";
}
if (cargoHomeBin) {
  const currentPath = env.PATH || "";
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  if (!parts.includes(cargoHomeBin)) {
    env.PATH = `${cargoHomeBin}${currentPath ? path.delimiter : ""}${currentPath}`;
  }
}

const directBin = resolveSimulatorBin();
const useDirectBin =
  process.env.BENCHMARK_RUST_USE_DIRECT_BIN === "1" ||
  (process.env.BENCHMARK_RUST_BIN && process.env.BENCHMARK_RUST_BIN.length > 0);

if (useDirectBin) {
  if (!directBin) {
    fail(
      "BENCHMARK_RUST_USE_DIRECT_BIN=1 but simulator binary is missing. " +
        "Run `cargo build --manifest-path simulator/Cargo.toml --release` first."
    );
  }

  const direct = spawnSync(directBin, simArgs, { stdio: "inherit", shell: false, env });
  if (direct.error) {
    if (direct.error.code === "ENOENT") {
      fail(`simulator binary not found: ${directBin}`);
    }
    fail(`failed to start simulator binary (${directBin}): ${direct.error.message}`);
  }
  if (direct.status !== 0) {
    process.exit(direct.status || 1);
  }
  process.exit(0);
}

const cargoArgs = [
  "run",
  "--manifest-path",
  path.join("simulator", "Cargo.toml"),
  "--bin",
  "equilibra-offchain-simulator",
  "--release",
  "--quiet",
  "--",
  ...simArgs,
];
const run = spawnSync(cargoBin, cargoArgs, { stdio: "inherit", shell: false, env });
if (run.error) {
  if (run.error.code === "ENOENT") {
    fail(
      "cargo is not installed or not in PATH. Install Rust toolchain (rustup), then restart benchmark:app.\n" +
        `Tried cargo candidates: ${resolved.tried.join(", ")}\n` +
        "Ubuntu quick install:\n" +
        "  curl https://sh.rustup.rs -sSf | sh -s -- -y\n" +
        "  source $HOME/.cargo/env\n" +
        "  rustc --version && cargo --version"
    );
  }
  fail(`failed to start cargo (${cargoBin}): ${run.error.message}`);
}
if (run.status !== 0) {
  process.exit(run.status || 1);
}
