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

/// @title EquilibraPool
/// @notice Clone-friendly 2-token AMM with anchor-driven concentration.
/// @dev Kernel:
///   • Asymmetric (quote-side normalised) math-space coordinate change:
///     `xMath = xWad` (base, identity), `yMath = yWad · WAD / priceScale`
///     (quote → base units). At the anchor `yMath == xMath` and the
///     kernel evaluates on the math-space diagonal; a repeg at fixed
///     reserves shifts `yMath` only.
///   • Two-knob cubic invariant:
///         K(x, y; L) = A · L · (x+y)/2 + (W − A) · xy,
///         A = a · W / (W + λ · D),
///         D = (y − x)² / (xy)
///     with `a` (depth at anchor) and `λ` (plateau width) as independent
///     concentration knobs. Polynomial degree in `y` (after clearing
///     denominators) is **3**, giving a well-conditioned cubic envelope
///     for the secant solver.
///   • Depth scale `L` is recovered per-leg from the pre-state via the
///     closed-form quadratic `solveLFromState` (positive root of
///     `W·L² − A·L·S − (W−A)·N = 0`) and frozen for the secant solver.
///   • LP unit value `vp = 2·L_eq · √(priceScale·WAD) / totalSupply` is
///     anchor-invariant under proportional mint/burn and re-anchor of
///     fixed reserves.
///   • Two-gate auto-repeg backed by the `vpGenesis / vpLast /
///     lpValueGrowth` accounting trio. `_repegShareBps` is stored
///     pre-scaled for protocol-fee compensation (see {initialize}).
contract EquilibraPool is
    IEquilibraPool,
    ReentrancyGuardTransient,
    EquilibraLpToken,
    EquilibraPoolGuard
{
    using FixedPointMathLib for uint256;

    /// @dev Force the pure-TSTORE reentrancy guard on every chain —
    ///      the pool only deploys on Cancun-ready EVM targets, so the
    ///      Solady fallback to SSTORE-based locking is unnecessary
    ///      and would add a redundant warm/cold slot per swap.
    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }

    // ============ Core pool state ============
    /// @dev Private-pool flag, packed ahead of `_token0` (8 + 160 bits
    ///      in one slot): the mint gate's flag check is that slot's
    ///      first touch and the settlement block re-reads `_token0`
    ///      from the then-warm slot, so a PUBLIC mint pays nothing
    ///      beyond its pre-existing token read; a PRIVATE mint's one
    ///      extra cold slot is `_factory`, which its allowlist
    ///      staticcall needs anyway. Set once at {initialize} and
    ///      immutable for the pool's lifetime: LPs must be able to
    ///      rely on a public pool never becoming gated.
    bool private _isPrivate;
    address private _token0;
    address private _token1;
    address private _factory;

    // Packed config slot (256 bits used / 256):
    //   _baseFee (16) + _protocolFeePercent (8) + _emaPeriod (32)
    //   + _feeFloorBps (16) + _repegShareBps (16) + _token0Scale (64)
    //   + _token1Scale (64) + _pairPoolIndex (32) + _parachuteBandMult (8).
    uint16 private _baseFee;
    uint8 private _protocolFeePercent;
    uint32 private _emaPeriod;
    uint16 private _feeFloorBps;
    uint16 private _repegShareBps;
    uint64 private _token0Scale;
    uint64 private _token1Scale;
    uint32 private _pairPoolIndex;
    /// @dev Donation-parachute activation multiplier K: the parachute
    ///      opens only at geometric deviation ≥ K × the active
    ///      dead-band. NOT a creation parameter — every pool starts at
    ///      `Constants.REPEG_PARACHUTE_BAND_MULT`; runtime-adjustable
    ///      through the param timelock ({setParachuteBandMult}, range
    ///      `[1, 255]`). Occupies the last free byte of this slot, so
    ///      the parachute's read is a warm SLOAD of a slot the repeg
    ///      path already touched.
    uint8 private _parachuteBandMult;

    /// @dev Smoothstep dynamic-fee warm-up width pre-scaled to WAD
    ///      (`feeRampBps × 1e14`). `0` ⇒ dynamic ramp disabled.
    uint64 private _feeRampDistWad;

    /// @dev Two-knob curve parameters, sharing one slot with
    ///      `_feeRampDistWad` above and the downward repeg dead-band
    ///      below (64 × 4 = 256 bits). Bounded by
    ///      `[A_MIN_WAD..A_MAX_WAD]` and
    ///      `[LAMBDA_MIN_WAD..LAMBDA_MAX_WAD]`, both `< WAD = 1e18`
    ///      `< 2^60`, so `uint64` fits with headroom.
    uint64 private _aWad;
    uint64 private _lambdaWad;

    /// @dev Downward auto-repeg dead-band (`ema < priceScale`), the
    ///      direction pair of `_repegThresholdToken1UpWad` below. Lives
    ///      in this slot because the timestamps slot is full and every
    ///      swap already warms this slot for `_aWad`/`_lambdaWad`/
    ///      `_feeRampDistWad` — the direction split costs zero extra
    ///      SLOADs on the hot path.
    uint64 private _repegThresholdToken1DownWad;

    /// @dev Pool price scale `yWad / xWad` at the anchor (WAD-scaled,
    ///      quote-per-base in the lifted form). Used by the
    ///      asymmetric coord change `yMath = yWad · WAD / priceScale`
    ///      that gives the auto-repeg gate an IL signal: a repeg
    ///      moves only `yMath`, so off-balance reserves register a
    ///      genuine math-space displacement after each anchor shift.
    uint256 private _priceScaleWad;

    /// @dev Live EMA of the (capped) raw spot price. Updated lazily
    ///      on every swap via `PoolOracle.updateEma`.
    uint256 private _emaPriceWad;

    /// @dev Epoch base of the auto-repeg gate threshold. Seeded at
    ///      genesis with `vp = 2·L_eq · √(priceScale · WAD) /
    ///      totalSupply` (constrained to `2·WAD ±
    ///      MAX_GENESIS_VP_ERROR_WAD` at pool creation) and
    ///      ratcheted forward by {setRepegShareBps}: each share change
    ///      seals the closing epoch's protected slice into the base.
    ///      Monotone non-decreasing, always ≤ the live unit value.
    uint256 private _lpUnitValueGenesisWad;

    /// @dev Live high-water mark of `vp`. Monotone-up between swaps;
    ///      drops to the post-repeg value on a successful auto-repeg.
    uint256 private _lpUnitValueWad;

    /// @dev Cumulative monotone-up accumulator of all positive `vp`
    ///      deltas ever booked. Drives the auto-repeg gate via
    ///        threshold = genesis + growth · (BPS − repegShareBps) / BPS.
    ///      Never decremented (not even by a successful repeg).
    uint256 private _lpValueGrowthWad;

    /// @dev Packed into one slot with the timestamps (64+64+64+64 =
    ///      256 bits): `_repegStepWad` and the upward dead-band are
    ///      bounded by the factory to `[MIN_REPEG_STEP, MAX_REPEG_STEP]
    ///      = [1, 1e18]`, which fits `uint64` (max ≈ 1.8e19) with
    ///      headroom. Packing turns the per-swap reads in
    ///      `_tryAutoRepeg` from cold SLOADs of dedicated slots into
    ///      warm reads of the slot `_updateEma` already touched
    ///      (−~2000 gas/swap on repeg-enabled pools; audit O-2).
    ///      `_pairPoolIndex` lives in the fee-config slot: it is
    ///      metadata-only and freed the 64 bits the threshold needs.
    ///      The DOWNWARD dead-band pair lives in the curve-knob slot
    ///      (`_repegThresholdToken1DownWad` above) — this slot is full.
    uint64 private _lastEmaTs;
    uint64 private _lastRepegTs;
    uint64 private _repegStepWad;
    uint64 private _repegThresholdToken1UpWad;

    // Clean reserves (low 128 = token0, high 128 = token1).
    uint256 private _reservesPacked;

    // Protocol-fee buckets (low 128 = token0, high 128 = token1).
    uint256 private _protocolFeesPacked;

    uint256 private constant _LOWER_128_MASK = type(uint128).max;

    /// @dev Internal hot-path SLOAD batching struct. Loaded once per
    ///      swap / repeg / EMA update via `_loadCurveParams`; passed
    ///      by memory to all math-kernel helpers.
    struct CurveSnapshot {
        uint256 aWad;
        uint256 lambdaWad;
        uint256 priceScaleWad;
        uint256 token0Scale;
        uint256 token1Scale;
    }

    struct SwapMathResult {
        uint256 amountOutWad;
        uint256 amountInCleanWad;
        uint256 finalXMath;
        uint256 finalYMath;
    }

    /// @dev Pre-state snapshot in math-space, lifted and L-solved
    ///      exactly ONCE per swap/quote and threaded through the EMA
    ///      sample, the fee resolver and the swap kernel (audit O-3 —
    ///      previously each stage re-lifted the same reserves and the
    ///      quote helpers re-solved the same quadratic). `lPreWad` is
    ///      `solveLFromState(xMath, yMath)`; the kernel is symmetric in
    ///      `(x, y)`, so the one value serves both trade directions
    ///      bit-for-bit.
    struct MathState {
        uint256 xMath;
        uint256 yMath;
        uint256 lPreWad;
    }

    struct SwapAmounts {
        uint256 amountInRaw;
        uint256 amountOutRaw;
        uint256 amountInCleanRaw;
        uint256 feeAmount;
        uint256 protocolCut;
        uint256 lpFeeCut;
    }

    /// @dev `addLiquidity` working set held in memory (one stack slot
    ///      for the pointer): the pre-callback snapshot — reserves and
    ///      the parked-buffer split — survives the mint callback, and
    ///      the frame stays within the 16-slot legacy-codegen stack
    ///      limit (coverage builds compile without viaIR).
    struct AddState {
        uint256 supplyBefore;
        uint256 reserve0;
        uint256 reserve1;
        uint256 parkedBefore;
        uint256 amount0Used;
        uint256 amount1Used;
    }

    modifier onlyOnce(address factoryAddress) {
        if (_factory != address(0)) revert Errors.AlreadyInitialized();
        _factory = factoryAddress;
        _;
    }

    // ============ Implementation lock ============

    /// @notice Lock the implementation contract so it can never be
    ///         initialised directly.
    /// @dev    EIP-1167 clones have their own storage. The implementation
    ///         deploys with `_factory = address(this) != 0`, so any
    ///         external `initialize()` reverts with `AlreadyInitialized`.
    constructor() {
        _factory = address(this);
    }

    // ============ Initialization ============

    /// @inheritdoc IEquilibraPool
    /// @dev All parameter bounds are validated by `EquilibraFactory`
    ///      before the clone is initialised.
    function initialize(InitParams calldata params) external override onlyOnce(msg.sender) {
        _token0 = params.token0;
        _token1 = params.token1;
        _token0Scale = params.token0Scale;
        _token1Scale = params.token1Scale;

        _baseFee = params.baseFee;
        _protocolFeePercent = params.protocolFeePercent;
        _emaPeriod = params.emaPeriod;

        _feeFloorBps = params.feeFloorBps;
        // Pre-scale `repegShareBps` to encode protocol-fee
        // compensation so the hot-path repeg gate consumes the
        // user-set share of growth regardless of `protocolFeePercent`:
        //   stored = ⌊ user · BPS / (BPS − p·100) ⌋
        _repegShareBps = uint16(
            FixedPointMathLib.mulDiv(
                uint256(params.repegShareBps),
                Constants.BPS,
                Constants.BPS - uint256(params.protocolFeePercent) * 100
            )
        );
        _feeRampDistWad = params.feeRampBps == 0 ? 0 : uint64(uint256(params.feeRampBps) * 1e14);

        _aWad = params.aWad;
        _lambdaWad = params.lambdaWad;

        // Seed `priceScale` at WAD (1.0). The genesis liquidity mint
        // replaces this with the seeded reserve ratio
        // `yWad / xWad` (see `addLiquidity` genesis branch).
        _priceScaleWad = Constants.WAD;
        _emaPriceWad = Constants.WAD;

        _lastEmaTs = uint64(block.timestamp);
        _lastRepegTs = uint64(block.timestamp);
        _pairPoolIndex = params.pairPoolIndex;
        _isPrivate = params.isPrivate;
        // Deliberately NOT an `InitParams` field: every pool starts at
        // the canonical default and the knob stays timelock-adjustable
        // afterwards ({setParachuteBandMult}).
        _parachuteBandMult = uint8(Constants.REPEG_PARACHUTE_BAND_MULT);
        // Safe narrowing: factory enforces every repeg knob ∈ [1, WAD]
        // and WAD = 1e18 < 2^64 (see `EquilibraFactory` bounds check).
        _repegStepWad = uint64(params.repegStepWad);
        _repegThresholdToken1UpWad = uint64(params.repegThresholdToken1UpWad);
        _repegThresholdToken1DownWad = uint64(params.repegThresholdToken1DownWad);

        _setLpTokenMetadata(params.lpName, params.lpSymbol);
    }

    // ============ Swaps ============

    /// @inheritdoc IEquilibraPool
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

            // Lift the pre-state into math-space and solve its depth L
            // exactly once — the EMA sample, the fee resolver and the
            // kernel below all reuse this snapshot (audit O-3).
            MathState memory ms = _liftMathState(reserve0, reserve1, cs);

            uint256 emaBefore = _updateEma(ms, cs);

            amounts = _computeSwapAmounts(zeroForOne, amountSpecified, ms, cs);

            if (zeroForOne) {
                if (amounts.amountOutRaw >= reserve1) revert Errors.InsufficientLiquidity();
                amount0 = _toSignedPositive(amounts.amountInRaw);
                amount1 = -_toSignedPositive(amounts.amountOutRaw);
                reserve0 += amounts.amountInRaw - amounts.protocolCut;
                reserve1 -= amounts.amountOutRaw;
                _accrueProtocolFees(amounts.protocolCut, 0);
            } else {
                if (amounts.amountOutRaw >= reserve0) revert Errors.InsufficientLiquidity();
                amount0 = -_toSignedPositive(amounts.amountOutRaw);
                amount1 = _toSignedPositive(amounts.amountInRaw);
                reserve1 += amounts.amountInRaw - amounts.protocolCut;
                reserve0 -= amounts.amountOutRaw;
                _accrueProtocolFees(0, amounts.protocolCut);
            }

            _setReservesInternal(reserve0, reserve1);

            uint256 vpNow = _accrueLpValueGrowth(reserve0, reserve1, cs);

            priceScaleForEvent = _tryAutoRepeg(reserve0, reserve1, cs, vpNow, emaBefore);
        }

        // Scope 2: Settlement — token transfer, callback, solvency.
        {
            address tokenIn = zeroForOne ? _token0 : _token1;
            address tokenOut = zeroForOne ? _token1 : _token0;
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

    /// @inheritdoc IEquilibraPool
    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        bytes calldata data
    ) external override nonReentrant whenNotPaused returns (uint256 sharesOut) {
        if (recipient == address(0)) revert Errors.ZeroAddress();
        if (amount0 == 0 || amount1 == 0) revert Errors.ZeroAmount();
        // Private pools gate the RECIPIENT, not the caller: minting is
        // routed (router, zaps, factory genesis), so the payer is rarely
        // the LP. Gating the party that ends up holding the shares is
        // what actually bounds who can join, and it covers every mint
        // path at one site. Note the scope: LP shares stay transferable,
        // so the allowlist bounds entry through minting, not secondary
        // custody.
        if (_isPrivate) _enforceLpAllowed(recipient);

        // Working set in memory (one stack slot); see `AddState`.
        AddState memory p;
        p.supplyBefore = totalSupply();
        (p.reserve0, p.reserve1) = _getReservesInternal();
        // Snapshot the donation buffer ONCE, before the mint callback,
        // pinning the active/parked split against a self-donation
        // slipped into `equilibraMintCallback`. Zero at genesis.
        p.parkedBefore = balanceOf(address(this));

        // Buffer top-up shares, COMPUTED before the callback from the
        // snapshot but MINTED only after settlement (see below). Stays 0
        // at genesis and on donation-free pools.
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

            // Initial priceScale = yWad / xWad (quote-per-base in WAD
            // form). At the anchor `yMath = yWad · WAD / priceScale =
            // xWad = xMath`, placing the seeded reserves on the
            // math-space diagonal.
            uint256 initialPriceScale = FixedPointMathLib.divWad(yWad, xWad);
            if (initialPriceScale == 0) revert Errors.InvalidPriceScale();
            _priceScaleWad = initialPriceScale;
            _emaPriceWad = initialPriceScale;
            _lastEmaTs = uint64(block.timestamp);

            uint256 geoMeanWad = FixedPointMathLib.sqrt(xWad * yWad);
            if (geoMeanWad <= Constants.MIN_INITIAL_LIQUIDITY)
                revert Errors.MathInvariantViolation();
            _mint(address(0xdEaD), Constants.MIN_INITIAL_LIQUIDITY);
            sharesOut = geoMeanWad - Constants.MIN_INITIAL_LIQUIDITY;

            // Snapshot the genesis LP unit value under the freshly
            // seeded priceScale; the high-water mark and the gate
            // threshold-floor both reference it.
            uint256 vpGenesisWad = _computeLpUnitValueWad(
                p.reserve0,
                p.reserve1,
                _loadCurveParams(),
                geoMeanWad
            );
            // Enforce the genesis identity `vp == 2·WAD` (within rounding
            // tolerance). Insufficient normalized depth can store an
            // understated or zero genesis floor; an extreme reserve ratio
            // can also quantize `priceScale` too coarsely. Either case would
            // let auto-repeg spend LP principal the floor is meant to
            // preserve. The geomean burn floor above cannot guarantee this
            // — under the asymmetric coord change `nWad` depends on the
            // base-side reserve, not the geometric mean — so the precision
            // gate is separate and authoritative.
            uint256 twoWad = 2 * Constants.WAD;
            uint256 vpErr = vpGenesisWad > twoWad ? vpGenesisWad - twoWad : twoWad - vpGenesisWad;
            if (vpErr > Constants.MAX_GENESIS_VP_ERROR_WAD)
                revert Errors.GenesisVpImprecise(vpGenesisWad);
            _lpUnitValueGenesisWad = vpGenesisWad;
            _lpUnitValueWad = vpGenesisWad;
        } else {
            p.amount0Used = amount0;
            p.amount1Used = FixedPointMathLib.mulDiv(amount0, p.reserve1, p.reserve0);
            if (p.amount1Used > amount1) {
                p.amount1Used = amount1;
                p.amount0Used = FixedPointMathLib.mulDiv(amount1, p.reserve0, p.reserve1);
            }
            if (p.amount0Used == 0 || p.amount1Used == 0)
                revert Errors.AmountTooSmallAfterNormalization();

            // Active-share pricing: parked donation shares (the pool's
            // own LP balance) carry no claim on reserves, so the mint is
            // quoted against the ACTIVE share count — the joiner pays the
            // active shares' going rate, no premium. The buffer top-up
            // below keeps `parked/active` invariant, which makes the
            // unit-value metric `vp = Λ/totalSupply` exactly invariant
            // across every proportional mint: a deposit can neither
            // manufacture spendable repeg budget nor destroy headroom.
            uint256 activeBefore = p.supplyBefore - p.parkedBefore;
            sharesOut = FixedPointMathLib.mulDiv(p.amount0Used, activeBefore, p.reserve0);

            // Buffer scaling (mint leg): grow the parked buffer in the
            // same proportion as the active float. Computed now from the
            // pre-callback snapshot; minted after settlement. The top-up
            // is fresh supply whose claim is zero (active-share
            // redemption excludes the pool's balance), mirrored by the
            // proportional buffer burn on the exit leg.
            if (p.parkedBefore != 0)
                bufferTopUp = FixedPointMathLib.mulDiv(sharesOut, p.parkedBefore, activeBefore);

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

        // Settlement verified — value-giving mints happen strictly AFTER
        // the callback has paid: first the (claimless, pool-owned) buffer
        // top-up, then the recipient's shares.
        if (bufferTopUp != 0) _mint(address(this), bufferTopUp);
        _mint(recipient, sharesOut);

        if (p.supplyBefore > 0) {
            _reanchorLpUnitValue(p.reserve0, p.reserve1, _loadCurveParams());
        }

        emit LiquidityAdded(msg.sender, recipient, p.amount0Used, p.amount1Used, sharesOut);
    }

    /// @inheritdoc IEquilibraPool
    /// @dev LP withdrawals remain callable while paused so LPs can exit.
    function removeLiquidity(
        uint256 shares,
        uint256 minAmount0,
        uint256 minAmount1,
        address recipient
    ) external override nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (recipient == address(0)) revert Errors.ZeroAddress();
        if (shares == 0) revert Errors.ZeroAmount();

        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        // Active-share redemption: parked donation shares hold no claim
        // on reserves, so payouts divide by the ACTIVE float. The
        // proportional buffer burn below keeps `parked/active` — and
        // therefore `vp` and the parachute's feasibility — invariant
        // across the exit, the mirror of the mint-side buffer top-up.
        uint256 parked = balanceOf(address(this));
        uint256 activeBefore = totalSupply() - parked;
        amount0 = FixedPointMathLib.mulDiv(reserve0, shares, activeBefore);
        amount1 = FixedPointMathLib.mulDiv(reserve1, shares, activeBefore);
        // Dust guard: on low-decimals pools (raw reserves ≪ LP supply)
        // a tiny share amount can floor BOTH payouts to zero — burning
        // the shares for nothing. Refuse loudly instead of silently
        // donating the dust to remaining LPs (audit I-8).
        if (amount0 == 0 && amount1 == 0) revert Errors.AmountTooSmallAfterNormalization();

        if (amount0 < minAmount0 || amount1 < minAmount1) revert Errors.SlippageExceeded();

        _burn(msg.sender, shares);
        // Burn the exiting holder's proportional slice of the buffer so
        // `parked/active` is unchanged. Without this the exit would
        // dilute the buffer's backing and drop `vp` below the gate
        // floor on any pool holding a donation. Genesis and
        // donation-free pools skip it (`parked == 0`).
        if (parked != 0) {
            uint256 bufferBurn = FixedPointMathLib.mulDiv(parked, shares, activeBefore);
            if (bufferBurn != 0) _burn(address(this), bufferBurn);
        }

        {
            uint256 reserve0After = reserve0 - amount0;
            uint256 reserve1After = reserve1 - amount1;
            _setReservesInternal(reserve0After, reserve1After);

            _reanchorLpUnitValue(reserve0After, reserve1After, _loadCurveParams());

            address t0 = _token0;
            address t1 = _token1;
            SafeTransferLib.safeTransfer(t0, recipient, amount0);
            SafeTransferLib.safeTransfer(t1, recipient, amount1);
            _assertSolvency(t0, t1);
        }

        emit LiquidityRemoved(msg.sender, recipient, amount0, amount1, shares);
    }

    // NOTE: donations are plain LP `transfer`s to the pool's own
    // address — the pool needs no entrypoint for them. The guarded
    // variant (maxSupply pin + deadline) lives in the ROUTER
    // (`EquilibraRouter.donate`), freeing this contract's scarce
    // EIP-170 budget; the parked shares' semantics (no claim on
    // reserves, spendable only by {_tryDonationParachute}'s emergency
    // burn, proportionally rescaled by the liquidity legs) are
    // documented at {_tryDonationParachute}.

    // ============ Protocol fees ============

    /// @inheritdoc IEquilibraPool
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

    /// @inheritdoc IEquilibraPool
    function setPaused(bool paused_) external override {
        _enforceFactoryOwner();
        _setPaused(paused_);
        emit PauseStateChanged(paused_, msg.sender);
    }

    // ============ Runtime parameters (param timelock only) ============

    /// @inheritdoc IEquilibraPool
    /// @dev Bare store gated to the param timelock — the same trust
    ///      split as {initialize}. Every fee invariant (bounds, ramp
    ///      headroom, and the stall guard against the immutable stored
    ///      threshold) is validated by `EquilibraParamTimelock`, both at
    ///      queue time and again at execution against the live config,
    ///      so the pool keeps no revalidation logic in its bytecode.
    function setFeeParams(
        uint16 baseFee_,
        uint16 feeRampBps_,
        uint16 feeFloorBps_
    ) external override {
        _enforceParamTimelock();
        _baseFee = baseFee_;
        _feeFloorBps = feeFloorBps_;
        _feeRampDistWad = feeRampBps_ == 0 ? 0 : uint64(uint256(feeRampBps_) * 1e14);
        emit FeeParamsUpdated(baseFee_, feeRampBps_, feeFloorBps_);
    }

    /// @inheritdoc IEquilibraPool
    function setRepegStepWad(uint64 repegStepWad_) external override {
        _enforceParamTimelock();
        _repegStepWad = repegStepWad_;
        emit RepegStepUpdated(repegStepWad_);
    }

    /// @inheritdoc IEquilibraPool
    function setRepegThresholds(
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) external override {
        _enforceParamTimelock();
        _repegThresholdToken1UpWad = repegThresholdToken1UpWad_;
        _repegThresholdToken1DownWad = repegThresholdToken1DownWad_;
        emit RepegThresholdsUpdated(repegThresholdToken1UpWad_, repegThresholdToken1DownWad_);
    }

    /// @inheritdoc IEquilibraPool
    /// @dev Stores the share pre-scaled for protocol-fee compensation
    ///      with the same map as {initialize}, so `getFeeConfig`
    ///      round-trips the user-facing value bit-for-bit.
    function setRepegShareBps(uint16 repegShareBps_) external override {
        _enforceParamTimelock();
        // Seal the closing epoch under the OUTGOING share: the slice
        // of accumulated growth it protected ratchets into the base
        // forever, the accumulator restarts, and the live spendable
        // gap (vp − floor) carries over untouched — the incoming
        // share splits only future earnings. History is split exactly
        // once, by the share in force while it was earned; the jump
        // size therefore depends on the outgoing share only. Ceil
        // rounding favours the LPs.
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

    /// @inheritdoc IEquilibraPool
    /// @dev Bare store gated to the param timelock, same trust split as
    ///      the other runtime setters: the `[1, 255]` range (zero would
    ///      erase the lag qualifier and turn the parachute into a
    ///      continuous top-up) is enforced by `EquilibraParamTimelock`
    ///      at queue AND execution time.
    function setParachuteBandMult(uint8 parachuteBandMult_) external override {
        _enforceParamTimelock();
        _parachuteBandMult = parachuteBandMult_;
        emit ParachuteBandMultUpdated(parachuteBandMult_);
    }

    // ============ Views ============
    /// @inheritdoc IEquilibraPool
    function quoteExactIn(
        bool zeroForOne,
        uint256 amountIn
    ) external view override returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > _LOWER_128_MASK) return 0;
        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        if (reserve0 == 0 || reserve1 == 0) return 0;

        CurveSnapshot memory cs = _loadCurveParams();
        uint256 outScale = zeroForOne ? cs.token1Scale : cs.token0Scale;

        MathState memory ms = _liftMathState(reserve0, reserve1, cs);
        (SwapMathResult memory result, , ) = _executeExactInWithDynamicFee(
            zeroForOne,
            amountIn,
            ms,
            cs
        );

        amountOut = _fromWadDownByScale(result.amountOutWad, outScale);
    }

    /// @inheritdoc IEquilibraPool
    function quoteExactOut(
        bool zeroForOne,
        uint256 amountOut
    ) external view override returns (uint256 amountIn) {
        if (amountOut == 0 || amountOut > _LOWER_128_MASK) return 0;
        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        if (reserve0 == 0 || reserve1 == 0) return 0;

        CurveSnapshot memory cs = _loadCurveParams();

        MathState memory ms = _liftMathState(reserve0, reserve1, cs);
        (, , , amountIn) = _executeExactOutWithDynamicFee(zeroForOne, amountOut, ms, cs);
    }

    /// @inheritdoc IEquilibraPool
    function getCurveParams() external view override returns (CurveParams memory cp) {
        cp.aWad = uint256(_aWad);
        cp.lambdaWad = uint256(_lambdaWad);
    }

    /// @inheritdoc IEquilibraPool
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
        // Stored value is the internal relaxation time tau; the view
        // reports the human-facing HALF-LIFE `tau * 694 / 1000`.
        // Exact round-trip with the factory's ceil conversion.
        cfg.emaPeriod = uint32((uint256(_emaPeriod) * 694) / 1000);
        cfg.repegStepWad = _repegStepWad;
        cfg.repegThresholdToken1UpWad = _repegThresholdToken1UpWad;
        cfg.repegThresholdToken1DownWad = _repegThresholdToken1DownWad;
        cfg.parachuteBandMult = _parachuteBandMult;
    }

    /// @inheritdoc IEquilibraPool
    function getPoolMetadata() external view override returns (PoolMetadata memory meta) {
        meta.token0 = _token0;
        meta.token1 = _token1;
        meta.factory = _factory;
        meta.pairPoolIndex = _pairPoolIndex;
    }

    /// @inheritdoc IEquilibraPool
    function getOracleState() external view override returns (OracleState memory state) {
        state.priceScaleWad = _priceScaleWad;
        state.emaPriceWad = _emaPriceWad;

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

    /// @inheritdoc IEquilibraPool
    function getOracleTimestamps()
        external
        view
        override
        returns (uint64 lastEmaTs, uint64 lastRepegTs)
    {
        return (_lastEmaTs, _lastRepegTs);
    }

    /// @inheritdoc IEquilibraPool
    /// @dev Reads Solady's `ReentrancyGuardTransient` slot directly. The
    ///      pool forces the pure-`TSTORE` path
    ///      (`_useTransientReentrancyGuardOnlyOnMainnet() == false`), so
    ///      the guard stores this contract's own address on entry and
    ///      zero on exit — a non-zero load means a guarded frame is live.
    ///      The slot constant is Solady's
    ///      `uint32(bytes4(keccak256("Reentrancy()"))) | (1 << 71)`
    ///      (`ReentrancyGuardTransient._REENTRANCY_GUARD_SLOT`), pinned by
    ///      a reentrancy-triggering test so a dependency bump that moves
    ///      it fails loudly rather than silently reporting "not entered".
    function reentrancyGuardEntered() external view override returns (bool entered) {
        assembly ("memory-safe") {
            entered := iszero(iszero(tload(0x8000000000ab143c06)))
        }
    }

    /// @inheritdoc IEquilibraPool
    function getLiveEmaPrice() external view override returns (uint256 emaPriceWad) {
        uint256 storedEma = _emaPriceWad;
        uint256 priceScale = _priceScaleWad;
        if (storedEma == 0 || priceScale == 0) return storedEma;

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
        uint256 spotRaw = FixedPointMathLib.mulWad(pMargMath, priceScale);

        PoolOracle.EmaState memory next = PoolOracle.updateEma(
            PoolOracle.EmaState({ emaPriceWad: storedEma, lastUpdateTs: _lastEmaTs }),
            spotRaw,
            priceScale,
            _emaPeriod,
            uint64(block.timestamp)
        );
        emaPriceWad = next.emaPriceWad;
    }

    /// @inheritdoc IEquilibraPool
    function getLpValueState() external view override returns (LpValueState memory state) {
        state.unitValueWad = _lpUnitValueWad;
        state.genesisWad = _lpUnitValueGenesisWad;
        state.growthWad = _lpValueGrowthWad;
    }

    /// @inheritdoc IEquilibraPool
    function getReserves() external view override returns (uint256 reserve0, uint256 reserve1) {
        return _getReservesInternal();
    }

    /// @inheritdoc IEquilibraPool
    function getProtocolFees() external view override returns (uint256 fee0, uint256 fee1) {
        return _getProtocolFeesInternal();
    }

    /// @inheritdoc IEquilibraPool
    function paused() external view override returns (bool) {
        return _paused;
    }

    /// @inheritdoc IEquilibraPool
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

    // ============ V3-style price target quoter ============

    struct QuoteBisectCtx {
        bool zeroForOne;
        uint256 pTargetMath;
        MathState ms;
        CurveSnapshot cs;
        uint256 inScale;
        uint256 outScale;
        uint256 inputReserve;
        uint256 protocolFeePercent;
    }

    /// @inheritdoc IEquilibraPool
    function quoteSwapToPrice(
        bool zeroForOne,
        uint160 sqrtPriceTargetX96
    ) external view override returns (uint256 amountIn, uint256 amountOut, bool crossesAnchor) {
        if (sqrtPriceTargetX96 == 0) return (0, 0, false);

        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        if (reserve0 == 0 || reserve1 == 0) return (0, 0, false);

        CurveSnapshot memory cs = _loadCurveParams();
        if (cs.priceScaleWad == 0) return (0, 0, false);

        uint256 pTargetMath = EquilibraSwapMath.sqrtPriceX96ToMathPriceWad(
            sqrtPriceTargetX96,
            cs.priceScaleWad,
            cs.token0Scale,
            cs.token1Scale
        );
        if (pTargetMath == 0) return (0, 0, false);

        // One lift + one L-solve serves the start-price sample AND every
        // bracket/bisection probe below (audit O-3).
        MathState memory ms = _liftMathState(reserve0, reserve1, cs);
        uint256 pStartMath = EquilibraSwapMath.marginalPrice(
            ms.xMath,
            ms.yMath,
            ms.lPreWad,
            cs.aWad,
            cs.lambdaWad
        );

        if (zeroForOne) {
            if (pTargetMath <= pStartMath) return (0, 0, false);
        } else {
            if (pTargetMath >= pStartMath) return (0, 0, false);
        }

        crossesAnchor =
            (pStartMath != Constants.WAD) &&
            (pTargetMath != Constants.WAD) &&
            ((pStartMath < Constants.WAD) != (pTargetMath < Constants.WAD));

        QuoteBisectCtx memory ctx = QuoteBisectCtx({
            zeroForOne: zeroForOne,
            pTargetMath: pTargetMath,
            ms: ms,
            cs: cs,
            inScale: zeroForOne ? cs.token0Scale : cs.token1Scale,
            outScale: zeroForOne ? cs.token1Scale : cs.token0Scale,
            inputReserve: zeroForOne ? reserve0 : reserve1,
            protocolFeePercent: uint256(_protocolFeePercent)
        });

        (amountIn, amountOut) = _bisectAmountInForTarget(ctx);
        // An unexecutable best iterate must not leak as a positive
        // quote: the kernel's dust soft-fail can report a zero output
        // for a nonzero probe (the executable trade would revert in the
        // typed dust guards), so fold it into the documented
        // "(0, 0, false)" no-admissible-amount shape — the
        // already-computed `crossesAnchor` resets with it. Checking the
        // output alone covers both sides: the bisection assigns
        // `(bestAmountIn, bestResult)` atomically, so a zero `amountIn`
        // only ever returns with the default (zero-output) result.
        if (amountOut == 0) return (0, 0, false);
    }

    // ============ Anchor / EMA ============

    /// @dev Sample the math-space marginal price, lift it to raw spot,
    ///      and fold into the EMA. Caller guarantees `reserve{0,1} > 0`
    ///      and supplies the pre-lifted math state (audit O-3).
    /// @return preEmaWad The EMA value BEFORE this update — threaded to
    ///         `_tryAutoRepeg` so `PriceScaleUpdated` can report a real
    ///         (old, new) EMA pair instead of twice the post-update
    ///         value (audit I-6). Equals the current EMA unchanged on
    ///         every early-return path.
    function _updateEma(
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal returns (uint256 preEmaWad) {
        preEmaWad = _emaPriceWad;
        uint64 nowTs = uint64(block.timestamp);
        if (nowTs <= _lastEmaTs) return preEmaWad;
        if (cs.priceScaleWad == 0) return preEmaWad;
        if (ms.xMath == 0 || ms.yMath == 0) return preEmaWad;

        // Math-space marginal price (L-supplied — solved once in the
        // caller); lift to raw spot (token1/token0 ratio in user-facing
        // frame): spotRaw = pMargMath · priceScale.
        uint256 pMargMath = EquilibraSwapMath.marginalPrice(
            ms.xMath,
            ms.yMath,
            ms.lPreWad,
            cs.aWad,
            cs.lambdaWad
        );
        uint256 spotRaw = FixedPointMathLib.mulWad(pMargMath, cs.priceScaleWad);

        PoolOracle.EmaState memory next = PoolOracle.updateEma(
            PoolOracle.EmaState({ emaPriceWad: preEmaWad, lastUpdateTs: _lastEmaTs }),
            spotRaw,
            cs.priceScaleWad,
            _emaPeriod,
            nowTs
        );
        _emaPriceWad = next.emaPriceWad;
        _lastEmaTs = next.lastUpdateTs;
    }

    /// @dev Two-gate auto-repeg. Operates on post-swap reserves and
    ///      reuses `vpBefore` from `_accrueLpValueGrowth` so the gate
    ///      pays for exactly one extra `_computeLpUnitValueWad`
    ///      (the `vpAfter` probe) per attempt.
    /// @param emaBeforeWad EMA value before this swap's `_updateEma`
    ///        commit — used only for `PriceScaleUpdated` telemetry so
    ///        the event reports a real (old, new) EMA pair (audit I-6).
    /// @return priceScaleAfter The committed price scale — the new value
    ///         on a successful repeg, the unchanged `cs.priceScaleWad`
    ///         on every skip path.
    function _tryAutoRepeg(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs,
        uint256 vpBefore,
        uint256 emaBeforeWad
    ) internal returns (uint256 priceScaleAfter) {
        priceScaleAfter = cs.priceScaleWad;

        // Explicit disable: `repegShareBps == 0` opts the pool out of
        // auto-repeg entirely. The stored share is pre-scaled at
        // `initialize` as `⌊user · BPS / (BPS − p·100)⌋`, which is `0`
        // iff the user share is `0` (any `user ≥ 1` bps yields `≥ 1`),
        // so this comparison faithfully detects the opt-out. The
        // threshold mechanism below would *almost* hold the gate shut on
        // its own, but `_reanchorLpUnitValue` can creep the live
        // `_lpUnitValueWad` above `vpGenesis + growth` by un-booked
        // mint/burn rounding dust, eventually clearing the gas-guard and
        // firing a (dust-funded) repeg on a pool configured as disabled.
        // This short-circuit makes the documented "disabled by
        // construction" guarantee exact (and skips the EMA / threshold
        // SLOADs on opt-out pools). See audit finding L-4.
        // Hoisted once: re-read again by the threshold math below (the
        // packed config slot is warm, but the duplicate SLOAD + shift
        // is still ~110 gas on every threshold-reaching swap).
        uint256 shareBps = uint256(_repegShareBps);
        if (shareBps == 0) return priceScaleAfter;

        if (vpBefore == 0) return priceScaleAfter;

        if (uint64(block.timestamp) <= _lastRepegTs) return priceScaleAfter;

        uint256 emaWad = _emaPriceWad;
        if (emaWad == 0) return priceScaleAfter;

        uint256 deviationWad;
        {
            // Activation dead-band: skip while the EMA/priceScale deviation
            // is below the active direction's dead-band
            // (`_repegThresholdToken1UpWad` while `ema > priceScale`,
            // else `_repegThresholdToken1DownWad`). Decoupled from the
            // per-repeg step cap `repegStepWad`: the threshold decides WHEN the
            // anchor wakes, the damped step decides HOW FAR it moves.
            // This gate is load-bearing, not a gas nicety:
            //
            //   1. It is the ONLY filter able to stop vp-neutral churn.
            //      Near the anchor a small `priceScale` move is value-
            //      neutral for the LP-unit metric (second-order in the
            //      step), so BOTH vp gates below pass and no growth budget
            //      is consumed — without this check any pool holding a
            //      growth cushion would commit a dust repeg nearly every
            //      block in a jittery sideways market (3 SSTOREs + event
            //      billed to the block's first swapper, plus permanent
            //      anchor/oracle churn).
            //   2. It keeps the hot path flat. `_lastRepegTs` advances only
            //      on a successful commit, so a non-committing attempt
            //      would re-run the threshold SLOADs, the shift candidate
            //      and the `vpAfter` probe on EVERY swap of the block; this
            //      early return prices the common case at one SLOAD + one
            //      mulDiv.
            //
            // Calibration: keep both dead-bands at or below the fee
            // floor (all read as relative fractions; see CLAUDE.md
            // "Sizing the repeg knobs"). The vp cost of a move fired at
            // deviation `dev`
            // grows ~quadratically in `dev` (move size `dev/5` × reserve
            // imbalance ∝ `dev`), while the fee-funded growth budget
            // accrued by the very flow that created the deviation grows
            // only ~linearly — a quantum set far above the fee scale pins
            // the pool where its first permitted move is already
            // unaffordable, and the anchor can stall until unrelated
            // volume replenishes the budget.
            //
            // Geometric (multiplicative) deviation `|max/min − 1|`. A ±2×
            // move of the EMA vs priceScale yields `1.0` WAD in BOTH
            // directions, consistent with the symmetric `[ps/2, 2ps]` EMA
            // clamp. The previous linear `|ema/ps − 1|` capped the
            // downward deviation at `0.5` (since `ema ≥ ps/2`), so any
            // threshold above `0.5·WAD` permanently blocked downward
            // repegs while upward still fired — a one-directional ratchet.
            // Upward (`ema ≥ ps`) is bit-identical to the old metric, so
            // only downward behaviour changes (see audit finding L-6).
            deviationWad = emaWad >= cs.priceScaleWad
                ? FixedPointMathLib.mulDiv(emaWad, Constants.WAD, cs.priceScaleWad) - Constants.WAD
                : FixedPointMathLib.mulDiv(cs.priceScaleWad, Constants.WAD, emaWad) - Constants.WAD;
            // Direction-split dead-band: `ema > priceScale` is an
            // internal token1-UP move (token1's price expressed in
            // token0 above the anchor). Under the mainnet address-sort
            // layout with the base asset in slot 0, a RISING base
            // market registers as token1-DOWN — the two knobs let the
            // deployer calibrate catch-up eagerness per direction
            // explicitly instead of inheriting it from averaging
            // artifacts.
            uint256 activeThresholdWad = emaWad > cs.priceScaleWad
                ? _repegThresholdToken1UpWad
                : _repegThresholdToken1DownWad;
            if (deviationWad < activeThresholdWad) return priceScaleAfter;
        }

        // Read the step cap only once the dead-band passed: the common
        // quiet-market exit above now skips this (warm) SLOAD entirely.
        // No reader exists before this point — the pre-gate parachute
        // handover and the ladder both sit below.
        uint256 stepWad = _repegStepWad;
        uint256 vpFloorWad;
        {
            // Scoped: keeps the frame within the 16-slot legacy-codegen
            // stack limit (coverage builds compile without viaIR).
            uint256 vpGenesis = _lpUnitValueGenesisWad;
            uint256 growth = _lpValueGrowthWad;
            vpFloorWad =
                vpGenesis +
                FixedPointMathLib.mulDiv(growth, Constants.BPS - shareBps, Constants.BPS);
            // No own budget ⇒ hand over to the donation parachute (the
            // ONLY path that may spend the donation buffer). The same
            // handover happens after the ladder exhausts every rung —
            // the parachute is consulted exactly when NO repeg
            // committed, and its own qualifiers (K × dead-band lag,
            // usable buffer, full-step shortfall covered) decide.
            if (vpBefore <= vpFloorWad + Constants.REPEG_GAS_GUARD_WAD)
                return
                    _tryDonationParachute(
                        reserve0,
                        reserve1,
                        cs,
                        emaWad,
                        emaBeforeWad,
                        stepWad,
                        deviationWad,
                        vpFloorWad
                    );
        }

        // Halving ladder: start from the damped applied step and, when
        // the post-move solvency probe refuses the candidate, retry with
        // the step halved (effective divisor D, 2D, 4D, 8D) instead of
        // freezing the anchor entirely. Every committed move passed the
        // REAL gate; no cross-block memory — the next attempt starts
        // fresh. `cs` is aliased by `csAfter` (memory struct assignment
        // copies the pointer), so the pre-repeg priceScale stays
        // available only in `priceScaleAfter`. Bit-for-bit with the
        // Rust reference ladder in `try_auto_repeg`. Strictly LP-budget-
        // funded: the donation buffer is spendable only by the parachute
        // branch above, never by a ladder rung.
        // Reuse `stepWad` as the base applied step — the raw cap has no
        // further reader and the legacy (non-viaIR) coverage pipeline
        // sits at the 16-slot stack limit here. (`appliedRepegStep` is
        // idempotent — `min(applied, dev/5) == applied` — so the
        // parachute handover below can pass the damped value where its
        // signature expects the raw cap.) Supply is invariant for the
        // whole attempt (no mint/burn can interleave a `nonReentrant`
        // swap), so it is read ONCE into `shareBps` — dead since the
        // threshold math — instead of once per rung probe.
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
            // Reuse `deviationWad` as the vpAfter probe slot (its last
            // read was the base-applied-step computation above) — same
            // 16-slot budget reasoning. `cs` is mutated in place for
            // the probe; the pre-repeg priceScale lives only in
            // `priceScaleAfter` from here on.
            {
                cs.priceScaleWad = priceScaleNew;
                deviationWad = _computeLpUnitValueWad(reserve0, reserve1, cs, shareBps);
            }
            // A degenerate zero probe needs no dedicated arm:
            // `vpFloorWad ≥ vpGenesis > 0` whenever a swap is executable
            // (genesis precedes the first swap), so `0 < vpFloorWad`
            // already refuses it.
            if (deviationWad < vpFloorWad) continue;

            _priceScaleWad = priceScaleNew;
            _lpUnitValueWad = deviationWad;
            _lastRepegTs = uint64(block.timestamp);
            // (old, new) EMA pair: pre-update value threaded from
            // swap()'s `_updateEma`, post-update value already in
            // `emaWad` — no redundant `_emaPriceWad` re-read.
            emit PriceScaleUpdated(priceScaleAfter, priceScaleNew, emaBeforeWad, emaWad);
            return priceScaleNew;
        }

        // Every rung refused ⇒ consult the parachute. Restore the
        // pre-repeg priceScale the probes overwrote and recompute the
        // geometric deviation (`deviationWad` was reused as the probe
        // slot; `emaWad` and `priceScaleAfter` are untouched, so the
        // recomputed value is bit-identical to the dead-band gate's).
        cs.priceScaleWad = priceScaleAfter;
        deviationWad = emaWad >= priceScaleAfter
            ? FixedPointMathLib.mulDiv(emaWad, Constants.WAD, priceScaleAfter) - Constants.WAD
            : FixedPointMathLib.mulDiv(priceScaleAfter, Constants.WAD, emaWad) - Constants.WAD;
        return
            _tryDonationParachute(
                reserve0,
                reserve1,
                cs,
                emaWad,
                emaBeforeWad,
                stepWad,
                deviationWad,
                vpFloorWad
            );
    }

    /// @dev Donation parachute — the ONLY spender of the donation
    ///      buffer (LP shares parked on the pool's own address; anyone
    ///      can top the buffer up with a plain LP `transfer`, which is
    ///      vp-neutral while parked — supply unchanged — and
    ///      irrevocable). Reached from `_tryAutoRepeg` whenever NO
    ///      repeg committed: from the pre-gate (no spendable growth
    ///      budget at all) and after the halving ladder exhausted every
    ///      rung. It opens only when the anchor additionally lags by at
    ///      least `parachuteBandMult × the active dead-band` — K stored
    ///      per pool, seeded at `Constants.REPEG_PARACHUTE_BAND_MULT`
    ///      and timelock-adjustable via {setParachuteBandMult} — so
    ///      ordinary regimes never consume donated funds and the
    ///      buffer survives as a genuine emergency reserve.
    ///
    ///      Commits the FULL damped step in one shot — no halving
    ///      ladder: halved rungs exist to fit a move into the pool's
    ///      own budget, and here they are pointless on both routes (the
    ///      pre-gate one has no budget at all; the post-ladder one just
    ///      had every rung, halves included, refused). The burn is
    ///      EXACTLY the shortfall
    ///        δ = ⌈S · (T − vpAfter) / T⌉
    ///      so the post-burn unit value lands ON `vpFloorWad` up to
    ///      rounding: `≥ T` is guaranteed (δ ≥ S·(T − vp)/T ⇒
    ///      T·(S − δ) ≤ S·vp ⇒ the floored latch `⌊vp · S / (S − δ)⌋ ≥
    ///      T`, no post-burn gate needed), and the overshoot above `T`
    ///      is the ceil's at-most-one-share over-burn expressed in unit
    ///      value — bounded by `~T / (S − δ)`, i.e. wei-scale whenever
    ///      the post-burn supply dwarfs `T` and growing only as the
    ///      supply shrinks toward the dead-share floor. That sub-share
    ///      remainder is the ONLY surplus a commit can hand to LP
    ///      holders, which makes sandwiching a parachute commit
    ///      value-free up to that rounding dust: the donation's entire
    ///      uplift is otherwise consumed by the anchor move within this
    ///      same transaction. A candidate that needs no subsidy
    ///      (`vpAfter ≥ threshold`, possible on the pre-gate route
    ///      where the ladder never probed) commits with δ = 0. The spend
    ///      rate stays bounded by the untouched cadence guard (one commit
    ///      per block, at least a second apart)
    ///      and step cap: donations make a move affordable, never
    ///      faster or larger.
    ///
    ///      `cs.priceScaleWad` is mutated for the probe and left dirty
    ///      on non-commit exits, mirroring the ladder's behaviour —
    ///      `swap()` reads nothing from `cs` afterwards. Pools with
    ///      `repegShareBps == 0` never reach this code (step-0
    ///      short-circuit), so donations sent to opted-out pools are
    ///      unspendable by design — documented, do not donate there.
    /// @return priceScaleAfter The committed price scale, or the
    ///         unchanged pre-call `cs.priceScaleWad` on every skip.
    function _tryDonationParachute(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs,
        uint256 emaWad,
        uint256 emaBeforeWad,
        uint256 stepCapWad,
        uint256 deviationWad,
        uint256 vpFloorWad
    ) internal returns (uint256 priceScaleAfter) {
        priceScaleAfter = cs.priceScaleWad;

        // Activation qualifier: anchor must lag by K × the active
        // direction's dead-band (all three slots are warm — the
        // dead-band gate read the band slots, the share opt-out read
        // the config slot holding `_parachuteBandMult`). K is the
        // timelock-adjustable per-pool multiplier; `band ≤ WAD` and
        // `K ≤ 255`, so the checked mul cannot overflow.
        {
            uint256 activeBandWad = emaWad > priceScaleAfter
                ? _repegThresholdToken1UpWad
                : _repegThresholdToken1DownWad;
            if (deviationWad < activeBandWad * uint256(_parachuteBandMult)) return priceScaleAfter;
        }

        uint256 donationShares = balanceOf(address(this));
        if (donationShares <= Constants.REPEG_DONATION_DUST_SHARES) return priceScaleAfter;

        // Full damped step; reuse `stepCapWad` for the applied step and
        // then the candidate — its raw-cap value has no further reader.
        stepCapWad = PoolOracle.appliedRepegStep(stepCapWad, deviationWad);
        stepCapWad = PoolOracle.applyLogStep(priceScaleAfter, emaWad, stepCapWad);
        if (stepCapWad == priceScaleAfter) return priceScaleAfter;

        cs.priceScaleWad = stepCapWad;
        uint256 supply = totalSupply();
        // Reuse `deviationWad` as the vpAfter probe slot (last read was
        // the applied-step computation above).
        deviationWad = _computeLpUnitValueWad(reserve0, reserve1, cs, supply);

        // Post-burn supply via the exact integer identity
        //   δ = ⌈S·(T − vp)/T⌉ = S − ⌊S·vp/T⌋      (T = vpFloorWad)
        // — one fullMulDiv replaces the sub + mulDivUp, and
        // `supplyAfter` doubles as the latch denominator below (δ and
        // the latch stay bit-identical to the subtractive form).
        // `fullMulDiv` (512-bit) over `mulDiv`: measured same bytecode
        // (the routine is already inlined for the vp probes) but no
        // 256-bit cliff on `S·vp` — an overflow revert here would abort
        // the whole swap on the rescue path. A degenerate `vp == 0`
        // probe needs no dedicated exit: `supplyAfter == 0 ⇒ burnShares
        // == supply`, declined by the buffer check below because
        // `donationShares < supply` always holds (the genesis dead
        // shares at 0xdEaD stay in the active float forever).
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

        _priceScaleWad = stepCapWad;
        // Exact post-burn latch (degenerates to `deviationWad` itself
        // when δ = 0): `supplyAfter ≤ S·vp/T ⇒ ⌊vp·S/supplyAfter⌋ ≥ T`
        // — the floored latch cannot land below the gate floor.
        _lpUnitValueWad = FixedPointMathLib.fullMulDiv(deviationWad, supply, supplyAfter);
        _lastRepegTs = uint64(block.timestamp);
        emit PriceScaleUpdated(priceScaleAfter, stepCapWad, emaBeforeWad, emaWad);
        return stepCapWad;
    }

    // ============ Swap orchestration ============

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

            (
                SwapMathResult memory result,
                uint256 feeAmount,
                uint256 cleanRaw
            ) = _executeExactInWithDynamicFee(zeroForOne, amounts.amountInRaw, ms, cs);

            amounts.feeAmount = feeAmount;
            amounts.amountInCleanRaw = cleanRaw;
            (amounts.protocolCut, amounts.lpFeeCut) = _splitFee(amounts.feeAmount);

            amounts.amountOutRaw = _fromWadDownByScale(result.amountOutWad, outScale);
            if (amounts.amountOutRaw == 0) revert Errors.AmountTooSmallAfterNormalization();
        } else {
            amounts.amountOutRaw = amountAbs;
            if (amounts.amountOutRaw == 0) revert Errors.ZeroAmount();

            SwapMathResult memory result;
            (
                result,
                amounts.feeAmount,
                amounts.amountInCleanRaw,
                amounts.amountInRaw
            ) = _executeExactOutWithDynamicFee(zeroForOne, amounts.amountOutRaw, ms, cs);
            (amounts.protocolCut, amounts.lpFeeCut) = _splitFee(amounts.feeAmount);
        }
    }

    /// @dev Single-pass exact-in resolver with smoothstep dynamic fee.
    ///      The rate is resolved and applied at WAD precision
    ///      (`1 bps == 1e14`): a one-ulp rate step moves the fee by at
    ///      most `amountInRaw / 1e18` wei, which keeps the
    ///      gross → clean-input map monotone up to a dust residual on
    ///      that order (the CP distance and `r` are WAD-quantized too,
    ///      so a single input wei can cross several rate ulps at once).
    function _executeExactInWithDynamicFee(
        bool zeroForOne,
        uint256 amountInRaw,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal view returns (SwapMathResult memory result, uint256 feeAmount, uint256 cleanRaw) {
        uint256 feeWad;
        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 and `amountInRaw ≤ uint128.max`
            // times a rate < WAD stays far below 2²⁵⁶ — both muls are
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
        cleanRaw = amountInRaw - feeAmount;
        uint256 inScale = zeroForOne ? cs.token0Scale : cs.token1Scale;
        uint256 cleanWad = _toWadByScale(cleanRaw, inScale);
        if (cleanWad == 0) revert Errors.AmountTooSmallAfterNormalization();

        result = _computeExactInSwapMath(zeroForOne, cleanWad, ms, cs);
    }

    /// @dev Exact-out resolver. Shares the CP-proxy rate surface with
    ///      the exact-in resolver, but charges the endpoint-max fee over
    ///      the realisable gross interval — ≥ the fee exact-in would
    ///      resolve at the settled gross (LP-favourable conservatism,
    ///      see the endpoint-max rationale below) — plus a +1 wei
    ///      pool-favourable safety bump on the gross input.
    function _executeExactOutWithDynamicFee(
        bool zeroForOne,
        uint256 amountOutRaw,
        MathState memory ms,
        CurveSnapshot memory cs
    )
        internal
        view
        returns (
            SwapMathResult memory result,
            uint256 feeAmount,
            uint256 cleanInRaw,
            uint256 amountInRaw
        )
    {
        uint256 outScale = zeroForOne ? cs.token1Scale : cs.token0Scale;
        uint256 inScale = zeroForOne ? cs.token0Scale : cs.token1Scale;
        {
            uint256 amountOutWad = _toWadByScale(amountOutRaw, outScale);
            if (amountOutWad == 0) revert Errors.AmountTooSmallAfterNormalization();

            result = _computeExactOutSwapMath(zeroForOne, amountOutWad, ms, cs);
        }
        cleanInRaw = _fromWadUpByScale(result.amountInCleanWad, inScale);
        // Guard the closed-form gross-up against a zero clean input
        // (reachable for ~1-wei exact-out on strongly skewed pools where
        // the secant's best iterate lands at `xPost == xMath` exactly):
        // `_grossUpExactOut` computes `cleanInRaw - 1`, which would
        // otherwise underflow into an opaque Panic(0x11). The Rust
        // reference already errors on this input (audit I-4).
        if (cleanInRaw == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 baseFeeWad;
        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
            baseFeeWad = uint256(_baseFee) * 1e14;
        }
        // Flat-fee short-circuit: with the ramp disabled the CP resolver
        // returns `baseFee` for ANY gross, so `feeLo == feeHi == baseFee`
        // and the endpoint-max below is a tautology — the final gross-up
        // would recompute `grossHi` verbatim. One SLOAD + one gross-up
        // replaces two resolver dispatches + three mulDivs (~400 gas per
        // flat-fee exactOutput/quoteExactOut; audit O-5). Bit-identical
        // outputs; mirrored in the Rust quoter.
        if (_feeRampDistWad == 0) {
            amountInRaw = _grossUpExactOut(cleanInRaw, baseFeeWad) + 1;
            feeAmount = amountInRaw - cleanInRaw;
            return (result, feeAmount, cleanInRaw, amountInRaw);
        }
        // Dynamic fee for exact-out via a non-iterative, identity-safe
        // resolution. The CP-proxy post-distance is quasi-convex
        // (V-shaped) in the gross input — its single minimum sits at the
        // constant-product anchor `xPost = √(xy)` — so a fixed-point
        // iteration on it can oscillate forever for anchor-crossing
        // trades (never converging within any fixed pass count).
        //
        // Instead, observe that the gross input the swap ultimately
        // settles on always lies in
        //   [grossUp(clean, feeFloor), grossUp(clean, baseFee)]
        // because the resolved rate ∈ [feeFloor, baseFee], and that
        // a quasi-convex function attains its maximum over an interval at
        // one of the endpoints. Charging
        //   feeWad = max(feeCp(grossLo), feeCp(grossHi))
        // is therefore ≥ the fee `exactInput` independently resolves at
        // the settled gross, which guarantees the user-facing identity
        //   exactInputSingle(quoteExactOut(out)) ≥ out
        // with two CP evaluations and no iteration. `quoteExactOut` runs
        // the same path, so quote == swap by construction. On the
        // descending branch of the V the resolved rate falls as the
        // requested output grows, so `amountIn` can tick DOWN per extra
        // output wei — the same dust residual on the order of
        // `gross / 1e18` as exact-in, in the taker-favourable
        // direction.
        uint256 grossLo;
        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
            grossLo = _grossUpExactOut(cleanInRaw, uint256(_feeFloorBps) * 1e14);
        }
        uint256 grossHi = _grossUpExactOut(cleanInRaw, baseFeeWad);
        uint256 feeLo = _resolveDynamicFeeWadFromCp(zeroForOne, grossLo, ms, cs, baseFeeWad);
        uint256 feeHi = _resolveDynamicFeeWadFromCp(zeroForOne, grossHi, ms, cs, baseFeeWad);
        uint256 feeWad = feeLo > feeHi ? feeLo : feeHi;
        // +1 wei safety bump: covers the secant's K-residual so the
        // settled `cleanIn` is never understated (see audit finding I-1).
        amountInRaw = _grossUpExactOut(cleanInRaw, feeWad) + 1;
        feeAmount = amountInRaw - cleanInRaw;
    }

    /// @dev Smallest gross `amountIn` whose post-fee `cleanIn`
    ///      (= `amountIn − floor(amountIn · feeWad / WAD)`) satisfies
    ///      `cleanIn ≥ cleanInRaw`. Closed form: `floor((cleanInRaw − 1)
    ///      · WAD / (WAD − feeWad)) + 1`.
    function _grossUpExactOut(
        uint256 cleanInRaw,
        uint256 feeWad
    ) internal pure returns (uint256 amountInRaw) {
        uint256 denom = Constants.WAD - feeWad;
        amountInRaw = FixedPointMathLib.mulDiv(cleanInRaw - 1, Constants.WAD, denom) + 1;
    }

    /// @dev CP-proxy dynamic-fee resolver for exact-in. Predicts the
    ///      post-swap state distance via
    ///      `EquilibraSwapMath.predictPostDistanceCp`, then feeds the
    ///      smoothstep ramp. Rates are WAD fractions (`1 bps == 1e14`).
    ///      Disabled pools (`_feeRampDistWad == 0`) short-circuit to
    ///      `baseFeeWad`.
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

        // Lift the input delta into math-space. With asymmetric coords
        // (`xMath = xWad`, `yMath = yWad · WAD / priceScale`):
        //   * zeroForOne — token0 (quote) goes onto y-axis →
        //     `amountInMath = divWad(amountInWad, priceScale)`
        //   * !zeroForOne — token1 (base) goes onto x-axis identity-lift.
        // Floor rounding is pool-favourable for the predictor.
        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(amountInWad, cs.priceScaleWad)
            : amountInWad;
        if (amountInMath == 0) return baseFeeWad;

        // For zeroForOne the deposit hits yMath; for !zeroForOne it
        // hits xMath. The math-space CP predictor only cares about
        // which side gets the deposit, so swap argument order
        // accordingly.
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
    // Math-space orientation (asymmetric, one-sided quote normalisation):
    //   xMath = r1 · t1Scale                               (base side, identity)
    //   yMath = r0 · t0Scale · WAD / priceScale            (quote → base)
    //
    // zeroForOne (token0 in, token1 out):
    //   deposit on yMath, withdraw from xMath.
    //   Pass (yMath, xMath, ·) to library — kernel treats first arg
    //   as input axis.
    //   amountInMath  = divWad(amountInWad,  priceScale)   (quote → y)
    //   amountOutWad = outDeltaMath                         (x → base, identity)
    // !zeroForOne (token1 in, token0 out):
    //   deposit on xMath, withdraw from yMath.
    //   Pass (xMath, yMath, ·) to library.
    //   amountInMath  = amountInWad                         (base → x, identity)
    //   amountOutWad = mulWad(outDeltaMath, priceScale)     (y → quote)

    function _computeExactInSwapMath(
        bool zeroForOne,
        uint256 amountInCleanWad,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal pure returns (SwapMathResult memory result) {
        if (amountInCleanWad == 0) revert Errors.ZeroAmount();

        // Lift the input delta into math-space (floor for input,
        // pool-favourable).
        //   zeroForOne   quote-WAD → yMath = divWad(amountInWad, priceScale)
        //   !zeroForOne  base-WAD  → xMath = amountInWad (identity)
        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(amountInCleanWad, cs.priceScaleWad)
            : amountInCleanWad;
        if (amountInMath == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 outDeltaMath;
        if (zeroForOne) {
            // Deposit on yMath; output is xMath delta. `lPreWad` is
            // direction-independent (kernel symmetric in (x, y)).
            (outDeltaMath, ) = EquilibraSwapMath.quoteExactInForward(
                ms.yMath,
                ms.xMath,
                amountInMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreWad
            );
            if (outDeltaMath >= ms.xMath) revert Errors.InsufficientLiquidity();
            result.finalYMath = ms.yMath + amountInMath;
            result.finalXMath = ms.xMath - outDeltaMath;
            // xMath output → token1 base wad: identity (x = base WAD).
            result.amountOutWad = outDeltaMath;
        } else {
            // Deposit on xMath; output is yMath delta.
            (outDeltaMath, ) = EquilibraSwapMath.quoteExactInForward(
                ms.xMath,
                ms.yMath,
                amountInMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreWad
            );
            if (outDeltaMath >= ms.yMath) revert Errors.InsufficientLiquidity();
            result.finalXMath = ms.xMath + amountInMath;
            result.finalYMath = ms.yMath - outDeltaMath;
            // yMath output → token0 quote wad: outQuoteWad =
            // mulWad(outDeltaMath, priceScale) (floor, pool-favourable).
            result.amountOutWad = FixedPointMathLib.mulWad(outDeltaMath, cs.priceScaleWad);
        }
    }

    function _computeExactOutSwapMath(
        bool zeroForOne,
        uint256 amountOutWad,
        MathState memory ms,
        CurveSnapshot memory cs
    ) internal pure returns (SwapMathResult memory result) {
        if (amountOutWad == 0) revert Errors.ZeroAmount();

        // Lift the output delta into math-space.
        //   zeroForOne (output = x-side base):
        //     amountOutMath = amountOutWad (identity, x = base WAD).
        //   !zeroForOne (output = y-side quote):
        //     amountOutMath = mulDivUp(amountOutWad, WAD, priceScale)
        //     (ceil — slightly larger math-output ⇒ input rounds up too,
        //      pool-favourable for exact-out).
        uint256 amountOutMath = zeroForOne
            ? amountOutWad
            : FixedPointMathLib.mulDivUp(amountOutWad, Constants.WAD, cs.priceScaleWad);
        if (amountOutMath == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 inDeltaMath;
        if (zeroForOne) {
            // Output is xMath; input goes to yMath. `lPreWad` is
            // direction-independent (kernel symmetric in (x, y)).
            if (amountOutMath >= ms.xMath) revert Errors.InsufficientLiquidity();
            (inDeltaMath, ) = EquilibraSwapMath.quoteExactOutForward(
                ms.yMath,
                ms.xMath,
                amountOutMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreWad
            );
            result.finalYMath = ms.yMath + inDeltaMath;
            result.finalXMath = ms.xMath - amountOutMath;
            // Input lands on yMath; lift to token0 quote wad (ceil):
            //   amountInCleanWad = mulDivUp(inDeltaMath, priceScale, WAD)
            result.amountInCleanWad = FixedPointMathLib.mulDivUp(
                inDeltaMath,
                cs.priceScaleWad,
                Constants.WAD
            );
        } else {
            // Output is yMath; input goes to xMath.
            if (amountOutMath >= ms.yMath) revert Errors.InsufficientLiquidity();
            (inDeltaMath, ) = EquilibraSwapMath.quoteExactOutForward(
                ms.xMath,
                ms.yMath,
                amountOutMath,
                cs.aWad,
                cs.lambdaWad,
                ms.lPreWad
            );
            result.finalXMath = ms.xMath + inDeltaMath;
            result.finalYMath = ms.yMath - amountOutMath;
            // Input lands on xMath; identity lift to token1 base wad
            // (x = base WAD, no rounding needed).
            result.amountInCleanWad = inDeltaMath;
        }
        result.amountOutWad = amountOutWad;
    }

    // ============ Utility ============

    function _getReservesInternal() internal view returns (uint256 reserve0, uint256 reserve1) {
        return _unpackPair128(_reservesPacked);
    }

    function _setReservesInternal(uint256 reserve0, uint256 reserve1) internal {
        _reservesPacked = _packPair128(reserve0, reserve1);
    }

    function _factoryAddress() internal view override returns (address) {
        return _factory;
    }

    function _getProtocolFeesInternal() internal view returns (uint256 fee0, uint256 fee1) {
        return _unpackPair128(_protocolFeesPacked);
    }

    function _accrueProtocolFees(uint256 add0, uint256 add1) internal {
        if (add0 == 0 && add1 == 0) return;
        (uint256 fee0, uint256 fee1) = _unpackPair128(_protocolFeesPacked);
        _protocolFeesPacked = _packPair128(fee0 + add0, fee1 + add1);
    }

    /// @dev Re-anchor `_lpUnitValueWad` to the live LP unit value of the
    ///      supplied reserves. Used on proportional mint/burn so the
    ///      per-share metric stays consistent with the new total supply
    ///      without polluting the cumulative growth accumulator.
    function _reanchorLpUnitValue(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs
    ) internal {
        uint256 vpNow = _computeLpUnitValueWad(reserve0, reserve1, cs, totalSupply());
        if (vpNow == 0) return;
        _lpUnitValueWad = vpNow;
    }

    /// @dev Promote any growth in the LP unit value into
    ///      `_lpValueGrowthWad`. Returns `vpNow` so the caller can pass
    ///      it straight to `_tryAutoRepeg` as `vpBefore`.
    function _accrueLpValueGrowth(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs
    ) internal returns (uint256 vpNow) {
        vpNow = _computeLpUnitValueWad(reserve0, reserve1, cs, totalSupply());
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

    /// @dev LP unit value `2·L_eq · √(priceScale · WAD) / totalSupply`
    ///      evaluated against the supplied reserves and curve snapshot.
    ///
    ///      Recovers `L_eq` from current state via the closed-form
    ///      quadratic (`solveLFromState`). Returns 0 on degenerate
    ///      states so callers can treat that as "metric undefined".
    function _computeLpUnitValueWad(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs,
        uint256 totalSupplyWad
    ) internal pure returns (uint256 unitValueWad) {
        (uint256 xMath, uint256 yMath) = _toMathState(reserve0, reserve1, cs);
        if (xMath == 0 || yMath == 0) return 0;
        uint256 lEqWad = EquilibraSwapMath.solveLFromState(xMath, yMath, cs.aWad, cs.lambdaWad);
        if (lEqWad == 0) return 0;
        unitValueWad = EquilibraSwapMath.computeLpUnitValueWad(
            lEqWad,
            cs.priceScaleWad,
            totalSupplyWad
        );
    }

    function _loadCurveParams() internal view returns (CurveSnapshot memory cs) {
        cs.aWad = uint256(_aWad);
        cs.lambdaWad = uint256(_lambdaWad);
        cs.priceScaleWad = _priceScaleWad;
        cs.token0Scale = uint256(_token0Scale);
        cs.token1Scale = uint256(_token1Scale);
    }

    /// @dev Lift raw reserves into math-space via the asymmetric coord
    ///      transformation (`xMath = xWad`, `yMath = yWad · WAD /
    ///      priceScale`). At the anchor `yWad / xWad = priceScale`, so
    ///      `yMath = xWad = xMath` — diagonal.
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

    /// @dev Lift the raw pre-state into math-space AND solve its depth
    ///      `L` — the once-per-swap snapshot every downstream stage
    ///      reuses (audit O-3).
    function _liftMathState(
        uint256 reserve0,
        uint256 reserve1,
        CurveSnapshot memory cs
    ) internal pure returns (MathState memory ms) {
        (ms.xMath, ms.yMath) = _toMathState(reserve0, reserve1, cs);
        ms.lPreWad = EquilibraSwapMath.solveLFromState(ms.xMath, ms.yMath, cs.aWad, cs.lambdaWad);
    }

    function _toWadByScale(
        uint256 amountRaw,
        uint256 scale
    ) internal pure returns (uint256 amountWad) {
        if (scale == 1) return amountRaw;
        amountWad = amountRaw * scale;
    }

    function _fromWadDownByScale(
        uint256 amountWad,
        uint256 scale
    ) internal pure returns (uint256 amountRaw) {
        if (scale == 1) return amountWad;
        amountRaw = amountWad / scale;
    }

    function _fromWadUpByScale(
        uint256 amountWad,
        uint256 scale
    ) internal pure returns (uint256 amountRaw) {
        if (scale == 1) return amountWad;
        amountRaw = FixedPointMathLib.mulDivUp(amountWad, 1, scale);
    }

    function _splitFee(
        uint256 feeAmount
    ) private view returns (uint256 protocolCut, uint256 lpFeeCut) {
        protocolCut = (feeAmount * _protocolFeePercent) / 100;
        lpFeeCut = feeAmount - protocolCut;
    }

    function _assertSolvency(address t0, address t1) internal view {
        uint256 balance0 = SafeTransferLib.balanceOf(t0, address(this));
        uint256 balance1 = SafeTransferLib.balanceOf(t1, address(this));
        (uint256 reserve0, uint256 reserve1) = _getReservesInternal();
        (uint256 protocol0, uint256 protocol1) = _getProtocolFeesInternal();
        uint256 required0 = reserve0 + protocol0;
        uint256 required1 = reserve1 + protocol1;
        if (balance0 < required0 || balance1 < required1) revert Errors.MathInvariantViolation();
    }

    function _toSignedPositive(uint256 value) internal pure returns (int256 signedValue) {
        if (value > uint256(type(int256).max)) revert Errors.InvalidAmountSpecified();
        signedValue = int256(value);
    }

    function _bisectAmountInForTarget(
        QuoteBisectCtx memory ctx
    ) private view returns (uint256 amountIn, uint256 amountOut) {
        uint256 lo = 0;
        uint256 hi;
        SwapMathResult memory bestResult;
        uint256 bestAmountIn = 0;
        {
            // Scoped: keeps the frame within the 16-slot legacy-codegen
            // stack limit (coverage builds compile without viaIR).
            uint256 hiCap = ctx.inputReserve - ctx.inputReserve / 100;
            if (hiCap == 0) return (0, 0);

            hi = ctx.inputReserve / 1024;
            if (hi == 0) hi = 1;
            if (hi > hiCap) hi = hiCap;

            bool bracketed = false;

            for (uint256 i; i < 40; ) {
                SwapMathResult memory r = _evalSwapAtAmountIn(ctx, hi);
                uint256 pMargAfter = _kernelPMargAfter(r, ctx.cs);

                bool crossed = ctx.zeroForOne
                    ? pMargAfter >= ctx.pTargetMath
                    : pMargAfter <= ctx.pTargetMath;
                if (crossed) {
                    bracketed = true;
                    break;
                }

                bestResult = r;
                bestAmountIn = hi;

                if (hi >= hiCap) break;
                lo = hi;
                unchecked {
                    hi = hi * 2;
                    if (hi > hiCap) hi = hiCap;
                    ++i;
                }
            }

            if (!bracketed) {
                amountIn = bestAmountIn;
                amountOut = _fromWadDownByScale(bestResult.amountOutWad, ctx.outScale);
                return (amountIn, amountOut);
            }
        }

        uint256 tolerance = ctx.pTargetMath / 1e8;
        {
            // Fee-quantization noise floor (audit L-8): rate steps make
            // the net curve input drop by the protocol slice of the fee
            // jump as `amountIn` grows, stepping the post-price BACKWARD.
            // The bound `~pTarget · protocolFeePercent / 1e6` is sized
            // for the coarsest one-bps rate step — conservative under
            // the WAD-precision rate, where real jumps are far smaller.
            // Searching below that amplitude chases noise and can flip
            // the crossed/not-crossed classification near the target.
            // No-op when `protocolFeePercent == 0`. (Scoped: 16-slot
            // legacy-codegen stack limit.)
            uint256 qNoise = (ctx.pTargetMath * ctx.protocolFeePercent) / 1e6;
            if (tolerance < qNoise) tolerance = qNoise;
        }
        if (tolerance == 0) tolerance = 1;

        for (uint256 j; j < 50; ) {
            if (hi - lo <= 1) break;
            uint256 mid;
            unchecked {
                mid = (lo + hi) / 2;
            }
            SwapMathResult memory r = _evalSwapAtAmountIn(ctx, mid);
            uint256 pMargAfter = _kernelPMargAfter(r, ctx.cs);

            bool crossed = ctx.zeroForOne
                ? pMargAfter >= ctx.pTargetMath
                : pMargAfter <= ctx.pTargetMath;
            if (crossed) {
                hi = mid;
            } else {
                lo = mid;
                bestResult = r;
                bestAmountIn = mid;
                // Tolerance exit ONLY from the not-crossed side (audit
                // L-7): the just-recorded `mid` is itself the returned
                // answer, so the caller always receives an amount whose
                // evaluated post-price did NOT cross the target — the
                // one-sided guarantee. A crossed-in-tolerance mid keeps
                // narrowing instead of discarding the answer it just
                // computed (the old code broke out of the loop there,
                // returning a stale far undershoot or even (0,0) for a
                // perfectly reachable target).
                uint256 diff = pMargAfter > ctx.pTargetMath
                    ? pMargAfter - ctx.pTargetMath
                    : ctx.pTargetMath - pMargAfter;
                if (diff <= tolerance) break;
            }

            unchecked {
                ++j;
            }
        }

        amountIn = bestAmountIn;
        amountOut = _fromWadDownByScale(bestResult.amountOutWad, ctx.outScale);
    }

    function _evalSwapAtAmountIn(
        QuoteBisectCtx memory ctx,
        uint256 amountInRaw
    ) private view returns (SwapMathResult memory result) {
        uint256 feeAmount;
        // The pre-state snapshot (`ctx.ms`) is constant across ALL
        // bracket/bisection probes — one lift + one L-solve serves the
        // whole search (audit O-3).
        (result, feeAmount, ) = _executeExactInWithDynamicFee(
            ctx.zeroForOne,
            amountInRaw,
            ctx.ms,
            ctx.cs
        );

        if (feeAmount == 0) return result;

        uint256 lpFeeCut = feeAmount;
        if (ctx.protocolFeePercent != 0) {
            unchecked {
                uint256 protocolCut = (feeAmount * ctx.protocolFeePercent) / 100;
                lpFeeCut = feeAmount - protocolCut;
            }
        }
        if (lpFeeCut == 0) return result;

        uint256 lpFeeWad = _toWadByScale(lpFeeCut, ctx.inScale);
        // Fold the LP-fee residue into the kernel post-state in
        // math-space (mirrors `_toMathState` lift of the input side):
        //   zfo  — input is quote-WAD → yMath = divWad(lpFee, priceScale)
        //   !zfo — input is base-WAD  → xMath = lpFee (identity)
        if (ctx.zeroForOne) {
            result.finalYMath += FixedPointMathLib.divWad(lpFeeWad, ctx.cs.priceScaleWad);
        } else {
            result.finalXMath += lpFeeWad;
        }
    }

    function _packPair128(uint256 low, uint256 high) private pure returns (uint256 packed) {
        if (low > _LOWER_128_MASK || high > _LOWER_128_MASK) revert Errors.MathInvariantViolation();
        packed = low | (high << 128);
    }

    function _unpackPair128(uint256 packed) private pure returns (uint256 low, uint256 high) {
        low = packed & _LOWER_128_MASK;
        high = packed >> 128;
    }

    function _kernelPMargAfter(
        SwapMathResult memory r,
        CurveSnapshot memory cs
    ) private pure returns (uint256 pMargMath) {
        pMargMath = EquilibraSwapMath.marginalPriceFromState(
            r.finalXMath,
            r.finalYMath,
            cs.aWad,
            cs.lambdaWad
        );
    }
}
