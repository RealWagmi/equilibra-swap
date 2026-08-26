// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Constants
/// @notice Shared protocol constants used across Equilibra contracts.
library Constants {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @dev `WAD * WAD * 2^96` precomputed at compile time so the V3
    ///      sqrtPriceX96 ↔ math-space marginal-price conversion can
    ///      assemble `pMargWad = num / priceQ96` with a single `DIV`
    ///      opcode instead of a triple-cascaded `fullMulDiv`. Magnitude
    ///      `≈ 7.92 · 10⁶⁴` comfortably fits in `uint256`
    ///      (`< 2^215 ≪ 2^256`).
    uint256 internal constant WAD_SQ_X96 = WAD * WAD * (1 << 96);

    // Factory and pool parameter bounds.
    // The fee ceiling floor keeps every pool's flat/ceiling rate
    // economically meaningful — sub-5-bps ceilings leave the dynamic
    // ramp and the repeg budget no room to work with.
    uint16 internal constant MIN_BASE_FEE = 5; // 0.05%
    uint16 internal constant MAX_BASE_FEE = 2_000; // 20%
    // Upper bound on the protocol's share of each swap fee. Unit is
    // **percent of fee** (not BPS of swap amount) — `25 = 25%`. The
    // bound is intentionally conservative: with the
    // `repegShareBps + protocolFeePercent × 100 ≤ BPS` invariant
    // enforced by the factory, the remaining BPS budget is what LPs
    // actually keep after repegs. Capping protocol at 25% leaves
    // ≥ 75 % of fee value available for the LP/repeg split, regardless
    // of the operator's split preference.
    uint8 internal constant MAX_PROTOCOL_FEE = 25; // 25% of swap fee
    // EMA period bounds, seconds. The factory bounds the user-facing
    // half-life input from below with MIN and the stored internal
    // relaxation time tau = ceil(halfLife * 1000 / 694) from above with
    // MAX, so the largest accepted half-life is 419731 s (~4.86 days).
    uint32 internal constant MIN_EMA_PERIOD = 60; // seconds
    uint32 internal constant MAX_EMA_PERIOD = 7 days;

    // ============ Dynamic Fee (smoothstep ramp) ============
    // Upper bound for the configurable warm-up width (`feeRampBps`). The
    // value is interpreted as a fraction of WAD (10000 bps = 1.0 WAD = full
    // state-distance unit). Above this width the smoothstep is effectively
    // flat across the entire admissible swap range.
    uint16 internal constant MAX_FEE_RAMP_BPS = 10_000; // 100%

    // Monotonicity guard for a live ramp: `feeRampBps · (BPS − baseFee)²
    // ≥ FEE_RAMP_GUARD_MULT · BPS · (baseFee − feeFloorBps)²`. The fee
    // is a terminal rate charged on the whole notional, so on a ramp too
    // narrow for its fee span the rate can climb faster than the input
    // grows — `d(g·f(g))/dg > 1` — and a larger exact-in gross would
    // buy LESS output over whole intervals. The monotone condition is
    // `g·f' ≤ 1 − f`, so the available headroom shrinks with the fee
    // level itself — hence the `(BPS − baseFee)²` factor (a span-only
    // bound admits non-monotone configs once the ceiling nears
    // MAX_BASE_FEE). The tight multiplier of the squared envelope is
    // 256/27 ≈ 9.5; 12 leaves a uniform ~11% margin above it.
    uint256 internal constant FEE_RAMP_GUARD_MULT = 12;

    // ============ Repeg Profit Share (LP value growth split) ============
    // `repegShareBps` controls the fraction of cumulative LP unit-value
    // growth (`_lpValueGrowthWad`) that the auto-repeg gate is allowed
    // to spend on anchor moves. The remainder `BPS - repegShareBps`
    // stays committed to LPs as the gate threshold:
    //
    //   threshold = lpUnitValueGenesisWad
    //             + lpValueGrowthWad · (BPS - repegShareBps) / BPS
    //
    // Boundary semantics:
    //   * `0`     — every accrued unit of growth must remain with LPs;
    //               threshold == lpUnitValueGenesisWad + growth, so the
    //               gate effectively never opens (auto-repeg disabled).
    //   * `5000`  — 50/50 split between LPs and the repeg gate.
    //               Conservative reference default.
    //   * `10000` — every accrued unit of growth may be spent on
    //               repegs; threshold == lpUnitValueGenesisWad, the
    //               gate opens as soon as `vpBefore > vpGenesis`.
    //
    // **Cross-parameter constraint** (enforced by the factory):
    //   `repegShareBps + protocolFeePercent × 100 ≤ BPS`
    // — the share reserved for repegs plus the protocol slice of every
    // fee must leave a non-negative residual for LPs. Without this
    // invariant `_tryAutoRepeg`'s denominator (`BPS − protocolFeePercent
    // × 100`) collapses to zero or negative.
    uint16 internal constant MAX_REPEG_SHARE_BPS = 10_000; // == BPS
    uint16 internal constant DEFAULT_REPEG_SHARE_BPS = 5_000; // 50/50 split

    // ============ Repeg Gas Guard ============
    // Minimum LP unit-value headroom above the gate threshold before
    // `_tryAutoRepeg` may commit, in absolute vp units (WAD scale).
    // Acts as a flat anti-noise / gas-amortisation floor that prevents
    // the pool from spending fees on micro-repegs whose IL cost
    // outweighs the LP gain.
    //
    //   gate1: vpBefore > threshold + REPEG_GAS_GUARD_WAD
    //
    // Accepted pools enforce
    //   |vpGenesis - 2·WAD| <= MAX_GENESIS_VP_ERROR_WAD
    // because the √(priceScale·WAD) normaliser cancels pair scale
    // against the geometric-mean supply in exact arithmetic. Therefore
    // an absolute threshold of 4e10 is approximately 20 ppb of every
    // accepted genesis unit value — intentionally well below a basis
    // point, so noise on the EMA cannot push through the gate on its own.
    //
    // VALIDITY PRECONDITION: genesis precision remains inside that band;
    // any change to the normaliser, supply seeding or tolerance must
    // re-derive this constant. The live/base value is never below the
    // accepted genesis floor (`2·WAD - MAX_GENESIS_VP_ERROR_WAD`), so
    // the absolute guard remains approximately a 2e-8 relative floor.
    uint256 internal constant REPEG_GAS_GUARD_WAD = 4e10;

    // =========================================================================
    // Two-knob concentration parameters (a, λ) — single-piece cubic kernel
    // =========================================================================
    //
    //     K(x, y; L) = A · L · (x + y) / 2  +  (W − A) · x · y,
    //              A = a · W / (W + λ · D),
    //              D = (y − x)² / (xy),
    //              W = WAD.
    //
    // Two independent knobs:
    //
    //   `a` — **depth at anchor.** At the anchor (D = 0) `A = a`, so `a`
    //         directly scales the linear-head contribution at the
    //         centre. Larger `a` → flatter plateau, deeper liquidity at
    //         the anchor.
    //
    //   `λ` — **plateau width.** At `λ·D = W` the amplification halves
    //         (`A = a/2`). Larger `λ` → narrower plateau, faster
    //         transition to the CP tail. Smaller `λ` → wider plateau.
    //
    // Decoupling: changing `a` alone moves depth at anchor without
    // shifting the cliff position; changing `λ` alone moves the cliff
    // position without affecting depth at anchor. The two knobs are
    // mathematically orthogonal.
    //
    // **Why `a ≤ 9e17`, not `≤ WAD`:** at `a == WAD` the curve degenerates
    // into pure constant-sum at anchor (`A = W`, tail term `(W − A)·N = 0`),
    // which makes the marginal-price derivative chain numerically
    // singular and the L-quadratic ill-conditioned (the `(W − A)` factor
    // in the denominator of the closed-form L-recovery vanishes). The
    // 0.99 ceiling keeps a healthy 1e16 (1% WAD) of CP-tail mixing
    // available everywhere, which is enough to keep all secant /
    // sqrt paths well-conditioned. Pegged-pair extremes pick `a` near
    // this ceiling; volatile pairs pick `a` near the floor. The
    // calibrated WETH / WBTC presets in `simulator/src/app/config.rs`
    // sit at `a ∈ {0.843, 0.949}` — well inside the 0.99 ceiling.
    uint256 internal constant A_MIN_WAD = 1e17; // 0.1 · WAD  (CP-leaning floor)
    uint256 internal constant A_MAX_WAD = 99e16; // 0.99 · WAD (constant-sum ceiling)

    // λ envelope. The amplification halves (`A = a/2`) at `λ · D = W`,
    // i.e. at math-space distance `D = W/λ`. The admissible band
    // `[1e15, 1e18]` covers half-A distances `D ∈ [W, 1000·W]`, which
    // exhausts the practically useful plateau widths:
    //
    //     * `λ ≈ 1e15..1e16` — wide plateau, soft cliff (volatile pairs)
    //     * `λ ≈ 1e16..1e17` — moderately concentrated (default band)
    //     * `λ ≈ 1e17..1e18` — narrow plateau, harder transition (peg-ish pools)
    uint256 internal constant LAMBDA_MIN_WAD = 1e15; // wide plateau
    uint256 internal constant LAMBDA_MAX_WAD = 1e18; // narrow plateau

    // Repeg bounds and defaults.
    uint256 internal constant MIN_REPEG_STEP = 1; // 1 wei (≈0%)
    uint256 internal constant MAX_REPEG_STEP = WAD; // 100%
    uint256 internal constant DEFAULT_REPEG_STEP_WAD = 1e15; // 0.1% per update

    // ============ Repeg Step Damping ============
    // Anchor moves on auto-repeg are capped at a fraction of the remaining
    // `|ema/priceScale − 1|` deviation per call, on top of the configured
    // `repegStepWad` ceiling. The damping divisor controls smoothness of
    // the asymptotic approach: a divisor of 5 means each call eats at most
    // one fifth of the gap, yielding an under-damped catch-up curve that
    // converges quickly without overshooting the EMA target.
    //
    //   appliedStepWad = min(repegStepWad, deviationWad / REPEG_DAMPING_DIVISOR)
    //   priceScaleNew  = mulWad(priceScale, expWad(±appliedStepWad))
    uint256 internal constant REPEG_DAMPING_DIVISOR = 5;

    // Halving ladder of the auto-repeg step: when the post-move solvency
    // probe (`vpAfter < threshold`) refuses the candidate, `_tryAutoRepeg`
    // retries with the applied step halved — effective divisor ladder
    // `D, 2D, 4D, 8D` — then skips. No cross-block memory: every attempt
    // starts fresh from `deviation / REPEG_DAMPING_DIVISOR`. Turns the
    // binary "unaffordable ⇒ freeze" into "move as much as the budget
    // allows", breaking the self-reinforcing stall spiral (frozen anchor →
    // concentration off-market → fees die → budget never refills). The
    // rungs are deliberately COARSE: committing ~50–100% of the affordable
    // step leaves a budget cushion; a finer ladder scrapes the budget to
    // the floor and measurably increases stall months.
    uint256 internal constant MAX_REPEG_STEP_HALVINGS = 3;

    // Dust floor (raw LP shares) for the donation parachute: pool-held
    // LP balances at or below this are treated as an empty donation
    // buffer, so a wei-scale LP transfer to the pool address cannot
    // wake the parachute's probe work on budgetless pools.
    // 1e12 raw shares = 1e-6 of one WAD LP unit — economically nil.
    uint256 internal constant REPEG_DONATION_DUST_SHARES = 1e12;

    // Donation-parachute activation multiplier K — the DEFAULT every
    // pool is initialized with. K is deliberately NOT a creation
    // parameter: pools start here and the per-pool stored value
    // (`_parachuteBandMult`, uint8) stays adjustable through the param
    // timelock within `[1, 255]` (zero is forbidden — it would erase
    // the lag qualifier and turn the parachute into a continuous
    // top-up). The parachute burns donated shares only when the
    // geometric EMA/priceScale deviation reaches `K × the active
    // direction's dead-band` AND no ladder rung committed. Scaling by
    // the dead-band self-calibrates per pool class: the bundled
    // WETH/WBTC presets (bands 2.5e15 / 1.5e15) open at 7.5%
    // (token1-up) / 4.5% (token1-down) anchor lag, while a pegged pool
    // with 1e14 bands opens at 0.3% — already a crisis for a peg.
    // Ordinary regimes never touch donated funds: small deviations are
    // served by the LP-budget ladder alone, so the buffer survives
    // until a genuine stall.
    uint256 internal constant REPEG_PARACHUTE_BAND_MULT = 30;

    // Dead-shares burn floor (WAD-scaled geometric mean of the seeded
    // reserves). Raised from the historical 1_000 to 1e6 as a conservative
    // first-depositor hardening policy. Security of the genesis VP does
    // NOT rely on this value: it is an LP-supply floor, not a math-kernel
    // precision guarantee. Under
    // the asymmetric coordinate change the genesis `nWad = xWad²/WAD`
    // depends on the base-side `xWad`, not on this geometric mean, so a
    // geomean floor cannot bound kernel precision. Genesis precision is
    // enforced separately and authoritatively by the `2·WAD` check below.
    uint256 internal constant MIN_INITIAL_LIQUIDITY = 1_000_000;

    // Maximum tolerated deviation of the genesis LP unit value from its
    // exact identity `2·WAD`. In exact arithmetic every non-degenerate
    // genesis state yields `vp = 2·WAD` (the √(priceScale·WAD) normaliser
    // cancels pair scale against the geometric-mean supply); only integer
    // rounding perturbs it. A genesis seed too small for the kernel to
    // resolve (e.g. `nWad` flooring toward zero) instead stores a
    // materially understated — or zero — value, which would leave the
    // auto-repeg gate protecting far less than the true LP principal.
    // The pool rejects any state outside the policy band, including both
    // under-resolved depth and an extreme reserve ratio whose WAD
    // `priceScale` cannot represent the intended anchor accurately enough.
    // Proportional seed growth fixes the former but not necessarily the
    // latter, so callers must inspect {GenesisVpImprecise}. The tolerance
    // aliases the repeg guard deliberately: accepted genesis rounding can
    // never manufacture more than one guard of unbooked headroom.
    uint256 internal constant MAX_GENESIS_VP_ERROR_WAD = REPEG_GAS_GUARD_WAD;

    uint8 internal constant MAX_TOKEN_DECIMALS = 18;

    // ============ EMA Oracle Protection ============
    // Two-layer flash-loan / multi-block manipulation defense for the EMA
    // oracle that feeds `_tryAutoRepeg`:
    //
    // 1) Symmetric spot cap: spot is clamped to
    //    `[priceScale / EMA_PRICE_CAP_DIV, priceScale * EMA_PRICE_CAP_MUL]`
    //    before being mixed into the EMA. This bounds how far a single
    //    trade can drag the oracle in either direction.
    //
    // 2) Repeg cadence gate (enforced in `_tryAutoRepeg` via the
    //    `_lastRepegTs` timestamp): at most one commit per block AND
    //    never more than one per second — sub-second blocks share a
    //    timestamp, so the second binds there, the block everywhere
    //    else. Plus the geometric activation dead-bands
    //    `|max(ema,priceScale)/min(ema,priceScale) − 1| >=
    //    repegThresholdToken1{Up,Down}Wad`, so the priceScale cannot be
    //    marched faster than one `repegStepWad` per block (and never
    //    faster than one per second).
    uint256 internal constant EMA_PRICE_CAP_MUL = 2; // priceScale * 2 upper bound
    uint256 internal constant EMA_PRICE_CAP_DIV = 2; // priceScale / 2 lower bound

    // ============ External integration (Q64.96 projection) ============
    // Canonical Uniswap-V3 sqrt-ratio domain. The oracle view's
    // `sqrtPriceX96` projection is clamped into
    // `[MIN_SQRT_RATIO, MAX_SQRT_RATIO − 1]` so TickMath-style
    // consumers never receive an out-of-range value (which would make
    // `getTickAtSqrtRatio` revert); saturation at either bound signals
    // an extreme/degenerate state (audit L-11).
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;
}
