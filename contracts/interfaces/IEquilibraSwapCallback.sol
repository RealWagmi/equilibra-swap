// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IEquilibraSwapCallback
/// @notice Callback invoked by Equilibra pools during swap execution.
interface IEquilibraSwapCallback {
    /// @notice Called by pool after output transfer to request swap payment.
    /// @param amount0Delta Token0 delta; positive means caller must pay pool.
    /// @param amount1Delta Token1 delta; positive means caller must pay pool.
    /// @param data Opaque payload originally passed to pool swap.
    function equilibraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}
