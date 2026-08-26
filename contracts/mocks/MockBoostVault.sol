// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.27;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

/// @title MockBoostVault
/// @notice Test-only stand-in for a Boost share vault: exposes the one
///         view the factory's Boost curation registry validates
///         (`pool()`). Never deployed to production.
contract MockBoostVault {
    address public pool;

    constructor(address pool_) {
        pool = pool_;
    }
}
