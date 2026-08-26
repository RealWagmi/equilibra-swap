// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { EquilibraPool } from "../EquilibraPool.sol";
import { IEquilibraPool } from "../interfaces/IEquilibraPool.sol";
import { EquilibraSwapMath } from "../libraries/EquilibraSwapMath.sol";

/// @title MockEquilibraPool
/// @notice Test-only subclass of {EquilibraPool} that re-exposes a small
///         hand-picked set of `internal` helpers as `external` view/pure
///         functions for the regression tests in
///         `test/security/RepegProfitShare.test.ts` and friends.
///
/// @dev    Replaces the broad `hardhat-exposed` plugin (`$EquilibraPool`)
///         which auto-wrapped every internal function and pushed the
///         resulting bytecode past the Spurious Dragon 24 KB limit.
///
///         Each `exposed_*` wrapper is a one-liner that forwards to the
///         identically-named internal helper on `EquilibraPool`, so the
///         tests exercise the production code paths verbatim.
contract MockEquilibraPool is EquilibraPool {
    /// @notice Forwards to `_computeLpUnitValueWad` using a freshly
    ///         loaded curve snapshot (`_loadCurveParams`).
    function exposed_computeLpUnitValueWad(
        uint256 reserve0,
        uint256 reserve1,
        uint256 totalSupplyWad
    ) external view returns (uint256) {
        return _computeLpUnitValueWad(reserve0, reserve1, _loadCurveParams(), totalSupplyWad);
    }

    /// @notice Probe `_computeLpUnitValueWad` at a counterfactual
    ///         `priceScaleWad`, holding the live `(aWad, lambdaWad)`
    ///         from storage. Used by the repeg-side security tests
    ///         (`RepegProfitShare`, `RepegConservation`) to sweep the
    ///         metric across candidate price-scale shifts without
    ///         reaching into the cubic-kernel internals.
    function exposed_computeLpUnitValueWadAtPriceScale(
        uint256 reserve0,
        uint256 reserve1,
        uint256 priceScaleWad,
        uint256 totalSupplyWad
    ) external view returns (uint256) {
        CurveSnapshot memory cs = _loadCurveParams();
        cs.priceScaleWad = priceScaleWad;
        return _computeLpUnitValueWad(reserve0, reserve1, cs, totalSupplyWad);
    }

    /// @notice Forwards to `_computeLpUnitValueWad` against an explicit
    ///         curve snapshot (priceScale and/or knobs can be
    ///         overridden vs. live storage). Used by the repeg
    ///         regression tests to probe the metric under
    ///         counterfactual priceScale shifts without mutating pool
    ///         storage.
    function exposed_computeLpUnitValueWadWithCs(
        uint256 reserve0,
        uint256 reserve1,
        uint256 totalSupplyWad,
        uint256 aWad,
        uint256 lambdaWad,
        uint256 priceScaleWad
    ) external view returns (uint256) {
        CurveSnapshot memory cs = _loadCurveParams();
        cs.aWad = aWad;
        cs.lambdaWad = lambdaWad;
        cs.priceScaleWad = priceScaleWad;
        return _computeLpUnitValueWad(reserve0, reserve1, cs, totalSupplyWad);
    }

    /// @notice Forwards to `_toWadByScale`. Pure decimal-scale lift.
    function exposed_toWadByScale(
        uint256 amountRaw,
        uint256 scale
    ) external pure returns (uint256) {
        return _toWadByScale(amountRaw, scale);
    }

    /// @notice Forwards to `EquilibraSwapMath.computeK`. Pure helper
    ///         used by the regression tests to evaluate the
    ///         state-only invariant against counterfactual reserve
    ///         snapshots.
    function exposed_computeK(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256) {
        return EquilibraSwapMath.computeK(xMath, yMath, aWad, lambdaWad);
    }

    /// @notice Forwards to `EquilibraSwapMath.solveLFromState`. Pure
    ///         depth-scale recovery from a math-space state.
    function exposed_solveLFromState(
        uint256 xMath,
        uint256 yMath,
        uint256 aWad,
        uint256 lambdaWad
    ) external pure returns (uint256) {
        return EquilibraSwapMath.solveLFromState(xMath, yMath, aWad, lambdaWad);
    }

    /// @notice Forwards to `_tryDonationParachute` with an explicit
    ///         qualifier/floor argument set over the live curve
    ///         snapshot. State-constructed twin of the Rust unit test
    ///         `parachute_commits_without_subsidy_when_candidate_needs_none`:
    ///         the δ = 0 no-subsidy commit branch is documented behaviour
    ///         but needs a vp-accretive candidate at a starved gate — a
    ///         state no plain swap scenario reaches deterministically —
    ///         so the test drives the production branch verbatim with a
    ///         crafted `vpFloorWad` instead.
    function exposed_tryDonationParachute(
        uint256 reserve0,
        uint256 reserve1,
        uint256 emaWad,
        uint256 emaBeforeWad,
        uint256 stepCapWad,
        uint256 deviationWad,
        uint256 vpFloorWad
    ) external returns (uint256) {
        return
            _tryDonationParachute(
                reserve0,
                reserve1,
                _loadCurveParams(),
                emaWad,
                emaBeforeWad,
                stepCapWad,
                deviationWad,
                vpFloorWad
            );
    }
}
