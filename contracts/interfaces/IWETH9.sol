// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IWETH9
/// @notice Minimal interface for the canonical Wrapped Ether contract.
/// @dev Mirrors the subset of the WETH9 ABI consumed by the periphery
///      (deposit/withdraw + ERC20 read/write). Kept deliberately small so
///      the router can remain chain-agnostic: callers supply the actual
///      WETH-equivalent address at deployment time (WETH on mainnet,
///      WBNB on BSC, WAVAX on Avalanche, etc.).
interface IWETH9 is IERC20 {
    /// @notice Wraps native ETH into WETH at a 1:1 ratio. The amount of
    ///         WETH minted equals `msg.value` and is credited to `msg.sender`.
    function deposit() external payable;

    /// @notice Burns `amount` WETH from `msg.sender` and sends the same
    ///         amount of native ETH back.
    /// @param amount Amount to unwrap (in wei).
    function withdraw(uint256 amount) external;
}
