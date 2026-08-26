// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { WETH } from "solady/src/tokens/WETH.sol";

/// @title MockWETH9
/// @notice WETH9-compatible mock backed by Solady's gas-optimised {WETH}.
/// @dev Solady's reference already provides `deposit`, `withdraw`, a payable
///      `receive` fallback (aliasing `deposit`) and the `"Wrapped Ether"` /
///      `"WETH"` metadata, which is exactly what our integration tests rely
///      on. We keep the dedicated alias to make the intent explicit in the
///      test setup (and to pin ownership of the mock to this repo).
contract MockWETH9 is WETH {}
