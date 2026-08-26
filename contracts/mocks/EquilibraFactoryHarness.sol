// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EquilibraFactory } from "../EquilibraFactory.sol";

/// @title EquilibraFactoryHarness
/// @notice Test-only subclass of {EquilibraFactory} that re-exposes a
///         small set of `internal` helpers as `external` view/pure
///         functions. Keeps the factory's production surface untouched
///         while letting unit tests probe the cosmetic-metadata helpers
///         directly (without spinning up a full pool deployment).
contract EquilibraFactoryHarness is EquilibraFactory {
    constructor(
        address poolImplementation_,
        address feeCollector_,
        address weth9_
    ) EquilibraFactory(poolImplementation_, feeCollector_, weth9_, 0) {}

    function exposed_safeSymbol(address token) external view returns (string memory) {
        return _safeSymbol(token);
    }
}
