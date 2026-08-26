// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IMulticall
/// @notice Enables batching multiple calls to the same contract in one tx.
/// @dev Standard `multicall(bytes[])` shape so integrators can compose
///      common patterns (swap + sweep, swap + unwrap, etc.) in a single
///      transaction.
interface IMulticall {
    /// @notice Call multiple functions on this contract and return the
    ///         result of each one if they all succeed.
    /// @dev Each element of `data` is executed via DELEGATECALL on
    ///      `address(this)`, so `msg.sender` AND `msg.value` are
    ///      preserved: every subcall observes the SAME `msg.value` as
    ///      the outer batch. The attached ETH is provided once at entry
    ///      (not re-funded per subcall), yet each subcall still SEES the
    ///      full value. Callable methods therefore MUST NOT use
    ///      `msg.value` for per-call accounting — a batch would
    ///      double-count it across subcalls.
    /// @param data Encoded function data for each of the inner calls.
    /// @return results ABI-encoded return values from each inner call.
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
}
