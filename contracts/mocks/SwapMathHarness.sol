// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EquilibraSwapMath } from "../libraries/EquilibraSwapMath.sol";

/// @dev Thin wrapper around the pure helpers in {EquilibraSwapMath} that
///      have no on-chain consumer test until now. Keeps the test surface
///      narrow (5 forwarders) so the deployable production pool stays
///      untouched.
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
        return EquilibraSwapMath.distanceFromAnchorWad(pMargWad, pAnchorWad);
    }

    function distanceState(uint256 xWad, uint256 yWad) external pure returns (uint256) {
        return EquilibraSwapMath.distanceState(xWad, yWad);
    }

    function toWad(uint256 amountRaw, uint8 decimals) external pure returns (uint256) {
        return EquilibraSwapMath.toWad(amountRaw, decimals);
    }

    function fromWadDown(uint256 amountWad, uint8 decimals) external pure returns (uint256) {
        return EquilibraSwapMath.fromWadDown(amountWad, decimals);
    }

    function fromWadUp(uint256 amountWad, uint8 decimals) external pure returns (uint256) {
        return EquilibraSwapMath.fromWadUp(amountWad, decimals);
    }

    function computeKAndL(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256 kWad, uint256 lWad) {
        return EquilibraSwapMath.computeKAndL(xMath, yMath, aWad, lambdaWad);
    }

    function balanceScaleFromK(uint256 kWad) external pure returns (uint256) {
        return EquilibraSwapMath.balanceScaleFromK(kWad);
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
        return EquilibraSwapMath.computeK(xMath, yMath, aWad, lambdaWad);
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
        return EquilibraSwapMath.quoteExactInForward(xMath, yMath, dxMath, aWad, lambdaWad);
    }

    function quoteExactOutForward(
        uint256 xMath,
        uint256 yMath,
        uint256 dyMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256 dxMath, uint256 iters) {
        return EquilibraSwapMath.quoteExactOutForward(xMath, yMath, dyMath, aWad, lambdaWad);
    }

    function toMathSpace(
        uint256 xWad,
        uint256 yWad,
        uint256 priceScaleWad
    ) external pure returns (uint256 xMath, uint256 yMath) {
        return EquilibraSwapMath.toMathSpace(xWad, yWad, priceScaleWad);
    }
}
