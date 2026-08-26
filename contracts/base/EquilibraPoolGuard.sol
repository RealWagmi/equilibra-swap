// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IEquilibraFactory } from "../interfaces/IEquilibraFactory.sol";
import { Errors } from "../libraries/Errors.sol";

/// @title EquilibraPoolGuard
/// @notice Shared pause and role-check guard helpers for Equilibra pools.
/// @dev The pool must implement {_factoryAddress} so the role-check
///      helpers can resolve the live factory address without taking it
///      as a parameter at every call site.
abstract contract EquilibraPoolGuard {
    // ============ Storage ============

    bool internal _paused;

    // ============ Abstract hooks ============

    /// @dev Returns the factory address bound to this pool. The
    ///      inheriting pool implements this with a single SLOAD of its
    ///      cached `_factory`; making it `virtual` lets the guard live
    ///      base-agnostic while keeping the role-check API parameter-less.
    function _factoryAddress() internal view virtual returns (address);

    // ============ Pause ============

    /// @notice Restricts execution while pool is paused.
    modifier whenNotPaused() {
        if (_paused) revert Errors.Paused();
        _;
    }

    /// @dev Toggle the pause flag. **No access check is performed here**
    ///      — the caller MUST gate this with an authorization step
    ///      (typically {_enforceFactoryOwner}). Kept `internal` so the
    ///      surface is small, but mark this carefully when extending:
    ///      any new caller that reaches `_setPaused` without prior auth
    ///      lets an unprivileged account pause/unpause the pool.
    /// @param paused_ New pause state.
    function _setPaused(bool paused_) internal {
        _paused = paused_;
    }

    // ============ Role checks ============

    /// @dev Reverts unless `recipient` sits on this pool's LP allowlist,
    ///      which lives on the factory (one registry, one admin surface)
    ///      and is resolved live — an allowlist edit takes effect on the
    ///      next mint with no pool-side migration. Callers MUST gate
    ///      this on the pool's own privacy flag: public pools never make
    ///      the staticcall.
    function _enforceLpAllowed(address recipient) internal view {
        if (!IEquilibraFactory(_factoryAddress()).isLpAllowed(address(this), recipient))
            revert Errors.LpNotAllowed();
    }

    /// @dev Reverts unless `msg.sender` is the factory owner. Reads the
    ///      live factory address via {_factoryAddress}, so a future
    ///      ownership transfer on the factory takes effect without any
    ///      pool-side migration.
    function _enforceFactoryOwner() internal view {
        if (msg.sender != IEquilibraFactory(_factoryAddress()).owner())
            revert Errors.Unauthorized();
    }

    /// @dev Reverts unless `msg.sender` is the current fee collector
    ///      recorded on the factory. Like {_enforceFactoryOwner}, the
    ///      collector is resolved live so the pool always honours the
    ///      factory's latest setting.
    function _enforceFeeCollector() internal view {
        if (msg.sender != IEquilibraFactory(_factoryAddress()).feeCollector())
            revert Errors.Unauthorized();
    }

    /// @dev Reverts unless `msg.sender` is the factory's param
    ///      timelock — the only account allowed to re-parameterise a
    ///      live pool. The timelock address is immutable on the
    ///      factory, so this check pins runtime changes to code that
    ///      enforces the queue delay and the change policy.
    function _enforceParamTimelock() internal view {
        if (msg.sender != IEquilibraFactory(_factoryAddress()).paramTimelock())
            revert Errors.NotParamTimelock();
    }
}
