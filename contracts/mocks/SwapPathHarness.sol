// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SwapPath } from "../libraries/SwapPath.sol";

/// @dev Test-only forwarder for the {SwapPath} helpers that have no
///      production caller (e.g. `numPools`). Keeps the production
///      router free of pure-view bloat while still letting the
///      coverage suite exercise every code path in the encoding lib.
contract SwapPathHarness {
    function numPools(bytes calldata path) external pure returns (uint256) {
        return SwapPath.numPools(path);
    }

    function hasMultiplePools(bytes calldata path) external pure returns (bool) {
        return SwapPath.hasMultiplePools(path);
    }
}
