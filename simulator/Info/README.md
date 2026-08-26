# EquilibraSwap Business Art (HTML)

A static, dependency-free landing page that explains EquilibraSwap to
a non-technical audience and lists every pool-setup parameter the
simulator exposes.

## Files

- `index.html` — single-page presentation: positioning, plain-English
  explanation of price formation, auto-repeg, dynamic fee, and a full
  parameter (SETUP) table. Includes an interactive section with a live
  chart driven by the single `α` slider.
- `styles.css` — visual theme.
- `app.js` — vanilla JS canvas chart (no external dependencies):
  - **Liquidity density around the anchor (live repeg):** a bell
    curve in price space whose peak sits on the current anchor.
    The X-axis is the market price relative to the _original_
    anchor on a log scale (`0.25× ... 4×`); the Y-axis is the
    local liquidity density (depth per unit price change), derived
    from the production kernel's `marginalPrice(x, y, α)` formula
    along the trajectory `x + y = 2` via a symmetric finite
    difference: `1 / |dpMarg/dd|`. The chart is bit-for-bit
    qualitatively identical to the on-chain math (modulo float
    quantisation in JavaScript).
  - Three vertical markers — anchor (gold), EMA (orange dashed),
    market (green) — show the repeg dynamics: market moves freely
    via the slider, EMA chases at ~60 % of the way, anchor creeps
    at ~30 %. The whole bell shifts horizontally as the anchor
    moves.
  - Y-axis is fixed (0 – 25), so changing `α` visibly deepens or
    flattens the central plateau instead of being auto-scaled
    away.
  - WETH / WBTC presets mirror the simulator's production
    configuration; "Stable-like" and "Volatile-like" presets show
    edge-of-range behaviour.
- `brand.png` — sidebar logo.

## Open

From repository root:

```bash
xdg-open simulator/Info/index.html
```

## What the page covers

- Positioning of Equilibra against classical CFMMs.
- The model in one sentence (anchor + single-knob adaptive curve).
- How a single swap is priced (the invariant, the slope-as-price).
- Auto-repeg: geometric EMA tracking, log-domain anchor advance per
  block (with the halving ladder), direction-split dead-bands,
  LP / repeg share split.
- Dynamic fee: floor near anchor, smooth ramp to base fee.
- **Pool Setup**: every configurable parameter (`aWad`, `lambdaWad`,
  `baseFee`, `feeFloorBps`, `feeRampBps`, `protocolFeePercent`,
  `emaPeriod`, `repegStepWad`, `repegThresholdToken1UpWad`,
  `repegThresholdToken1DownWad`, `repegShareBps`) with on-chain limits
  and tuning intuition.
- Symmetric disclaimer covering the multi-AMM benchmark: simulator
  output for every AMM is a directional estimate replayed on
  historical data, not a forecast of production behaviour.
- Short FAQ.

## Notes

- All numerical limits in the SETUP section mirror
  `contracts/libraries/Constants.sol` and the Rust simulator
  (`simulator/src/app/config.rs`). When a constant changes on chain,
  update both places at once.
- The current Equilibra invariant is the two-knob cubic
  `K(x, y; L) = A · L · (x + y) / 2 + (W − A) · x · y` with
  `A = a · W / (W + λ · D)` and `D = (y − x)² / (x · y)`, `W = 1e18`.
  The depth scale `L` is recovered analytically from the pre-state via
  a closed-form quadratic and frozen for the swap leg. The on-page
  chart fetches its series from `/api/visualizer/series` (the
  bit-exact Rust `LocalQuoter` backend) — no invariant math runs in
  JavaScript, so the bell shape reflects the exact production kernel.
- Final execution semantics remain defined by Solidity contracts.
  The Rust simulator is held bit-exact via `test/simparity/`.
