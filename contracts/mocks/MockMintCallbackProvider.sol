// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { IEquilibraPool } from "../interfaces/IEquilibraPool.sol";
import { IEquilibraMintCallback } from "../interfaces/IEquilibraMintCallback.sol";
import { Errors } from "../libraries/Errors.sol";

/// @title MockMintCallbackProvider
/// @notice Test helper that wraps pool.addLiquidity with the required mint callback.
contract MockMintCallbackProvider is IEquilibraMintCallback {
    function addLiquidity(
        address pool,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient
    ) external returns (uint256 sharesOut) {
        IEquilibraPool p = IEquilibraPool(pool);
        IEquilibraPool.PoolMetadata memory meta = p.getPoolMetadata();
        bytes memory data = abi.encode(pool, msg.sender, meta.token0, meta.token1);
        sharesOut = p.addLiquidity(amount0, amount1, minShares, recipient, data);
    }

    /// @inheritdoc IEquilibraMintCallback
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        (address pool, address payer, address t0, address t1) = abi.decode(
            data,
            (address, address, address, address)
        );
        if (msg.sender != pool) revert Errors.InvalidCallbackSender();

        if (amount0Owed > 0) {
            SafeTransferLib.safeTransferFrom(t0, payer, msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            SafeTransferLib.safeTransferFrom(t1, payer, msg.sender, amount1Owed);
        }
    }
}

/// @title MockUnderpayingMintProvider
/// @notice Test-only callback that intentionally short-pays the pool by
///         a configurable shortfall (in wei) on token0. Used to verify
///         the pool's strict `received != amount0Used` delta check
///         actually rejects the deposit instead of silently accepting
///         less liquidity than the trader paid for.
contract MockUnderpayingMintProvider is IEquilibraMintCallback {
    uint256 public shortfall0;

    function setShortfall0(uint256 newShortfall) external {
        shortfall0 = newShortfall;
    }

    function addLiquidity(
        address pool,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient
    ) external returns (uint256 sharesOut) {
        IEquilibraPool p = IEquilibraPool(pool);
        IEquilibraPool.PoolMetadata memory meta = p.getPoolMetadata();
        bytes memory data = abi.encode(pool, msg.sender, meta.token0, meta.token1);
        sharesOut = p.addLiquidity(amount0, amount1, minShares, recipient, data);
    }

    /// @inheritdoc IEquilibraMintCallback
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        (address pool, address payer, address t0, address t1) = abi.decode(
            data,
            (address, address, address, address)
        );
        if (msg.sender != pool) revert Errors.InvalidCallbackSender();

        // Intentionally short-pay token0 to exercise the pool's strict
        // delta check. Subtract `shortfall0` wei from `amount0Owed`
        // (saturating at 0 if the shortfall would underflow).
        uint256 pay0 = amount0Owed > shortfall0 ? amount0Owed - shortfall0 : 0;
        if (pay0 > 0) {
            SafeTransferLib.safeTransferFrom(t0, payer, msg.sender, pay0);
        }
        if (amount1Owed > 0) {
            SafeTransferLib.safeTransferFrom(t1, payer, msg.sender, amount1Owed);
        }
    }
}

/// @title MockReentrancyGuardProbe
/// @notice Test-only mint callback that records
///         `pool.reentrancyGuardEntered()` observed from INSIDE the
///         guarded `addLiquidity` frame — pinning that the pool reports
///         the guard as held during a callback (the read-only-reentrancy
///         window a fair-value LP oracle must reject). It ALSO reads the
///         guard again after the inner `addLiquidity` returns but still
///         in the SAME transaction, so `clearedAfterInner` genuinely
///         exercises the modifier's `tstore(slot, 0)` exit path — a read
///         across a transaction boundary would see the slot wiped by
///         EIP-1153 regardless of whether the exit path ran.
contract MockReentrancyGuardProbe is IEquilibraMintCallback {
    bool public enteredDuringCallback;
    bool public clearedAfterInner;
    bool public callbackRan;

    function addLiquidity(
        address pool,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient
    ) external returns (uint256 sharesOut) {
        IEquilibraPool p = IEquilibraPool(pool);
        IEquilibraPool.PoolMetadata memory meta = p.getPoolMetadata();
        bytes memory data = abi.encode(pool, msg.sender, meta.token0, meta.token1);
        sharesOut = p.addLiquidity(amount0, amount1, minShares, recipient, data);
        // Same transaction, guard frame has unwound: proves clear-on-exit
        // (transient storage is NOT yet wiped — that only happens at the
        // tx boundary).
        clearedAfterInner = p.reentrancyGuardEntered();
    }

    /// @inheritdoc IEquilibraMintCallback
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        (address pool, address payer, address t0, address t1) = abi.decode(
            data,
            (address, address, address, address)
        );
        if (msg.sender != pool) revert Errors.InvalidCallbackSender();

        // Observe the guard state while the pool's addLiquidity frame is
        // live and record it for the test to assert on.
        enteredDuringCallback = IEquilibraPool(pool).reentrancyGuardEntered();
        callbackRan = true;

        if (amount0Owed > 0) {
            SafeTransferLib.safeTransferFrom(t0, payer, msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            SafeTransferLib.safeTransferFrom(t1, payer, msg.sender, amount1Owed);
        }
    }
}
