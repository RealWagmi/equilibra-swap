// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Errors
 * @notice Shared custom errors of the Equilibra contracts.
 */
library Errors {
    // ============ Solver and LP guard ============

    /**
     * @notice The counterpart solver exhausted its iteration budget without a certified result.
     */
    error SolverDidNotConverge();
    /**
     * @notice Post-fee depth at the unchanged anchor is below the fresh pre-swap depth.
     */
    error LpValueDecreased();

    // ============ Generic arguments and roles ============

    /**
     * @notice An address argument, recipient or LP transfer target is the zero address.
     */
    error ZeroAddress();
    /**
     * @notice An amount, share or input argument is zero.
     */
    error ZeroAmount();
    /**
     * @notice Both tokens of a pair are the same address.
     */
    error IdenticalTokens();
    /**
     * @notice The pool has already been initialised.
     */
    error AlreadyInitialized();
    /**
     * @notice The caller lacks the required role (factory owner or fee collector).
     */
    error Unauthorized();
    /**
     * @notice The requested output token is not a member of the resolved pool.
     */
    error UnsupportedToken();
    /**
     * @notice A callback deposit did not change the pool balance by exactly the amount owed
     * (fee-on-transfer or rebasing tokens are not supported).
     */
    error UnsupportedTokenBehavior();
    /**
     * @notice A token reports more than `MAX_TOKEN_DECIMALS` decimals.
     */
    error TokenDecimalsTooLarge();

    // ============ Pool configuration ============

    /**
     * @notice `baseFee` is outside `[MIN_BASE_FEE, MAX_BASE_FEE]`.
     */
    error InvalidFee();
    /**
     * @notice The protocol fee percent exceeds `MAX_PROTOCOL_FEE`.
     */
    error InvalidProtocolFee();
    /**
     * @notice The EMA half-life is below the pool class minimum or its relaxation time exceeds
     * `MAX_EMA_PERIOD`.
     */
    error InvalidEmaPeriod();
    /**
     * @notice `aWad` (depth-at-anchor knob) is outside `[A_MIN_WAD, A_MAX_WAD]`.
     */
    error InvalidA();
    /**
     * @notice `lambdaWad` (plateau-width knob) is outside `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
     */
    error InvalidLambda();
    /**
     * @notice A price scale is zero or outside the admissible range (public genesis bounds or
     * the numeric domain).
     */
    error InvalidPriceScale();
    /**
     * @notice The repeg step cap is outside `[MIN_REPEG_STEP, MAX_REPEG_STEP]`.
     */
    error InvalidRepegStep();
    /**
     * @notice A timelocked step change is more than double or less than half the live value.
     */
    error RepegStepChangeTooLarge();
    /**
     * @notice A repeg dead-band is outside `[1, WAD)`.
     */
    error InvalidRepegThreshold();
    /**
     * @notice A timelocked threshold or step update would leave a band above the step cap.
     */
    error RepegThresholdExceedsStep();
    /**
     * @notice The donation-parachute multiplier is zero.
     */
    error InvalidParachuteBandMult();
    /**
     * @notice `feeRampBps` exceeds `MAX_FEE_RAMP_BPS`.
     */
    error InvalidFeeRamp();
    /**
     * @notice A live ramp's floor is outside `[1, baseFee)`.
     */
    error InvalidFeeFloor();
    /**
     * @notice A live ramp is too narrow for its fee span and ceiling:
     * `feeRampBps * (BPS - baseFee)^2 < FEE_RAMP_GUARD_MULT * BPS * (baseFee - feeFloorBps)^2`.
     * On such a ramp a larger exact-in trade would return less output over whole input intervals.
     */
    error FeeRampTooNarrow();
    /**
     * @notice `repegShareBps` exceeds `MAX_REPEG_SHARE_BPS`.
     */
    error InvalidRepegShare();
    /**
     * @notice `repegShareBps + protocolFeePercent * 100` exceeds `BPS`, which would leave a
     * negative LP residual and a non-positive repeg-gate denominator.
     */
    error RepegShareExceedsBudget();

    // ============ Factory registry, swaps and liquidity ============

    /**
     * @notice The pool is not registered for the pair.
     */
    error PoolNotFound();
    /**
     * @notice The pool is already whitelisted for the pair.
     */
    error PoolExists();
    /**
     * @notice Native value was attached but neither token of the pool is WETH9.
     */
    error NoWethLeg();
    /**
     * @notice Attached native value does not equal the WETH9 leg amount.
     */
    error NativeValueMismatch();
    /**
     * @notice The pool cannot serve the request: a zero reserve or depth, or an output at or
     * above the reserve.
     */
    error InsufficientLiquidity();
    /**
     * @notice The delivered output is below the caller's minimum or differs from the quoted
     * amount.
     */
    error InsufficientOutputAmount();
    /**
     * @notice The required input exceeds the caller's maximum.
     */
    error ExcessiveInputAmount();
    /**
     * @notice A minimum-output, minimum-shares or supply-pin check failed.
     */
    error SlippageExceeded();
    /**
     * @notice `amountSpecified` is zero or its magnitude exceeds `uint128`.
     */
    error InvalidAmountSpecified();
    /**
     * @notice The transaction deadline has passed.
     * @param timeDelta Seconds elapsed since the deadline.
     */
    error DeadlineExpired(uint256 timeDelta);
    /**
     * @notice A pool callback did not come from the expected pool address.
     */
    error InvalidCallbackSender();
    /**
     * @notice The pool is paused.
     */
    error Paused();
    /**
     * @notice `setPaused(false, true)` was requested; a stop implies a pause.
     */
    error InvalidPauseState();

    // ============ Math ============

    /**
     * @notice An arithmetic precondition the parameter envelope guarantees was violated.
     */
    error MathInvariantViolation();
    /**
     * @notice An invariant-weight product or squared distance exceeds uint256.
     */
    error MathOutOfRange();
    /**
     * @notice The genesis LP unit value is not within `MAX_GENESIS_VP_ERROR_WAD` of the exact
     * `2 * WAD` identity: either insufficient normalised depth (which proportional seed growth
     * can fix) or a reserve ratio the WAD price scale cannot represent (which it cannot).
     * @param vpGenesisWad The computed genesis unit value, WAD.
     */
    error GenesisVpImprecise(uint256 vpGenesisWad);
    /**
     * @notice The marginal-price denominator is zero.
     */
    error DivisionByZero();
    /**
     * @notice An amount rounds to zero after normalisation, fees or the output margin.
     */
    error AmountTooSmallAfterNormalization();

    // ============ Periphery payments ============

    /**
     * @notice Native ETH was sent to the router by an account other than WETH9.
     */
    error NotWETH9();
    /**
     * @notice The router's WETH9 balance is below the requested minimum.
     */
    error InsufficientWETH9();
    /**
     * @notice The router's token balance is below the requested minimum.
     */
    error InsufficientToken();

    // ============ Boost curation (factory) ============

    /**
     * @notice The Boost vault wraps a different pool.
     */
    error BoostPoolMismatch();
    /**
     * @notice No Boost stack is bound to the pool.
     */
    error BoostNotBound();

    // ============ Param timelock ============

    /**
     * @notice A pool setter caller is not the factory's param timelock.
     */
    error NotParamTimelock();
    /**
     * @notice The timelock caller is not the registered pool admin.
     */
    error NotPoolAdmin();
    /**
     * @notice Private pool: the mint recipient is not on the factory-held LP allowlist.
     */
    error LpNotAllowed();
    /**
     * @notice An LP-allowlist edit targets a pool that was not created private.
     */
    error NotPrivatePool();
    /**
     * @notice The admin-handover claimant is not the nominated next admin.
     */
    error NotPendingPoolAdmin();
    /**
     * @notice The timelock registration caller is not the factory.
     */
    error NotFactory();
    /**
     * @notice No change of this kind is queued for the pool.
     */
    error ParamChangeNotQueued();
    /**
     * @notice The queue delay (`DELAY` for public pools, `PRIVATE_DELAY` for private ones) has
     * not elapsed.
     */
    error ParamChangeNotReady();
    /**
     * @notice The queued change outlived its grace window and must be re-queued.
     */
    error ParamChangeExpired();
    /**
     * @notice Runtime repeg-share changes cannot flip the auto-repeg opt-out: a pool created with
     * share zero stays opted out.
     */
    error RepegShareImmutable();
    /**
     * @notice The queued repeg share is outside the runtime policy band or above the
     * protocol-fee budget cap.
     */
    error RepegShareChangeOutOfRange();
}
