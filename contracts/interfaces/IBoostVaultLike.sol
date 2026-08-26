// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IBoostVaultLike
/// @notice Minimal surface of a Boost share vault used by the factory's
///         curation registry — a full Boost interface import would
///         couple this repo to the wrapper's codebase.
interface IBoostVaultLike {
    /// @notice The Equilibra pool this Boost stack wraps.
    function pool() external view returns (address);
}
