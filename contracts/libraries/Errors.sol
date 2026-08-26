// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Errors
/// @notice Shared custom errors for Equilibra contracts.
library Errors {
    error ZeroAddress();
    error ZeroAmount();
    error IdenticalTokens();
    error AlreadyInitialized();
    error Unauthorized();
    error UnsupportedToken();
    error UnsupportedTokenBehavior();
    error TokenDecimalsTooLarge();

    error InvalidFee();
    error InvalidProtocolFee();
    error InvalidEmaPeriod();
    /// @dev Reverted when the configured `aWad` (depth-at-anchor knob)
    ///      lies outside `[A_MIN_WAD, A_MAX_WAD]`.
    error InvalidA();
    /// @dev Reverted when the configured `lambdaWad` (plateau-width
    ///      knob) lies outside `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
    error InvalidLambda();
    /// @dev Reverted when `priceScaleWad` is zero or otherwise outside
    ///      the admissible range.
    error InvalidPriceScale();
    error InvalidRepegStep();
    error RepegStepChangeTooLarge();
    error InvalidRepegThreshold();
    error InvalidParachuteBandMult();
    error EmaRatioZero();
    error InvalidFeeRamp();
    error InvalidFeeFloor();
    /// @dev Reverted by the factory when a non-zero `feeRampBps` is
    ///      paired with `baseFee == feeFloorBps`: the smoothstep ramp
    ///      has no headroom to interpolate into, so the ramp silently
    ///      collapses to the flat-fee path. Fail-fast at deploy time
    ///      instead of letting the misconfig hide in the pool.
    error FeeRampNoHeadroom();
    /// @dev Reverted when a live ramp is too narrow for its fee span
    ///      and ceiling: `feeRampBps · (BPS − baseFee)² <
    ///      FEE_RAMP_GUARD_MULT · BPS · (baseFee − feeFloorBps)²`. On
    ///      such a ramp the terminal rate climbs faster than the gross
    ///      input grows, so a larger exact-in trade would return less
    ///      output over whole input intervals.
    error FeeRampTooNarrow();
    error InvalidRepegShare();
    /// @dev Reverted by the factory when the proposed
    ///      `repegShareBps + protocolFeePercent × 100` exceeds `BPS`.
    ///      That sum is what the rebalance + protocol share consume
    ///      from every swap fee; leaving a negative residual to LPs is
    ///      both economically unsound and makes `_tryAutoRepeg`'s
    ///      threshold denominator (`BPS − protocolFeePercent × 100`)
    ///      ≤ 0 — fail fast at deploy time.
    error RepegShareExceedsBudget();
    /// @dev Reverted by the factory when auto-repeg is enabled
    ///      (`repegShareBps != 0`) but `repegStepWad` exceeds the pool's
    ///      fee scale (`feeFloorBps` with a live ramp, flat `baseFee`
    ///      otherwise), read as relative fractions: `step > fee · 1e14`.
    ///      The dead-band pins the first permitted repeg attempt at
    ///      `deviation == repegStepWad`, where the move's LP-unit-value
    ///      cost grows ~quadratically in the deviation while the
    ///      fee-funded budget grows only ~linearly — a step far above
    ///      the fee scale produces a pool whose repeg can NEVER afford
    ///      to fire from its own flow, at any deviation. Since pool
    ///      parameters are immutable, fail fast at deploy time. Skipped
    ///      when `repegShareBps == 0` (step is inert then).
    error RepegThresholdExceedsFeeScale();

    error PoolNotFound();
    error PoolExists();
    error NoWethLeg();
    error NativeValueMismatch();
    error InsufficientLiquidity();
    error InsufficientOutputAmount();
    error ExcessiveInputAmount();
    error SlippageExceeded();
    error InvalidAmountSpecified();
    error DeadlineExpired(uint256 timeDelta);
    error InvalidCallbackSender();
    error Paused();

    error MathInvariantViolation();
    /// @dev Genesis LP unit value is not within `MAX_GENESIS_VP_ERROR_WAD`
    ///      of the exact `2·WAD` identity. This can mean either insufficient
    ///      normalized depth (which proportional seed growth can fix) or an
    ///      extreme reserve ratio that WAD `priceScale` cannot represent
    ///      within policy tolerance (which proportional growth cannot fix).
    ///      Carries the computed value so tooling can distinguish the cases.
    error GenesisVpImprecise(uint256 vpGenesisWad);
    error DivisionByZero();
    error AmountTooSmallAfterNormalization();

    // Periphery payments / ETH handling
    error NotWETH9();
    error InsufficientWETH9();
    error InsufficientToken();

    // ============ Boost curation (factory) ============
    error BoostPoolMismatch();
    error BoostNotBound();

    // ============ Param timelock ============
    /// @dev Pool setter caller is not the factory's param timelock.
    error NotParamTimelock();
    /// @dev Timelock caller is not the registered pool admin.
    error NotPoolAdmin();
    /// @dev Private pool: the mint recipient is not on the factory-held
    ///      LP allowlist of this pool.
    error LpNotAllowed();
    /// @dev LP-allowlist edit aimed at a pool that was not created
    ///      private — public pools have no mint gate to curate.
    error NotPrivatePool();
    /// @dev Timelock admin-handover claimant is not the nominated next admin.
    error NotPendingPoolAdmin();
    /// @dev Timelock registration caller is not the factory.
    error NotFactory();
    /// @dev No change of this kind is queued for the pool.
    error ParamChangeNotQueued();
    /// @dev The queue delay of the change (24 h public pools,
    ///      `PRIVATE_DELAY` private ones) has not elapsed yet.
    error ParamChangeNotReady();
    /// @dev The queued change outlived its grace window and must be
    ///      re-queued.
    error ParamChangeExpired();
    /// @dev Runtime repeg-share changes cannot flip the auto-repeg
    ///      opt-out in either direction: an opted-out pool carries an
    ///      unvalidated (inert) threshold, and disabling repeg would
    ///      freeze the anchor under any wrapper pricing LP through it.
    error RepegShareImmutable();
    /// @dev Queued repeg share is outside the runtime policy band
    ///      or above the protocol-fee budget cap.
    error RepegShareChangeOutOfRange();
}
