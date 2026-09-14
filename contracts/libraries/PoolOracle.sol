// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { Constants } from "./Constants.sol";
import { Errors } from "./Errors.sol";

/**
 * @title PoolOracle
 * @notice Geometric (log-domain) price EMA and bounded, damped log-domain anchor steps.
 * @dev `updateEma` keeps a continuous-time geometric EMA with a symmetric spot cap; it is
 * reciprocal-invariant, so the oracle does not depend on token order. `appliedRepegStep` and
 * `applyLogStep` move the anchor toward a target by a capped, damped log-domain step clamped to
 * the remaining gap, so a single call never overshoots; `shiftPriceScale` composes the two.
 */
library PoolOracle {
    /**
     * @notice Persistent EMA state: the price logarithm `ln(price / WAD)` in WAD and the
     * timestamp of the last update.
     */
    struct EmaState {
        int256 emaLogWad;
        uint64 lastUpdateTs;
    }

    /**
     * @dev Encode a positive WAD price as `ln(price / WAD)` in WAD. Reverts `MathOutOfRange` when
     * the price does not fit `int256`.
     */
    function priceToEmaLog(uint256 priceWad) internal pure returns (int256) {
        if (priceWad > uint256(type(int256).max)) revert Errors.MathOutOfRange();
        return FixedPointMathLib.lnWad(int256(priceWad));
    }

    /**
     * @dev Decode a stored logarithm into a WAD price, floored at 1. Only price consumers decode;
     * the persistent state keeps log precision.
     */
    function emaLogToPrice(int256 emaLogWad) internal pure returns (uint256 priceWad) {
        priceWad = uint256(FixedPointMathLib.expWad(emaLogWad));
        if (priceWad == 0) priceWad = 1;
    }

    /**
     * @notice Update the continuous-time geometric EMA in log space.
     * @dev `alpha = exp(-dt / tau)` and
     * `logNew = logOld + (ln(cappedSpot) - logOld) * (WAD - alpha) / WAD`; the signed division
     * truncates toward zero, identically in the Rust reference. Spot is clamped to
     * `[priceScale / 2, priceScale * 2]` before mixing. A zero spot or a non-increasing
     * timestamp is a no-op. Only a zero `lastUpdateTs` bootstraps from the uncapped spot; a zero
     * logarithm is the valid price 1, not a sentinel.
     * @param state Current EMA state.
     * @param spotPriceWad Live marginal price, token0 per token1, WAD.
     * @param priceScaleWad Anchor used for the spot cap; zero disables the cap.
     * @param emaPeriod Relaxation time `tau` in seconds, positive.
     * @param nowTs Current block timestamp.
     * @return next Updated state.
     */
    function updateEma(
        EmaState memory state,
        uint256 spotPriceWad,
        uint256 priceScaleWad,
        uint32 emaPeriod,
        uint64 nowTs
    ) internal pure returns (EmaState memory next) {
        if (spotPriceWad == 0) return state;
        next = state;
        if (state.lastUpdateTs == 0) {
            next.emaLogWad = priceToEmaLog(spotPriceWad);
            next.lastUpdateTs = nowTs;
            return next;
        }
        if (nowTs <= state.lastUpdateTs) return next;

        uint256 elapsed = uint256(nowTs - state.lastUpdateTs);
        // elapsed is uint64 and the factory validates a positive tau.
        uint256 alpha = uint256(
            FixedPointMathLib.expWad(-int256((elapsed * Constants.WAD) / uint256(emaPeriod)))
        );
        uint256 cappedSpot = spotPriceWad;
        if (priceScaleWad != 0) {
            uint256 maxSpot = priceScaleWad * Constants.EMA_PRICE_CAP_MUL;
            uint256 minSpot = priceScaleWad / Constants.EMA_PRICE_CAP_DIV;
            if (cappedSpot > maxSpot) cappedSpot = maxSpot;
            else if (cappedSpot < minSpot) cappedSpot = minSpot;
        }
        int256 target = priceToEmaLog(cappedSpot);
        next.emaLogWad =
            state.emaLogWad +
            ((target - state.emaLogWad) * int256(Constants.WAD - alpha)) / int256(Constants.WAD);
        next.lastUpdateTs = nowTs;
    }

    /**
     * @notice Shift the anchor toward `targetWad` by a bounded, damped log-domain step.
     * @dev `deviationWad = |max(target, priceScale) / min(target, priceScale) - 1|` (WAD),
     * `appliedStepWad = min(repegStepWad, deviationWad / REPEG_DAMPING_DIVISOR)` and
     * `priceScaleNew = mulWad(priceScale, expWad(±appliedStepWad))`. The geometric deviation
     * registers a 2x move as 1.0 WAD before rounding. Activation dead-bands stay below WAD.
     * `applyLogStep` clamps the landing to the target, so a single call never overshoots
     * for any step magnitude. The activation dead-band gate is enforced by the caller. Reverts
     * `InvalidPriceScale` on a zero anchor or target and `InvalidRepegStep` when the cap is zero
     * or above WAD.
     * @param priceScaleOldWad Current anchor, WAD.
     * @param targetWad Target anchor (the EMA), WAD.
     * @param repegStepWad Maximum log-domain step per call, WAD, in `(0, WAD]`.
     * @return priceScaleNewWad Anchor after the move.
     * @return movedAbsWad Absolute anchor change, WAD.
     */
    function shiftPriceScale(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 repegStepWad
    ) internal pure returns (uint256 priceScaleNewWad, uint256 movedAbsWad) {
        if (priceScaleOldWad == 0 || targetWad == 0) revert Errors.InvalidPriceScale();
        if (repegStepWad == 0 || repegStepWad > Constants.WAD) revert Errors.InvalidRepegStep();

        if (targetWad == priceScaleOldWad) {
            return (priceScaleOldWad, 0);
        }

        // Geometric deviation |max/min - 1|, bit-exact with the pool's activation gate.
        uint256 deviationWad = targetWad >= priceScaleOldWad
            ? FixedPointMathLib.fullMulDiv(targetWad, Constants.WAD, priceScaleOldWad) -
                Constants.WAD
            : FixedPointMathLib.fullMulDiv(priceScaleOldWad, Constants.WAD, targetWad) -
                Constants.WAD;

        return shiftPriceScale(priceScaleOldWad, targetWad, repegStepWad, deviationWad);
    }

    /**
     * @notice Deviation-supplied variant of `shiftPriceScale` for callers that already hold the
     * bit-identical geometric deviation, such as the pool's activation gate.
     * @dev Same semantics and reverts as the three-argument form. A damped step that rounds to
     * zero (deviation below `REPEG_DAMPING_DIVISOR` wei) returns the anchor unchanged.
     * @param priceScaleOldWad Current anchor, WAD.
     * @param targetWad Target anchor, WAD.
     * @param repegStepWad Maximum log-domain step per call, WAD, in `(0, WAD]`.
     * @param deviationWad Geometric deviation `|max / min - 1|` between target and anchor, WAD.
     * @return priceScaleNewWad Anchor after the move.
     * @return movedAbsWad Absolute anchor change, WAD.
     */
    function shiftPriceScale(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 repegStepWad,
        uint256 deviationWad
    ) internal pure returns (uint256 priceScaleNewWad, uint256 movedAbsWad) {
        if (priceScaleOldWad == 0 || targetWad == 0) revert Errors.InvalidPriceScale();
        if (repegStepWad == 0 || repegStepWad > Constants.WAD) revert Errors.InvalidRepegStep();

        if (targetWad == priceScaleOldWad) {
            return (priceScaleOldWad, 0);
        }

        uint256 appliedStepWad = appliedRepegStep(repegStepWad, deviationWad);

        // A damped step that rounds to zero is skipped.
        if (appliedStepWad == 0) {
            return (priceScaleOldWad, 0);
        }

        priceScaleNewWad = applyLogStep(priceScaleOldWad, targetWad, appliedStepWad);
        movedAbsWad = priceScaleNewWad >= priceScaleOldWad
            ? priceScaleNewWad - priceScaleOldWad
            : priceScaleOldWad - priceScaleNewWad;
    }

    /**
     * @notice Damped applied step `min(repegStepWad, deviationWad / REPEG_DAMPING_DIVISOR)`.
     * @dev Split out so the pool's halving ladder can retry the same base step at halved
     * magnitudes.
     * @param repegStepWad Configured step cap, WAD.
     * @param deviationWad Geometric deviation between target and anchor, WAD.
     * @return appliedStepWad Log-domain step to apply, WAD.
     */
    function appliedRepegStep(
        uint256 repegStepWad,
        uint256 deviationWad
    ) internal pure returns (uint256 appliedStepWad) {
        uint256 dampedDeviationWad = deviationWad / Constants.REPEG_DAMPING_DIVISOR;
        appliedStepWad = repegStepWad < dampedDeviationWad ? repegStepWad : dampedDeviationWad;
    }

    /**
     * @notice Apply one log-domain move of magnitude `appliedStepWad` toward `targetWad`:
     * `psNew = mulWad(ps, expWad(±applied))`, clamped to the target.
     * @dev Up and down moves are multiplicative inverses before integer rounding, unlike the
     * additive form `ps * (1 ± s)` with its `O(s^2)` residue.
     * Bit-for-bit with the Rust reference `apply_log_step`. The clamp is unconditional: the
     * worst case lands on the target, never past it. Reverts `InvalidPriceScale` on a zero
     * anchor or target.
     * @param priceScaleOldWad Current anchor, WAD.
     * @param targetWad Target anchor, WAD.
     * @param appliedStepWad Log-domain step magnitude, WAD; zero returns the anchor unchanged.
     * @return priceScaleNewWad Anchor after the move.
     */
    function applyLogStep(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 appliedStepWad
    ) internal pure returns (uint256 priceScaleNewWad) {
        if (priceScaleOldWad == 0 || targetWad == 0) revert Errors.InvalidPriceScale();
        if (targetWad == priceScaleOldWad || appliedStepWad == 0) {
            return priceScaleOldWad;
        }
        bool up = targetWad > priceScaleOldWad;
        // Single expWad call site keeps one inlined copy of the exp kernel in the pool bytecode.
        uint256 factor = uint256(
            FixedPointMathLib.expWad(up ? int256(appliedStepWad) : -int256(appliedStepWad))
        );
        priceScaleNewWad = FixedPointMathLib.fullMulDiv(priceScaleOldWad, factor, Constants.WAD);
        if (up) {
            if (priceScaleNewWad > targetWad) priceScaleNewWad = targetWad;
        } else {
            if (priceScaleNewWad < targetWad) priceScaleNewWad = targetWad;
        }
    }
}
