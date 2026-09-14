// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IEquilibraFactory } from "../interfaces/IEquilibraFactory.sol";
import { Errors } from "../libraries/Errors.sol";

/**
 * @title EquilibraPoolGuard
 * @notice Pause flag and role-check helpers shared by Equilibra pools.
 * @dev The inheriting pool implements `_factoryAddress` so every role check resolves the live
 * factory without a parameter.
 */
abstract contract EquilibraPoolGuard {
    // ============ Storage ============

    /**
     * @dev Reversible pause flag; blocks `swap` and `addLiquidity`.
     */
    bool internal _paused;

    // ============ Abstract hooks ============

    /**
     * @dev Factory address bound to this pool; the pool implements it with a single SLOAD of its
     * cached `_factory`.
     */
    function _factoryAddress() internal view virtual returns (address);

    // ============ Pause ============

    /**
     * @dev Reverts `Paused` while the pool is paused.
     */
    modifier whenNotPaused() {
        if (_paused) revert Errors.Paused();
        _;
    }

    // ============ Role checks ============

    /**
     * @dev Reverts `LpNotAllowed` unless `recipient` is on this pool's LP allowlist, held on the
     * factory and resolved live, so an allowlist edit applies to the next mint. Callers gate
     * this on the pool's own privacy flag; public pools never make the call.
     */
    function _enforceLpAllowed(address recipient) internal view {
        if (!IEquilibraFactory(_factoryAddress()).isLpAllowed(address(this), recipient))
            revert Errors.LpNotAllowed();
    }

    /**
     * @dev Reverts `Unauthorized` unless `msg.sender` is the factory owner, resolved live so a
     * factory ownership transfer needs no pool-side migration.
     */
    function _enforceFactoryOwner() internal view {
        if (msg.sender != IEquilibraFactory(_factoryAddress()).owner())
            revert Errors.Unauthorized();
    }

    /**
     * @dev Reverts `Unauthorized` unless `msg.sender` is the fee collector recorded on the
     * factory, resolved live.
     */
    function _enforceFeeCollector() internal view {
        if (msg.sender != IEquilibraFactory(_factoryAddress()).feeCollector())
            revert Errors.Unauthorized();
    }

    /**
     * @dev Reverts `NotParamTimelock` unless `msg.sender` is the factory's param timelock, the
     * only account allowed to re-parameterise a live pool. The timelock address is immutable on
     * the factory, so runtime changes are pinned to code that enforces the queue delay and the
     * change policy.
     */
    function _enforceParamTimelock() internal view {
        if (msg.sender != IEquilibraFactory(_factoryAddress()).paramTimelock())
            revert Errors.NotParamTimelock();
    }
}
