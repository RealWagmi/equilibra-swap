// SPDX-License-Identifier: GPL-2.0-or-later
// Portions of this contract are adapted from Uniswap V3 Periphery and
// swap-router-contracts, Copyright (c) 2021 Uniswap Labs, licensed
// GPL-2.0-or-later: the SelfPermit pair, the PeripheryPayments-style
// helpers (`unwrapWETH9` / `sweepToken` / `refundETH` and the `_pay`
// branch structure), the payable Multicall composition and the
// CONTRACT_BALANCE / recipient-staging conventions.
//   https://github.com/Uniswap/v3-periphery
//   https://github.com/Uniswap/swap-router-contracts
pragma solidity ^0.8.20;

import { Multicallable } from "solady/src/utils/Multicallable.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";
import { SafeCastLib } from "solady/src/utils/SafeCastLib.sol";
import { IEquilibraPool } from "../interfaces/IEquilibraPool.sol";
import { IEquilibraRouter } from "../interfaces/IEquilibraRouter.sol";
import { IEquilibraSwapCallback } from "../interfaces/IEquilibraSwapCallback.sol";
import { IEquilibraMintCallback } from "../interfaces/IEquilibraMintCallback.sol";
import { IMulticall } from "../interfaces/IMulticall.sol";
import { IWETH9 } from "../interfaces/IWETH9.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Errors } from "../libraries/Errors.sol";
import { Constants } from "../libraries/Constants.sol";
import { EquilibraSwapMath } from "../libraries/EquilibraSwapMath.sol";
import { PoolAddressCompute } from "../libraries/PoolAddressCompute.sol";
import { SwapPath } from "../libraries/SwapPath.sol";

/// @dev Minimal EIP-2612 surface used by {EquilibraRouter.selfPermit}.
///      Every Equilibra LP token implements it (Solady ERC20 + permit).
interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title EquilibraRouter
/// @notice User-facing swap, liquidity and payment router for callback-based
///         Equilibra pools.
/// @dev Routes user-facing entrypoints through internal `*Internal`
///      helpers, unifies WETH wrapping via `_pay`, supports batching
///      via {multicall} and output capture via {sweepToken}/{unwrapWETH9}.
///      Two callback encodings are supported: a compact 128-byte
///      single-hop path (cheaper gas) and a dynamic {SwapPath}-encoded
///      multi-hop path.
///
///      All ERC20/ETH movements go through Solady's {SafeTransferLib}.
///
///      Batching is inherited from Solady's {Multicallable}. The default
///      implementation rejects `msg.value != 0` to prevent double-spending,
///      so we override {multicall} to re-enable payable batches (required
///      for native-ETH swaps chained with `refundETH`).
contract EquilibraRouter is
    IEquilibraRouter,
    IEquilibraSwapCallback,
    IEquilibraMintCallback,
    Multicallable
{
    using SwapPath for bytes;
    using FixedPointMathLib for uint256;

    // =====================================================================
    // Events (zap)
    // =====================================================================

    event ZapIn(
        address indexed pool,
        address indexed user,
        address tokenIn,
        uint256 amountIn,
        uint256 liquidity,
        uint256 dust0,
        uint256 dust1
    );

    event ZapOut(
        address indexed pool,
        address indexed user,
        address tokenOut,
        uint256 liquidity,
        uint256 amountOut
    );

    // =====================================================================
    // Immutables
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    address public immutable override factory;
    address public immutable poolImplementation;
    /// @inheritdoc IEquilibraRouter
    address public immutable override WETH9;
    bytes32 private immutable _initCodeHash;

    /// @dev Size in bytes of the **compact** single-hop callback
    ///      payload `abi.encode(tokenIn, tokenOut, poolIndex, payer)`.
    ///      Four static fields, each padded to 32 bytes → `4 · 32 = 128`.
    ///      The multi-hop encoding (`abi.encode(SwapCallbackData)`) is
    ///      ≥ 160 bytes for any valid path (head: 64; tail: ≥ 32 length
    ///      + ≥ 64 padded path), so dispatching on `_data.length == 128`
    ///      cleanly discriminates the two cases.
    uint256 private constant _SINGLE_HOP_PAYLOAD_BYTES = 128;

    /// @dev Exact-input amount sentinel: consume the router's ENTIRE
    ///      live balance of the leg's input token — regardless of
    ///      provenance — and pay the leg from it
    ///      (`payer = address(this)`). Stage and consume atomically
    ///      within one transaction: any pre-existing balance (a stray
    ///      transfer, output staged by an earlier transaction) is
    ///      included AND equally sweepable by anyone via the
    ///      permissionless payment helpers, so pre-funding the router
    ///      ahead of time is unsafe. A WETH9 leg reads the existing
    ///      WETH balance only — attached native value is NOT wrapped
    ///      by the sentinel and stays claimable via `refundETH`.
    ///      Cannot collide with a real amount: every other value
    ///      >= 2^255 still reverts in the checked int256 cast, and
    ///      pool-side amounts are capped at uint128. The zap twin of
    ///      this convention is `zapInSingleSided.amountIn == 0`.
    uint256 private constant _CONTRACT_BALANCE = type(uint256).max;

    // =====================================================================
    // Transient storage (EIP-1153)
    // =====================================================================

    /// @dev Slot used by exact-output multi-hop to relay the final-leg
    ///      input cost from the swap callback up to the {exactOutput}
    ///      entrypoint. Lives in EIP-1153 transient storage so it is
    ///      automatically cleared at the end of every transaction —
    ///      no constructor sentinel and no manual cleanup are required.
    ///      Slot derived from `bytes9(keccak256("EQUILIBRA_AMOUNT_IN_CACHED_TSLOT"))`
    ///      with the high bit set (Solady-style) to keep it well outside
    ///      the linear storage layout.
    uint256 private constant _AMOUNT_IN_CACHED_TSLOT = 0x80000000000a4b6c1f;

    // =====================================================================
    // Callback payloads
    // =====================================================================

    struct SwapCallbackData {
        bytes path;
        address payer;
    }

    struct MintCallbackData {
        address token0;
        address token1;
        uint32 pairPoolIndex;
        address payer;
    }

    /// @dev Reverts with `Errors.DeadlineExpired(overshoot)` when
    ///      `block.timestamp > deadline`. `deadline` is UNIX-seconds;
    ///      equality (`block.timestamp == deadline`) still passes —
    ///      a swap that lands in the exact deadline-second succeeds.
    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Errors.DeadlineExpired(block.timestamp - deadline);
        _;
    }

    constructor(address _factory, address _poolImplementation, address _WETH9) {
        if (_factory == address(0) || _poolImplementation == address(0) || _WETH9 == address(0))
            revert Errors.ZeroAddress();
        factory = _factory;
        poolImplementation = _poolImplementation;
        WETH9 = _WETH9;
        _initCodeHash = PoolAddressCompute.initCodeHash(_poolImplementation);
    }

    /// @dev Accept ETH only from the canonical WETH9. Any other ETH would
    ///      get stuck here (unless caller uses {refundETH} in a multicall),
    ///      so we fail fast on unexpected deposits.
    receive() external payable {
        if (msg.sender != WETH9) revert Errors.NotWETH9();
    }

    // =====================================================================
    // Multicall
    // =====================================================================

    /// @inheritdoc IMulticall
    /// @dev Overrides Solady's {Multicallable.multicall} to drop the
    ///      default `msg.value != 0` guard. The router intentionally
    ///      accepts ETH into a multicall so that an `exactInput*`
    ///      call with `tokenIn == WETH9` can wrap native value inside
    ///      the callback and subsequently be refunded via
    ///      {refundETH}.
    ///
    ///      Security note: each sub-call in the batch is executed
    ///      via `delegatecall` and observes the *full* `msg.value`
    ///      as its own `callvalue`. The payment helpers (`_pay`,
    ///      `_pullOrWrap`,
    ///      `unwrapWETH9`, `refundETH`, `sweepToken`) compare against
    ///      `address(this).balance` rather than `msg.value`, so the
    ///      attached ETH cannot be spent twice within one
    ///      transaction.
    function multicall(
        bytes[] calldata data
    ) public payable override(Multicallable, IMulticall) returns (bytes[] memory) {
        _multicallDirectReturn(_multicall(data));
    }

    // =====================================================================
    // Periphery payments
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable override {
        uint256 balance = SafeTransferLib.balanceOf(WETH9, address(this));
        if (balance < amountMinimum) revert Errors.InsufficientWETH9();
        if (balance > 0) {
            IWETH9(WETH9).withdraw(balance);
            SafeTransferLib.safeTransferETH(recipient, balance);
        }
    }

    /// @inheritdoc IEquilibraRouter
    function sweepToken(
        address token,
        uint256 amountMinimum,
        address recipient
    ) external payable override {
        uint256 balance = SafeTransferLib.balanceOf(token, address(this));
        if (balance < amountMinimum) revert Errors.InsufficientToken();
        if (balance > 0) {
            SafeTransferLib.safeTransfer(token, recipient, balance);
        }
    }

    /// @inheritdoc IEquilibraRouter
    function refundETH() external payable override {
        if (address(this).balance > 0) {
            SafeTransferLib.safeTransferETH(msg.sender, address(this).balance);
        }
    }

    // =====================================================================
    // Callbacks
    // =====================================================================

    /// @inheritdoc IEquilibraMintCallback
    /// @dev Two payer modes, both settled through {_pay}:
    ///        - `payer == address(this)`: the router holds the tokens
    ///          (zap flows stage funds on the router via an upfront
    ///          {_pullOrWrap} and a swap-output capture), so push via
    ///          `safeTransfer`.
    ///        - any other address: the caller of the router entry-point.
    ///          A WETH9 leg with enough attached native value is wrapped
    ///          in place (the payable `addLiquidity` ETH path — {_pay}
    ///          branch 2); anything else is pulled via
    ///          `safeTransferFrom`.
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        MintCallbackData memory cbData = abi.decode(data, (MintCallbackData));
        _verifyCallback(cbData.token0, cbData.token1, cbData.pairPoolIndex);

        if (amount0Owed > 0) {
            _pay(cbData.token0, cbData.payer, msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            _pay(cbData.token1, cbData.payer, msg.sender, amount1Owed);
        }
    }

    /// @inheritdoc IEquilibraSwapCallback
    function equilibraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        if (amount0Delta <= 0 && amount1Delta <= 0) revert Errors.MathInvariantViolation();

        // Fast path for single-hop swaps (compact encoding).
        if (_data.length == _SINGLE_HOP_PAYLOAD_BYTES) {
            (address tokenA, address tokenB, uint32 poolIdx, address payer) = abi.decode(
                _data,
                (address, address, uint32, address)
            );
            _verifyCallback(tokenA, tokenB, poolIdx);

            bool aIsToken0 = tokenA < tokenB;
            if (amount0Delta > 0) {
                _pay(aIsToken0 ? tokenA : tokenB, payer, msg.sender, uint256(amount0Delta));
            }
            if (amount1Delta > 0) {
                _pay(aIsToken0 ? tokenB : tokenA, payer, msg.sender, uint256(amount1Delta));
            }
            return;
        }

        // Slow path (multi-hop): dynamic {SwapPath}-encoded payload.
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenIn, address tokenOut, uint32 poolIndex) = data.path.decodeFirstPool();
        _verifyCallback(tokenIn, tokenOut, poolIndex);

        (bool isExactInput, uint256 amountToPay) = amount0Delta > 0
            ? (tokenIn < tokenOut, uint256(amount0Delta))
            : (tokenOut < tokenIn, uint256(amount1Delta));

        if (isExactInput) {
            _pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else if (data.path.hasMultiplePools()) {
            // Chain the next hop: pay the current pool from the output of
            // the subsequent hop (reverse-direction multi-hop).
            data.path = data.path.skipToken();
            _exactOutputInternal(amountToPay, msg.sender, data);
        } else {
            // Final hop of a multi-hop exact-output: relay the actual input
            // amount up to {exactOutput} via transient storage instead of a
            // persistent slot. EIP-1153 auto-clears the slot at tx end, so
            // no sentinel reset is required.
            /// @solidity memory-safe-assembly
            assembly {
                tstore(_AMOUNT_IN_CACHED_TSLOT, amountToPay)
            }
            _pay(tokenOut, data.payer, msg.sender, amountToPay);
        }
    }

    // =====================================================================
    // Swap: single-hop
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountOut) {
        // No zero-amount short-circuit here: the pool's `swap()` already
        // rejects `amountSpecified == 0`, surfacing the dedicated
        // `InvalidAmountSpecified` error from there.
        amountOut = _exactInputSingleInternal(
            params.tokenIn,
            params.tokenOut,
            params.poolIndex,
            params.amountIn,
            params.recipient,
            msg.sender
        );
        if (amountOut < params.amountOutMinimum) revert Errors.SlippageExceeded();
    }

    /// @inheritdoc IEquilibraRouter
    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountIn) {
        // Zero-amount guard lives in the pool — see {exactInputSingle}.
        amountIn = _exactOutputSingleInternal(
            params.tokenIn,
            params.tokenOut,
            params.poolIndex,
            params.amountOut,
            params.recipient,
            msg.sender
        );
        if (amountIn > params.amountInMaximum) revert Errors.ExcessiveInputAmount();
    }

    // =====================================================================
    // Swap: multi-hop
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    function exactInput(
        ExactInputParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountOut) {
        bytes memory path = params.path;
        uint256 amountIn;
        address payer;

        if (params.amountIn == _CONTRACT_BALANCE) {
            (address tokenIn0, , ) = path.decodeFirstPool();
            amountIn = IERC20Metadata(tokenIn0).balanceOf(address(this));
            payer = address(this);
        } else {
            amountIn = params.amountIn;
            payer = msg.sender;
        }

        while (true) {
            bool hasMultiple = path.hasMultiplePools();

            amountIn = _exactInputInternal(
                amountIn,
                hasMultiple ? address(this) : params.recipient,
                SwapCallbackData({ path: path.getFirstPool(), payer: payer })
            );

            if (hasMultiple) {
                payer = address(this);
                path = path.skipToken();
            } else {
                amountOut = amountIn;
                break;
            }
        }

        if (amountOut < params.amountOutMinimum) revert Errors.SlippageExceeded();
    }

    /// @inheritdoc IEquilibraRouter
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountIn) {
        _exactOutputInternal(
            params.amountOut,
            params.recipient,
            SwapCallbackData({ path: params.path, payer: msg.sender })
        );

        // The swap callback for the final hop wrote `amountToPay` into the
        // transient slot. A zero load here would mean the callback never
        // ran (impossible without `_exactOutputInternal` reverting and
        // unwinding the whole tx), so any non-zero value already implies
        // the slippage check is meaningful.
        //
        // We clear the slot before returning so back-to-back
        // invocations within the same tx — e.g. through {multicall}
        // — must not see a stale value if a future edit ever drops
        // the post-load slippage check. EIP-1153 only auto-clears at
        // *tx* end.
        /// @solidity memory-safe-assembly
        assembly {
            amountIn := tload(_AMOUNT_IN_CACHED_TSLOT)
            tstore(_AMOUNT_IN_CACHED_TSLOT, 0)
        }
        if (amountIn > params.amountInMaximum) revert Errors.ExcessiveInputAmount();
    }

    // =====================================================================
    // Liquidity
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    function addLiquidity(
        AddLiquidityParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 sharesOut) {
        if (params.recipient == address(0)) revert Errors.ZeroAddress();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        // Sort tokens **and** desired amounts in lockstep so the pool
        // receives them in its canonical (`token0 < token1`) order. The
        // callback payload encodes the sorted tokens too —
        // `equilibraMintCallback` pulls `amount{0,1}Owed` of
        // `cbData.token{0,1}` and the indices must match.
        (address t0, address t1, uint256 a0, uint256 a1) = params.tokenA < params.tokenB
            ? (params.tokenA, params.tokenB, params.amountADesired, params.amountBDesired)
            : (params.tokenB, params.tokenA, params.amountBDesired, params.amountADesired);
        // Zero-address rejected after the sort: `address(0)` is the
        // smallest address, so a single check on `t0` covers both
        // inputs.
        if (t0 == address(0)) revert Errors.ZeroAddress();

        sharesOut = _addLiquidityInternal(
            t0,
            t1,
            params.poolIndex,
            a0,
            a1,
            params.minShares,
            params.recipient,
            msg.sender
        );
    }

    /// @inheritdoc IEquilibraRouter
    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public payable override {
        IERC20Permit(token).permit(msg.sender, address(this), value, deadline, v, r, s);
    }

    /// @inheritdoc IEquilibraRouter
    function selfPermitIfNecessary(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable override {
        if (IERC20Metadata(token).allowance(msg.sender, address(this)) < value)
            selfPermit(token, value, deadline, v, r, s);
    }

    /// @inheritdoc IEquilibraRouter
    /// @dev Pulls the LP shares onto the router first (the pool's
    ///      `removeLiquidity` burns from `msg.sender`), then burns and
    ///      routes both legs. `recipient == address(0)` stages the
    ///      outputs in the router for {unwrapWETH9} / {sweepToken}
    ///      chaining — same convention as the swap entrypoints.
    function removeLiquidity(
        RemoveLiquidityParams calldata params
    )
        external
        payable
        override
        checkDeadline(params.deadline)
        returns (uint256 amountA, uint256 amountB)
    {
        if (params.shares == 0) revert Errors.ZeroAmount();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        bool aIsToken0 = params.tokenA < params.tokenB;
        address pool;
        {
            // Scoped: keeps the frame within the 16-slot legacy-codegen
            // stack limit (coverage builds compile without viaIR).
            (address token0, address token1) = aIsToken0
                ? (params.tokenA, params.tokenB)
                : (params.tokenB, params.tokenA);
            if (token0 == address(0)) revert Errors.ZeroAddress();
            pool = PoolAddressCompute.computeAddress(
                factory,
                _initCodeHash,
                token0,
                token1,
                params.poolIndex
            );
        }
        SafeTransferLib.safeTransferFrom(pool, msg.sender, address(this), params.shares);
        (uint256 amount0, uint256 amount1) = IEquilibraPool(pool).removeLiquidity(
            params.shares,
            aIsToken0 ? params.amountAMin : params.amountBMin,
            aIsToken0 ? params.amountBMin : params.amountAMin,
            params.recipient == address(0) ? address(this) : params.recipient
        );
        (amountA, amountB) = aIsToken0 ? (amount0, amount1) : (amount1, amount0);
    }

    /// @inheritdoc IEquilibraRouter
    /// @dev Donation = parking LP shares on the pool's own address,
    ///      where they carry no claim on reserves and only the pool's
    ///      donation parachute may burn them. Irreversible. A plain LP
    ///      `transfer` to the pool address is equivalent and unguarded;
    ///      this entrypoint exists for donors that need the donation
    ///      atomic against the state they quoted:
    ///      - `maxSupply` pins the pool's `totalSupply()`: any mint
    ///        landing first raises it and reverts the call, so a
    ///        zero-capital sandwich cannot join to divert part of the
    ///        lift the donation gives the active float. A holder
    ///        already in the pool still receives its pro-rata slice —
    ///        the pin bounds who may JOIN, not who is already there.
    ///      - `deadline` bounds how long the signed intent stays live.
    ///      The caller must have approved this router for the pool's LP
    ///      token — chain {selfPermitIfNecessary} in the same
    ///      `multicall` to sign the approval atomically. The
    ///      `totalSupply()` staticcall doubles as an existence check —
    ///      it reverts on a not-yet-deployed pool address.
    function donate(
        address tokenA,
        address tokenB,
        uint32 poolIndex,
        uint256 shares,
        uint256 maxSupply,
        uint256 deadline
    ) external override checkDeadline(deadline) {
        if (shares == 0) revert Errors.ZeroAmount();
        if (tokenA == tokenB) revert Errors.IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            poolIndex
        );
        if (IERC20Metadata(pool).totalSupply() > maxSupply) revert Errors.SlippageExceeded();
        SafeTransferLib.safeTransferFrom(pool, msg.sender, pool, shares);
    }

    // =====================================================================
    // Zap: single-sided / imbalanced liquidity
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    /// @dev Flow:
    ///        1. Fund the input: pull `amountIn` from the caller via
    ///           {_pullOrWrap} (wrapping attached native ETH for a WETH9
    ///           leg), or — on the `amountIn == 0` CONTRACT_BALANCE
    ///           sentinel — consume the router's whole staged `tokenIn`
    ///           balance. All subsequent leg payments happen out of the
    ///           router's balance.
    ///        2. CP-zap heuristic computes `swapAmount` from current
    ///           reserves.
    ///        3. `_exactInputSingleInternal` runs the swap with the router
    ///           as both `recipient` and `payer` (swap callback pays from
    ///           self via branch 1 of {_pay}).
    ///        4. `_mintAtPool` mints LP straight to
    ///           `params.recipient`, with router as payer (mint callback
    ///           pays from self via branch 1 of {_pay}).
    ///        5. Any residual on either side (proportional cap) is swept
    ///           back to the caller.
    function zapInSingleSided(
        ZapInSingleSidedParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 liquidity) {
        if (params.recipient == address(0)) revert Errors.ZeroAddress();
        if (params.tokenIn == params.tokenOut) revert Errors.IdenticalTokens();

        // Sort pair into canonical order; remember which side is the
        // input side so we can place `amountIn / amountOut` correctly
        // later.
        bool inIsToken0 = params.tokenIn < params.tokenOut;
        (address token0, address token1) = inIsToken0
            ? (params.tokenIn, params.tokenOut)
            : (params.tokenOut, params.tokenIn);
        if (token0 == address(0)) revert Errors.ZeroAddress();

        // Fund the input onto the router first; both subsequent legs
        // (swap + mint) pay from this staging balance. `amountIn == 0`
        // is the CONTRACT_BALANCE sentinel: consume the whole `tokenIn`
        // balance already staged here by an earlier multicall step (an
        // `exactInput` with `recipient == address(0)`), skipping the
        // pull entirely.
        uint256 amountIn = params.amountIn;
        if (amountIn == 0) {
            amountIn = SafeTransferLib.balanceOf(params.tokenIn, address(this));
            if (amountIn == 0) revert Errors.ZeroAmount();
        } else {
            _pullOrWrap(params.tokenIn, amountIn);
        }

        // Reserves drive both the optimal-swap heuristic and the pool
        // address (the latter via CREATE2 — keep it inline so the
        // staticcall is reused).
        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            params.poolIndex
        );
        (uint256 amount0, uint256 amount1) = _zapSingleSidedSwap(
            pool,
            params.tokenIn,
            params.tokenOut,
            params.poolIndex,
            amountIn,
            inIsToken0
        );

        liquidity = _zapInFinalize(params, amountIn, pool, token0, token1, amount0, amount1);
    }

    /// @inheritdoc IEquilibraRouter
    function zapInImbalanced(
        ZapInImbalancedParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 liquidity) {
        if (params.amountA == 0 && params.amountB == 0) revert Errors.ZeroAmount();
        if (params.recipient == address(0)) revert Errors.ZeroAddress();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        // Sort pair + amounts into canonical order.
        (address token0, address token1, uint256 amount0, uint256 amount1) = params.tokenA <
            params.tokenB
            ? (params.tokenA, params.tokenB, params.amountA, params.amountB)
            : (params.tokenB, params.tokenA, params.amountB, params.amountA);
        if (token0 == address(0)) revert Errors.ZeroAddress();

        if (amount0 > 0) {
            _pullOrWrap(token0, amount0);
        }
        if (amount1 > 0) {
            _pullOrWrap(token1, amount1);
        }

        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            params.poolIndex
        );

        (amount0, amount1) = _zapImbalancedRebalance(
            pool,
            token0,
            token1,
            params.poolIndex,
            amount0,
            amount1
        );

        liquidity = _zapInImbalancedFinalize(params, pool, token0, token1, amount0, amount1);
    }

    /// @inheritdoc IEquilibraRouter
    function zapOutSingleSided(
        ZapOutSingleSidedParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountOut) {
        if (params.liquidity == 0) revert Errors.ZeroAmount();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        (address token0, address token1) = params.tokenA < params.tokenB
            ? (params.tokenA, params.tokenB)
            : (params.tokenB, params.tokenA);
        if (token0 == address(0)) revert Errors.ZeroAddress();

        // `tokenOut` must be one of the pair's two tokens. Validate
        // membership once, then derive `zeroForOne` from a single
        // comparison (`true` ⇒ swap token0 → token1).
        if (params.tokenOut != token0 && params.tokenOut != token1)
            revert Errors.UnsupportedToken();
        bool zeroForOne = params.tokenOut == token1;

        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            params.poolIndex
        );

        // Pull LP shares from caller, burn at pool to receive both
        // underlying tokens onto the router.
        SafeTransferLib.safeTransferFrom(pool, msg.sender, address(this), params.liquidity);
        (uint256 amount0, uint256 amount1) = IEquilibraPool(pool).removeLiquidity(
            params.liquidity,
            0,
            0,
            address(this)
        );

        amountOut = _zapOutSingleSidedFinalize(
            params,
            pool,
            token0,
            token1,
            zeroForOne,
            amount0,
            amount1
        );
    }

    // =====================================================================
    // Zap: previews (off-chain estimates)
    // =====================================================================

    /// @inheritdoc IEquilibraRouter
    function previewZapIn(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn
    ) external view override returns (uint256 liquidity, uint256 swapAmount) {
        if (tokenIn == tokenOut) revert Errors.IdenticalTokens();
        bool inIsToken0 = tokenIn < tokenOut;

        (address token0, address token1) = inIsToken0 ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            poolIndex
        );

        (uint256 r0, uint256 r1) = IEquilibraPool(pool).getReserves();
        swapAmount = _calculateOptimalSwap(inIsToken0, amountIn, r0, r1);
        if (swapAmount == 0) return (0, 0);

        uint256 amountOut = IEquilibraPool(pool).quoteExactIn(inIsToken0, swapAmount);
        // A zero swap quote means the executed zap's swap leg would
        // revert in the pool's zero-raw-output dust guard — mirror that
        // execution outcome instead of returning an unexecutable
        // (0, swapAmount) pair (same rule as previewZapOut's off-side
        // leg).
        if (amountOut == 0) revert Errors.AmountTooSmallAfterNormalization();

        // On commit the pool adds only `gross − protocolCut` of the swap
        // input to its reserve; the mint below prices against exactly
        // that state, so the projection must subtract the cut. The
        // context load (several staticcalls) is skipped entirely when
        // no protocol fee is configured — the cut is zero then.
        uint256 protocolCut;
        if (IEquilibraPool(pool).getFeeConfig().protocolFeePercent != 0) {
            protocolCut = _swapProtocolCut(
                _loadQuoteCtx(pool, token0, token1, r0, r1),
                inIsToken0,
                swapAmount
            );
        }

        liquidity = _previewZapInLiquidity(
            pool,
            inIsToken0,
            amountIn,
            swapAmount,
            swapAmount - protocolCut,
            amountOut,
            r0,
            r1
        );
    }

    /// @inheritdoc IEquilibraRouter
    function previewZapOut(
        address tokenA,
        address tokenB,
        uint32 poolIndex,
        uint256 liquidity,
        address tokenOut
    ) external view override returns (uint256 amountOut) {
        if (tokenA == tokenB) revert Errors.IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (tokenOut != token0 && tokenOut != token1) revert Errors.UnsupportedToken();

        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            poolIndex
        );
        IEquilibraPool poolI = IEquilibraPool(pool);

        if (liquidity == 0) return 0;
        (uint256 r0, uint256 r1) = poolI.getReserves();
        uint256 supply = IERC20Metadata(pool).totalSupply() - IERC20Metadata(pool).balanceOf(pool);
        if (supply == 0) return 0;

        uint256 amount0 = liquidity.fullMulDiv(r0, supply);
        uint256 amount1 = liquidity.fullMulDiv(r1, supply);
        // Mirror the burn's dust guard: a position whose BOTH payouts
        // floor to zero reverts in `removeLiquidity`.
        if (amount0 == 0 && amount1 == 0) revert Errors.AmountTooSmallAfterNormalization();

        bool zeroForOne = tokenOut == token1;
        uint256 amountToSwap = zeroForOne ? amount0 : amount1;
        uint256 keepSide = zeroForOne ? amount1 : amount0;
        if (amountToSwap == 0) return keepSide;

        // Execution burns FIRST and only then swaps the off-side amount
        // against the reduced reserves — mirror that state AND the swap
        // path's guards: a dust off-side swap whose raw output floors
        // to zero reverts in execution, so the preview reverts
        // identically instead of quoting an unexecutable amount. The
        // zero-reserve check is defensive only: the genesis burn keeps
        // the active float above any executable `liquidity`, so a
        // fully drained post-burn state is reachable here solely
        // through share amounts no holder can actually burn.
        (r0, r1) = (r0 - amount0, r1 - amount1);
        if (r0 == 0 || r1 == 0) revert Errors.InsufficientLiquidity();
        uint256 swapOut = _quoteExactInAt(
            _loadQuoteCtx(pool, token0, token1, r0, r1),
            zeroForOne,
            amountToSwap
        );
        if (swapOut == 0) revert Errors.AmountTooSmallAfterNormalization();
        amountOut = keepSide + swapOut;
    }

    /// @dev Swap-off-side + combine + slippage-check + transfer + emit
    ///      tail of {zapOutSingleSided}. Extracted as a private helper
    ///      to keep the entry-point's stack under the EVM 16-slot limit
    ///      on legacy (non-viaIR) builds.
    function _zapOutSingleSidedFinalize(
        ZapOutSingleSidedParams calldata params,
        address pool,
        address token0,
        address token1,
        bool zeroForOne,
        uint256 amount0,
        uint256 amount1
    ) private returns (uint256 amountOut) {
        uint256 amountToSwap = zeroForOne ? amount0 : amount1;
        uint256 keepSide = zeroForOne ? amount1 : amount0;

        uint256 swapOut;
        if (amountToSwap > 0) {
            swapOut = _zapOutExecuteSwap(
                pool,
                zeroForOne ? token0 : token1,
                params.tokenOut,
                params.poolIndex,
                zeroForOne,
                amountToSwap
            );
        }
        amountOut = keepSide + swapOut;
        if (amountOut < params.minAmountOut) revert Errors.InsufficientOutputAmount();

        // `recipient == address(0)` stages the output in the router for
        // {unwrapWETH9} / {sweepToken} chaining — same convention as
        // the swap entrypoints. The output already sits on the router,
        // so staging skips the transfer entirely instead of paying for
        // a self-transfer.
        if (params.recipient != address(0)) {
            SafeTransferLib.safeTransfer(params.tokenOut, params.recipient, amountOut);
        }

        emit ZapOut(pool, msg.sender, params.tokenOut, params.liquidity, amountOut);
    }

    /// @dev Project the post-swap pool state and the LP shares the
    ///      proportional-cap deposit would mint. Extracted from
    ///      {previewZapIn} so that the entry-point's stack stays under
    ///      the EVM 16-slot limit on non-viaIR builds. `swapAmountNet`
    ///      (= gross − protocolCut) is what the pool's reserve actually
    ///      gains from the swap; the gross amount still prices the
    ///      user's deposit split.
    function _previewZapInLiquidity(
        address pool,
        bool inIsToken0,
        uint256 amountIn,
        uint256 swapAmount,
        uint256 swapAmountNet,
        uint256 amountOut,
        uint256 r0,
        uint256 r1
    ) private view returns (uint256 liquidity) {
        // ACTIVE-float supply read hoisted to the frame's top: down by
        // `used0` the legacy (non-viaIR) codegen frame is at the
        // 16-slot stack limit and the two staticcalls of this
        // expression no longer fit — up here only the params live and
        // the coverage pipeline compiles. The value is invariant
        // across this view, so the hoist is semantics-preserving.
        uint256 supply = IERC20Metadata(pool).totalSupply() - IERC20Metadata(pool).balanceOf(pool);

        (uint256 newR0, uint256 newR1) = inIsToken0
            ? (r0 + swapAmountNet, r1 - amountOut)
            : (r0 - amountOut, r1 + swapAmountNet);
        if (newR0 == 0 || newR1 == 0) return 0;

        (uint256 dep0, uint256 dep1) = inIsToken0
            ? (amountIn - swapAmount, amountOut)
            : (amountOut, amountIn - swapAmount);

        // Mirror the pool's proportional cap (smaller side wins).
        uint256 used0 = dep0;
        uint256 used1 = dep0.fullMulDiv(newR1, newR0);
        if (used1 > dep1) {
            used0 = dep1.fullMulDiv(newR0, newR1);
        }
        liquidity = used0.fullMulDiv(supply, newR0);
    }

    /// @dev Pre-sorted internal `addLiquidity`. Reused by the external
    ///      entry point; the zap flows skip this wrapper and call
    ///      {_mintAtPool} directly because they already have the pool
    ///      address from their own CREATE2 derive (avoids a redundant
    ///      hash). The `(token0, token1)` pair **must** already be in
    ///      canonical sort order — the caller is responsible.
    function _addLiquidityInternal(
        address token0,
        address token1,
        uint32 poolIndex,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        address payer
    ) private returns (uint256 sharesOut) {
        address pool = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            token0,
            token1,
            poolIndex
        );
        sharesOut = _mintAtPool(
            pool,
            token0,
            token1,
            poolIndex,
            amount0,
            amount1,
            minShares,
            recipient,
            payer
        );
    }

    /// @dev Execute `pool.addLiquidity` against a **pre-resolved** pool
    ///      address. `(token0, token1)` must be in canonical sort order
    ///      since the callback payload encodes them as-is and the pool
    ///      pulls `amount{0,1}Owed` of `cbData.token{0,1}`.
    function _mintAtPool(
        address pool,
        address token0,
        address token1,
        uint32 poolIndex,
        uint256 amount0,
        uint256 amount1,
        uint256 minShares,
        address recipient,
        address payer
    ) private returns (uint256 sharesOut) {
        bytes memory callbackData = abi.encode(
            MintCallbackData({
                token0: token0,
                token1: token1,
                pairPoolIndex: poolIndex,
                payer: payer
            })
        );
        sharesOut = IEquilibraPool(pool).addLiquidity(
            amount0,
            amount1,
            minShares,
            recipient,
            callbackData
        );
    }

    // =====================================================================
    // Zap: at-reserves quote mirror
    // =====================================================================

    /// @dev Snapshot of everything `EquilibraPool.quoteExactIn` reads,
    ///      rebindable to hypothetical reserves. Token scales are
    ///      recomputed with the factory's `10**(18 - decimals)` formula,
    ///      so they equal the pool's stored scales; the fee bounds are
    ///      widened from the config bps exactly like the pool's hot path
    ///      (`uint16 · 1e14`). Assumes standard-behaving tokens whose
    ///      `decimals()` is constant after pool creation.
    struct PoolQuoteCtx {
        uint256 aWad;
        uint256 lambdaWad;
        uint256 priceScaleWad;
        uint256 token0Scale;
        uint256 token1Scale;
        uint256 baseFeeWad;
        uint256 floorWad;
        uint256 rampDistWad;
        uint256 protocolFeePercent;
        uint256 xMath;
        uint256 yMath;
        uint256 lPreWad;
    }

    function _loadQuoteCtx(
        address pool,
        address token0,
        address token1,
        uint256 reserve0,
        uint256 reserve1
    ) private view returns (PoolQuoteCtx memory ctx) {
        {
            IEquilibraPool.CurveParams memory cp = IEquilibraPool(pool).getCurveParams();
            ctx.aWad = cp.aWad;
            ctx.lambdaWad = cp.lambdaWad;
        }
        ctx.priceScaleWad = IEquilibraPool(pool).getOracleState().priceScaleWad;
        {
            IEquilibraPool.FeeConfig memory fc = IEquilibraPool(pool).getFeeConfig();
            unchecked {
                // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
                ctx.baseFeeWad = uint256(fc.baseFee) * 1e14;
                ctx.floorWad = uint256(fc.feeFloorBps) * 1e14;
                ctx.rampDistWad = uint256(fc.feeRampBps) * 1e14;
            }
            ctx.protocolFeePercent = fc.protocolFeePercent;
        }
        ctx.token0Scale = 10 ** (18 - IERC20Metadata(token0).decimals());
        ctx.token1Scale = 10 ** (18 - IERC20Metadata(token1).decimals());

        // Asymmetric lift, same order as the pool: `xMath = base wad`
        // (identity), `yMath = quote wad / priceScale`; both stay zero
        // when either wad side is zero.
        uint256 xWad = reserve1 * ctx.token1Scale;
        uint256 yWad = reserve0 * ctx.token0Scale;
        if (xWad != 0 && yWad != 0) {
            ctx.xMath = xWad;
            ctx.yMath = FixedPointMathLib.divWad(yWad, ctx.priceScaleWad);
        }
        ctx.lPreWad = EquilibraSwapMath.solveLFromState(
            ctx.xMath,
            ctx.yMath,
            ctx.aWad,
            ctx.lambdaWad
        );
    }

    /// @dev Mirror of the pool's CP-proxy dynamic-fee resolver,
    ///      evaluated at the context's state. Returns the WAD fee rate
    ///      for a gross exact-in amount.
    function _resolveFeeWadAt(
        PoolQuoteCtx memory ctx,
        bool zeroForOne,
        uint256 amountInRaw
    ) private pure returns (uint256 feeWad) {
        if (ctx.rampDistWad == 0) return ctx.baseFeeWad;
        if (ctx.xMath == 0 || ctx.yMath == 0) return ctx.baseFeeWad;

        uint256 amountInWad = amountInRaw * (zeroForOne ? ctx.token0Scale : ctx.token1Scale);
        if (amountInWad == 0) return ctx.baseFeeWad;
        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(amountInWad, ctx.priceScaleWad)
            : amountInWad;
        if (amountInMath == 0) return ctx.baseFeeWad;

        uint256 distPredictedWad = zeroForOne
            ? EquilibraSwapMath.predictPostDistanceCp(ctx.yMath, ctx.xMath, amountInMath)
            : EquilibraSwapMath.predictPostDistanceCp(ctx.xMath, ctx.yMath, amountInMath);
        feeWad = EquilibraSwapMath.smoothstepFeeWad(
            distPredictedWad,
            ctx.rampDistWad,
            ctx.floorWad,
            ctx.baseFeeWad
        );
    }

    /// @dev Protocol slice of the fee an exact-in swap of `grossIn`
    ///      would pay at the context's state — the part the pool does
    ///      NOT add back to its reserves on commit.
    function _swapProtocolCut(
        PoolQuoteCtx memory ctx,
        bool zeroForOne,
        uint256 grossIn
    ) private pure returns (uint256 cut) {
        if (ctx.protocolFeePercent == 0) return 0;
        uint256 feeWad = _resolveFeeWadAt(ctx, zeroForOne, grossIn);
        unchecked {
            // grossIn ≤ uint128.max and feeWad < WAD — overflow-free.
            uint256 feeAmount = (grossIn * feeWad) / Constants.WAD;
            cut = (feeAmount * ctx.protocolFeePercent) / 100;
        }
    }

    /// @dev Mirror of `EquilibraPool.quoteExactIn` evaluated at the
    ///      context's (possibly hypothetical) reserves: same library
    ///      kernel, same rounding order, same guard outcomes — reverts
    ///      where the pool's quote would revert.
    function _quoteExactInAt(
        PoolQuoteCtx memory ctx,
        bool zeroForOne,
        uint256 amountIn
    ) private pure returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > type(uint128).max) return 0;
        if (ctx.xMath == 0 || ctx.yMath == 0) return 0;

        uint256 feeWad = _resolveFeeWadAt(ctx, zeroForOne, amountIn);
        uint256 cleanWad;
        unchecked {
            // amountIn ≤ uint128.max and feeWad < WAD — overflow-free.
            cleanWad =
                (amountIn - (amountIn * feeWad) / Constants.WAD) *
                (zeroForOne ? ctx.token0Scale : ctx.token1Scale);
        }
        if (cleanWad == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(cleanWad, ctx.priceScaleWad)
            : cleanWad;
        if (amountInMath == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 outDeltaMath;
        if (zeroForOne) {
            (outDeltaMath, ) = EquilibraSwapMath.quoteExactInForward(
                ctx.yMath,
                ctx.xMath,
                amountInMath,
                ctx.aWad,
                ctx.lambdaWad,
                ctx.lPreWad
            );
            if (outDeltaMath >= ctx.xMath) revert Errors.InsufficientLiquidity();
            // xMath output → token1 base wad: identity.
            amountOut = outDeltaMath / ctx.token1Scale;
        } else {
            (outDeltaMath, ) = EquilibraSwapMath.quoteExactInForward(
                ctx.xMath,
                ctx.yMath,
                amountInMath,
                ctx.aWad,
                ctx.lambdaWad,
                ctx.lPreWad
            );
            if (outDeltaMath >= ctx.yMath) revert Errors.InsufficientLiquidity();
            // yMath output → token0 quote wad (floor).
            amountOut = FixedPointMathLib.mulWad(outDeltaMath, ctx.priceScaleWad) / ctx.token0Scale;
        }
    }

    // =====================================================================
    // Zap: math helpers
    // =====================================================================

    /// @dev Rebalance leg of {zapInImbalanced}: derives the direction
    ///      and magnitude of the in-pool swap that aligns the
    ///      `(amount0, amount1)` deposit pair with the current pool
    ///      ratio, executes the swap (router pays from self / receives
    ///      to self), and returns the updated deposit amounts.
    function _zapImbalancedRebalance(
        address pool,
        address token0,
        address token1,
        uint32 poolIndex,
        uint256 amount0,
        uint256 amount1
    ) private returns (uint256, uint256) {
        bool zeroForOne;
        uint256 swapAmount;
        {
            (uint256 r0, uint256 r1) = IEquilibraPool(pool).getReserves();
            (zeroForOne, swapAmount) = _calculateRebalanceSwap(amount0, amount1, r0, r1);
        }
        if (swapAmount == 0) return (amount0, amount1);

        uint256 swapOut = _zapRebalanceExecuteSwap(
            pool,
            token0,
            token1,
            poolIndex,
            zeroForOne,
            swapAmount
        );
        if (zeroForOne) {
            return (amount0 - swapAmount, amount1 + swapOut);
        }
        return (amount0 + swapOut, amount1 - swapAmount);
    }

    /// @dev Inner swap leg of {_zapOutSingleSidedFinalize}, factored
    ///      out so the parent's stack stays under the EVM 16-slot
    ///      limit on legacy (non-viaIR) builds.
    function _zapOutExecuteSwap(
        address pool,
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        bool zeroForOne,
        uint256 amountToSwap
    ) private returns (uint256 swapOut) {
        swapOut = _swapInputAtPool(
            pool,
            zeroForOne,
            amountToSwap,
            address(this),
            abi.encode(tokenIn, tokenOut, poolIndex, address(this))
        );
    }

    /// @dev Inner swap leg of {_zapImbalancedRebalance}, factored out
    ///      so the parent's stack stays under the EVM 16-slot limit on
    ///      legacy (non-viaIR) builds. Resolves the `(in, out)` token
    ///      pair from `zeroForOne` and forwards to {_swapInputAtPool}.
    function _zapRebalanceExecuteSwap(
        address pool,
        address token0,
        address token1,
        uint32 poolIndex,
        bool zeroForOne,
        uint256 swapAmount
    ) private returns (uint256 swapOut) {
        (address inTok, address outTok) = zeroForOne ? (token0, token1) : (token1, token0);
        swapOut = _swapInputAtPool(
            pool,
            zeroForOne,
            swapAmount,
            address(this),
            abi.encode(inTok, outTok, poolIndex, address(this))
        );
    }

    /// @dev Mint + slippage-check + dust-sweep tail of
    ///      {zapInImbalanced}. Same shape as {_zapInFinalize} but emits
    ///      `ZapIn` with `tokenIn = address(0)` because there is no
    ///      single user-facing input token.
    function _zapInImbalancedFinalize(
        ZapInImbalancedParams calldata params,
        address pool,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) private returns (uint256 liquidity) {
        // Pool requires both sides > 0 — fail upstream with a clearer
        // error than the pool-side `ZeroAmount`.
        if (amount0 == 0 || amount1 == 0) revert Errors.ZeroAmount();

        liquidity = _mintAtPool(
            pool,
            token0,
            token1,
            params.poolIndex,
            amount0,
            amount1,
            0,
            params.recipient,
            address(this)
        );
        if (liquidity < params.minLiquidity) revert Errors.SlippageExceeded();

        _emitZapInWithDust(
            pool,
            msg.sender,
            address(0), // imbalanced: no single tokenIn
            params.amountA + params.amountB,
            liquidity,
            token0,
            token1
        );
    }

    /// @dev Mint + slippage-check + dust-sweep tail of
    ///      {zapInSingleSided}. Extracted as a private helper to keep
    ///      the entry-point's stack under the EVM 16-slot limit on
    ///      legacy (non-viaIR) builds.
    function _zapInFinalize(
        ZapInSingleSidedParams calldata params,
        uint256 amountIn,
        address pool,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) private returns (uint256 liquidity) {
        liquidity = _mintAtPool(
            pool,
            token0,
            token1,
            params.poolIndex,
            amount0,
            amount1,
            0,
            params.recipient,
            address(this)
        );
        if (liquidity < params.minLiquidity) revert Errors.SlippageExceeded();

        // `amountIn` is the EFFECTIVE input (the resolved staged balance
        // on the CONTRACT_BALANCE sentinel path), never the raw
        // `params.amountIn` — a zero sentinel must not be logged as a
        // zero-sized zap.
        _emitZapInWithDust(pool, msg.sender, params.tokenIn, amountIn, liquidity, token0, token1);
    }

    /// @dev Internal swap leg of {zapInSingleSided}: derives the optimal
    ///      `swapAmount` from the current reserves, executes the swap
    ///      with the router as both `recipient` and `payer`, and
    ///      returns the canonical `(amount0, amount1)` deposit pair.
    ///      Extracted as a private helper so the entry-point's stack
    ///      stays under the EVM 16-slot limit on legacy (non-viaIR)
    ///      builds.
    function _zapSingleSidedSwap(
        address pool,
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn,
        bool inIsToken0
    ) private returns (uint256 amount0, uint256 amount1) {
        (uint256 r0, uint256 r1) = IEquilibraPool(pool).getReserves();
        uint256 swapAmount = _calculateOptimalSwap(inIsToken0, amountIn, r0, r1);
        if (swapAmount == 0) revert Errors.ZeroAmount();

        uint256 amountOut = _swapInputAtPool(
            pool,
            inIsToken0,
            swapAmount,
            address(this),
            abi.encode(tokenIn, tokenOut, poolIndex, address(this))
        );

        (amount0, amount1) = inIsToken0
            ? (amountIn - swapAmount, amountOut)
            : (amountOut, amountIn - swapAmount);
    }

    /// @dev Constant-product closed form for the swap leg of a single-
    ///      sided zap. The exact formula is
    ///      `x = √(rIn · (rIn + amountIn)) − rIn`. We compute it as
    ///      `√rIn · √(rIn + amountIn) − rIn` to dodge a potential
    ///      `rIn · (rIn + amountIn)` overflow on extreme user inputs
    ///      (reserves are uint128-bounded by the pool, but `amountIn`
    ///      is not capped). The factored form is `≤` the exact form
    ///      (per-sqrt floor rounding compounds); the 0.5 % safety
    ///      margin absorbs the bias and biases residual dust onto the
    ///      output side rather than under-funding the input side.
    function _calculateOptimalSwap(
        bool zeroForOne,
        uint256 amountIn,
        uint256 r0,
        uint256 r1
    ) private pure returns (uint256 swapAmount) {
        uint256 rIn = zeroForOne ? r0 : r1;
        if (rIn == 0) return 0;

        uint256 sqrtRIn = FixedPointMathLib.sqrt(rIn);
        uint256 sqrtSum = FixedPointMathLib.sqrt(rIn + amountIn);
        uint256 sqrtProduct = sqrtRIn * sqrtSum;
        swapAmount = sqrtProduct > rIn ? sqrtProduct - rIn : 0;

        swapAmount = (swapAmount * 995) / 1000;

        uint256 cap = amountIn / 2;
        if (swapAmount > cap) swapAmount = cap;
    }

    /// @dev Direction + magnitude of the rebalance swap for the
    ///      imbalanced zap. Returns `swapAmount == 0` when the deposit
    ///      already matches the pool ratio (within floor rounding) —
    ///      caller short-circuits the swap in that case.
    ///      Cross-product comparisons use {fullMulDiv} so they stay
    ///      correct on extreme inputs (`amount · reserve` may overflow
    ///      raw uint256).
    function _calculateRebalanceSwap(
        uint256 amount0,
        uint256 amount1,
        uint256 r0,
        uint256 r1
    ) private pure returns (bool zeroForOne, uint256 swapAmount) {
        if (amount0 == 0) {
            return (false, _calculateOptimalSwap(false, amount1, r0, r1));
        }
        if (amount1 == 0) {
            return (true, _calculateOptimalSwap(true, amount0, r0, r1));
        }

        // balanced1 = amount0 · r1 / r0 — the amount of token1 that
        // would pair perfectly with `amount0` at the pool ratio.
        uint256 balanced1 = amount0.fullMulDiv(r1, r0);
        if (amount1 > balanced1) {
            uint256 excess = amount1 - balanced1;
            return (false, _calculateOptimalSwap(false, excess, r0, r1));
        }
        if (amount1 < balanced1) {
            uint256 balanced0 = amount1.fullMulDiv(r0, r1);
            if (amount0 > balanced0) {
                uint256 excess = amount0 - balanced0;
                return (true, _calculateOptimalSwap(true, excess, r0, r1));
            }
        }
        // amount1 == balanced1 (within floor rounding): already balanced.
    }

    /// @dev Sweep both pool-side balances back to the caller and emit
    ///      `ZapIn`. Combines dust-refund and event emission into a
    ///      single helper so the two zap-in entry points stay short.
    function _emitZapInWithDust(
        address pool,
        address user,
        address tokenIn,
        uint256 amountIn,
        uint256 liquidity,
        address token0,
        address token1
    ) private {
        uint256 dust0 = SafeTransferLib.balanceOf(token0, address(this));
        uint256 dust1 = SafeTransferLib.balanceOf(token1, address(this));
        if (dust0 > 0) SafeTransferLib.safeTransfer(token0, user, dust0);
        if (dust1 > 0) SafeTransferLib.safeTransfer(token1, user, dust1);

        emit ZapIn(pool, user, tokenIn, amountIn, liquidity, dust0, dust1);
    }

    // =====================================================================
    // Internal: single-hop (fast-path callback)
    // =====================================================================

    function _exactInputSingleInternal(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn,
        address recipient,
        address payer
    ) private returns (uint256 amountOut) {
        // Opt-in: recipient=0 captures output on the router so the
        // caller can chain with sweepToken / unwrapWETH9 via multicall.
        if (recipient == address(0)) recipient = address(this);
        if (amountIn == _CONTRACT_BALANCE) {
            amountIn = IERC20Metadata(tokenIn).balanceOf(address(this));
            payer = address(this);
        }

        (address pool, bool zeroForOne) = _resolvePool(tokenIn, tokenOut, poolIndex);

        amountOut = _swapInputAtPool(
            pool,
            zeroForOne,
            amountIn,
            recipient,
            abi.encode(tokenIn, tokenOut, poolIndex, payer)
        );
    }

    /// @dev Execute an exact-input `pool.swap` against a **pre-resolved**
    ///      pool address and return the receiver-side delta. Used by
    ///      every exact-input path (single-hop entry, multi-hop entry,
    ///      and the zap flows) so the CREATE2 resolve never runs twice
    ///      on the same pair within one call.
    function _swapInputAtPool(
        address pool,
        bool zeroForOne,
        uint256 amountIn,
        address recipient,
        bytes memory callbackData
    ) private returns (uint256 amountOut) {
        (int256 amount0, int256 amount1) = IEquilibraPool(pool).swap(
            recipient,
            zeroForOne,
            SafeCastLib.toInt256(amountIn), // checked: no exact-in/out flip
            callbackData
        );
        amountOut = uint256(-(zeroForOne ? amount1 : amount0));
    }

    function _exactOutputSingleInternal(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountOut,
        address recipient,
        address payer
    ) private returns (uint256 amountIn) {
        if (recipient == address(0)) recipient = address(this);

        (address pool, bool zeroForOne) = _resolvePool(tokenIn, tokenOut, poolIndex);

        (int256 amount0Delta, int256 amount1Delta) = IEquilibraPool(pool).swap(
            recipient,
            zeroForOne,
            -SafeCastLib.toInt256(amountOut), // checked: no semantics flip
            abi.encode(tokenIn, tokenOut, poolIndex, payer)
        );

        amountIn = _assertExactOutDeltas(zeroForOne, amount0Delta, amount1Delta, amountOut);
    }

    // =====================================================================
    // Internal: multi-hop (path-encoded callback)
    // =====================================================================

    function _exactInputInternal(
        uint256 amountIn,
        address recipient,
        SwapCallbackData memory data
    ) private returns (uint256 amountOut) {
        if (recipient == address(0)) recipient = address(this);

        (address tokenIn, address tokenOut, uint32 poolIndex) = data.path.decodeFirstPool();
        (address pool, bool zeroForOne) = _resolvePool(tokenIn, tokenOut, poolIndex);

        amountOut = _swapInputAtPool(pool, zeroForOne, amountIn, recipient, abi.encode(data));
    }

    /// @dev Multi-hop exact-output leg. The return value is intentionally
    ///      void: the canonical input cost is relayed up to {exactOutput}
    ///      through `_AMOUNT_IN_CACHED_TSLOT` (written by the innermost
    ///      callback). The outer call's local `amountIn` would only
    ///      describe the **intermediate** token quote — the wrong
    ///      quantity to slippage-check against `amountInMaximum`.
    function _exactOutputInternal(
        uint256 amountOut,
        address recipient,
        SwapCallbackData memory data
    ) private {
        if (recipient == address(0)) recipient = address(this);

        // Exact-output paths are reversed: the first 20 bytes encode the
        // **output** token of this hop, the next 20 bytes the **input**
        // token. Decode and rename accordingly.
        (address tokenOut, address tokenIn, uint32 poolIndex) = data.path.decodeFirstPool();
        (address pool, bool zeroForOne) = _resolvePool(tokenIn, tokenOut, poolIndex);

        (int256 amount0Delta, int256 amount1Delta) = IEquilibraPool(pool).swap(
            recipient,
            zeroForOne,
            -SafeCastLib.toInt256(amountOut), // checked: no semantics flip
            abi.encode(data)
        );

        _assertExactOutDeltas(zeroForOne, amount0Delta, amount1Delta, amountOut);
    }

    // =====================================================================
    // Internal: callback verification + payment routing
    // =====================================================================

    function _verifyCallback(address tokenA, address tokenB, uint32 poolIndex) private view {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        address expected = PoolAddressCompute.computeAddress(
            factory,
            _initCodeHash,
            t0,
            t1,
            poolIndex
        );
        if (msg.sender != expected) revert Errors.InvalidCallbackSender();
    }

    /// @dev Sort `(tokenIn, tokenOut)` into the pool's canonical
    ///      `(token0, token1)` order and CREATE2-derive the pool
    ///      address. Returns the `zeroForOne` flag so callers can pass
    ///      it straight into {IEquilibraPool.swap}. Pure arithmetic —
    ///      no external call, no codesize check; passing a pair without
    ///      a deployed pool surfaces as a plain revert from the
    ///      subsequent `pool.swap()`.
    function _resolvePool(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex
    ) private view returns (address pool, bool zeroForOne) {
        zeroForOne = tokenIn < tokenOut;
        (address t0, address t1) = zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        pool = PoolAddressCompute.computeAddress(factory, _initCodeHash, t0, t1, poolIndex);
    }

    /// @dev Decode the signed `(amount0Delta, amount1Delta)` returned
    ///      by an exact-output `pool.swap`, enforce that the pool
    ///      delivered exactly `amountOut` of the output side, and
    ///      return the matching input cost. Used by both the single-
    ///      and multi-hop exact-output paths.
    function _assertExactOutDeltas(
        bool zeroForOne,
        int256 amount0Delta,
        int256 amount1Delta,
        uint256 amountOut
    ) private pure returns (uint256 amountIn) {
        uint256 amountOutReceived;
        (amountIn, amountOutReceived) = zeroForOne
            ? (uint256(amount0Delta), uint256(-amount1Delta))
            : (uint256(amount1Delta), uint256(-amount0Delta));
        if (amountOutReceived != amountOut) revert Errors.InsufficientOutputAmount();
    }

    /// @dev Fund a zap input onto the router: wrap attached native ETH
    ///      in place when the input leg is WETH9 and the router carries
    ///      enough value, otherwise `transferFrom` the caller.
    ///
    ///      Funding modes, all three permitted:
    ///        1. attached value ≥ `amount` for a WETH9 leg — wraps
    ///           EXACTLY `amount`; any over-attachment stays on the
    ///           router and MUST be reclaimed with {refundETH} in the
    ///           same batch;
    ///        2. attached value < `amount` for a WETH9 leg — falls
    ///           through to the ERC20 pull for the FULL amount, so the
    ///           partial native value stays on the router and needs the
    ///           same {refundETH} tail;
    ///        3. non-WETH9 leg — plain ERC20 pull; any attached value is
    ///           untouched (and again reclaimable only via {refundETH}).
    ///      Router-held value is permissionless: never end a transaction
    ///      with a native balance left behind.
    function _pullOrWrap(address token, uint256 amount) private {
        if (token == WETH9 && address(this).balance >= amount) {
            IWETH9(WETH9).deposit{ value: amount }();
        } else {
            SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        }
    }

    /// @dev Unified payer handling for both swap callbacks and mint
    ///      callback fan-outs. Branch order (payer-first is
    ///      SAFETY-CRITICAL — see the router-as-payer branch):
    ///        1. **Router as payer** (`payer == address(this)`) —
    ///           `transfer` from the router's own `token` balance,
    ///           UNCONDITIONALLY. Staged funds (a multi-hop intermediate
    ///           output, or a zap swap-output capture) are held as
    ///           `token` in the router; this branch must run before any
    ///           native-wrap so ambient `msg.value` is never spent to
    ///           re-fund a hop already funded in kind.
    ///        2. **WETH9 from attached ETH** — external payer only:
    ///           `token == WETH9` and the router holds enough native
    ///           value, so wrap exactly what this hop owes and pay.
    ///        3. **External payer** — `transferFrom` the declared
    ///           `payer` (the original user for swaps, the mint caller
    ///           for liquidity adds).
    function _pay(address token, address payer, address recipient, uint256 value) private {
        if (payer == address(this)) {
            // Router-staged funds (an intermediate exact-input hop output,
            // or a zap swap-output capture) are already held as `token` in
            // the router. Pay from that balance UNCONDITIONALLY — never wrap
            // ambient native value here. Consulting `address(this).balance`
            // first would, on a `... -> WETH -> ...` route carrying excess
            // `msg.value`, wrap the attached ETH for this hop and strand the
            // staged WETH alongside the leftover ETH, both then claimable via
            // the permissionless `sweepToken` / `refundETH` helpers.
            SafeTransferLib.safeTransfer(token, recipient, value);
        } else if (token == WETH9 && address(this).balance >= value) {
            // External payer supplied native ETH for a WETH input leg: wrap
            // only what this hop owes, then forward to the pool.
            IWETH9(WETH9).deposit{ value: value }();
            SafeTransferLib.safeTransfer(WETH9, recipient, value);
        } else {
            SafeTransferLib.safeTransferFrom(token, payer, recipient, value);
        }
    }
}
