# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

EquilibraSwap is a two-knob cubic AMM with asymmetric (quote-side
normalised) math-space coordinates:

```
priceScaleWad = yWad / xWad  at the anchor          (quote / base, WAD)

xMath = xWad                                        (base, identity)
yMath = yWad · WAD / priceScaleWad                  (quote → base units)

K(x, y; L) = A · L · (x + y) / 2 + (W − A) · xy
A          = a · W / (W + λ · D)
D          = (y − x)² / (xy)
W          = WAD = 1e18
```

- **Solidity stack** (pool, factory, router, oracle, lp-token, mocks)
  is the production surface. `EquilibraPool` runtime bytecode is
  24,471 bytes / 24,576 bytes (`optimizer.runs = 2000`, `viaIR = true`,
  `metadata.appendCBOR = true`, `evmVersion = "cancun"`).
- **Test suite**: run `npm run test:ci` for the non-interactive full
  Solidity suite. Security tests (`test/security/*`)
  covers every attacker-perspective scenario — round-trip, batching,
  LP-flux, cross-anchor, repeg conservation, callback misuse,
  fee splittability.
- **Rust library** (`runtime_quoter::{equilibra_math, equilibra}`,
  `app::config`, `app::visualizer`) mirrors the Solidity math
  bit-for-bit. Validate with `cargo build --release` and
  `cargo test --release --lib`; avoid hard-coding counts here because
  they change whenever a regression case is added.
- **Cross-language parity**: `test/simparity/*` enforces Solidity ==
  Rust at wei resolution — 16 tests across WETH/WBTC presets, both
  swap directions, exact-in/exact-out paths, ramp/opt-out modes.
- **Dashboard**: `simulator/app-web/` (Runs / Setup / Curve Lab) +
  standalone `simulator/visualizer/` + Curve-Lab-style `simulator/Info/`
  page served at `/info`. The visualizer has independent
  `aWad` and `lambdaWad` sliders.

## Build & Test Commands

```bash
npm run compile       # Clean and compile Solidity contracts (solc 0.8.36, viaIR, evm cancun)
npm test              # Interactive menu: pick a section (default = math + periphery + security)
npm run coverage      # Solidity coverage report (sets SOLIDITY_COVERAGE=true → compiles WITHOUT viaIR)
npm run lint-fix      # Format .sol and .ts files (prettier + prettier-plugin-solidity)
```

> Coverage compiles through the legacy (non-viaIR) codegen, so every
> contract must stay within the 16-slot EVM stack limit on BOTH
> pipelines — several hot functions sit at 0–1 slots of headroom. After
> touching pool / library / router internals, run
> `SOLIDITY_COVERAGE=true npx hardhat compile`; on `Stack too deep`,
> scope short-lived locals into `{ ... }` blocks instead of re-enabling
> viaIR. Coverage builds also flip `optimizer.runs` to 1, which keeps
> even the un-instrumented legacy `EquilibraPool` under EIP-170. The
> in-process test network lifts the size cap unconditionally
> (`allowUnlimitedContractSize`) because the internals-exposing
> `MockEquilibraPool` legitimately exceeds it, so the deployable viaIR
> build's 24,576-byte ceiling is pinned by an explicit artifact-size
> assertion instead (`test/security/BytecodeSize.test.ts`).
>
> Solady's ~250 deprecation warnings on 0.8.36 (`memory-safe-assembly`
> NatSpec comments, the `at` identifier) are suppressed by a small
> subtask filter in `hardhat.config.ts` (drops warnings from `solady/*`
> sources plus solc's location-less 256-warnings cap notice, code 4591;
> no plugin dependency). Warnings from `contracts/` still print — a
> clean compile is silent.

Run a single test file:

```bash
npx hardhat test test/security/DynamicFee.test.ts
```

Run a specific test by name:

```bash
npx hardhat test --grep "matches on-chain for every size"
```

Notable suites that are not part of the default `npm test` glob:

```bash
# Liquidity event behaviour (proportional add/remove, EIP-2612 permit, router flows).
npx hardhat test 'test/liquidity/*.test.ts'

# Bit-exact parity between the Solidity pool and the Rust simulator quoter.
# Requires a local cargo toolchain (Rust ≥ 1.74). The test harness shells out
# to `cargo run --release -p equilibra-offchain-simulator -- --trace-input ...`.
npx hardhat test test/simparity/GeneralRustParity.test.ts
npx hardhat test test/simparity/DynamicFeeRustParity.test.ts
```

### Scripts

Three scripts live under `scripts/`:

```bash
# Interactive test runner (the `npm test` entry point).
# Lists each section under test/ as a numbered choice; default (1) runs
# math + periphery + security. Accepts a positional shortcut so CI / muscle
# memory can skip the prompt: `npm test -- math`, `npm test -- security`,
# `npm test -- all`, or `npm test -- 5`. Falls back to "default" silently
# when stdin is not a TTY.
npm test

# Deployment is split into three idempotent steps. All non-secret
# parameters (WETH9, fee collector, protocol fee, pool specs) live in
# scripts/deploy/config.ts under git review; .env holds only
# credentials (see .env.example). Addresses land in the git-tracked
# deployments/<network>.json (local dev chains write gitignored
# deployments/local-*.json instead).
npm run deploy --network=<hardhat-network>          # core: impl + factory (+timelock) + router, then verify
npm run deploy:pools --network=<hardhat-network>    # create+seed pools declared in config (idempotent by name)
npm run deploy:verify --network=<hardhat-network>   # re-run verification from the document (Sourcify + explorer)

# Fetch / extend the Binance ETH-USD + BTC-USD oracle feeds at
# simulator/data/{eth-usd.json, btc-usd.json}. Idempotent: only candles
# strictly newer than the existing last point are pulled, then the file
# is rewritten atomically. Re-run any time to extend the tail to "now".
#   BENCHMARK_BINANCE_END_TS=<unix-seconds>  pin a fixed end (default: "now")
#   BENCHMARK_BINANCE_FORCE=1                clean re-download from scratch
npm run simulator:fetch-prices
```

### Off-chain simulator (Rust)

The reference quoter and the multi-AMM benchmark live in `simulator/`. Always
run the release profile — the codebase is performance-sensitive (fat LTO,
`codegen-units = 1`, `opt-level = 3`):

```bash
cargo build --release -p equilibra-offchain-simulator
cargo test  --release -p equilibra-offchain-simulator
```

Run `cargo fmt` (from `simulator/`) after touching Rust sources — CI
enforces `cargo fmt --manifest-path simulator/Cargo.toml -- --check`,
and `npm run lint-fix` covers only `.sol` / `.ts` files.

Convenience aliases defined in `package.json` (each is a thin wrapper around
the cargo invocation, all pinned to `--release`):

```bash
npm run simulator:run     # cargo run --bin equilibra-offchain-app --release  (dashboard at :3100)
npm run simulator:test    # cargo test --release  (Rust unit + parity tests)
npm run simulator:clean   # cargo clean  (force a fresh rebuild on the next run)
```

Useful helper binaries (all under `simulator/src/bin/`):

| Binary                                | Purpose                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `equilibra-offchain-simulator`        | Main benchmark / trace runner (default `cargo run`).                     |
| `equilibra-offchain-config-defaults`  | Emit the full typed canonical config plus reference test prices as JSON. |
| `equilibra-offchain-merge`            | Verify and merge shard results, digest the merged result in memory (no raw-result file is written), then atomically publish the report bundle. Every shard must use the same `--execution-manifest` and the same shared oracle directory (verified by content digest); a bare `--origin-config-hash` is rejected. |
| `equilibra-offchain-report`           | Regenerate an atomic report bundle from a kept `sim_results.json` plus its run-local `execution.json`. The shared oracle directory is re-verified by digest — regeneration fails closed if the consumed window was rewritten. Orchestrated runs prune their raw result after the report, so regeneration applies to standalone runs. |
| `equilibra-offchain-app`              | Local dashboard server (`app-web/`, `visualizer/`, `report-web/`).       |

The Rust simulator is the **canonical reference** for the on-chain math: every
Solidity update that touches `EquilibraPool`/`EquilibraSwapMath` is expected
to keep the bit-for-bit parity tests green (`test/simparity/`). The Rust
quoter sources live in `simulator/src/runtime_quoter/`:

- `equilibra.rs` — stateful Equilibra pool that mirrors the on-chain
  reserves, anchor, geometric EMA, the log-domain repeg step with its
  halving ladder and direction-split dead-bands, the LP-unit-value
  accounting trio (`lp_unit_value_genesis_wad`, `lp_unit_value_wad`,
  `lp_value_growth_wad`) and the smoothstep dynamic fee.
- `equilibra_math.rs` — the math kernel (closed-form invariant,
  `solveLFromState` quadratic, secant exact-in / exact-out solvers,
  `smoothstep_fee_wad`, balanced-depth recovery `2·L`, plus the
  fixed-point transcendentals `ln_wad` / `exp_pos_wad` and
  `geometric_ema_step` that keep the oracle bit-for-bit with
  Solady's `lnWad` / `expWad`).
- `curve.rs` — Curve twocrypto port used as a baseline. Mirrors the
  live 2026-05 version (reference pools 0x6563…b9f3 / 0x3136…729a): the
  twocrypto shell (price_scale transform, tweak_price, dynamic fee)
  over a **StableswapMath invariant** — the live pools inject
  `StableswapMath` as the MATH contract and their stored `gamma` is
  unused compatibility filler, hence `math_mode: "stableswap"` is the
  faithful default (the crypto kernel stays available for research).
  `price_scale` moves by `min(norm/5, adjustment_step_max)` at most
  once per block, gated by the LP-protected profit floor
  `lp_xcp_profit` (accrues `reserved_profit_fraction` of growth);
  `adjustment_step_min` is the dust dead-band; the EMA spot cap is
  symmetric `[ps/2, 2ps]`. Donation shares ARE modelled: the simulator
  streams quote-side donations into the pool's donation buffer at the
  preset's `donationAprBps` of pool TVL per year (one event every
  `donationIntervalSec`), shares unlock linearly over 7 days
  (protection factor included), boost the rebalance trigger via
  `vp_boosted = xcp / locked_supply`, and are burned at commit to lift
  the post-move vp back to `max(lp_xcp_profit, vp)`. Only the external
  policy hook of the live pools is not modelled.
- `uniswap_v2.rs` — constant-product reference for the benchmark.

### Simulator configuration — single source of truth

`simulator/src/app/config.rs` is the authoritative definition of every
default the off-chain stack uses. Treat it as **the** source of truth: if
a number lives in two places (this file and a TS / JSON / UI default),
this file wins. It owns three things:

1. **The `BenchmarkRunConfig` schema** (`#[derive(Serialize, Deserialize)]`),
   including the per-AMM presets (`EquilibraPresetCfg`, `CurvePresetCfg`,
   `UniswapV2AmmCfg`), arbitrageur knobs (`gas_used_estimates`,
   `post_arb_external_swaps`), report-only policies, simulation window,
   parallelism and the
   dynamic-fee triple (`fee_ramp_bps`, `fee_floor_bps`,
   `repeg_share_bps`). All Equilibra preset fields are strictly
   required; unknown fields are rejected recursively and partial JSON is
   rejected at parse time so the canonical
   `build_default_config` remains the single source of truth.
2. **`build_default_config(oracle_start_ts, oracle_end_ts) -> BenchmarkRunConfig`**
   — produces the canonical defaults (WETH and WBTC presets, gas-used
   estimates, simulation window, parallelism). Every other component
   must either call this function or load JSON that was originally
   derived from it.
3. **`validate_run_config(value)`** — strict bounds check + version pin
   (`BENCHMARK_RUN_CONFIG_VERSION = "benchmark-run-config/v11"`) used by
   the dashboard's HTTP layer before persisting a run. Every older
   `params.json` version (v4–v10) is rejected outright — there is
   deliberately no migrator: silent field-filling was a reproducibility
   bug class, and archived numbers are unreproducible anyway (pre-v6
   binaries embed a different actor policy and no oracle snapshot). To
   reuse an archived calibration, port its overrides (seed, window,
   presets) onto fresh v11 defaults by hand. v7 added the required
   per-preset `amms.equilibra.presets.<BASE>.baseTokenPosition` (`"token0"` = base in slot 0,
   matching mainnet address sort — WETH `0xC02a…` and WBTC `0x2260…`
   both sort before USDT `0xdAC1…`; `"token1"` keeps the quote in
   slot 0). Equilibra only — the Curve baseline always models the
   quote as token0 like its live reference pools, and the report's
   anchor metrics convert per-context to USD-per-base. v8 added the
   required donation-stream pair `donationAprBps` /
   `donationIntervalSec` (0/0 = disabled; the bundled presets default
   to WETH 344 / WBTC 41 bps per year with a 30-day interval); v9 kept the
   v8 schema and pinned the donation semantics (per-event buy+park,
   first stream tick at t = 0, one-year interval cap); v10 keeps the
   schema and pins the WAD fee-rate semantics plus the ramp
   monotonicity guard (previously-valid narrow-ramp presets are
   rejected); v11 keeps the schema and pins the tightened floors
   `feeBps >= 5` / `emaPeriod >= 60 s`.

> Hard limits (e.g. `feeRampBps ∈ [0, 10_000]`, `feeFloorBps ≤ baseFee`,
> the ramp monotonicity guard `feeRampBps · (BPS − baseFee)² ≥
> FEE_RAMP_GUARD_MULT · BPS · (baseFee − feeFloorBps)²` whenever
> `feeRampBps != 0`,
> `repegShareBps + protocolFeePercent · 100 ≤ BPS`, `protocolFee ≤ 25`,
> and the repeg stall guard `repegThresholdToken1{Up,Down}Wad ≤
> feeScale · 1e14` — each band independently — whenever
> `repegShareBps != 0`, where feeScale = `feeFloorBps` with a
> live ramp and flat `baseFee` otherwise)
> are enforced on chain by `EquilibraFactory` / `Constants.sol`. The
> Rust validator in `simulator/src/app/config.rs::validate_run_config`
> mirrors every one of those bounds so the simulator never proposes a
> config the chain would refuse. **When you change a constant on chain,
> mirror it in `config.rs`.**

#### How a runtime config is formed

```
            simulator/src/app/config.rs :: build_default_config()
                          │
                          ▼
   ┌──── BenchmarkRunConfig (in-memory, fully populated) ─────┐
   │  simulation { startTimestamp, endTimestamp, seed, … }    │
   │  liquidity.passiveLpInitialUsd                           │
   │  actors.{user,arbitrageur}                               │
   │  reporting.slippageSweep                                 │
   │  amms.{equilibra,uniswapV2,curve}                        │
   │  amms.equilibra.presets["WETH" | "WBTC"]                 │
   │  amms.curve.presets   ["WETH" | "WBTC"]                  │
   │  parallel                                                │
   └──────────────────────────────────────────────────────────┘
              │                          │
              │ overridden by setup      │ exported as JSON
              ▼                          ▼
   ┌─ setup layer (one of) ─┐      ┌─ equilibra-offchain-config-defaults ─┐
   │ 1. Dashboard form      │      │  JSON snapshot for tests / UI         │
   │    (POST /api/runs)    │      │  cached by simulator/test_helpers/    │
   │ 2. Hand-edited         │      │  config.ts (loadRustBenchmarkDefaults)│
   │    params.json         │      └───────────────────────────────────────┘
   │ 3. Simulator CLI flags │
   │    (process-local)     │
   └────────────┬───────────┘
                ▼
      validate_run_config()  ──►  reject on bound or version drift
                ▼
     runs/<runId>/params.json   ◀── validated and config-hashed
                ▼
   equilibra-offchain-simulator --config runs/<runId>/params.json …
```

What comes from where, in one sentence each:

- **From `config.rs`**: every default that is not explicitly overridden —
  presets, `gas_used_estimates`, `progress_interval_sec`, EMA periods,
  `repeg_step_wad`, dynamic-fee floor / share, post-arb adaptive gate
  defaults, and the report-only slippage sweep, etc. V7 persisted configs
  are fully materialized: no required runtime field has a serde fallback.
- **From the setup layer**: per-run overrides — most commonly seed,
  duration, `baseFee` / `feeRampBps` / `feeFloorBps` for sweeps, AMM
  enable flags, and the `presets["WETH"|"WBTC"]` block when calibrating
  new pools. The dashboard materializes a complete config before
  `POST /api/runs`; the server rejects partial JSON and re-validates the
  full value through `validate_run_config` before persisting.
- **From simulator CLI flags**: `--config`, `--output` and `--data-dir`
  select the persisted config, result and shared oracle source;
  `--duration-sec`, `--no-curve`, `--disable-equilibra-recenter` and
  `--disable-curve-rebalance` alter benchmark execution. Partition filters
  (`--only-amms`, `--only-bases`) are used by sharded execution. Trace mode
  uses `--trace-input`, `--trace-output` and `--trace-disable-recenter`.
  `--origin-config-hash` is accepted only together with the shared
  `--execution-manifest`; the parent hash alone is not provenance. CLI
  flags **never** silently rewrite `params.json`. For benchmark execution,
  the effective window, disable switches and selected partitions are bound
  into the execution fingerprint; trace mode is a separate replay path.

`reporting.slippageSweep.{minInitialSideBps,maxInitialSideBps}` controls the
diagnostic quote range as BPS of initial one-side liquidity (canonical
default `1..3000`). It is deliberately independent from the stateful user
actor's USD trade limits. The five legacy-shaped `rebalanceEnabled` fields
are a single global policy and validation requires all of them to agree;
mixed values are rejected instead of being silently collapsed with AND.

The TypeScript side mirrors the same defaults via
`simulator/test_helpers/config.ts`, which shells out to
`equilibra-offchain-config-defaults` once per process and caches the
parsed JSON. That is how `test/simparity/*` and the dashboard agree on
"the same WETH preset". If you ever need to tune a simulator default,
**always** start from `simulator/src/app/config.rs` — the rest of the
stack picks the change up automatically (Rust binaries on the next
`cargo build`, TS tests on the next `loadRustBenchmarkDefaults` call).

#### Per-run artefacts (`runs/<runId>/`)

```
runs/<runId>/
├── params.json              # fully materialized, validated config
├── status.json              # RunManifest + config/oracle/execution identities
├── inputs/
│   └── execution.json       # complete execution material + fingerprint
│                            # (incl. the shared oracle feed's content digest —
│                            #  the feed itself is digested, never copied)
├── checkpoints/             # transient process checkpoints (prunable)
├── logs/                    # transient per-shard stdout/stderr (prunable)
├── shards_ctx_rust/         # transient per-context results (prunable)
├── sim_results.json         # transient merged raw result; pruned after the
│                            # report is durably published (can exceed 1 GB)
└── report/
    ├── REPORT_COMPLETE.json # durable publication marker tied to result/provenance
    └── web/                 # immutable per-run copy of viewer assets + data
        └── data/            # metrics.json and per-AMM/per-pool series
```

`configHash` is the SHA-256 of canonicalised `params.json` and identifies
parameters only. `oracleDigest` identifies the exact candle bytes the run
consumed. `executionFingerprint` additionally binds the parent/partition
config hashes, effective window and CLI options, simulator/merge binary
digests, actor/result/report algorithm versions and the report-asset digest.
`resultDigest` in the report metadata and completion marker is the canonical
content digest of the result the report was generated from
(`common::canonical_result_digest`: compact serde stream, all maps are
`BTreeMap` so key order is stable, the volatile `generatedAt` stamp is
excluded) — the ONE definition shared by the merge pipeline and standalone
report regeneration, so identical results always carry identical digests
and the value is reproducible from any faithful copy of the result;
`reportFingerprint` also binds the report generator and assets. These are consistency and
reproducibility identities for declared inputs, not an attestation of the
host or every process-environment variable.

The oracle feed is digested, never copied: run creation fingerprints the
shared directory's content, and every later consumer (each shard, merge,
report) re-digests the same directory and fails closed on any drift — a
mutated feed stops the pipeline instead of being consumed silently. Nothing
is duplicated per run; extending the feed's tail between runs is routine and
only changes future digests. Report generation writes a sibling staging
tree, fsyncs it, atomically publishes `report/`, and writes
`REPORT_COMPLETE.json`. Only after that marker matches the execution/oracle
identities are raw shard directories AND the merged `sim_results.json`
pruned — the report bundle (which records the result digest) is the retained
artifact; a full run's raw result exceeds a gigabyte and is deliberately not
kept.

### Local dashboard / visualizer (`equilibra-offchain-app`)

The dashboard is a single Axum binary that fronts the orchestrator. It serves
the dashboard/visualizer source bundles from `simulator/` and completed report
assets only from each run's atomically published directory:

| URL prefix         | Asset directory          | Purpose                                                                 |
| ------------------ | ------------------------ | ----------------------------------------------------------------------- |
| `/`                | `simulator/app-web/`     | Run controller — list / create / cancel runs, live SSE log stream.      |
| `/visualizer/`     | `simulator/visualizer/`  | Interactive blend-invariant curve / slippage / coverage explorer.       |
| `/api/runs/{runId}/report/{*asset}` | `runs/<runId>/report/web/` | Durably published per-run viewer and data. No mutable template fallback is served. |

Key HTTP endpoints (full router in `simulator/src/app/server.rs`):

- `GET  /api/config/default` — returns
  `{ config: build_default_config(...), defaultsHash }`; the UI stores only
  versioned overrides and invalidates them when the canonical defaults change.
- `POST /api/visualizer/series` — synchronous preview of slippage
  and coverage for arbitrary Equilibra `(aWad, lambdaWad)` and
  reference Curve V2 `(A, gamma)` (stableswap or crypto math).
  Runs entirely through `runtime_quoter::LocalQuoter` — **no run is
  created on disk**, the response is computed in-process. Returns
  `{ slippage: { equilibra, uniswapV2, curve }, coverage }`, all
  three slippage series sharing the **same** `d_bps` axis (see
  "Adaptive sampling" below).
- `POST /api/runs` — validate a fully materialized config, snapshot the
  requested oracle range, persist the provenance sidecars and `params.json`,
  then enqueue the run. The orchestrator spawns per-context
  `equilibra-offchain-simulator` workers followed by
  `equilibra-offchain-merge`, which retains the merged result and publishes
  the report, while simulator stdout emits `[BENCHMARK_EVENT]` `RunEvent`s.
- `GET  /api/runs/{runId}/events` — SSE stream of those events for live
  progress in the UI.
- `GET  /api/runs/{runId}/report/{*asset}` — assets from that completed
  run's published `report/web/` only. Missing files fail with 404; the server
  never substitutes the mutable source `simulator/report-web/` tree.

The visualizer is the **fastest** way to feel out a parameter combo
before committing a long run: it talks the same `runtime_quoter` math
kernel that a real run uses, so curves are bit-for-bit identical to a
benchmark started from the dashboard. Fees, auto-repeg and the EMA
oracle are intentionally **not** modelled in the visualizer — it
explores the static curve geometry only, which is what the slider
sweep is for.

**Backend-only curve rendering.** All slippage / liquidity points
come from `simulator/src/app/visualizer.rs::build_visualizer_series`,
which calls `LocalQuoter` (U256 arithmetic) for every sample. The
frontend (`simulator/visualizer/index.html`) does **no** invariant
math in JavaScript — slider values are forwarded as decimal strings
to `POST /api/visualizer/series`, the response is rendered as-is.
This bit-exactness against the kernel is the whole point: any
client-side f64 mirror would catastrophically cancel in
`targetX` / `targetY` for sharp configs.

**Adaptive sampling.** Equilibra curves can become near-vertical close
to reserve depletion (penalty rising 0.5 → 100+ within a single
uniform 1% segment), and Chart.js cubic-monotone interpolation
renders such jumps as a visible "staircase". `build_series_for_amm`
counters this with a uniform pass at the requested grid plus two
rounds of adaptive refinement, inserting midpoints into the
highest-|Δpenalty| segments and any segment that straddles a
finite ↔ unreachable transition. The refined Equilibra grid is then
re-used by the Uniswap and Curve resamples (`resample_secondary_at_grid`)
so all three series are index-aligned for the chart's
`dVals[i] ↔ uniVals[i] ↔ curveVals[i]` data layout.

### Benchmark / dashboard (CLI)

```bash
cargo run --manifest-path simulator/Cargo.toml --release \
    --bin equilibra-offchain-simulator -- \
    --config runs/<runId>/params.json \
    --output runs/<runId>/sim_results.json \
    --data-dir simulator/data

# The standalone command writes inputs/execution.json beside
# sim_results.json; the oracle feed is digested in place, not copied.
# Report regeneration re-verifies the shared feed's digest and fails
# closed if the consumed window was rewritten since the run.
cargo run --manifest-path simulator/Cargo.toml --release \
    --bin equilibra-offchain-report -- \
    --results runs/<runId>/sim_results.json \
    --output runs/<runId>/report \
    --execution-manifest runs/<runId>/inputs/execution.json

# Manual merge syntax. The execution manifest must have been created before
# every shard and must enumerate all partitions and the exact simulator/merge
# binaries. Every shard must receive this same manifest and parent hash and
# read the same shared oracle directory; generating independent per-shard
# manifests is not merge-compatible. The merged raw result is digested in
# memory and NOT written to disk — the report bundle is the output.
cargo run --manifest-path simulator/Cargo.toml --release \
    --bin equilibra-offchain-merge -- \
    --input runs/<runId>/shard-weth/sim_results.json \
    --input runs/<runId>/shard-wbtc/sim_results.json \
    --report-output runs/<runId>/report \
    --execution-manifest runs/<runId>/inputs/execution.json

# Local UI (charts, slippage histograms, fee-paid breakdowns).
cargo run --manifest-path simulator/Cargo.toml --release \
    --bin equilibra-offchain-app
# → http://127.0.0.1:3100  (override via BENCHMARK_APP_HOST / BENCHMARK_APP_PORT)
```

Non-loopback binding is refused unless
`BENCHMARK_APP_ALLOW_PUBLIC=1` is set. That flag is only an explicit
risk acknowledgement, not authentication: any externally reachable
deployment still requires an authenticated reverse proxy, CSRF/origin
controls and resource limits.

## Project Architecture

EquilibraSwap is a 2-token hybrid AMM with anchor-driven concentration. Each
pool is a clone (EIP-1167) of a single implementation; the factory atomically
deploys + seeds liquidity to prevent anchor front-running.

### Contract layout

```
contracts/
├── EquilibraFactory.sol             # Clone factory + atomic create+seed (public & private pools; payable — attached native value funds the WETH9 leg), per-pool LP allowlist + owner-curated Boost registry
├── EquilibraPool.sol                # Hybrid AMM: swap, mint, burn, EMA, auto-repeg
│
├── base/
│ ├── EquilibraLpToken.sol           # Solady ERC20 + EIP-2612 permit (clone-friendly metadata)
│ └── EquilibraPoolGuard.sol         # Pause + factory-owner role helpers
│
├── periphery/
│ └── EquilibraRouter.sol            # User-facing swap, liquidity, zap & payment router
│
├── libraries/
│ ├── Constants.sol                  # WAD, BPS, fee/ramp/repeg bounds, EMA caps
│ ├── EquilibraSwapMath.sol          # State distance, closed-form invariant, smoothstep fee, 2·L
│ ├── PoolOracle.sol                 # Geometric (log-domain) EMA with symmetric cap, log-step repeg helpers
│ ├── PoolAddressCompute.sol         # CREATE2-style deterministic clone address
│ ├── SwapPath.sol                   # Multi-hop path encoding (token0|poolIndex|token1|...)
│ └── Errors.sol                     # Custom error surface for all contracts
│
├── interfaces/
│ ├── IEquilibraPool.sol             # Pool ABI: swap/mint/burn callbacks, views, events
│ ├── IEquilibraFactory.sol          # Factory ABI: createPool[Private]AndAddLiquidity, LP allowlist, whitelist, Boost curation, params
│ ├── IBoostVaultLike.sol            # Minimal Boost share-vault surface (`pool()`) for the curation registry
│ ├── IEquilibraRouter.sol           # Router ABI: exactIn/Out single + path, payment helpers
│ ├── IEquilibraSwapCallback.sol     # `equilibraSwapCallback(amount0, amount1, data)`
│ ├── IEquilibraMintCallback.sol     # `equilibraMintCallback(amount0, amount1, data)`
│ ├── IMulticall.sol                 # Solady-compatible multicall
│ └── IWETH9.sol                     # Wrapped-native interface used by the router
│
└── mocks/                           # Test ERC20s, callback traders, mint providers, WETH9
```

Pools sit on top of two callback interfaces (V3-style):

- `swap()` requires `IEquilibraSwapCallback.equilibraSwapCallback` to push
  the input token. The strict `received != amountInRaw` delta check inside
  the pool is a stronger invariant than a `balanceOf` solvency assertion.
- `addLiquidity()` requires `IEquilibraMintCallback.equilibraMintCallback`
  to deposit both sides. The factory itself implements the mint callback for
  `createPoolAndAddLiquidity` so the seeder only needs the two ERC20
  approvals on the factory — or one approval plus attached native value
  for a WETH9 leg: the payable create entrypoints wrap `msg.value`
  (strictly equal to that side's seed amount; `NoWethLeg` /
  `NativeValueMismatch` otherwise) and pay the leg from the factory's
  just-wrapped balance.
- `removeLiquidity()` is a regular ERC20 transferFrom on the LP token (the
  router pulls the shares before invoking `burn`).

---

## Mathematical model

### Two-knob invariant K

Reserves are normalised to math-space via the **asymmetric** coordinate
change (quote side normalised by `priceScale`, base side untouched):

```
xMath = reserve1 · token1Scale                            // base, identity
yMath = (reserve0 · token0Scale) · WAD / priceScaleWad    // quote → base units
```

`priceScale = yWad / xWad` is seeded at genesis from the initial reserve
ratio (so at the anchor `yMath = xWad = xMath` and the kernel evaluates
on the math-space diagonal). A successful auto-repeg shifts `priceScale`
toward the EMA, which moves **only `yMath`** — the resulting `(xMath,
yMath)` carries a genuine off-diagonal displacement that gives the
auto-repeg solvency gate a real IL signal (see `_tryAutoRepeg` NatSpec).

The single-piece cubic invariant:

```
K(x, y; L) = A · L · (x + y) / 2  +  (W − A) · xy
A          = a · W / (W + λ · D)
D          = (y − x)² / (x · y),    W = WAD
```

Polynomial degree in `y` (after clearing denominators) is **3**, giving
a well-conditioned cubic envelope for the secant solver.

- `a` (WAD; bounded by `[A_MIN_WAD, A_MAX_WAD] = [0.1·W, 0.99·W]`) is the
  **depth-at-anchor** knob. At `D = 0` (anchor), `A = a`; larger `a`
  deepens the plateau at the centre.
- `λ` (WAD; bounded by `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD] = [1e15, 1e18]`)
  is the **plateau-width** knob. At `λ·D = W`, `A = a/2`
  (half-amplification distance); larger `λ` narrows the plateau.
- **Decoupling.** `a` alone controls centre depth; `λ` alone controls
  cliff position — the two knobs are mathematically orthogonal.
- `D = (y − x)² / (x · y)` is the symmetric state distance (one
  division for numerical stability near `x ≈ y`).
- `L` is the balance-equivalent depth scale, recovered analytically
  per-leg from the pre-state via the closed-form quadratic
  `solveLFromState` (positive root of `W·L² − A·L·S − (W−A)·N = 0`)
  and frozen for the whole swap leg.

The kernel is monotone in `L` for every reachable `(x, y)`, so the
secant solver converges on a one-sided bracket.

### Single-piece K — no segment walker

The blend is a single smooth piece across the whole positive
quadrant. Cross-anchor swaps settle in the same kernel as
single-segment ones via one secant solve — there is no segment-A
cache, no anchor walker, and no chicken-and-egg between segments.

### Marginal price

```
pMarg(x, y; L, a, λ) = ∂K/∂x ÷ ∂K/∂y   // WAD-scaled, math-space
                     = 1.0 when x == y
```

`marginalPriceFromState` recovers `L` internally; `marginalPrice` (with
`L` supplied) is the cheap variant used by callers that already have
`L` in scope. `marginalPrice` is split internally into 3 private
helpers (`_marginalPriceAmpSide`, `_marginalPriceBases`,
`_marginalPriceTau` plus the orchestrator `_marginalPriceParts`) so
the body fits the EVM 16-slot stack limit on `viaIR=false` builds;
with `viaIR=true` the optimizer inlines them back, bytecode is
identical and gas overhead is ≤ 15 wei per call.
The user-facing raw spot is `spotRaw = mulWad(pMargMath, priceScale)`.

### Balanced depth and LP unit value

At the balance state `x = y = L_eq`, `K = W · L_eq²`, so
`L_eq = √(K / W) = sqrtWad(K)` (single-WAD semantics). LP unit value:

```
vp = 2 · L_eq · √(priceScale · WAD) / totalSupply
```

The `√(priceScale · WAD)` factor is the anchor normaliser — it keeps
`vp` in consistent units across repegs (otherwise math-space drift
would mask IL).

Limits: `L → sqrt(x·y)` as `a → 0` (constant-product), `L → (x+y)/2`
as `a → W` (constant-sum, forbidden by `A_MAX_WAD = 0.99·W`).
Always satisfies `2·L ≤ x + y` by AM-GM.

---

## Dynamic fee — smoothstep ramp

The pool charges a per-swap fee that climbs from a **floor** to a
**ceiling** along the post-swap state distance:

```
m(r) = 2·r − r²,    r = distPostWad / feeRampWad   (clamped to [0, 1])

feeWad = floorWad + (baseFeeWad − floorWad) · m(r)
        ∈ [floorWad, baseFeeWad],   floorWad = feeFloorBps · 1e14
```

with `feeRampWad = feeRampBps · 1e14` (so 10 000 bps == 1 WAD == one
full state-distance unit). The config stays in integer bps; the pool
widens it once per swap (`uint16 · 1e14`, `unchecked`) and both
resolves AND applies the rate at **WAD precision**
(`fee = amountIn · feeWad / WAD`). A one-ulp rate step therefore moves
the fee by at most `amountIn / 1e18` wei — the gross → clean-input map
(and hence `quoteExactIn`) is monotone up to a dust residual on that
order (the CP distance and `r` are WAD-quantized too, so one input wei
can cross several rate ulps at once — a small multiple of
`amountIn / 1e18`, pinned by the monotonicity tests), instead of the
1-bps-of-notional cliffs an integer-bps rate would produce at every
rate boundary. The shape is C¹-continuous with
`m'(0) = 2`, i.e. the fee climbs *twice* as fast as a linear ramp
near the anchor and then saturates smoothly. This is intentional:
tiny mean-reverting flow keeps the fee at the floor while any
meaningful imbalance pushes the fee toward the ceiling within the
first few % of the ramp.

### Disable rules

The ramp is bypassed (every swap pays exactly `baseFee`) when:

- `feeRampBps == 0` — explicit per-pool opt-out (flat-fee mode).

Pairing `feeRampBps != 0` with `baseFee == feeFloorBps` is **rejected
at deploy time** with `FeeRampNoHeadroom`: the smoothstep would have no
headroom to interpolate into and would silently collapse, so the
factory fails fast instead of hiding the misconfig in the pool. The
opt-out path zeros `_feeRampDistWad` so the hot swap path dispatches
on a single comparison.

A live ramp must additionally satisfy the **monotonicity guard**
`feeRampBps · (BPS − baseFee)² ≥ FEE_RAMP_GUARD_MULT · BPS ·
(baseFee − feeFloorBps)²` (`FeeRampTooNarrow` otherwise, enforced by
the factory and re-checked by the param timelock on every fee change).
On a ramp narrower than that, the terminal rate climbs faster than the
gross input grows (`d(g·f(g))/dg > 1`) and a larger exact-in trade
returns less output over whole input intervals — a regime no rate
precision can fix. The monotone condition is `g·f' ≤ 1 − f`, so the
headroom shrinks with the fee ceiling itself — hence the
`(BPS − baseFee)²` factor (a span-only bound admits non-monotone
configs once the ceiling nears `MAX_BASE_FEE`). The tight multiplier
of the squared envelope is 256/27 ≈ 9.5; the shipped 12 leaves a
uniform ~11% margin above it.

### Cost model

Both directions resolve the WAD fee rate through the same
constant-product proxy of the post-swap **state distance**
(`_resolveDynamicFeeWadFromCp` →
`EquilibraSwapMath.predictPostDistanceCp` → `smoothstepFeeWad`). The CP
proxy is a cheap closed-form approximation, so the dynamic fee adds only
a handful of muls/divs on top of the flat-fee swap.

- **Exact-in** resolves the fee in a single shot from the CP-proxy
  distance of the **gross** input. Consuming gross rather than `cleanIn`
  adds a small upward bias (≈ 2·fee relative). Note, however, that the
  CP proxy itself can diverge from the true cubic post-state distance in
  either direction — it tends to *under*-state the distance on plateau /
  imbalance-increasing trades — so the net bias is **not** guaranteed to
  favour LPs on large swaps (see the math audit, finding L-1).
- **Exact-out** has the output (hence the post-swap *curve* state and
  `cleanIn`) fixed up front, but the **fee** still depends on the gross
  input (`gross = cleanIn / (1 − feeWad/WAD)`), so it is genuinely circular.
  The CP-proxy distance is quasi-convex (V-shaped, minimum at the
  constant-product anchor `xPost = √(xy)`) in the gross, so a fixed-point
  iteration can oscillate for anchor-crossing trades. The pool therefore
  resolves the fee **non-iteratively** as the maximum of the CP-proxy fee
  at the two ends of the realisable gross interval
  `[grossUp(cleanIn, feeFloor), grossUp(cleanIn, baseFee)]`. A
  quasi-convex function attains its maximum over an interval at an
  endpoint, so this value is ≥ the fee `exactInput` independently
  resolves at the settled gross — which guarantees the user-facing
  identity `exactInputSingle(quoteExactOut(out)) ≥ out` with no
  iteration. `quoteExactOut` runs the same resolver, so quote == swap.
  Trade-off: anchor-crossing exact-out trades are quoted **conservatively**
  (over-charged by up to the live `baseFee − feeFloor` span), always in
  the LP-favourable direction. On the **descending branch** of the V the
  resolved rate falls as the requested output grows, so `quoteExactOut`
  can require marginally LESS input for one more wei of output — the
  same dust residual on the order of `quotedIn / 1e18`,
  taker-favourable. Both residuals are pinned by
  `test/security/DynamicFeeMonotonicity.test.ts`.

Pools that do not need the ramp must still set `feeRampBps = 0` to skip the
prediction entirely.

### Sizing the ramp

For `feeFloorBps = 20`, `baseFee = 100`:

| price move | ramp =  10 | ramp =  100 | ramp = 1000 | ramp = 10000 |
| ---------: | ---------: | ----------: | ----------: | -----------: |
|      1.00% |      35.06 |       21.58 |       20.16 |        20.02 |
|      2.00% |      70.44 |       26.15 |       20.63 |        20.06 |
|      5.00% |     100.00 |       53.56 |       23.76 |        20.38 |
|     10.00% |     100.00 |       99.34 |       33.88 |        21.45 |
|     20.00% |     100.00 |      100.00 |       64.44 |        25.24 |
|     50.00% |     100.00 |      100.00 |      100.00 |        44.44 |
|    100.00% |     100.00 |      100.00 |      100.00 |        80.00 |
|    162.00% |     100.00 |      100.00 |      100.00 |       100.00 |

Reading the table:

- Each column is one `feeRampBps` setting; rows are the post-swap anchor
  deviation produced by the swap.
- Narrow ramps (`feeRampBps ≤ 100`) are aggressive — even a 1-2% move pushes
  the fee close to the ceiling.
- Wide ramps (`feeRampBps ≥ 1000`) behave as a soft floor where most
  realistic swaps stay near `feeFloorBps`.
- **Setting `feeRampBps = 10000` is NOT "max fees".** It is the widest
  possible smoothstep, so most swaps end up paying close to `feeFloorBps`.
  To bias fees high, pick a small `feeRampBps` (≤ 100) instead.
- The narrowest deployable ramp for a given config is
  `ceil(FEE_RAMP_GUARD_MULT · BPS · span² / (BPS − baseFee)²)` (= 8
  for the table's span 80 at ceiling 100; the shipped WETH/WBTC
  configs need 28 / 3) — anything below reverts `FeeRampTooNarrow`
  (see "Disable rules" above).

### Splittability (accepted)

The ramp is **marginal, not cumulative**: the fee is a function of the
*instantaneous* post-swap state distance, charged on each leg's own
input. A directional trade split into N legs therefore pays the area
under the rising `f(D)` curve, while one swap of the same notional pays
the rectangle `f(D_final)·total ≥ that area` — so **splitting is strictly
cheaper** (≈ 30–40 % of the dynamic premium at ~32 legs). This is an
accepted, inherent property of any instantaneous-state fee, and it is
**not** an LP drain: the per-leg integral is
the marginal-cost-fair charge, and a single swap merely over-charges the
early units. The only consistent non-splittable fee is that same integral,
which would lower fees for everyone — so there is no LP-favourable "fix".
The behaviour is pinned by
`test/security/DynamicFeeSplittability.test.ts` (ramp enabled), distinct
from `test/security/SwapBatchVsSingle.test.ts` (flat fee, tests OUTPUT
concavity). See the math audit, finding L-3.

---

## V3-style swap interface

```solidity
function swap(
    address recipient,
    bool zeroForOne,
    int256 amountSpecified,    // > 0 = exact input, < 0 = exact output
    bytes calldata data        // forwarded to equilibraSwapCallback
) external returns (int256 amount0, int256 amount1);
```

The pool always issues `equilibraSwapCallback` to `msg.sender`; the router
forwards a `(SwapCallbackData{path, payer})` payload so it knows whom to
charge. The strict `received != amountInRaw` delta check after the callback
makes fee-on-transfer / rebasing tokens fail loudly rather than silently
under-pay the pool.

`quoteExactIn` / `quoteExactOut` reuse the **exact same** resolver as the
live swap (including the smoothstep ramp), so `quote == output` bit-for-bit.
This identity is exercised by `test/security/DynamicFee.test.ts` and the
parity suite under `test/simparity/`.

### Donation entrypoint

Auto-repeg is funded out of LP-value growth; when a pool exhausts that budget
the donation buffer is what keeps the anchor tracking. A donation is LP shares
parked at the pool's own address, where they carry no claim on reserves. The
pool itself has **no** donation entrypoint — the donation primitive is a plain
LP `transfer` to the pool address. The guarded entrypoint lives on the router:

```solidity
// EquilibraRouter
function donate(
    address tokenA,
    address tokenB,
    uint32 poolIndex,
    uint256 shares,
    uint256 maxSupply,
    uint256 deadline
) external;
```

Parking shrinks the active float `totalSupply - balanceOf(pool)` that BOTH
liquidity legs price against, so redemption per active share rises in that block.
`maxSupply` pins it: if the pool's `totalSupply()` exceeds it at execution (any
mint landing first raises it), the call reverts `SlippageExceeded`, so a
zero-capital sandwich cannot divert part of the lift; `checkDeadline` bounds how
long the signed intent stays live. The donor approves the ROUTER for the pool's
LP token (`selfPermitIfNecessary` folds the EIP-2612 approval into the same
`multicall` batch) and the router
`safeTransferFrom`s the shares donor → pool. A plain LP `transfer` stays
equivalent and unguarded — the pin and the deadline exist for callers that need
the donation atomic against the state they quoted.

Accepted residual: the pin bounds who may JOIN between quote and execution, not
who is already there. A holder already in the pool when the donation lands
receives its pro-rata slice, and that holder carries real LP exposure across
blocks to do so. Donors observing an unusually large position can defer the
tranche; the flash-loaned, zero-risk sandwich is the case the pin closes.

Buffer lifecycle: both liquidity legs keep the `parked/active` ratio invariant —
`addLiquidity` mints a proportional buffer top-up to the pool, and
`removeLiquidity` burns the exiting holder's proportional buffer slice. That
exit-leg burn is pure REBALANCING: it moves no value and keeps `vp` (and the
parachute's feasibility) unchanged. The donation parachute is the only burner
that SPENDS the buffer. It is consulted whenever `_tryAutoRepeg` commits NO
rung — both when the pre-repeg gate finds no spendable growth budget at all AND
after the halving ladder exhausts every rung — and it additionally requires the
anchor to lag by at least `parachuteBandMult ×` the active dead-band (per-pool
K, seeded at `Constants.REPEG_PARACHUTE_BAND_MULT = 30`, timelock-adjustable in
`[1, 255]`, readable as `getFeeConfig().parachuteBandMult`). With the bundled
preset bands (`Up 2.5e15 / Down 1.5e15`) the default K = 30 arms the parachute
at a 7.5% / 4.5% geometric anchor lag; pegged pools with both bands at `1e14`
arm at 0.3%. Each burn is sized to the exact shortfall, so the post-burn unit
value lands on the gate floor and no standing budget is ever parked — the
reason donations here need no separate spend cap.

### EquilibraRouter (user-facing)

`EquilibraRouter` mirrors the Uniswap V3 SwapRouter design (internal
`*Internal` helpers shared by every public entrypoint, unified WETH
wrapping, batching via `multicall`) **plus** the merged zap entrypoints
that used to live in a standalone `EquilibraZap` contract:

```solidity
// Swaps
function exactInputSingle (ExactInputSingleParams)  payable returns (uint256);
function exactOutputSingle(ExactOutputSingleParams) payable returns (uint256);
function exactInput       (ExactInputParams)        payable returns (uint256);  // multi-hop
function exactOutput      (ExactOutputParams)       payable returns (uint256);  // multi-hop

// Liquidity
function addLiquidity(AddLiquidityParams) payable returns (uint256 sharesOut);
function removeLiquidity(RemoveLiquidityParams) payable returns (uint256 amountA, uint256 amountB);

// Donation (guarded LP-share parking; see "Donation entrypoint" above)
function donate(address tokenA, address tokenB, uint32 poolIndex, uint256 shares, uint256 maxSupply, uint256 deadline);

// Zap (single-sided / imbalanced / single-asset-out)
function zapInSingleSided (ZapInSingleSidedParams)  payable returns (uint256 liquidity);
function zapInImbalanced  (ZapInImbalancedParams)   payable returns (uint256 liquidity);
function zapOutSingleSided(ZapOutSingleSidedParams) payable returns (uint256 amountOut);
function previewZapIn (address tokenIn, address tokenOut, uint32 poolIndex, uint256 amountIn) view returns (uint256 liquidity, uint256 swapAmount);
function previewZapOut(address tokenA, address tokenB, uint32 poolIndex, uint256 liquidity, address tokenOut) view returns (uint256 amountOut);

// Payments
function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;
function sweepToken(address token, uint256 amountMinimum, address recipient) external payable;
function refundETH() external payable;
function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable;
function selfPermitIfNecessary(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable;
```

Highlights:

- **Multi-hop path encoding** lives in `libraries/SwapPath.sol`:
  `[token0 (20)][poolIndex (4)][token1 (20)][poolIndex (4)]…`. The 4-byte
  `poolIndex` is the pair-local index under
  `EquilibraFactory._poolsByPair`, allowing multiple pools per pair.
- **Single-hop fast path** uses a compact 128-byte callback payload to skip
  the `SwapPath` decoder. The literal `128` is bound to
  `_SINGLE_HOP_PAYLOAD_BYTES` with the ABI arithmetic spelled out in
  NatSpec.
- **V3/SwapRouter02 composition surface.** `addLiquidity`, both `zapIn*`
  and `zapOutSingleSided` are `payable`: a WETH9 leg can be funded with
  attached native ETH (the mint callback / `_pullOrWrap` wrap exactly
  the used amount; `addLiquidity` callers chain `refundETH` because the
  proportional cap makes the used amount unknowable upfront).
  `zapInSingleSided.amountIn == 0` is the CONTRACT_BALANCE sentinel:
  the zap consumes the router's whole staged `tokenIn` balance — chain
  it after an `exactInput` with `recipient = address(0)` to zap in from
  any token via a multi-hop route. The swap-side twin is
  `amountIn == type(uint256).max` on `exactInputSingle` / `exactInput`:
  the leg consumes the router's whole LIVE balance of its input token
  (regardless of provenance — stage and consume atomically, a
  pre-funded balance is equally sweepable by anyone) and pays from the
  router — fan legs stage outputs with `recipient = address(0)`, the
  sentinel leg absorbs the pot (drift included), `sweepToken` closes.
  Every other value >= 2^255 keeps reverting in the checked cast, so
  the sentinel shadows no real amount. `removeLiquidity` /
  `zapOutSingleSided` accept `recipient = address(0)` to stage outputs
  for `unwrapWETH9`/`sweepToken` chaining (single-transaction
  native-ETH withdrawal); `selfPermit`/`selfPermitIfNecessary` fold an
  EIP-2612 approval into the same batch (prefer the IfNecessary
  variant — it survives a front-run that consumes the signature's
  nonce).
- **`recipient = address(0)`** keeps the output in the router so the caller
  can chain `sweepToken` / `unwrapWETH9` / `refundETH` through `multicall`.
  Solady's default `multicall` rejects `msg.value != 0`; we override it to
  re-enable payable batches (required for native-ETH swaps).
- **Zap callbacks reuse the router's existing `equilibraSwapCallback` /
  `equilibraMintCallback`**. Both callbacks verify `msg.sender` against
  the CREATE2-derived pool address (`_verifyCallback`), so zap flows
  inherit the router's security model — no separate transient-slot
  authentication needed. The mint callback branches on `payer` so the
  router can pay either from caller funds (`transferFrom`) or its own
  staging balance after a swap-output capture (`safeTransfer`).
- **Zap math helpers** (`_calculateOptimalSwap`,
  `_calculateRebalanceSwap`) and several `_zap*` private wrappers are
  factored out so the entry-points fit under the EVM 16-slot stack
  limit even on legacy (non-viaIR) builds.
- All ERC20/ETH movements go through Solady's `SafeTransferLib`.
- OpenZeppelin's `IERC20Metadata` is the router's single ERC-20 read
  interface (`totalSupply`, `balanceOf`, `allowance`, `decimals`) —
  used by the zap previews, `donate`'s supply pin and
  `selfPermitIfNecessary`.

---

## Auto-repeg (priceScale follows market)

The pool moves `priceScale` toward the EMA of recent marginal prices,
paying for the impermanent loss out of cumulative LP-unit-value growth
rather than diluting LPs. The repeg gate is governed by a per-LP-unit
threshold that the live LP unit value must clear both before AND after
the candidate move. The full pipeline runs **inside `swap()`**,
immediately after the curve math and before the input transfer:

0. **Opt-out short-circuit.** `_repegShareBps == 0 ⇒ no-op` before any
   other read. This is an explicit gate, NOT a by-construction property
   of the threshold: `_reanchorLpUnitValue` can creep the live
   high-water mark above `vpGenesis + growth` by mint/burn rounding
   dust, which would eventually clear the gas guard and fire a
   dust-funded repeg on a pool configured as disabled (audit L-4).
1. **Cadence guard.** `block.timestamp <= _lastRepegTs ⇒ no-op` — at
   most one commit per block AND never more than one per second
   (sub-second blocks share a timestamp, so the second binds there,
   the block everywhere else). The
   profit-share gate already prevents abuse, this is a gas safeguard
   against multi-repeg in a single tx.
2. **Activation threshold.** `|max(ema,priceScale)/min(ema,priceScale) − 1|
   (WAD) < activeThreshold ⇒ no-op`, where `activeThreshold` is the
   **direction-split dead-band**: `_repegThresholdToken1UpWad` while
   `ema > priceScale` (token1 price rising in token0 terms), else
   `_repegThresholdToken1DownWad`. Under the mainnet base-in-slot-0
   layout a rising base asset reads as token1-DOWN, so a smaller `down`
   band chases base rallies eagerly while a larger `up` band damps
   drawdown tracking (the bundled presets ship Up = 2.5e15 /
   Down = 1.5e15). The deviation is **geometric** (multiplicative), so
   a ±2× EMA move registers `1.0` WAD in either direction, consistent
   with the symmetric `[ps/2, 2ps]` EMA clamp — the full `[1, WAD]`
   range activates symmetrically on both sides. The dead-bands are
   **decoupled** from the per-repeg step cap `repegStepWad`: the
   threshold decides WHEN the anchor wakes, the damped step decides HOW
   FAR it moves per commit.
3. **Pre-repeg gate** — read the cached storage trio
   (`_lpUnitValueGenesisWad`, `_lpValueGrowthWad`, `_repegShareBps`)
   and compute:
   * `thresholdWad = vpGenesis +
     lpValueGrowthWad · (BPS − _repegShareBps) / BPS`.
     `_repegShareBps` is **pre-scaled at `initialize`** to encode the
     protocol-fee compensation:
     `stored = ⌊ user_share · BPS / (BPS − protocolFeePercent · 100) ⌋`.
     This bakes the gross-up into the stored value so the hot path
     reads only one slot and uses the simple LP-floor formula. The
     net effect: repegs fire after the **same** total swap volume
     regardless of `_protocolFeePercent` — the protocol slice is
     funded from LPs' residual, not from the rebalance budget. The
     factory enforces `user_share + protocolFeePercent · 100 ≤ BPS`
     so the stored value never exceeds `BPS`. `getFeeConfig()`
     reverses the map via the ceil inverse to return the user-set
     share bit-for-bit.
   * `REPEG_GAS_GUARD_WAD = 4e10` — absolute anti-noise floor in vp
     units (≈2e-8 of an accepted genesis unit value near `2·WAD`).
     Prevents micro-rebalances whose gas cost would dwarf the LP
     gain.
   * Compute the live `vpBefore = _computeLpUnitValueWad(reservesAfter)`
     under the **current** anchor. If `vpBefore <= thresholdWad +
     REPEG_GAS_GUARD_WAD`, no profit headroom — hand over to the
     donation parachute (`_tryDonationParachute`) instead of returning
     silently: its own qualifiers (anchor lag ≥ `parachuteBandMult ×`
     the active dead-band, usable buffer above the dust floor,
     full-step shortfall covered) decide whether parked donations fund
     the move.
4. **Base step.** `PoolOracle.appliedRepegStep` sizes the log-domain
   step `appliedStepWad = min(repegStepWad, deviationWad /
   REPEG_DAMPING_DIVISOR)` (divisor 5). The damping cap pulls the move
   to zero as priceScale approaches the EMA — asymptotic catch-up,
   never overshoots the target.
5. **Halving ladder + post-repeg gate.** For `k = 0..
   MAX_REPEG_STEP_HALVINGS (3)` the pool probes the candidate
   `priceScaleNew = PoolOracle.applyLogStep(ps, ema, appliedStepWad >> k)`
   — a **multiplicative** step `ps · expWad(±applied)` (single `expWad`
   call site, sign by direction, clamped to never overshoot the EMA).
   The log-domain form is orientation-symmetric: an up-step and a
   down-step of the same magnitude compose to the identity, so the
   token-order of the pair cannot bias the anchor's trajectory (an
   additive step leaves an `O(s²)` residue per repeg). For each rung
   probe `vpAfter = _computeLpUnitValueWad(reservesAfter, csAfter,
   supply)` with the candidate priceScale. Under the asymmetric coord
   change, repegs at fixed reserves shift `yMath` only — `L_eq`
   typically drops and the `√(priceScale · WAD)` factor in `vp` either
   partially compensates or amplifies the IL signal, giving the gate a
   real cost-of-IL reading. If `vpAfter < thresholdWad`, the rung's IL
   cost would consume more than the configured share of cumulative
   growth — try the next (halved) rung; a rung that shrinks to zero or
   to a dust move ends the ladder (smaller rungs can only stay dust).
   The coarse ÷2 rungs deliberately leave a budget cushion: the first
   affordable rung spends well under the full allowance, so a pool
   keeps tracking through extended one-way regimes instead of scraping
   its growth budget to the floor on the first block.
6. **Commit.** On the first affordable rung: write the new
   `_priceScaleWad`, latch `_lpUnitValueWad = vpAfter` (the high-water
   mark drops to the post-repeg value, but `_lpValueGrowthWad` is
   intentionally left intact so future swaps can fund follow-up
   repegs), bump `_lastRepegTs`, and emit `PriceScaleUpdated`. If no
   rung passes, the donation parachute is consulted — it is reached
   exactly when NO rung committed (from the pre-repeg gate above and
   here after ladder exhaustion). If the parachute also declines, the
   swap settles with the anchor untouched and the ladder re-arms on
   the next eligible block — there is no cross-block ladder memory.

### LP unit-value accounting (`_lpUnitValueWad` / `_lpValueGrowthWad`)

The pool tracks LP earnings as a strictly monotonic
**LP-unit-value growth accumulator**. There is no separate fee bucket:
LP gains are always tied to the per-LP-unit value of the pool itself.

- **Genesis / epoch base:** `_lpUnitValueGenesisWad =
  _computeLpUnitValueWad(...)` is sampled on the very first liquidity
  event. In exact arithmetic the `√(priceScale·WAD)` normaliser cancels
  pair scale against geometric-mean supply and gives `2·WAD`; fixed-point
  rounding may land on either side. The genesis mint **enforces**:
  `|vpGenesis − 2·WAD| ≤ MAX_GENESIS_VP_ERROR_WAD (4e10)`, else it
  reverts `GenesisVpImprecise`. Insufficient normalized depth can store
  an understated/zero base; an extreme reserve ratio can also quantize
  `priceScale` too coarsely even after proportional seed growth. Both are
  outside the supported genesis domain. The
  geomean burn floor (`MIN_INITIAL_LIQUIDITY`, raised to `1e6`) cannot
  bound this because genesis `nWad = xWad²/WAD` depends on the base-side
  reserve, not the geometric mean. This gate is the stated precondition
  behind the absolute `REPEG_GAS_GUARD_WAD`. It is the base every gate
  threshold measures against. Runtime `repegShareBps` changes ratchet it forward: each
  change seals the closing epoch under the outgoing share
  (`base += ceil(growth · (BPS − oldShare) / BPS)`, accumulator
  restarts), so the base is monotone non-decreasing and always ≤ the
  live unit value. Swaps, mints and burns never touch it.
- **Per-swap accrual:** after the curve math commits new reserves,
  `_accrueLpValueGrowth` recomputes the live `vpNow`. If
  `vpNow > _lpUnitValueWad`, the delta is added to
  `_lpValueGrowthWad` and the high-water mark advances. The
  `vpNow <= vpLast` short-circuit prevents transient sub-wei
  rounding from double-counting growth on the way back up.
- **Mint/burn re-anchor:** proportional liquidity events do NOT
  create or burn LP gain — they only change the unit by which future
  deltas are measured. `_reanchorLpUnitValue` recomputes `vpNow`
  against the post-mint / post-burn supply and writes it into
  `_lpUnitValueWad`. `_lpValueGrowthWad` is **never** rescaled.
- **Repeg latch:** a successful auto-repeg drops the high-water mark
  to `vpAfter` (so the next swap measures growth against the
  post-repeg unit value), but `_lpValueGrowthWad` carries forward
  unchanged. This is what lets a pool fund several consecutive
  repegs out of a single pre-existing growth cushion.

`_repegShareBps` controls how aggressively the gate is allowed to
spend that cushion:

- `_repegShareBps == 0` disables auto-repeg entirely via the explicit
  step-0 short-circuit in `_tryAutoRepeg` (the threshold alone would
  *almost* hold the gate shut, but `_reanchorLpUnitValue` watermark
  creep from mint/burn rounding dust defeats "by construction" — see
  audit finding L-4 and the NatSpec at the short-circuit).
- `_repegShareBps == 5000` is the contract's conservative reference
  split and gives the gate half of the
  accumulated growth; the other half stays with LPs as a margin of
  safety — the pool only ever spends half of what it has verifiably
  earned.
- `_repegShareBps == 10000` lets the gate consume 100% of growth — a
  "track-the-market" mode useful for pegged pools that prefer
  responsiveness over LP cushion.

`REPEG_GAS_GUARD_WAD = 4e10` is hardcoded in `Constants.sol` (an
absolute vp-units threshold — accepted genesis values are constrained to
`2·WAD ± 4e10`, so no per-pool scaling is needed). Treat it as a hardcoded
anti-noise gas guard, not a tunable.

### Sizing the repeg knobs (dead-bands + `repegStepWad`)

Three decoupled knobs (the dead-band/step-cap pattern of the live
reference twocrypto pools, with the dead-band split by direction):

- **`repegThresholdToken1UpWad` / `repegThresholdToken1DownWad` —
  direction-split activation dead-bands.** No repeg attempt while the
  geometric deviation `|max(ema, ps)/min(ema, ps) − 1|` is below the
  side's band (`up` while `ema > priceScale`, else `down`). These are
  the knobs the stall guard applies to — each side independently.
  Under the mainnet base-in-slot-0 layout, token1-DOWN corresponds to
  the base asset rising, so `down < up` biases the anchor toward
  chasing base rallies (momentum asymmetry).
- **`repegStepWad` — per-repeg step cap.** Once awake, the anchor
  moves by the log-domain step `applied = min(repegStepWad,
  deviation/5)` (i.e. `ps · exp(±applied)`) at most once per block
  and never more than once per second;
  the cap bounds the anchor's slew rate (and therefore its
  manipulability through the EMA) regardless of the deviation. When
  the vp gate refuses a rung, the halving ladder retries at
  `applied/2`, `/4`, `/8` within the same attempt.

The 2026-07 decoupling study (1585-day benchmark, WBTC preset,
`threshold = step/5`): 13× more commits, average slippage −30 %,
LP PnL +16.7 pp — a previously dormant anchor (dead-band 0.5 % on a
flat 1.7 % fee) woke up and kept concentration on-market. The WETH
preset (already actively tracking) lost ~2 pp under the arb-only
volume model, so per-pool calibration matters: the bundled presets
ship `Up = 2.5e15 / Down = 1.5e15` for both WETH and WBTC, calibrated
by the follow-up 2026-07 runs (the asymmetric pair beat every
symmetric setting on the full window for both bases).

Why the dead-band exists (and must not be removed):

- **It is the only filter that can stop vp-neutral churn.** Near the
  anchor a small `priceScale` move is value-neutral for the LP-unit
  metric (second order in the step), so both vp gates pass and the
  growth budget is not consumed. Without the dead-band, any pool
  holding a growth cushion commits a dust repeg nearly every block in
  a jittery sideways market — 3 SSTOREs + an event billed to the
  block's first swapper, plus permanent anchor/oracle churn.
- **It keeps the hot path flat.** `_lastRepegTs` advances only on a
  successful commit, so non-committing attempts would re-run the
  threshold SLOADs, the candidate shift and the `vpAfter` probe on
  every swap of the block. Below the quantum a swap pays one SLOAD +
  one mulDiv here and exits.

**Calibration rule: each dead-band `≲ feeFloorBps · 1e14`** — neither
band should exceed the fee floor (or the flat `baseFee` when the ramp
is disabled), all read as relative fractions. Rationale: the vp cost
of a repeg fired at deviation `dev` grows ~quadratically in `dev`
(move size `dev/5` × reserve imbalance ∝ `dev`), while the fee-funded
growth budget accrued by the very flow that created the deviation
grows only ~linearly in `dev`. `cost/budget ∝ dev`, and the dead-band
pins the *first permitted attempt* on its side at `dev = threshold` —
set it far above the fee scale and that first move is already
unaffordable: the post-repeg gate skips (the halving ladder softens
but cannot remove this — even the smallest rung's cost still scales
with `dev`), and waiting only worsens the ratio (a stall that
persists until unrelated volume replenishes the budget). The step cap
needs no such guard: a large cap only widens the per-commit ceiling
while the damping `deviation/5` keeps individual moves proportional.

| regime | dead-band                                 | behaviour                                                              |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------- |
| quiet  | large (e.g. `5e15` with a 60 bps floor)   | rare, meaningful repegs; anchor lags the EMA by up to one dead-band     |
| tight  | tiny (e.g. `1e14` and below)              | near-continuous tracking; dust commits at the full cadence once a cushion exists |

Worked check against the bundled presets: WETH (`Up 2.5e15 /
Down 1.5e15`, floor `136 bps = 1.36e16`) ✓; WBTC (same bands, floor
`146 bps = 1.46e16`) ✓. A misconfigured sharp-curve pool (floor
`2 bps = 2e14`, band `1e15`) stalls: at `dev = threshold` the
forced move already costs ~2× the accrued budget, and the gap only
widens as `dev` grows.

Two refinements from the 2026-07 stall-risk study (measured through the
exact kernel):

- **Flat-fee pools need extra margin.** The binding deviation is not
  `dev = threshold` but `dev ≈ 5·step..20·step` (the damping cap stops
  shrinking the move there while the budget is still ~linear). For
  pools with `feeRampBps = 0` use `threshold ≤ 0.7 · baseFee · 1e14`;
  ramp-enabled pools are rescued by the ramp revenue in exactly that
  window, so the plain rule holds with margin.
- **A lower bound exists too.** The anchor's maximum slew rate is
  `step × commits/day`, so a quantum far below
  `expected daily |move| / swaps per day` leaves the pool
  bandwidth-limited: it can never track a fast repricing regardless of
  budget (it relies on mean reversion instead). This is a tracking-lag
  trade-off, not a stall — but size it consciously.

### Geometric EMA + oracle protection

`PoolOracle.updateEma` averages in the **log domain** (geometric EMA):

```
ratio  = divWad(cappedSpot, ema)
ema'   = mulWad(ema, expWad(lnWad(ratio) · (WAD − α) / WAD))
```

An arithmetic EMA carries a Jensen bias: `EMA(p) · EMA(1/p) ≥ 1`
(≈ σ²/2 of the mixed ratios), so the same market read through the two
token orders produces oracles that disagree by the price variance —
an orientation-dependent repeg subsidy on whichever side is
convexity-favoured. The log-domain blend removes the bias exactly:
mirroring every price reciprocates the EMA bit-for-bit (up to
fixed-point dust), and `spot == ema` is an exact fixed point. The
Rust kernel (`equilibra_math.rs::geometric_ema_step` over `ln_wad` /
`exp_pos_wad`) mirrors the same op order for bit-for-bit parity.

Protection layers:

1. **Symmetric spot cap.** Spot is clamped to
   `[priceScale / EMA_PRICE_CAP_DIV, priceScale · EMA_PRICE_CAP_MUL]`
   (defaults: ÷2, ×2) before being mixed into the EMA, so a single
   manipulated trade cannot drag the oracle past 2× in either
   direction.
2. **Repeg cadence gate** (enforced in `_tryAutoRepeg` via
   `_lastRepegTs`) plus the direction-split geometric activation
   threshold `|max(ema,priceScale)/min(ema,priceScale) − 1| ≥
   repegThresholdToken1{Up,Down}Wad`. Together they bound multi-block
   manipulation: `priceScale` walks at most one `repegStepWad` per
   block — never more than one per second — regardless of how the EMA
   moves.

The bootstrap path (no prior EMA) seeds the EMA with the current spot
without applying the cap — there is no history to anchor against.
Same-block re-entries are no-ops by design.

---

## Emergency pause

Factory owner can pause individual pools:

- **Blocked when paused:** `swap`, `addLiquidity`.
- **Allowed when paused:** `removeLiquidity`, `collectProtocolFees`.

```solidity
function setPaused(bool paused_) external; // factory owner only
function paused() external view returns (bool);
```

`removeLiquidity` stays callable while paused so LPs can always exit;
the exit also performs its proportional donation-buffer rebalancing
burn (value-neutral — it only keeps `parked/active` invariant).
Donations are untouched by the pause: the guarded entrypoint is
`EquilibraRouter.donate` (the router has no pause switch) and the
primitive is a plain LP transfer to the pool address — neither goes
through a pausable pool function.

---

## Key parameters

| Parameter           | Range                  | Description                                                                                                        |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `aWad`              | `[1e17, 99e16]`        | Depth-at-anchor knob (WAD). `A(D=0) = a`; larger `a` deepens the plateau at the centre. Forbidden at WAD (would force constant-sum / ill-conditioned L-quadratic). |
| `lambdaWad`         | `[1e15, 1e18]`         | Plateau-width knob (WAD). At `λ·D = W`, `A = a/2` (half-amplification distance). Larger `λ` narrows the plateau. Decoupled from `aWad`. |
| `baseFee`           | `[5, 2000]` bps        | Maximum swap fee = ceiling of the smoothstep ramp.                                                                 |
| `feeRampBps`        | `[0, 10000]` bps of WAD | Smoothstep warm-up width. `0` disables the ramp (flat `baseFee`). A live ramp must satisfy `feeRampBps · (BPS − baseFee)² ≥ FEE_RAMP_GUARD_MULT · BPS · (baseFee − feeFloorBps)²` (`FeeRampTooNarrow`) — narrower ramps would make a larger exact-in trade return less output. |
| `feeFloorBps`       | `[0, baseFee]` bps     | Lower bound of the dynamic fee. Equality with `baseFee` only allowed when `feeRampBps == 0` (factory rejects the misconfig). |
| `repegShareBps`     | `[0, 10000]` bps       | Share of **total fee** budget the repeg gate may spend. `0` disables auto-repeg; `5000` is the conservative 50/50 reference; the bundled presets use `5500` (WETH) / `7000` (WBTC). Capped by `BPS − protocolFeePercent · 100` (factory revert `RepegShareExceedsBudget`). |
| `protocolFeePercent`| `[0, 25]`              | Protocol slice of every swap fee, percent (NOT bps). Capped at 25 % so `repegShareBps` and the LP residual always have meaningful budget. |
| `emaPeriod`         | `[60, 419731]` seconds | Half-life of the price EMA. The factory stores the internal relaxation time `tau = ceil(emaPeriod · 1000 / 694)` (bounded by `MAX_EMA_PERIOD = 7d`, hence the ≈4.86 d input ceiling); `getFeeConfig` returns the half-life back bit-for-bit. |
| `repegStepWad`      | `[1, WAD]`             | Per-repeg cap on the log-domain `priceScale` step: `applied = min(repegStepWad, deviation / REPEG_DAMPING_DIVISOR)`, committed as `priceScale · expWad(±applied)` at most once per block and never more than once per second (the halving ladder may settle on `applied >> k`, `k ≤ 3`). Bounds the anchor's slew rate (and its manipulability through the EMA). No fee-scale guard applies to the cap. |
| `repegThresholdToken1UpWad` | `[1, WAD]`     | Activation dead-band while `ema > priceScale` (token1 price rising in token0 terms): short-circuit while the **geometric** deviation `\|max(ema,priceScale)/min(ema,priceScale) − 1\|` is below it. The geometric metric makes a ±2× move read `1.0` WAD both ways, so the full `[1, WAD]` range is usable under the `[ps/2, 2ps]` EMA clamp. When auto-repeg is live (`repegShareBps != 0`) the factory enforces the stall guard `threshold ≤ feeScale · 1e14` per side (revert `RepegThresholdExceedsFeeScale`); with `repegShareBps == 0` both bands are inert and only the `[1, WAD]` range applies. |
| `repegThresholdToken1DownWad` | `[1, WAD]`   | Same dead-band for the opposite side (`ema < priceScale`, token1 price falling — i.e. the base asset rising under the mainnet base-in-slot-0 layout). Setting `down < up` makes the anchor chase base rallies more eagerly than drawdowns (the bundled presets ship `2.5e15 / 1.5e15`). Same range and per-side stall guard as the `up` band. |
| `parachuteBandMult` | `[1, 255]`             | Donation-parachute activation multiplier K: the parachute opens only at a geometric deviation ≥ `K × active dead-band`. Per-pool storage seeded at `Constants.REPEG_PARACHUTE_BAND_MULT = 30` for every pool — **never** a creation parameter — and timelock-adjustable (`queueParachuteBandMult` / `executeParachuteBandMult`; zero reverts `InvalidParachuteBandMult`). Exposed as the last field of `getFeeConfig()`. |

### Runtime-adjustable parameters (param timelock)

A minimal subset of the config stays tunable after deployment through
`EquilibraParamTimelock` — a singleton deployed by the factory
constructor. The pool creator (the `createPoolAndAddLiquidity` caller)
is the per-pool parameter admin: LPs joined a curve the creator
calibrated, and the delay between `queue*` and `execute*` (24 hours;
10 minutes on private pools — see below) gives any dissenting LP the
whole window to exit at the old parameters
(`removeLiquidity` is never gated). Queued changes expire after a
7-day grace window; execution is admin-gated like queue and cancel
(the admin keeps the whole lifecycle of a queued change); the admin role is
transferable via a two-step nominate/accept handover and renounceable
(renounce = parameters frozen forever).

**Private pools** (`createPrivatePoolAndAddLiquidity`): every mint's
RECIPIENT must sit on the pool's LP allowlist, held on the factory
(`isLpAllowed` / batch `setLpAllowed`, editable by the pool admin
resolved live from the timelock — handover and renounce govern the
allowlist too). The gate lives in the pool's `addLiquidity`, so it
covers the router, both zap-ins and direct calls at one site; exits,
swaps, donations and ERC20 LP transfers stay ungated (the allowlist
bounds entry by minting, not secondary custody). Privacy is chosen at
creation and immutable; the creator and the genesis recipient are
allowlisted automatically. Private pools run the parameter timelock on
`PRIVATE_DELAY = 10 minutes` instead of the public 24 h — their LP set
is admin-curated, so the long public exit window protects nobody the
admin has not already chosen; the queue/announce/cancel machinery and
the 7-day grace stay identical.

- **Adjustable:** the dynamic-fee triple (`baseFee`, `feeRampBps`,
  `feeFloorBps`), `repegStepWad` (runtime range = the factory's
  deploy range, and one queued change may at most double or halve the
  live value — `RepegStepChangeTooLarge` otherwise, so an extreme
  setting takes several queue windows (24 h public / 10 min private)
  and LPs keep a full exit
  window between moves), the direction-split dead-band pair
  (`queueRepegThresholds(up, down)` — both bands change together,
  validated against the factory range and the stall guard on the LIVE
  fee scale at queue AND execution time), `repegShareBps`
  (floor `5000` user-space; ceiling `9500`
  in STORED space, i.e. after the protocol-fee gross-up, so LPs keep
  ≥ 5% of growth at any `protocolFeePercent`; pools created with
  `repegShareBps = 0` keep it immutable in both directions), and
  `parachuteBandMult` (`queueParachuteBandMult` /
  `executeParachuteBandMult` / `cancelParachuteBandMult`, range
  `[1, 255]` — zero reverts `InvalidParachuteBandMult`). Admin
  handover is two-step (`nominatePoolAdmin` then the nominee's
  `acceptPoolAdmin`), so a mistyped address never captures the role;
  accept and renounce clear the pending queue (the parachute-K queue
  included) — a renounced pool is frozen immediately, not after a
  still-executable queue drains.
- Share changes are **non-retroactive by construction** (epoch
  ratchet): executing `setRepegShareBps` first seals the closing
  epoch under the outgoing share — its protected growth slice is
  ratcheted into the gate base forever, the growth accumulator
  restarts, and the live spendable budget carries over untouched.
  History is split exactly once, by the share in force while it was
  earned; the jump of the base depends on the outgoing share only.
  No delay bypass exists — every change still waits its full queue window.
- **Immutable forever:** `aWad`, `lambdaWad` (the curve LPs bought
  into), `emaPeriod` (oracle manipulation-resistance) and
  `protocolFeePercent`. Fee changes are re-validated against the two
  stored dead-bands via the stall guard, and threshold changes against
  the live fee scale — the pair can never drift into a stalling
  combination through either path.
- The pool-side setters are bare stores gated to the timelock — the
  same trust split as `initialize` (factory validates, pool stores),
  preserving the pool's scarce bytecode headroom. Every invariant (fee
  bounds, ramp headroom, stall guard) and every policy rule is
  enforced by the timelock both at queue time and again at execution
  time against the live config.

> Recommended defaults for general-purpose pools: `feeRampBps = 1000`,
> `feeFloorBps = 20`, `repegShareBps = 5000`. Stable / pegged pools tighten
> the ramp (`feeRampBps = 50…200`) and shrink both dead-bands to `1e14`
> (symmetric — the Up/Down split is a momentum knob for volatile pairs,
> not a pegged-pool tool). The factory **enforces**
> `repegThresholdToken1{Up,Down}Wad ≤ feeScale · 1e14` per side whenever
> `repegShareBps != 0` (`RepegThresholdExceedsFeeScale`; feeScale is the
> floor with a live ramp, flat `baseFee` otherwise) — see "Sizing the
> repeg knobs" above for the stall mechanics behind the rule. Note the
> corollary: `feeFloorBps = 0` with a live ramp is undeployable while
> auto-repeg is enabled (the cap collapses to zero) — raise the floor
> to at least 1 bps or disable auto-repeg. For flat-fee pools prefer
> extra margin (`≤ 0.7 · baseFee · 1e14`, see the refinements above).
>
> **Rebalance cadence is `protocolFeePercent`-independent.** Two pools
> with the same curve / fee / share settings will fire auto-repegs
> after the **same** total swap volume regardless of
> `protocolFeePercent` — the protocol slice comes out of the LPs'
> residual, not out of the repeg budget. See
> `EquilibraPool._tryAutoRepeg` NatSpec for the algebra.

### Curve parameters — WAD, display, and visualizer band

Two independent concentration knobs (`aWad`, `lambdaWad`), both
stored as `uint64` WAD-scaled values. Display values are simply
`wad / 1e18` (e.g. `aWad = 5e17` ↔ display `0.5`).

| Param       | Contract (WAD)        | Contract (display) | Visualizer (research band) |
| ----------- | --------------------- | ------------------ | -------------------------- |
| `aWad`      | `[1e17, 99e16]`       | `[0.1, 0.99]`      | `[0.01, 0.99]`             |
| `lambdaWad` | `[1e15, 1e18]`        | `[0.001, 1.0]`     | `[0.0001, 10]`             |

Contract bounds (`Constants.A_MIN_WAD` / `A_MAX_WAD` /
`LAMBDA_MIN_WAD` / `LAMBDA_MAX_WAD`) are enforced by
`EquilibraFactory` at deploy time (revert with `InvalidA` or
`InvalidLambda`). The Curve Lab in the visualizer exposes a wider
research band — values outside the production envelope are
rejected by the factory but are useful when calibrating new
presets via the live curve preview.

---

## Code conventions

- **PRECISION = 1e18** for all scaled values. `BPS = 10_000`.
- All math goes through Solady's `FixedPointMathLib` (`mulWad`, `mulDiv`,
  `mulDivUp`, `divWad`, `sqrt`, `powWad`, `expWad`).
- Internal storage uses underscore prefixes (`_reservesPacked`,
  `_priceScaleWad`, `_lpUnitValueWad`, `_lpValueGrowthWad`). Reserves
  and protocol-fee buckets are packed two `uint128`s per slot.
- Custom errors only — no `require(string)`. Surface lives in
  `libraries/Errors.sol`.
- Solidity `0.8.36` with `optimizer.runs = 2000`, `viaIR = true`,
  `evmVersion = "cancun"`.
- English-only comments and NatSpec.
- The pool **never** assumes `name` / `symbol` are constants — clones boot
  storage-backed metadata via `_setLpTokenMetadata`. Solady's ERC20 resolves
  the EIP-712 `DOMAIN_SEPARATOR` lazily from `name()`, so this drops in
  without overrides.

---

## Test layout

```
test/
├── experiments/                    # Research probes outside EVERY npm-test glob (even `all`):
│                                   #   TokenOrderMirror — run explicitly via
│                                   #   `npx hardhat test test/experiments/TokenOrderMirror.test.ts`.
├── fixtures/                       # Shared deploy / pool fixtures.
├── helpers/                        # Reusable test helpers (e.g. securityFixtures.ts).
├── integration/                    # End-to-end smoke tests.
├── liquidity/                      # mint/burn (proportional, permit, router liquidity flows).
├── math/                           # Library-level math regressions (20 files):
│                                   #   AsymmetricCoordChange, GeometricMirrorInvariance, Kernel,
│                                   #   NoPersistentG, PoolOracleEmaProtection,
│                                   #   PoolOracleShiftPriceScale, PriceScaleStability,
│                                   #   PriceScaleUpdatedEventArgs, SmoothstepFee, SolveLPostRepeg,
│                                   #   SqrtPriceX96, SwapMathHelpers, SwapPath, SwapSymmetry,
│                                   #   TwoKnobIndependence, TwoKnobMonotonicityEdge,
│                                   #   ArbitrageMath, DistanceFromAnchor, HighPrecisionHarness,
│                                   #   UsdtWbtcAwayTowardTable.
├── periphery/                      # Router integration: factory, multicall, multi-hop, WETH9, zap,
│                                   # param timelock (10 files):
│                                   # (FactoryBoostRegistry, FactoryIntegration, FactorySafeSymbol,
│                                   #  FactoryViewsAndValidation, MultihopAndVerification,
│                                   #  MultihopWethIntegration, PoolParamTimelock,
│                                   #  RouterExactOutputSingle, RouterPeripheryPayments, RouterZap).
├── security/                       # Pool-level invariants + dynamic-fee guarantees (23 files):
│                                   #   DynamicFee, DynamicFeeMonotonicity,
│                                   #   DynamicFeeSplittability, PoolSecurity,
│                                   #   ImplementationLock, RoundTripNoArbitrage,
│                                   #   AggressiveRoundTrip, SwapBatchVsSingle, CpZoneSecurity,
│                                   #   ExactOutStressCrossAnchorRepeg, LiquidityFluxStability,
│                                   #   NoFeeArbBetweenPaths, PathAdditivity,
│                                   #   PathAdditivityExactOut, QuoteSwapToPrice,
│                                   #   RepegConservation, RepegHalvingLadder, RepegProfitShare,
│                                   #   GenesisPrecision, DonateGuard, DonationParachute,
│                                   #   OracleViewsForBoost, BytecodeSize.
└── simparity/                      # Bit-exact parity vs the Rust simulator (4 files):
    ├── CurveRustParity.test.ts       # Curve V2 reference baseline parity (needs locally
    │                                 #   built artifacts; self-skips when absent).
    ├── DynamicFeeRustParity.test.ts  # Sweeps both directions through ramp + disabled paths.
    ├── ExactOutRustParity.test.ts    # exactOutput parity (closed-form + secant solver).
    └── GeneralRustParity.test.ts     # Full scenario (quote + swap + add/remove + auto-repeg).
```

### Internal-helper tests via `MockEquilibraPool`

Some regression tests (e.g. the post-swap-reserves repeg invariant in
`RepegProfitShare`) need to call internal helpers like
`_computeLpUnitValueWad` against arbitrary inputs without baking probe
APIs into the production contract. The repo provides
`contracts/mocks/MockEquilibraPool.sol` for that: a `EquilibraPool`
subclass that re-exposes a small, hand-picked set of internals
(`exposed_computeLpUnitValueWad`, `exposed_computeLpUnitValueWadAtPriceScale`,
`exposed_computeLpUnitValueWadWithCs`, `exposed_toWadByScale`,
`exposed_computeK`, `exposed_solveLFromState`) as `external view/pure`
one-liner forwarders, plus the state-mutating
`exposed_tryDonationParachute` (the δ = 0 no-subsidy commit branch is
unreachable deterministically through swap scenarios; the forwarder is
the Solidity twin of the corresponding Rust unit test). Tests load it via
`getContractFactory("MockEquilibraPool")`; production bytecode is
untouched.

All numbers (presets, gas estimates, prices) used by the parity tests are
sourced from `simulator/test_helpers/config.ts`, which itself shells out
to `equilibra-offchain-config-defaults`; gas estimates and Curve donation
settings come from that same typed JSON, without source-code parsing. That is by design — the
on-chain tests cannot drift away from the simulator's single source of
truth, no matter how the dashboard or hand-edited `params.json` is
configured.

---

## Notes for further iteration

- The dynamic fee, the repeg gate, and the auto-repeg all share a single
  storage slot family — extending any of them should preserve the existing
  packing (see `_baseFee` / `_protocolFeePercent` / `_emaPeriod` /
  `_feeFloorBps` / `_repegShareBps` / `_token0Scale` / `_token1Scale`
  block in `EquilibraPool.sol`) so the hot path keeps doing zero extra
  SLOADs. The LP-unit-value accumulator trio
  (`_lpUnitValueGenesisWad`, `_lpUnitValueWad`, `_lpValueGrowthWad`)
  takes one full slot each — none of them are packed because the
  `_tryAutoRepeg` hot path has to read all three plus a fresh
  `_computeLpUnitValueWad` evaluation.
- When changing the smoothstep math or the kernel solver,
  regenerate the parity fixtures by re-running both simulator unit
  tests and `test/simparity/*` — those tests are the contract for
  "Solidity == Rust".
- The simulator's `totalFeesUsd` reporting reads the **actual** dynamic fee
  out of the executor (`StatefulSwapExecOut.fee_amount_raw` /
  `actual_fee_bps`); when extending the fee model, plumb the new fee
  through `runtime_quoter/equilibra.rs::execute_equilibra_stateful_swap`
  and update `main.rs::execute_stateful_swap_for_context` accordingly.
