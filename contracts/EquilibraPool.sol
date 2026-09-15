// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 *
 *    /  |  _  /  | /      \  /      \ /  \     /  |/      |
 *    $$ | / \ $$ |/$$$$$$  |/$$$$$$  |$$  \   /$$ |$$$$$$/
 *    $$ |/$  \$$ |$$ |__$$ |$$ | _$$/ $$$  \ /$$$ |  $$ |
 *    $$ /$$$  $$ |$$    $$ |$$ |/    |$$$$  /$$$$ |  $$ |
 *    $$ $$/$$ $$ |$$$$$$$$ |$$ |$$$$ |$$ $$ $$/$$ |  $$ |
 *    $$$$/  $$$$ |$$ |  $$ |$$ \__$$ |$$ |$$$/ $$ | _$$ |_
 *    $$$/    $$$ |$$ |  $$ |$$    $$/ $$ | $/  $$ |/ $$   |
 *    $$/      $$/ $$/   $$/  $$$$$$/  $$/      $$/ $$$$$$/
 */

import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { ReentrancyGuardTransient } from "solady/src/utils/ReentrancyGuardTransient.sol";
import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { IEquilibraPool } from "./interfaces/IEquilibraPool.sol";
import { IEquilibraSwapCallback } from "./interfaces/IEquilibraSwapCallback.sol";
import { IEquilibraMintCallback } from "./interfaces/IEquilibraMintCallback.sol";
import { EquilibraLpToken } from "./base/EquilibraLpToken.sol";
import { EquilibraPoolGuard } from "./base/EquilibraPoolGuard.sol";
import { Constants } from "./libraries/Constants.sol";
import { Errors } from "./libraries/Errors.sol";
import { EquilibraSwapMath } from "./libraries/EquilibraSwapMath.sol";
import { PoolOracle } from "./libraries/PoolOracle.sol";

/**
 * @title EquilibraPool
 * @notice Clone-friendly two-token AMM with anchor-driven concentration, a geometric price EMA
 * and an auto-repeg of the anchor funded from LP-value growth.
 * @dev Reserves are lifted into math space by the asymmetric coordinate change `xMath = xWad`
 * (base, identity) and `yMath = yWad · WAD / priceScale` (quote expressed in base units). At the
 * anchor `yMath == xMath`; a repeg at fixed reserves moves `yMath` only.
 * The two-knob cubic invariant is `K(x, y; L) = A · L · (x + y) / 2 + (W − A) · xy` with
 * `A = a · W / (W + λ · D)` and `D = (y − x)² / (xy)`; `a` sets the depth at the anchor and
 * `λ` the plateau width, independently. Clearing denominators leaves degree 3 in `y`, so the
 * secant solver works on a cubic envelope. The depth `L` (Q128) is recovered once per swap from
 * the pre-state as the positive root of `W·L² − A·L·S − (W−A)·N = 0` (`solveLFromState`) and
 * held fixed for the leg.
 * The LP unit value `vp = 2·L_eq · √(priceScale · WAD) / totalSupply` is comparable across
 * anchors and invariant under proportional mint/burn; it drives the two-gate auto-repeg through
 * the `genesis / live / growth` accounting trio. `_repegShareBps` is stored pre-scaled by the
 * factory for protocol-fee compensation.
 */
contract EquilibraPool is
    IEquilibraPool,
    ReentrancyGuardTransient,
    EquilibraLpToken,
    EquilibraPoolGuard
{
    using FixedPointMathLib for uint256;

    /**
     * @dev Forces Solady's pure-TSTORE reentrancy guard on every chain. The pool deploys only on
     * Cancun-ready targets, so the SSTORE fallback would only add a redundant storage slot per
     * swap.
     */
    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }

    // ============ Core pool state ============
    /**
     * @dev Private-pool flag, packed with `_paused`, `_token0` and `_stopped` in one slot: the
     * mint gate's check warms the slot that settlement reads `_token0` from, so a public mint
     * pays nothing extra. Set once in {initialize} and immutable afterwards, so a public pool can
     * never become gated.
     */
    bool private _isPrivate;
    address private _token0;
    /**
     * @dev Permanent-stop latch, packed in the byte after `_token0`. Never cleared once set;
     * {setPaused} then becomes a no-op.
     */
    bool private _stopped;
    address private _token1;
    address private _factory;

    /**
     * @dev Fee ceiling in bps. This and the next four fields occupy the high 88 bits of the
     * `_factory` slot (16 + 8 + 32 + 16 + 16), written by {initialize} as one factory-packed
     * word.
     */
    uint16 private _baseFee;
    /**
     * @dev Protocol slice of every fee in percent, `[0, 25]`; immutable after {initialize}.
     */
    uint8 private _protocolFeePercent;
    /**
     * @dev Internal EMA relaxation time `tau = ceil(halfLife · 1000 / 694)` in seconds;
     * immutable. {getFeeConfig} maps it back to the half-life.
     */
    uint32 private _emaPeriod;
    /**
     * @dev Dynamic-fee floor in bps; ignored while the ramp is disabled.
     */
    uint16 private _feeFloorBps;
    /**
     * @dev Repeg share pre-scaled by the factory as
     * `⌊share · BPS / (BPS − protocolFeePercent · 100)⌋`, so the gate spends the user share of
     * gross growth and the protocol cut comes out of the LP residual. Zero iff the user share is
     * zero, which disables auto-repeg.
     */
    uint16 private _repegShareBps;
    /**
     * @dev Power-of-ten raw-to-WAD scales of token0 and token1. Their slot also holds the pair
     * index (32), the parachute multiplier (8) and the fee ramp (64), leaving 24 bits spare.
     */
    uint64 private _token0Scale;
    uint64 private _token1Scale;
    /**
     * @dev Pair-local index of this pool on the factory; metadata only.
     */
    uint32 private _pairPoolIndex;
    /**
     * @dev Donation-parachute multiplier K: the parachute opens only at a geometric deviation of
     * at least `K × active dead-band`. Not a creation parameter; every pool starts at
     * `Constants.REPEG_PARACHUTE_BAND_MULT` and {setParachuteBandMult} adjusts it within
     * `[1, 255]`. Shares the scales/index/ramp slot the repeg path has already warmed.
     */
    uint8 private _parachuteBandMult;

    /**
     * @dev Smoothstep warm-up width pre-scaled to WAD (`feeRampBps · 1e14`). Zero disables the
     * ramp: every swap then pays `_baseFee`.
     */
    uint64 private _feeRampDistWad;

    /**
     * @dev Two-knob curve parameters, sharing a slot with the downward repeg dead-band
     * (3 × 64 bits). Bounded by the factory to `[A_MIN_WAD, A_MAX_WAD]` and
     * `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`, both `<= WAD < 2^60`, so `uint64` holds them with
     * headroom. Immutable after {initialize}.
     */
    uint64 private _aWad;
    uint64 private _lambdaWad;

    /**
     * @dev Downward auto-repeg dead-band (`ema < priceScale`), WAD; the direction pair of
     * `_repegThresholdToken1UpWad`. Lives in the curve-knob slot because the timestamps slot is
     * full and every swap already warms this slot for `_aWad` / `_lambdaWad`.
     */
    uint64 private _repegThresholdToken1DownWad;

    /**
     * @dev Anchor price scale `yWad / xWad` (token0 per token1, WAD). The coordinate change
     * `yMath = yWad · WAD / priceScale` depends on it, so a repeg at fixed reserves moves `yMath`
     * only and off-balance reserves register a math-space displacement the repeg gate prices.
     */
    uint256 private _priceScaleWad;

    /**
     * @dev Natural logarithm of the geometric price EMA, WAD-scaled, stored without an offset.
     * Updated by {_updateEma} at most once per timestamp on the swap path.
     */
    int256 private _emaLogWad;

    /**
     * @dev Epoch base of the auto-repeg gate, WAD. Seeded at genesis with
     * `vp = 2·L_eq · √(priceScale · WAD) / totalSupply`, which {addLiquidity} requires to lie
     * within `2·WAD ± MAX_GENESIS_VP_ERROR_WAD`, and ratcheted forward by {setRepegShareBps},
     * which seals the closing epoch's protected growth slice into it. Monotone non-decreasing
     * and never above the live unit value.
     */
    uint256 private _lpUnitValueGenesisWad;

    /**
     * @dev Live high-water mark of `vp`, WAD. Rises on swaps that book growth, is re-anchored on
     * proportional mint/burn and drops to the post-move value on a committed repeg.
     */
    uint256 private _lpUnitValueWad;

    /**
     * @dev Cumulative sum of every positive `vp` delta booked by swaps, WAD. Sets the gate floor
     * `genesis + growth · (BPS − repegShareBps) / BPS`. Never reduced by swaps, liquidity
     * events or repegs; only {setRepegShareBps} restarts it after sealing the epoch.
     */
    uint256 private _lpValueGrowthWad;

    /**
     * @dev Timestamp of the last EMA update. One slot holds it with `_lastRepegTs`,
     * `_repegStepWad` and the upward dead-band (4 × 64 bits); the step is in `[1, WAD]` and
     * both dead-bands in `[1, WAD)`, which `uint64` holds with headroom. {_updateEma}
     * warms the slot, so {_tryAutoRepeg} reads its fields warm. The downward dead-band lives in
     * the curve-knob slot because this one is full.
     */
    uint64 private _lastEmaTs;
    /**
     * @dev Timestamp of the last committed repeg; enforces one commit per timestamp.
     */
    uint64 private _lastRepegTs;
    /**
     * @dev Per-repeg log-domain step cap, WAD.
     */
    uint64 private _repegStepWad;
    /**
     * @dev Upward auto-repeg dead-band (`ema > priceScale`), WAD.
     */
    uint64 private _repegThresholdToken1UpWad;

    /**
     * @dev Clean reserves in raw token units: low 128 bits token0, high 128 bits token1. Excludes
     * the protocol-fee buckets.
     */
    uint256 private _reservesPacked;

    /**
     * @dev Accrued protocol fees in raw token units: low 128 bits token0, high 128 bits token1.
     */
    uint256 private _protocolFeesPacked;

    /**
     * @dev Mask of the low 128 bits; also the raw-amount ceiling of every packed pair.
     */
    uint256 private constant _LOWER_128_MASK = type(uint128).max;

    /**
     * @notice Memory snapshot of the curve knobs, the anchor and the decimal scales.
     * @dev Loaded once per swap, quote, liquidity event or view by {_loadCurveParams} and passed
     * by reference to the math helpers; the repeg probes overwrite `priceScaleWad` in place.
     */
    struct CurveSnapshot {
        uint256 aWad;
        uint256 lambdaWad;
        uint256 priceScaleWad;
        uint256 token0Scale;
        uint256 token1Scale;
    }

    /**
     * @notice Pre-swap math-space snapshot, lifted and depth-solved once per swap or quote.
     * @dev Reused by the EMA sample, the fee resolver and the kernel. `lPreQ128` is
     * `solveLFromState(xMath, yMath)` in Q128; the kernel is symmetric in `(x, y)`, so one value
     * serves both directions.
     */
    struct MathState {
        uint256 xMath;
        uint256 yMath;
        uint256 lPreQ128;
        /// Raw reserves, low 128 bits token0 and high 128 bits token1; settlement bounds read it.
        uint256 reservesPacked;
    }

    /**
     * @notice Resolved amounts of one swap leg, raw token units.
     */
    struct SwapAmounts {
        /// Gross input, fee included.
        uint256 amountInRaw;
        /// Output paid to the recipient.
        uint256 amountOutRaw;
        /// Total fee taken from the input.
        uint256 feeAmount;
        /// Protocol slice of the fee, kept out of the reserves.
        uint256 protocolCut;
        /// LP slice of the fee, folded into the input-side reserve.
        uint256 lpFeeCut;
        /// Post-swap depth `L` (Q128) of the settled reserves.
        uint256 lAfterQ128;
    }

    /**
     * @notice Working set of {addLiquidity}, held in memory so the frame fits the 16-slot stack
     * limit of the legacy (non-viaIR) codegen.
     * @dev The reserve and parked-buffer snapshot is taken before the mint callback and
     * survives it, pinning the active/parked split against a self-donation made inside the
     * callback.
     */
    struct AddState {
        /// Total supply before the mint, parked shares included.
        uint256 supplyBefore;
        uint256 reserve0;
        uint256 reserve1;
        /// Pool-owned (parked donation) shares before the mint; zero at genesis.
        uint256 parkedBefore;
        /// Raw token0 the callback must deliver.
        uint256 amount0Used;
        /// Raw token1 the callback must deliver.
        uint256 amount1Used;
    }

    /**
     * @dev Binds the factory on the first call and reverts `AlreadyInitialized` on every later
     * one.
     * @param factoryAddress Caller of {initialize}, stored as `_factory` before the body runs.
     */
    modifier onlyOnce(address factoryAddress) {
        if (_factory != address(0)) revert Errors.AlreadyInitialized();
        _factory = factoryAddress;
        _;
    }

    // ============ Implementation lock ============

    /**
     * @notice Locks the implementation so it can never be initialised directly.
     * @dev EIP-1167 clones have their own storage. The implementation deploys with
     * `_factory = address(this)`, so `initialize` on it reverts `AlreadyInitialized`.
     */
    constructor() {
        _factory = address(this);
    }

    // ============ Initialization ============

    /**
     * @inheritdoc IEquilibraPool
     * @dev Callable once, by the factory. Every bound and the packing of the four config words
     * are validated by `EquilibraFactory`; the pool stores them verbatim. `feeConfigBits` lands
     * above the factory address in the `_factory` slot while the low 160 bits keep the address
     * bound by {onlyOnce}. The anchor starts at WAD and the EMA log at zero until genesis.
     */
    function initialize(InitParams calldata params) external override onlyOnce(msg.sender) {
        _token0 = params.token0;
        _token1 = params.token1;
        _isPrivate = params.isPrivate;
        uint256 feeConfigBits = params.feeConfigBits;
        uint256 scaleRampConfig = params.scaleRampConfig;
        uint256 curveConfig = params.curveConfig;
        uint256 repegConfig = params.repegConfig;
        // Keep the factory address bound by `onlyOnce` in the low 160 bits.
        assembly ("memory-safe") {
            sstore(
                _factory.slot,
                or(and(sload(_factory.slot), sub(shl(160, 1), 1)), shl(160, feeConfigBits))
            )
            sstore(_token0Scale.slot, scaleRampConfig)
            sstore(_aWad.slot, curveConfig)
            sstore(_lastEmaTs.slot, repegConfig)
        }
        _priceScaleWad = Constants.WAD;
        _emaLogWad = 0;
        _setLpTokenMetadata(params.lpName, params.lpSymbol);
    }

    // ============ Swaps ============

    /**
     * @inheritdoc IEquilibraPool
     * @dev Pipeline: EMA update from the pre-swap state, fee and kernel resolution, reserve
     * update (the protocol cut stays out of the reserves), LP-growth accrual, auto-repeg
     * attempt, then settlement. The output is paid before the callback, and
     * `equilibraSwapCallback` must deliver exactly `amountInRaw` of the input token
     * (`UnsupportedTokenBehavior` otherwise). Reverts `ZeroAddress` for a zero recipient and
     * `InsufficientLiquidity` on an unseeded pool.
     */
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        bytes calldata data
    ) external override nonReentrant whenNotPaused returns (int256 amount0, int256 amount1) {
        if (recipient == address(0)) revert Errors.ZeroAddress();

        SwapAmounts memory amounts;
        uint256 priceScaleForEvent;

        // Scope 1: EMA sync, swap math, reserve deltas, accrue, repeg.
        {
            CurveSnapshot memory cs = _loadCurveParams();
            (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
            if (reserve0 == 0 || reserve1 == 0) revert Errors.InsufficientLiquidity();

            // Lift the pre-state and solve L once; the EMA sample, the fee resolver and the
            // kernel reuse it.
            MathState memory ms = _liftMathState(reserve0, reserve1, cs);

            int256 emaBefore = _updateEma(ms, cs);

            amounts = _computeSwapAmounts(zeroForOne, amountSpecified, ms, cs);

            if (zeroForOne) {
                amount0 = _toSignedPositive(amounts.amountInRaw);
                amount1 = -_toSignedPositive(amounts.amountOutRaw);
                reserve0 += amounts.amountInRaw - amounts.protocolCut;
                reserve1 -= amounts.amountOutRaw;
                _accrueProtocolFees(amounts.protocolCut, 0);
            } else {
                amount0 = -_toSignedPositive(amounts.amountOutRaw);
                amount1 = _toSignedPositive(amounts.amountInRaw);
                reserve1 += amounts.amountInRaw - amounts.protocolCut;
                reserve0 -= amounts.amountOutRaw;
                _accrueProtocolFees(0, amounts.protocolCut);
            }

            _setReservesInternal(reserve0, reserve1);

            uint256 vpNow = _accrueLpValueGrowth(amounts.lAfterQ128, cs.priceScaleWad);

            priceScaleForEvent = _tryAutoRepeg(reserve0, reserve1, cs, vpNow, emaBefore);
        }

        // Scope 2: Settlement — token transfer, callback, solvency.
        {
            (address tokenIn, address tokenOut) = zeroForOne
                ? (_token0, _token1)
                : (_token1, _token0);
            SafeTransferLib.safeTransfer(tokenOut, recipient, amounts.amountOutRaw);

            uint256 balanceBeforeIn = SafeTransferLib.balanceOf(tokenIn, address(this));
            IEquilibraSwapCallback(msg.sender).equilibraSwapCallback(amount0, amount1, data);
            uint256 received = SafeTransferLib.balanceOf(tokenIn, address(this)) - balanceBeforeIn;
            if (received != amounts.amountInRaw) revert Errors.UnsupportedTokenBehavior();
        }

        emit Swap(
            msg.sender,
            recipient,
            zeroForOne,
            amounts.amountInRaw,
            amounts.amountOutRaw,
            amounts.feeAmount,
            amounts.protocolCut,
            priceScaleForEvent,
            amounts.lpFeeCut
        );
    }

    // ============ Liquidity ============

    /**
     * @inheritdoc IEquilibraPool
     * @dev Genesis seeds `priceScale = yWad / xWad`, the EMA log and both LP unit-value marks,
     * burns `MIN_INITIAL_LIQUIDITY` shares to `0xdEaD` and requires the genesis unit value to
     * lie within `2·WAD ± MAX_GENESIS_VP_ERROR_WAD` (`GenesisVpImprecise` otherwise). Later
     * deposits are priced against the active float `totalSupply − balanceOf(pool)` and mint a
     * proportional top-up of the parked donation buffer, so `parked / active` and `vp` are
     * unchanged. Private pools require `recipient` to be on the factory's LP allowlist
     * (`LpNotAllowed`). Shares are minted only after `equilibraMintCallback` has delivered
     * exactly the used amounts (`UnsupportedTokenBehavior` otherwise).
     */
    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        bytes calldata data
    ) external override nonReentrant whenNotPaused returns (uint256 sharesOut) {
        if (recipient == address(0)) revert Errors.ZeroAddress();
        if (amount0 == 0 || amount1 == 0) revert Errors.ZeroAmount();
        // Private pools gate the recipient (the eventual holder): one check covers every mint
        // path. LP shares stay transferable, so the allowlist bounds entry by minting only.
        if (_isPrivate) _enforceLpAllowed(recipient);

        AddState memory p;
        p.supplyBefore = totalSupply();
        (p.reserve0, p.reserve1) = _getReservesInternal();
        // Snapshot the parked buffer before the callback so a self-donation inside it cannot
        // move the active/parked split. Zero at genesis.
        p.parkedBefore = balanceOf(address(this));

        // Buffer top-up: computed from the snapshot, minted after settlement; zero without a
        // buffer.
        uint256 bufferTopUp;

        if (p.supplyBefore == 0) {
            p.amount0Used = amount0;
            p.amount1Used = amount1;

            p.reserve0 += amount0;
            p.reserve1 += amount1;
            _setReservesInternal(p.reserve0, p.reserve1);

            uint256 yWad = _toWadByScale(p.reserve0, uint256(_token0Scale));
            uint256 xWad = _toWadByScale(p.reserve1, uint256(_token1Scale));
            if (xWad == 0 || yWad == 0) revert Errors.InsufficientLiquidity();

            // `priceScale = yWad / xWad` puts the seeded reserves on the math-space diagonal.
            uint256 initialPriceScale = FixedPointMathLib.divWad(yWad, xWad);
            if (
                initialPriceScale == 0 ||
                (!_isPrivate &&
                    (initialPriceScale <= Constants.MIN_PUBLIC_INITIAL_PRICE_SCALE_WAD ||
                        initialPriceScale >= Constants.MAX_PUBLIC_INITIAL_PRICE_SCALE_WAD))
            ) revert Errors.InvalidPriceScale();
            _priceScaleWad = initialPriceScale;
            _emaLogWad = PoolOracle.priceToEmaLog(initialPriceScale);
            _lastEmaTs = uint64(block.timestamp);

            uint256 geoMeanWad = FixedPointMathLib.sqrt(xWad * yWad);
            if (geoMeanWad <= Constants.MIN_INITIAL_LIQUIDITY)
                revert Errors.MathInvariantViolation();
            _mint(address(0xdEaD), Constants.MIN_INITIAL_LIQUIDITY);
            sharesOut = geoMeanWad - Constants.MIN_INITIAL_LIQUIDITY;

            // Genesis unit value under the seeded anchor: the base of every gate threshold.
            uint256 vpGenesisWad = _computeLpUnitValueWad(
                p.reserve0,
                p.reserve1,
                _loadCurveParams(),
                geoMeanWad
            );
            // Genesis identity `vp == 2·WAD` within tolerance. Insufficient normalised depth or
            // a coarsely quantised anchor would understate the base and let auto-repeg spend LP
            // principal; the geomean floor cannot bound this because `nWad` depends on the
            // base-side reserve only.
            uint256 twoWad = 2 * Constants.WAD;
            uint256 vpErr = vpGenesisWad > twoWad ? vpGenesisWad - twoWad : twoWad - vpGenesisWad;
            if (vpErr > Constants.MAX_GENESIS_VP_ERROR_WAD)
                revert Errors.GenesisVpImprecise(vpGenesisWad);
            _lpUnitValueGenesisWad = vpGenesisWad;
            _lpUnitValueWad = vpGenesisWad;
        } else {
            p.amount0Used = amount0;
            // Shares are priced on token0: round the matching token1 payment up.
            p.amount1Used = FixedPointMathLib.fullMulDivUp(amount0, p.reserve1, p.reserve0);
            if (p.amount1Used > amount1) {
                p.amount1Used = amount1;
                p.amount0Used = FixedPointMathLib.mulDiv(amount1, p.reserve0, p.reserve1);
            }
            if (p.amount0Used == 0 || p.amount1Used == 0)
                revert Errors.AmountTooSmallAfterNormalization();

            // Parked shares carry no claim, so the mint is priced against the active float; with
            // the buffer top-up below, `vp` is exactly invariant across a proportional mint.
            uint256 activeBefore = p.supplyBefore - p.parkedBefore;
            sharesOut = FixedPointMathLib.fullMulDiv(p.amount0Used, activeBefore, p.reserve0);

            // Grow the parked buffer in proportion to the active float; mirrored by the burn on
            // exit.
            if (p.parkedBefore != 0)
                bufferTopUp = FixedPointMathLib.fullMulDiv(sharesOut, p.parkedBefore, activeBefore);

            p.reserve0 += p.amount0Used;
            p.reserve1 += p.amount1Used;
            _setReservesInternal(p.reserve0, p.reserve1);
        }

        if (sharesOut < minShares) revert Errors.SlippageExceeded();

        {
            address t0 = _token0;
            address t1 = _token1;
            uint256 bal0Before = SafeTransferLib.balanceOf(t0, address(this));
            uint256 bal1Before = SafeTransferLib.balanceOf(t1, address(this));

            IEquilibraMintCallback(msg.sender).equilibraMintCallback(
                p.amount0Used,
                p.amount1Used,
                data
            );

            if (SafeTransferLib.balanceOf(t0, address(this)) - bal0Before != p.amount0Used)
                revert Errors.UnsupportedTokenBehavior();
            if (SafeTransferLib.balanceOf(t1, address(this)) - bal1Before != p.amount1Used)
                revert Errors.UnsupportedTokenBehavior();
        }

        // Mint only after the callback has paid: the claimless buffer top-up first, then the
        // recipient's shares.
        if (bufferTopUp != 0) _mint(address(this), bufferTopUp);
        _mint(recipient, sharesOut);

        if (p.supplyBefore > 0) {
            _reanchorLpUnitValue(p.reserve0, p.reserve1, _loadCurveParams());
        }

        emit LiquidityAdded(msg.sender, recipient, p.amount0Used, p.amount1Used, sharesOut);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Payouts are `reserve · shares / activeFloat`, rounded down, and the exiting holder's
     * proportional slice of the parked buffer is burned so `parked / active` and `vp` stay
     * unchanged. Both payouts flooring to zero reverts `AmountTooSmallAfterNormalization`
     * rather than burning shares for nothing. Never gated by the pause; a permanently stopped
     * pool skips the LP re-anchor and the solvency check.
     */
    function removeLiquidity(
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        address recipient
    ) external override nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (recipient == address(0)) revert Errors.ZeroAddress();
        if (shares == 0) revert Errors.ZeroAmount();

        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        // Parked shares hold no claim: payouts divide by the active float.
        uint256 parked = balanceOf(address(this));
        uint256 activeBefore = totalSupply() - parked;
        amount0 = FixedPointMathLib.fullMulDiv(reserve0, shares, activeBefore);
        amount1 = FixedPointMathLib.fullMulDiv(reserve1, shares, activeBefore);
        // Dust guard: on low-decimal pools a tiny share amount can floor both payouts to zero.
        if (amount0 == 0 && amount1 == 0) revert Errors.AmountTooSmallAfterNormalization();

        if (amount0 < minAmount0 || amount1 < minAmount1) revert Errors.SlippageExceeded();

        _burn(msg.sender, shares);
        // Burn the holder's proportional buffer slice; otherwise the exit would dilute the
        // buffer's backing and drop `vp` below the gate floor.
        if (parked != 0) {
            uint256 bufferBurn = FixedPointMathLib.fullMulDiv(parked, shares, activeBefore);
            if (bufferBurn != 0) _burn(address(this), bufferBurn);
        }

        {
            uint256 reserve0After = reserve0 - amount0;
            uint256 reserve1After = reserve1 - amount1;
            _setReservesInternal(reserve0After, reserve1After);

            if (!_stopped) {
                _reanchorLpUnitValue(reserve0After, reserve1After, _loadCurveParams());
            }

            address t0 = _token0;
            address t1 = _token1;
            SafeTransferLib.safeTransfer(t0, recipient, amount0);
            SafeTransferLib.safeTransfer(t1, recipient, amount1);
            if (!_stopped) _assertSolvency(t0, t1);
        }

        emit LiquidityRemoved(msg.sender, recipient, amount0, amount1, shares);
    }

    // Donations are plain LP transfers to the pool's own address; the pool has no donation
    // entrypoint. The guarded variant (supply pin + deadline) is `EquilibraRouter.donate`. Parked
    // shares carry no claim on reserves, scale with the liquidity legs and are spent only by
    // {_tryDonationParachute}.

    // ============ Protocol fees ============

    /**
     * @inheritdoc IEquilibraPool
     * @dev Fee collector only (`Unauthorized`). Zeroes both buckets before transferring and then
     * checks that each balance still covers its reserve.
     */
    function collectProtocolFees(
        address recipient
    ) external override nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (recipient == address(0)) revert Errors.ZeroAddress();
        _enforceFeeCollector();

        (amount0, amount1) = _getProtocolFeesInternal();
        _protocolFeesPacked = 0;

        address t0 = _token0;
        address t1 = _token1;
        if (amount0 > 0) SafeTransferLib.safeTransfer(t0, recipient, amount0);
        if (amount1 > 0) SafeTransferLib.safeTransfer(t1, recipient, amount1);
        _assertSolvency(t0, t1);

        emit ProtocolFeesCollected(recipient, amount0, amount1);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Factory owner only. Writes both flags into their shared slot with one SSTORE. A set
     * stop latch turns every later call into a silent no-op.
     */
    function setPaused(bool paused_, bool stopped_) external override {
        _enforceFactoryOwner();
        if (stopped_ && !paused_) revert Errors.InvalidPauseState();
        if (_stopped) return;
        // Both flags share a slot; the latch check above guarantees a zero stopped byte.
        assembly ("memory-safe") {
            let word := sload(_paused.slot)
            word := and(word, not(shl(mul(_paused.offset, 8), 0xff)))
            word := or(word, shl(mul(_paused.offset, 8), paused_))
            sstore(_paused.slot, or(word, shl(mul(_stopped.offset, 8), stopped_)))
        }
        emit PauseStateChanged(paused_, stopped_, msg.sender);
    }

    // ============ Runtime parameters (param timelock only) ============

    /**
     * @inheritdoc IEquilibraPool
     * @dev Bare store gated to the param timelock, the same trust split as {initialize}: bounds,
     * ramp headroom and ramp monotonicity are validated by `EquilibraParamTimelock` at queue and
     * execution time. The ramp is stored pre-scaled as `feeRampBps · 1e14`.
     */
    function setFeeParams(
        uint16 baseFee_,
        uint16 feeRampBps_,
        uint16 feeFloorBps_
    ) external override {
        _enforceParamTimelock();
        _baseFee = baseFee_;
        _feeFloorBps = feeFloorBps_;
        _feeRampDistWad = uint64(uint256(feeRampBps_) * 1e14);
        emit FeeParamsUpdated(baseFee_, feeRampBps_, feeFloorBps_);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Bare store gated to the param timelock; range and change-size policy are validated
     * there.
     */
    function setRepegStepWad(uint64 repegStepWad_) external override {
        _enforceParamTimelock();
        _repegStepWad = repegStepWad_;
        emit RepegStepUpdated(repegStepWad_);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Bare store gated to the param timelock; ranges and the band-to-step relation are
     * validated there.
     */
    function setRepegThresholds(
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) external override {
        _enforceParamTimelock();
        _repegThresholdToken1UpWad = repegThresholdToken1UpWad_;
        _repegThresholdToken1DownWad = repegThresholdToken1DownWad_;
        emit RepegThresholdsUpdated(repegThresholdToken1UpWad_, repegThresholdToken1DownWad_);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Seals the closing epoch under the outgoing share before storing the new one: the
     * protected slice `⌈growth · (BPS − oldShare) / BPS⌉` ratchets into the gate base, the
     * accumulator restarts and the live spendable gap carries over untouched, so the incoming
     * share splits only future earnings. Ceil rounding favours LPs. The share is stored with the
     * factory's pre-scaling `⌊share · BPS / (BPS − protocolFeePercent · 100)⌋`, so
     * {getFeeConfig} round-trips the user-facing value.
     */
    function setRepegShareBps(uint16 repegShareBps_) external override {
        _enforceParamTimelock();
        uint256 sealedBaseWad = _lpUnitValueGenesisWad +
            FixedPointMathLib.mulDivUp(
                _lpValueGrowthWad,
                Constants.BPS - uint256(_repegShareBps),
                Constants.BPS
            );
        _lpUnitValueGenesisWad = sealedBaseWad;
        _lpValueGrowthWad = 0;
        _repegShareBps = uint16(
            FixedPointMathLib.mulDiv(
                uint256(repegShareBps_),
                Constants.BPS,
                Constants.BPS - uint256(_protocolFeePercent) * 100
            )
        );
        emit RepegShareUpdated(repegShareBps_, sealedBaseWad);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Bare store gated to the param timelock; the `[1, 255]` range is validated there (zero
     * would remove the lag qualifier and turn the parachute into a continuous top-up).
     */
    function setParachuteBandMult(uint8 parachuteBandMult_) external override {
        _enforceParamTimelock();
        _parachuteBandMult = parachuteBandMult_;
        emit ParachuteBandMultUpdated(parachuteBandMult_);
    }

    // ============ Views ============
    /**
     * @inheritdoc IEquilibraPool
     * @dev Returns zero for a zero amount, an amount above `uint128.max` or an unseeded pool;
     * otherwise runs the live swap resolver, so quote and swap agree on the same state.
     */
    function quoteExactIn(
        bool zeroForOne,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > _LOWER_128_MASK) return 0;
        return _quoteSwapAmountsChecked(zeroForOne, int256(amountIn)).amountOutRaw;
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Returns zero for a zero amount, an amount above `uint128.max` or an unseeded pool;
     * otherwise runs the live swap resolver, so quote and swap agree on the same state.
     */
    function quoteExactOut(
        bool zeroForOne,
        uint256 amountOut
    ) external view override returns (uint256 amountIn) {
        if (amountOut == 0 || amountOut > _LOWER_128_MASK) return 0;
        return _quoteSwapAmountsChecked(zeroForOne, -int256(amountOut)).amountInRaw;
    }

    /**
     * @dev Runs the full swap resolver (fee, kernel, native bounds, LP-depth guard) on the
     * current state without mutating it.
     * @return amounts Resolved raw amounts; all zero on an unseeded pool.
     */
    function _quoteSwapAmountsChecked(
        bool zeroForOne,
        int256 amountSpecified
    ) private view returns (SwapAmounts memory amounts) {
        (uint256 r0, uint256 r1) = _getReservesInternal();
        if (r0 == 0 || r1 == 0) return amounts;
        CurveSnapshot memory cs = _loadCurveParams();
        MathState memory ms = _liftMathState(r0, r1, cs);
        amounts = _computeSwapAmounts(zeroForOne, amountSpecified, ms, cs);
    }

    /**
     * @dev Applies the native settlement bounds and recomputes the post-swap depth. Reverts
     * `InsufficientLiquidity` when the output reaches the output-side reserve and
     * `MathInvariantViolation` when a settled reserve exceeds `uint128`. The settled reserves
     * include the LP fee and exclude the protocol cut.
     * @return lAfterQ128 Depth `L` (Q128) of the settled reserves; zero on a degenerate lift.
     */
    function _checkSwapAmounts(
        bool zeroForOne,
        SwapAmounts memory amounts,
        MathState memory ms,
        CurveSnapshot memory cs
    ) private pure returns (uint256 lAfterQ128) {
        (uint256 r0, uint256 r1) = _unpackPair128(ms.reservesPacked);
        uint256 reserveOut = zeroForOne ? r1 : r0;
        if (amounts.amountOutRaw >= reserveOut) revert Errors.InsufficientLiquidity();
        if (zeroForOne) {
            r0 += amounts.amountInRaw - amounts.protocolCut;
            r1 -= amounts.amountOutRaw;
        } else {
            r1 += amounts.amountInRaw - amounts.protocolCut;
            r0 -= amounts.amountOutRaw;
        }
        if (r0 > _LOWER_128_MASK || r1 > _LOWER_128_MASK) revert Errors.MathInvariantViolation();
        lAfterQ128 = _poolDepth(r0, r1, cs);
    }

    /**
     * @dev Depth `L` (Q128) of raw reserves under `cs`; zero when either math coordinate is
     * zero.
     */
    function _poolDepth(
        uint256 r0,
        uint256 r1,
        CurveSnapshot memory cs
    ) internal pure returns (uint256 lAfterQ128) {
        (uint256 x, uint256 y) = _toMathState(r0, r1, cs);
        if (x != 0 && y != 0)
            lAfterQ128 = EquilibraSwapMath.solveLFromState(x, y, cs.aWad, cs.lambdaWad);
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getCurveParams() external view override returns (CurveParams memory cp) {
        cp.aWad = uint256(_aWad);
        cp.lambdaWad = uint256(_lambdaWad);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Reverses the storage encodings: `feeRampBps = _feeRampDistWad / 1e14`,
     * `repegShareBps = ⌈stored · (BPS − protocolFeePercent · 100) / BPS⌉` and
     * `emaPeriod = tau · 694 / 1000`, each an exact round trip of the factory's conversion.
     */
    function getFeeConfig() external view override returns (FeeConfig memory cfg) {
        cfg.baseFee = _baseFee;
        cfg.feeRampBps = uint16(uint256(_feeRampDistWad) / 1e14);
        cfg.feeFloorBps = _feeFloorBps;
        // Inverse pre-scaling: `user = ⌈ stored · (BPS − p·100) / BPS ⌉`.
        cfg.repegShareBps = uint16(
            FixedPointMathLib.mulDivUp(
                uint256(_repegShareBps),
                Constants.BPS - uint256(_protocolFeePercent) * 100,
                Constants.BPS
            )
        );
        cfg.protocolFeePercent = _protocolFeePercent;
        // Stored value is the relaxation time tau; report the half-life `tau · 694 / 1000`.
        cfg.emaPeriod = uint32((uint256(_emaPeriod) * 694) / 1000);
        cfg.repegStepWad = _repegStepWad;
        cfg.repegThresholdToken1UpWad = _repegThresholdToken1UpWad;
        cfg.repegThresholdToken1DownWad = _repegThresholdToken1DownWad;
        cfg.parachuteBandMult = _parachuteBandMult;
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getPoolMetadata() external view override returns (PoolMetadata memory meta) {
        meta.token0 = _token0;
        meta.token1 = _token1;
        meta.factory = _factory;
        meta.pairPoolIndex = _pairPoolIndex;
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getPriceScale() external view override returns (uint256) {
        return _priceScaleWad;
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev `pMargWad` and `sqrtPriceX96` stay zero on an unseeded or degenerate pool.
     */
    function getOracleState() external view override returns (OracleState memory state) {
        state.priceScaleWad = _priceScaleWad;
        state.emaPriceWad = PoolOracle.emaLogToPrice(_emaLogWad);

        if (state.priceScaleWad == 0) return state;
        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        if (reserve0 == 0 || reserve1 == 0) return state;

        CurveSnapshot memory cs = _loadCurveParams();
        (uint256 xMath, uint256 yMath) = _toMathState(reserve0, reserve1, cs);
        if (xMath == 0 || yMath == 0) return state;

        state.pMargWad = EquilibraSwapMath.marginalPriceFromState(
            xMath,
            yMath,
            cs.aWad,
            cs.lambdaWad
        );
        state.sqrtPriceX96 = EquilibraSwapMath.mathPriceToSqrtPriceX96(
            state.pMargWad,
            state.priceScaleWad,
            cs.token0Scale,
            cs.token1Scale
        );
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getOracleTimestamps()
        external
        view
        override
        returns (uint64 lastEmaTs, uint64 lastRepegTs)
    {
        return (_lastEmaTs, _lastRepegTs);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Reads Solady's transient guard slot directly. With the pure-TSTORE path forced, the
     * guard stores this contract's address on entry and zero on exit, so a non-zero load means a
     * guarded frame is live. The literal is `ReentrancyGuardTransient._REENTRANCY_GUARD_SLOT`,
     * `uint32(bytes4(keccak256("Reentrancy()"))) | (1 << 71)`; a dependency bump that moves it
     * must be mirrored here.
     */
    function reentrancyGuardEntered() external view override returns (bool entered) {
        assembly ("memory-safe") {
            entered := iszero(iszero(tload(0x8000000000ab143c06)))
        }
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev View twin of {_updateEma}: the EMA a swap in this block would store, computed from the
     * live marginal price with the same spot lift, cap and log-domain step. Returns the stored
     * EMA on an unseeded or degenerate pool.
     */
    function getLiveEmaPrice() external view override returns (uint256 emaPriceWad) {
        uint256 storedEma = PoolOracle.emaLogToPrice(_emaLogWad);
        uint256 priceScale = _priceScaleWad;
        if (priceScale == 0) return storedEma;

        (uint256 r0, uint256 r1) = _getReservesInternal();
        if (r0 == 0 || r1 == 0) return storedEma;

        CurveSnapshot memory cs = _loadCurveParams();
        (uint256 xMath, uint256 yMath) = _toMathState(r0, r1, cs);
        if (xMath == 0 || yMath == 0) return storedEma;

        uint256 pMargMath = EquilibraSwapMath.marginalPriceFromState(
            xMath,
            yMath,
            cs.aWad,
            cs.lambdaWad
        );
        uint256 spotRaw = FixedPointMathLib.fullMulDiv(pMargMath, priceScale, Constants.WAD);

        PoolOracle.EmaState memory next = PoolOracle.updateEma(
            PoolOracle.EmaState({ emaLogWad: _emaLogWad, lastUpdateTs: _lastEmaTs }),
            spotRaw,
            priceScale,
            _emaPeriod,
            uint64(block.timestamp)
        );
        emaPriceWad = PoolOracle.emaLogToPrice(next.emaLogWad);
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getLpValueState() external view override returns (LpValueState memory state) {
        state.unitValueWad = _lpUnitValueWad;
        state.genesisWad = _lpUnitValueGenesisWad;
        state.growthWad = _lpValueGrowthWad;
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getReserves() external view override returns (uint256 reserve0, uint256 reserve1) {
        return _getReservesInternal();
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function getProtocolFees() external view override returns (uint256 fee0, uint256 fee1) {
        return _getProtocolFeesInternal();
    }

    /**
     * @inheritdoc IEquilibraPool
     */
    function paused() external view override returns (bool paused_, bool stopped_) {
        return (_paused, _stopped);
    }

    /**
     * @inheritdoc IEquilibraPool
     * @dev Raw `sload` of each requested slot; no layout guarantee is implied.
     */
    function getStorageSlots(
        uint256[] calldata slots
    ) external view override returns (bytes32[] memory data) {
        uint256 len = slots.length;
        data = new bytes32[](len);
        for (uint256 i; i < len; ) {
            uint256 slot = slots[i];
            bytes32 slotData;
            assembly ("memory-safe") {
                slotData := sload(slot)
            }
            data[i] = slotData;
            unchecked {
                ++i;
            }
        }
    }

    // ============ Anchor / EMA ============

    /**
     * @dev Samples the math-space marginal price of the pre-swap state, lifts it to the raw spot
     * `pMargMath · priceScale` and folds it into the geometric EMA through
     * `PoolOracle.updateEma`. No-op when the timestamp has not advanced, on a zero anchor or on
     * a degenerate lift. The caller guarantees non-zero reserves and supplies the lifted state.
     * @return preEmaLogWad Stored EMA logarithm before this update, unchanged on every early
     * return; {_tryAutoRepeg} reports it as the old EMA in `PriceScaleUpdated`.
     */
    function _updateEma(
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal returns (int256 preEmaLogWad) {
        preEmaLogWad = _emaLogWad;
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs <= _lastEmaTs) return preEmaLogWad;
        if (cs.priceScaleWad == 0) return preEmaLogWad;
        if (ms.xMath == 0 || ms.yMath == 0) return preEmaLogWad;

        // Raw spot in the user-facing frame (token0 per token1):
        // `spotRaw = pMargMath · priceScale`.
        uint256 pMargMath = EquilibraSwapMath.marginalPrice(
            ms.xMath,
            ms.yMath,
            ms.lPreQ128,
            cs.aWad,
            cs.lambdaWad
        );
        uint256 spotRaw = FixedPointMathLib.fullMulDiv(pMargMath, cs.priceScaleWad, Constants.WAD);

        PoolOracle.EmaState memory next = PoolOracle.updateEma(
            PoolOracle.EmaState({ emaLogWad: preEmaLogWad, lastUpdateTs: _lastEmaTs }),
            spotRaw,
            cs.priceScaleWad,
            _emaPeriod,
            nowTs
        );
        _emaLogWad = next.emaLogWad;
        _lastEmaTs = next.lastUpdateTs;
    }

    /**
     * @dev Auto-repeg attempt on the post-swap reserves. Skips when `_repegShareBps == 0`
     * (explicit opt-out: the stored share is zero iff the user share is zero, and the threshold
     * alone is not exact because mint/burn re-anchoring can creep `_lpUnitValueWad` above the
     * budgeted floor by rounding dust), when `vpBefore == 0`, when a commit already happened at
     * this timestamp, or when the geometric deviation `|max(ema, ps) / min(ema, ps) − 1|` is
     * below the active dead-band (`Up` while `ema > priceScale`, else `Down`). The dead-band is
     * the only filter against value-neutral churn near the anchor and keeps the quiet-market exit
     * cheap. The gate floor is `vpFloor = genesis + growth · (BPS − share) / BPS`; without
     * headroom above `vpFloor + REPEG_GAS_GUARD_WAD` the attempt is handed to
     * {_tryDonationParachute}. Otherwise the damped step
     * `min(stepCap, deviation / REPEG_DAMPING_DIVISOR)` is probed through the halving ladder
     * `step >> k`, `k <= MAX_REPEG_STEP_HALVINGS`, and the first rung whose post-move unit value
     * is at least `vpFloor` commits; a rung that shrinks to zero or to a dust move ends the
     * ladder, and if no rung commits the parachute is consulted. Ladder rungs spend LP-value
     * growth only, never the donation buffer. Costs one `_computeLpUnitValueWad` per probed
     * rung. `cs.priceScaleWad` is overwritten by the probes and may be left dirty; `swap` reads
     * nothing from `cs` afterwards.
     * @param reserve0 Settled token0 reserve, raw.
     * @param reserve1 Settled token1 reserve, raw.
     * @param cs Curve snapshot; `priceScaleWad` is mutated in place by the probes.
     * @param vpBefore Live LP unit value under the current anchor, from {_accrueLpValueGrowth}.
     * @param emaBeforeLogWad Stored EMA logarithm before this swap's oracle update; used only for
     * the `PriceScaleUpdated` event.
     * @return priceScaleAfter Committed anchor: the new value on a commit, the unchanged
     * `cs.priceScaleWad` on every skip.
     */
    function _tryAutoRepeg(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs,
        uint256 vpBefore,
        int256 emaBeforeLogWad
    ) internal returns (uint256 priceScaleAfter) {
        priceScaleAfter = cs.priceScaleWad;

        // Explicit opt-out; the threshold alone is not exact (re-anchor rounding dust can creep
        // the mark above the floor). `shareBps` is reused by the threshold math below.
        uint256 shareBps = uint256(_repegShareBps);
        if (shareBps == 0) return priceScaleAfter;

        if (vpBefore == 0) return priceScaleAfter;

        if (uint64(block.timestamp) <= _lastRepegTs) return priceScaleAfter;

        uint256 emaWad = PoolOracle.emaLogToPrice(_emaLogWad);

        uint256 deviationWad;
        {
            // Activation dead-band on the geometric deviation `|max/min − 1|` (a ±2× move reads
            // 1.0 WAD in both directions, matching the `[ps/2, 2ps]` EMA clamp). Independent of
            // the step cap and of fees: it decides when the anchor may wake, the budget gates
            // whether a move is affordable. It is the only filter against value-neutral dust
            // repegs near the anchor, and it keeps every non-committing swap of a block at one
            // SLOAD plus one division.
            deviationWad = _priceDeviation(emaWad, cs.priceScaleWad);
            // `ema > priceScale` is a token1-UP move; with the base asset in slot 0 a rising base
            // market reads as token1-DOWN, so each direction is calibrated explicitly.
            uint256 activeThresholdWad = emaWad > cs.priceScaleWad
                ? _repegThresholdToken1UpWad
                : _repegThresholdToken1DownWad;
            if (deviationWad < activeThresholdWad) return priceScaleAfter;
        }

        // Step cap read only after the dead-band passed; the quiet-market exit skips the SLOAD.
        uint256 stepWad = _repegStepWad;
        uint256 vpFloorWad;
        {
            // Scoped for the legacy-codegen 16-slot stack limit.
            uint256 vpGenesis = _lpUnitValueGenesisWad;
            uint256 growth = _lpValueGrowthWad;
            vpFloorWad =
                vpGenesis +
                FixedPointMathLib.mulDiv(growth, Constants.BPS - shareBps, Constants.BPS);
            // No spendable growth: hand over to the parachute, the only spender of the donation
            // buffer.
            if (vpBefore <= vpFloorWad + Constants.REPEG_GAS_GUARD_WAD)
                return
                    _tryDonationParachute(
                        reserve0,
                        reserve1,
                        cs,
                        emaWad,
                        emaBeforeLogWad,
                        stepWad,
                        deviationWad,
                        vpFloorWad
                    );
        }

        // Halving ladder: the damped applied step, then halved up to MAX_REPEG_STEP_HALVINGS
        // times; no cross-block memory. `stepWad` is reused for the applied step
        // (`appliedRepegStep` is idempotent, so the parachute may receive it as the cap) and
        // `shareBps` for the supply (invariant during a `nonReentrant` swap) to stay within the
        // legacy 16-slot stack limit.
        stepWad = PoolOracle.appliedRepegStep(stepWad, deviationWad);
        shareBps = totalSupply();
        for (uint256 halving; halving <= Constants.MAX_REPEG_STEP_HALVINGS; ++halving) {
            if (stepWad >> halving == 0) break;
            uint256 priceScaleNew = PoolOracle.applyLogStep(
                priceScaleAfter,
                emaWad,
                stepWad >> halving
            );
            if (priceScaleNew == priceScaleAfter) {
                // Dust move — smaller halvings can only stay dust.
                break;
            }
            // `deviationWad` is reused as the vpAfter probe slot; `cs` is mutated in place, so
            // the pre-repeg anchor lives only in `priceScaleAfter` from here on.
            {
                cs.priceScaleWad = priceScaleNew;
                deviationWad = _computeLpUnitValueWad(reserve0, reserve1, cs, shareBps);
            }
            // A zero probe is refused here: `vpFloorWad >= vpGenesis > 0` once a swap is
            // executable.
            if (deviationWad < vpFloorWad) continue;

            _commitRepeg(priceScaleAfter, priceScaleNew, deviationWad, emaBeforeLogWad, emaWad);
            return priceScaleNew;
        }

        // Every rung refused: restore the anchor and recompute the deviation (bit-identical to
        // the gate's) for the parachute.
        cs.priceScaleWad = priceScaleAfter;
        deviationWad = _priceDeviation(emaWad, priceScaleAfter);
        return
            _tryDonationParachute(
                reserve0,
                reserve1,
                cs,
                emaWad,
                emaBeforeLogWad,
                stepWad,
                deviationWad,
                vpFloorWad
            );
    }

    /**
     * @dev Donation parachute: the only spender of the donation buffer (LP shares parked on the
     * pool's own address, added by plain LP transfers, vp-neutral while parked and irrevocable).
     * Reached from {_tryAutoRepeg} exactly when no rung committed. Opens only when the anchor
     * lags by at least `parachuteBandMult × active dead-band` and the buffer exceeds
     * `REPEG_DONATION_DUST_SHARES`, so ordinary regimes never consume donations. Commits the
     * full damped step in one shot (halved rungs exist to fit the pool's own budget, which is
     * absent here) and burns exactly the shortfall
     * `δ = ⌈S · (T − vpAfter) / T⌉ = S − ⌊S · vpAfter / T⌋` (`T = vpFloorWad`, `S = supply`),
     * which lands the post-burn unit value on `T` up to the ceil's at-most-one-share over-burn:
     * `T · (S − δ) <= S · vpAfter` implies the latched `⌊vpAfter · S / (S − δ)⌋ >= T`, so no
     * post-burn gate is needed, and the overshoot is at most about `T / (S − δ)` in unit value,
     * wei-scale while the post-burn supply dwarfs `T`. That sub-share remainder is the only
     * surplus a commit can hand to LP holders, which makes sandwiching a parachute commit
     * value-free up to rounding dust. A candidate that needs no subsidy commits with `δ = 0`; a
     * shortfall above the buffer declines. The cadence guard and step cap are unchanged:
     * donations make a move affordable, never faster or larger. Pools with
     * `repegShareBps == 0` never reach this code, so donations to them are unspendable.
     * `cs.priceScaleWad` is mutated for the probe and left dirty on non-commit exits.
     * @param reserve0 Settled token0 reserve, raw.
     * @param reserve1 Settled token1 reserve, raw.
     * @param cs Curve snapshot; `priceScaleWad` is overwritten by the probe.
     * @param emaWad Current EMA price, WAD.
     * @param emaBeforeLogWad Stored EMA logarithm before this swap's oracle update; used only for
     * the `PriceScaleUpdated` event.
     * @param stepCapWad Per-repeg step cap, WAD; the damped applied step is accepted too.
     * @param deviationWad Geometric EMA/anchor deviation, WAD.
     * @param vpFloorWad Gate floor `genesis + growth · (BPS − share) / BPS`, WAD.
     * @return priceScaleAfter Committed anchor, or the unchanged `cs.priceScaleWad` on every skip.
     */
    function _tryDonationParachute(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs,
        uint256 emaWad,
        int256 emaBeforeLogWad,
        uint256 stepCapWad,
        uint256 deviationWad,
        uint256 vpFloorWad
    ) internal returns (uint256 priceScaleAfter) {
        priceScaleAfter = cs.priceScaleWad;

        // Lag qualifier: K × the active dead-band; `band <= WAD` and `K <= 255`, so the checked
        // mul cannot overflow.
        {
            uint256 activeBandWad = emaWad > priceScaleAfter
                ? _repegThresholdToken1UpWad
                : _repegThresholdToken1DownWad;
            if (deviationWad < activeBandWad * uint256(_parachuteBandMult)) return priceScaleAfter;
        }

        uint256 donationShares = balanceOf(address(this));
        if (donationShares <= Constants.REPEG_DONATION_DUST_SHARES) return priceScaleAfter;

        // Full damped step; `stepCapWad` is reused for the applied step and then the candidate.
        stepCapWad = PoolOracle.appliedRepegStep(stepCapWad, deviationWad);
        stepCapWad = PoolOracle.applyLogStep(priceScaleAfter, emaWad, stepCapWad);
        if (stepCapWad == priceScaleAfter) return priceScaleAfter;

        cs.priceScaleWad = stepCapWad;
        uint256 supply = totalSupply();
        // `deviationWad` is reused as the vpAfter probe slot.
        deviationWad = _computeLpUnitValueWad(reserve0, reserve1, cs, supply);

        // Post-burn supply via the integer identity `δ = ⌈S·(T − vp)/T⌉ = S − ⌊S·vp/T⌋` with
        // `T = vpFloorWad`; the 512-bit `fullMulDiv` cannot overflow on `S·vp` and abort the
        // rescue. A zero probe gives `supplyAfter == 0`, i.e. `burnShares == supply`, which the
        // buffer check declines because `donationShares < supply` always holds (the dead shares
        // at 0xdEaD never leave the active float).
        uint256 supplyAfter = deviationWad >= vpFloorWad
            ? supply
            : FixedPointMathLib.fullMulDiv(supply, deviationWad, vpFloorWad);
        uint256 burnShares;
        unchecked {
            // `supplyAfter ≤ supply` in both branches.
            burnShares = supply - supplyAfter;
        }
        if (burnShares > donationShares) return priceScaleAfter;
        if (burnShares != 0) _burn(address(this), burnShares);

        // Exact post-burn latch: supplyAfter <= supply * vpAfter / floor implies latch >= floor.
        _commitRepeg(
            priceScaleAfter,
            stepCapWad,
            FixedPointMathLib.fullMulDiv(deviationWad, supply, supplyAfter),
            emaBeforeLogWad,
            emaWad
        );
        return stepCapWad;
    }

    /**
     * @dev Commit shared by ladder rungs and parachute moves: stores the anchor, latches the LP
     * unit value, stamps `_lastRepegTs` and emits `PriceScaleUpdated`.
     * @param previous Anchor before the move, WAD.
     * @param next Anchor after the move, WAD.
     * @param lpValue Post-move LP unit value to latch, WAD.
     * @param emaBefore EMA logarithm before this swap's oracle update, WAD.
     * @param emaAfter Current EMA price, WAD.
     */
    function _commitRepeg(
        uint256 previous,
        uint256 next,
        uint256 lpValue,
        int256 emaBefore,
        uint256 emaAfter
    ) private {
        _priceScaleWad = next;
        _lpUnitValueWad = lpValue;
        _lastRepegTs = uint64(block.timestamp);
        emit PriceScaleUpdated(previous, next, PoolOracle.emaLogToPrice(emaBefore), emaAfter);
    }

    /**
     * @dev Geometric deviation `max(a, b) · WAD / min(a, b) − WAD` of two positive prices;
     * symmetric in its arguments.
     * @param a First price, WAD.
     * @param b Second price, WAD.
     * @return Deviation, WAD.
     */
    function _priceDeviation(uint256 a, uint256 b) private pure returns (uint256) {
        if (a < b) (a, b) = (b, a);
        return FixedPointMathLib.fullMulDiv(a, Constants.WAD, b) - Constants.WAD;
    }

    // ============ Swap orchestration ============

    /**
     * @dev Resolves one swap leg on the pre-swap snapshot: `amountSpecified > 0` is exact input
     * (gross raw input, output floored to raw units), `< 0` exact output (raw output, gross input
     * ceiled). Reverts `InvalidAmountSpecified` for zero or above `uint128.max`,
     * `AmountTooSmallAfterNormalization` for an output that floors to zero and
     * `LpValueDecreased` when the settled post-fee depth falls below the pre-swap depth. Splits
     * the fee into the protocol cut and the LP cut.
     * @return amounts Resolved raw amounts, fee split and post-swap depth (Q128).
     */
    function _computeSwapAmounts(
        bool zeroForOne,
        int256 amountSpecified,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal view returns (SwapAmounts memory amounts) {
        if (amountSpecified == 0) revert Errors.InvalidAmountSpecified();
        uint256 amountAbs;
        unchecked {
            amountAbs = amountSpecified > 0 ? uint256(amountSpecified) : uint256(-amountSpecified);
        }
        if (amountAbs > type(uint128).max) revert Errors.InvalidAmountSpecified();

        uint256 outScale = zeroForOne ? cs.token1Scale : cs.token0Scale;

        if (amountSpecified > 0) {
            amounts.amountInRaw = amountAbs;

            (uint256 amountOutWad, uint256 feeAmount) = _executeExactInWithDynamicFee(
                zeroForOne,
                amounts.amountInRaw,
                ms,
                cs
            );

            amounts.feeAmount = feeAmount;

            amounts.amountOutRaw = _fromWadDownByScale(amountOutWad, outScale);
            if (amounts.amountOutRaw == 0) revert Errors.AmountTooSmallAfterNormalization();
        } else {
            amounts.amountOutRaw = amountAbs;

            (amounts.feeAmount, amounts.amountInRaw) = _executeExactOutWithDynamicFee(
                zeroForOne,
                amounts.amountOutRaw,
                ms,
                cs
            );
        }
        (amounts.protocolCut, amounts.lpFeeCut) = _splitFee(amounts.feeAmount);
        amounts.lAfterQ128 = _checkSwapAmounts(zeroForOne, amounts, ms, cs);
        if (amounts.lAfterQ128 < ms.lPreQ128) revert Errors.LpValueDecreased();
    }

    /**
     * @dev Exact-in resolver. Resolves the smoothstep rate once from the CP-proxy distance of
     * the gross input at WAD precision (`1 bps == 1e14`), charges
     * `max(1, ⌊amountIn · feeWad / WAD⌋)` for a positive rate (zero for a zero rate), lifts the
     * clean input to WAD and runs the kernel. A one-ulp rate step moves the fee by at most
     * `amountInRaw / 1e18` wei, so the gross-to-clean map is monotone up to a dust residual of
     * that order (the CP distance and the ramp position are WAD-quantised, so one input wei can
     * cross several rate ulps).
     * @return amountOutWad Output in WAD of the output token.
     * @return feeAmount Fee in raw input units.
     */
    function _executeExactInWithDynamicFee(
        bool zeroForOne,
        uint256 amountInRaw,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal view returns (uint256 amountOutWad, uint256 feeAmount) {
        uint256 feeWad;
        unchecked {
            // `uint16 · 1e14 <= 6.55e18` and `uint128.max · rate < 2^256`: both muls are
            // overflow-free.
            feeWad = _resolveDynamicFeeWadFromCp(
                zeroForOne,
                amountInRaw,
                ms,
                cs,
                uint256(_baseFee) * 1e14
            );
            feeAmount = (amountInRaw * feeWad) / Constants.WAD;
        }
        if (feeAmount == 0 && feeWad != 0) feeAmount = 1;
        uint256 cleanRaw = amountInRaw - feeAmount;
        uint256 inScale = zeroForOne ? cs.token0Scale : cs.token1Scale;
        uint256 cleanWad = _toWadByScale(cleanRaw, inScale);
        if (cleanWad == 0) revert Errors.AmountTooSmallAfterNormalization();

        amountOutWad = _computeExactInSwapMath(zeroForOne, cleanWad, ms, cs);
    }

    /**
     * @dev Exact-out resolver. Lifts the requested output to WAD, runs the kernel for the clean
     * input (ceiled to raw units) and delegates the fee gross-up to {_resolveExactOutFee}. A
     * clean input of zero (reachable for one-wei outputs on strongly skewed pools) reverts
     * `AmountTooSmallAfterNormalization` instead of underflowing inside the gross-up.
     * @return feeAmount Fee in raw input units, including the +1 raw gross-input bump.
     * @return amountInRaw Gross raw input the caller must deliver.
     */
    function _executeExactOutWithDynamicFee(
        bool zeroForOne,
        uint256 amountOutRaw,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal view returns (uint256 feeAmount, uint256 amountInRaw) {
        (uint256 outScale, uint256 inScale) = zeroForOne
            ? (cs.token1Scale, cs.token0Scale)
            : (cs.token0Scale, cs.token1Scale);
        uint256 amountInCleanWad;
        {
            uint256 amountOutWad = _toWadByScale(amountOutRaw, outScale);
            if (amountOutWad == 0) revert Errors.AmountTooSmallAfterNormalization();

            amountInCleanWad = _computeExactOutSwapMath(zeroForOne, amountOutWad, ms, cs);
        }
        uint256 cleanInRaw = _fromWadUpByScale(amountInCleanWad, inScale);
        // A zero clean input (one-wei exact-out on a strongly skewed pool) would underflow the
        // gross-up's `cleanInRaw - 1`; reject it as dust instead.
        if (cleanInRaw == 0) revert Errors.AmountTooSmallAfterNormalization();
        (feeAmount, amountInRaw) = _resolveExactOutFee(zeroForOne, cleanInRaw, ms, cs);
    }

    /**
     * @dev Fee gross-up for exact output. Flat-fee pools (`_feeRampDistWad == 0`) gross up at
     * `baseFee` directly. With a live ramp the settled gross lies in
     * `[grossUp(clean, feeFloor), grossUp(clean, baseFee)]` and the CP-proxy distance is
     * quasi-convex (V-shaped, minimum at the constant-product anchor) in the gross, so a
     * fixed-point iteration could oscillate on anchor-crossing trades; the rate is instead
     * resolved non-iteratively as `max(feeCp(grossLo), feeCp(grossHi))`, which is at or above
     * the rate exact-in resolves at the settled gross. This bounds the rate, not the inverse
     * identity between independent exact-in and exact-out solves. On the descending branch of
     * the V the rate falls as the requested output grows, so the required input can tick down
     * per extra output wei by a dust residual of order `gross / 1e18`, in the taker's favour.
     * Both branches add the +1 raw fee-rounding bump. `quoteExactOut` runs the same path, so
     * quote and swap agree.
     * @return feeAmount Fee in raw input units.
     * @return amountInRaw Gross raw input.
     */
    function _resolveExactOutFee(
        bool zeroForOne,
        uint256 cleanInRaw,
        MathState memory ms,
        CurveSnapshot memory cs
    ) private view returns (uint256 feeAmount, uint256 amountInRaw) {
        uint256 baseFeeWad;
        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
            baseFeeWad = uint256(_baseFee) * 1e14;
        }
        // Flat fee: the resolver returns `baseFee` for any gross, so the endpoint max is a
        // tautology.
        if (_feeRampDistWad == 0) {
            amountInRaw = _grossUpExactOut(cleanInRaw, baseFeeWad) + 1;
            feeAmount = amountInRaw - cleanInRaw;
            return (feeAmount, amountInRaw);
        }
        // Endpoint max of the quasi-convex CP-proxy rate over `[grossLo, grossHi]`.
        uint256 grossLo;
        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
            grossLo = _grossUpExactOut(cleanInRaw, uint256(_feeFloorBps) * 1e14);
        }
        uint256 grossHi = _grossUpExactOut(cleanInRaw, baseFeeWad);
        uint256 feeLo = _resolveDynamicFeeWadFromCp(zeroForOne, grossLo, ms, cs, baseFeeWad);
        uint256 feeHi = _resolveDynamicFeeWadFromCp(zeroForOne, grossHi, ms, cs, baseFeeWad);
        uint256 feeWad = feeLo > feeHi ? feeLo : feeHi;
        // +1 raw fee-rounding bump.
        amountInRaw = _grossUpExactOut(cleanInRaw, feeWad) + 1;
        feeAmount = amountInRaw - cleanInRaw;
    }

    /**
     * @dev Smallest gross input whose post-fee clean input is at least `cleanInRaw`: the
     * floor-fee inverse `⌊(cleanInRaw − 1) · WAD / (WAD − feeWad)⌋ + 1`, plus one raw unit when
     * that gross would carry a zero fee at a positive rate. The caller's separate +1 safety bump
     * is not included.
     * @param cleanInRaw Required clean (post-fee) input, raw.
     * @param feeWad Fee rate, WAD.
     * @return amountInRaw Gross raw input.
     */
    function _grossUpExactOut(
        uint256 cleanInRaw,
        uint256 feeWad
    ) internal pure returns (uint256 amountInRaw) {
        uint256 denom = Constants.WAD - feeWad;
        amountInRaw = FixedPointMathLib.mulDiv(cleanInRaw - 1, Constants.WAD, denom) + 1;
        if (amountInRaw == cleanInRaw && feeWad != 0) ++amountInRaw;
    }

    /**
     * @dev CP-proxy dynamic-fee resolver. Lifts the gross input into math space (`divWad` by the
     * anchor for token0, identity for token1; floor, pool-favourable), predicts the post-swap
     * state distance with `EquilibraSwapMath.predictPostDistanceCp` on the deposit side and
     * feeds it to the smoothstep ramp. Returns `baseFeeWad` when the ramp is disabled or the
     * lift degenerates to zero. Rates are WAD fractions (`1 bps == 1e14`).
     * @param zeroForOne True when token0 is the input token.
     * @param amountInRaw Gross raw input.
     * @param ms Pre-swap math-space snapshot.
     * @param cs Curve snapshot.
     * @param baseFeeWad Fee ceiling, WAD.
     * @return feeWad Resolved fee rate, WAD.
     */
    function _resolveDynamicFeeWadFromCp(
        bool zeroForOne,
        uint256 amountInRaw,
        MathState memory ms,
        CurveSnapshot memory cs,
        uint256 baseFeeWad
    ) internal view returns (uint256 feeWad) {
        uint64 rampDistWad = _feeRampDistWad;
        if (rampDistWad == 0) return baseFeeWad;

        if (ms.xMath == 0 || ms.yMath == 0) return baseFeeWad;

        uint256 inScale = zeroForOne ? cs.token0Scale : cs.token1Scale;
        uint256 amountInWad = _toWadByScale(amountInRaw, inScale);
        if (amountInWad == 0) return baseFeeWad;

        // Lift the input into math space: token0 lands on the y-axis (`divWad` by the anchor),
        // token1 on the x-axis (identity). Floor is pool-favourable for the predictor.
        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(amountInWad, cs.priceScaleWad)
            : amountInWad;
        if (amountInMath == 0) return baseFeeWad;

        // The predictor takes the deposit side first.
        uint256 distPredictedWad = zeroForOne
            ? EquilibraSwapMath.predictPostDistanceCp(ms.yMath, ms.xMath, amountInMath)
            : EquilibraSwapMath.predictPostDistanceCp(ms.xMath, ms.yMath, amountInMath);

        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
            feeWad = EquilibraSwapMath.smoothstepFeeWad(
                distPredictedWad,
                uint256(rampDistWad),
                uint256(_feeFloorBps) * 1e14,
                baseFeeWad
            );
        }
    }

    // ============ Internal swap math ============
    //
    // Math-space orientation (asymmetric, quote-side normalisation):
    //   xMath = r1 · t1Scale                        (base, identity)
    //   yMath = r0 · t0Scale · WAD / priceScale     (quote → base units)
    // The kernel treats its first argument as the input axis.
    // zeroForOne deposits on yMath and withdraws from xMath: called as (yMath, xMath, ·) with
    //   amountInMath = divWad(amountInWad, priceScale) and amountOutWad = outDeltaMath.
    // !zeroForOne deposits on xMath and withdraws from yMath: called as (xMath, yMath, ·) with
    //   amountInMath = amountInWad and amountOutWad = mulWad(outDeltaMath, priceScale).

    /**
     * @dev Exact-in kernel call. Lifts the clean input into math space (floor, pool-favourable),
     * runs `quoteExactInForward` with the pre-solved depth and lifts the output delta back to
     * WAD of the output token (identity for token1, `mulWad` by the anchor for token0, floor).
     * Reverts `AmountTooSmallAfterNormalization` when the lifted input is zero; the native
     * output bound is checked at settlement.
     * @return amountOutWad Output in WAD of the output token.
     */
    function _computeExactInSwapMath(
        bool zeroForOne,
        uint256 amountInCleanWad,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal pure returns (uint256 amountOutWad) {
        // Lift the clean input into math space (floor, pool-favourable).
        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(amountInCleanWad, cs.priceScaleWad)
            : amountInCleanWad;
        if (amountInMath == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 outDeltaMath;
        if (zeroForOne) {
            // Deposit on yMath; the output is the xMath delta.
            (outDeltaMath, ) = EquilibraSwapMath.quoteExactInForward(
                ms.yMath,
                ms.xMath,
                amountInMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreQ128
            );
            // xMath output is token1 WAD (identity); native bounds are checked at settlement.
            amountOutWad = outDeltaMath;
        } else {
            // Deposit on xMath; output is yMath delta.
            (outDeltaMath, ) = EquilibraSwapMath.quoteExactInForward(
                ms.xMath,
                ms.yMath,
                amountInMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreQ128
            );
            // yMath output to token0 WAD: `mulWad` by the anchor (floor, pool-favourable).
            amountOutWad = FixedPointMathLib.mulWad(outDeltaMath, cs.priceScaleWad);
        }
    }

    /**
     * @dev Exact-out kernel call. Lifts the requested output into math space (identity for
     * token1, `mulDivUp` by the inverse anchor for token0: ceil, pool-favourable), runs
     * `quoteExactOutForward` with the pre-solved depth (which checks the math-output reserve
     * bound) and lifts the input delta back to WAD of the input token (`mulDivUp` by the anchor
     * for token0, identity for token1).
     * @return amountInCleanWad Clean (pre-fee) input in WAD of the input token.
     */
    function _computeExactOutSwapMath(
        bool zeroForOne,
        uint256 amountOutWad,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal pure returns (uint256 amountInCleanWad) {
        // Lift the output into math space: token1 identity, token0 `mulDivUp` by the inverse
        // anchor (ceil, pool-favourable for exact-out).
        uint256 amountOutMath = zeroForOne
            ? amountOutWad
            : FixedPointMathLib.mulDivUp(amountOutWad, Constants.WAD, cs.priceScaleWad);

        uint256 inDeltaMath;
        if (zeroForOne) {
            // Output from xMath, input onto yMath; the kernel checks the math-output reserve
            // bound.
            (inDeltaMath, ) = EquilibraSwapMath.quoteExactOutForward(
                ms.yMath,
                ms.xMath,
                amountOutMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreQ128
            );
            // yMath input to token0 WAD: `mulDivUp` by the anchor (ceil).
            amountInCleanWad = FixedPointMathLib.mulDivUp(
                inDeltaMath,
                cs.priceScaleWad,
                Constants.WAD
            );
        } else {
            // Output from yMath, input onto xMath; the kernel checks the math-output reserve
            // bound.
            (inDeltaMath, ) = EquilibraSwapMath.quoteExactOutForward(
                ms.xMath,
                ms.yMath,
                amountOutMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreQ128
            );
            // xMath input is token1 WAD (identity).
            amountInCleanWad = inDeltaMath;
        }
    }

    // ============ Utility ============

    /**
     * @dev Unpacks the clean reserves, raw units.
     */
    function _getReservesInternal() internal view returns (uint256 reserve0, uint256 reserve1) {
        return _unpackPair128(_reservesPacked);
    }

    /**
     * @dev Packs and stores the clean reserves; reverts `MathInvariantViolation` above `uint128`.
     */
    function _setReservesInternal(uint256 reserve0, uint256 reserve1) internal {
        _reservesPacked = _packPair128(reserve0, reserve1);
    }

    /**
     * @dev Guard hook: the factory bound at initialisation.
     */
    function _factoryAddress() internal view override returns (address) {
        return _factory;
    }

    /**
     * @dev Unpacks the protocol-fee buckets, raw units.
     */
    function _getProtocolFeesInternal() internal view returns (uint256 fee0, uint256 fee1) {
        return _unpackPair128(_protocolFeesPacked);
    }

    /**
     * @dev Adds a swap's protocol cut to the fee buckets; no-op when both amounts are zero.
     */
    function _accrueProtocolFees(uint256 add0, uint256 add1) internal {
        if (add0 == 0 && add1 == 0) return;
        (uint256 fee0, uint256 fee1) = _unpackPair128(_protocolFeesPacked);
        _protocolFeesPacked = _packPair128(fee0 + add0, fee1 + add1);
    }

    /**
     * @dev Re-anchors `_lpUnitValueWad` to the live unit value of the supplied reserves after a
     * proportional mint or burn, so later deltas are measured against the new supply without
     * touching the growth accumulator. A zero (degenerate) value is skipped.
     */
    function _reanchorLpUnitValue(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs
    ) internal {
        uint256 vpNow = _computeLpUnitValueWad(reserve0, reserve1, cs, totalSupply());
        if (vpNow == 0) return;
        _lpUnitValueWad = vpNow;
    }

    /**
     * @dev Books any rise of the LP unit value above `_lpUnitValueWad` into `_lpValueGrowthWad`
     * and advances the mark. A non-increase is a no-op, so transient sub-wei rounding on the
     * way back up is never double-counted.
     * @param lAfterQ128 Post-swap depth `L`, Q128.
     * @param priceScaleWad Anchor the depth was solved under, WAD.
     * @return vpNow Live unit value, WAD, passed on to {_tryAutoRepeg} as `vpBefore`; zero when
     * undefined.
     */
    function _accrueLpValueGrowth(
        uint256 lAfterQ128,
        uint256 priceScaleWad
    ) internal returns (uint256 vpNow) {
        vpNow = EquilibraSwapMath.computeLpUnitValueWad(lAfterQ128, priceScaleWad, totalSupply());
        if (vpNow == 0) return 0;
        uint256 vpLast = _lpUnitValueWad;
        if (vpNow <= vpLast) return vpNow;
        unchecked {
            uint256 delta = vpNow - vpLast;
            uint256 newGrowth = _lpValueGrowthWad + delta;
            _lpValueGrowthWad = newGrowth;
            _lpUnitValueWad = vpNow;
            emit LpValueGrowthAccrued(delta, newGrowth);
        }
    }

    /**
     * @dev LP unit value `2·L_eq · √(priceScale · WAD) / totalSupply` (WAD) of the supplied
     * reserves and curve snapshot, with `L_eq` recovered by `solveLFromState`. Returns zero on a
     * degenerate state, which callers treat as "metric undefined".
     * @param reserve0 Token0 reserve, raw.
     * @param reserve1 Token1 reserve, raw.
     * @param cs Curve snapshot supplying the knobs, anchor and scales.
     * @param totalSupplyWad LP share supply to divide by.
     * @return unitValueWad LP unit value, WAD; zero when undefined.
     */
    function _computeLpUnitValueWad(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs,
        uint256 totalSupplyWad
    ) internal pure returns (uint256 unitValueWad) {
        uint256 lEqQ128 = _poolDepth(reserve0, reserve1, cs);
        if (lEqQ128 == 0) return 0;
        unitValueWad = EquilibraSwapMath.computeLpUnitValueWad(
            lEqQ128,
            cs.priceScaleWad,
            totalSupplyWad
        );
    }

    /**
     * @dev Loads the curve knobs, the anchor and both decimal scales (three slots) into memory.
     */
    function _loadCurveParams() internal view returns (CurveSnapshot memory cs) {
        cs.aWad = uint256(_aWad);
        cs.lambdaWad = uint256(_lambdaWad);
        cs.priceScaleWad = _priceScaleWad;
        cs.token0Scale = uint256(_token0Scale);
        cs.token1Scale = uint256(_token1Scale);
    }

    /**
     * @dev Lifts raw reserves into math space: `xMath = xWad`, `yMath = divWad(yWad, priceScale)`.
     * At the anchor `yWad / xWad == priceScale`, so `yMath == xMath` (the diagonal). Returns
     * `(0, 0)` when either lifted reserve is zero.
     */
    function _toMathState(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs
    ) internal pure returns (uint256 xMath, uint256 yMath) {
        uint256 xWad = _toWadByScale(reserve1, cs.token1Scale);
        uint256 yWad = _toWadByScale(reserve0, cs.token0Scale);
        if (xWad == 0 || yWad == 0) return (0, 0);
        xMath = xWad;
        yMath = FixedPointMathLib.divWad(yWad, cs.priceScaleWad);
    }

    /**
     * @dev Builds the once-per-swap {MathState}: packed raw reserves, math-space coordinates and
     * the pre-swap depth `L` (Q128) from `solveLFromState`.
     */
    function _liftMathState(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs
    ) internal pure returns (MathState memory ms) {
        ms.reservesPacked = reserve0 | (reserve1 << 128);
        (ms.xMath, ms.yMath) = _toMathState(reserve0, reserve1, cs);
        ms.lPreQ128 = EquilibraSwapMath.solveLFromState(ms.xMath, ms.yMath, cs.aWad, cs.lambdaWad);
    }

    /**
     * @dev Raw to WAD by the token's power-of-ten scale; exact.
     */
    function _toWadByScale(
        uint256 amountRaw,
        uint256 scale
    ) internal pure returns (uint256 amountWad) {
        if (scale == 1) return amountRaw;
        amountWad = amountRaw * scale;
    }

    /**
     * @dev WAD to raw, rounding down (output side, pool-favourable).
     */
    function _fromWadDownByScale(
        uint256 amountWad,
        uint256 scale
    ) internal pure returns (uint256 amountRaw) {
        if (scale == 1) return amountWad;
        amountRaw = amountWad / scale;
    }

    /**
     * @dev WAD to raw, rounding up (input side, pool-favourable).
     */
    function _fromWadUpByScale(
        uint256 amountWad,
        uint256 scale
    ) internal pure returns (uint256 amountRaw) {
        if (scale == 1) return amountWad;
        amountRaw = FixedPointMathLib.mulDivUp(amountWad, 1, scale);
    }

    /**
     * @dev Splits a raw fee into the protocol cut `⌊fee · protocolFeePercent / 100⌋` and the LP
     * remainder.
     */
    function _splitFee(
        uint256 feeAmount
    ) private view returns (uint256 protocolCut, uint256 lpFeeCut) {
        protocolCut = (feeAmount * _protocolFeePercent) / 100;
        lpFeeCut = feeAmount - protocolCut;
    }

    /**
     * @dev Reverts `MathInvariantViolation` unless each token balance covers its reserve plus
     * its protocol-fee bucket.
     */
    function _assertSolvency(address t0, address t1) internal view {
        uint256 balance0 = SafeTransferLib.balanceOf(t0, address(this));
        uint256 balance1 = SafeTransferLib.balanceOf(t1, address(this));
        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        (uint256 protocol0, uint256 protocol1) = _getProtocolFeesInternal();
        uint256 required0 = reserve0 + protocol0;
        uint256 required1 = reserve1 + protocol1;
        if (balance0 < required0 || balance1 < required1) revert Errors.MathInvariantViolation();
    }

    /**
     * @dev Casts to `int256`, reverting `InvalidAmountSpecified` above `int256.max`.
     */
    function _toSignedPositive(uint256 value) internal pure returns (int256) {
        if (int256(value) >= 0) return int256(value);
        revert Errors.InvalidAmountSpecified();
    }

    /**
     * @dev Packs two raw amounts (low = token0, high = token1); reverts `MathInvariantViolation`
     * above `uint128`.
     */
    function _packPair128(uint256 low, uint256 high) private pure returns (uint256 packed) {
        if (low > _LOWER_128_MASK || high > _LOWER_128_MASK) revert Errors.MathInvariantViolation();
        packed = low | (high << 128);
    }

    /**
     * @dev Unpacks a 128/128 pair (low = token0, high = token1).
     */
    function _unpackPair128(uint256 packed) private pure returns (uint256 low, uint256 high) {
        low = packed & _LOWER_128_MASK;
        high = packed >> 128;
    }
}
