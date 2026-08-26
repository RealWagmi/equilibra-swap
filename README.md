# EquilibraSwap

EquilibraSwap is a single-pool concentrated-liquidity AMM. The shape
of the curve is set by **two independent immutable knobs
`(aWad, lambdaWad)`** and reshaped on every swap by the pool's own
off-balance distance `D` in asymmetric (quote-side normalised)
math-space coordinates:

```
priceScaleWad = yWad / xWad  at the anchor      (quote / base, WAD)

xMath = xWad                                    (base, identity)
yMath = yWad · WAD / priceScaleWad              (quote → base units)

K(x, y; L) = A · L · (x + y) / 2  +  (W − A) · x · y
A          = a · W / (W + λ · D)
D          = (y − x)² / (x · y)
W          = WAD = 1e18
```

At the anchor (`xMath = yMath = L`) the kernel reduces to
`K = W · L²`. At deep imbalance (`D → ∞`) it collapses to the
constant-product asymptote `K → W · x · y` — every swap stays
feasible, no liquidity wall.

Highlights:

- **Two-knob design with full decoupling.** `aWad` ∈ `[0.1·W, 0.99·W]`
  controls the depth at anchor (`A(D=0) = a`); `lambdaWad` ∈
  `[1e15, 1e18]` controls the plateau width (`A = a/2` at `λ·D = W`).
  Moving one knob never shifts the other's effect — operators can
  tune centre depth and cliff position independently.
- **Asymmetric math-space coordinate change.** Only the quote side is
  normalised by `priceScale`; the base side stays identity. A repeg
  moves `yMath` only, so off-balance reserves register a genuine
  math-space displacement after each anchor shift — exactly the IL
  signal the auto-repeg solvency gate needs.
- **Anchor that follows the market.** A protected geometric
  (log-domain) EMA oracle observes every swap; an auto-repeg gate
  inches `priceScale` toward the EMA in bounded, damped multiplicative
  steps (`priceScale · exp(±applied)`, with a halving ladder when the
  budget only affords a partial move), financed entirely by
  accumulated swap fees. LPs are guaranteed to keep at least
  `(BPS − repegShareBps) / BPS` of fee growth (the conservative 50 % reference at
  `repegShareBps = 5 000`).
- **Dynamic fee.** Smoothstep ramp from `feeFloorBps` near the
  anchor to `baseFee` at deep imbalance, with a single closed-form
  prediction per swap. Set `feeRampBps = 0` to opt out.
- **Bit-exact off-chain twin.** The Rust simulator
  (`simulator/`) is a byte-for-byte port of the Solidity kernel; the
  parity tests under `test/simparity/` enforce
  Solidity == Rust on every PR.

---

## Disclaimer about benchmark comparisons

The simulator and several Hardhat benchmark tests run EquilibraSwap
side-by-side with two industry-standard reference AMMs (constant
product and a concentrated cubic-D design). Those references are
**only included as comparison baselines** — they let users see how
EquilibraSwap behaves under the same trade schedule, oracle path
and arbitrageur model as a familiar known design.

**The reference implementations are not the source of truth for those
projects, and the numbers produced by this repo for them are not a
literal verdict on their on-chain behaviour.** They are simplified
stand-ins:

- gas, fee precision and slippage policy are simulator
  approximations;
- corner-case behaviour, governance levers, ramp dynamics and
  oracle handling diverge in subtle ways from the upstream
  contracts;
- benchmark scenarios are designed to stress
  EquilibraSwap-specific properties (concentration, repeg cadence,
  IL coverage), not to be a representative live workload for any
  third-party AMM.

If you want to evaluate, audit, or reason about the production
behaviour of those AMMs, please refer to their own repositories,
documentation, audits and on-chain deployments. This repository
makes no claim to authoritatively describe them — the comparison is
purely directional context for EquilibraSwap.

---

## Repository layout

```
contracts/                  — Solidity sources
  EquilibraPool.sol           Core 2-token AMM (swap, mint, burn, EMA, auto-repeg)
  EquilibraFactory.sol        Clone factory + atomic createPoolAndAddLiquidity
  periphery/                  EquilibraRouter.sol (swap, liquidity, zap, payments)
  libraries/                  EquilibraSwapMath, Constants, PoolOracle, SwapPath,
                              PoolAddressCompute, Errors
  interfaces/                 IEquilibraPool, IEquilibraFactory, IEquilibraRouter,
                              IEquilibraSwapCallback, IEquilibraMintCallback,
                              IMulticall, IWETH9
  base/                       EquilibraLpToken (Solady ERC20 + EIP-2612 permit),
                              EquilibraPoolGuard (pause, factory-owner role)
  mocks/                      Test harnesses (MockEquilibraPool, StatefulKernelHarness,
                              SwapMathHarness, PoolOracleHarness, MockERC20, …)

scripts/                    — Helpers
  deploy/                     Split deploy pipeline: config.ts (per-network params),
                                core.ts, create-pool.ts, verify.ts (see Deployment below)
  test.ts                     Interactive `npm test` runner (math + periphery + security)
  fetch-prices-binance-long.ts  Extend simulator/data/{eth-usd,btc-usd}.json

test/                       — Hardhat tests
  security/                   Pool-level invariants (22 files)
  math/                       Library-level math regressions (20 files)
  periphery/                  Router / factory integration (10 files)
  simparity/                  Solidity ↔ Rust bit-exact parity gate (4 files)
  liquidity/                  Proportional add/remove + permit (3 files)
  integration/                End-to-end smoke
  fixtures/, helpers/         Shared deploy + helper modules

simulator/                  — Standalone Rust benchmark stack
  src/runtime_quoter/         Math / state kernel (bit-exact mirror of `contracts/`)
  src/app/                    Config schema (canonical source of truth), server,
                              orchestration, visualizer
  src/bin/                    CLI binaries (simulator, app, merge, report, defaults)
  test_helpers/               TypeScript bridge: loads Rust defaults via
                              `equilibra-offchain-config-defaults`
  app-web/                    Dashboard SPA (Setup, Runs, Curve Lab)
  visualizer/                 Standalone curve-shape playground (two sliders: a, λ)
  Info/                       Static info page (served at /info)
  report-web/                 Source report assets copied into each durable run bundle
  data/                       Oracle JSON inputs (eth-usd.json, btc-usd.json)
  runs/                       Per-run config, immutable inputs, results and reports
```

---

## Prerequisites

- **Node.js 18+** and **npm** for the Solidity toolchain.
- **Rust stable** (via [rustup](https://rustup.rs)) for the off-chain
  simulator.

Clone the repo and install JS dependencies:

```bash
git clone https://github.com/RealWagmi/equilibra-swap.git
cd equilibra-swap
npm install
```

---

## Build & test (Solidity)

```bash
npm run compile                # clean + hardhat compile
npm test                       # math / periphery / security suites + typecheck
npm run lint-fix               # prettier for .sol and .ts
npm run simulator:run
```

Run a single test file or pattern:

```bash
npx hardhat test test/security/RepegConservation.test.ts
npx hardhat test --grep "vp_final ≥ genesis"
```

### Coverage

```bash
npm run coverage               # solidity-coverage report → ./coverage/
```

> Coverage compiles through the legacy (non-viaIR) codegen for accurate
> per-statement hit counts; [`hardhat.config.ts`](hardhat.config.ts)
> flips `viaIR` off automatically (for both `npm run coverage` and a
> bare `npx hardhat coverage`), while `npm run compile` / `npm test`
> keep `viaIR: true`. A full instrumented run takes ≈ 35–40 minutes;
> gas-envelope assertions and the heaviest stress sweeps key off
> `SOLIDITY_COVERAGE=true` and are skipped or shrunk under coverage.

---

## Run the off-chain simulator

The simulator ships as a standalone Rust crate at `simulator/`. The
recommended entry point is the **dashboard server**, which exposes a
configurable Setup page, an interactive Curve Lab (visualizer),
on-demand simulation runs, and a Curve-Lab-style Info page. Three npm
shortcuts wrap the cargo invocations so you can drive everything from
the JS toolchain:

```bash
npm run simulator:run    # build & launch the dashboard server (release profile)
npm run simulator:test   # run the Rust unit + parity tests (release profile)
npm run simulator:clean  # drop cached cargo artefacts (forces a clean rebuild next run)
npm run simulator:fetch-prices  # extend the Binance oracle feeds to "now"
```

Each one is a thin alias around its cargo equivalent — for example,
`npm run simulator:run` expands to:

```bash
cargo run --manifest-path simulator/Cargo.toml --bin equilibra-offchain-app --release
```

Once the dashboard is up, open <http://127.0.0.1:3100> in your browser.

Optional environment variables:

| Variable                        | Default          | Effect                                               |
| ------------------------------- | ---------------- | ---------------------------------------------------- |
| `BENCHMARK_APP_HOST`            | `127.0.0.1`      | Bind host                                            |
| `BENCHMARK_APP_PORT`            | `3100`           | Bind port                                            |
| `BENCHMARK_APP_PORT_TRIES`      | `20`             | Adjacent ports to try if the first is busy           |
| `BENCHMARK_MAX_CONCURRENT_RUNS` | `1`              | How many simulation runs may execute in parallel     |
| `BENCHMARK_ORACLE_DATA_DIR`     | `simulator/data` | Shared source feed; digested (never copied) per run  |

Direct simulator binary (without the dashboard) is also available:

```bash
cargo run --manifest-path simulator/Cargo.toml --release \
  --bin equilibra-offchain-simulator -- \
  --config runs/<runId>/params.json \
  --output runs/<runId>/sim_results.json \
  --data-dir simulator/data
```

The direct command also writes `inputs/execution.json` beside its output —
a small manifest with the oracle content digest, effective options and
binary hashes. The feed itself is digested in place, never copied, so run
directories stay small. Report regeneration re-verifies the shared feed's
digest and fails closed if the consumed window was rewritten since the run;
the current source report assets are accepted only when their digest matches
the execution manifest:

```bash
cargo run --manifest-path simulator/Cargo.toml --release \
  --bin equilibra-offchain-report -- \
  --results runs/<runId>/sim_results.json \
  --output runs/<runId>/report
```

`--execution-manifest` is optional here only because it resolves to
`inputs/execution.json` beside the result; a missing or mismatched sidecar
fails closed.

### How a simulation flows

1. **Setup** — open the dashboard, tweak preset parameters in the
   Setup page (`aWad`, `lambdaWad`, fees, EMA period, repeg knobs, …) and click
   _Save_. The page materializes the complete
   `benchmark-run-config/v11` object and validates it against the same
   constraints the on-chain factory enforces; partial or older configs fail
   rather than inheriting hidden runtime defaults.
2. **Run** — submit a run from the dashboard. Before queue publication, the
   orchestrator copies the requested oracle range (including lookup guard
   candles) into the run and hashes it. It then records an execution
   fingerprint over config/partition hashes, exact oracle inputs, effective
   options, binaries and schema/algorithm versions. Per-context Rust workers
   use only those immutable inputs; progress streams via Server-Sent Events.
3. **Results** — every run is persisted under
   `simulator/runs/run_<...>/`. The merge keeps the complete root
   `sim_results.json` for trajectory comparison and report regeneration.
   Report generation uses a sibling staging directory, fsyncs it and
   atomically publishes `report/`; `report/REPORT_COMPLETE.json` binds the
   report to the execution, oracle and `resultDigest`. Only completed per-run
   assets are served—there is no fallback to mutable `simulator/report-web/`.

The durable part of a run is:

```text
runs/<runId>/
├── params.json
├── status.json
├── inputs/{oracle.json,oracle/,execution.json}
├── sim_results.json
└── report/{REPORT_COMPLETE.json,web/}
```

Shard logs/checkpoints/results may be pruned only after the completion marker
matches the run identities; the merged `sim_results.json` remains available.

The Setup config is the **single source of truth** for both the
simulator and the Hardhat tests:
`simulator/src/app/config.rs::build_default_config` returns the
canonical WETH / WBTC presets, and
`simulator/test_helpers/config.ts` sources them via the
`equilibra-offchain-config-defaults` binary so test fixtures and
simulator runs stay in lockstep.

For manual sharding, every worker must receive the same pre-created
`--execution-manifest`, immutable `--data-dir` snapshot and matching
`--origin-config-hash`, with only `--only-amms` / `--only-bases` varying.
A bare origin hash or independently generated per-shard manifests are rejected;
the merge command additionally requires that manifest via
`--execution-manifest` and durably writes both `--results-output` and the
atomic `--report-output` bundle.

---

## Deployment (Solidity)

Deployment is split into three idempotent steps. Every non-secret
parameter — WETH9 address, fee collector, protocol fee (percent of
every swap fee, set at factory construction so no pool can ever
snapshot a zero share), verification switch, and the
declarative pool list — lives in `scripts/deploy/config.ts` under git
review. `.env` holds only credentials (`DEPLOYER_PRIVATE_KEY`,
`ETHERSCAN_API_KEY`, optional RPC overrides — see `.env.example`).

```bash
# Compile first so artefacts / typechain are up to date.
npm run compile

# 1. Core contracts: pool implementation, factory (which deploys the
#    param timelock), router. Fails fast on incompatible chains (Cancun
#    probe, WETH9 compatibility probe), then verifies sources on the
#    explorer and writes the address book to deployments/<network>.json
#    (git-tracked; local dev chains write gitignored
#    deployments/local-*.json). Refuses to run twice for a network that
#    already has a document.
npm run deploy --network=<hardhat-network>

# 2. Pools: creates + seeds every pool declared for the network in
#    scripts/deploy/config.ts that is not yet recorded in the
#    deployments document (idempotent by pool `name`; the document is
#    updated after every pool). Supports native-value seeding of the
#    WETH9 leg (`nativeSeed: true`) and private pools (`isPrivate`).
npm run deploy:pools --network=<hardhat-network>

# 3. Verification re-run (safe to repeat; already-verified contracts
#    are skipped) — for when the explorer API flaked during step 1.
npm run deploy:verify --network=<hardhat-network>
```

Pool specs intentionally have no silent defaults: every parameter of a
`PoolSpec` must be an explicitly reviewed snapshot. `aWad` /
`lambdaWad` are the two independent concentration knobs (see
`Constants.A_MIN_WAD..A_MAX_WAD` = `[1e17, 99e16]` and
`Constants.LAMBDA_MIN_WAD..LAMBDA_MAX_WAD` = `[1e15, 1e18]`); the
current research presets live in
`simulator/src/app/config.rs::build_default_config`. The factory
accepts `(tokenA, tokenB)` in any order and canonicalises them to
`(token0, token1) = (min, max)` by address internally — seed amounts
are re-paired with the sorted slots automatically.

For a local end-to-end rehearsal: `npx hardhat node`, then run steps 1
and 2 with `--network localhost` (the bundled `localhost` config uses
MockWETH9 and a mock-token smoke pool).

---

## Documentation

- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) — extended
  architecture notes, math derivations, parameter tables, and
  contributor checklists.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — production runbook:
  auto-repeg monitoring, alert thresholds, the permissionless
  kickstart procedure, LP guarantees, and deploy-time calibration
  rules.
- [`simulator/README.md`](simulator/README.md) — Rust simulator
  internals, AMM-model description, configuration keys.
- static landing page mirrored at `http://localhost:3100/info` once
  the dashboard is running.
