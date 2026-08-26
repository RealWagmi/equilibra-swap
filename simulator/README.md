# Rust Benchmark Simulator

`simulator/` now contains a standalone Rust benchmark stack:

- simulation engine (`equilibra-offchain-simulator`);
- shard merge tool (`equilibra-offchain-merge`);
- compact report generator (`equilibra-offchain-report`);
- dashboard web server/API (`equilibra-offchain-app`);
- web assets (`app-web/`, `visualizer/`, `report-web/`).

The AMM runtime math (Equilibra, Curve, Uniswap V2) is executed in Rust only.

## Data Source

The app uses oracle JSON files from:

1. `BENCHMARK_ORACLE_DATA_DIR` (if set);
2. `simulator/data` (default and recommended for standalone usage).

Required files:

- `eth-usd.json`
- `btc-usd.json`

## Run Dashboard (Rust Server)

From `simulator/`:

```bash
cargo run --bin equilibra-offchain-app
```

Optional server environment variables:

- `BENCHMARK_APP_HOST` (default `127.0.0.1`)
- `BENCHMARK_APP_PORT` (default `3100`)
- `BENCHMARK_APP_PORT_TRIES` (default `20`)
- `BENCHMARK_MAX_CONCURRENT_RUNS` (default `1`)

## Run Simulator Binary Directly

```bash
cargo run --bin equilibra-offchain-simulator -- \
  --config runs/<runId>/params.json \
  --output runs/<runId>/sim_results.json \
  --data-dir simulator/data
```

Useful runtime flags:

- `--only-amms equilibra|uniswapV2|curve`
- `--only-bases WETH|WBTC`
- `--trace-disable-recenter`

## Output

Each run is stored under `runs/run_<...>/` and includes:

- `params.json` (run config);
- `status.json` (run manifest/state);
- `report/web/data/*.json` (compact dashboard payloads).

When a run is completed, raw heavy artifacts are pruned and compact report files are kept for dashboard usage.

## AMM Model

The Equilibra math kernel in `src/runtime_quoter/equilibra_math.rs`
is a bit-for-bit Rust port of
`contracts/libraries/EquilibraSwapMath.sol` and
`contracts/EquilibraPool.sol`. It implements a single-knob blend
between a flat plateau centre and a constant-product tail:

```
K(x, y; L) = (1 − w(D)) · α · L · (x + y) + w(D) · x · y
w(D)       = D / (α + D)
D          = (y − x)² / (x · y)
```

where:

- `x`, `y` are value-normalised reserves (WAD) with respect to the
  current anchor (`x` in token1 units, `y = r0 · WAD / anchor`);
- `D = (y − x)² / (x · y)` is the symmetric state distance — single
  division so rounding stays well-behaved near `x ≈ y`;
- `w(D)` is the blend weight, smoothly transitioning from `0` at the
  anchor to `1` at deep imbalance;
- `α` (WAD, range `[3, 200]`) is the single concentration knob.
  Larger `α` deepens the central plateau (linear-head multiplier)
  and widens the cross-over toward the constant-product tail
  (`w = 0.5` at `D = α`); smaller `α` brings the constant-product
  tail closer to the anchor.

The depth scale `L` is recovered analytically from the pre-state
via a closed-form quadratic (`solveLFromState`) and frozen for the
whole swap leg. Per-leg swaps are settled by a short secant
iteration against `K = const` that converges in a handful of steps
from a constant-product seed. Fees are inlined into reserves, with
a separate protocol-fee bucket per token. Auto-repeg
(`moveAnchor`) is gated on the cumulative LP-value growth
(`_lpValueGrowthWad`) so a fixed share of fees stays committed to
LPs even on aggressive multi-cycle paths.

### Configuration Keys

Equilibra preset parameters live in
`RunConfig.amms.equilibra.presets`:

- `aWad` (string, WAD — depth-at-anchor knob)
- `lambdaWad` (string, WAD — plateau-width knob)
- `feeBps` (number, BPS — base / ceiling fee)
- `feeRampBps` (number, BPS of WAD — dynamic ramp width)
- `feeFloorBps` (number, BPS — dynamic ramp floor)
- `repegShareBps` (number, BPS — LP / repeg split)
- `emaPeriod` (number, seconds)
- `repegStepWad` (string, WAD — max per-repeg anchor step)
- `repegThresholdToken1UpWad` (string, WAD — activation dead-band while the EMA sits above `priceScale`)
- `repegThresholdToken1DownWad` (string, WAD — dead-band for the opposite side)
- `baseTokenPosition` (string, `"token0"` / `"token1"` — slot of the base token)
- `protocolFeePercent` (number)
- `rebalanceEnabled` (bool)

All fields are strictly required; the parser rejects partial JSON.
The canonical WETH and WBTC presets are defined in
`simulator/src/app/config.rs::build_default_config` and the
TypeScript counterpart `test_helpers/config.ts::EquilibraPoolParams`
sources them from this Rust config at test time via the
`equilibra-offchain-config-defaults` binary.

