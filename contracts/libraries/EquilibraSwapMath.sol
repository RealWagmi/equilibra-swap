// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { Constants } from "./Constants.sol";
import { Errors } from "./Errors.sol";

/**
 * @title EquilibraSwapMath
 * @notice Math kernel of the Equilibra AMM: a single-piece cubic invariant with two independent
 * concentration knobs over asymmetric (quote-side normalised) math-space coordinates.
 * @dev Coordinate change: `priceScaleWad = yWad / xWad` at the anchor (quote per base),
 * `xMath = xWad` and `yMath = yWad * WAD / priceScaleWad`, so the anchor state lies on the
 * diagonal `yMath == xMath`. A repeg moves `yMath` only, which gives the pool's LP-value gate a
 * real IL signal on imbalanced reserves.
 * Invariant: `K(x, y; L) = A * L * (x + y) / 2 + (W - A) * x * y` with
 * `D = (y - x)^2 / (x * y)`, `A = a * W / (W + lambda * D)` and `W = WAD`. `K` is cubic in `y`
 * at fixed `x` after clearing denominators, so the secant solver works on a well-conditioned
 * envelope.
 * Knobs: `a` is the depth at the anchor (`A(0) = a`, range `[A_MIN_WAD, A_MAX_WAD]`; `a == W`
 * is excluded because the central price slope vanishes) and `lambda` is the plateau width
 * (`A = a / 2` at `lambda * D = W`, range `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`). The knobs are
 * independent.
 * Depth: at the balance state `x = y = L_eq`, `K = W * L_eq^2`. For any state the depth is the
 * positive root of `W * L^2 - A * L * S - (W - A) * N = 0` with `S = (x + y) / 2` and
 * `N = x * y`. Every point of a level set recovers the same `L`, so the solver freezes `L` at
 * the pre-state value.
 * LP unit value: `vp = 2 * L_eq * sqrt(priceScale * WAD) / totalSupply`; the square-root factor
 * keeps `vp` comparable across repegs.
 */
library EquilibraSwapMath {
    uint256 internal constant Q128 = uint256(1) << 128;

    /**
     * @dev Quote K carries 18 extra fractional bits (`WAD * 2^18`); external K diagnostics stay
     * WAD.
     */
    uint256 internal constant QUOTE_K_EXTRA_BITS = 18;

    /**
     * @dev Secant iteration cap; exhaustion requires certification of the best candidate.
     */
    uint256 private constant _MAX_SECANT_ITER = 40;
    /**
     * @dev Cap-certification tolerance: `1 / (denominator - 1)` of the quoted amount (0.0001%).
     */
    uint256 private constant _CAP_QUOTE_EPSILON_DENOM = 1000001;
    /**
     * @dev Output-margin rate: every positive quote loses `max(1, amount / denominator)` math
     * units (0.000001%).
     */
    uint256 private constant _QUOTE_MARGIN_DENOM = 100000000;

    /**
     * @notice Secant solver state: the fixed post-swap axis, the quote-K target, the curve
     * parameters, the frozen Q128 depth, the pre-state value of the solved axis and the
     * direction flag.
     */
    struct SolverContext {
        uint256 fixedAxis;
        uint256 target;
        uint256 a;
        uint256 lambda;
        uint256 depth;
        uint256 previous;
        bool exactOut;
    }

    // =========================================================================
    // 1. Amplification A = a·W / (W + λ·D)
    // =========================================================================

    /**
     * @dev Amplification `A = a * W / (W + lambda * D)` and its denominator, returned together so
     * the marginal-price derivative chain (`A * lambda / denom`) pays for the denominator once.
     * `D = 0` gives `A = a`; `lambda * D = W` gives `A = a / 2`; `A -> 0` as `D -> inf`. With
     * `a <= A_MAX_WAD < W`, `A < W` strictly, so the tail weight `(W - A)` never vanishes.
     */
    function _amplification(
        uint256 aWad,
        uint256 lambdaWad,
        uint256 distWad
    ) private pure returns (uint256 ampWad, uint256 denomWad) {
        uint256 lambdaDWad = FixedPointMathLib.mulWad(lambdaWad, distWad);
        denomWad = Constants.WAD + lambdaDWad;
        ampWad = FixedPointMathLib.mulDiv(aWad, Constants.WAD, denomWad);
    }

    // =========================================================================
    // 2. Depth scale L
    // =========================================================================

    /**
     * @notice Positive depth root in Q128; reserves and parameters stay WAD.
     * @dev Normalised by `R = max(x, y)`, `t = min(x, y) / R` and `theta = A / W`:
     * `L / R = theta * (1 + t) / 4 + sqrt((theta * (1 + t) / 4)^2 + (1 - theta) * t)`. The
     * normalised radicand fits uint256. Coordinates keep Q128 relative precision, not a uniform
     * absolute-error bound: at extreme ratios `t` can round to zero. The amplification weight
     * shares the quote kernel's WAD fallback; the returned depth stays Q128. Positive states
     * require `x * y <= uint256.max` and `|x - y| < 2^128`, the diagonal shortcut included;
     * otherwise reverts `MathOutOfRange`, which is not an LP-budget refusal.
     * @param xMath Base-side math coordinate, WAD.
     * @param yMath Quote-side math coordinate, WAD.
     * @param aWad Depth-at-anchor knob, WAD.
     * @param lambdaWad Plateau-width knob, WAD.
     * @return lQ128 Depth, Q128; zero when either coordinate is zero.
     */
    function solveLFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 lQ128) {
        if (xMath == 0 || yMath == 0) return 0;
        if (xMath == yMath) {
            if (xMath >= Q128) revert Errors.MathOutOfRange();
            return FixedPointMathLib.fullMulDiv(xMath, Q128, Constants.WAD);
        }
        uint256 r = xMath > yMath ? xMath : yMath;
        uint256 t = FixedPointMathLib.fullMulDiv(xMath > yMath ? yMath : xMath, Q128, r);
        (uint256 theta, uint256 precision) = _tightWeightBound(
            xMath,
            yMath,
            aWad,
            lambdaWad,
            false
        );
        if (precision != Q128) theta = FixedPointMathLib.fullMulDiv(theta, Q128, precision);
        uint256 head = FixedPointMathLib.fullMulDivN(theta, Q128 + t, 130);
        uint256 ratio = head + FixedPointMathLib.sqrt(head * head + (Q128 - theta) * t);
        lQ128 = FixedPointMathLib.fullMulDiv(r, ratio, Constants.WAD);
    }

    // =========================================================================
    // 3. LP unit value (price-scale-aware)
    // =========================================================================

    /**
     * @notice Per-share LP value `vp = 2 * L_eq * sqrt(priceScale) / supply`, WAD.
     * @dev Depth is Q128; price scale and supply are WAD. The anchor normaliser puts values
     * before and after a repeg on the same basis: both `L_eq` and `sqrt(priceScale)` change
     * during a repeg and neither factor alone measures its cost. Returns zero when any input is
     * zero.
     * @param lEqQ128 Balanced depth, Q128.
     * @param priceScaleWad Anchor, WAD.
     * @param totalSupplyWad LP supply, WAD.
     * @return unitValueWad LP unit value, WAD.
     */
    function computeLpUnitValueWad(
        uint256 lEqQ128,
        uint256 priceScaleWad,
        uint256 totalSupplyWad
    ) internal pure returns (uint256 unitValueWad) {
        if (totalSupplyWad == 0 || lEqQ128 == 0 || priceScaleWad == 0) {
            return 0;
        }
        // sqrtWad(x) = sqrt(x * WAD): the WAD square root of a WAD quantity.
        uint256 sqrtPsWad = FixedPointMathLib.sqrtWad(priceScaleWad);
        uint256 depthPerShareQ128 = FixedPointMathLib.fullMulDiv(
            lEqQ128,
            2 * Constants.WAD,
            totalSupplyWad
        );
        unitValueWad = FixedPointMathLib.fullMulDivN(depthPerShareQ128, sqrtPsWad, 128);
    }

    // =========================================================================
    // 4. Marginal price (analytic, math-space, n = 1)
    // =========================================================================

    /**
     * @notice Math-space marginal price `pMarg = dK/dxMath / dK/dyMath` at `(xMath, yMath)` with
     * frozen depth `L`, WAD; exactly `WAD` on the diagonal.
     * @dev With `A = a * W / (W + lambda * D)`:
     * `dK/dx = (dA/dx) * (L * S - N) + A * L / 2 + (W - A) * y`, and symmetrically for `y`.
     * Symmetry of `D` gives `x * dA/dx = -y * dA/dy`, so one sign decision
     * (`sign(yMath - xMath)`) suffices. With `tau = (x * dA/dx) * (L * S - N)`:
     * `x * dK/dx = tau + baseX`, `y * dK/dy = -tau + baseY`,
     * `baseX = A * L * x / 2 + (W - A) * N`, `baseY = A * L * y / 2 + (W - A) * N` and
     * `pMarg = (y * xKx) / (x * yKy)`. The subtractive branch is positive for every admissible
     * `(a, lambda)`; an underflow there reverts `MathInvariantViolation`. Coordinates at or above
     * `2^125` cancel `x` before the final ratio so the WAD-scaled derivative products stay inside
     * uint256. Reverts `InsufficientLiquidity` on a zero coordinate or, off the diagonal, a zero
     * depth.
     * @param xMath Base-side math coordinate, WAD.
     * @param yMath Quote-side math coordinate, WAD.
     * @param lQ128 Frozen depth, Q128.
     * @param aWad Depth-at-anchor knob, WAD.
     * @param lambdaWad Plateau-width knob, WAD.
     * @return pMargMathWad Marginal price, WAD.
     */
    function marginalPrice(
        uint256 xMath,
        uint256 yMath,
        uint256 lQ128,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 pMargMathWad) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        // Diagonal: D = 0, so pMarg = WAD exactly.
        if (xMath == yMath) return Constants.WAD;
        if (lQ128 == 0) revert Errors.InsufficientLiquidity();

        (uint256 xKx, uint256 yKy) = _marginalPriceParts(xMath, yMath, lQ128, aWad, lambdaWad);

        if (yKy == 0) revert Errors.DegenerateMarginalPrice();

        // Cancel xMath first when WAD-scaled derivative products could overflow; ordinary
        // magnitudes keep the established rounding order.
        if (xMath >= (uint256(1) << 125) || yMath >= (uint256(1) << 125)) {
            uint256 intermediate = FixedPointMathLib.fullMulDiv(yMath, xKx, xMath);
            return FixedPointMathLib.fullMulDiv(intermediate, Constants.WAD, yKy);
        }
        // pMarg = (yMath · xKx) / (xMath · yKy)
        uint256 num = FixedPointMathLib.fullMulDiv(yMath, xKx, Constants.WAD);
        uint256 den = FixedPointMathLib.fullMulDiv(xMath, yKy, Constants.WAD);
        pMargMathWad = FixedPointMathLib.fullMulDiv(num, Constants.WAD, den);
    }

    /**
     * @dev The two numerators `(x * dK/dx, y * dK/dy)` of the marginal-price ratio, split out of
     * `marginalPrice` to keep its stack under the 16-slot limit on legacy builds. Preconditions:
     * `xMath != yMath`, both positive, `lQ128 > 0`. Reverts `MathInvariantViolation` when a
     * subtractive branch would underflow.
     */
    function _marginalPriceParts(
        uint256 xMath,
        uint256 yMath,
        uint256 lQ128,
        uint256 aWad,
        uint256 lambdaWad
    ) private pure returns (uint256 xKx, uint256 yKy) {
        // nWad is returned because the tau helper needs it again.
        (uint256 prefactor, uint256 baseX, uint256 baseY, uint256 nWad) = _marginalPriceAmpSide(
            xMath,
            yMath,
            lQ128,
            aWad,
            lambdaWad
        );

        (uint256 absTau, bool tauPositive) = _marginalPriceTau(
            prefactor,
            lQ128,
            xMath,
            yMath,
            nWad
        );

        // x·∂K/∂x = τ + base_x, y·∂K/∂y = −τ + base_y
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

    /**
     * @dev Amplification-side quantities of the marginal-price formula, computed together to keep
     * `_marginalPriceParts` shallow on the stack: `prefactor = A * lambda / denom`,
     * `baseX = A * L * x / 2 + (W - A) * N`, `baseY = A * L * y / 2 + (W - A) * N` and
     * `nWad = x * y / W`. Reverts `MathInvariantViolation` when `nWad` rounds to zero.
     */
    function _marginalPriceAmpSide(
        uint256 xMath,
        uint256 yMath,
        uint256 lQ128,
        uint256 aWad,
        uint256 lambdaWad
    ) private pure returns (uint256 prefactor, uint256 baseX, uint256 baseY, uint256 nWad) {
        nWad = FixedPointMathLib.mulWad(xMath, yMath);
        if (nWad == 0) revert Errors.MathInvariantViolation();

        uint256 distWad = _distState(xMath, yMath, nWad);
        (uint256 ampWad, uint256 denomWad) = _amplification(aWad, lambdaWad, distWad);

        (baseX, baseY) = _marginalPriceBases(ampWad, lQ128, xMath, yMath, nWad);
        prefactor = FixedPointMathLib.mulDiv(ampWad, lambdaWad, denomWad);
    }

    /**
     * @dev State distance `D = (yMath - xMath)^2 / (xMath * yMath)` in WAD, with
     * `nWad = xMath * yMath / W` supplied by the caller.
     */
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

    /**
     * @dev Off-diagonal term `tau = (x * dA/dx) * (L * S - N)` as magnitude and sign, with
     * `prefactor = A * lambda / denom` supplied by the caller to stay under the legacy stack
     * limit. `|x * dA/dx| = prefactor * |y - x| * (x + y) / N`, and
     * `sign(tau) = sign(x * dA/dx) * sign(L * S - N)` collapses to an equality of the two flags.
     */
    function _marginalPriceTau(
        uint256 prefactor,
        uint256 lQ128,
        uint256 xMath,
        uint256 yMath,
        uint256 nWad
    ) private pure returns (uint256 absTau, bool tauPositive) {
        uint256 sumXY = xMath + yMath;

        // Paired fullMulDiv keeps the intermediates inside 256 bits.
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
        uint256 lsWad = FixedPointMathLib.fullMulDivN(lQ128, sumXY, 129);
        bool hPositive = lsWad >= nWad;
        uint256 absH;
        unchecked {
            absH = hPositive ? lsWad - nWad : nWad - lsWad;
        }

        absTau = FixedPointMathLib.mulWad(absXdAdxWad, absH);
        tauPositive = (yMath > xMath) == hPositive;
    }

    /**
     * @dev Diagonal base terms `baseX = A * L * x / 2 + (W - A) * N` and
     * `baseY = A * L * y / 2 + (W - A) * N`, sharing the `alHalf` and `tailWad` factors.
     */
    function _marginalPriceBases(
        uint256 ampWad,
        uint256 lQ128,
        uint256 xMath,
        uint256 yMath,
        uint256 nWad
    ) private pure returns (uint256 baseX, uint256 baseY) {
        uint256 alHalf = FixedPointMathLib.fullMulDiv(ampWad, lQ128, 2 * Constants.WAD);
        uint256 wMinusA;
        unchecked {
            wMinusA = Constants.WAD - ampWad;
        }
        uint256 tailWad = FixedPointMathLib.mulWad(wMinusA, nWad);
        baseX = FixedPointMathLib.fullMulDivN(alHalf, xMath, 128) + tailWad;
        baseY = FixedPointMathLib.fullMulDivN(alHalf, yMath, 128) + tailWad;
    }

    /**
     * @notice Marginal price with freshly recovered depth; call `marginalPrice` directly when the
     * Q128 depth is already available.
     * @param xMath Base-side math coordinate, WAD.
     * @param yMath Quote-side math coordinate, WAD.
     * @param aWad Depth-at-anchor knob, WAD.
     * @param lambdaWad Plateau-width knob, WAD.
     * @return pMargMathWad Marginal price, WAD.
     */
    function marginalPriceFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 pMargMathWad) {
        uint256 lQ128 = solveLFromState(xMath, yMath, aWad, lambdaWad);
        pMargMathWad = marginalPrice(xMath, yMath, lQ128, aWad, lambdaWad);
    }

    // =========================================================================
    // 5. Swap quotes (secant against frozen-L cubic K)
    // =========================================================================

    /**
     * @notice Exact-input quote: the y-side output `dyMath` for an x-side deposit `dxMath` that
     * conserves `K` at the frozen pre-state depth.
     * @dev `kTarget = computeQuoteKFromL(xMath, yMath, lPreQ128)` is the same evaluation the
     * secant uses, so the residual matches bit-for-bit. The counterpart search starts from the
     * curve-aware seed, runs at most `_MAX_SECANT_ITER` iterations and certifies the best
     * residual at the cap or reverts `SolverDidNotConverge`. A terminal iterate on the wrong side
     * of the pre-state (`yPost > yMath`) returns `dyMath = 0`: a fail-closed refusal that the
     * callers' dust guards reject, not a claim that the true output is zero. Reverts
     * `InsufficientLiquidity` on a zero coordinate, depth or target and `ZeroAmount` on a zero
     * input.
     * @param xMath Pre-state input-side coordinate, WAD.
     * @param yMath Pre-state output-side coordinate, WAD.
     * @param dxMath Input, WAD math units.
     * @param aWad Depth-at-anchor knob, WAD.
     * @param lambdaWad Plateau-width knob, WAD.
     * @param lPreQ128 Pre-state depth from `solveLFromState`, Q128.
     * @return dyMath Output after the output margin, WAD math units.
     * @return iters Secant iterations used.
     */
    function quoteExactInForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPreQ128
    ) internal pure returns (uint256 dyMath, uint256 iters) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dxMath == 0) revert Errors.ZeroAmount();

        uint256 kTarget = computeQuoteKFromL(xMath, yMath, lPreQ128, aWad, lambdaWad);
        if (lPreQ128 == 0 || kTarget == 0) revert Errors.InsufficientLiquidity();

        return _quoteExactInBody(xMath, yMath, dxMath, aWad, lambdaWad, lPreQ128, kTarget);
    }

    /**
     * @dev Secant setup of `quoteExactInForward`: CP seed `xMath * yMath / xPost` (at least 1),
     * then `_solveCounterpart` on the fixed axis `xPost`.
     */
    function _quoteExactInBody(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPreQ128,
        uint256 kTarget
    ) private pure returns (uint256 dyMath, uint256 iters) {
        uint256 xPost = xMath + dxMath;

        // CP seed: yPost ≈ xMath · yMath / xPost
        uint256 ySeed = FixedPointMathLib.mulDiv(xMath, yMath, xPost);
        assembly ("memory-safe") {
            ySeed := or(ySeed, iszero(ySeed))
        }

        SolverContext memory c;
        c.fixedAxis = xPost;
        c.previous = yMath;
        c.exactOut = false;
        c.target = kTarget;
        c.a = aWad;
        c.lambda = lambdaWad;
        c.depth = lPreQ128;
        (uint256 yPost, uint256 used) = _solveCounterpart(ySeed, c);

        if (yPost > yMath) {
            // Wrong-side terminal iterate: no admissible discrete quote. Fail closed with the
            // zero-output sentinel, which the callers' zero-raw-output guard rejects.
            return (0, used);
        }
        unchecked {
            dyMath = yMath - yPost;
        }
        iters = used;
    }

    /**
     * @notice Exact-output quote: the x-side input `dxMath` that pays the y-side output `dyMath`
     * while conserving `K` at the frozen pre-state depth.
     * @dev Mirror of `quoteExactInForward`. The trial output is enlarged to
     * `dyMath + max(1, dyMath / (_QUOTE_MARGIN_DENOM - 1))`, the integer inverse of the exact-in
     * output margin, so no input surcharge follows. A wrong-side terminal iterate
     * (`xPost < xMath`) returns `dxMath = 0`, rejected by the callers' zero-input guard. Reverts
     * `InsufficientLiquidity` when the requested or trial output reaches the reserve or on a
     * zero coordinate, depth or target, and `ZeroAmount` on a zero output.
     * @param xMath Pre-state input-side coordinate, WAD.
     * @param yMath Pre-state output-side coordinate, WAD.
     * @param dyMath Requested output, WAD math units.
     * @param aWad Depth-at-anchor knob, WAD.
     * @param lambdaWad Plateau-width knob, WAD.
     * @param lPreQ128 Pre-state depth from `solveLFromState`, Q128.
     * @return dxMath Required input, WAD math units.
     * @return iters Secant iterations used.
     */
    function quoteExactOutForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPreQ128
    ) internal pure returns (uint256 dxMath, uint256 iters) {
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dyMath == 0) revert Errors.ZeroAmount();
        if (dyMath >= yMath) revert Errors.InsufficientLiquidity();

        uint256 kTarget = computeQuoteKFromL(xMath, yMath, lPreQ128, aWad, lambdaWad);
        if (lPreQ128 == 0 || kTarget == 0) revert Errors.InsufficientLiquidity();

        return _quoteExactOutBody(xMath, yMath, dyMath, aWad, lambdaWad, lPreQ128, kTarget);
    }

    /**
     * @dev Secant setup of `quoteExactOutForward`: enlarge the trial output by the inverse
     * margin, seed with the CP estimate `xMath * yMath / yPost` (strictly above `xMath`) and
     * solve on the fixed axis `yPost`; the kernel is symmetric in `(x, y)`.
     */
    function _quoteExactOutBody(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 lPreQ128,
        uint256 kTarget
    ) private pure returns (uint256 dxMath, uint256 iters) {
        uint256 yPost = yMath - dyMath;
        // Upper integer inverse of u - max(1, floor(u / D)): the increased
        // trial output maps back to exactly dyMath after the output margin.
        uint256 margin = dyMath / (_QUOTE_MARGIN_DENOM - 1);
        assembly ("memory-safe") {
            margin := or(margin, iszero(margin))
        }
        if (margin >= yPost) revert Errors.InsufficientLiquidity();
        yPost -= margin;

        uint256 xSeed = FixedPointMathLib.mulDiv(xMath, yMath, yPost);
        if (xSeed <= xMath) xSeed = xMath + 1;

        SolverContext memory c;
        c.fixedAxis = yPost;
        c.previous = xMath;
        c.exactOut = true;
        c.target = kTarget;
        c.a = aWad;
        c.lambda = lambdaWad;
        c.depth = lPreQ128;
        (uint256 xPost, uint256 used) = _solveCounterpart(xSeed, c);

        if (xPost < xMath) {
            // Wrong-side terminal iterate on the input axis: no admissible discrete quote. Fail
            // closed with the zero-input sentinel, which the callers' `cleanInRaw == 0` guard
            // rejects, so a zero-input settlement can never happen.
            return (0, used);
        }
        unchecked {
            dxMath = xPost - xMath;
        }
        iters = used;
    }

    /**
     * @dev Curve-aware initial guess; the counterpart solver and the native settlement checks
     * decide acceptance. Freezes `theta` at the CP point and solves the linear-in-b envelope,
     * flooring that estimate at `cp / 1000` to limit cancellation near zero; when the envelope
     * has no positive root, uses the `b << s` tail of the invariant. Falls back to `cp` when an
     * operand exceeds uint128 or the tail denominator is not positive.
     */
    function _curveSeed(uint256 cp, SolverContext memory c) private pure returns (uint256) {
        uint256 s = c.fixedAxis;
        uint256 halfL = FixedPointMathLib.fullMulDivN(c.depth, Constants.WAD, 129);
        uint256 kOverS = FixedPointMathLib.fullMulDiv(
            c.target,
            Constants.WAD >> QUOTE_K_EXTRA_BITS,
            s
        );
        // This bounds only the inexpensive initializer, never an accepted swap.
        if (s > type(uint128).max || halfL > type(uint128).max || kOverS > type(uint128).max)
            return cp;
        (uint256 theta, uint256 precision) = _tightWeightBound(s, cp, c.a, c.lambda, false);
        uint256 head = FixedPointMathLib.mulDiv(theta, halfL, precision);
        uint256 numerator;
        uint256 denominator;
        if (kOverS > head) {
            unchecked {
                numerator = kOverS - head;
            }
            denominator = FixedPointMathLib.mulDiv(precision - theta, s, precision) + head;
        } else {
            // b ~= lambda*K / (a*L/2 + lambda*s - (1-2*lambda)*K/s).
            numerator = FixedPointMathLib.mulDiv(c.lambda, kOverS, Constants.WAD);
            denominator =
                FixedPointMathLib.mulDiv(c.a, halfL, Constants.WAD) +
                FixedPointMathLib.mulDiv(c.lambda, s, Constants.WAD) +
                2 *
                numerator;
            if (denominator <= kOverS) return cp;
            denominator -= kOverS;
        }
        if (denominator == 0) return cp;
        uint256 seed = FixedPointMathLib.mulDiv(s, numerator, denominator);
        assembly ("memory-safe") {
            seed := or(seed, iszero(seed))
        }
        if (kOverS > head) {
            uint256 floor = cp / 1000;
            if (seed < floor) return floor;
        }
        return seed;
    }

    /**
     * @dev Solve at frozen depth and apply the single output-side margin
     * (`max(1, output / _QUOTE_MARGIN_DENOM)` math units) to a positive exact-in output.
     * Exact-out already enlarged its trial output and needs no input surcharge; nonpositive
     * quotes keep their zero sentinel.
     */
    function _solveCounterpart(
        uint256 bSeed,
        SolverContext memory c
    ) private pure returns (uint256 b, uint256 iters) {
        (b, iters) = _solveUnadjustedCounterpart(bSeed, c);
        if (!c.exactOut && b < c.previous) {
            b += _quoteEpsilon(c, b, _QUOTE_MARGIN_DENOM);
        }
    }

    /**
     * @dev Secant on the Q128-weight quote invariant at frozen depth. Equal-K and
     * unchanged-counterpart exits apply at every iteration; a proposed nonpositive counterpart
     * takes the half-step `b / 2 + 1`. At the iteration cap the best-residual iterate is
     * certified once at `_CAP_QUOTE_EPSILON_DENOM` (0.0001%) and an unconfirmed candidate reverts
     * `SolverDidNotConverge`. Integer exits alone do not prove exact agreement with the
     * continuous invariant; the caller applies the margin, the native bounds and the LP-depth
     * guard.
     */
    function _solveUnadjustedCounterpart(
        uint256 bSeed,
        SolverContext memory c
    ) private pure returns (uint256 b, uint256 iters) {
        bSeed = _curveSeed(bSeed, c);
        uint256 b1 = bSeed;
        uint256 b2;
        {
            uint256 step = bSeed / 1000;
            assembly ("memory-safe") {
                step := or(step, iszero(step))
            }
            b2 = bSeed > step ? bSeed - step : bSeed + step;
            // A lower point reduces the product, but can increase |fixed-b|.
            // At that opposite square boundary retain the original upper side.
            if (c.fixedAxis >= Q128 && b2 <= c.fixedAxis - Q128) b2 = bSeed + step;
        }
        uint256 k1 = _solverK(c, b1);
        uint256 kBest = k1;
        uint256 bBest = b1;
        uint256 residualAbsBest = k1 >= c.target ? k1 - c.target : c.target - k1;

        for (; iters < _MAX_SECANT_ITER; ) {
            ++iters;
            uint256 k2 = _solverK(c, b2);
            if (k2 == c.target) return (b2, iters);

            bool residPos = k2 >= c.target;
            uint256 residMag;
            unchecked {
                residMag = residPos ? k2 - c.target : c.target - k2;
            }
            if (residMag < residualAbsBest) {
                bBest = b2;
                residualAbsBest = residMag;
                kBest = k2;
            }

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
                if (dkMag == 0) {
                    b3u = b2;
                } else {
                    uint256 stepMag = FixedPointMathLib.fullMulDiv(residMag, dbMag, dkMag);
                    bool stepPos = (residPos == dbPos) != (!dkPos);
                    if (stepPos) b3u = b2 > stepMag ? b2 - stepMag : b2 / 2 + 1;
                    else b3u = b2 + stepMag;
                }
            }

            if (b3u == b2) return (b2, iters);
            b1 = b2;
            k1 = k2;
            b2 = b3u;
        }

        b = _certifyCounterpart(c, bBest, kBest, _quoteEpsilon(c, bBest, _CAP_QUOTE_EPSILON_DENOM));
        if (b == 0) revert Errors.SolverDidNotConverge();
        return (b, iters);
    }

    /**
     * @dev Quote K at `(fixedAxis, b)` with the context's depth and curve parameters.
     */
    function _solverK(SolverContext memory c, uint256 b) private pure returns (uint256) {
        return computeQuoteKFromL(c.fixedAxis, b, c.depth, c.a, c.lambda);
    }

    /**
     * @dev Amount-based local tolerance with a one-math-unit minimum. For certification the
     * denominator is `1 + inverse tolerance`, which covers the smaller quote in the bracket:
     * `epsilon / (quote - epsilon) <= 1 / (denominator - 1)`. The common margin uses the inverse
     * rate directly and applies to every positive quote.
     */
    function _quoteEpsilon(
        SolverContext memory c,
        uint256 b,
        uint256 denominator
    ) private pure returns (uint256 epsilon) {
        uint256 amount = c.exactOut
            ? (b >= c.previous ? b - c.previous : 0)
            : (b <= c.previous ? c.previous - b : 0);
        epsilon = amount / denominator;
        assembly ("memory-safe") {
            epsilon := or(epsilon, iszero(epsilon))
        }
    }

    /**
     * @dev Certify a cap candidate by bracketing `target` within `epsilon` of `b`; returns `b`
     * unchanged when confirmed and zero when unresolved. The common margin is applied
     * separately, exactly once. The local bracket in the Q128-weight quote K is not a global
     * continuous-root or strict pool-side proof; integer rounding is retained.
     */
    function _certifyCounterpart(
        SolverContext memory c,
        uint256 b,
        uint256 k,
        uint256 epsilon
    ) internal pure returns (uint256) {
        if (k == c.target) return b;
        if (k > c.target) {
            uint256 low = b > epsilon ? b - epsilon : 1;
            if (low < b && _solverK(c, low) <= c.target) return b;
        } else {
            uint256 high = b + epsilon;
            if (_solverK(c, high) >= c.target) return b;
        }
        return 0;
    }

    // =========================================================================
    // 6. CP-proxy distance predictor (dynamic-fee resolver)
    // =========================================================================

    /**
     * @notice Predict the post-swap math-space distance of an exact-in trade with a
     * constant-product proxy.
     * @dev Used by the pool's exact-in dynamic-fee resolver to set the rate before running the
     * cubic. The proxy can diverge from the true cubic post-state distance in either direction
     * and tends to understate it on plateau or imbalance-increasing trades, so on large swaps the
     * resolved fee can sit below the true-distance fee; the resolved rate always stays in
     * `[feeFloor, baseFee]` and same-state quote equals swap. Returns 0 when the proxy lands on
     * the diagonal or any reserve is zero. An exhausted proxy or a distance square outside
     * uint256 saturates at WAD: with `x * y <= uint256.max`, `D >= 1` there and every allowed
     * ramp is saturated.
     * @param xMath Pre-state input-side coordinate, WAD.
     * @param yMath Pre-state output-side coordinate, WAD.
     * @param dxMathGross Gross input, WAD math units.
     * @return distPostWad Predicted post-swap distance, WAD.
     */
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
        if (yProxy == 0) return Constants.WAD;
        if (yProxy == xPost) return 0;

        uint256 diff;
        unchecked {
            diff = yProxy > xPost ? yProxy - xPost : xPost - yProxy;
        }
        if (diff >= Q128) return Constants.WAD;
        uint256 diffSqWad = FixedPointMathLib.mulWad(diff, diff);
        uint256 denomWad = FixedPointMathLib.mulWad(xPost, yProxy);
        if (denomWad == 0) return 0;
        distPostWad = FixedPointMathLib.divWad(diffSqWad, denomWad);
    }

    // =========================================================================
    // 7. Smoothstep dynamic-fee ramp
    // =========================================================================

    /**
     * @notice Smoothstep dynamic-fee rate: climbs from `floorWad` to `feeCeilingWad` along
     * `m(r) = 2r - r^2` with `r = distPostWad / rampDistWad`.
     * @dev The shape is C1-continuous (`m'(0) = 2`, `m'(1) = 0`). Rates are WAD fractions
     * (1 bps = 1e14); resolving at WAD precision keeps the gross to clean-input map monotone up
     * to a dust residual on the order of `gross / 1e18` per rate step (the inputs are
     * WAD-quantised, so one input wei can cross several rate ulps). Returns `feeCeilingWad`
     * unchanged when `rampDistWad == 0` (ramp disabled), `feeCeilingWad <= floorWad` or
     * `distPostWad >= rampDistWad` (saturated). The fee is marginal, not cumulative: it depends
     * on the instantaneous post-swap distance and is charged on each leg's own input, so a
     * directional trade split into legs pays the area under the rising curve while one swap pays
     * the rectangle `f(D_final) * total`. Splitting is cheaper by construction; the per-leg
     * integral is the marginal-cost-fair charge.
     * @param distPostWad Post-swap state distance, WAD.
     * @param rampDistWad Ramp width, WAD; zero disables the ramp.
     * @param floorWad Fee floor rate, WAD.
     * @param feeCeilingWad Fee ceiling rate, WAD.
     * @return feeWad Resolved fee rate, WAD.
     */
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
    // 8. V3-compat (sqrtPriceX96 ↔ math-space marginal price)
    // =========================================================================

    /**
     * @notice Convert a V3 `sqrtPriceX96` (Q64.96 of `sqrt(token1 / token0)` in raw units) into
     * the math-space marginal price, WAD.
     * @dev Pure coordinate change, independent of the invariant: the raw spot is recovered from
     * the Q64.96 square root, then divided by `priceScale` to project onto the math-space axis
     * where the anchor sits at `WAD`. Total over `[MIN_SQRT_RATIO, MAX_SQRT_RATIO)`: both poles
     * saturate instead of degenerating. Every input below `2^48` maps to the same largest
     * representable math price and inputs past the representable top return 1 wei; the saturated
     * band lies far beyond any reachable pool state, and the operating range keeps a relative
     * error on the order of `(2^48 / sqrtPriceX96)^2`. Token scales are positive powers of ten
     * (0 to 18 decimals); their ratio is reduced before multiplication, and an unrepresentable
     * final price saturates at `uint256.max`. Reverts `InvalidPriceScale` on a zero anchor and
     * `MathInvariantViolation` on a zero scale or a zero input.
     * @param sqrtPriceX96 V3 sqrt price, Q64.96.
     * @param priceScaleWad Anchor, WAD.
     * @param token0Scale Token0 decimal scale, `10^(18 - decimals0)`.
     * @param token1Scale Token1 decimal scale, `10^(18 - decimals1)`.
     * @return pMargWad Math-space marginal price, WAD, at least 1.
     */
    function sqrtPriceX96ToMathPriceWad(
        uint160 sqrtPriceX96,
        uint256 priceScaleWad,
        uint256 token0Scale,
        uint256 token1Scale
    ) internal pure returns (uint256 pMargWad) {
        if (priceScaleWad == 0) revert Errors.InvalidPriceScale();
        if (token0Scale == 0 || token1Scale == 0) revert Errors.MathInvariantViolation();
        if (sqrtPriceX96 == 0) revert Errors.MathInvariantViolation();
        uint256 sp = uint256(sqrtPriceX96);
        uint256 priceQ96 = FixedPointMathLib.fullMulDivN(sp, sp, 96);
        // Low pole: below 2^48 the square floors to zero. Pinning it to the smallest Q96 price
        // maps that whole band to the largest representable math price.
        assembly ("memory-safe") {
            priceQ96 := or(priceQ96, iszero(priceQ96))
        }

        // pMargWad = WAD² · t0Scale · 2^96 / (priceQ96 · t1Scale · priceScale)
        //          = (WAD_SQ_X96 / priceQ96) · t0Scale / t1Scale / priceScale
        uint256 num = Constants.WAD_SQ_X96 / priceQ96;
        if (token0Scale >= token1Scale) {
            uint256 scale = token0Scale / token1Scale;
            if (
                scale > priceScaleWad &&
                num > FixedPointMathLib.fullMulDiv(type(uint256).max, priceScaleWad, scale)
            ) return type(uint256).max;
            pMargWad = FixedPointMathLib.fullMulDiv(num, scale, priceScaleWad);
        } else {
            pMargWad = num / (token1Scale / token0Scale) / priceScaleWad;
        }
        // High pole: a target far above the representable range floors to zero, which callers
        // could not tell apart from "no admissible quote". One wei keeps it a price.
        assembly ("memory-safe") {
            pMargWad := or(pMargWad, iszero(pMargWad))
        }
    }

    /**
     * @notice Inverse of `sqrtPriceX96ToMathPriceWad`.
     * @dev The Q64.96 lift is applied before the scale-ratio division so no precision is lost to
     * early flooring; `fullMulDiv`'s 512-bit intermediate absorbs the lifted magnitudes. The
     * decimal-scale ratio is reduced before the final lift, and a product outside uint256
     * already exceeds the canonical upper clamp. The output is clamped into
     * `[MIN_SQRT_RATIO, MAX_SQRT_RATIO - 1]` so TickMath-style consumers never revert on an
     * extreme state; `pMargMathWad == 0` (infinite price) saturates at the upper clamp. Reverts
     * `InvalidPriceScale` on a zero anchor or scale.
     * @param pMargMathWad Math-space marginal price, WAD.
     * @param priceScaleWad Anchor, WAD.
     * @param token0Scale Token0 decimal scale.
     * @param token1Scale Token1 decimal scale.
     * @return sqrtPriceX96 Clamped V3 sqrt price, Q64.96.
     */
    function mathPriceToSqrtPriceX96(
        uint256 pMargMathWad,
        uint256 priceScaleWad,
        uint256 token0Scale,
        uint256 token1Scale
    ) internal pure returns (uint160 sqrtPriceX96) {
        if (priceScaleWad == 0 || token0Scale == 0 || token1Scale == 0)
            revert Errors.InvalidPriceScale();
        if (pMargMathWad == 0) return Constants.MAX_SQRT_RATIO_MINUS_ONE;
        uint256 numWad = FixedPointMathLib.fullMulDiv(Constants.WAD, Constants.WAD, pMargMathWad);
        uint256 priceQ96 = FixedPointMathLib.fullMulDiv(numWad, 1 << 96, priceScaleWad);
        if (token0Scale >= token1Scale) {
            uint256 scale = token0Scale / token1Scale;
            if (priceQ96 > type(uint256).max / scale) return Constants.MAX_SQRT_RATIO_MINUS_ONE;
            priceQ96 *= scale;
        } else {
            priceQ96 /= token1Scale / token0Scale;
        }
        uint256 sqrtPrice = FixedPointMathLib.sqrt(priceQ96) << 48;
        if (sqrtPrice < Constants.MIN_SQRT_RATIO) return Constants.MIN_SQRT_RATIO;
        if (sqrtPrice > Constants.MAX_SQRT_RATIO_MINUS_ONE) {
            return Constants.MAX_SQRT_RATIO_MINUS_ONE;
        }
        sqrtPriceX96 = uint160(sqrtPrice);
    }

    /**
     * @notice Lower-rounded quote K at frozen depth, also evaluated by every secant step.
     * @dev Depth and weights use Q128; K uses `WAD * 2^18`. Reducing both denominators before
     * division preserves bits that scaling a rounded WAD K cannot recover. Reverts
     * `MathOutOfRange` through the weight bound when `x * y` or `(x - y)^2` overflows.
     * @param x First coordinate, WAD math units.
     * @param y Second coordinate, WAD math units.
     * @param depth Frozen depth, Q128.
     * @param aWad Depth-at-anchor knob, WAD.
     * @param lambdaWad Plateau-width knob, WAD.
     * @return Quote K scaled by `WAD * 2^18`; zero when either coordinate is zero.
     */
    function computeQuoteKFromL(
        uint256 x,
        uint256 y,
        uint256 depth,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256) {
        if (x == 0 || y == 0) return 0;
        uint256 n = FixedPointMathLib.fullMulDiv(x, y, Constants.WAD >> QUOTE_K_EXTRA_BITS);
        uint256 h = FixedPointMathLib.fullMulDivN(depth, x + y, 129 - uint8(QUOTE_K_EXTRA_BITS));
        if (h == n) return n;
        bool positive = h > n;
        bool roundUp = !positive;
        (uint256 theta, uint256 precision) = _tightWeightBound(x, y, aWad, lambdaWad, roundUp);
        uint256 correction = _directedMulDiv(theta, positive ? h - n : n - h, precision, roundUp);
        return positive ? n + correction : n - correction;
    }

    /**
     * @dev Directed bound of the amplification weight `theta = A / precision` at `(x, y)`,
     * rounded up when `upper` is true and down otherwise. Precision is Q128, falling back to WAD
     * at extreme ratios (`(x - y)^2 / (x * y) >= 2^127`) to keep the denominator inside uint256.
     * Reverts `MathOutOfRange` when `x * y` overflows or `|x - y| >= 2^128`.
     */
    function _tightWeightBound(
        uint256 x,
        uint256 y,
        uint256 aWad,
        uint256 lambdaWad,
        bool upper
    ) private pure returns (uint256 theta, uint256 precision) {
        precision = Q128;
        if (x == y) return (_directedMulDiv(aWad, precision, Constants.WAD, upper), precision);
        uint256 difference = x > y ? x - y : y - x;
        uint256 xy;
        uint256 square;
        bool validProducts;
        // The square fits exactly when difference < 2^128.
        assembly ("memory-safe") {
            xy := mul(x, y)
            validProducts := and(iszero(shr(128, difference)), eq(div(xy, x), y))
            square := mul(difference, difference)
        }
        if (!validProducts) revert Errors.MathOutOfRange();
        // When square/xy < 2^127, directed D*Q128 < 2^255+1.
        // For lambda<=W the denominator then fits uint256. Retain the
        // proven WAD bound at extreme ratios instead of narrowing the domain.
        if ((square >> 127) >= xy) precision = Constants.WAD;
        uint256 distance = _directedMulDiv(square, precision, xy, !upper);
        uint256 denominator = precision +
            _directedMulDiv(lambdaWad, distance, Constants.WAD, !upper);
        uint256 anchor = _directedMulDiv(aWad, precision, Constants.WAD, upper);
        theta = _directedMulDiv(anchor, precision, denominator, upper);
    }

    /**
     * @dev `x * y / denominator` rounded up when `upper` is true and down otherwise.
     */
    function _directedMulDiv(
        uint256 x,
        uint256 y,
        uint256 denominator,
        bool upper
    ) private pure returns (uint256 value) {
        value = FixedPointMathLib.fullMulDiv(x, y, denominator);
        if (upper && mulmod(x, y, denominator) != 0) ++value;
    }
}
