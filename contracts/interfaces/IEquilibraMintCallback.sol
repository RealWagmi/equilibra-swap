// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IEquilibraMintCallback
/// @notice Callback invoked by Equilibra pools during addLiquidity execution.
interface IEquilibraMintCallback {
    /// @notice Called by pool after computing required amounts to request liquidity payment.
    /// @param amount0Owed Token0 amount the caller must transfer to the pool.
    /// @param amount1Owed Token1 amount the caller must transfer to the pool.
    /// @param data Opaque payload originally passed to pool addLiquidity.
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external;
}
