// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IMulticall } from "./IMulticall.sol";

/**
 * @title IEquilibraRouter
 * @notice User-facing swap, liquidity, donation and zap router for callback-based Equilibra pools.
 * @dev Every state-changing entrypoint except {donate} is `payable`: a WETH9 leg can be funded
 * with attached native ETH, and batches carrying value compose through {IMulticall}. Balances left
 * on the router (staged outputs, unspent ETH) are claimable by anyone, so a batch that can leave
 * value behind ends with {sweepToken}, {unwrapWETH9} or {refundETH}.
 */
interface IEquilibraRouter is IMulticall {
    // =====================================================================
    // Swap structs
    // =====================================================================

    /**
     * @notice Parameters for {exactInputSingle}.
     * @dev `amountIn == type(uint256).max` is the CONTRACT_BALANCE sentinel on every exact-input
     * entrypoint: the leg consumes the router's entire live balance of its input token, whatever
     * its provenance, and pays from it. Stage and consume in one transaction: a balance funded
     * earlier is included but equally sweepable by anyone. For a WETH9 leg only the existing WETH
     * balance counts; the sentinel wraps no attached native value (chain {refundETH}). Every other
     * value >= 2^255 reverts in the checked int256 cast, so the sentinel shadows no real amount.
     */
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// `address(0)` stages the output on the router for {sweepToken} / {unwrapWETH9}.
        address recipient;
        /// Gross input in raw `tokenIn` units, or the CONTRACT_BALANCE sentinel.
        uint256 amountIn;
        /// Reverts `SlippageExceeded` when the output is below it.
        uint256 amountOutMinimum;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {exactOutputSingle}.
     */
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// `address(0)` stages the output on the router for {sweepToken} / {unwrapWETH9}.
        address recipient;
        /// Exact output in raw `tokenOut` units.
        uint256 amountOut;
        /// Reverts `ExcessiveInputAmount` when the input paid exceeds it.
        uint256 amountInMaximum;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {exactInput}.
     * @dev `amountIn` accepts the CONTRACT_BALANCE sentinel of {ExactInputSingleParams}; the
     * balance read is of the path's first token.
     */
    struct ExactInputParams {
        /// {SwapPath} bytes `[tokenIn (20)][poolIndex (4)][token (20)]...`, input token first.
        bytes path;
        /// `address(0)` stages the final output on the router for {sweepToken} / {unwrapWETH9}.
        address recipient;
        /// Gross input in raw units of the path's first token, or the CONTRACT_BALANCE sentinel.
        uint256 amountIn;
        /// Reverts `SlippageExceeded` when the final output is below it.
        uint256 amountOutMinimum;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {exactOutput}.
     */
    struct ExactOutputParams {
        /// {SwapPath} bytes in reverse hop order: the final output token first, the input token
        /// last.
        bytes path;
        /// `address(0)` stages the output on the router for {sweepToken} / {unwrapWETH9}.
        address recipient;
        /// Exact output in raw units of the path's first token.
        uint256 amountOut;
        /// Reverts `ExcessiveInputAmount` when the input paid exceeds it.
        uint256 amountInMaximum;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {addLiquidity}. Tokens may be given in either order; the router
     * sorts `(tokenA, tokenB)` and `(amountADesired, amountBDesired)` in lockstep into the pool's
     * canonical `token0 < token1` order.
     */
    struct AddLiquidityParams {
        address tokenA;
        address tokenB;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// LP share recipient; `address(0)` reverts `ZeroAddress`.
        address recipient;
        /// Upper bound pulled in `tokenA`; the pool's proportional cap may use less.
        uint256 amountADesired;
        /// Upper bound pulled in `tokenB`; the pool's proportional cap may use less.
        uint256 amountBDesired;
        /// Reverts `SlippageExceeded` when fewer shares are minted.
        uint256 minShares;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {zapInSingleSided}: a single-token deposit that the router splits by
     * the constant-product zap closed form, swaps one part to the other side and mints from the
     * rebalanced pair.
     */
    struct ZapInSingleSidedParams {
        address tokenIn;
        address tokenOut;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// LP share recipient; `address(0)` reverts `ZeroAddress`.
        address recipient;
        /// Raw `tokenIn` deposit; `0` is the CONTRACT_BALANCE sentinel (see {zapInSingleSided}).
        uint256 amountIn;
        /// Reverts `SlippageExceeded` when fewer shares are minted.
        uint256 minLiquidity;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {zapInImbalanced}: both tokens at any ratio (one side may be zero);
     * the router performs one internal swap toward the pool's current ratio and then mints.
     */
    struct ZapInImbalancedParams {
        address tokenA;
        address tokenB;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// LP share recipient; `address(0)` reverts `ZeroAddress`.
        address recipient;
        /// Raw `tokenA` deposit; zero means nothing on this side (no sentinel).
        uint256 amountA;
        /// Raw `tokenB` deposit; zero means nothing on this side (no sentinel).
        uint256 amountB;
        /// Reverts `SlippageExceeded` when fewer shares are minted.
        uint256 minLiquidity;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {zapOutSingleSided}: burn LP, swap the off-side leg into `tokenOut`
     * and pay out a single asset.
     */
    struct ZapOutSingleSidedParams {
        address tokenA;
        address tokenB;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// One of the pair's tokens; any other address reverts `UnsupportedToken`.
        address tokenOut;
        /// `address(0)` stages the output on the router for {unwrapWETH9} / {sweepToken}.
        address recipient;
        /// LP shares to burn; zero reverts `ZeroAmount`.
        uint256 liquidity;
        /// Reverts `InsufficientOutputAmount` when the combined output is below it.
        uint256 minAmountOut;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    /**
     * @notice Parameters for {removeLiquidity}: burn `shares` of the `(tokenA, tokenB, poolIndex)`
     * pool's LP and forward both legs to `recipient`.
     * @dev Needs an LP-token approval to this router; chain {selfPermitIfNecessary} in the same
     * batch to sign it in the same transaction. `recipient == address(0)` keeps both outputs on
     * the router for {unwrapWETH9} / {sweepToken} chaining through {multicall}.
     */
    struct RemoveLiquidityParams {
        address tokenA;
        address tokenB;
        /// Pair-local index of the pool under the factory.
        uint32 poolIndex;
        /// LP shares to burn; zero reverts `ZeroAmount`.
        uint256 shares;
        /// Minimum payout in `tokenA` (caller's order); the pool reverts `SlippageExceeded` below.
        uint256 amountAMin;
        /// Minimum payout in `tokenB` (caller's order); the pool reverts `SlippageExceeded` below.
        uint256 amountBMin;
        address recipient;
        /// UNIX seconds; reverts `DeadlineExpired` once `block.timestamp > deadline`.
        uint256 deadline;
    }

    // =====================================================================
    // Self-permit (EIP-2612 forwarding)
    // =====================================================================

    /**
     * @notice Forward an EIP-2612 signature to `token`, approving this router as the spender of
     * `msg.sender`'s balance.
     * @dev {multicall} delegatecalls only into this router, so an external `token.permit` cannot
     * be a batch element; this forwarder makes `[selfPermit, removeLiquidity]` (or a donation, or
     * a zap that pulls LP) atomic. Payable so it composes inside a batch that carries native
     * value. A bare `selfPermit` reverts when the signature was already consumed (anyone can
     * submit it from the mempool) and fails the whole batch; prefer {selfPermitIfNecessary}.
     * @param token EIP-2612 token; every Equilibra LP token implements `permit`.
     * @param value Allowance to grant this router, raw token units.
     * @param deadline Signature expiry, UNIX seconds.
     * @param v Signature recovery id.
     * @param r Signature `r` word.
     * @param s Signature `s` word.
     */
    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable;

    /**
     * @notice {selfPermit} that no-ops when the router's allowance from `msg.sender` is already at
     * least `value`, so a front-run (already-consumed) signature cannot fail the batch.
     * @param token EIP-2612 token; every Equilibra LP token implements `permit`.
     * @param value Allowance to grant this router, raw token units.
     * @param deadline Signature expiry, UNIX seconds.
     * @param v Signature recovery id.
     * @param r Signature `r` word.
     * @param s Signature `s` word.
     */
    function selfPermitIfNecessary(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable;

    // =====================================================================
    // Swap entrypoints
    // =====================================================================

    /**
     * @notice Swap `params.amountIn` of `tokenIn` for as much `tokenOut` as one pool returns.
     * @dev The pool's callback charges `msg.sender`, wraps attached ETH for a WETH9 input, or
     * pays from the router on the CONTRACT_BALANCE sentinel. Reverts `SlippageExceeded` below
     * `amountOutMinimum` and `DeadlineExpired` past `deadline`; a zero `amountIn` is rejected by
     * the pool with `InvalidAmountSpecified`.
     * @param params Swap parameters; see {ExactInputSingleParams}.
     * @return amountOut Output delivered, raw `tokenOut` units.
     */
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Swap as little `tokenIn` as one pool requires for exactly `params.amountOut` of
     * `tokenOut`.
     * @dev Reverts `ExcessiveInputAmount` above `amountInMaximum` and `DeadlineExpired` past
     * `deadline`; a zero `amountOut` is rejected by the pool with `InvalidAmountSpecified`.
     * @param params Swap parameters; see {ExactOutputSingleParams}.
     * @return amountIn Input paid, raw `tokenIn` units.
     */
    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable returns (uint256 amountIn);

    /**
     * @notice Swap `params.amountIn` of the path's first token for as much of its last token as
     * the route returns.
     * @dev Each intermediate output is delivered to the router and pays the next hop; only the
     * final hop pays `recipient`. Reverts `SlippageExceeded` below `amountOutMinimum` and
     * `DeadlineExpired` past `deadline`.
     * @param params Swap parameters; see {ExactInputParams}.
     * @return amountOut Output delivered, raw units of the path's last token.
     */
    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Swap as little of the path's input token as the route requires for exactly
     * `params.amountOut` of its output token.
     * @dev Hops execute from the output end: each pool is paid by the next hop's output, and the
     * input token is charged to `msg.sender` at the last executed hop. Reverts
     * `ExcessiveInputAmount` above `amountInMaximum` and `DeadlineExpired` past `deadline`.
     * @param params Swap parameters; see {ExactOutputParams}.
     * @return amountIn Input paid, raw units of the path's input token.
     */
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable returns (uint256 amountIn);

    // =====================================================================
    // Liquidity entrypoints
    // =====================================================================

    /**
     * @notice Add proportional liquidity, pulling at most the desired amounts from the caller and
     * minting LP shares to `params.recipient`.
     * @dev The pool's proportional cap may use less on one side, so the used amount is unknowable
     * up front. A WETH9 leg can be funded with attached native ETH (the mint callback wraps
     * exactly the used amount); callers attaching ETH chain {refundETH} in the same {multicall}
     * to reclaim the remainder. Reverts `ZeroAddress` on a zero recipient, `IdenticalTokens` when
     * `tokenA == tokenB`, `SlippageExceeded` below `minShares` and `DeadlineExpired` past
     * `deadline`.
     * @param params Liquidity parameters; see {AddLiquidityParams}.
     * @return sharesOut LP shares minted to `params.recipient`.
     */
    function addLiquidity(
        AddLiquidityParams calldata params
    ) external payable returns (uint256 sharesOut);

    /**
     * @notice Burn `params.shares` LP shares and pay both underlying legs to `params.recipient`.
     * @dev The router pulls the shares from `msg.sender` first (approval or
     * {selfPermitIfNecessary} required) and the pool burns them from the router. Minimums and
     * returned amounts follow the caller's `(tokenA, tokenB)` order. Reverts `ZeroAmount` on zero
     * shares, `IdenticalTokens` when `tokenA == tokenB` and `DeadlineExpired` past `deadline`.
     * @param params Withdrawal parameters; see {RemoveLiquidityParams}.
     * @return amountA Payout in `tokenA`, raw units.
     * @return amountB Payout in `tokenB`, raw units.
     */
    function removeLiquidity(
        RemoveLiquidityParams calldata params
    ) external payable returns (uint256 amountA, uint256 amountB);

    /**
     * @notice Park `shares` of the `(tokenA, tokenB, poolIndex)` pool's LP on the pool's own
     * address as a donation: irreversible, no claim on reserves, spendable only by the pool's
     * donation parachute.
     * @dev Requires an LP-token approval to this router; chain {selfPermitIfNecessary} in the same
     * batch. A plain LP `transfer` to the pool is equivalent but unguarded; this entrypoint makes
     * the donation atomic against the quoted state. Not payable. Reverts `ZeroAmount` on zero
     * shares, `IdenticalTokens` when `tokenA == tokenB`, `SlippageExceeded` when the pool's
     * `totalSupply()` exceeds `maxSupply` and `DeadlineExpired` past `deadline`.
     * @param tokenA One pair token (either order).
     * @param tokenB The other pair token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param shares LP shares to park from the caller's balance.
     * @param maxSupply Highest pool `totalSupply()` the caller accepts. A mint landing first
     * raises the supply above the pin and reverts the call, so a zero-capital sandwich cannot join
     * to divert part of the lift the donation gives the active float; the pin bounds who may
     * join, not who already holds shares.
     * @param deadline Latest timestamp at which the donation may execute, UNIX seconds.
     */
    function donate(
        address tokenA,
        address tokenB,
        uint32 poolIndex,
        uint256 shares,
        uint256 maxSupply,
        uint256 deadline
    ) external;

    // =====================================================================
    // Zap entrypoints
    // =====================================================================

    /**
     * @notice Mint LP from a single token: pull `params.amountIn` of `tokenIn`, swap the
     * constant-product zap split to `tokenOut`, mint to `params.recipient` and refund both
     * residuals to the caller.
     * @dev A WETH9 `tokenIn` can be funded with attached native ETH: exactly `amountIn` is wrapped
     * when the attached value covers it, a smaller attachment falls back to pulling the full
     * amount as ERC20, and value attached to a non-WETH9 call is not consumed. In every case the
     * remainder stays on the router as a permissionless balance, so any batch that may leave
     * value behind ends with {refundETH}. `amountIn == 0` is the CONTRACT_BALANCE sentinel: the
     * zap consumes the router's whole `tokenIn` balance instead of pulling from the caller
     * (reverts `ZeroAmount` when that balance is zero); chain it after an {exactInput} with
     * `recipient == address(0)` to zap in from any token via a multi-hop route. Reverts
     * `ZeroAddress` on a zero recipient, `IdenticalTokens` when `tokenIn == tokenOut`,
     * `SlippageExceeded` below `minLiquidity` and `DeadlineExpired` past `deadline`.
     * @param params Zap parameters; see {ZapInSingleSidedParams}.
     * @return liquidity LP shares minted to `params.recipient`.
     */
    function zapInSingleSided(
        ZapInSingleSidedParams calldata params
    ) external payable returns (uint256 liquidity);

    /**
     * @notice Mint LP from any `(amountA, amountB)` ratio, one side possibly zero: one internal
     * swap rebalances the deposit toward the pool ratio before minting, and both residuals are
     * refunded to the caller.
     * @dev A WETH9 side can be funded with attached native ETH under the same wrap and remainder
     * rules as {zapInSingleSided} (end the batch with {refundETH} whenever over-attachment is
     * possible). There is no CONTRACT_BALANCE sentinel: a zero side means nothing on that side.
     * Reverts `ZeroAmount` when both sides are zero or when the rebalanced deposit leaves a side
     * at zero, `ZeroAddress` on a zero recipient, `IdenticalTokens` when `tokenA == tokenB`,
     * `SlippageExceeded` below `minLiquidity` and `DeadlineExpired` past `deadline`.
     * @param params Zap parameters; see {ZapInImbalancedParams}.
     * @return liquidity LP shares minted to `params.recipient`.
     */
    function zapInImbalanced(
        ZapInImbalancedParams calldata params
    ) external payable returns (uint256 liquidity);

    /**
     * @notice Burn `params.liquidity` LP shares, swap the off-side leg into `params.tokenOut` and
     * pay the combined amount to `params.recipient`.
     * @dev Requires an LP-token approval to this router ({selfPermitIfNecessary} chains it).
     * `recipient == address(0)` keeps the output on the router for {unwrapWETH9} / {sweepToken}
     * chaining. Reverts `ZeroAmount` on zero liquidity, `IdenticalTokens` when `tokenA == tokenB`,
     * `UnsupportedToken` when `tokenOut` is not a pair token, `InsufficientOutputAmount` below
     * `minAmountOut` and `DeadlineExpired` past `deadline`.
     * @param params Zap parameters; see {ZapOutSingleSidedParams}.
     * @return amountOut Total paid in `tokenOut`, raw units.
     */
    function zapOutSingleSided(
        ZapOutSingleSidedParams calldata params
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Quote {zapInSingleSided} off-chain: the swap leg reuses `pool.quoteExactIn` and the
     * mint projection runs against the post-swap reserves net of the protocol fee cut, so a zap
     * executed from the same pre-state on an unpaused pool mints exactly `liquidity`.
     * @dev Point-in-time: any intervening swap or liquidity action invalidates the quote, so
     * callers apply their own margin to `minLiquidity`. `amountIn == 0` returns `(0, 0)`; the
     * zap's CONTRACT_BALANCE sentinel is not modelled, so pass the staged amount the zap will
     * consume. A dust `amountIn` whose swap split floors to zero returns `(0, 0)` (execution
     * reverts `ZeroAmount` there); one whose split quotes a zero swap output reverts
     * `AmountTooSmallAfterNormalization`, as does a deposit leg that rounds to zero under the
     * pool's proportional cap, mirroring the executed zap's own reverts. Reverts `IdenticalTokens`
     * when `tokenIn == tokenOut`.
     * @param tokenIn Deposited token.
     * @param tokenOut The other pair token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param amountIn Raw `tokenIn` deposit.
     * @return liquidity LP shares the zap would mint.
     * @return swapAmount Part of `amountIn` the zap would swap into `tokenOut`, raw units.
     */
    function previewZapIn(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn
    ) external view returns (uint256 liquidity, uint256 swapAmount);

    /**
     * @notice Quote {zapOutSingleSided} off-chain: the off-side swap is quoted against the
     * post-burn reserves with the pool's own kernel, rounding and guards, so a zap executed from
     * the same pre-state on an unpaused pool pays exactly this amount.
     * @dev Point-in-time: any intervening swap or liquidity action invalidates the quote, so
     * callers apply their own margin to `minAmountOut`. Unexecutable dust exits revert here with
     * the execution path's error. A burn at or above the active supply reverts `InsufficientLiquidity`.
     * `liquidity == 0` returns `0` as a quote convention while
     * execution rejects a zero burn with `ZeroAmount`. Reverts `IdenticalTokens` when
     * `tokenA == tokenB` and `UnsupportedToken` when `tokenOut` is not a pair token.
     * @param tokenA One pair token (either order).
     * @param tokenB The other pair token.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param liquidity LP shares the zap would burn.
     * @param tokenOut Pair token to receive.
     * @return amountOut Total the zap would pay in `tokenOut`, raw units.
     */
    function previewZapOut(
        address tokenA,
        address tokenB,
        uint32 poolIndex,
        uint256 liquidity,
        address tokenOut
    ) external view returns (uint256 amountOut);

    // =====================================================================
    // Periphery payments (ETH / WETH helpers)
    // =====================================================================

    /**
     * @notice Unwrap the router's entire WETH9 balance and forward the ETH to `recipient`.
     * @dev Batched through {multicall} after a leg that staged output on the router
     * (`recipient == address(0)`). Reverts `InsufficientWETH9` when the balance is below
     * `amountMinimum`; a zero balance is a no-op.
     * @param amountMinimum Lower bound the router's WETH9 balance must clear, raw units.
     * @param recipient Receiver of the unwrapped ETH.
     */
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;

    /**
     * @notice Transfer the router's entire balance of `token` to `recipient`.
     * @dev Batched through {multicall} after a leg that staged output on the router. Reverts
     * `InsufficientToken` when the balance is below `amountMinimum`; a zero balance is a no-op.
     * @param token ERC20 token to sweep.
     * @param amountMinimum Lower bound the router's balance must clear, raw units.
     * @param recipient Receiver of the tokens.
     */
    function sweepToken(address token, uint256 amountMinimum, address recipient) external payable;

    /**
     * @notice Refund the router's entire ETH balance to `msg.sender`.
     * @dev Typically the last call of a {multicall} batch whose attached value exceeded what its
     * WETH9 legs wrapped; a zero balance is a no-op.
     */
    function refundETH() external payable;

    // =====================================================================
    // Immutable state (for integrations)
    // =====================================================================

    /**
     * @notice Canonical wrapped-native token (WETH9 family) used for native ETH legs.
     * @return The WETH9 contract address.
     */
    function WETH9() external view returns (address);

    /**
     * @notice Factory whose pools this router serves; pool addresses are CREATE2-derived from it.
     * @return The factory contract address.
     */
    function factory() external view returns (address);

    /**
     * @notice Search the gross `amountIn` that moves the pool's marginal price toward
     * `sqrtPriceTargetX96` without crossing it, and quote its output.
     * @dev Intended for `eth_call`: the search invokes the pool's swap solver repeatedly and is
     * too gas-heavy for on-chain use. A positive result has a checked post-swap price strictly on
     * the non-crossing side of the target, evaluated at the current anchor before any auto-repeg;
     * the result is the best checked non-crossing candidate encountered, or `(0, 0, false)` when
     * none exists. Every probe calls the pool's checked `quoteExactIn` (common output margin and
     * strict LP guard included) and evaluates the post-swap price on native settled reserves after
     * the protocol cut; the returned output must not be adjusted. Probes reverting
     * `SolverDidNotConverge`, `LpValueDecreased`, `InsufficientLiquidity` or `MathOutOfRange`
     * narrow the search toward smaller inputs (a refusal is a ceiling, not evidence of crossing);
     * dust probes (`AmountTooSmallAfterNormalization` or a zero quote) push it toward larger
     * inputs; other errors propagate. At most 12 expansion probes (the initial probe plus up to 11
     * doublings) and 50 refinements run, with the input capped at ~99% of the input-side reserve.
     * The search aims for the tolerance `max(pTarget / 1e8, pTarget · protocolFeePercent / 1e6,
     * 1)` on the math-space price but is best-effort: a refused probe, the cap or native rounding
     * may stop it short of a reachable target, and a target needing more input than the cap
     * returns the capped sweep in the same tuple shape without a reached flag, so an `amountIn`
     * at the cap is inconclusive. No maximal-fill guarantee is made. `(0, 0, false)` means no
     * admissible candidate was found, not that none exists; a zero target, a target not strictly
     * beyond the start price in the swap direction, and a degenerate pool (zero reserve, zero
     * price scale, target decoding to zero) return it too. Every target in
     * `[MIN_SQRT_RATIO, MAX_SQRT_RATIO)` decodes; the endpoints saturate to the extreme
     * representable prices, so naming one as a sweep bound quotes the capped sweep in that
     * direction and `(0, 0, false)` in the other. `crossesAnchor` describes the requested target
     * relative to the start price, not the possibly capped result. Quotes assume unchanged state.
     * Exotic decimal scales or probe sizes beyond available liquidity can still revert with math
     * errors instead of returning zeros; wrap the call in try/catch for a total function. Reverts
     * `IdenticalTokens` when `tokenIn == tokenOut`; a missing pool reverts when its state is read.
     * @param tokenIn Input token; the swap direction follows canonical token order.
     * @param tokenOut Output token, distinct from `tokenIn`.
     * @param poolIndex Pair-local index of the pool under the factory.
     * @param sqrtPriceTargetX96 Target `sqrt(token1 raw / token0 raw) · 2^96` in canonical token
     * order for both directions, never in `tokenOut / tokenIn` order.
     * @return amountIn Gross input in raw `tokenIn` units, or zero.
     * @return amountOut Checked output of `amountIn` in raw `tokenOut` units, or zero.
     * @return crossesAnchor Whether the start price and the requested target lie on opposite sides
     * of the pool's anchor price.
     */
    function quoteSwapToPrice(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint160 sqrtPriceTargetX96
    ) external view returns (uint256 amountIn, uint256 amountOut, bool crossesAnchor);
}
