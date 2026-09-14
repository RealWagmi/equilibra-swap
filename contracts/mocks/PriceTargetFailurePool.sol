// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IEquilibraPool } from "../interfaces/IEquilibraPool.sol";

/// @dev Test-only adapter: real snapshots and quotes, with injected probe failures.
contract PriceTargetFailurePool {
    IEquilibraPool public immutable source;
    uint256 public rejectFrom;
    uint256 public rejectTo;
    bytes4 public failure;

    constructor(address pool) {
        source = IEquilibraPool(pool);
    }

    function setFailure(uint256 from, uint256 to, bytes4 selector) external {
        rejectFrom = from;
        rejectTo = to;
        failure = selector;
    }

    function getCurveParams() external view returns (IEquilibraPool.CurveParams memory) {
        return source.getCurveParams();
    }

    function getFeeConfig() external view returns (IEquilibraPool.FeeConfig memory) {
        return source.getFeeConfig();
    }

    function getPriceScale() external view returns (uint256) {
        return source.getPriceScale();
    }

    function getReserves() external view returns (uint256, uint256) {
        return source.getReserves();
    }

    function quoteExactIn(bool zeroForOne, uint256 amountIn) external view returns (uint256) {
        if (failure != bytes4(0) && amountIn >= rejectFrom && amountIn <= rejectTo) {
            bytes memory reason = abi.encodePacked(failure);
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
        return source.quoteExactIn(zeroForOne, amountIn);
    }
}
