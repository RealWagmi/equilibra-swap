// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IEquilibraSwapCallback
 * @notice Callback an Equilibra pool invokes on `msg.sender` during `swap`.
 */
interface IEquilibraSwapCallback {
    /**
     * @notice Called by the pool after the output transfer to collect the swap input.
     * @dev The pool checks that its input-token balance grew by exactly the positive delta.
     * @param amount0Delta Raw token0 delta; positive means the caller must pay it to the pool.
     * @param amount1Delta Raw token1 delta; positive means the caller must pay it to the pool.
     * @param data Opaque payload originally passed to `swap`.
     */
    function equilibraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}
