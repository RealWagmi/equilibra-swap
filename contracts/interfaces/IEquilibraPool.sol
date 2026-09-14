// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IEquilibraPool
 * @notice Interface of a two-token Equilibra pool: V3-style callback swaps, proportional
 * liquidity, a geometric price EMA and an auto-repeg of the price anchor.
 */
interface IEquilibraPool {
    // ============ Events ============

    /**
     * @notice Emitted on every executed swap.
     * @param sender Caller of `swap` (the contract that received the swap callback).
     * @param recipient Receiver of the output token.
     * @param zeroForOne True when token0 is the input token.
     * @param amountIn Gross raw input, fee included.
     * @param amountOut Raw output paid to `recipient`.
     * @param feeAmount Total raw fee taken from the input.
     * @param protocolFeeAmount Protocol slice of `feeAmount`.
     * @param priceScale Anchor in force after the swap (token0 per token1, WAD).
     * @param lpFeeAccrued LP-owned slice of the fee, `feeAmount - protocolFeeAmount`, folded into
     * the input-side reserve.
     */
    event Swap(
        address indexed sender,
        address indexed recipient,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 protocolFeeAmount,
        uint256 priceScale,
        uint256 lpFeeAccrued
    );

    /**
     * @notice Emitted when liquidity is added.
     * @param sender Caller of `addLiquidity` (the contract that received the mint callback).
     * @param recipient Receiver of the minted shares.
     * @param amount0 Raw token0 deposited.
     * @param amount1 Raw token1 deposited.
     * @param sharesMinted Shares minted to `recipient`.
     */
    event LiquidityAdded(
        address indexed sender,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 sharesMinted
    );

    /**
     * @notice Emitted when liquidity is removed.
     * @param sender Caller of `removeLiquidity`; the burned shares are taken from it.
     * @param recipient Receiver of both tokens.
     * @param amount0 Raw token0 paid out.
     * @param amount1 Raw token1 paid out.
     * @param sharesBurned Shares burned from `sender`.
     */
    event LiquidityRemoved(
        address indexed sender,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 sharesBurned
    );

    /**
     * @notice Emitted when the auto-repeg moves the anchor (token0 per token1, WAD) toward the EMA.
     * @param oldPriceScale Anchor before the move.
     * @param newPriceScale Anchor after the move.
     * @param oldEmaPrice EMA before this swap's oracle update.
     * @param newEmaPrice EMA after this swap's oracle update.
     */
    event PriceScaleUpdated(
        uint256 oldPriceScale,
        uint256 newPriceScale,
        uint256 oldEmaPrice,
        uint256 newEmaPrice
    );

    /**
     * @notice Emitted when the fee collector withdraws the accrued protocol fees.
     * @param recipient Receiver of the fees.
     * @param amount0 Raw token0 withdrawn.
     * @param amount1 Raw token1 withdrawn.
     */
    event ProtocolFeesCollected(address indexed recipient, uint256 amount0, uint256 amount1);

    /**
     * @notice Emitted when the factory owner changes the pause state.
     * @param paused Whether swaps and new liquidity are blocked.
     * @param stopped Whether the pause is permanent.
     * @param caller Factory owner that made the change.
     */
    event PauseStateChanged(bool paused, bool stopped, address indexed caller);

    /**
     * @notice Emitted when the param timelock commits a new dynamic-fee triple.
     * @param baseFee Fee ceiling in bps.
     * @param feeRampBps Smoothstep ramp width in bps of WAD; zero disables the ramp.
     * @param feeFloorBps Fee floor in bps; ignored while the ramp is disabled.
     */
    event FeeParamsUpdated(uint16 baseFee, uint16 feeRampBps, uint16 feeFloorBps);

    /**
     * @notice Emitted when the param timelock commits a new per-repeg step cap.
     * @param repegStepWad Log-domain step cap, WAD.
     */
    event RepegStepUpdated(uint256 repegStepWad);

    /**
     * @notice Emitted when the param timelock commits new direction-split dead-bands.
     * @param repegThresholdToken1UpWad Activation band while `ema > priceScale`, WAD.
     * @param repegThresholdToken1DownWad Activation band while `ema < priceScale`, WAD.
     */
    event RepegThresholdsUpdated(
        uint256 repegThresholdToken1UpWad,
        uint256 repegThresholdToken1DownWad
    );

    /**
     * @notice Emitted when the param timelock commits a new repeg share.
     * @param repegShareBps User-facing share in bps, before the protocol-fee gross-up.
     * @param epochBaseWad Sealed gate base after the closing epoch's protected slice was ratcheted
     * into it.
     */
    event RepegShareUpdated(uint16 repegShareBps, uint256 epochBaseWad);

    /**
     * @notice Emitted when the param timelock commits a new donation-parachute multiplier.
     * @param parachuteBandMult Multiplier K applied to the active dead-band.
     */
    event ParachuteBandMultUpdated(uint8 parachuteBandMult);

    /**
     * @notice Emitted when a swap books strictly positive growth of the LP unit value.
     * @dev The accumulator never resets; a successful repeg lowers the live unit value only.
     * @param deltaWad Growth booked by this swap, WAD.
     * @param totalGrowthWad Cumulative growth booked over the pool's lifetime, WAD.
     */
    event LpValueGrowthAccrued(uint256 deltaWad, uint256 totalGrowthWad);

    // ============ Structs ============

    /**
     * @notice Immutable two-knob curve shape.
     * @dev Kernel `K(x, y; L) = A·L·(x+y)/2 + (W - A)·xy` with `A = a·W/(W + λ·D)` and
     * `D = (y - x)²/(xy)` in math-space coordinates. `aWad` is the depth at the anchor
     * (`A(D = 0) = a`), range `[A_MIN_WAD, A_MAX_WAD]`; `lambdaWad` is the plateau width
     * (`A = a/2` at `λ·D = W`), range `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
     */
    struct CurveParams {
        uint256 aWad;
        uint256 lambdaWad;
    }

    /**
     * @notice Per-pool fee and repeg configuration as returned by `getFeeConfig`.
     */
    struct FeeConfig {
        /// Fee ceiling in bps.
        uint16 baseFee;
        /// Smoothstep ramp width in bps of WAD; zero disables the ramp.
        uint16 feeRampBps;
        /// Fee floor in bps; ignored while the ramp is disabled.
        uint16 feeFloorBps;
        /// User-facing repeg share in bps, before the protocol-fee gross-up.
        uint16 repegShareBps;
        /// Protocol slice of every fee, in percent.
        uint8 protocolFeePercent;
        /// Price-EMA half-life in seconds. The pool stores `tau = ceil(halfLife * 1000 / 694)`
        /// and maps it back with `tau * 694 / 1000`, an exact round trip for every valid input.
        uint32 emaPeriod;
        /// Per-repeg log-domain step cap, WAD.
        uint256 repegStepWad;
        /// Activation dead-band while `ema > priceScale` (token1 priced in token0 above the
        /// anchor), WAD. With the base asset in slot 0 a rising base market is a token1-DOWN move.
        uint256 repegThresholdToken1UpWad;
        /// Activation dead-band while `ema < priceScale`, WAD.
        uint256 repegThresholdToken1DownWad;
        /// Donation-parachute multiplier K: the parachute opens at a geometric deviation of at
        /// least `K × active dead-band`. Seeded with `Constants.REPEG_PARACHUTE_BAND_MULT`,
        /// adjustable through the param timelock within `[1, 255]`.
        uint8 parachuteBandMult;
    }

    /**
     * @notice Identity of a deployed pool.
     */
    struct PoolMetadata {
        address token0;
        address token1;
        address factory;
        /// Pair-local index assigned by the factory.
        uint32 pairPoolIndex;
    }

    /**
     * @notice Oracle snapshot.
     * @dev `priceScaleWad` is the anchor, token0 per token1 in WAD, seeded as `yWad / xWad` with
     * `y = reserve0` and `x = reserve1`. `emaPriceWad` is the protected geometric EMA decoded from
     * its stored logarithm and floored at one WAD unit. `pMargWad` is the live math-space marginal
     * price (1.0 WAD at the anchor) and is authoritative at every state. `sqrtPriceX96` is the same
     * point in Uniswap V3 Q64.96 form clamped into `[MIN_SQRT_RATIO, MAX_SQRT_RATIO - 1]`; a value
     * equal to a bound marks saturation, not an exact price. Both projections are zero only on an
     * uninitialised pool.
     */
    struct OracleState {
        uint256 priceScaleWad;
        uint256 emaPriceWad;
        uint256 pMargWad;
        uint160 sqrtPriceX96;
    }

    /**
     * @notice LP unit-value accounting snapshot, all values in WAD.
     */
    struct LpValueState {
        /// Live LP unit value.
        uint256 unitValueWad;
        /// Repeg-gate base: the genesis unit value until the first runtime share change, then the
        /// sealed floor of each closed epoch. Monotone non-decreasing.
        uint256 genesisWad;
        /// Cumulative unit-value growth booked by swaps; never decremented.
        uint256 growthWad;
    }

    /**
     * @notice Initialisation words prepared and validated by the factory.
     * @dev Each packed word is stored verbatim into the matching pool storage slot, so its layout
     * must follow the pool's storage declaration order.
     */
    struct InitParams {
        address token0;
        address token1;
        /// Fee fields in the low 88 bits; stored above the factory address. Top 8 bits are zero.
        uint96 feeConfigBits;
        /// Token scales, pair index, parachute default and fee ramp.
        uint256 scaleRampConfig;
        /// `aWad`, `lambdaWad` and the downward dead-band.
        uint256 curveConfig;
        /// Genesis timestamps, step cap and the upward dead-band.
        uint256 repegConfig;
        bool isPrivate;
        string lpName;
        string lpSymbol;
    }

    // ============ Initialization ============

    /**
     * @notice Initialise a freshly cloned pool. Callable once, by the factory only.
     * @param params Packed configuration prepared by the factory.
     */
    function initialize(InitParams calldata params) external;

    // ============ Swaps ============

    /**
     * @notice Execute an exact-input (`amountSpecified > 0`) or exact-output (`< 0`) swap.
     * @dev The output token is sent first; the caller must then pay the exact required raw input
     * inside `equilibraSwapCallback`. Amounts come from the same checked resolver as the quotes,
     * including the output margin and the strict post-fee LP-depth guard, evaluated before any
     * repeg. Reverts while paused.
     * @param recipient Receiver of the output token.
     * @param zeroForOne True to sell token0 for token1.
     * @param amountSpecified Raw input when positive, raw output when negative.
     * @param data Opaque payload forwarded to the swap callback.
     * @return amount0 Signed raw token0 delta: positive is owed to the pool, negative is paid out.
     * @return amount1 Signed raw token1 delta with the same convention.
     */
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    /**
     * @notice Quote the raw output for a gross raw input, fee included.
     * @dev Matches exact-input settlement on the same state. A positive fee rate charges at least
     * one raw input unit; an input consumed entirely by the fee reverts as dust. The secant solver
     * exits only on an exact or unchanged counterpart; at the 40-iteration cap the best residual
     * must certify within 0.0001% or the call reverts `SolverDidNotConverge`. Every positive
     * solver output loses `max(1, floor(output / 1e8))` math units once before native conversion.
     * Reverts `LpValueDecreased` when the post-fee Q128 depth (LP fees included, protocol cut
     * excluded) drops, and `MathOutOfRange` when an invariant-weight product overflows, trial
     * states included. Valid curve parameters do not guarantee that every amount is quotable.
     * @param zeroForOne True to sell token0 for token1.
     * @param amountIn Gross raw input.
     * @return amountOut Raw output.
     */
    function quoteExactIn(
        bool zeroForOne,
        uint256 amountIn
    ) external view returns (uint256 amountOut);

    /**
     * @notice Quote the gross raw input required for a requested raw output.
     * @dev Matches exact-output settlement on the same state with the same solver exits and
     * cap check. The solver targets `requested + max(1, floor(requested / 99999999))` math
     * units, the integer inverse of the exact-input margin, then applies native conversion and
     * the fee gross-up; settlement pays the requested output. A positive rate charges at least
     * one raw input unit before the separate +1 raw safety bump. A trial output at or above the
     * reserve reverts `InsufficientLiquidity`; `LpValueDecreased`, `SolverDidNotConverge` and
     * `MathOutOfRange` apply as for `quoteExactIn`. Independent exact-in and exact-out quotes are
     * not guaranteed to invert each other exactly.
     * @param zeroForOne True to sell token0 for token1.
     * @param amountOut Requested raw output.
     * @return amountIn Gross raw input.
     */
    function quoteExactOut(
        bool zeroForOne,
        uint256 amountOut
    ) external view returns (uint256 amountIn);

    // ============ Liquidity ============

    /**
     * @notice Add liquidity; the caller must deposit the used amounts inside
     * `equilibraMintCallback`.
     * @dev The first deposit seeds the anchor as `yWad / xWad`. Public pools require the seeded
     * anchor strictly inside
     * `(MIN_PUBLIC_INITIAL_PRICE_SCALE_WAD, MAX_PUBLIC_INITIAL_PRICE_SCALE_WAD)`; private pools
     * only require a positive anchor inside the numeric domain. Later deposits
     * price shares on token0 and round the matching token1 up; when the token1 maximum binds,
     * token0 rounds down. Neither maximum is exceeded. Reverts while paused.
     * @param amount0 Maximum raw token0 to deposit.
     * @param amount1 Maximum raw token1 to deposit.
     * @param minShares Minimum shares to mint, otherwise reverts.
     * @param recipient Receiver of the shares; must be allowlisted on a private pool.
     * @param data Opaque payload forwarded to the mint callback.
     * @return sharesOut Shares minted.
     */
    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        bytes calldata data
    ) external returns (uint256 sharesOut);

    /**
     * @notice Burn shares for a proportional payout of both tokens. Callable while paused or
     * permanently stopped.
     * @dev Payouts use the recorded reserves. A stopped pool skips LP-value reanchoring and the
     * post-transfer solvency check, so its cached LP metrics go stale and, under a token
     * deficit, exits are served first come first served.
     * @param shares Shares to burn from the caller.
     * @param minAmount0 Minimum raw token0 to receive, otherwise reverts.
     * @param minAmount1 Minimum raw token1 to receive, otherwise reverts.
     * @param recipient Receiver of both tokens.
     * @return amount0 Raw token0 paid out.
     * @return amount1 Raw token1 paid out.
     */
    function removeLiquidity(
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    // A donation is a plain LP transfer to the pool's own address; the guarded variant with a
    // supply pin and deadline is `EquilibraRouter.donate`.

    // ============ Admin / protocol ============

    /**
     * @notice Withdraw the accrued protocol fees. Fee collector only.
     * @param recipient Receiver of both tokens.
     * @return amount0 Raw token0 withdrawn.
     * @return amount1 Raw token1 withdrawn.
     */
    function collectProtocolFees(
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    /**
     * @notice Pause or resume the pool, or stop it permanently with `(true, true)`. Factory owner
     * only.
     * @dev `(false, true)` reverts `InvalidPauseState`. Once stopped, further calls are silent
     * no-ops and a new factory owner cannot undo the stop.
     * @param paused_ Whether swaps and new liquidity are blocked.
     * @param stopped_ Whether the pause is permanent.
     */
    function setPaused(bool paused_, bool stopped_) external;

    // ============ Runtime parameters (param timelock only) ============
    // Adjustable: the dynamic-fee triple, the repeg step cap, the repeg share, the direction-split
    // dead-bands and the parachute multiplier. `aWad`, `lambdaWad`, `emaPeriod` and
    // `protocolFeePercent` are immutable. The setters are bare stores; every bound and policy
    // check runs in `EquilibraParamTimelock` at queue and execution time.

    /**
     * @notice Store a new dynamic-fee triple. Param timelock only; validated by the timelock.
     * @param baseFee_ Fee ceiling in bps.
     * @param feeRampBps_ Ramp width in bps of WAD; zero disables the ramp.
     * @param feeFloorBps_ Fee floor in bps; ignored while the ramp is disabled.
     */
    function setFeeParams(uint16 baseFee_, uint16 feeRampBps_, uint16 feeFloorBps_) external;

    /**
     * @notice Store a new per-repeg step cap. Param timelock only; validated by the timelock.
     * @param repegStepWad_ Log-domain step cap, WAD.
     */
    function setRepegStepWad(uint64 repegStepWad_) external;

    /**
     * @notice Store new direction-split dead-bands. Param timelock only; validated by the timelock.
     * @param repegThresholdToken1UpWad_ Activation band while `ema > priceScale`, WAD.
     * @param repegThresholdToken1DownWad_ Activation band while `ema < priceScale`, WAD.
     */
    function setRepegThresholds(
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) external;

    /**
     * @notice Store a new repeg share. Param timelock only; validated by the timelock.
     * @dev The closing epoch is sealed first: its protected growth slice ratchets into the gate
     * base and the growth accumulator restarts, so the new share splits future earnings only and
     * the live spendable budget carries over unchanged.
     * @param repegShareBps_ User-facing share in bps; stored grossed up for the protocol fee.
     */
    function setRepegShareBps(uint16 repegShareBps_) external;

    /**
     * @notice Store a new donation-parachute multiplier. Param timelock only; validated by the
     * timelock within `[1, 255]`. Inert on pools with `repegShareBps == 0`.
     * @param parachuteBandMult_ Multiplier K applied to the active dead-band.
     */
    function setParachuteBandMult(uint8 parachuteBandMult_) external;

    // ============ Views ============

    /**
     * @notice Return the curve shape.
     * @return The `(aWad, lambdaWad)` pair.
     */
    function getCurveParams() external view returns (CurveParams memory);

    /**
     * @notice Return the fee and repeg configuration in user-facing units.
     * @return The configuration with `emaPeriod` as a half-life and `repegShareBps` before the
     * protocol-fee gross-up.
     */
    function getFeeConfig() external view returns (FeeConfig memory);

    /**
     * @notice Return the pool's tokens, factory and pair-local index.
     * @return The metadata struct.
     */
    function getPoolMetadata() external view returns (PoolMetadata memory);

    /**
     * @notice Return the current anchor without computing the marginal price or depth.
     * @return priceScaleWad Anchor, token0 per token1, WAD.
     */
    function getPriceScale() external view returns (uint256 priceScaleWad);

    /**
     * @notice Return the oracle snapshot: anchor, EMA, marginal price and its V3 projection.
     * @return The snapshot; see `OracleState` for the semantics of each field.
     */
    function getOracleState() external view returns (OracleState memory);

    /**
     * @notice Return the last-update timestamps of the EMA and of the anchor.
     * @return lastEmaTs Block timestamp of the most recent EMA update.
     * @return lastRepegTs Block timestamp of the most recent committed repeg.
     */
    function getOracleTimestamps() external view returns (uint64 lastEmaTs, uint64 lastRepegTs);

    /**
     * @notice Whether execution is currently inside a guarded frame (`swap`, `addLiquidity`,
     * `removeLiquidity` or `collectProtocolFees`), typically observed from a pool callback.
     * @dev Consumers that value LP shares from live reserves and supply must revert while this
     * returns true: inside a frame the reserves and the supply are not mutually consistent.
     * @return entered True while the reentrancy guard is held.
     */
    function reentrancyGuardEntered() external view returns (bool entered);

    /**
     * @notice Return the EMA as it would read after an update at the current block, computed from
     * the live marginal price without writing state.
     * @return emaPriceWad Projected EMA, token0 per token1, WAD.
     */
    function getLiveEmaPrice() external view returns (uint256 emaPriceWad);

    /**
     * @notice Return the LP unit-value accounting snapshot.
     * @return The snapshot; see `LpValueState`.
     */
    function getLpValueState() external view returns (LpValueState memory);

    /**
     * @notice Return the clean reserves, excluding the protocol-fee buckets.
     * @return reserve0 Raw token0 reserve.
     * @return reserve1 Raw token1 reserve.
     */
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1);

    /**
     * @notice Return the accrued, not yet collected protocol fees.
     * @return fee0 Raw token0 fees.
     * @return fee1 Raw token1 fees.
     */
    function getProtocolFees() external view returns (uint256 fee0, uint256 fee1);

    /**
     * @notice Return the reversible pause flag and the permanent stop flag.
     * @return paused_ Whether swaps and new liquidity are blocked.
     * @return stopped_ Whether the pause is permanent; implies `paused_`.
     */
    function paused() external view returns (bool paused_, bool stopped_);

    /**
     * @notice Read raw storage slots for off-chain observability.
     * @param slots Storage slot indexes to read.
     * @return data The word stored in each requested slot, in order.
     */
    function getStorageSlots(
        uint256[] calldata slots
    ) external view returns (bytes32[] memory data);
}
