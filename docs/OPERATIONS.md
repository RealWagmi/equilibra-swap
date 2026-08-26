# Pool operations runbook — auto-repeg monitoring & recovery

Operational guide for running EquilibraSwap pools in production. Covers
the one systemic risk of anchor-following designs: the auto-repeg can
enter a prolonged **budget stall** (the anchor stops moving while the
market trends away). This document explains how to detect it, when to
act, and how to recover — using only public pool views and the router.

All quantitative figures below were measured with exact-integer probes
of the production kernel (the bit-exact Rust mirror under
`simulator/src/runtime_quoter/`) on a legacy WETH-like reference preset
(`a = 0.843`, `λ = 0.0323`, base fee 220 bps, floor 60 bps, ramp
1000 bps, `repegStepWad = 5e15`, `repegShareBps = 5000`), evaluated at
the worst-case state (deviation saturated at the EMA clamp, zero growth
cushion). This is a REFERENCE MEASUREMENT preset for the tables below,
not the shipped default — the current research presets live in
`simulator/src/app/config.rs::build_default_config` (WETH `a≈0.9096`,
`λ≈0.0168`, base 282 / floor 136 bps, ramp 5000, share 7000). Sharper or
shallower curves shift the numbers by tens of percent, not orders of
magnitude — re-derive with the simulator when operating a materially
different preset.

---

## 1. Background: what a "stall" is and is not

The repeg pipeline (`EquilibraPool._tryAutoRepeg`) only commits a
`priceScale` move when the pool has **earned** it: cumulative
LP-unit-value growth (fee income) must cover the move's IL cost, with
`repegShareBps` capping the spendable share. Three consequences:

- **Pool price never stalls.** Arbitrage plus the fee band keep the
  pool's *tradable* price within roughly `fee + arb-threshold` of the
  market at all times, regardless of the anchor. The curve is monotone
  and quotes at every price; there is no untradable state.
- **Anchor lag is designed behaviour, not a fault.** On a sustained
  one-directional trend the anchor cannot keep up under *any*
  parameterization — tracking a fast trend costs more IL per day than
  any realistic fee yield. The gate correctly refuses to spend value
  the pool has not earned. The cost of a lagging anchor is reduced
  concentration efficiency (extra IL versus a constant-product
  baseline, bounded and measured — see §6), not mispricing.
- **A permanent brick is not reachable** while swaps are enabled and
  `repegShareBps > 0`: the growth accumulator increases with *any*
  fee-paying volume and is never decremented, while the cost of one
  step is bounded above. For every reachable state there is a finite
  future volume that re-opens the gate. Recovery is therefore always a
  question of *volume and time*, never of possibility.

The one configuration class that can never self-recover — an
activation dead-band (`repegThresholdToken1UpWad` /
`repegThresholdToken1DownWad`) above the fee scale — is rejected by the
factory at deploy time and by the timelock at every runtime change
(`RepegThresholdExceedsFeeScale`, skipped when auto-repeg is disabled);
the remaining calibration guidance lives in §7.

## 2. Signals to monitor

Everything needed is already exposed; no contract changes required.

| Signal | Source | Meaning |
| --- | --- | --- |
| `devGeo = max(ema, ps) / min(ema, ps) − 1` | `getOracleState()` | anchor-vs-EMA deviation (WAD). **Saturates at 1.0** because EMA spot input is clamped to `[ps/2, 2·ps]` — pair with an external price feed to know the true market gap. |
| `repegThresholdToken1UpWad`, `repegThresholdToken1DownWad`, `repegStepWad`, `repegShareBps`, `protocolFeePercent` | `getFeeConfig()` | direction-split activation dead-bands, per-repeg movement cap, and user-facing spendable share |
| `spendable = unitValueWad − genesisWad − growthWad·(BPS − shareStored)/BPS − 4e10` | `getLpValueState()` + reconstructed `shareStored` | pre-repeg headroom after the absolute `REPEG_GAS_GUARD_WAD`. Reconstruct `shareStored = floor(repegShareBps·BPS/(BPS − protocolFeePercent·100))`; the view deliberately returns the user-facing share, not the stored grossed-up value. Clamp a negative result to zero. |
| `PriceScaleUpdated` | pool event | the repeg heartbeat. Absence while `devGeo ≥ activeThreshold` (the `Up` band while `ema > ps`, else the `Down` band) **and** `Swap` events keep flowing is the stall signature. |
| `LpValueGrowthAccrued` | pool event | budget inflow rate |

**One-step cost probe** (the decisive check): compute the candidate
`ps′ = ps · exp(±(min(step, devGeo/5) >> k))` for each ladder rung
`k = 0..3` and evaluate `vpAfter` at unchanged reserves;
`cost(k) = unitValueWad − vpAfter`. Run it off-chain with the bit-exact
Rust quoter, or on a fork via
`MockEquilibraPool.exposed_computeLpUnitValueWadAtPriceScale`. A stall
is confirmed when `spendable < cost(3)` — the SMALLEST rung —
persistently (the halving ladder means the pool commits partial rungs
long before the full step becomes affordable).

## 3. Alert thresholds

Thresholds derive from the pool's own parameters, not absolute numbers:

- **WARN** — `devGeo ≥ activeThreshold` for longer than `emaPeriod`, with
  swaps observed in the window and zero `PriceScaleUpdated`.
- **CRIT** — `devGeo ≥ 2 · activeThreshold` **and** the cost probe shows
  `spendable / cost(3) < 1` with no upward trend over one hour.

## 4. Decision tree

1. **`spendable/cost` rising with volume → wait.** Any fee-paying flow
   refills the budget. Measured: ordinary mean-reverting markets with
   ~1% noise fully heal even a 2× anchor gap in roughly a day of
   organic arbitrage, with zero subsidy — a lagging pool still quotes
   at every price, so arbitrage keeps routing through it.
2. **Ratio flat; market trading inside the fee band → kickstart** (§5).
3. **Pause only for suspected manipulation or a math bug.** Pausing
   blocks `swap` — i.e. it cuts off the *only* budget source and
   freezes the EMA. It is never a stall-recovery tool; its sole
   stall-adjacent use is freezing adversarial oracle input. Note the
   unpause quirk: after a pause much longer than `emaPeriod`, the first
   swap snaps the EMA to the clamped spot in one update (decay factor
   ≈ 0). This is safe — the dead-bands and value gates still govern the
   anchor — but deviation readings will jump.

## 5. Permissionless kickstart

A stalled pool lacks budget, not mechanism. Anyone can fund the budget
by trading through the router — two `exactInputSingle` calls
(round-trip). Each leg pays the swap fee; the LP share of the fee lands
in reserves, raising the LP unit value and hence the growth budget.

Measured costs (the legacy reference preset from the introduction, worst case — deviation saturated,
zero cushion; every leg pays the fee ceiling because the state distance
is far beyond the ramp):

| Quantity | Value |
| --- | --- |
| IL cost of one `0.5%` repeg step | ≈ 0.10% of LP unit value |
| growth needed at `share = 5000` | ≈ 0.20% of LP unit value |
| round-trip size that funds one step | **≈ 5% of TVL per leg** (smaller legs fail the post-value gate) |
| kickstarter's fee outlay per step | ≈ 0.22% of TVL |
| full catch-up from a 2× gap | ~142 commits ≥ 142 blocks and ≥ 142 seconds (cadence gate), ~10× TVL notional, ~22% of TVL in fees |

Practical notes:

- The fee outlay is a **transfer to the pool, not a burn**: LPs
  permanently keep `1 − share` of it as cushion; a treasury that is
  itself the majority LP recovers most of the cost.
- **Hybrid strategy is the correct play**: fund the first step(s) —
  each commit shrinks the gap and cheapens the next — then let organic
  arbitrage flow carry the rest.
- Committed steps move the pool's raw spot by well under the fee band
  (~0.09% per 0.5% step at saturation), so catch-up does not leak value
  to arbitrageurs.
- Procedure: cost probe → one 5%-of-TVL leg → reverse leg → wait for
  `PriceScaleUpdated` → next block → repeat until `devGeo < 2 ·
  activeThreshold` or organic flow takes over.

## 6. LP guarantees (what to tell liquidity providers)

- `removeLiquidity` is callable in **every** pool state, including
  while paused and regardless of repeg health — funds are never locked.
- The post-repeg gate enforces `vpAfter ≥ vpGenesis` at every commit:
  repegs can never push the LP unit value below its genesis baseline.
- Honest worst case of a stalled anchor: opportunity cost plus
  concentrated impermanent loss — measured at ~2.5× the
  constant-product IL for a 2× market move (concentration dissolves
  only asymptotically away from the anchor). Bounded, and exit is
  always available.

## 7. Calibration rules (deploy-time prevention)

The curve knobs (`aWad`, `lambdaWad`), `emaPeriod` and
`protocolFeePercent` are IMMUTABLE — get them right before
`createPool`. The dynamic-fee triple (`baseFee`, `feeRampBps`,
`feeFloorBps`), `repegStepWad`, the dead-band pair
(`queueRepegThresholds(up, down)`) and `repegShareBps` are adjustable
after deploy through `EquilibraParamTimelock` under a 24-hour delay
(10 minutes for private pools)
(see the CLAUDE.md "Runtime-adjustable parameters" section). The stall
guard below is re-validated by the timelock on every fee change AND on
every threshold change:

1. **Upper bound (stall guard) — factory-enforced.** When
   `repegShareBps != 0` the factory reverts deployment
   (`RepegThresholdExceedsFeeScale`) unless each dead-band satisfies
   `threshold ≤ feeScale · 1e14`
   (feeScale = `feeFloorBps` with a live ramp, flat `baseFee`
   otherwise). Corollary: `feeFloorBps = 0` with a live ramp is
   undeployable while auto-repeg is enabled — raise the floor to
   ≥ 1 bps or set `repegShareBps = 0`. For flat-fee pools prefer extra
   voluntary margin (each band `≤ 0.7 · baseFee · 1e14`): the
   binding deviation sits at ~5–20× the step, where the damping cap
   stops shrinking the move while the budget is still linear, and there
   is no ramp revenue to close the gap.
2. **Lower bound (bandwidth).** The anchor's maximum slew rate is
   `repegStepWad × commits per day`. A quantum far below
   `expected daily |move| / swaps per day` leaves the pool permanently
   bandwidth-limited: it can never track a fast repricing regardless of
   budget and relies on market mean reversion instead. This is a
   conscious trade-off (tight quanta suit pegged pairs), not a defect —
   size it deliberately.
3. `repegShareBps = 5000` is a conservative 50/50 starting point: half
   of every earned unit of growth stays with LPs as a permanent cushion.
   The current WETH/WBTC research presets use `7000`; that choice spends
   more earned growth on repegs and must be validated against the intended
   volume and trend regime.
   `10000` ("track-the-market") measurably does **not** improve
   tracking on sustained trends and costs LPs ~1% — prefer the default.
