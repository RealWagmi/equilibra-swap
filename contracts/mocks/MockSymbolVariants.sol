// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockSymbolString
/// @notice Standard EIP-20 Metadata `string symbol()` shape.
contract MockSymbolString {
    string public symbol;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }
}

/// @title MockSymbolBytes32
/// @notice Legacy MKR-style token that returns `bytes32` from `symbol()`.
///         Used to exercise the `IERC20SymbolBytes32` fallback branch in
///         `EquilibraFactory._safeSymbol`.
contract MockSymbolBytes32 {
    bytes32 public symbol;

    constructor(bytes32 symbol_) {
        symbol = symbol_;
    }
}

/// @title MockSymbolNone
/// @notice Token without a `symbol()` selector at all — every call to
///         `symbol()` reverts at the dispatcher level. Exercises the
///         final `"???"` fallback in `EquilibraFactory._safeSymbol`.
contract MockSymbolNone {
    // Intentionally empty: no `symbol()` selector, no fallback function.
}
