// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { Constants } from "./Constants.sol";
import { Errors } from "./Errors.sol";

/// @title PoolOracle
/// @notice Helpers for EMA update and bounded price-scale shifts.
///
/// Primitives:
///   * `updateEma` — continuous-time GEOMETRIC (log-domain) EMA with
///     symmetric spot cap; reciprocal-invariant, so oracle behaviour
///     does not depend on token order (no Jensen-gap tilt).
///   * `appliedRepegStep` + `applyLogStep` — bounded, damped LOG-DOMAIN
///     anchor move toward a target, clamped to the remaining gap: a
///     single call never overshoots the target, unconditionally.
///     `shiftPriceScale` composes the two for single-shot callers.
library PoolOracle {
    struct EmaState {
        uint256 emaPriceWad;
        uint64 lastUpdateTs;
    }

    /// @notice Update EMA using continuous-time GEOMETRIC (log-domain)
    ///         exponential smoothing with flash-loan / multi-block
    ///         manipulation protection.
    /// @dev Decay factor alpha = exp(-Δt / τ) (τ = smoothing period), then
    ///      `ema_new = ema_old · exp((1 − alpha) · ln(spot_capped / ema_old))`
    ///      — the same smoothing weight as an arithmetic mix, applied to
    ///      the LOGARITHM of the price.
    ///
    ///      Why geometric and not arithmetic (the Jensen gap): an
    ///      arithmetic price average is not reciprocal-invariant —
    ///      `EMA(p) · EMA(1/p) ≥ 1` strictly under volatility (Jensen's
    ///      inequality, gap ≈ σ²/2 of the smoothed window). The oracle
    ///      frame is `token0-per-token1`, fixed by the address sort at
    ///      deploy, so an arithmetic EMA would give the SAME pair a
    ///      volatility-dependent tilt whose sign depends on which token
    ///      sorts first: measured deviations read larger in one price
    ///      direction and smaller in the other, systematically skewing
    ///      when the auto-repeg dead-band wakes. The geometric mean is
    ///      exactly reciprocal-invariant — `EMA(1/p)` IS `1/EMA(p)` up
    ///      to integer rounding — so oracle behaviour does not depend on
    ///      token order or price direction.
    ///
    ///      Fixed-point op order (bit-for-bit with the Rust reference
    ///      `equilibra_math::geometric_ema_step`):
    ///        ratio  = divWad(spot_capped, ema_old)        (floor)
    ///        lnr    = lnWad(ratio)                        (signed)
    ///        scaled = (lnr · (WAD − alpha)) / WAD         (sdiv, trunc)
    ///        factor = expWad(scaled)
    ///        ema    = mulWad(ema_old, factor)             (floor)
    ///      `spot == ema` maps through `lnWad(WAD) == 0` and
    ///      `expWad(0) == WAD` to an EXACT fixed point.
    ///
    ///      Symmetric spot cap before blending: spot is clamped to
    ///        [priceScaleWad / EMA_PRICE_CAP_DIV,
    ///         priceScaleWad * EMA_PRICE_CAP_MUL]
    ///      so a single manipulated trade cannot drag the oracle past 2x
    ///      in either direction. Multi-block manipulation is bounded by
    ///      the auto-repeg pipeline itself: `_tryAutoRepeg` commits
    ///      at most once per block and never more than once per second
    ///      (timestamp gate) and is gated on the geometric deviation
    ///      `|max(ema, priceScale)/min(ema, priceScale) − 1| >=
    ///      repegThresholdToken1{Up,Down}Wad` (the direction-split
    ///      dead-bands), so the anchor walks at most one `repegStepWad`
    ///      per block — per second at the fastest — regardless of how
    ///      the EMA moves.
    ///
    ///      Three short-circuit branches, with distinct behaviour:
    ///        0. **Zero spot** (`spotPriceWad == 0`): no-op, the existing
    ///           `EmaState` is returned unchanged. `spotRaw =
    ///           mulWad(pMarg, priceScale)` floors to zero for an exotic
    ///           small-`priceScale` pool pushed to extreme depletion;
    ///           the EMA cannot track a sub-wei spot, so the update is
    ///           skipped rather than reverted. Reverting here would brick
    ///           every subsequent swap (the caller runs `updateEma` at
    ///           the top of `swap()`), so the skip is what keeps an
    ///           exotic pool live and matches the Rust quoter bit-for-bit
    ///           (`update_ema_in_place` returns early on a zero spot).
    ///        1. **Bootstrap** (`emaPriceWad == 0` or `lastUpdateTs == 0`):
    ///           seed `emaPriceWad := spotPriceWad` directly. The cap is
    ///           skipped because there is no "previous EMA" to anchor
    ///           against — applying it against a stale anchor would
    ///           freeze the oracle on the wrong side of the first real
    ///           trade.
    ///        2. **Same-block re-entry** (`nowTs <= lastUpdateTs`): no-op,
    ///           the existing `EmaState` is returned unchanged. Treating
    ///           this as a no-op rather than re-seeding prevents callers
    ///           from accidentally overwriting `emaPriceWad` with
    ///           `spotPriceWad` (which would silently bypass the cap)
    ///           when no time has elapsed.
    function updateEma(
        EmaState memory state,
        uint256 spotPriceWad,
        uint256 priceScaleWad,
        uint32 emaPeriod,
        uint64 nowTs
    ) internal pure returns (EmaState memory next) {
        // Sub-wei spot: skip the update (no-op) instead of reverting, so
        // an exotic pool that floors `spotRaw` to zero stays swappable.
        // Bit-for-bit with the Rust quoter (audit finding L-5).
        if (spotPriceWad == 0) return state;

        next = state;

        // Bootstrap: no prior EMA — seed with current spot. Skip the cap
        // because there is no priceScale history to compare against.
        if (state.emaPriceWad == 0 || state.lastUpdateTs == 0) {
            next.emaPriceWad = spotPriceWad;
            next.lastUpdateTs = nowTs;
            return next;
        }

        // Same-block / past-block re-entry: idempotent no-op. The pool's
        // `_updateEma` already guards this case, but treating the library
        // as a hardened primitive prevents callers from accidentally
        // overwriting `emaPriceWad` with `spotPriceWad` when no time has
        // elapsed (which would silently bypass the cap).
        if (nowTs <= state.lastUpdateTs) {
            return next;
        }

        uint256 elapsed = uint256(nowTs - state.lastUpdateTs);

        // alpha = exp(-elapsed * WAD / emaPeriod)
        // `emaPeriod` is range-validated at deploy by the factory.
        int256 exponent = -int256((elapsed * Constants.WAD) / uint256(emaPeriod));
        uint256 alpha = uint256(FixedPointMathLib.expWad(exponent));

        // Symmetric spot cap relative to priceScale. Skipped when
        // priceScale is zero (degenerate state) — fall back to raw spot
        // rather than reverting to keep the oracle live.
        uint256 cappedSpot = spotPriceWad;
        if (priceScaleWad != 0) {
            uint256 maxSpot = priceScaleWad * Constants.EMA_PRICE_CAP_MUL;
            uint256 minSpot = priceScaleWad / Constants.EMA_PRICE_CAP_DIV;
            if (cappedSpot > maxSpot) cappedSpot = maxSpot;
            else if (cappedSpot < minSpot) cappedSpot = minSpot;
        }

        // Geometric blend with the capped spot (op order pinned in the
        // NatSpec above). A zero ratio means the spot floors below one
        // wei of the EMA scale — outside the supported domain, fail
        // loud (the Rust reference errors identically).
        uint256 ratio = FixedPointMathLib.divWad(cappedSpot, state.emaPriceWad);
        if (ratio == 0) revert Errors.EmaRatioZero();
        int256 scaled = (FixedPointMathLib.lnWad(int256(ratio)) * int256(Constants.WAD - alpha)) /
            int256(Constants.WAD);
        next.emaPriceWad = FixedPointMathLib.mulWad(
            state.emaPriceWad,
            uint256(FixedPointMathLib.expWad(scaled))
        );
        next.lastUpdateTs = nowTs;
    }

    /// @notice Shift the pool's price scale toward `targetWad` by a
    ///         bounded, damped step.
    /// @dev Step semantics:
    ///        deviationWad   = |max(target, priceScale) /
    ///                          min(target, priceScale) − 1|             (WAD)
    ///        appliedStepWad = min(repegStepWad,
    ///                             deviationWad / REPEG_DAMPING_DIVISOR)
    ///        priceScaleNew  = mulWad(priceScale, expWad(±appliedStepWad))
    ///
    ///      The geometric (multiplicative) deviation makes a ±2× move
    ///      register `1.0` WAD in both directions, so the full
    ///      `[1, WAD]` range of the step cap and of both activation
    ///      dead-bands is usable symmetrically under the `[ps/2, 2ps]`
    ///      EMA clamp (audit L-6).
    ///
    ///      `repegStepWad` is the **maximum relative move per call**
    ///      (fraction of `priceScale`, in WAD). The damping cap pulls
    ///      `appliedStepWad` toward zero as `priceScale` approaches the
    ///      EMA. `applyLogStep` additionally clamps the landing to the
    ///      target, so a single call **never overshoots —
    ///      unconditionally**. (Under the divisor-5 damping the clamp is
    ///      belt-and-suspenders for this composed path: `dev/5 <
    ///      ln(1 + dev)` for every reachable deviation and the cap tops
    ///      out at one e-fold, so the exponential lands strictly short
    ///      of the target. The clamp makes the guarantee hold for raw
    ///      `appliedStepWad` magnitudes any library caller might pass.)
    ///
    ///      The deviation activation gate (`deviationWad ≥` the active
    ///      direction's `repegThresholdToken1{Up,Down}Wad`) is enforced
    ///      upstream by `_tryAutoRepeg`; this helper assumes the caller
    ///      already cleared it.
    function shiftPriceScale(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 repegStepWad
    ) internal pure returns (uint256 priceScaleNewWad, uint256 movedAbsWad) {
        if (priceScaleOldWad == 0 || targetWad == 0) revert Errors.InvalidPriceScale();
        if (repegStepWad == 0 || repegStepWad > Constants.WAD) revert Errors.InvalidRepegStep();

        if (targetWad == priceScaleOldWad) {
            return (priceScaleOldWad, 0);
        }

        // Geometric (multiplicative) deviation `|max/min − 1|` — bit-exact
        // with `_tryAutoRepeg`'s activation gate. A ±2× move yields `1.0`
        // WAD in both directions, matching the symmetric `[ps/2, 2ps]` EMA
        // clamp (audit L-6); the upward branch is identical to the old
        // linear `|target/priceScale − 1|`, only downward differs.
        uint256 deviationWad = targetWad >= priceScaleOldWad
            ? FixedPointMathLib.mulDiv(targetWad, Constants.WAD, priceScaleOldWad) - Constants.WAD
            : FixedPointMathLib.mulDiv(priceScaleOldWad, Constants.WAD, targetWad) - Constants.WAD;

        return shiftPriceScale(priceScaleOldWad, targetWad, repegStepWad, deviationWad);
    }

    /// @notice Deviation-supplied variant: skips the geometric-deviation
    ///         recompute when the caller (the pool's activation gate)
    ///         already holds the bit-identical value. Keeping a single
    ///         evaluation site also removes the two-copies-in-lockstep
    ///         maintenance hazard the L-6 migration exposed.
    function shiftPriceScale(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 repegStepWad,
        uint256 deviationWad
    ) internal pure returns (uint256 priceScaleNewWad, uint256 movedAbsWad) {
        if (priceScaleOldWad == 0 || targetWad == 0) revert Errors.InvalidPriceScale();
        if (repegStepWad == 0 || repegStepWad > Constants.WAD) revert Errors.InvalidRepegStep();

        if (targetWad == priceScaleOldWad) {
            return (priceScaleOldWad, 0);
        }

        uint256 appliedStepWad = appliedRepegStep(repegStepWad, deviationWad);

        // No-progress guard: when the deviation collapses below
        // `REPEG_DAMPING_DIVISOR` wei the cap rounds to 0; skip the move
        // and keep the function side-effect free.
        if (appliedStepWad == 0) {
            return (priceScaleOldWad, 0);
        }

        priceScaleNewWad = applyLogStep(priceScaleOldWad, targetWad, appliedStepWad);
        movedAbsWad = priceScaleNewWad >= priceScaleOldWad
            ? priceScaleNewWad - priceScaleOldWad
            : priceScaleOldWad - priceScaleNewWad;
    }

    /// @notice Damped applied step: `min(repegStepWad,
    ///         deviationWad / REPEG_DAMPING_DIVISOR)`. The cap shrinks
    ///         the applied step proportionally as the EMA-priceScale gap
    ///         closes, bounded above by the configured `repegStepWad`.
    ///         Split out so `_tryAutoRepeg`'s halving ladder can retry
    ///         the SAME base step at halved magnitudes.
    function appliedRepegStep(
        uint256 repegStepWad,
        uint256 deviationWad
    ) internal pure returns (uint256 appliedStepWad) {
        uint256 dampedDeviationWad = deviationWad / Constants.REPEG_DAMPING_DIVISOR;
        appliedStepWad = repegStepWad < dampedDeviationWad ? repegStepWad : dampedDeviationWad;
    }

    /// @notice Apply one LOG-DOMAIN move of magnitude `appliedStepWad`
    ///         toward `targetWad`: `psNew = mulWad(ps, expWad(±applied))`.
    /// @dev Why log-domain and not the relative-additive `ps·(1 ± s)`:
    ///      `exp(s) · exp(−s) == 1` exactly, so the up and down moves
    ///      are exact multiplicative inverses and a mirrored
    ///      (reciprocal-frame) pool shifts onto the exact reciprocal
    ///      anchor. The additive form leaves an O(s²) residue per move
    ///      whose sign depends on token order — accumulated over ~1e5
    ///      repegs of a multi-year horizon it grows to a percent-scale
    ///      anchor drift between the two orientations of the same pair.
    ///      Same reciprocal-invariance rationale as the geometric EMA
    ///      above; bit-for-bit with the Rust reference `apply_log_step`.
    ///      The no-overshoot clamp to `targetWad` is unconditional:
    ///      worst case lands exactly ON the target, never past it.
    function applyLogStep(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 appliedStepWad
    ) internal pure returns (uint256 priceScaleNewWad) {
        if (priceScaleOldWad == 0 || targetWad == 0) revert Errors.InvalidPriceScale();
        if (targetWad == priceScaleOldWad || appliedStepWad == 0) {
            return priceScaleOldWad;
        }
        bool up = targetWad > priceScaleOldWad;
        // Single `expWad` call site (sign folded into the argument)
        // keeps ONE inlined copy of the exp kernel in the pool's
        // bytecode — the pool sits near the EIP-170 ceiling.
        uint256 factor = uint256(
            FixedPointMathLib.expWad(up ? int256(appliedStepWad) : -int256(appliedStepWad))
        );
        priceScaleNewWad = FixedPointMathLib.mulWad(priceScaleOldWad, factor);
        if (up) {
            if (priceScaleNewWad > targetWad) priceScaleNewWad = targetWad;
        } else {
            if (priceScaleNewWad < targetWad) priceScaleNewWad = targetWad;
        }
    }
}
