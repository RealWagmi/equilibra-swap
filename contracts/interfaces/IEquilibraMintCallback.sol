// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IEquilibraMintCallback
 * @notice Callback an Equilibra pool invokes on `msg.sender` during `addLiquidity`.
 */
interface IEquilibraMintCallback {
    /**
     * @notice Called by the pool after computing the required amounts to collect the deposit.
     * @param amount0Owed Raw token0 the caller must transfer to the pool.
     * @param amount1Owed Raw token1 the caller must transfer to the pool.
     * @param data Opaque payload originally passed to `addLiquidity`.
     */
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external;
}
