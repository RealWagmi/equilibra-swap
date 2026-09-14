// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Constants
 * @notice Shared protocol constants of the Equilibra contracts.
 */
library Constants {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /**
     * @dev `WAD * WAD * 2^96` (about 7.92e64, below 2^215), so the sqrtPriceX96 to math-space
     * marginal-price conversion assembles `pMargWad = num / priceQ96` with a single division.
     */
    uint256 internal constant WAD_SQ_X96 = WAD * WAD * (1 << 96);

    // ============ Fee and oracle parameter bounds ============

    /**
     * @dev Base-fee range in bps. Every positive-fee pool is deployable down to one basis point;
     * the floor, ceiling and ramp checks keep the dynamic-fee configuration coherent.
     */
    uint16 internal constant MIN_BASE_FEE = 1; // 0.01%
    uint16 internal constant MAX_BASE_FEE = 2_000; // 20%
    /**
     * @dev Upper bound on the protocol's share of each swap fee, in percent of the fee, not bps
     * of the swap amount. With `repegShareBps + protocolFeePercent * 100 <= BPS` enforced by the
     * factory, the cap leaves at least 75% of every fee to the LP/repeg split.
     */
    uint8 internal constant MAX_PROTOCOL_FEE = 25; // 25% of swap fee
    /**
     * @dev EMA period bounds in seconds. The factory bounds the user-facing half-life from below
     * (600 s public, 60 s private) and the stored relaxation time
     * `tau = ceil(halfLife * 1000 / 694)` from above with `MAX_EMA_PERIOD`, so the largest
     * accepted half-life is 419731 s (about 4.86 days).
     */
    uint32 internal constant MIN_EMA_PERIOD = 60; // seconds
    uint32 internal constant MIN_PUBLIC_EMA_PERIOD = 600; // seconds
    uint32 internal constant MAX_EMA_PERIOD = 7 days;

    /**
     * @dev Open genesis-anchor bounds of public pools (token0 per token1, WAD). Private pools
     * keep only the numeric-domain checks.
     */
    uint256 internal constant MIN_PUBLIC_INITIAL_PRICE_SCALE_WAD = 1_000_000;
    uint256 internal constant MAX_PUBLIC_INITIAL_PRICE_SCALE_WAD = 1e30;

    // ============ Dynamic fee (smoothstep ramp) ============

    /**
     * @dev Upper bound of the warm-up width `feeRampBps`, read as a fraction of WAD
     * (10000 bps = 1.0 WAD = one state-distance unit); above it the smoothstep is effectively
     * flat over the admissible swap range. A live ramp charges at least one basis point at its
     * floor; flat-fee pools ignore the floor.
     */
    uint16 internal constant MAX_FEE_RAMP_BPS = 10_000; // 100%

    /**
     * @dev Monotonicity guard of a live ramp:
     * `feeRampBps * (BPS - baseFee)^2 >= FEE_RAMP_GUARD_MULT * BPS * (baseFee - feeFloorBps)^2`.
     * The fee is a terminal rate on the whole notional, so on a narrower ramp the rate climbs
     * faster than the input grows (`d(g * f(g)) / dg > 1`) and a larger exact-in trade returns
     * less output. The monotone condition `g * f' <= 1 - f` leaves less headroom at higher fee
     * levels, hence the `(BPS - baseFee)^2` factor. The tight multiplier is 256/27 (about 9.5);
     * 12 rounds it up conservatively.
     */
    uint256 internal constant FEE_RAMP_GUARD_MULT = 12;

    // ============ Repeg profit share ============

    /**
     * @dev `repegShareBps` is the fraction of cumulative LP unit-value growth the auto-repeg gate
     * may spend on anchor moves; the rest stays with LPs through the gate threshold
     * `genesis + growth * (BPS - repegShareBps) / BPS`. `0` keeps the gate shut (auto-repeg
     * disabled), `5000` splits growth evenly, `10000` lets the gate spend all growth. The factory
     * enforces `repegShareBps + protocolFeePercent * 100 <= BPS` to keep the LP residual
     * non-negative.
     */
    uint16 internal constant MAX_REPEG_SHARE_BPS = 10_000; // == BPS
    uint16 internal constant DEFAULT_REPEG_SHARE_BPS = 5_000; // 50/50 split

    // ============ Repeg gas guard ============

    /**
     * @dev Minimum LP unit-value headroom above the gate threshold before `_tryAutoRepeg` may
     * commit, in absolute vp units: `vpBefore > threshold + REPEG_GAS_GUARD_WAD`. Accepted genesis
     * values satisfy `|vpGenesis - 2 * WAD| <= MAX_GENESIS_VP_ERROR_WAD`, so 4e10 is about 2e-8 of
     * every accepted unit value, far below one basis point. Any change to the genesis normaliser,
     * supply seeding or tolerance must re-derive this constant.
     */
    uint256 internal constant REPEG_GAS_GUARD_WAD = 4e10;

    // ============ Curve parameters (a, lambda) ============

    /**
     * @dev Kernel `K(x, y; L) = A * L * (x + y) / 2 + (W - A) * x * y` with
     * `A = a * W / (W + lambda * D)`, `D = (y - x)^2 / (x * y)` and `W = WAD`. `a` sets the
     * depth at the anchor (`A = a` at `D = 0`) and `lambda` the plateau width (`A = a / 2` at
     * `lambda * D = W`); the two knobs are independent. The alpha domain is `0 < a < WAD`: at
     * `a == WAD` the centre has zero price slope and above it the CP weight turns negative.
     * `WAD - 1` is the largest integer in the open interval. Near the ceiling integer
     * conditioning is limited, so the bounded solver and the strict LP guard may still reject a
     * swap; the bound does not guarantee that every amount or state is quotable.
     */
    uint256 internal constant A_MIN_WAD = 1e17; // 0.1 · WAD  (CP-leaning floor)
    uint256 internal constant A_MAX_WAD = WAD - 1;

    /**
     * @dev Lambda envelope. The amplification halves at math-space distance `D = W / lambda`, so
     * `[1e12, 1e18]` covers half-A distances `D` in `[W, 1e6 * W]`; the lower end permits wider
     * plateaus. Near `A_MAX_WAD` even substantial inputs on moderately imbalanced pools can fail
     * solver certification, and a refused amount does not imply that larger amounts are
     * unquotable.
     */
    uint256 internal constant LAMBDA_MIN_WAD = 1e12; // wide plateau
    uint256 internal constant LAMBDA_MAX_WAD = 1e18; // narrow plateau

    // ============ Repeg step ============

    /**
     * @dev Bounds and default of the per-repeg log-domain step cap, WAD.
     */
    uint256 internal constant MIN_REPEG_STEP = 1; // 1 wei (≈0%)
    uint256 internal constant MAX_REPEG_STEP = WAD; // 100%
    uint256 internal constant DEFAULT_REPEG_STEP_WAD = 1e15; // 0.1% per update

    /**
     * @dev Damping of the auto-repeg move on top of the configured cap:
     * `appliedStepWad = min(repegStepWad, deviationWad / REPEG_DAMPING_DIVISOR)` and
     * `priceScaleNew = mulWad(priceScale, expWad(±appliedStepWad))`, clamped to the EMA.
     */
    uint256 internal constant REPEG_DAMPING_DIVISOR = 5;

    /**
     * @dev Halving ladder of the auto-repeg step. When the post-move probe (`vpAfter < threshold`)
     * refuses a rung, `_tryAutoRepeg` retries with the applied step halved, up to this many
     * times, then skips; every attempt starts fresh from `deviation / REPEG_DAMPING_DIVISOR`.
     * The coarse rungs keep a budget cushion: a finer ladder scrapes the budget to the floor and
     * lengthens stalls.
     */
    uint256 internal constant MAX_REPEG_STEP_HALVINGS = 3;

    /**
     * @dev Dust floor (raw LP shares) of the donation parachute: a pool-held LP balance at or
     * below it counts as an empty buffer, so a wei-scale transfer to the pool address cannot
     * trigger the parachute's probe work. 1e12 raw shares is 1e-6 of one WAD LP unit.
     */
    uint256 internal constant REPEG_DONATION_DUST_SHARES = 1e12;

    /**
     * @dev Default donation-parachute multiplier K every pool starts with. K is not a creation
     * parameter; the per-pool stored `uint8` is adjustable through the param timelock within
     * `[1, 255]` (zero would drop the lag qualifier and turn the parachute into a continuous
     * top-up). The parachute burns donated shares only when the geometric EMA/priceScale
     * deviation reaches `K * active dead-band` and no ladder rung committed. With the bundled
     * bands (2.5e15 / 1.5e15) it opens at 7.5% / 4.5% anchor lag; a pegged pool with 1e14 bands
     * opens at 0.3%.
     */
    uint256 internal constant REPEG_PARACHUTE_BAND_MULT = 30;

    /**
     * @dev Dead-shares burn floor, the WAD-scaled geometric mean of the seeded reserves. It is an
     * LP-supply floor, not a kernel-precision guarantee: the genesis `nWad = xWad^2 / WAD` depends
     * on the base-side reserve, so genesis precision is enforced by `MAX_GENESIS_VP_ERROR_WAD`.
     */
    uint256 internal constant MIN_INITIAL_LIQUIDITY = 1_000_000;

    /**
     * @dev Maximum tolerated deviation of the genesis LP unit value from its exact identity
     * `2 * WAD`; only integer rounding perturbs it. A seed too small for the kernel to resolve,
     * or a reserve ratio the WAD anchor cannot represent accurately, stores an understated value
     * and reverts `GenesisVpImprecise`; proportional seed growth fixes the former only. The
     * tolerance equals the repeg guard on purpose: accepted rounding can never manufacture more
     * than one guard of unbooked headroom.
     */
    uint256 internal constant MAX_GENESIS_VP_ERROR_WAD = REPEG_GAS_GUARD_WAD;

    uint8 internal constant MAX_TOKEN_DECIMALS = 18;

    // ============ EMA oracle protection ============

    /**
     * @dev Symmetric spot cap: spot is clamped to
     * `[priceScale / EMA_PRICE_CAP_DIV, priceScale * EMA_PRICE_CAP_MUL]` before it enters the EMA,
     * bounding how far one trade can drag the oracle. The repeg cadence gate (at most one commit
     * per block and never more than one per second) and the geometric activation dead-bands then
     * bound the anchor to one `repegStepWad` per commit.
     */
    uint256 internal constant EMA_PRICE_CAP_MUL = 2; // priceScale * 2 upper bound
    uint256 internal constant EMA_PRICE_CAP_DIV = 2; // priceScale / 2 lower bound

    // ============ External integration (Q64.96 projection) ============

    /**
     * @dev Canonical Uniswap V3 sqrt-ratio domain. The oracle view clamps `sqrtPriceX96` into
     * `[MIN_SQRT_RATIO, MAX_SQRT_RATIO - 1]` so TickMath-style consumers never receive a value
     * that makes `getTickAtSqrtRatio` revert; saturation at a bound marks an extreme state.
     */
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;
}
