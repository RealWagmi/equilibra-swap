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

/**
 * @title IERC20Permit
 * @notice Minimal EIP-2612 surface used by {EquilibraRouter.selfPermit}.
 * @dev Every Equilibra LP token implements it (Solady ERC20 with permit).
 */
interface IERC20Permit {
    /**
     * @notice Set `spender`'s allowance over `owner`'s tokens to `value` by signature.
     * @param owner Token holder that signed the approval.
     * @param spender Address being approved.
     * @param value Allowance to set, raw token units.
     * @param deadline Signature expiry, UNIX seconds.
     * @param v Signature recovery id.
     * @param r Signature `r` word.
     * @param s Signature `s` word.
     */
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

/**
 * @title EquilibraRouter
 * @notice User-facing swap, liquidity, donation, zap and payment router for callback-based
 * Equilibra pools.
 * @dev Public entrypoints delegate to `*Internal` helpers. Every token and ETH movement goes
 * through Solady's {SafeTransferLib}; {_pay} and {_pullOrWrap} unify WETH9 wrapping. Two
 * swap-callback encodings exist: a compact 128-byte single-hop payload and the dynamic {SwapPath}
 * multi-hop payload. {multicall} overrides Solady's {Multicallable} to accept `msg.value`, so
 * native-ETH legs batch with {refundETH}.
 */
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

    /**
     * @notice Emitted by both zap-in entrypoints after the mint and the residual refund.
     * @param pool Pool that minted the shares.
     * @param user Caller that funded the zap and received the residuals.
     * @param tokenIn Deposited token, or `address(0)` for the imbalanced zap.
     * @param amountIn Effective input: `params.amountIn`, the resolved staged balance on the
     * sentinel path, or the sum of both raw deposits for the imbalanced zap.
     * @param liquidity LP shares minted.
     * @param dust0 Token0 residual refunded to `user`, raw units.
     * @param dust1 Token1 residual refunded to `user`, raw units.
     */
    event ZapIn(
        address indexed pool,
        address indexed user,
        address tokenIn,
        uint256 amountIn,
        uint256 liquidity,
        uint256 dust0,
        uint256 dust1
    );

    /**
     * @notice Emitted by {zapOutSingleSided} after the burn, the off-side swap and the payout.
     * @param pool Pool whose shares were burned.
     * @param user Caller whose shares were burned.
     * @param tokenOut Token paid out.
     * @param liquidity LP shares burned.
     * @param amountOut Total paid in `tokenOut`, raw units.
     */
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

    /**
     * @inheritdoc IEquilibraRouter
     */
    address public immutable override factory;
    /**
     * @notice EIP-1167 implementation every pool of {factory} is cloned from.
     */
    address public immutable poolImplementation;
    /**
     * @inheritdoc IEquilibraRouter
     */
    address public immutable override WETH9;
    /**
     * @dev Clone init-code hash of `poolImplementation` for CREATE2 pool address derivation.
     */
    bytes32 private immutable _initCodeHash;

    /**
     * @dev Byte size of the compact single-hop callback payload
     * `abi.encode(tokenIn, tokenOut, poolIndex, payer)`: four static fields, each padded to 32
     * bytes. The multi-hop encoding `abi.encode(SwapCallbackData)` is at least 160 bytes for any
     * valid path (64-byte head, 32-byte length word, at least 64 bytes of padded path), so
     * `_data.length == 128` discriminates the two.
     */
    uint256 private constant _SINGLE_HOP_PAYLOAD_BYTES = 128;

    /**
     * @dev Exact-input amount sentinel: consume the router's entire live balance of the leg's
     * input token, whatever its provenance, and pay the leg from it (`payer = address(this)`).
     * Stage and consume within one transaction: any pre-existing balance is included and equally
     * sweepable by anyone through the permissionless payment helpers. A WETH9 leg reads the
     * existing WETH balance only; the sentinel wraps no attached native value (claimable via
     * {refundETH}). Every other value >= 2^255 reverts in the checked int256 cast and pool-side
     * amounts are capped at uint128, so the sentinel collides with no real amount. The zap twin
     * is `zapInSingleSided.amountIn == 0`.
     */
    uint256 private constant _CONTRACT_BALANCE = type(uint256).max;

    // =====================================================================
    // Transient storage (EIP-1153)
    // =====================================================================

    /**
     * @dev EIP-1153 transient slot through which the final-hop swap callback relays the
     * exact-output multi-hop input cost up to {exactOutput}, which clears it after reading.
     * Transient storage also clears at transaction end; no constructor sentinel is needed. Derived from
     * `bytes9(keccak256("EQUILIBRA_AMOUNT_IN_CACHED_TSLOT"))` with the high bit set, keeping it
     * outside the linear storage layout.
     */
    uint256 private constant _AMOUNT_IN_CACHED_TSLOT = 0x80000000000a4b6c1f;

    // =====================================================================
    // Callback payloads
    // =====================================================================

    /**
     * @notice Multi-hop swap-callback payload.
     */
    struct SwapCallbackData {
        /// Remaining {SwapPath}; its first pool is the one issuing the callback.
        bytes path;
        /// Address charged for the input leg; `address(this)` pays from router-staged funds.
        address payer;
    }

    /**
     * @notice Mint-callback payload.
     */
    struct MintCallbackData {
        /// Canonical `token0 < token1` of the pool.
        address token0;
        address token1;
        /// Pair-local index of the pool under the factory.
        uint32 pairPoolIndex;
        /// Address charged for both legs; `address(this)` pays from router-staged funds.
        address payer;
    }

    /**
     * @dev Reverts `DeadlineExpired(overshoot)` when `block.timestamp > deadline`; equality passes.
     * @param deadline UNIX seconds.
     */
    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Errors.DeadlineExpired(block.timestamp - deadline);
        _;
    }

    /**
     * @dev Binds the router to one factory, pool implementation and WETH9 (a zero address reverts
     * `ZeroAddress`) and caches the clone init-code hash used for CREATE2 pool resolution.
     * @param _factory Factory whose pools this router serves.
     * @param _poolImplementation EIP-1167 implementation the factory clones.
     * @param _WETH9 Canonical wrapped-native token.
     */
    constructor(address _factory, address _poolImplementation, address _WETH9) {
        if (_factory == address(0) || _poolImplementation == address(0) || _WETH9 == address(0))
            revert Errors.ZeroAddress();
        factory = _factory;
        poolImplementation = _poolImplementation;
        WETH9 = _WETH9;
        _initCodeHash = PoolAddressCompute.initCodeHash(_poolImplementation);
    }

    /**
     * @dev Accepts ETH only from WETH9 (unwrap proceeds); any other deposit reverts `NotWETH9` so
     * value cannot be stranded on the router by a plain transfer.
     */
    receive() external payable {
        if (msg.sender != WETH9) revert Errors.NotWETH9();
    }

    // =====================================================================
    // Multicall
    // =====================================================================

    /**
     * @inheritdoc IMulticall
     * @dev Overrides Solady's {Multicallable.multicall} to drop its `msg.value != 0` guard, so an
     * exact-input leg with `tokenIn == WETH9` can wrap attached value inside the callback and the
     * remainder can be reclaimed with {refundETH}. Every sub-call runs via `delegatecall` and
     * observes the full `msg.value` as its own `callvalue`; the payment helpers compare against
     * `address(this).balance`, never `msg.value`, so attached ETH cannot be spent twice.
     */
    function multicall(
        bytes[] calldata data
    ) public payable override(Multicallable, IMulticall) returns (bytes[] memory) {
        _multicallDirectReturn(_multicall(data));
    }

    // =====================================================================
    // Periphery payments
    // =====================================================================

    /**
     * @inheritdoc IEquilibraRouter
     */
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable override {
        uint256 balance = SafeTransferLib.balanceOf(WETH9, address(this));
        if (balance < amountMinimum) revert Errors.InsufficientWETH9();
        if (balance > 0) {
            IWETH9(WETH9).withdraw(balance);
            SafeTransferLib.safeTransferETH(recipient, balance);
        }
    }

    /**
     * @inheritdoc IEquilibraRouter
     */
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

    /**
     * @inheritdoc IEquilibraRouter
     */
    function refundETH() external payable override {
        if (address(this).balance > 0) {
            SafeTransferLib.safeTransferETH(msg.sender, address(this).balance);
        }
    }

    // =====================================================================
    // Callbacks
    // =====================================================================

    /**
     * @inheritdoc IEquilibraMintCallback
     * @dev Verifies that the caller is the CREATE2-derived pool of the payload's pair, then
     * settles each owed side through {_pay}: `payer == address(this)` pushes router-staged funds
     * (zap flows); any other payer is charged via `transferFrom`, or has a WETH9 leg wrapped from
     * attached native value (the payable {addLiquidity} path).
     */
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

    /**
     * @inheritdoc IEquilibraSwapCallback
     * @dev Dispatches on payload length: 128 bytes is the compact single-hop encoding, anything
     * else the {SwapPath} multi-hop one. Both verify `msg.sender` against the CREATE2-derived
     * pool before paying. An exact-input leg pays the input side from `payer`. An exact-output
     * leg with pools left recurses into {_exactOutputInternal} so the next hop's output pays this
     * pool; the final exact-output hop records its input cost in `_AMOUNT_IN_CACHED_TSLOT` and
     * pays it from `payer`. A callback owing nothing reverts `MathInvariantViolation`.
     */
    function equilibraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        if (amount0Delta <= 0 && amount1Delta <= 0) revert Errors.MathInvariantViolation();

        // Fast path: compact single-hop encoding.
        if (_data.length == _SINGLE_HOP_PAYLOAD_BYTES) {
            (address tokenA, address tokenB, uint32 poolIdx, address payer) = abi.decode(
                _data,
                (address, address, uint32, address)
            );
            bool aIsToken0 = _verifyCallback(tokenA, tokenB, poolIdx);
            if (amount0Delta > 0) {
                _pay(aIsToken0 ? tokenA : tokenB, payer, msg.sender, uint256(amount0Delta));
            }
            if (amount1Delta > 0) {
                _pay(aIsToken0 ? tokenB : tokenA, payer, msg.sender, uint256(amount1Delta));
            }
            return;
        }

        // Slow path: {SwapPath}-encoded multi-hop payload.
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenIn, address tokenOut, uint32 poolIndex) = data.path.decodeFirstPool();
        bool inIsToken0 = _verifyCallback(tokenIn, tokenOut, poolIndex);

        (bool isExactInput, uint256 amountToPay) = amount0Delta > 0
            ? (inIsToken0, uint256(amount0Delta))
            : (!inIsToken0, uint256(amount1Delta));

        if (isExactInput) {
            _pay(tokenIn, data.payer, msg.sender, amountToPay);
        } else if (data.path.hasMultiplePools()) {
            // Pay this pool with the output of the next hop (exact-output paths run in reverse).
            data.path = data.path.skipToken();
            _exactOutputInternal(amountToPay, msg.sender, data);
        } else {
            // Final exact-output hop: relay the input cost to {exactOutput} through the transient
            // slot; EIP-1153 clears it at transaction end.
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

    /**
     * @inheritdoc IEquilibraRouter
     */
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountOut) {
        // No zero-amount short-circuit: the pool rejects `amountSpecified == 0` with
        // `InvalidAmountSpecified`.
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

    /**
     * @inheritdoc IEquilibraRouter
     */
    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountIn) {
        // Zero-amount guard lives in the pool.
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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev The CONTRACT_BALANCE sentinel resolves the router's balance of the path's first token
     * and makes the router the payer. Intermediate hops deliver to the router and the next hop
     * pays from that balance; only the last hop pays `params.recipient`.
     */
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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev The input actually paid is the final-hop callback's `amountToPay`, relayed through
     * `_AMOUNT_IN_CACHED_TSLOT`; {_exactOutputInternal} itself only observes the cost of the first
     * executed hop, which on a multi-hop route is an intermediate token.
     */
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountIn) {
        _exactOutputInternal(
            params.amountOut,
            params.recipient,
            SwapCallbackData({ path: params.path, payer: msg.sender })
        );

        // The final-hop callback stored its input cost in the transient slot (a revert would have
        // unwound the whole call otherwise). Clear the slot so a later call in the same
        // transaction cannot read a stale value: EIP-1153 clears only at transaction end.
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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Sorts the caller's pair and desired amounts into canonical order; the mint callback
     * charges `msg.sender`, or wraps attached native value for a WETH9 leg.
     */
    function addLiquidity(
        AddLiquidityParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 sharesOut) {
        if (params.recipient == address(0)) revert Errors.ZeroAddress();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        (address pool, bool aIsToken0, address t0, address t1) = _resolvePool(
            params.tokenA,
            params.tokenB,
            params.poolIndex
        );
        if (t0 == address(0)) revert Errors.ZeroAddress();

        sharesOut = _mintAtPool(
            pool,
            t0,
            t1,
            params.poolIndex,
            aIsToken0 ? params.amountADesired : params.amountBDesired,
            aIsToken0 ? params.amountBDesired : params.amountADesired,
            params.minShares,
            params.recipient,
            msg.sender
        );
    }

    /**
     * @inheritdoc IEquilibraRouter
     */
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

    /**
     * @inheritdoc IEquilibraRouter
     */
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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Pulls the shares onto the router first because the pool burns from `msg.sender`; a
     * zero `recipient` maps to the router so both legs stay staged for {unwrapWETH9} /
     * {sweepToken}.
     */
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

        (address pool, bool aIsToken0, address token0, ) = _resolvePool(
            params.tokenA,
            params.tokenB,
            params.poolIndex
        );
        if (token0 == address(0)) revert Errors.ZeroAddress();
        SafeTransferLib.safeTransferFrom(pool, msg.sender, address(this), params.shares);
        (uint256 amount0, uint256 amount1) = IEquilibraPool(pool).removeLiquidity(
            params.shares,
            aIsToken0 ? params.amountAMin : params.amountBMin,
            aIsToken0 ? params.amountBMin : params.amountAMin,
            params.recipient == address(0) ? address(this) : params.recipient
        );
        (amountA, amountB) = aIsToken0 ? (amount0, amount1) : (amount1, amount0);
    }

    /**
     * @inheritdoc IEquilibraRouter
     * @dev The `totalSupply()` staticcall doubles as the existence check: an undeployed pool
     * address reverts there. The pin bounds who may join between quote and execution; a holder
     * already in the pool still receives its pro-rata slice of the lift.
     */
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
        (address pool, , , ) = _resolvePool(tokenA, tokenB, poolIndex);
        if (IERC20Metadata(pool).totalSupply() > maxSupply) revert Errors.SlippageExceeded();
        SafeTransferLib.safeTransferFrom(pool, msg.sender, pool, shares);
    }

    // =====================================================================
    // Zap: single-sided / imbalanced liquidity
    // =====================================================================

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Flow: fund `tokenIn` onto the router ({_pullOrWrap}, or the staged balance on the zero
     * sentinel); {_zapSingleSidedSwap} swaps the constant-product split with the router as payer
     * and recipient; {_zapInFinalize} mints to `params.recipient` with the router as payer and
     * sweeps both residuals to the caller. Both legs pay from the router's balance through the
     * router-as-payer branch of {_pay}.
     */
    function zapInSingleSided(
        ZapInSingleSidedParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 liquidity) {
        if (params.recipient == address(0)) revert Errors.ZeroAddress();
        if (params.tokenIn == params.tokenOut) revert Errors.IdenticalTokens();

        (address pool, bool inIsToken0, address token0, address token1) = _resolvePool(
            params.tokenIn,
            params.tokenOut,
            params.poolIndex
        );
        if (token0 == address(0)) revert Errors.ZeroAddress();

        // Fund the input onto the router; the swap and the mint both pay from this staging
        // balance. `amountIn == 0` consumes the `tokenIn` balance staged by an earlier batch step
        // instead of pulling.
        uint256 amountIn = params.amountIn;
        if (amountIn == 0) {
            amountIn = SafeTransferLib.balanceOf(params.tokenIn, address(this));
            if (amountIn == 0) revert Errors.ZeroAmount();
        } else {
            _pullOrWrap(params.tokenIn, amountIn);
        }

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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Pulls each non-zero side onto the router ({_pullOrWrap}), rebalances through
     * {_zapImbalancedRebalance} and mints through {_zapInImbalancedFinalize} with the router as
     * payer.
     */
    function zapInImbalanced(
        ZapInImbalancedParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 liquidity) {
        if (params.amountA == 0 && params.amountB == 0) revert Errors.ZeroAmount();
        if (params.recipient == address(0)) revert Errors.ZeroAddress();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        (address pool, bool aIsToken0, address token0, address token1) = _resolvePool(
            params.tokenA,
            params.tokenB,
            params.poolIndex
        );
        if (token0 == address(0)) revert Errors.ZeroAddress();
        (uint256 amount0, uint256 amount1) = aIsToken0
            ? (params.amountA, params.amountB)
            : (params.amountB, params.amountA);

        if (amount0 > 0) {
            _pullOrWrap(token0, amount0);
        }
        if (amount1 > 0) {
            _pullOrWrap(token1, amount1);
        }

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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Pulls the shares onto the router, burns them with both legs delivered to the router
     * (no pool-side minimums), then {_zapOutSingleSidedFinalize} swaps the off-side leg and pays
     * out.
     */
    function zapOutSingleSided(
        ZapOutSingleSidedParams calldata params
    ) external payable override checkDeadline(params.deadline) returns (uint256 amountOut) {
        if (params.liquidity == 0) revert Errors.ZeroAmount();
        if (params.tokenA == params.tokenB) revert Errors.IdenticalTokens();

        (address pool, , address token0, address token1) = _resolvePool(
            params.tokenA,
            params.tokenB,
            params.poolIndex
        );
        if (token0 == address(0)) revert Errors.ZeroAddress();

        // `tokenOut` must be a pair token; `zeroForOne` (swap token0 -> token1) holds when the
        // off-side token is token0.
        if (params.tokenOut != token0 && params.tokenOut != token1)
            revert Errors.UnsupportedToken();
        bool zeroForOne = params.tokenOut == token1;

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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev The swap leg is the pool's own `quoteExactIn`; {_previewSwapProtocolCut} projects the
     * protocol slice the pool withholds from its reserve and {_previewZapInLiquidity} mirrors the
     * proportional-cap mint at the projected post-swap reserves.
     */
    function previewZapIn(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn
    ) external view override returns (uint256 liquidity, uint256 swapAmount) {
        if (tokenIn == tokenOut) revert Errors.IdenticalTokens();
        (address pool, bool inIsToken0, address token0, address token1) = _resolvePool(
            tokenIn,
            tokenOut,
            poolIndex
        );

        (uint256 r0, uint256 r1) = IEquilibraPool(pool).getReserves();
        swapAmount = _calculateOptimalSwap(inIsToken0, amountIn, r0, r1);
        if (swapAmount == 0) return (0, 0);

        uint256 amountOut = IEquilibraPool(pool).quoteExactIn(inIsToken0, swapAmount);
        // The pool's quote already rejects native dust; the zero-output guard stays so a sentinel
        // return cannot advertise a zap whose swap leg cannot execute.
        if (amountOut == 0) revert Errors.AmountTooSmallAfterNormalization();

        uint256 protocolCut = _previewSwapProtocolCut(
            pool,
            token0,
            token1,
            r0,
            r1,
            inIsToken0,
            swapAmount
        );

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

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Mirrors execution order: the burn is projected first against the active float
     * (`totalSupply - balanceOf(pool)`), then the off-side leg is quoted with {_quoteExactInAt}
     * against the reduced reserves, including the pool's dust and LP-depth guards.
     */
    function previewZapOut(
        address tokenA,
        address tokenB,
        uint32 poolIndex,
        uint256 liquidity,
        address tokenOut
    ) external view override returns (uint256 amountOut) {
        if (tokenA == tokenB) revert Errors.IdenticalTokens();
        (address pool, , address token0, address token1) = _resolvePool(tokenA, tokenB, poolIndex);
        if (tokenOut != token0 && tokenOut != token1) revert Errors.UnsupportedToken();

        IEquilibraPool poolI = IEquilibraPool(pool);

        if (liquidity == 0) return 0;
        (uint256 r0, uint256 r1) = poolI.getReserves();
        uint256 supply = IERC20Metadata(pool).totalSupply() - IERC20Metadata(pool).balanceOf(pool);
        if (supply == 0) return 0;

        uint256 amount0 = liquidity.fullMulDiv(r0, supply);
        uint256 amount1 = liquidity.fullMulDiv(r1, supply);
        // Mirror the burn's dust guard: both payouts flooring to zero reverts in `removeLiquidity`.
        if (amount0 == 0 && amount1 == 0) revert Errors.AmountTooSmallAfterNormalization();

        bool zeroForOne = tokenOut == token1;
        uint256 amountToSwap = zeroForOne ? amount0 : amount1;
        uint256 keepSide = zeroForOne ? amount1 : amount0;
        if (amountToSwap == 0) return keepSide;

        // Execution burns first and swaps the off-side leg against the reduced reserves; mirror
        // that state and the swap path's guards so a dust swap reverts here as it would there.
        // The zero-reserve check is defensive: the genesis burn keeps the active float above any
        // burnable `liquidity`, so a fully drained post-burn state needs shares no holder owns.
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

    /**
     * @dev Off-side swap, combine, slippage check, transfer and event tail of
     * {zapOutSingleSided}; split out so the entrypoint fits the 16-slot stack on legacy
     * (non-viaIR) builds. Reverts `InsufficientOutputAmount` below `params.minAmountOut`.
     * @param params Caller's zap parameters.
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param zeroForOne Whether the off-side leg is token0 (swapped into `tokenOut == token1`).
     * @param amount0 Token0 received from the burn, raw units.
     * @param amount1 Token1 received from the burn, raw units.
     * @return amountOut Total paid in `params.tokenOut`, raw units.
     */
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

        // A zero `recipient` stages the output on the router; it already sits here, so no
        // self-transfer is paid for.
        if (params.recipient != address(0)) {
            SafeTransferLib.safeTransfer(params.tokenOut, params.recipient, amountOut);
        }

        emit ZapOut(pool, msg.sender, params.tokenOut, params.liquidity, amountOut);
    }

    /**
     * @dev Projects the post-swap reserves and the shares the proportional-cap deposit mints,
     * mirroring the pool: token1 is rounded up against the token0-priced shares, a leg that
     * floors to zero reverts `AmountTooSmallAfterNormalization`, and shares are priced on the
     * active float. Split out of {previewZapIn} for the legacy 16-slot stack.
     * @param pool Resolved pool address.
     * @param inIsToken0 Whether the deposited token is token0.
     * @param amountIn Raw deposit.
     * @param swapAmount Gross part of `amountIn` swapped; prices the deposit split.
     * @param swapAmountNet `swapAmount` minus the protocol cut: what the pool's reserve gains.
     * @param amountOut Quoted swap output, raw units of the other token.
     * @param r0 Pre-swap token0 reserve, raw units.
     * @param r1 Pre-swap token1 reserve, raw units.
     * @return liquidity Shares the mint would produce; zero when a projected reserve is empty.
     */
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
        // Read the active float first: lower in the frame the legacy codegen has no stack room
        // for these two staticcalls.
        uint256 supply = IERC20Metadata(pool).totalSupply() - IERC20Metadata(pool).balanceOf(pool);

        (uint256 newR0, uint256 newR1) = inIsToken0
            ? (r0 + swapAmountNet, r1 - amountOut)
            : (r0 - amountOut, r1 + swapAmountNet);
        if (newR0 == 0 || newR1 == 0) return 0;

        (uint256 dep0, uint256 dep1) = inIsToken0
            ? (amountIn - swapAmount, amountOut)
            : (amountOut, amountIn - swapAmount);

        // Mirror the pool's cap: token1 rounds up against the token0-priced shares.
        uint256 used0 = dep0;
        uint256 used1 = dep0.fullMulDivUp(newR1, newR0);
        if (used1 > dep1) {
            used1 = dep1;
            used0 = dep1.fullMulDiv(newR0, newR1);
        }
        if (used0 == 0 || used1 == 0) revert Errors.AmountTooSmallAfterNormalization();
        liquidity = used0.fullMulDiv(supply, newR0);
    }

    /**
     * @dev Calls `pool.addLiquidity` on a pre-resolved pool. `(token0, token1)` must be canonical:
     * the callback payload encodes them as-is and the pool pulls `amount{0,1}Owed` of
     * `cbData.token{0,1}` from `payer`.
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param amount0 Token0 offered, raw units.
     * @param amount1 Token1 offered, raw units.
     * @param minShares Pool-side minimum; fewer shares revert `SlippageExceeded`.
     * @param recipient LP share recipient.
     * @param payer Address the mint callback charges; `address(this)` pays from staged funds.
     * @return sharesOut LP shares minted.
     */
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
    // Off-chain price-target quotes
    // =====================================================================

    /**
     * @inheritdoc IEquilibraRouter
     * @dev Sentinel exits: zero target, empty reserve, zero price scale, target decoding to a zero
     * math-space price, target not strictly beyond the start price in the swap direction, or a
     * search that finds no candidate. `crossesAnchor` is set when the start and target math-space
     * prices lie on opposite sides of the anchor (`WAD`), neither being exactly on it.
     */
    function quoteSwapToPrice(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint160 sqrtPriceTargetX96
    ) external view override returns (uint256 amountIn, uint256 amountOut, bool crossesAnchor) {
        if (tokenIn == tokenOut) revert Errors.IdenticalTokens();
        if (sqrtPriceTargetX96 == 0) return (0, 0, false);

        (address pool, bool zeroForOne, address token0, address token1) = _resolvePool(
            tokenIn,
            tokenOut,
            poolIndex
        );
        (uint256 reserve0, uint256 reserve1) = IEquilibraPool(pool).getReserves();
        if (reserve0 == 0 || reserve1 == 0) return (0, 0, false);

        PoolQuoteCtx memory cs = _loadQuoteCtx(pool, token0, token1, reserve0, reserve1);
        if (cs.priceScaleWad == 0) return (0, 0, false);

        uint256 pTargetMath = EquilibraSwapMath.sqrtPriceX96ToMathPriceWad(
            sqrtPriceTargetX96,
            cs.priceScaleWad,
            cs.token0Scale,
            cs.token1Scale
        );
        if (pTargetMath == 0) return (0, 0, false);

        _liftQuoteCtx(cs);
        uint256 pStartMath = EquilibraSwapMath.marginalPriceFromState(
            cs.xMath,
            cs.yMath,
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
            pool: pool,
            zeroForOne: zeroForOne,
            pTargetMath: pTargetMath,
            state: cs,
            inputReserve: zeroForOne ? reserve0 : reserve1
        });

        (amountIn, amountOut) = _bisectAmountInForTarget(ctx);
        if (amountIn == 0 || amountOut == 0) return (0, 0, false);
    }

    /**
     * @notice Search context of {_bisectAmountInForTarget}.
     */
    struct QuoteBisectCtx {
        address pool;
        bool zeroForOne;
        /// Target marginal price in math space, WAD.
        uint256 pTargetMath;
        /// Lifted pre-swap snapshot (reserves, scales, fee config, curve knobs).
        PoolQuoteCtx state;
        /// Raw reserve of the input token; bounds the probed input.
        uint256 inputReserve;
    }

    /**
     * @notice Outcome class of one price-target probe: `Valid` (quote and post-price computed),
     * `TooSmall` (dust; search larger inputs), `Rejected` (solver, LP-guard, liquidity or range
     * refusal; search smaller inputs).
     */
    enum PriceProbeStatus {
        Valid,
        TooSmall,
        Rejected
    }

    /**
     * @dev Two-phase search over the gross input. Expansion starts at `inputReserve / 1024` (at
     * least 1) and doubles up to the cap `inputReserve - inputReserve / 100`; every valid
     * non-crossing probe becomes the current answer, and a rejected or crossing probe brackets
     * `[lo, hi]`. Without a bracket the best sweep is returned as is. Refinement bisects the
     * bracket for at most 50 probes: rejected or crossing probes lower `hi`, dust probes raise
     * `lo` without recording an answer, and a valid non-crossing probe records the answer and
     * ends the search once its post-price is within `tolerance` of the target. The tolerance is
     * `max(pTarget / 1e8, pTarget · protocolFeePercent / 1e6, 1)`; the protocol-fee term is the
     * fee-quantization noise floor, because a fee-rate step drops the net curve input by the
     * protocol slice of the fee jump and steps the post-price backward, so searching below that
     * amplitude flips the crossing classification. The tolerance exit is one-sided: only a
     * not-crossed `mid`, which is itself the recorded answer, may end the loop, so the returned
     * amount's evaluated post-price never crosses the target.
     * @param ctx Search context.
     * @return amountIn Best checked non-crossing gross input, raw units, or zero.
     * @return amountOut Pool quote for `amountIn`, raw units, or zero.
     */
    function _bisectAmountInForTarget(
        QuoteBisectCtx memory ctx
    ) private view returns (uint256 amountIn, uint256 amountOut) {
        uint256 lo = 0;
        uint256 hi;
        {
            // Scoped for the legacy 16-slot stack.
            uint256 hiCap = ctx.inputReserve - ctx.inputReserve / 100;
            if (hiCap == 0) return (0, 0);

            hi = ctx.inputReserve / 1024;
            if (hi == 0) hi = 1;
            if (hi > hiCap) hi = hiCap;

            bool bracketed = false;

            for (uint256 i; i < 40; ) {
                (PriceProbeStatus status, uint256 out, uint256 pMargAfter) = _tryPriceTargetProbe(
                    ctx,
                    hi
                );

                bool crossed = ctx.zeroForOne
                    ? pMargAfter >= ctx.pTargetMath
                    : pMargAfter <= ctx.pTargetMath;
                // A refused amount is a search ceiling, not evidence of crossing; refine toward
                // the last usable amount.
                if (
                    status == PriceProbeStatus.Rejected ||
                    (status == PriceProbeStatus.Valid && crossed)
                ) {
                    bracketed = true;
                    break;
                }

                if (status == PriceProbeStatus.Valid) {
                    amountOut = out;
                    amountIn = hi;
                }

                if (hi >= hiCap) break;
                lo = hi;
                unchecked {
                    hi = hi * 2;
                    if (hi > hiCap) hi = hiCap;
                    ++i;
                }
            }

            if (!bracketed) {
                return (amountIn, amountOut);
            }
        }

        uint256 tolerance = ctx.pTargetMath / 1e8;
        {
            // Fee-quantization noise floor, sized for the coarsest one-bps rate step (conservative
            // under the WAD-precision rate); a no-op when `protocolFeePercent == 0`. Scoped for
            // the legacy 16-slot stack.
            uint256 qNoise = FixedPointMathLib.fullMulDiv(
                ctx.pTargetMath,
                ctx.state.protocolFeePercent,
                1e6
            );
            if (tolerance < qNoise) tolerance = qNoise;
        }
        if (tolerance == 0) tolerance = 1;

        for (uint256 j; j < 50; ) {
            if (hi - lo <= 1) break;
            uint256 mid;
            unchecked {
                mid = (lo + hi) / 2;
            }
            (PriceProbeStatus status, uint256 out, uint256 pMargAfter) = _tryPriceTargetProbe(
                ctx,
                mid
            );

            bool crossed = ctx.zeroForOne
                ? pMargAfter >= ctx.pTargetMath
                : pMargAfter <= ctx.pTargetMath;
            if (
                status == PriceProbeStatus.Rejected || (status == PriceProbeStatus.Valid && crossed)
            ) {
                hi = mid;
            } else {
                lo = mid;
                if (status == PriceProbeStatus.TooSmall) {
                    unchecked {
                        ++j;
                    }
                    continue;
                }
                amountOut = out;
                amountIn = mid;
                // One-sided tolerance exit: only this not-crossed `mid`, the recorded answer, may
                // end the search; a crossed mid within tolerance keeps narrowing instead.
                uint256 diff = pMargAfter > ctx.pTargetMath
                    ? pMargAfter - ctx.pTargetMath
                    : ctx.pTargetMath - pMargAfter;
                if (diff <= tolerance) break;
            }

            unchecked {
                ++j;
            }
        }
    }

    /**
     * @dev Runs the pool's checked `quoteExactIn` for `amountIn` and classifies the outcome:
     * `AmountTooSmallAfterNormalization` or a zero quote is `TooSmall`; `SolverDidNotConverge`,
     * `LpValueDecreased`, `InsufficientLiquidity` and `MathOutOfRange` are `Rejected`; any other
     * revert is re-raised verbatim. A valid probe also returns the marginal math-space price of
     * the settled native reserves (input net of the protocol cut added, output removed).
     * @param ctx Search context.
     * @param amountIn Gross input to probe, raw units.
     * @return status Outcome class.
     * @return amountOut Pool quote, raw units; zero unless `Valid`.
     * @return priceAfter Post-swap marginal price in math space, WAD; zero unless `Valid`.
     */
    function _tryPriceTargetProbe(
        QuoteBisectCtx memory ctx,
        uint256 amountIn
    ) private view returns (PriceProbeStatus status, uint256 amountOut, uint256 priceAfter) {
        try IEquilibraPool(ctx.pool).quoteExactIn(ctx.zeroForOne, amountIn) returns (uint256 out) {
            amountOut = out;
        } catch (bytes memory reason) {
            if (reason.length == 4) {
                bytes4 selector = bytes4(reason);
                if (selector == Errors.AmountTooSmallAfterNormalization.selector)
                    return (PriceProbeStatus.TooSmall, 0, 0);
                if (
                    selector == Errors.SolverDidNotConverge.selector ||
                    selector == Errors.LpValueDecreased.selector ||
                    selector == Errors.InsufficientLiquidity.selector ||
                    selector == Errors.MathOutOfRange.selector
                ) return (PriceProbeStatus.Rejected, 0, 0);
            }
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
        if (amountOut == 0) return (PriceProbeStatus.TooSmall, 0, 0);

        PoolQuoteCtx memory cs = ctx.state;
        uint256 netIn = amountIn - _swapProtocolCut(cs, ctx.zeroForOne, amountIn);
        uint256 r0 = cs.reserve0;
        uint256 r1 = cs.reserve1;
        if (ctx.zeroForOne) {
            r0 += netIn;
            r1 -= amountOut;
        } else {
            r1 += netIn;
            r0 -= amountOut;
        }
        priceAfter = EquilibraSwapMath.marginalPriceFromState(
            r1 * cs.token1Scale,
            FixedPointMathLib.divWad(r0 * cs.token0Scale, cs.priceScaleWad),
            cs.aWad,
            cs.lambdaWad
        );
    }

    /**
     * @notice Pool snapshot shared by the price-target and zap quotes; the reserves can be bound
     * to a hypothetical state before lifting.
     */
    struct PoolQuoteCtx {
        uint256 aWad;
        uint256 lambdaWad;
        uint256 priceScaleWad;
        /// `10^(18 - decimals)` of token0.
        uint256 token0Scale;
        /// `10^(18 - decimals)` of token1.
        uint256 token1Scale;
        /// Fee ceiling as a WAD rate (`baseFee · 1e14`).
        uint256 baseFeeWad;
        /// Fee floor as a WAD rate (`feeFloorBps · 1e14`).
        uint256 floorWad;
        /// Ramp width as a WAD distance (`feeRampBps · 1e14`); zero disables the ramp.
        uint256 rampDistWad;
        /// Protocol slice of every fee, percent.
        uint256 protocolFeePercent;
        uint256 reserve0;
        uint256 reserve1;
        /// Lifted base-side coordinate `reserve1 · token1Scale`.
        uint256 xMath;
        /// Lifted quote-side coordinate `divWad(reserve0 · token0Scale, priceScaleWad)`.
        uint256 yMath;
        /// Pre-swap depth `solveLFromState(xMath, yMath)`, Q128.
        uint256 lPreQ128;
    }

    /**
     * @dev Loads the typed pool state (fee config, price scale, decimal scales, curve knobs) and
     * binds the given reserves without lifting or solving L. Token decimals must equal the scales
     * the pool was initialized with.
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param reserve0 Token0 reserve to bind, raw units.
     * @param reserve1 Token1 reserve to bind, raw units.
     * @return ctx Unlifted snapshot.
     */
    function _loadQuoteCtx(
        address pool,
        address token0,
        address token1,
        uint256 reserve0,
        uint256 reserve1
    ) private view returns (PoolQuoteCtx memory ctx) {
        ctx = _feeQuoteCtx(IEquilibraPool(pool).getFeeConfig());
        _loadQuoteScales(ctx, pool, token0, token1);
        ctx.reserve0 = reserve0;
        ctx.reserve1 = reserve1;
        {
            IEquilibraPool.CurveParams memory cp = IEquilibraPool(pool).getCurveParams();
            ctx.aWad = cp.aWad;
            ctx.lambdaWad = cp.lambdaWad;
        }
    }

    /**
     * @dev Widens the pool's bps fee triple to WAD rates (`bps · 1e14`) and copies the protocol
     * percent into a fresh context.
     * @param fc Pool fee configuration.
     * @return ctx Context with only the fee fields populated.
     */
    function _feeQuoteCtx(
        IEquilibraPool.FeeConfig memory fc
    ) private pure returns (PoolQuoteCtx memory ctx) {
        unchecked {
            // uint16 · 1e14 ≤ 6.55e18 — overflow-free.
            ctx.baseFeeWad = uint256(fc.baseFee) * 1e14;
            ctx.floorWad = uint256(fc.feeFloorBps) * 1e14;
            ctx.rampDistWad = uint256(fc.feeRampBps) * 1e14;
        }
        ctx.protocolFeePercent = fc.protocolFeePercent;
    }

    /**
     * @dev Reads the price scale and derives `10^(18 - decimals)` for both tokens.
     * @param ctx Context to fill.
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     */
    function _loadQuoteScales(
        PoolQuoteCtx memory ctx,
        address pool,
        address token0,
        address token1
    ) private view {
        ctx.priceScaleWad = IEquilibraPool(pool).getPriceScale();
        ctx.token0Scale = 10 ** (18 - IERC20Metadata(token0).decimals());
        ctx.token1Scale = 10 ** (18 - IERC20Metadata(token1).decimals());
    }

    /**
     * @dev Asymmetric lift in the pool's order: `xMath = reserve1 · token1Scale` (identity) and
     * `yMath = divWad(reserve0 · token0Scale, priceScaleWad)`; both stay zero when either wad
     * side is zero.
     * @param ctx Context whose reserves and scales are already bound.
     */
    function _liftQuoteCtx(PoolQuoteCtx memory ctx) private pure {
        uint256 xWad = ctx.reserve1 * ctx.token1Scale;
        uint256 yWad = ctx.reserve0 * ctx.token0Scale;
        if (xWad != 0 && yWad != 0) {
            ctx.xMath = xWad;
            ctx.yMath = FixedPointMathLib.divWad(yWad, ctx.priceScaleWad);
        }
    }

    /**
     * @dev Projects the protocol cut of an exact-in swap without loading curve parameters or
     * solving L; the lift is skipped when the cut is zero or the ramp is off (flat fee).
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param reserve0 Pre-swap token0 reserve, raw units.
     * @param reserve1 Pre-swap token1 reserve, raw units.
     * @param zeroForOne Swap direction.
     * @param amountIn Gross input, raw units.
     * @return Protocol cut in raw input units.
     */
    function _previewSwapProtocolCut(
        address pool,
        address token0,
        address token1,
        uint256 reserve0,
        uint256 reserve1,
        bool zeroForOne,
        uint256 amountIn
    ) private view returns (uint256) {
        IEquilibraPool.FeeConfig memory fc = IEquilibraPool(pool).getFeeConfig();
        if (fc.protocolFeePercent == 0) return 0;
        PoolQuoteCtx memory ctx = _feeQuoteCtx(fc);
        if (ctx.rampDistWad != 0) {
            _loadQuoteScales(ctx, pool, token0, token1);
            ctx.reserve0 = reserve0;
            ctx.reserve1 = reserve1;
            _liftQuoteCtx(ctx);
        }
        return _swapProtocolCut(ctx, zeroForOne, amountIn);
    }

    /**
     * @dev Mirror of the pool's CP-proxy dynamic-fee resolver at the context's state: the flat
     * `baseFeeWad` when the ramp is off, the state is unlifted or the input normalizes to zero;
     * otherwise `smoothstepFeeWad` of the constant-product post-distance of the gross input.
     * @param ctx Lifted context.
     * @param zeroForOne Swap direction.
     * @param amountInRaw Gross input, raw units.
     * @return feeWad Fee rate, WAD.
     */
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

    /**
     * @dev Protocol slice of the fee an exact-in swap of `grossIn` pays at the context's state:
     * the part the pool does not add back to its reserve on commit. Mirrors the pool's minimum
     * raw fee (`max(1, floor(grossIn · feeWad / WAD))` at a positive rate) and its floor
     * division by 100.
     * @param ctx Lifted context.
     * @param zeroForOne Swap direction.
     * @param grossIn Gross input, raw units.
     * @return cut Protocol cut, raw input units.
     */
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
            if (feeAmount == 0 && feeWad != 0) feeAmount = 1;
            cut = (feeAmount * ctx.protocolFeePercent) / 100;
        }
    }

    /**
     * @dev Mirror of `EquilibraPool.quoteExactIn` at the context's (possibly hypothetical)
     * reserves: same library kernel, rounding order and guard outcomes, reverting where the pool's
     * quote reverts. Returns zero for a zero or over-uint128 input and for an empty reserve.
     * @param ctx Context with reserves bound; lifted and depth-solved here.
     * @param zeroForOne Swap direction.
     * @param amountIn Gross input, raw units.
     * @return amountOut Checked output, raw units.
     */
    function _quoteExactInAt(
        PoolQuoteCtx memory ctx,
        bool zeroForOne,
        uint256 amountIn
    ) private pure returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > type(uint128).max) return 0;
        if (ctx.reserve0 == 0 || ctx.reserve1 == 0) return 0;

        _liftQuoteCtx(ctx);
        ctx.lPreQ128 = EquilibraSwapMath.solveLFromState(
            ctx.xMath,
            ctx.yMath,
            ctx.aWad,
            ctx.lambdaWad
        );
        SwapQuoteResult memory result = _quoteExactInMathAt(ctx, zeroForOne, amountIn);
        amountOut = result.amountOutWad / (zeroForOne ? ctx.token1Scale : ctx.token0Scale);
        amountOut = _checkedQuotedAmountOut(ctx, zeroForOne, amountIn, amountOut, result.feeAmount);
    }

    /**
     * @notice Math-space exact-in quote: the output in wad units of the output token and the raw
     * fee charged on the input.
     */
    struct SwapQuoteResult {
        uint256 amountOutWad;
        uint256 feeAmount;
    }

    /**
     * @dev Fee, normalization and kernel stage of {_quoteExactInAt}. The fee is
     * `max(1, floor(amountIn · feeWad / WAD))` at a positive rate; the clean input is scaled to
     * wad and, for token0 input, divided by the price scale, a zero at either step reverting
     * `AmountTooSmallAfterNormalization`. A forward-kernel output at or above the output-side math
     * reserve reverts `InsufficientLiquidity`; a token0 output is multiplied back by the price
     * scale, rounded down.
     * @param ctx Lifted context with `lPreQ128` solved.
     * @param zeroForOne Swap direction.
     * @param amountIn Gross input, raw units.
     * @return result Output in wad units and the raw fee.
     */
    function _quoteExactInMathAt(
        PoolQuoteCtx memory ctx,
        bool zeroForOne,
        uint256 amountIn
    ) private pure returns (SwapQuoteResult memory result) {
        uint256 cleanWad;
        unchecked {
            // amountIn <= uint128.max and feeWad < WAD.
            uint256 feeWad = _resolveFeeWadAt(ctx, zeroForOne, amountIn);
            result.feeAmount = (amountIn * feeWad) / Constants.WAD;
            if (result.feeAmount == 0 && feeWad != 0) result.feeAmount = 1;
            cleanWad =
                (amountIn - result.feeAmount) * (zeroForOne ? ctx.token0Scale : ctx.token1Scale);
        }
        if (cleanWad == 0) revert Errors.AmountTooSmallAfterNormalization();
        uint256 amountInMath = zeroForOne
            ? FixedPointMathLib.divWad(cleanWad, ctx.priceScaleWad)
            : cleanWad;
        if (amountInMath == 0) revert Errors.AmountTooSmallAfterNormalization();
        uint256 delta;
        if (zeroForOne) {
            (delta, ) = EquilibraSwapMath.quoteExactInForward(
                ctx.yMath,
                ctx.xMath,
                amountInMath,
                ctx.aWad,
                ctx.lambdaWad,
                ctx.lPreQ128
            );
            if (delta >= ctx.xMath) revert Errors.InsufficientLiquidity();
            result.amountOutWad = delta;
        } else {
            (delta, ) = EquilibraSwapMath.quoteExactInForward(
                ctx.xMath,
                ctx.yMath,
                amountInMath,
                ctx.aWad,
                ctx.lambdaWad,
                ctx.lPreQ128
            );
            if (delta >= ctx.yMath) revert Errors.InsufficientLiquidity();
            result.amountOutWad = FixedPointMathLib.mulWad(delta, ctx.priceScaleWad);
        }
    }

    /**
     * @dev Applies the pool's native-unit commit checks before repeg: a zero output reverts
     * `AmountTooSmallAfterNormalization`, an output at or above the output reserve
     * `InsufficientLiquidity`, settled reserves (input net of the protocol cut added, output
     * removed) beyond uint128 `MathInvariantViolation`, and a settled Q128 depth below the
     * pre-swap `lPreQ128` `LpValueDecreased`. Works on the raw reserves: reversing the math-space
     * lift would lose quote-side rounding at a non-unit price scale.
     * @param ctx Lifted context with `lPreQ128` solved.
     * @param zeroForOne Swap direction.
     * @param amountIn Gross input, raw units.
     * @param amountOut Candidate output, raw units.
     * @param feeAmount Raw fee charged on `amountIn`.
     * @return The unchanged `amountOut`.
     */
    function _checkedQuotedAmountOut(
        PoolQuoteCtx memory ctx,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount
    ) private pure returns (uint256) {
        if (amountOut == 0) revert Errors.AmountTooSmallAfterNormalization();
        uint256 r0 = ctx.reserve0;
        uint256 r1 = ctx.reserve1;
        uint256 reserveOut = zeroForOne ? r1 : r0;
        if (amountOut >= reserveOut) revert Errors.InsufficientLiquidity();
        uint256 protocolCut = (feeAmount * ctx.protocolFeePercent) / 100;
        if (zeroForOne) {
            r0 += amountIn - protocolCut;
            r1 -= amountOut;
        } else {
            r1 += amountIn - protocolCut;
            r0 -= amountOut;
        }
        if (r0 > type(uint128).max || r1 > type(uint128).max)
            revert Errors.MathInvariantViolation();
        if (_lpDepthAt(ctx, r0, r1) < ctx.lPreQ128) revert Errors.LpValueDecreased();
        return amountOut;
    }

    /**
     * @dev Q128 depth of the raw reserves `(r0, r1)` under the context's anchor and curve knobs.
     * @param ctx Context supplying scales, price scale and curve knobs.
     * @param r0 Token0 reserve, raw units.
     * @param r1 Token1 reserve, raw units.
     * @return `solveLFromState` of the lifted pair, Q128.
     */
    function _lpDepthAt(
        PoolQuoteCtx memory ctx,
        uint256 r0,
        uint256 r1
    ) private pure returns (uint256) {
        return
            EquilibraSwapMath.solveLFromState(
                r1 * ctx.token1Scale,
                FixedPointMathLib.divWad(r0 * ctx.token0Scale, ctx.priceScaleWad),
                ctx.aWad,
                ctx.lambdaWad
            );
    }

    // =====================================================================
    // Zap: math helpers
    // =====================================================================

    /**
     * @dev Rebalance leg of {zapInImbalanced}: derives the direction and size of the in-pool swap
     * that aligns `(amount0, amount1)` with the current reserve ratio, executes it with the
     * router as payer and recipient, and returns the updated deposit pair (unchanged when no swap
     * is needed).
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param amount0 Token0 staged on the router, raw units.
     * @param amount1 Token1 staged on the router, raw units.
     * @return Rebalanced token0 deposit, raw units.
     * @return Rebalanced token1 deposit, raw units.
     */
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

    /**
     * @dev Swap leg of {_zapOutSingleSidedFinalize} with the router as payer and recipient; split
     * out so the parent fits the 16-slot stack on legacy (non-viaIR) builds.
     * @param pool Resolved pool address.
     * @param tokenIn Off-side token being sold.
     * @param tokenOut Token being bought.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param zeroForOne Swap direction.
     * @param amountToSwap Gross input, raw units.
     * @return swapOut Output delivered to the router, raw units.
     */
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

    /**
     * @dev Swap leg of {_zapImbalancedRebalance}: resolves the `(in, out)` pair from `zeroForOne`
     * and forwards to {_swapInputAtPool} with the router as payer and recipient; split out so the
     * parent fits the 16-slot stack on legacy (non-viaIR) builds.
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param zeroForOne Swap direction.
     * @param swapAmount Gross input, raw units.
     * @return swapOut Output delivered to the router, raw units.
     */
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

    /**
     * @dev Mint, slippage check and residual sweep tail of {zapInImbalanced}. Emits `ZapIn` with
     * `tokenIn = address(0)` and `amountIn = amountA + amountB` because there is no single input
     * token.
     * @param params Caller's zap parameters.
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param amount0 Rebalanced token0 deposit, raw units.
     * @param amount1 Rebalanced token1 deposit, raw units.
     * @return liquidity LP shares minted to `params.recipient`.
     */
    function _zapInImbalancedFinalize(
        ZapInImbalancedParams calldata params,
        address pool,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) private returns (uint256 liquidity) {
        // The pool rejects a zero side with `ZeroAmount`; fail before the external call.
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

    /**
     * @dev Mint, slippage check and residual sweep tail of {zapInSingleSided}; split out so the
     * entrypoint fits the 16-slot stack on legacy (non-viaIR) builds.
     * @param params Caller's zap parameters.
     * @param amountIn Effective input (the resolved staged balance on the sentinel path).
     * @param pool Resolved pool address.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     * @param amount0 Token0 deposit after the swap, raw units.
     * @param amount1 Token1 deposit after the swap, raw units.
     * @return liquidity LP shares minted to `params.recipient`.
     */
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

        // Log the effective input, never the raw `params.amountIn`: a zero sentinel must not read
        // as a zero-sized zap.
        _emitZapInWithDust(pool, msg.sender, params.tokenIn, amountIn, liquidity, token0, token1);
    }

    /**
     * @dev Swap leg of {zapInSingleSided}: derives the constant-product split from the current
     * reserves (zero reverts `ZeroAmount`), swaps it with the router as payer and recipient, and
     * returns the canonical `(amount0, amount1)` deposit pair; split out so the entrypoint fits
     * the 16-slot stack on legacy (non-viaIR) builds.
     * @param pool Resolved pool address.
     * @param tokenIn Deposited token.
     * @param tokenOut The other pair token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param amountIn Effective raw deposit staged on the router.
     * @param inIsToken0 Whether `tokenIn` is token0.
     * @return amount0 Token0 deposit after the swap, raw units.
     * @return amount1 Token1 deposit after the swap, raw units.
     */
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

    /**
     * @dev Constant-product closed form for the swap leg of a single-sided zap,
     * `x = sqrt(rIn · (rIn + amountIn)) - rIn`. The product is rooted once when it fits uint256;
     * otherwise the conservative `sqrt(rIn) · sqrt(rIn + amountIn)` is used (the factored product
     * fits uint192 for uint128 reserves). The result is reduced by 0.5% and capped at half the
     * input. Reverts `MathOutOfRange` when `rIn + amountIn` overflows; an empty input reserve
     * yields zero.
     * @param zeroForOne Swap direction (`true` sells token0).
     * @param amountIn Raw deposit.
     * @param r0 Token0 reserve, raw units.
     * @param r1 Token1 reserve, raw units.
     * @return swapAmount Part of `amountIn` to swap, raw units.
     */
    function _calculateOptimalSwap(
        bool zeroForOne,
        uint256 amountIn,
        uint256 r0,
        uint256 r1
    ) internal pure returns (uint256 swapAmount) {
        uint256 rIn = zeroForOne ? r0 : r1;
        if (rIn == 0) return 0;

        if (amountIn > type(uint256).max - rIn) revert Errors.MathOutOfRange();
        uint256 sum = rIn + amountIn;
        uint256 sqrtProduct = rIn <= type(uint256).max / sum
            ? FixedPointMathLib.sqrt(rIn * sum)
            : FixedPointMathLib.sqrt(rIn) * FixedPointMathLib.sqrt(sum);
        swapAmount = sqrtProduct > rIn ? sqrtProduct - rIn : 0;

        swapAmount = (swapAmount * 995) / 1000;

        uint256 cap = amountIn / 2;
        if (swapAmount > cap) swapAmount = cap;
    }

    /**
     * @dev Direction and size of the rebalance swap for the imbalanced zap. A single-sided
     * deposit reduces to {_calculateOptimalSwap}; otherwise the side in excess of the pool ratio
     * is partially swapped. Returns `swapAmount == 0` when the deposit already matches the ratio
     * within floor rounding. Cross products use `fullMulDiv`, so `amount · reserve` beyond
     * uint256 stays exact.
     * @param amount0 Token0 deposit, raw units.
     * @param amount1 Token1 deposit, raw units.
     * @param r0 Token0 reserve, raw units.
     * @param r1 Token1 reserve, raw units.
     * @return zeroForOne Swap direction (`true` sells token0).
     * @return swapAmount Gross input of the rebalance swap, raw units; zero when balanced.
     */
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

        // balanced1 = amount0 · r1 / r0: the token1 amount that pairs with `amount0` at the pool
        // ratio.
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

    /**
     * @dev Sweeps the router's whole balance of both pool tokens back to `user` and emits `ZapIn`.
     * @param pool Resolved pool address.
     * @param user Residual recipient (the zap caller).
     * @param tokenIn Deposited token, or `address(0)` for the imbalanced zap.
     * @param amountIn Effective input logged in the event.
     * @param liquidity LP shares minted.
     * @param token0 Canonical token0.
     * @param token1 Canonical token1.
     */
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

    /**
     * @dev Single-hop exact-input leg with the compact callback payload. A zero `recipient` maps
     * to the router (staging); the CONTRACT_BALANCE sentinel resolves the router's `tokenIn`
     * balance and makes the router the payer.
     * @param tokenIn Input token.
     * @param tokenOut Output token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param amountIn Gross input, raw units, or the sentinel.
     * @param recipient Output receiver, or `address(0)` to stage on the router.
     * @param payer Address the callback charges.
     * @return amountOut Output delivered, raw units.
     */
    function _exactInputSingleInternal(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn,
        address recipient,
        address payer
    ) private returns (uint256 amountOut) {
        if (recipient == address(0)) recipient = address(this);
        if (amountIn == _CONTRACT_BALANCE) {
            amountIn = IERC20Metadata(tokenIn).balanceOf(address(this));
            payer = address(this);
        }

        (address pool, bool zeroForOne, , ) = _resolvePool(tokenIn, tokenOut, poolIndex);

        amountOut = _swapInputAtPool(
            pool,
            zeroForOne,
            amountIn,
            recipient,
            abi.encode(tokenIn, tokenOut, poolIndex, payer)
        );
    }

    /**
     * @dev Executes an exact-input `pool.swap` on a pre-resolved pool and returns the
     * receiver-side delta. Shared by every exact-input path (single-hop, multi-hop and the zaps),
     * so the CREATE2 resolve never runs twice for one pair within a call.
     * @param pool Resolved pool address.
     * @param zeroForOne Swap direction.
     * @param amountIn Gross input, raw units; above `int256.max` reverts in the checked cast.
     * @param recipient Output receiver.
     * @param callbackData Payload forwarded to {equilibraSwapCallback}.
     * @return amountOut Output delivered, raw units.
     */
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

    /**
     * @dev Single-hop exact-output leg with the compact callback payload: a negative
     * `amountSpecified` requests `amountOut`, and {_assertExactOutDeltas} checks the delivered
     * output and extracts the input paid. A zero `recipient` maps to the router.
     * @param tokenIn Input token.
     * @param tokenOut Output token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param amountOut Exact output, raw units.
     * @param recipient Output receiver, or `address(0)` to stage on the router.
     * @param payer Address the callback charges.
     * @return amountIn Input paid, raw units.
     */
    function _exactOutputSingleInternal(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountOut,
        address recipient,
        address payer
    ) private returns (uint256 amountIn) {
        if (recipient == address(0)) recipient = address(this);

        (address pool, bool zeroForOne, , ) = _resolvePool(tokenIn, tokenOut, poolIndex);

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

    /**
     * @dev One exact-input hop of a multi-hop route with the {SwapPath} callback payload; a zero
     * `recipient` maps to the router.
     * @param amountIn Gross input of this hop, raw units.
     * @param recipient Output receiver, or `address(0)` to stage on the router.
     * @param data Callback payload holding this hop's path and the payer.
     * @return amountOut Output delivered, raw units.
     */
    function _exactInputInternal(
        uint256 amountIn,
        address recipient,
        SwapCallbackData memory data
    ) private returns (uint256 amountOut) {
        if (recipient == address(0)) recipient = address(this);

        (address tokenIn, address tokenOut, uint32 poolIndex) = data.path.decodeFirstPool();
        (address pool, bool zeroForOne, , ) = _resolvePool(tokenIn, tokenOut, poolIndex);

        amountOut = _swapInputAtPool(pool, zeroForOne, amountIn, recipient, abi.encode(data));
    }

    /**
     * @dev Multi-hop exact-output leg. Returns nothing on purpose: the input cost reaches
     * {exactOutput} through `_AMOUNT_IN_CACHED_TSLOT`, written by the innermost callback, while
     * this frame's delta describes the token paid to its own hop, an intermediate token on a
     * multi-hop route and the wrong quantity to check against `amountInMaximum`. A zero
     * `recipient` maps to the router.
     * @param amountOut Exact output of this hop, raw units.
     * @param recipient Output receiver, or `address(0)` to stage on the router.
     * @param data Callback payload holding the remaining reversed path and the payer.
     */
    function _exactOutputInternal(
        uint256 amountOut,
        address recipient,
        SwapCallbackData memory data
    ) private {
        if (recipient == address(0)) recipient = address(this);

        // Exact-output paths are reversed: the first 20 bytes are this hop's output token, the
        // next 20 its input token.
        (address tokenOut, address tokenIn, uint32 poolIndex) = data.path.decodeFirstPool();
        (address pool, bool zeroForOne, , ) = _resolvePool(tokenIn, tokenOut, poolIndex);

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

    /**
     * @dev Reverts `InvalidCallbackSender` unless `msg.sender` is the CREATE2-derived pool of
     * `(tokenA, tokenB, poolIndex)`.
     * @param tokenA One pair token as encoded in the payload.
     * @param tokenB The other pair token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @return zeroForOne Whether `tokenA` is the pool's token0.
     */
    function _verifyCallback(
        address tokenA,
        address tokenB,
        uint32 poolIndex
    ) private view returns (bool zeroForOne) {
        address expected;
        (expected, zeroForOne, , ) = _resolvePool(tokenA, tokenB, poolIndex);
        if (msg.sender != expected) revert Errors.InvalidCallbackSender();
    }

    /**
     * @dev Sorts `(tokenIn, tokenOut)` into the pool's canonical `(token0, token1)` order and
     * CREATE2-derives the pool address; pure arithmetic with no external call or existence check,
     * so an undeployed pool fails when the caller reads or calls it.
     * @param tokenIn Input token.
     * @param tokenOut Output token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @return pool Derived pool address.
     * @return zeroForOne Whether `tokenIn` is token0.
     * @return token0 Lower-sorted token.
     * @return token1 Higher-sorted token.
     */
    function _resolvePool(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex
    ) private view returns (address pool, bool zeroForOne, address token0, address token1) {
        zeroForOne = tokenIn < tokenOut;
        (token0, token1) = zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        pool = PoolAddressCompute.computeAddress(factory, _initCodeHash, token0, token1, poolIndex);
    }

    /**
     * @dev Decodes the signed deltas of an exact-output `pool.swap`, reverting
     * `InsufficientOutputAmount` unless the pool delivered exactly `amountOut`, and returns the
     * input paid. Shared by the single- and multi-hop exact-output paths.
     * @param zeroForOne Swap direction.
     * @param amount0Delta Token0 delta returned by the pool (positive = paid in).
     * @param amount1Delta Token1 delta returned by the pool (positive = paid in).
     * @param amountOut Requested exact output, raw units.
     * @return amountIn Input paid, raw units.
     */
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

    /**
     * @dev Funds a zap input onto the router. A WETH9 `token` with attached value of at least
     * `amount` wraps exactly `amount`; a WETH9 leg with less attached value, or any other token,
     * is pulled in full from `msg.sender` via `transferFrom`. Attached value not consumed here
     * stays on the router as a permissionless balance and must be reclaimed with {refundETH} in
     * the same batch.
     * @param token Input token.
     * @param amount Raw amount to fund.
     */
    function _pullOrWrap(address token, uint256 amount) private {
        if (token == WETH9 && address(this).balance >= amount) {
            IWETH9(WETH9).deposit{ value: amount }();
        } else {
            SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        }
    }

    /**
     * @dev Payment routing for the swap and mint callbacks, in a safety-critical branch order.
     * (1) Router as payer (`payer == address(this)`): transfer from the router's own `token`
     * balance unconditionally; staged funds (a multi-hop intermediate output, a zap swap-output
     * capture) are held as `token`, and consulting `address(this).balance` first would, on a
     * `... -> WETH -> ...` route carrying excess `msg.value`, wrap attached ETH for the hop and
     * strand the staged WETH beside the leftover ETH, both claimable through the permissionless
     * helpers. (2) External payer with `token == WETH9` and enough router-held native value: wrap
     * exactly the amount owed and pay it. (3) External payer otherwise: `transferFrom` the
     * declared `payer`.
     * @param token Token owed.
     * @param payer Address charged; `address(this)` selects the staged-funds branch.
     * @param recipient Pool receiving the payment.
     * @param value Raw amount owed.
     */
    function _pay(address token, address payer, address recipient, uint256 value) private {
        if (payer == address(this)) {
            // Staged funds: pay from the router's `token` balance and never wrap native value here.
            SafeTransferLib.safeTransfer(token, recipient, value);
        } else if (token == WETH9 && address(this).balance >= value) {
            // External payer supplied native ETH for a WETH9 leg: wrap only what this hop owes.
            IWETH9(WETH9).deposit{ value: value }();
            SafeTransferLib.safeTransfer(WETH9, recipient, value);
        } else {
            SafeTransferLib.safeTransferFrom(token, payer, recipient, value);
        }
    }
}
