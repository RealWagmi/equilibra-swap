// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IEquilibraPool } from "../interfaces/IEquilibraPool.sol";
import { IEquilibraSwapCallback } from "../interfaces/IEquilibraSwapCallback.sol";
import { Errors } from "../libraries/Errors.sol";

/// @title MockSwapCallbackTrader
/// @notice Test helper contract for callback payment behavior checks.
contract MockSwapCallbackTrader is IEquilibraSwapCallback {
    using SafeERC20 for IERC20;

    enum PayMode {
        Exact,
        Underpay,
        Overpay
    }

    struct CallbackData {
        address pool;
        PayMode mode;
    }

    function executeSwap(
        address pool,
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        PayMode mode
    ) external returns (int256 amount0, int256 amount1) {
        bytes memory data = abi.encode(CallbackData({ pool: pool, mode: mode }));
        (amount0, amount1) = IEquilibraPool(pool).swap(
            recipient,
            zeroForOne,
            amountSpecified,
            data
        );
    }

    /// @inheritdoc IEquilibraSwapCallback
    function equilibraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external override {
        CallbackData memory callbackData = abi.decode(data, (CallbackData));
        if (msg.sender != callbackData.pool) revert Errors.InvalidCallbackSender();

        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : amount1Delta > 0
                ? uint256(amount1Delta)
                : 0;
        if (amountToPay == 0) return;

        if (callbackData.mode == PayMode.Underpay) {
            if (amountToPay > 0) amountToPay -= 1;
        } else if (callbackData.mode == PayMode.Overpay) {
            amountToPay += 1;
        }

        IEquilibraPool.PoolMetadata memory meta = IEquilibraPool(msg.sender).getPoolMetadata();
        address tokenIn = amount0Delta > 0 ? meta.token0 : meta.token1;
        IERC20(tokenIn).safeTransfer(msg.sender, amountToPay);
    }
}
