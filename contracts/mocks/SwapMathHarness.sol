// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EquilibraSwapMath } from "../libraries/EquilibraSwapMath.sol";
import { Errors } from "../libraries/Errors.sol";
import { SwapMathDiagnostics } from "./SwapMathDiagnostics.sol";

/// @dev Thin wrapper around the pure helpers in {EquilibraSwapMath} that
///      are exercised independently of pool settlement. Test-only depth
///      preparation and internal control-flow probes stay in this mock.
contract SwapMathHarness {
    function smoothstepFeeWad(
        uint256 distPostWad,
        uint256 rampDistWad,
        uint256 floorWad,
        uint256 feeCeilingWad
    ) external pure returns (uint256) {
        return
            EquilibraSwapMath.smoothstepFeeWad(distPostWad, rampDistWad, floorWad, feeCeilingWad);
    }

    function sqrtPriceX96ToMathPriceWad(
        uint160 sqrtPriceX96,
        uint256 anchorWad,
        uint256 token0Scale,
        uint256 token1Scale
    ) external pure returns (uint256) {
        return
            EquilibraSwapMath.sqrtPriceX96ToMathPriceWad(
                sqrtPriceX96,
                anchorWad,
                token0Scale,
                token1Scale
            );
    }

    function mathPriceToSqrtPriceX96(
        uint256 pMargWad,
        uint256 anchorWad,
        uint256 token0Scale,
        uint256 token1Scale
    ) external pure returns (uint160) {
        return
            EquilibraSwapMath.mathPriceToSqrtPriceX96(
                pMargWad,
                anchorWad,
                token0Scale,
                token1Scale
            );
    }

    function distanceFromAnchorWad(
        uint256 pMargWad,
        uint256 pAnchorWad
    ) external pure returns (uint256) {
        return SwapMathDiagnostics.distanceFromAnchorWad(pMargWad, pAnchorWad);
    }

    function distanceState(uint256 xWad, uint256 yWad) external pure returns (uint256) {
        return SwapMathDiagnostics.distanceState(xWad, yWad);
    }

    function toWad(uint256 amountRaw, uint8 decimals) external pure returns (uint256) {
        return SwapMathDiagnostics.toWad(amountRaw, decimals);
    }

    function fromWadDown(uint256 amountWad, uint8 decimals) external pure returns (uint256) {
        return SwapMathDiagnostics.fromWadDown(amountWad, decimals);
    }

    function fromWadUp(uint256 amountWad, uint8 decimals) external pure returns (uint256) {
        return SwapMathDiagnostics.fromWadUp(amountWad, decimals);
    }

    function computeKAndL(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256 kWad, uint256 lQ128) {
        return SwapMathDiagnostics.computeKAndL(xMath, yMath, aWad, lambdaWad);
    }

    function balanceScaleFromK(uint256 kWad) external pure returns (uint256) {
        return SwapMathDiagnostics.balanceScaleFromK(kWad);
    }

    function solveLFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256) {
        return EquilibraSwapMath.solveLFromState(xMath, yMath, aWad, lambdaWad);
    }

    function computeK(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256) {
        return SwapMathDiagnostics.computeK(xMath, yMath, aWad, lambdaWad);
    }

    function marginalPriceFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256) {
        return EquilibraSwapMath.marginalPriceFromState(xMath, yMath, aWad, lambdaWad);
    }

    function predictPostDistanceCp(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMathGross
    ) external pure returns (uint256) {
        return EquilibraSwapMath.predictPostDistanceCp(xMath, yMath, dxMathGross);
    }

    function quoteExactInForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dxMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256 dyMath, uint256 iters) {
        // Test-only convenience entry: production callers already carry L.
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dxMath == 0) revert Errors.ZeroAmount();
        uint256 depth = EquilibraSwapMath.solveLFromState(xMath, yMath, aWad, lambdaWad);
        return EquilibraSwapMath.quoteExactInForward(xMath, yMath, dxMath, aWad, lambdaWad, depth);
    }

    function quoteExactOutForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256 dxMath, uint256 iters) {
        // Test-only convenience entry: production callers already carry L.
        if (xMath == 0 || yMath == 0) revert Errors.InsufficientLiquidity();
        if (dyMath == 0) revert Errors.ZeroAmount();
        if (dyMath >= yMath) revert Errors.InsufficientLiquidity();
        uint256 depth = EquilibraSwapMath.solveLFromState(xMath, yMath, aWad, lambdaWad);
        return EquilibraSwapMath.quoteExactOutForward(xMath, yMath, dyMath, aWad, lambdaWad, depth);
    }

    function toMathSpace(
        uint256 xWad,
        uint256 yWad,
        uint256 priceScaleWad
    ) external pure returns (uint256 xMath, uint256 yMath) {
        return SwapMathDiagnostics.toMathSpace(xWad, yWad, priceScaleWad);
    }
    function computeQuoteK(
        uint256 x,
        uint256 y,
        uint256 depth,
        uint256 a,
        uint256 lambda
    ) external pure returns (uint256) {
        return EquilibraSwapMath.computeQuoteKFromL(x, y, depth, a, lambda);
    }

    function certifyCounterpart(
        EquilibraSwapMath.SolverContext memory context,
        uint256 b,
        uint256 k,
        uint256 epsilon
    ) external pure returns (uint256) {
        return EquilibraSwapMath._certifyCounterpart(context, b, k, epsilon);
    }
}
