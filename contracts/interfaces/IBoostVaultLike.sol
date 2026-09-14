// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IBoostVaultLike
 * @notice Minimal Boost share-vault surface used by the factory's curation registry, so the
 * repository does not import the wrapper's full interface.
 */
interface IBoostVaultLike {
    /**
     * @notice The Equilibra pool this Boost stack wraps.
     * @return The pool address.
     */
    function pool() external view returns (address);
}
