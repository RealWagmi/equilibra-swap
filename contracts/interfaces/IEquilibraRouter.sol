// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IMulticall } from "./IMulticall.sol";

/// @title IEquilibraRouter
/// @notice User-facing swap and liquidity router for callback-based Equilibra pools.
/// @dev All swap endpoints are `payable` to enable native ETH flows via the
///      integrated WETH9 wrapper (see `PeripheryPayments`-style helpers
///      below) and to support batching via {IMulticall}.
interface IEquilibraRouter is IMulticall {
    // =====================================================================
    // Swap structs
    // =====================================================================

    /// @dev `amountIn == type(uint256).max` is the CONTRACT_BALANCE
    ///      sentinel on every exact-input entrypoint (single- and
    ///      multi-hop): the leg consumes the router's ENTIRE live
    ///      balance of its input token — regardless of provenance —
    ///      and pays from it. Chain it in a {multicall} after legs
    ///      that staged output on the router
    ///      (`recipient = address(0)`), closing with `sweepToken` /
    ///      `unwrapWETH9`. Stage and consume atomically: a balance
    ///      funded ahead of time is included but equally sweepable by
    ///      anyone, so never pre-fund in a separate transaction. For a
    ///      WETH9 leg only the existing WETH balance counts — the
    ///      sentinel wraps no attached native value (chain `refundETH`
    ///      for leftovers). Any other value >= 2^255 reverts in the
    ///      checked int256 cast, so the sentinel cannot shadow a real
    ///      amount.
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint32 poolIndex;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint256 deadline;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint32 poolIndex;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint256 deadline;
    }

    /// @dev `amountIn` accepts the CONTRACT_BALANCE sentinel — see
    ///      {ExactInputSingleParams}; the balance read is of the PATH's
    ///      first token.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint256 deadline;
    }

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint256 deadline;
    }

    /// @notice Parameters for {addLiquidity}. Tokens may be supplied in
    ///         any order; the router internally sorts `(tokenA, tokenB)`
    ///         and `(amountADesired, amountBDesired)` in lockstep so the
    ///         pool always receives them in its canonical
    ///         `token0 < token1` order.
    struct AddLiquidityParams {
        address tokenA;
        address tokenB;
        uint32 poolIndex;
        address recipient;
        uint256 amountADesired;
        uint256 amountBDesired;
        uint256 minShares;
        uint256 deadline;
    }

    /// @notice Parameters for {zapInSingleSided}. Caller deposits a single
    ///         token; the router swaps half (via the CP-zap heuristic)
    ///         to the other side and mints LP from the rebalanced pair.
    struct ZapInSingleSidedParams {
        address tokenIn;
        address tokenOut;
        uint32 poolIndex;
        address recipient;
        uint256 amountIn;
        uint256 minLiquidity;
        uint256 deadline;
    }

    /// @notice Parameters for {zapInImbalanced}. Caller deposits both
    ///         tokens at any ratio (one side may be zero). The router
    ///         performs a single internal swap to rebalance the deposit
    ///         to the pool's current price and then mints LP.
    struct ZapInImbalancedParams {
        address tokenA;
        address tokenB;
        uint32 poolIndex;
        address recipient;
        uint256 amountA;
        uint256 amountB;
        uint256 minLiquidity;
        uint256 deadline;
    }

    /// @notice Parameters for {zapOutSingleSided}. Caller burns LP, then
    ///         the router swaps the off-side token into `tokenOut` for a
    ///         single-asset withdrawal.
    struct ZapOutSingleSidedParams {
        address tokenA;
        address tokenB;
        uint32 poolIndex;
        address tokenOut;
        address recipient;
        uint256 liquidity;
        uint256 minAmountOut;
        uint256 deadline;
    }

    /// @notice Parameters for {removeLiquidity}. Burns `shares` of the
    ///         `(tokenA, tokenB, poolIndex)` pool's LP and forwards both
    ///         underlying legs to `recipient`.
    /// @dev `recipient == address(0)` keeps both outputs in the router
    ///      so the caller can chain {unwrapWETH9} / {sweepToken} through
    ///      {multicall} (single-transaction native-ETH withdrawal).
    ///      Requires an LP-token approval to this router — chain
    ///      {selfPermitIfNecessary} in the same batch to sign it in the
    ///      same transaction.
    struct RemoveLiquidityParams {
        address tokenA;
        address tokenB;
        uint32 poolIndex;
        uint256 shares;
        uint256 amountAMin;
        uint256 amountBMin;
        address recipient;
        uint256 deadline;
    }

    // =====================================================================
    // Self-permit (EIP-2612 forwarding)
    // =====================================================================

    /// @notice Forward an EIP-2612 signature to `token`, approving THIS
    ///         router as the spender of `msg.sender`'s balance.
    /// @dev Exists so a signature and the action it authorises fit in one
    ///      transaction: {multicall} `delegatecall`s only back into this
    ///      router, so an external `token.permit(...)` can never be a
    ///      batch element — this forwarder is what makes
    ///      `[selfPermit, removeLiquidity]` (or `donate`, or a zap that
    ///      pulls LP) atomic. Payable so it composes inside a batch that
    ///      carries native value.
    ///
    ///      Prefer {selfPermitIfNecessary} for user-facing flows: a bare
    ///      `selfPermit` reverts if the signature was already consumed
    ///      (anyone can extract it from the mempool and submit it
    ///      standalone), which would fail the whole batch.
    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable;

    /// @notice {selfPermit} that no-ops when the router already holds a
    ///         sufficient allowance, so a front-run (already-consumed)
    ///         signature cannot fail the batch.
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

    /// @notice Swaps `amountIn` of one token for as much of another as possible (single pool).
    /// @dev If `params.recipient == address(0)`, the tokens are held by the
    ///      router so the caller can chain with {sweepToken}/{unwrapWETH9}
    ///      through {multicall}.
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut);

    /// @notice Swaps as little of one token as possible for `amountOut` of another (single pool).
    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable returns (uint256 amountIn);

    /// @notice Swaps `amountIn` of the first token in a path for as much of the last token as possible.
    function exactInput(
        ExactInputParams calldata params
    ) external payable returns (uint256 amountOut);

    /// @notice Swaps as little of the first token as possible for `amountOut` of the last token.
    function exactOutput(
        ExactOutputParams calldata params
    ) external payable returns (uint256 amountIn);

    // =====================================================================
    // Liquidity entrypoints
    // =====================================================================

    /// @notice Add proportional liquidity. Pulls at most the desired
    ///         amounts from the caller (the pool's proportional cap may
    ///         use less on one side).
    /// @dev Payable: a WETH9 leg can be funded with attached native ETH
    ///      — the mint callback wraps exactly the used amount. The
    ///      proportional cap makes the used amount unknowable upfront,
    ///      so callers attaching ETH must chain {refundETH} through
    ///      {multicall} to reclaim the unused remainder (the router's
    ///      payment helpers are permissionless — never leave value
    ///      behind after the transaction).
    function addLiquidity(
        AddLiquidityParams calldata params
    ) external payable returns (uint256 sharesOut);

    /// @notice Burn LP shares and withdraw both underlying legs.
    /// @dev See {RemoveLiquidityParams} for the `recipient == address(0)`
    ///      staging convention (native-ETH withdrawal via {unwrapWETH9}).
    /// @return amountA Amount paid out in `tokenA` (caller's order).
    /// @return amountB Amount paid out in `tokenB` (caller's order).
    function removeLiquidity(
        RemoveLiquidityParams calldata params
    ) external payable returns (uint256 amountA, uint256 amountB);

    /// @notice Donate LP shares of the `(tokenA, tokenB, poolIndex)` pool
    ///         into its donation buffer (parked on the pool's own address,
    ///         no claim on reserves, spendable only by the pool's donation
    ///         parachute). Irreversible. Requires an LP-token approval to
    ///         this router — chain {selfPermitIfNecessary} in the same
    ///         batch to sign it in the same transaction.
    /// @param tokenA    One pair token (either order).
    /// @param tokenB    The other pair token.
    /// @param poolIndex Pair-local pool index under the factory.
    /// @param shares    LP shares to park from the caller's balance.
    /// @param maxSupply Highest pool `totalSupply()` the caller accepts;
    ///        above it the call reverts, so a mint cannot front-run the
    ///        donation and divert part of the lift it gives the active
    ///        float.
    /// @param deadline  Latest timestamp at which the donation may execute.
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

    /// @notice Mint LP from a single token. Pulls `params.amountIn` of
    ///         `tokenIn` from the caller, swaps the CP-zap optimal
    ///         fraction to `tokenOut`, mints LP to `params.recipient`,
    ///         refunds any dust.
    /// @dev Payable: a WETH9 `tokenIn` can be funded with attached
    ///      native ETH — EXACTLY `amountIn` is wrapped. Attaching more
    ///      (or attaching less than `amountIn`, which falls back to
    ///      pulling the full amount as ERC20) leaves the remainder as a
    ///      permissionless native balance on the router; value attached
    ///      to a call whose `tokenIn` is not WETH9 is not consumed at
    ///      all. Any batch that may leave native value behind MUST end
    ///      with {refundETH}.
    ///      `amountIn == 0` is the CONTRACT_BALANCE sentinel: the zap
    ///      consumes the router's whole `tokenIn` balance instead of
    ///      pulling from the caller — chain it after an {exactInput}
    ///      with `recipient == address(0)` in one {multicall} to zap in
    ///      from any token via a multi-hop route.
    /// @return liquidity LP shares minted; reverts with `SlippageExceeded`
    ///         if below `params.minLiquidity`.
    function zapInSingleSided(
        ZapInSingleSidedParams calldata params
    ) external payable returns (uint256 liquidity);

    /// @notice Mint LP from arbitrary `(amountA, amountB)` ratios. One
    ///         side may be zero. Internally rebalances via a single
    ///         swap before minting.
    /// @dev Payable: a WETH9 side can be funded with attached native
    ///      ETH — exactly that side's amount is wrapped, with the same
    ///      remainder rules as {zapInSingleSided} (end the batch with
    ///      {refundETH} whenever over-attachment is possible). No
    ///      CONTRACT_BALANCE sentinel here — a zero side legitimately
    ///      means "nothing on this side".
    function zapInImbalanced(
        ZapInImbalancedParams calldata params
    ) external payable returns (uint256 liquidity);

    /// @notice Burn LP and withdraw as a single token. Burns
    ///         `params.liquidity` LP, swaps the off-side token into
    ///         `params.tokenOut`, transfers the combined amount to
    ///         `params.recipient`.
    /// @dev `recipient == address(0)` keeps the output in the router so
    ///      the caller can chain {unwrapWETH9} through {multicall}
    ///      (single-transaction native-ETH withdrawal).
    function zapOutSingleSided(
        ZapOutSingleSidedParams calldata params
    ) external payable returns (uint256 amountOut);

    /// @notice Off-chain quote of {zapInSingleSided} outputs. The swap
    ///         leg reuses `pool.quoteExactIn`; the mint projection runs
    ///         against the post-swap reserves net of the protocol fee
    ///         cut — executed from the SAME pre-state on an unpaused
    ///         pool, the zap mints exactly `liquidity`. The quote is
    ///         point-in-time: any intervening swap or liquidity action
    ///         invalidates it, so production callers should apply their
    ///         own slippage margin to `minLiquidity` rather than pass
    ///         the raw quote. `amountIn = 0` returns `(0, 0)` — the
    ///         zap's CONTRACT_BALANCE sentinel is not modelled here;
    ///         pass the staged amount the zap will actually consume.
    ///         A dust `amountIn` whose swap split floors to zero
    ///         returns `(0, 0)`; one whose split quotes a zero swap
    ///         output reverts `AmountTooSmallAfterNormalization` —
    ///         mirroring the executed zap's own dust revert.
    function previewZapIn(
        address tokenIn,
        address tokenOut,
        uint32 poolIndex,
        uint256 amountIn
    ) external view returns (uint256 liquidity, uint256 swapAmount);

    /// @notice Off-chain quote of {zapOutSingleSided} output. The
    ///         off-side swap is quoted against the post-burn reserves
    ///         with the pool's own kernel, rounding and guards —
    ///         executed from the SAME pre-state, the zap pays exactly
    ///         this amount on an unpaused pool, and unexecutable dust
    ///         exits revert here with the execution path's error. The
    ///         quote is point-in-time: any intervening swap or
    ///         liquidity action invalidates it, so production callers
    ///         should apply their own slippage margin to
    ///         `minAmountOut` rather than pass the raw quote.
    ///         `liquidity = 0` returns `0` as a quote convention;
    ///         execution rejects a zero burn with `ZeroAmount`.
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

    /// @notice Unwraps the router's balance of WETH9 and forwards it to `recipient`.
    /// @dev Expected to be batched via {multicall} right after a swap that
    ///      routed tokens back to the router (recipient=address(0)).
    /// @param amountMinimum Lower bound the router's WETH balance must clear.
    /// @param recipient     Address to forward the unwrapped ETH to.
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;

    /// @notice Transfers the router's entire balance of `token` to `recipient`.
    /// @dev Expected to be batched via {multicall} after a swap with
    ///      recipient=address(0), so the caller can atomically combine
    ///      swaps and withdrawals.
    /// @param token         ERC20 token to sweep.
    /// @param amountMinimum Lower bound the router's balance must clear.
    /// @param recipient     Address to forward the tokens to.
    function sweepToken(address token, uint256 amountMinimum, address recipient) external payable;

    /// @notice Refunds any leftover ETH held by the router to `msg.sender`.
    /// @dev Typically the last call in a {multicall} batch when the caller
    ///      overpaid the native-ETH value of a swap.
    function refundETH() external payable;

    // =====================================================================
    // Immutable state (for integrations)
    // =====================================================================

    /// @notice Address of the canonical wrapped-native token (WETH9 family).
    function WETH9() external view returns (address);

    /// @notice Address of the {EquilibraFactory} this router is bound to.
    function factory() external view returns (address);
}
