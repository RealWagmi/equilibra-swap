// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { EquilibraRouter } from "../periphery/EquilibraRouter.sol";

/// @dev Exposes the production zap split for arithmetic-boundary tests only.
contract MockEquilibraRouter is EquilibraRouter {
    constructor() EquilibraRouter(address(1), address(2), address(3)) {}

    function exposed_calculateOptimalSwap(
        bool zeroForOne,
        uint256 amountIn,
        uint256 r0,
        uint256 r1
    ) external pure returns (uint256) {
        return _calculateOptimalSwap(zeroForOne, amountIn, r0, r1);
    }
}
