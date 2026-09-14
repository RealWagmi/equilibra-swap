// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IWETH9
 * @notice Subset of the canonical Wrapped Ether ABI used by the periphery.
 * @dev The router takes the wrapped-native address at deployment (WETH on mainnet, WBNB on BSC,
 * and so on), so this interface stays chain-agnostic.
 */
interface IWETH9 is IERC20 {
    /**
     * @notice Wrap `msg.value` native ETH into WETH credited to `msg.sender` at 1:1.
     */
    function deposit() external payable;

    /**
     * @notice Burn `amount` WETH from `msg.sender` and send the same amount of native ETH back.
     * @param amount Amount to unwrap, in wei.
     */
    function withdraw(uint256 amount) external;
}
