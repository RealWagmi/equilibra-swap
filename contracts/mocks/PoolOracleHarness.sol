// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { PoolOracle } from "../libraries/PoolOracle.sol";

/// @dev Exposes `PoolOracle.updateEma` and `PoolOracle.shiftPriceScale`
///      so the EMA-protection / damped-step invariants can be asserted
///      from TypeScript tests without spinning up a full pool.
contract PoolOracleHarness {
    function updateEma(
        uint256 emaPriceWad,
        uint64 lastUpdateTs,
        uint256 spotPriceWad,
        uint256 priceScaleWad,
        uint32 emaPeriod,
        uint64 nowTs
    ) external pure returns (uint256 newEmaPriceWad, uint64 newLastUpdateTs) {
        PoolOracle.EmaState memory next = PoolOracle.updateEma(
            PoolOracle.EmaState({ emaPriceWad: emaPriceWad, lastUpdateTs: lastUpdateTs }),
            spotPriceWad,
            priceScaleWad,
            emaPeriod,
            nowTs
        );
        newEmaPriceWad = next.emaPriceWad;
        newLastUpdateTs = next.lastUpdateTs;
    }

    function shiftPriceScale(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 repegStepWad
    ) external pure returns (uint256 priceScaleNewWad, uint256 movedAbsWad) {
        return PoolOracle.shiftPriceScale(priceScaleOldWad, targetWad, repegStepWad);
    }

    function appliedRepegStep(
        uint256 repegStepWad,
        uint256 deviationWad
    ) external pure returns (uint256 appliedStepWad) {
        return PoolOracle.appliedRepegStep(repegStepWad, deviationWad);
    }

    function applyLogStep(
        uint256 priceScaleOldWad,
        uint256 targetWad,
        uint256 appliedStepWad
    ) external pure returns (uint256 priceScaleNewWad) {
        return PoolOracle.applyLogStep(priceScaleOldWad, targetWad, appliedStepWad);
    }
}
