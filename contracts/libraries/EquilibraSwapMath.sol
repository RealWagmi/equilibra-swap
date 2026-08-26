// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { Constants } from "./Constants.sol";
import { Errors } from "./Errors.sol";

/// @title EquilibraSwapMath
/// @notice Math kernel for the Equilibra AMM. Single-piece **cubic**
///         invariant with two independent concentration knobs and an
///         **asymmetric (quote-side normalised)** math-space coordinate
///         change.
///
/// === Coordinate change (asymmetric, quote-side normalised) ===
///
///     priceScaleWad = (yWad / xWad) at the anchor          [quote / base]
///
///     xMath = xWad                                          (base side, untouched)
///     yMath = yWad · WAD / priceScaleWad                    (quote → base)
///
/// Properties:
///   • At the anchor `yWad / xWad = priceScale`, so
///     `yMath = yWad·WAD/priceScale = xWad = xMath` (diagonal).
///   • A repeg moving `priceScale` toward EMA shifts `yMath` (only one
///     side); the resulting `(xMath, yMath)` is genuinely off-diagonal
///     when reserves are imbalanced, which is what gives the auto-repeg
///     gate a meaningful IL signal (see §6 below and the pool's
///     `_tryAutoRepeg` NatSpec). One-sided normalisation is what gives
///     the repeg gate a real cost basis on imbalanced state.
///
/// === Invariant ===
///
///     K(xMath, yMath; L) = A · L · (xMath + yMath) / 2
///                        + (W − A) · xMath · yMath
///
///     D = (yMath − xMath)² / (xMath · yMath)      // state distance
///     A = a · W / (W + λ · D)                      // n = 1, hardcoded
///
///     W = WAD = 1e18.
///
/// Polynomial degree in `yMath` (with `xMath` fixed) is **3** after
/// clearing denominators — the secant solver operates on a
/// well-conditioned cubic envelope.
///
/// === Concentration knobs (independent) ===
///
///   `a` — depth at anchor. `A(D=0) = a`, so larger `a` deepens the
///         centre. Range `[A_MIN_WAD, A_MAX_WAD] = [0.1·W, 0.99·W]`.
///         `a == W` is forbidden — it makes `(W − A) = 0` at the
///         anchor and the L-quadratic ill-conditioned.
///
///   `λ` — plateau width. `A = a/2` at `λ·D = W` (half-amplification
///         distance). Larger `λ` narrows the plateau; smaller `λ`
///         widens it. Range `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
///
/// Decoupling: `a` alone controls the centre depth, `λ` alone controls
/// the cliff position — the two knobs are mathematically orthogonal.
///
/// === Depth scale L (closed-form quadratic) ===
///
///     At the balance-state `xMath = yMath = L_eq`, `D = 0`, `A = a`:
///       K = a·L_eq² + (W − a)·L_eq² = W · L_eq²
///     ⇒  L_eq = √(K / W)
///
///     For any state `(xMath, yMath)`, the self-consistent depth scale
///     is the positive root of
///       W·L² − A·L·S − (W − A)·N = 0,
///       S = (xMath + yMath)/2,
///       N = xMath · yMath,
///     yielding
///       L = (A·S + √( (A·S)² + 4·W·(W − A)·N )) / (2·W).
///
///     Path-additivity: every point on `K = const` recovers the same
///     `L` (the second root is spurious and negative on every
///     admissible state), so the secant solver freezes `L` at the
///     pre-state value and the level-set arithmetic is exact modulo
///     residual rounding.
///
/// === LP unit value (anchor-invariant) ===
///
///     vp = 2 · L_eq · √(priceScale · WAD) / totalSupply
///
///     The `√(priceScale · WAD)` factor is the anchor normaliser: it
///     keeps `vp` in consistent units across repegs, otherwise
///     math-space drift would mask IL.
library EquilibraSwapMath {
    /// @dev Maximum secant iterations per swap leg. Cubic K with frozen
    ///      L converges in 3–6 iterations from a CP seed on the
    ///      production envelope. The elevated cap accommodates extreme
    ///      deep-imbalance / boundary-`λ` swaps and triggers the
    ///      best-iterate fallback only on pathological inputs.
    uint256 private constant _MAX_SECANT_ITER = 12;

    // =========================================================================
    // 1. Decimal lift / drop  (WAD ↔ raw token decimals)
    // =========================================================================

    /// @notice Convert raw token amount to WAD-normalised units.
    function toWad(uint256 amountRaw, uint8 decimals) internal pure returns (uint256 amountWad) {
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        if (decimals == 18) return amountRaw;
        unchecked {
            amountWad = amountRaw * (10 ** (18 - decimals));
        }
    }

    /// @notice Convert WAD amount to raw token decimals using floor rounding.
    ///         Use for amounts paid OUT to the user — flooring is
    ///         pool-favourable (dust stays on the pool side).
    function fromWadDown(
        uint256 amountWad,
        uint8 decimals
    ) internal pure returns (uint256 amountRaw) {
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        if (decimals == 18) return amountWad;
        unchecked {
            amountRaw = amountWad / (10 ** (18 - decimals));
        }
    }

    /// @notice Convert WAD amount to raw token decimals using ceil rounding.
    ///         Use for amounts the user must pay IN to the pool — ceiling
    ///         is pool-favourable.
    function fromWadUp(
        uint256 amountWad,
        uint8 decimals
    ) internal pure returns (uint256 amountRaw) {
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        if (decimals == 18) return amountWad;
        amountRaw = FixedPointMathLib.mulDivUp(amountWad, 1, 10 ** (18 - decimals));
    }

    // =========================================================================
    // 2. Math-space coordinate change (symmetric)
    // =========================================================================

    /// @notice Lift `(xWad, yWad)` into the asymmetric math-space:
    ///             xMath = xWad                              (base, untouched)
    ///             yMath = yWad · WAD / priceScaleWad        (quote → base)
    /// @dev    `priceScaleWad = yWad / xWad` at the anchor (quote per
    ///         base in WAD form), so at the anchor `yMath = xWad =
    ///         xMath` (diagonal) and the curve's symmetric kernel
    ///         applies. Off-anchor, `yMath ≠ xMath` and the
    ///         `(xMath, yMath)` carries one-sided priceScale
    ///         dependence — this is the source of the auto-repeg gate's
    ///         IL detection.
    function toMathSpace(
        uint256 xWad,
        uint256 yWad,
        uint256 priceScaleWad
    ) internal pure returns (uint256 xMath, uint256 yMath) {
        if (priceScaleWad == 0) revert Errors.InvalidPriceScale();
        xMath = xWad;
        yMath = FixedPointMathLib.divWad(yWad, priceScaleWad);
    }

    // =========================================================================
    // 3. Distance metrics
    // =========================================================================

    /// @notice Symmetric distance between marginal and reference prices,
    ///         used by the dynamic-fee ramp:
    ///             dist = (p − a)² / (p · a)
    /// @dev    Anti-symmetric in `(pMarg, pRef)`. The squared-difference
    ///         form uses a single division instead of two, which
    ///         eliminates cascading rounding from ratio inversion.
    ///         Result is WAD-scaled.
    function distanceFromAnchorWad(
        uint256 pMargWad,
        uint256 pRefWad
    ) internal pure returns (uint256 distWad) {
        if (pMargWad == 0 || pRefWad == 0) revert Errors.InvalidPriceScale();
        if (pMargWad == pRefWad) return 0;

        uint256 diff;
        unchecked {
            diff = pMargWad > pRefWad ? pMargWad - pRefWad : pRefWad - pMargWad;
        }
        uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
        uint256 denomWad = FixedPointMathLib.mulWad(pMargWad, pRefWad);
        if (denomWad == 0) revert Errors.MathInvariantViolation();
        distWad = FixedPointMathLib.divWad(diffSqWad, denomWad);
    }

    /// @notice State-only math-space distance:
    ///             D = (yMath − xMath)² / (xMath · yMath)
    ///         WAD-scaled. Reverts on zero reserves; returns 0 at the
    ///         anchor (xMath == yMath).
    /// @dev    Feeds the amplification `A = a·W / (W + λ·D)`.
    function distanceState(uint256 xMath, uint256 yMath) internal pure returns (uint256 distWad) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (xMath == yMath) return 0;
        uint256 diff;
        unchecked {
            diff = yMath > xMath ? yMath - xMath : xMath - yMath;
        }
        uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
        uint256 xyWad = FixedPointMathLib.mulWad(xMath, yMath);
        if (xyWad == 0) revert Errors.MathInvariantViolation();
        distWad = FixedPointMathLib.divWad(diffSqWad, xyWad);
    }

    // =========================================================================
    // 4. Amplification A = a·W / (W + λ·D)
    // =========================================================================

    /// @notice Compute the amplification `A` and its denominator
    ///         `denom = W + λ·D` jointly.
    /// @dev    Returns both so callers needing the marginal-price
    ///         derivative chain — which references `A · λ / denom` —
    ///         pay for the denominator only once.
    ///
    ///         Properties:
    ///           • `D = 0` (anchor):    `A = a`,   `denom = W`
    ///           • `λ·D = W` (knee):    `A = a/2`, `denom = 2W`
    ///           • `D → ∞`:             `A → 0`,   `denom → ∞`
    ///
    ///         `A < W` strictly under the factory's `a ≤ A_MAX_WAD <
    ///         W` invariant, so the tail term `(W − A)·N` in the
    ///         invariant never collapses.
    function _amplification(
        uint256 aWad,
        uint256 lambdaWad,
        uint256 distWad
    ) private pure returns (uint256 ampWad, uint256 denomWad) {
        // λ·D in WAD (dimensionless)
        uint256 lambdaDWad = FixedPointMathLib.mulWad(lambdaWad, distWad);
        // denom = W + λ·D ≥ W, strictly monotone-up in D
        denomWad = Constants.WAD + lambdaDWad;
        // A = a · W / denom (single mulDiv, no intermediate overflow)
        ampWad = FixedPointMathLib.mulDiv(aWad, Constants.WAD, denomWad);
    }

    // =========================================================================
    // 5. Invariant K and depth scale L
    // =========================================================================

    /// @notice Closed-form invariant
    ///         `K(x, y; L) = A·L·(x+y)/2 + (W − A)·xy`
    ///         with `L` supplied by the caller.
    /// @dev    Private fast path used by `computeK`/`computeKAndL` and
    ///         the secant solver. Returns 0 for degenerate states
    ///         (zero reserve or `xy` floored to zero) so callers can
    ///         short-circuit on cold paths.
    function _computeKFromL(
        uint256 xMath,
        uint256 yMath,
        uint256 lWad,
        uint256 aWad,
        uint256 lambdaWad
    ) private pure returns (uint256 kWad) {
        if (xMath == 0 || yMath == 0) return 0;
        uint256 nWad = FixedPointMathLib.mulWad(xMath, yMath);
        if (nWad == 0) return 0;

        // D and A
        uint256 distWad;
        if (xMath != yMath) {
            uint256 diff;
            unchecked {
                diff = yMath > xMath ? yMath - xMath : xMath - yMath;
            }
            uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
            distWad = FixedPointMathLib.divWad(diffSqWad, nWad);
        }
        (uint256 ampWad, ) = _amplification(aWad, lambdaWad, distWad);

        // K = A·L·(x+y)/2 + (W−A)·xy
        uint256 sumXY = xMath + yMath;
        uint256 sHalfWad = sumXY >> 1; // (x+y) / 2
        uint256 alWad = FixedPointMathLib.mulWad(ampWad, lWad);
        uint256 headWad = FixedPointMathLib.mulWad(alWad, sHalfWad);
        uint256 tailWad = FixedPointMathLib.mulWad(Constants.WAD - ampWad, nWad);
        kWad = headWad + tailWad;
    }

    /// @notice Solve the closed-form quadratic
    ///         `W·L² − A·L·S − (W − A)·N = 0`
    ///         for the positive root
    ///         `L = (A·S + √((A·S)² + 4·W·(W − A)·N)) / (2·W)`.
    /// @dev    The discriminant `(A·S)² + 4W(W−A)·N` is strictly
    ///         positive on every well-defined state, so the positive
    ///         root exists. The negative root is non-positive and
    ///         spurious.
    ///
    ///         **Path-additivity**: any other point on the same
    ///         `K = const` level set recovers the same positive root,
    ///         so a forward leg ending at `(x', y')` and a reverse
    ///         leg starting from `(x', y')` yield the same `L`.
    ///         Within a swap leg the on-chain pool freezes `L` at the
    ///         pre-state value and the secant drives
    ///         `K(x_post, y_post; L_pre) = K_pre` to ≤ 1–2 wei
    ///         residual.
    ///
    ///         **Anchor identity**: at `x = y = L`, the quadratic
    ///         reduces to `L = (a·x + (2−a)·x)/2 = x` (with `W = 1`),
    ///         pinning the centre exactly without sqrt rounding.
    ///
    ///         Returns `0` for degenerate states (zero reserve, or
    ///         `xy` floored to 0) so callers can short-circuit.
    function solveLFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 lWad) {
        if (xMath == 0 || yMath == 0) return 0;
        uint256 nWad = FixedPointMathLib.mulWad(xMath, yMath);
        if (nWad == 0) return 0;

        // D in math-space (zero at anchor)
        uint256 distWad;
        if (xMath != yMath) {
            uint256 diff;
            unchecked {
                diff = yMath > xMath ? yMath - xMath : xMath - yMath;
            }
            uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
            distWad = FixedPointMathLib.divWad(diffSqWad, nWad);
        }

        (uint256 ampWad, ) = _amplification(aWad, lambdaWad, distWad);

        // S = (x + y) / 2
        uint256 sHalfWad = (xMath + yMath) >> 1;
        // A·S in WAD
        uint256 asWad = FixedPointMathLib.mulWad(ampWad, sHalfWad);
        // (A·S)² in WAD
        uint256 asSqWad = FixedPointMathLib.mulWad(asWad, asWad);
        // 4·W·(W − A)·N in WAD:
        //   In real units (W = 1):       4·(W − A)·N
        //   In stored single-WAD form:   4 · mulWad(WAD − ampWad, nWad)
        // (The explicit `W` collapses into the single-WAD
        //  store-scaling.)
        uint256 fourTermWad;
        unchecked {
            fourTermWad = 4 * FixedPointMathLib.mulWad(Constants.WAD - ampWad, nWad);
        }
        uint256 discWad = asSqWad + fourTermWad;
        // √disc · WAD = sqrtWad(disc) (single-WAD semantics)
        uint256 sqrtDiscWad = FixedPointMathLib.sqrtWad(discWad);

        // L = (A·S + √disc) / 2 in real units; stored single-WAD is
        // numerator >> 1 since `W = 1` collapses the `2W` denominator
        // to `2`.
        unchecked {
            lWad = (asWad + sqrtDiscWad) >> 1;
        }
    }

    /// @notice Closed-form invariant K with L recovered from state.
    ///         Used wherever the caller does not already have `L` in
    ///         scope (LP unit-value reader, marginal-price probe,
    ///         test harness).
    function computeK(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 kWad) {
        (kWad, ) = computeKAndL(xMath, yMath, aWad, lambdaWad);
    }

    /// @notice Joint K + L recovery in one fused pass. The shared state
    ///         products — `N = x·y`, distance `D`, amplification `A`,
    ///         half-sum `S/2` and tail `(W − A)·N` — are computed
    ///         exactly once and reused by both the quadratic root and
    ///         the invariant evaluation. Bit-identical to running
    ///         `solveLFromState` + `_computeKFromL` back to back (same
    ///         primitives, same order, same rounding) at roughly half
    ///         the arithmetic (audit O-4).
    function computeKAndL(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 kWad, uint256 lWad) {
        if (xMath == 0 || yMath == 0) return (0, 0);
        uint256 nWad = FixedPointMathLib.mulWad(xMath, yMath);
        if (nWad == 0) return (0, 0);

        // D and A — single evaluation shared by both halves.
        uint256 distWad;
        if (xMath != yMath) {
            uint256 diff;
            unchecked {
                diff = yMath > xMath ? yMath - xMath : xMath - yMath;
            }
            uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
            distWad = FixedPointMathLib.divWad(diffSqWad, nWad);
        }
        (uint256 ampWad, ) = _amplification(aWad, lambdaWad, distWad);

        uint256 sHalfWad = (xMath + yMath) >> 1;
        uint256 asWad = FixedPointMathLib.mulWad(ampWad, sHalfWad);
        // `(W − A)·N` doubles as the quadratic's 4-term (×4) and the
        // invariant's tail — computed once.
        uint256 tailWad = FixedPointMathLib.mulWad(Constants.WAD - ampWad, nWad);

        // L: positive root of `W·L² − A·L·S − (W − A)·N = 0`.
        uint256 asSqWad = FixedPointMathLib.mulWad(asWad, asWad);
        uint256 fourTermWad;
        unchecked {
            fourTermWad = 4 * tailWad;
        }
        uint256 discWad = asSqWad + fourTermWad;
        uint256 sqrtDiscWad = FixedPointMathLib.sqrtWad(discWad);
        unchecked {
            lWad = (asWad + sqrtDiscWad) >> 1;
        }
        if (lWad == 0) return (0, 0);

        // K = A·L·(x+y)/2 + (W − A)·xy — amp/half-sum/tail reused.
        uint256 alWad = FixedPointMathLib.mulWad(ampWad, lWad);
        kWad = FixedPointMathLib.mulWad(alWad, sHalfWad) + tailWad;
    }

    /// @notice Recover the balance-state depth `L_eq = √(K / W)` from
    ///         the invariant value at the anchor.
    /// @dev    At the anchor `K = W · L_eq²`. With `W = WAD` (real
    ///         value 1), the stored relation is `K_stored = L²_stored
    ///         · WAD / WAD = mulWad(L, L)`, so `L_eq = sqrt(K_stored ·
    ///         WAD) = sqrtWad(K_stored)` recovers L in WAD-scaled
    ///         (single-WAD) form.
    ///
    ///         Returns 0 on `kWad == 0`.
    function balanceScaleFromK(uint256 kWad) internal pure returns (uint256 lEqWad) {
        if (kWad == 0) return 0;
        lEqWad = FixedPointMathLib.sqrtWad(kWad);
    }

    // =========================================================================
    // 6. LP unit value (price-scale-aware)
    // =========================================================================

    /// @notice `vp = 2 · L_eq · √(priceScale · WAD) / totalSupply` — the
    ///         per-LP-share quote-equivalent unit value consumed by
    ///         `_accrueLpValueGrowth` (monotone-up high-water mark) and
    ///         the auto-repeg solvency gate.
    /// @dev    **Role of the `√(priceScale · WAD)` normaliser.**
    ///         The auto-repeg gate (`_tryAutoRepeg`) compares `vpAfter`
    ///         (same reserves, candidate `priceScaleNew`) against the
    ///         threshold; its job is to reject moves whose realised
    ///         IL cost would exceed the LP growth cushion. For that
    ///         check to **bite**, `vp` must change meaningfully when
    ///         `priceScale` shifts at fixed reserves — otherwise the
    ///         gate becomes a no-op (the symmetric coord change leaves
    ///         `xMath · yMath` invariant and `L_eq` mostly invariant,
    ///         so without the normaliser `vpAfter ≈ vpBefore` always
    ///         and Gate 2 never fires).
    ///
    ///         The `√(priceScale · WAD)` factor is the anchor
    ///         normaliser: it converts the math-space depth `2·L_eq` (in `L_eq` /
    ///         share dimensionless units) into a **quote-equivalent**
    ///         per-share value. A move from `priceScale_old` to
    ///         `priceScale_new` at fixed reserves shifts `vp` by
    ///         approximately `√(P_new / P_old) − 1`, which is exactly
    ///         the IL signal Gate 2 needs.
    ///
    ///         vp evolution:
    ///           • Fee-bearing swap: K↑ → L_eq↑ → vp↑ (monotone).
    ///           • Mint/burn:        proportional — L_eq and supply
    ///                                scale together, vp is preserved
    ///                                modulo wei-level rounding
    ///                                (handled by `_reanchorLpUnitValue`).
    ///           • Repeg:            `priceScale` changes ⇒ vp shifts
    ///                                by ≈ `√(P_new/P_old) − 1`. Gate 2
    ///                                approves only when the post-move
    ///                                vp stays above the LP-share
    ///                                threshold.
    ///
    ///         **Anchor-invariance of growth accrual.** The accrual
    ///         path is unaffected by the cross-repeg shift because
    ///         `_accrueLpValueGrowth` runs **before** `_tryAutoRepeg`
    ///         (so it sees `vp` under the unchanged pre-swap
    ///         `priceScale`), and a successful repeg writes
    ///         `_lpUnitValueWad = vpAfter` **directly** (bypassing the
    ///         accrual that would otherwise double-credit the shift).
    ///         The next swap's accrual then measures growth against
    ///         the new baseline — only real fee-driven L_eq growth
    ///         flows into `_lpValueGrowthWad`.
    /// @notice `vp = 2 · L_eq · √(priceScale · WAD) / totalSupply`
    ///         — the per-LP-share quote-equivalent unit value consumed
    ///         by `_accrueLpValueGrowth` (monotone-up high-water mark)
    ///         and the auto-repeg solvency gate (Gate 2).
    /// @dev    With the asymmetric math-space coord change
    ///         (`yMath = yWad · WAD / priceScale`), repegs at fixed
    ///         reserves shift `yMath` only — making `(xMath, yMath)`
    ///         genuinely off-balance. The resulting `L_eq` typically
    ///         drops, and the `√(priceScale·WAD)` factor either
    ///         partially compensates (when priceScale moves toward
    ///         reserve balance, reducing math-space imbalance) or
    ///         amplifies the IL signal. This gives Gate 2 a real
    ///         "did the repeg consume too much LP cushion?" reading.
    function computeLpUnitValueWad(
        uint256 lEqWad,
        uint256 priceScaleWad,
        uint256 totalSupplyWad
    ) internal pure returns (uint256 unitValueWad) {
        if (totalSupplyWad == 0 || lEqWad == 0 || priceScaleWad == 0) {
            return 0;
        }
        // sqrtWad(x) returns `√(x · WAD)` in WAD form — the canonical
        // WAD-of-a-WAD-quantity primitive used everywhere else.
        uint256 sqrtPsWad = FixedPointMathLib.sqrtWad(priceScaleWad);
        uint256 doubleL = lEqWad << 1;
        unitValueWad = FixedPointMathLib.fullMulDiv(doubleL, sqrtPsWad, totalSupplyWad);
    }

    // =========================================================================
    // 7. Marginal price (analytic, math-space, n = 1)
    // =========================================================================

    /// @notice Math-space marginal price `pMarg = ∂K/∂xMath ÷
    ///         ∂K/∂yMath` at `(xMath, yMath)` with frozen depth `L`.
    ///         WAD-scaled. At the diagonal (`xMath == yMath`) collapses
    ///         to `WAD` exactly.
    /// @dev    Closed-form derivation for `A = a·W / (W + λ·D)`:
    ///             ∂K/∂x = (∂A/∂x)·(L·S − N) + A·L/2 + (W − A)·y
    ///             ∂K/∂y = (∂A/∂y)·(L·S − N) + A·L/2 + (W − A)·x
    ///
    ///         Symmetry of D in (x, y) gives
    ///             x · ∂A/∂x  =  −y · ∂A/∂y
    ///         so the case-split collapses to ONE sign decision
    ///         (`sign(yMath − xMath)`).
    ///
    ///         Magnitudes:
    ///             |x·∂D/∂x| = |yMath − xMath|·(xMath + yMath) / N
    ///             |x·∂A/∂x| = (A·λ / denom) · |x·∂D/∂x|        [n = 1]
    ///             |τ|       = |x·∂A/∂x| · |L·S − N|
    ///
    ///         Assemble:
    ///             x · ∂K/∂x = τ + base_x,   base_x = A·L·x/2 + (W − A)·N
    ///             y · ∂K/∂y = −τ + base_y, base_y = A·L·y/2 + (W − A)·N
    ///             pMarg     = (yMath · (x·∂K/∂x)) /
    ///                          (xMath · (y·∂K/∂y))
    ///
    ///         The subtractive branch is mathematically positive for
    ///         every admissible (a, λ) in the factory-validated
    ///         envelope. A runtime underflow on that branch signals a
    ///         parameter-envelope regression and reverts with
    ///         `MathInvariantViolation`.
    function marginalPrice(
        uint256 xMath,
        uint256 yMath,
        uint256 lWad,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 pMargMathWad) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        // Diagonal short-circuit — D = 0, ∂A/∂{x,y} = 0, the formula
        // collapses to base_x = base_y, pMarg = WAD exactly.
        if (xMath == yMath) return Constants.WAD;
        if (lWad == 0) revert Errors.InsufficientLiquidity();

        (uint256 xKx, uint256 yKy) = _marginalPriceParts(xMath, yMath, lWad, aWad, lambdaWad);

        if (yKy == 0) revert Errors.DivisionByZero();

        // pMarg = (yMath · xKx) / (xMath · yKy)
        uint256 num = FixedPointMathLib.mulWad(yMath, xKx);
        uint256 den = FixedPointMathLib.mulWad(xMath, yKy);
        pMargMathWad = FixedPointMathLib.divWad(num, den);
    }

    /// @dev Compute the two numerators `(x·∂K/∂x, y·∂K/∂y)` for the
    ///      marginal-price ratio. Extracted from `marginalPrice` so the
    ///      caller's stack stays under the 16-slot limit on `viaIR=false`
    ///      builds. Pre-conditions: `xMath != yMath > 0`, `lWad > 0`.
    function _marginalPriceParts(
        uint256 xMath,
        uint256 yMath,
        uint256 lWad,
        uint256 aWad,
        uint256 lambdaWad
    ) private pure returns (uint256 xKx, uint256 yKy) {
        // Bundle the amplification-side computations into one helper
        // so the outer function's stack stays under the 16-slot limit
        // on `viaIR=false`. `nWad` is also returned because the τ
        // helper needs it again — re-deriving costs a `mulWad`.
        (uint256 prefactor, uint256 baseX, uint256 baseY, uint256 nWad) = _marginalPriceAmpSide(
            xMath,
            yMath,
            lWad,
            aWad,
            lambdaWad
        );

        (uint256 absTau, bool tauPositive) = _marginalPriceTau(prefactor, lWad, xMath, yMath, nWad);

        // Combine with proper signs:
        //   x·∂K/∂x = τ + base_x
        //   y·∂K/∂y = −τ + base_y
        if (tauPositive) {
            xKx = baseX + absTau;
            if (baseY <= absTau) revert Errors.MathInvariantViolation();
            unchecked {
                yKy = baseY - absTau;
            }
        } else {
            if (baseX <= absTau) revert Errors.MathInvariantViolation();
            unchecked {
                xKx = baseX - absTau;
            }
            yKy = baseY + absTau;
        }
    }

    /// @dev All amplification-side derived quantities the marginal-price
    ///      formula needs, computed in one helper to keep
    ///      `_marginalPriceParts` shallow on the stack:
    ///        - `prefactor = A · λ / denom` (the τ-scaling factor)
    ///        - `baseX = A·L·x/2 + (W−A)·N`, `baseY = A·L·y/2 + (W−A)·N`
    ///        - `nWad = x · y / W` (returned because τ also needs it).
    function _marginalPriceAmpSide(
        uint256 xMath,
        uint256 yMath,
        uint256 lWad,
        uint256 aWad,
        uint256 lambdaWad
    ) private pure returns (uint256 prefactor, uint256 baseX, uint256 baseY, uint256 nWad) {
        nWad = FixedPointMathLib.mulWad(xMath, yMath);
        if (nWad == 0) revert Errors.MathInvariantViolation();

        uint256 distWad = _distState(xMath, yMath, nWad);
        (uint256 ampWad, uint256 denomWad) = _amplification(aWad, lambdaWad, distWad);

        (baseX, baseY) = _marginalPriceBases(ampWad, lWad, xMath, yMath, nWad);
        prefactor = FixedPointMathLib.mulDiv(ampWad, lambdaWad, denomWad);
    }

    /// @dev State distance `D = (yMath − xMath)² / (xMath · yMath)` in
    ///      WAD with the product `nWad = xMath·yMath/W` pre-computed
    ///      to avoid a redundant `mulWad`.
    function _distState(
        uint256 xMath,
        uint256 yMath,
        uint256 nWad
    ) private pure returns (uint256 distWad) {
        uint256 diff;
        unchecked {
            diff = yMath > xMath ? yMath - xMath : xMath - yMath;
        }
        uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
        distWad = FixedPointMathLib.divWad(diffSqWad, nWad);
    }

    /// @dev Signed off-diagonal term `τ = (x·∂A/∂x)·(L·S − N)` split
    ///      into magnitude + sign. Returned bool is the sign of `τ`.
    ///      `prefactor = A·λ / denom` is supplied pre-computed by the
    ///      caller to keep this helper's argument count below the
    ///      `viaIR=false` stack-spill threshold.
    ///      `|x·∂A/∂x| = prefactor · |y − x|·(x + y) / N` and the
    ///      sign rule
    ///        sign(τ) = sign(x·∂A/∂x) · sign(H)
    ///                = (yMath > xMath) ⊕ (lsWad < nWad)
    ///      collapses to an `==` between the two flags.
    function _marginalPriceTau(
        uint256 prefactor,
        uint256 lWad,
        uint256 xMath,
        uint256 yMath,
        uint256 nWad
    ) private pure returns (uint256 absTau, bool tauPositive) {
        uint256 sumXY = xMath + yMath;

        // |x·∂A/∂x| via paired fullMulDiv to keep intermediates inside
        // 256 bits at the envelope's upper corner.
        uint256 absXdAdxWad;
        {
            uint256 diff;
            unchecked {
                diff = yMath > xMath ? yMath - xMath : xMath - yMath;
            }
            uint256 num1 = FixedPointMathLib.fullMulDiv(diff, sumXY, Constants.WAD);
            uint256 absXdDdx = FixedPointMathLib.fullMulDiv(num1, Constants.WAD, nWad);
            absXdAdxWad = FixedPointMathLib.mulWad(prefactor, absXdDdx);
        }

        // H = L·S − N, sign-tracked. S = sumXY / 2.
        uint256 lsWad = FixedPointMathLib.mulWad(lWad, sumXY >> 1);
        bool hPositive = lsWad >= nWad;
        uint256 absH;
        unchecked {
            absH = hPositive ? lsWad - nWad : nWad - lsWad;
        }

        absTau = FixedPointMathLib.mulWad(absXdAdxWad, absH);
        tauPositive = (yMath > xMath) == hPositive;
    }

    /// @dev Diagonal base terms `base_x = A·L·x/2 + (W−A)·N` and
    ///      `base_y = A·L·y/2 + (W−A)·N`. The two outputs share the
    ///      `alHalf` and `tailWad` factors.
    function _marginalPriceBases(
        uint256 ampWad,
        uint256 lWad,
        uint256 xMath,
        uint256 yMath,
        uint256 nWad
    ) private pure returns (uint256 baseX, uint256 baseY) {
        uint256 alHalf = FixedPointMathLib.mulWad(ampWad, lWad) >> 1;
        uint256 wMinusA;
        unchecked {
            wMinusA = Constants.WAD - ampWad;
        }
        uint256 tailWad = FixedPointMathLib.mulWad(wMinusA, nWad);
        baseX = FixedPointMathLib.mulWad(alHalf, xMath) + tailWad;
        baseY = FixedPointMathLib.mulWad(alHalf, yMath) + tailWad;
    }

    /// @notice Convenience overload that recovers `L` from state
    ///         internally. Slightly more expensive than the
    ///         L-supplied form; the pool prefers the supplied form
    ///         on swap hot paths where `L` is already in scope.
    function marginalPriceFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 pMargMathWad) {
        uint256 lWad = solveLFromState(xMath, yMath, aWad, lambdaWad);
        pMargMathWad = marginalPrice(xMath, yMath, lWad, aWad, lambdaWad);
    }

    // =========================================================================
    // 8. Swap quotes (secant against frozen-L cubic K)
    // =========================================================================

    /// @notice Forward exact-input: given pre-state `(xMath, yMath)`
    ///         and deposit `dxMath` on the x-side, return the output
    ///         `dyMath` on the y-side conserving `K(·; L_pre)`.
    /// @dev    Algorithm:
    ///           1. `L_pre = solveLFromState(xMath, yMath; a, λ)`.
    ///           2. `kTarget = K(xMath, yMath; L_pre, a, λ)` via
    ///              `_computeKFromL` (same formula path the secant
    ///              uses inside the loop — bit-exact match on the
    ///              residual).
    ///           3. `xPost = xMath + dxMath`.
    ///           4. Seed `yPost ≈ N_pre / xPost` (CP proxy).
    ///           5. Secant on `K(xPost, yPost; L_pre) = kTarget`,
    ///              ≤ `_MAX_SECANT_ITER` iters, best-iterate fallback.
    ///           6. `dyMath = yMath − yPost`. A wrong-side terminal
    ///              iterate (`yPost > yMath`) reports as `dyMath = 0` —
    ///              a fail-closed refusal to quote that flows into the
    ///              typed dust guards downstream.
    function quoteExactInForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 dyMath, uint256 iters) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dxMath == 0) revert Errors.ZeroAmount();

        (uint256 kTarget, uint256 lPre) = computeKAndL(xMath, yMath, aWad, lambdaWad);
        if (lPre == 0 || kTarget == 0) revert Errors.InsufficientLiquidity();

        return _quoteExactInBody(xMath, yMath, dxMath, aWad, lambdaWad, lPre, kTarget);
    }

    /// @notice L-supplied overload: the pool solves the pre-state `L`
    ///         exactly once per swap/quote and threads it here (audit
    ///         O-3). `lPreWad` MUST be `solveLFromState` of the same
    ///         pre-state — the kernel is symmetric in `(x, y)`, so one
    ///         value serves both trade directions bit-for-bit.
    function quoteExactInForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPreWad
    ) internal pure returns (uint256 dyMath, uint256 iters) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dxMath == 0) revert Errors.ZeroAmount();

        uint256 kTarget = _computeKFromL(xMath, yMath, lPreWad, aWad, lambdaWad);
        if (lPreWad == 0 || kTarget == 0) revert Errors.InsufficientLiquidity();

        return _quoteExactInBody(xMath, yMath, dxMath, aWad, lambdaWad, lPreWad, kTarget);
    }

    /// @dev Shared secant body for both `quoteExactInForward` variants.
    function _quoteExactInBody(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPre,
        uint256 kTarget
    ) private pure returns (uint256 dyMath, uint256 iters) {
        uint256 xPost = xMath + dxMath;

        // CP seed: yPost ≈ xMath · yMath / xPost
        uint256 ySeed = FixedPointMathLib.mulDiv(xMath, yMath, xPost);
        if (ySeed == 0) ySeed = 1;

        (uint256 yPost, uint256 used) = _solveCounterpart(
            xPost,
            ySeed,
            kTarget,
            aWad,
            lambdaWad,
            lPre
        );

        if (yPost > yMath) {
            // The secant's terminal iterate landed on the wrong side of
            // the pre-state: no physically admissible discrete quote
            // was found for this input (observed on dust-scale trades
            // where the kernel's integer quantization dominates the
            // signal, e.g. strongly de-anchored pools). Fail closed
            // with a zero-output sentinel — the swap path stops in the
            // typed zero-raw-output guard
            // (`AmountTooSmallAfterNormalization`) and `quoteExactIn`
            // returns 0 like every other unquotable dust case. This is
            // a refusal to quote, not a claim that the true real-valued
            // output is exactly zero.
            return (0, used);
        }
        unchecked {
            dyMath = yMath - yPost;
        }
        iters = used;
    }

    /// @notice Forward exact-output: mirror of `quoteExactInForward`.
    function quoteExactOutForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 dxMath, uint256 iters) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dyMath == 0) revert Errors.ZeroAmount();
        if (dyMath >= yMath) revert Errors.InsufficientLiquidity();

        (uint256 kTarget, uint256 lPre) = computeKAndL(xMath, yMath, aWad, lambdaWad);
        if (lPre == 0 || kTarget == 0) revert Errors.InsufficientLiquidity();

        return _quoteExactOutBody(xMath, yMath, dyMath, aWad, lambdaWad, lPre, kTarget);
    }

    /// @notice L-supplied overload — see `quoteExactInForward` (audit
    ///         O-3): `lPreWad` must be the same pre-state's
    ///         `solveLFromState` value (direction-independent).
    function quoteExactOutForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPreWad
    ) internal pure returns (uint256 dxMath, uint256 iters) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dyMath == 0) revert Errors.ZeroAmount();
        if (dyMath >= yMath) revert Errors.InsufficientLiquidity();

        uint256 kTarget = _computeKFromL(xMath, yMath, lPreWad, aWad, lambdaWad);
        if (lPreWad == 0 || kTarget == 0) revert Errors.InsufficientLiquidity();

        return _quoteExactOutBody(xMath, yMath, dyMath, aWad, lambdaWad, lPreWad, kTarget);
    }

    /// @dev Shared secant body for both `quoteExactOutForward` variants.
    function _quoteExactOutBody(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPre,
        uint256 kTarget
    ) private pure returns (uint256 dxMath, uint256 iters) {
        uint256 yPost = yMath - dyMath;

        uint256 xSeed = FixedPointMathLib.mulDiv(xMath, yMath, yPost);
        if (xSeed <= xMath) xSeed = xMath + 1;

        // Search with (yPost, xSeed): the secant treats yPost as the
        // fixed axis. The cubic is symmetric in (xMath, yMath), so
        // this works without extra structure.
        (uint256 xPost, uint256 used) = _solveCounterpart(
            yPost,
            xSeed,
            kTarget,
            aWad,
            lambdaWad,
            lPre
        );

        if (xPost < xMath) {
            // Wrong-side terminal iterate on the input axis: no
            // physically admissible discrete quote (mirror of the
            // exact-in case). Fail closed with a zero-input sentinel —
            // both the view and the swap path stop in the existing
            // `cleanInRaw == 0` typed guard
            // (`AmountTooSmallAfterNormalization`), so a zero-input
            // settlement can never happen.
            return (0, used);
        }
        unchecked {
            dxMath = xPost - xMath;
        }
        iters = used;
    }

    /// @notice Solve `K(aFixed, b; L) = kTarget` for `b` via secant
    ///         iteration on the closed-form cubic with frozen depth `L`.
    /// @dev    `K(aFixed, ·; L)` is strictly monotone in `b` on the
    ///         production envelope (head term `A·L·(aFixed + b)/2`
    ///         increases linearly; tail term `(W−A)·aFixed·b` is
    ///         non-negative; A varies smoothly with D). Two-seed
    ///         bootstrap (`b1 = bSeed`, `b2 = b1·1.001`) provides a
    ///         finite initial slope.
    ///
    ///         Early-exit conditions:
    ///           • `k2 == kTarget`  — exact hit.
    ///           • `dk == 0`        — degenerate slope.
    ///           • `b3u == b2`      — integer fixed point.
    ///
    ///         **Best-iterate fallback.** Pure secant on integer
    ///         cubics can oscillate around the fixed point — each
    ///         iterate flips sign and magnitude does not necessarily
    ///         shrink. When the loop exits on `MAX_ITER` we return
    ///         the iterate with the smallest absolute residual
    ///         observed, never strictly worse than the most recent.
    function _solveCounterpart(
        uint256 aFixed,
        uint256 bSeed,
        uint256 kTarget,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lWad
    ) private pure returns (uint256 b, uint256 iters) {
        uint256 b1 = bSeed;
        uint256 b2 = (bSeed * 1001) / 1000;
        if (b2 == b1) b2 = b1 + 1;

        uint256 k1 = _computeKFromL(aFixed, b1, lWad, aWad, lambdaWad);

        uint256 bBest = b1;
        uint256 residualAbsBest = k1 >= kTarget ? k1 - kTarget : kTarget - k1;

        for (uint256 i = 0; i < _MAX_SECANT_ITER; ++i) {
            uint256 k2 = _computeKFromL(aFixed, b2, lWad, aWad, lambdaWad);
            if (k2 == kTarget) {
                return (b2, i + 1);
            }

            // `residMag` doubles as the best-iterate residual and the
            // secant numerator below — one computation serves both.
            bool residPos = k2 >= kTarget;
            uint256 residMag;
            unchecked {
                residMag = residPos ? k2 - kTarget : kTarget - k2;
            }
            if (residMag < residualAbsBest) {
                bBest = b2;
                residualAbsBest = residMag;
            }

            // Signed secant step `step = (residual · db) / dk`, computed
            // over magnitudes with a 512-bit `fullMulDiv` so the
            // `residual · db` product can never overflow on large pools
            // (the quotient always fits; the naive `int256` product
            // reverts once |residual·db| ≥ 2²⁵⁵, which is reachable below
            // the uint128 reserve cap). Sign is tracked separately. This
            // mirrors the Rust reference `solve_counterpart` bit-for-bit
            // (`mul_div_floor` over magnitudes + boolean sign XOR), so
            // the parity suite stays green and large pools no longer DoS.
            // Scoped: keeps the frame within the 16-slot legacy-codegen
            // stack limit (coverage builds compile without viaIR).
            uint256 b3u;
            {
                bool dkPos = k2 >= k1;
                bool dbPos = b2 >= b1;
                uint256 dkMag;
                uint256 dbMag;
                unchecked {
                    dkMag = dkPos ? k2 - k1 : k1 - k2;
                    dbMag = dbPos ? b2 - b1 : b1 - b2;
                }
                if (dkMag == 0) return (b2, i + 1);

                uint256 stepMag = FixedPointMathLib.fullMulDiv(residMag, dbMag, dkMag);
                // sign(step) = sign(residual·db) ⊕ sign(1/dk)
                //            = (residPos == dbPos) ⊕ (!dkPos)
                bool stepPos = (residPos == dbPos) != (!dkPos);

                // b3 = b2 − step, clamped to ≥ 1 on underflow.
                if (stepPos) {
                    b3u = b2 > stepMag ? b2 - stepMag : 1;
                } else {
                    b3u = b2 + stepMag;
                }
            }
            if (b3u == b2) return (b2, i + 1);
            b1 = b2;
            k1 = k2;
            b2 = b3u;
        }
        return (bBest, _MAX_SECANT_ITER);
    }

    // =========================================================================
    // 9. CP-proxy distance predictor (dynamic-fee resolver)
    // =========================================================================

    /// @notice Predict the post-swap math-space distance `D_post` for
    ///         an exact-in trade using a constant-product proxy.
    /// @dev    Used by the pool's exact-in dynamic-fee resolver to set
    ///         the fee rate BEFORE running the actual cubic. The proxy is
    ///         intentionally cheap, and it can diverge from the true
    ///         cubic post-state distance in EITHER direction: it tends
    ///         to *under*-state the distance on plateau / imbalance-
    ///         increasing trades (the cubic's plateau holds the state
    ///         closer to balance than constant product predicts, but a
    ///         D-increasing trade also moves further per unit of input),
    ///         so the resolved fee can sit below the true-distance fee
    ///         by a double-digit share of the dynamic range on large
    ///         (≥5% of reserves) swaps. The gross-vs-clean input bias
    ///         (~2·fee relative) only partially compensates — the
    ///         net bias is NOT guaranteed to favour LPs. Bounded
    ///         consequences: the resolved rate always stays in
    ///         `[feeFloor, baseFee]`, quote == swap holds, and the
    ///         exact-out identity is unaffected; the cost is
    ///         under-collected LP premium on exactly the large trades
    ///         the ramp targets. See the math audit, finding L-1
    ///         (accepted).
    ///
    ///         Returns 0 when the proxy lands at the diagonal
    ///         (`yProxy == xPost`) or any reserve is zero.
    function predictPostDistanceCp(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMathGross
    ) internal pure returns (uint256 distPostWad) {
        if (xMath == 0 || yMath == 0 || dxMathGross == 0) return 0;
        uint256 xPost = xMath + dxMathGross;
        uint256 nPre = FixedPointMathLib.mulWad(xMath, yMath);
        if (nPre == 0) return 0;
        // yProxy = N_pre · WAD / xPost (single mulDiv keeps single-WAD scale)
        uint256 yProxy = FixedPointMathLib.mulDiv(xMath, yMath, xPost);
        if (yProxy == 0 || yProxy == xPost) return 0;

        uint256 diff;
        unchecked {
            diff = yProxy > xPost ? yProxy - xPost : xPost - yProxy;
        }
        uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
        uint256 denomWad = FixedPointMathLib.mulWad(xPost, yProxy);
        if (denomWad == 0) return 0;
        distPostWad = FixedPointMathLib.divWad(diffSqWad, denomWad);
    }

    // =========================================================================
    // 10. Smoothstep dynamic-fee ramp
    // =========================================================================

    /// @notice Smoothstep dynamic-fee ramp: the WAD-scale fee rate
    ///         climbs from `floorWad` to `feeCeilingWad` via
    ///         `m(r) = 2r − r²` with `r = distPostWad / rampDistWad`.
    /// @dev    Shape is C¹-continuous (`m'(0) = 2`, `m'(1) = 0`).
    ///         Rates are WAD fractions (`1 bps == 1e14`); resolving at
    ///         WAD rather than integer-bps precision keeps the
    ///         gross → clean-input map monotone up to a dust residual
    ///         on the order of `gross / 1e18` wei per rate step (the
    ///         inputs `distPostWad` and `r` are WAD-quantized too, so
    ///         one input wei can cross several rate ulps at once).
    ///         Disabled paths return `feeCeilingWad`
    ///         unchanged:
    ///           • `rampDistWad == 0`        — pool opted out of ramp
    ///           • `feeCeilingWad <= floor`  — ceiling not strictly
    ///                                          above floor
    ///           • `distPostWad >= ramp`     — saturated
    ///
    ///         **Splittable by design (accepted).** The fee is a function
    ///         of the *instantaneous* post-swap distance, charged on each
    ///         leg's own input, so it is **marginal**, not cumulative: a
    ///         directional trade split into N legs pays the area under the
    ///         rising `f(D)` curve, whereas one swap of the same notional
    ///         pays the rectangle `f(D_final)·total ≥ that area`. Splitting
    ///         is therefore strictly cheaper (≈ 30–40 % of the dynamic
    ///         premium at ~32 legs). This is inherent to any
    ///         instantaneous-state fee and is NOT an LP
    ///         drain — the per-leg integral is the marginal-cost-fair
    ///         charge, while a single swap merely over-charges the early
    ///         units; the only consistent non-splittable fee is that same
    ///         integral, which would lower fees for everyone. The behaviour
    ///         is pinned by `test/security/DynamicFeeSplittability.test.ts`.
    function smoothstepFeeWad(
        uint256 distPostWad,
        uint256 rampDistWad,
        uint256 floorWad,
        uint256 feeCeilingWad
    ) internal pure returns (uint256 feeWad) {
        if (rampDistWad == 0 || feeCeilingWad <= floorWad) {
            return feeCeilingWad;
        }
        if (distPostWad >= rampDistWad) {
            return feeCeilingWad;
        }
        unchecked {
            uint256 r = (distPostWad * Constants.WAD) / rampDistWad;
            uint256 r2 = (r * r) / Constants.WAD;
            uint256 m = 2 * r - r2;
            feeWad = floorWad + ((feeCeilingWad - floorWad) * m) / Constants.WAD;
        }
    }

    // =========================================================================
    // 11. V3-compat (sqrtPriceX96 ↔ math-space marginal price)
    // =========================================================================

    /// @notice Convert a V3 `sqrtPriceX96` (Q64.96 of
    ///         `sqrt(token1/token0)`) into the math-space marginal
    ///         price `pMargMath` in WAD scale.
    /// @dev    The conversion sits purely in the coordinate-change
    ///         layer and is independent of the invariant: spot price
    ///         in raw token units is recovered from the Q64.96 sqrt,
    ///         then divided by `priceScale` to project onto the
    ///         math-space axis where the anchor sits at `WAD`.
    ///
    ///         Total over the whole canonical sqrt-ratio domain
    ///         `[MIN_SQRT_RATIO, MAX_SQRT_RATIO)`: both poles saturate
    ///         instead of degenerating, so a caller naming a domain
    ///         endpoint gets a usable extreme price rather than a
    ///         revert or an ambiguous zero. Saturation is lossy —
    ///         every input below `2^48` returns the same maximal price,
    ///         and inputs past the representable top return `1` wei —
    ///         but the whole saturated band lies orders of magnitude
    ///         beyond any reachable pool state, so every value in it
    ///         resolves to the same answer downstream. Accuracy in the
    ///         operating range is unaffected (relative error tracks
    ///         `(2^48 / sqrtPriceX96)²`). The inverse saturates at the
    ///         matching poles, keeping the pair symmetric.
    function sqrtPriceX96ToMathPriceWad(
        uint160 sqrtPriceX96,
        uint256 priceScaleWad,
        uint256 token0Scale,
        uint256 token1Scale
    ) internal pure returns (uint256 pMargWad) {
        if (priceScaleWad == 0) revert Errors.InvalidPriceScale();
        if (token1Scale == 0) revert Errors.MathInvariantViolation();
        if (sqrtPriceX96 == 0) revert Errors.MathInvariantViolation();
        uint256 sp = uint256(sqrtPriceX96);
        uint256 priceQ96 = FixedPointMathLib.fullMulDiv(sp, sp, 1 << 96);
        // Saturate instead of failing at the low pole: `sqrtPriceX96 <
        // 2^48` squares below the Q96 unit, so the quotient floors to
        // zero. Pinning it to the smallest representable Q96 price maps
        // that whole band to the largest representable math price —
        // the intent of a caller naming a sub-representable target.
        assembly ("memory-safe") {
            priceQ96 := or(priceQ96, iszero(priceQ96))
        }

        // pMargWad = WAD² · t0Scale · 2^96 / (priceQ96 · t1Scale · priceScale)
        //          = (WAD_SQ_X96 / priceQ96) · t0Scale / t1Scale / priceScale
        uint256 num = Constants.WAD_SQ_X96 / priceQ96;
        uint256 stage = FixedPointMathLib.fullMulDiv(num, token0Scale, token1Scale);
        pMargWad = stage / priceScaleWad;
        // Mirror at the high pole: a target far above the representable
        // range floors the cascade to zero, which callers cannot tell
        // apart from "no admissible quote". One wei keeps it a price.
        assembly ("memory-safe") {
            pMargWad := or(pMargWad, iszero(pMargWad))
        }
    }

    /// @notice Inverse of `sqrtPriceX96ToMathPriceWad`.
    /// @dev    The Q64.96 lift is applied BEFORE the scale-ratio
    ///         division so no precision is lost to early flooring
    ///         (audit L-10): the previous order floored
    ///         `numWad · t0Scale / t1Scale` first, costing ~1e-6
    ///         relative error on 18/6-decimals pairs and collapsing
    ///         to 0 on 18/0 pairs. `fullMulDiv`'s 512-bit intermediate
    ///         absorbs the lifted magnitudes.
    ///
    ///         The output is clamped into the canonical V3 sqrt-ratio
    ///         domain `[MIN_SQRT_RATIO, MAX_SQRT_RATIO − 1]` (audit
    ///         L-11) so TickMath-style consumers never revert on an
    ///         extreme state; `pMargMathWad == 0` (infinite price)
    ///         saturates at the upper clamp.
    function mathPriceToSqrtPriceX96(
        uint256 pMargMathWad,
        uint256 priceScaleWad,
        uint256 token0Scale,
        uint256 token1Scale
    ) internal pure returns (uint160 sqrtPriceX96) {
        if (priceScaleWad == 0 || token1Scale == 0) revert Errors.InvalidPriceScale();
        if (pMargMathWad == 0) return Constants.MAX_SQRT_RATIO_MINUS_ONE;
        uint256 numWad = FixedPointMathLib.fullMulDiv(Constants.WAD, Constants.WAD, pMargMathWad);
        uint256 priceQ96 = FixedPointMathLib.fullMulDiv(numWad, 1 << 96, priceScaleWad);
        priceQ96 = FixedPointMathLib.fullMulDiv(priceQ96, token0Scale, token1Scale);
        uint256 sqrtPrice = FixedPointMathLib.sqrt(priceQ96) << 48;
        if (sqrtPrice < Constants.MIN_SQRT_RATIO) return Constants.MIN_SQRT_RATIO;
        if (sqrtPrice > Constants.MAX_SQRT_RATIO_MINUS_ONE) {
            return Constants.MAX_SQRT_RATIO_MINUS_ONE;
        }
        sqrtPriceX96 = uint160(sqrtPrice);
    }
}
