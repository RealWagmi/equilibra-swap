// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IEquilibraPool
/// @notice Interface for a 2-token Equilibra hybrid AMM pool.
interface IEquilibraPool {
    // ============ Events ============

    /// @param lpFeeAccrued  LP-owned portion of `feeAmount` folded into
    ///                      the input-side reserve on this swap (i.e.
    ///                      `feeAmount - protocolFeeAmount`). Exposed so
    ///                      off-chain indexers can track LP fee accrual
    ///                      without reconstructing it from
    ///                      virtual-price deltas — the inline-fee model
    ///                      hides this number from reserves.
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

    event LiquidityAdded(
        address indexed sender,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 sharesMinted
    );

    event LiquidityRemoved(
        address indexed sender,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 sharesBurned
    );

    /// @dev Emitted when the auto-repeg gate shifts the pool's price
    ///      scale (token0 per token1 — quote per base, WAD-scaled)
    ///      toward the EMA target.
    event PriceScaleUpdated(
        uint256 oldPriceScale,
        uint256 newPriceScale,
        uint256 oldEmaPrice,
        uint256 newEmaPrice
    );

    event ProtocolFeesCollected(address indexed recipient, uint256 amount0, uint256 amount1);
    event PauseStateChanged(bool paused, address indexed caller);

    /// @notice Runtime fee re-parameterisation committed through the
    ///         factory's param timelock.
    event FeeParamsUpdated(uint16 baseFee, uint16 feeRampBps, uint16 feeFloorBps);
    /// @notice Runtime repeg step-cap change committed through the
    ///         factory's param timelock.
    event RepegStepUpdated(uint256 repegStepWad);
    event RepegThresholdsUpdated(
        uint256 repegThresholdToken1UpWad,
        uint256 repegThresholdToken1DownWad
    );
    /// @notice Runtime repeg-share change committed through the
    ///         factory's param timelock. `repegShareBps` is the
    ///         user-facing share (pre protocol-fee gross-up);
    ///         `epochBaseWad` is the sealed base the closing epoch's
    ///         protected slice ratcheted into.
    event RepegShareUpdated(uint16 repegShareBps, uint256 epochBaseWad);
    /// @notice Runtime donation-parachute multiplier change committed
    ///         through the factory's param timelock.
    event ParachuteBandMultUpdated(uint8 parachuteBandMult);

    /// @dev Emitted whenever a swap commits a strictly positive growth
    ///      of `lpUnitValueWad` (LP unit value, denominated in quote
    ///      WAD). The accumulator never resets, not even on a
    ///      successful auto-repeg — repegs only push the live
    ///      `lpUnitValueWad` checkpoint downward, while
    ///      `lpValueGrowthWad` keeps reflecting all the gain LPs have
    ///      ever booked.
    event LpValueGrowthAccrued(uint256 deltaWad, uint256 totalGrowthWad);

    // ============ Structs ============

    /// @notice Two-knob curve shape captured at deployment.
    /// @dev    `aWad`      — depth at anchor (`A(D=0) = a`). Range
    ///                       `[A_MIN_WAD, A_MAX_WAD]`.
    ///         `lambdaWad` — plateau width (`A = a/2` at `λ·D = W`).
    ///                       Range `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
    ///         Both pinned at deployment and never mutated post-init.
    ///         The cubic kernel is
    ///             K(x, y; L) = A · L · (x+y) / 2 + (W − A) · xy,
    ///             A = a · W / (W + λ · D),
    ///             D = (y − x)² / (xy)
    ///         (math-space coordinates).
    struct CurveParams {
        uint256 aWad;
        uint256 lambdaWad;
    }

    /// @notice Configurable per-pool fee parameters.
    struct FeeConfig {
        uint16 baseFee;
        uint16 feeRampBps;
        uint16 feeFloorBps;
        uint16 repegShareBps;
        uint8 protocolFeePercent;
        /// @notice Price-EMA half-life in seconds — the same units the
        ///         deployer supplied. The pool stores the internal
        ///         relaxation time `tau = ceil(halfLife * 1000 / 694)`;
        ///         `getFeeConfig` maps it back via `tau * 694 / 1000`
        ///         (exact round trip for every valid input).
        uint32 emaPeriod;
        uint256 repegStepWad;
        /// @notice Direction-split auto-repeg dead-bands: `Up` applies
        ///         while `ema > priceScale` (token1's price expressed in
        ///         token0 above the anchor), `Down` while below. Under
        ///         the mainnet address-sort layout with the base asset
        ///         in slot 0, a RISING base market is an internal
        ///         token1-DOWN move.
        uint256 repegThresholdToken1UpWad;
        uint256 repegThresholdToken1DownWad;
        /// @notice Donation-parachute activation multiplier K: the
        ///         parachute opens only at geometric deviation
        ///         ≥ `K × active dead-band`. Seeded at the canonical
        ///         default (`Constants.REPEG_PARACHUTE_BAND_MULT`) for
        ///         every pool — never a creation parameter — and
        ///         runtime-adjustable via the param timelock within
        ///         `[1, 255]`.
        uint8 parachuteBandMult;
    }

    /// @notice Identity / wiring of a deployed pool.
    struct PoolMetadata {
        address token0;
        address token1;
        address factory;
        uint32 pairPoolIndex;
    }

    /// @notice Auto-repeg oracle snapshot.
    /// @dev `priceScaleWad` is the current pool price scale — token0
    ///      per token1 (quote = token0, base = token1), WAD-scaled,
    ///      seeded as `yWad / xWad` with `y = reserve0`, `x = reserve1`;
    ///      `emaPriceWad` is the protected
    ///      EMA spot estimate that drives the repeg activation gate.
    ///      `pMargWad` is the live math-space marginal price under
    ///      the closed-form derivative kernel (1.0 WAD = at-anchor),
    ///      and `sqrtPriceX96` projects the same point into the V3
    ///      Q64.96 representation, clamped into the canonical
    ///      `[MIN_SQRT_RATIO, MAX_SQRT_RATIO − 1]` domain.
    ///      `pMargWad` is authoritative at every state; `sqrtPriceX96`
    ///      is a compatibility adapter — equality with a domain bound
    ///      is a saturation marker, not an exact price (states beyond
    ///      the V3 domain all export the same bound while `pMargWad`
    ///      keeps moving). TickMath-style consumers never revert. Both
    ///      projections are zero only on a degenerate / uninitialised
    ///      pool.
    struct OracleState {
        uint256 priceScaleWad;
        uint256 emaPriceWad;
        uint256 pMargWad;
        uint160 sqrtPriceX96;
    }

    /// @notice LP unit-value accounting snapshot.
    struct LpValueState {
        uint256 unitValueWad;
        /// @dev Epoch base of the repeg gate: the genesis unit value
        ///      until the first runtime share change, then the sealed
        ///      floor of each closed epoch (monotone non-decreasing).
        uint256 genesisWad;
        uint256 growthWad;
    }

    struct InitParams {
        address token0;
        address token1;
        /// @notice Pre-computed decimal-lift scale for `token0`,
        ///         `10**(18 - decimals0)`. Calculated by the factory.
        uint64 token0Scale;
        /// @notice Symmetric `token1Scale = 10**(18 - decimals1)`.
        uint64 token1Scale;
        /// @notice Depth-at-anchor knob (WAD-scaled). Range
        ///         `[A_MIN_WAD, A_MAX_WAD]`.
        uint64 aWad;
        /// @notice Plateau-width knob (WAD-scaled). Range
        ///         `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
        uint64 lambdaWad;
        uint16 baseFee;
        /// @notice Internal EMA relaxation time `tau` in seconds. The
        ///         factory converts the deployer's half-life input
        ///         (`ceil(halfLife * 1000 / 694)`) before initialize;
        ///         the pool stores and uses this value as-is.
        uint32 emaPeriod;
        uint256 repegStepWad;
        /// @notice Direction-split activation dead-bands of the
        ///         auto-repeg (WAD): no repeg attempt while the
        ///         geometric EMA/anchor deviation is below the side's
        ///         band (`Up` for `ema > priceScale`, `Down` below).
        ///         Decoupled from the per-repeg step cap `repegStepWad`.
        uint256 repegThresholdToken1UpWad;
        uint256 repegThresholdToken1DownWad;
        uint8 protocolFeePercent;
        uint32 pairPoolIndex;
        /// @notice Smoothstep dynamic-fee warm-up width, in BPS of WAD.
        ///         `0` disables the dynamic ramp.
        uint16 feeRampBps;
        /// @notice Lower bound of the dynamic fee in BPS. Must satisfy
        ///         `feeFloorBps <= baseFee`.
        uint16 feeFloorBps;
        /// @notice Fraction of cumulative LP unit-value growth the
        ///         auto-repeg gate may spend. Clamped to
        ///         `MAX_REPEG_SHARE_BPS` and to `BPS −
        ///         protocolFeePercent · 100` by the factory.
        uint16 repegShareBps;
        /// @notice Private pool: every mint's recipient must sit on the
        ///         pool's LP allowlist, held by the factory and curated
        ///         by the pool admin. Immutable after {initialize}.
        bool isPrivate;
        string lpName;
        string lpSymbol;
    }

    // ============ Initialization ============

    function initialize(InitParams calldata params) external;

    // ============ Swaps ============

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function quoteExactIn(
        bool zeroForOne,
        uint256 amountIn
    ) external view returns (uint256 amountOut);

    function quoteExactOut(
        bool zeroForOne,
        uint256 amountOut
    ) external view returns (uint256 amountIn);

    // ============ Liquidity ============

    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        bytes calldata data
    ) external returns (uint256 sharesOut);

    function removeLiquidity(
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    // NOTE: donating = a plain LP `transfer` to the pool's own address;
    // the pool exposes no donation entrypoint. The guarded variant
    // (maxSupply pin + deadline) is `EquilibraRouter.donate`.

    // ============ Admin / protocol ============

    function collectProtocolFees(
        address recipient
    ) external returns (uint256 amount0, uint256 amount1);

    function setPaused(bool paused_) external;

    // ============ Runtime parameters (param timelock only) ============
    // The runtime-adjustable set is deliberately minimal: the dynamic
    // fee triple, the repeg step cap, the repeg share, the direction-
    // split dead-bands and the parachute band multiplier. Everything
    // else stays immutable for the pool's lifetime — the curve knobs
    // (`aWad`, `lambdaWad`) define the product LPs bought into, the
    // EMA period is the oracle's manipulation-resistance parameter and
    // `protocolFeePercent` is the protocol's economic term. The
    // direction-split repeg dead-bands are adjustable; the stall guard
    // that fee changes are validated against re-checks BOTH stored
    // bands.
    //
    // The setters are bare stores gated to the factory's param
    // timelock: every invariant and policy check lives in
    // `EquilibraParamTimelock` (queue time AND execution time) — the
    // same trust split as `initialize`, where the factory validates
    // and the pool stores. Keeping validation out of the pool
    // preserves its scarce bytecode headroom.

    /// @notice Re-parameterise the dynamic fee. Param timelock only;
    ///         validated by the timelock before the call.
    function setFeeParams(uint16 baseFee_, uint16 feeRampBps_, uint16 feeFloorBps_) external;

    /// @notice Change the per-repeg step cap (commits are spaced at
    ///         least one block AND one second apart). Param timelock
    ///         only; validated by the timelock before the call.
    function setRepegStepWad(uint64 repegStepWad_) external;

    /// @notice Change the direction-split repeg dead-bands. Param
    ///         timelock only; validated by the timelock before the call.
    function setRepegThresholds(
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) external;

    /// @notice Change the repeg share (user-facing BPS, re-scaled
    ///         internally for protocol-fee compensation). Param
    ///         timelock only; validated by the timelock before the
    ///         call. Epoch semantics: the change first SEALS the
    ///         closing epoch under the outgoing share — its protected
    ///         growth slice ratchets into the base (`genesisWad`)
    ///         forever and the growth accumulator restarts — so the
    ///         incoming share splits only future earnings and the
    ///         live spendable budget carries over untouched. No share
    ///         change is retroactive in either direction.
    function setRepegShareBps(uint16 repegShareBps_) external;

    /// @notice Change the donation-parachute activation multiplier K
    ///         (parachute opens at deviation ≥ `K × active dead-band`).
    ///         Param timelock only; the `[1, 255]` range is validated
    ///         by the timelock before the call. Inert on pools with
    ///         `repegShareBps == 0` (the parachute is unreachable).
    function setParachuteBandMult(uint8 parachuteBandMult_) external;

    // ============ Views ============

    /// @notice Returns the two-knob curve shape `(aWad, lambdaWad)`.
    function getCurveParams() external view returns (CurveParams memory);

    function getFeeConfig() external view returns (FeeConfig memory);

    function getPoolMetadata() external view returns (PoolMetadata memory);

    function getOracleState() external view returns (OracleState memory);

    /// @notice Last-update timestamps of the EMA and the auto-repeg
    ///         anchor, exposed so external consumers can gauge oracle
    ///         freshness (e.g. an anchor-lag detector) without reading
    ///         raw storage slots by index — which a storage-layout
    ///         change would silently break.
    /// @return lastEmaTs   Block timestamp of the most recent EMA update
    ///                     (`_lastEmaTs`); the stored `emaPriceWad` is as
    ///                     of this time.
    /// @return lastRepegTs Block timestamp of the most recent committed
    ///                     auto-repeg (`_lastRepegTs`); `priceScaleWad`
    ///                     has not moved since.
    function getOracleTimestamps() external view returns (uint64 lastEmaTs, uint64 lastRepegTs);

    /// @notice Whether the pool's reentrancy guard is currently held,
    ///         i.e. execution is inside a `swap` / `addLiquidity` /
    ///         `removeLiquidity` / `collectProtocolFees` frame (typically
    ///         observed from within a pool callback).
    /// @dev Read-only-reentrancy shield for consumers that value the LP
    ///      token from LIVE reserves + supply: mid-mint the reserves are
    ///      already bumped while `_mint` has not run (and mid-swap the
    ///      input tokens have not arrived), so a `getReserves()` /
    ///      `totalSupply()` pair read during a guarded frame is
    ///      internally inconsistent and can be manipulated. Such a
    ///      consumer MUST revert when this returns `true`. The incumbent
    ///      latched-`unitValueWad` oracle did not need it; a fair-value
    ///      oracle that recomputes from reserves does.
    function reentrancyGuardEntered() external view returns (bool entered);

    function getLiveEmaPrice() external view returns (uint256 emaPriceWad);

    function getLpValueState() external view returns (LpValueState memory);

    function getReserves() external view returns (uint256 reserve0, uint256 reserve1);

    function getProtocolFees() external view returns (uint256 fee0, uint256 fee1);

    function paused() external view returns (bool);

    /// @notice Off-chain bisection over the gross `amountIn` toward the
    ///         marginal price `sqrtPriceTargetX96`.
    /// @dev One-sided guarantee, unconditional: the returned `amountIn`
    ///      NEVER moves the price past the target. Landing within the
    ///      tolerance `max(pTarget/1e8, pTarget·protocolFeePercent/1e6)`
    ///      from below (the second term is the fee-quantization noise
    ///      floor) additionally holds ONLY when the target was bracketed
    ///      before the search cap below — a capped sweep can stop
    ///      arbitrarily far from the target. `(0, 0,
    ///      false)` means "no admissible amount": the target is zero /
    ///      behind the current price / unreachable without crossing it
    ///      (even 1 wei of input overshoots), or the pool is degenerate.
    ///      Every target across the canonical sqrt-ratio domain
    ///      `[MIN_SQRT_RATIO, MAX_SQRT_RATIO)` decodes: the endpoints
    ///      saturate to the extreme representable prices, so naming one
    ///      as an unbounded sweep bound quotes the CAPPED sweep in that
    ///      direction — the search maximum below, not necessarily the
    ///      largest economically executable swap (and `(0, 0, false)`
    ///      on the opposite one, which is a wrong-direction target).
    ///      The search is best-effort: the probed input is capped at
    ///      ~99% of the input-side reserve, and a target that needs
    ///      more input than the cap returns the capped sweep — the
    ///      same tuple shape as a target-reaching quote, with no
    ///      reached-flag. An `amountIn` at the cap is therefore
    ///      inconclusive about reaching the target. `crossesAnchor` is
    ///      a property of the REQUESTED target relative to the start
    ///      price, not of the possibly-capped result.
    ///      Exotic decimal
    ///      scales or probe sizes beyond available liquidity may still
    ///      revert with math errors instead of returning zeros —
    ///      callers wanting a total function should wrap the call in
    ///      try/catch.
    function quoteSwapToPrice(
        bool zeroForOne,
        uint160 sqrtPriceTargetX96
    ) external view returns (uint256 amountIn, uint256 amountOut, bool crossesAnchor);

    function getStorageSlots(
        uint256[] calldata slots
    ) external view returns (bytes32[] memory data);
}
