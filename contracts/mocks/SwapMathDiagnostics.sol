// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { EquilibraSwapMath } from "../libraries/EquilibraSwapMath.sol";
import { Constants } from "../libraries/Constants.sol";
import { Errors } from "../libraries/Errors.sol";

/// @dev Test-only decimal, coordinate and WAD-invariant diagnostics.
///      Production quotes retain Q128 depth and the finer quote-K scale.
library SwapMathDiagnostics {
    /// @notice Convert raw token amount to WAD-normalised units.
    function toWad(uint256 amountRaw, uint8 decimals) internal pure returns (uint256 amountWad) {
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        if (decimals == 18) return amountRaw;
        amountWad = amountRaw * (10 ** (18 - decimals));
    }

    /// @notice Convert WAD to raw token units, rounding down.
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

    /// @notice Convert WAD to raw token units, rounding up.
    function fromWadUp(
        uint256 amountWad,
        uint8 decimals
    ) internal pure returns (uint256 amountRaw) {
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        if (decimals == 18) return amountWad;
        amountRaw = FixedPointMathLib.mulDivUp(amountWad, 1, 10 ** (18 - decimals));
    }

    /// @notice Asymmetric coordinates: x stays in base units; y is divided by the anchor.
    function toMathSpace(
        uint256 xWad,
        uint256 yWad,
        uint256 priceScaleWad
    ) internal pure returns (uint256 xMath, uint256 yMath) {
        if (priceScaleWad == 0) revert Errors.InvalidPriceScale();
        xMath = xWad;
        yMath = FixedPointMathLib.divWad(yWad, priceScaleWad);
    }

    /// @notice Symmetric price distance `(p - ref)^2 / (p * ref)`, in WAD.
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

    /// @notice State distance `(y - x)^2 / (x * y)`, in WAD.
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

    /// @notice Quote K reduced to WAD, using freshly recovered Q128 depth.
    function computeK(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 kWad) {
        (kWad, ) = computeKAndL(xMath, yMath, aWad, lambdaWad);
    }

    /// @notice Recover Q128 depth and reduce quote K to WAD for diagnostics.
    function computeKAndL(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) internal pure returns (uint256 kWad, uint256 lQ128) {
        lQ128 = EquilibraSwapMath.solveLFromState(xMath, yMath, aWad, lambdaWad);
        kWad =
            EquilibraSwapMath.computeQuoteKFromL(xMath, yMath, lQ128, aWad, lambdaWad) >>
            EquilibraSwapMath.QUOTE_K_EXTRA_BITS;
    }

    /// @notice Q128 depth from WAD K; precision lost in K is not recoverable.
    function balanceScaleFromK(uint256 kWad) internal pure returns (uint256 lEqQ128) {
        if (kWad == 0) return 0;
        lEqQ128 = FixedPointMathLib.fullMulDiv(
            FixedPointMathLib.sqrtWad(kWad),
            EquilibraSwapMath.Q128,
            Constants.WAD
        );
    }
}
