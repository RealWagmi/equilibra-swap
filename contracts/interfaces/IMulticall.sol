// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMulticall
 * @notice Batches several calls to the same contract in one transaction.
 */
interface IMulticall {
    /**
     * @notice Execute every call in `data` on this contract and return each result; the batch
     * reverts if any call reverts.
     * @dev Each element runs via `DELEGATECALL` on `address(this)`, so `msg.sender` and
     * `msg.value` are preserved and every subcall observes the same `msg.value` as the batch.
     * The attached ETH is provided once at entry, so callable methods must not use `msg.value`
     * for per-call accounting.
     * @param data ABI-encoded calldata of each inner call.
     * @return results ABI-encoded return data of each inner call.
     */
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
}
