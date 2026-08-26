// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IEquilibraFactory
/// @notice Interface for the Equilibra pool factory
interface IEquilibraFactory {
    // ============ Events ============

    /// @notice Emitted once per pool deployment with a full snapshot of
    ///         the pool's identity + initial configuration.
    /// @dev    Indexed topics (`token0`, `token1`, `pool`) make subgraph
    ///         filters trivial. `creator` is the `msg.sender` that
    ///         invoked {createPoolAndAddLiquidity}; not indexed because
    ///         the event already saturates the 3-topic budget — for
    ///         creator-keyed enumeration use {getPoolsByCreator}.
    ///         Privacy is deliberately NOT part of this snapshot:
    ///         private pools emit the companion {PrivatePoolCreated} in
    ///         the same transaction, and {isPrivatePool} answers at any
    ///         later time.
    ///         `pairPoolIndex` is the per-pair index the factory
    ///         assigned to this clone; together with `(token0, token1)`
    ///         it's the only state needed to recompute the pool address
    ///         off-chain via {computePoolAddress}.
    ///         `poolCount = allPools.length` after the push.
    ///         `config` is the full per-pool configuration as accepted
    ///         by {createPoolAndAddLiquidity} (post-validation).
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        address indexed pool,
        address creator,
        uint32 pairPoolIndex,
        uint256 poolCount,
        PoolConfig config
    );
    event PoolWhitelistUpdated(
        address indexed token0,
        address indexed token1,
        address indexed pool,
        bool whitelisted
    );

    /// @notice A private pool was created: every mint into it must name
    ///         a recipient on the pool's LP allowlist.
    event PrivatePoolCreated(address indexed pool, address indexed admin);
    /// @notice The pool admin added or removed an account on a private
    ///         pool's LP allowlist. Distinct from {PoolWhitelistUpdated},
    ///         which is the OWNER-curated registry of featured pools.
    event PoolLpAllowlistUpdated(address indexed pool, address indexed account, bool allowed);

    event ProtocolFeeChanged(uint8 oldFee, uint8 newFee);
    event FeeCollectorChanged(address oldCollector, address newCollector);

    /// @notice Owner (re)bound or unbound the verified Boost wrapper of
    ///         a pool (`newBoost == address(0)` = unbound).
    event PoolBoostSet(address indexed pool, address oldBoost, address newBoost);

    // ============ Structs ============

    /// @notice Full per-pool configuration. All ranges below are
    ///         enforced by the factory at deploy time — out-of-range
    ///         values revert with the matching `Invalid*` error.
    /// @param aWad             Depth-at-anchor knob of the two-knob
    ///                         cubic invariant
    ///                         `K = A·L·(x+y)/2 + (W − A)·xy` with
    ///                         `A = a·W/(W + λ·D)`, WAD-scaled. Range
    ///                         `[A_MIN_WAD, A_MAX_WAD] = [0.1·W,
    ///                         0.99·W]`. Larger `aWad` deepens the
    ///                         plateau at the anchor; smaller `aWad`
    ///                         shallows it.
    /// @param lambdaWad        Plateau-width knob (WAD-scaled). Range
    ///                         `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
    ///                         Larger `lambdaWad` narrows the plateau
    ///                         (faster transition to CP tail); smaller
    ///                         `lambdaWad` widens it. Decoupled from
    ///                         `aWad` — moving one knob does not
    ///                         affect the other's effect.
    /// @param baseFee          Maximum swap fee in BPS — also the **flat
    ///                         fee** charged on every swap when
    ///                         `feeRampBps == 0` (explicit opt-out). Range
    ///                         `[MIN_BASE_FEE, MAX_BASE_FEE]`.
    /// @param emaPeriod        HALF-LIFE of the EMA oracle in seconds.
    ///                         The factory converts it once to the
    ///                         internal relaxation time
    ///                         `τ = ceil(emaPeriod · 1000 / 694)` used in
    ///                         `α_decay = exp(−Δt / τ)`; the pool's
    ///                         `getFeeConfig()` returns the half-life via
    ///                         the exact inverse `τ · 694 / 1000`. Input
    ///                         floor `MIN_EMA_PERIOD`; ceiling bounds the
    ///                         CONVERTED τ at `MAX_EMA_PERIOD`, so the
    ///                         maximum accepted half-life is
    ///                         `⌊MAX_EMA_PERIOD · 694 / 1000⌋ ≈ 4.86 d`.
    /// @param repegStepWad     **Maximum relative anchor move per repeg
    ///                         call**, WAD-scaled (1e15 ≈ 0.1 % of the
    ///                         anchor per step). The actual move is
    ///                         further capped by a damping rule
    ///                         (`deviation / REPEG_DAMPING_DIVISOR`),
    ///                         so the anchor asymptotically catches up
    ///                         to the EMA without overshooting. Range
    ///                         `[MIN_REPEG_STEP, MAX_REPEG_STEP]`.
    /// @param repegThresholdToken1UpWad **Activation dead-band, upward
    ///                         direction**: `_tryAutoRepeg`
    ///                         short-circuits while `ema > priceScale`
    ///                         (token1's price expressed in token0
    ///                         ABOVE the anchor) and the geometric
    ///                         deviation `|max(ema,anchor)/min(ema,
    ///                         anchor) − 1|` is below this band.
    ///                         Decoupled from `repegStepWad`: the
    ///                         threshold decides WHEN the anchor wakes,
    ///                         the step caps HOW FAR it moves per commit
    ///                         (`min(repegStepWad, deviation/5)`).
    ///                         Layout note: under the mainnet
    ///                         address-sort layout with the base asset
    ///                         in slot 0, a RISING base market is an
    ///                         internal token1-DOWN move — bull-market
    ///                         catch-up is tuned by the Down band.
    ///                         Subject to the stall guard
    ///                         `threshold ≤ feeScale · 1e14` whenever
    ///                         `repegShareBps != 0` (the first
    ///                         permitted move must be affordable out of
    ///                         the fee-funded growth budget). Range
    ///                         `[MIN_REPEG_STEP, MAX_REPEG_STEP]`.
    /// @param repegThresholdToken1DownWad **Activation dead-band,
    ///                         downward direction** (`ema <
    ///                         priceScale`). Same range and stall
    ///                         guard as the Up band. The split lets
    ///                         the deployer calibrate catch-up
    ///                         eagerness per direction explicitly
    ///                         (e.g. a momentum-style tilt) instead of
    ///                         inheriting an averaging artifact.
    /// @param feeRampBps       Smoothstep dynamic-fee warm-up width, in
    ///                         BPS of WAD. Range `[0, MAX_FEE_RAMP_BPS]`;
    ///                         `0` disables the ramp entirely (every
    ///                         swap pays exactly `baseFee`).
    /// @param feeFloorBps      Lower bound of the dynamic fee in BPS;
    ///                         paid by swaps that land near the anchor.
    ///                         The smoothstep climbs from `feeFloorBps`
    ///                         up to `baseFee` across the configured
    ///                         ramp. Must satisfy `feeFloorBps ≤ baseFee`
    ///                         (factory reverts with `InvalidFeeFloor`
    ///                         on `feeFloorBps > baseFee`). The equality
    ///                         `feeFloorBps == baseFee` is allowed
    ///                         **only** with `feeRampBps == 0` (flat-fee
    ///                         mode); pairing it with a non-zero ramp
    ///                         reverts with `FeeRampNoHeadroom` because
    ///                         the smoothstep would have nothing to
    ///                         interpolate into.
    /// @param repegShareBps    Fraction (in BPS of `BPS = 10_000`) of
    ///                         the **total** fee budget that
    ///                         `_tryAutoRepeg` is allowed to spend on
    ///                         anchor moves. The pool's threshold
    ///                         formula compensates for the protocol
    ///                         slice so this share is independent of
    ///                         `protocolFeePercent` — see
    ///                         `EquilibraPool._tryAutoRepeg`.
    ///                         `0` disables auto-repeg entirely;
    ///                         `5_000` (conservative reference,
    ///                         `DEFAULT_REPEG_SHARE_BPS`)
    ///                         is a 50/50 split; the upper bound is
    ///                         `min(MAX_REPEG_SHARE_BPS,
    ///                         BPS − protocolFeePercent · 100)` — the
    ///                         factory rejects configs that would leave
    ///                         a negative residual to LPs with
    ///                         `RepegShareExceedsBudget`.
    struct PoolConfig {
        uint64 aWad;
        uint64 lambdaWad;
        uint16 baseFee;
        uint32 emaPeriod;
        uint256 repegStepWad;
        uint256 repegThresholdToken1UpWad;
        uint256 repegThresholdToken1DownWad;
        uint16 feeRampBps;
        uint16 feeFloorBps;
        uint16 repegShareBps;
    }

    // ============ Pool Creation ============

    /// @notice Atomically create a new pool and seed its initial liquidity.
    /// @dev    The factory exposes pool creation **only** through this
    ///         atomic helper to prevent front-running of the initial
    ///         price (a third party seeding the empty pool first would
    ///         dictate the anchor and pocket the price-setting bonus).
    ///         Caller must approve both tokens to the factory beforehand.
    ///
    /// === Dynamic fee semantics ===
    /// The fee charged on every swap is resolved by a smoothstep ramp
    /// `m(r) = 2r − r²` evaluated at `r = distPostWad / feeRampWad`,
    /// where `distPostWad` is the post-swap state distance from the
    /// anchor and `feeRampWad = config.feeRampBps · 1e14`:
    ///
    ///   feeBps = config.feeFloorBps
    ///          + (config.baseFee − config.feeFloorBps) · m(r),
    ///          clamped into [config.feeFloorBps, config.baseFee]
    ///
    /// Behavioural rules enforced by the pool:
    ///   • `config.baseFee` is the **maximum** fee charged when the swap
    ///     leaves the pool at or beyond the configured ramp width.
    ///   • `config.feeFloorBps` is the **minimum** fee; mean-reverting
    ///     flow (a swap that lands close to the anchor) pays exactly
    ///     this floor. Any value in `[0, config.baseFee]` is accepted.
    ///   • The dynamic ramp is **disabled** — every swap simply pays
    ///     `config.baseFee` — when `config.feeRampBps == 0` (explicit
    ///     opt-out). Pairing a non-zero ramp with `baseFee ==
    ///     feeFloorBps` is rejected at deploy time with
    ///     `FeeRampNoHeadroom` rather than silently collapsing.
    ///
    /// === Cost model ===
    /// Both swap directions resolve the fee rate (a WAD fraction,
    /// `1 bps == 1e14`) against the same CP-projected post-state
    /// surface (`_resolveDynamicFeeWadFromCp`), and quote == swap holds
    /// bit-for-bit on each route. Exact-out charges the endpoint-max of
    /// that surface, ≥ the fee exact-in resolves at the settled gross —
    /// the conservatism is LP-favourable, so route choice never
    /// under-pays the pool. WAD-rate resolution keeps
    /// the gross → clean-input map monotone up to a dust residual on
    /// the order of `amountIn / 1e18` wei per rate step (one input wei
    /// can cross several WAD-quantized rate ulps at once).
    ///   • **Exact-in** is single-pass: the gross `amountIn` feeds the
    ///     CP predictor directly. The predictor sees gross rather than
    ///     post-fee `cleanIn`, which adds a small upward bias — but the
    ///     CP proxy itself can diverge from the true post-state distance
    ///     in either direction, so the net bias is NOT guaranteed to
    ///     favour LPs on large swaps. Enabling the ramp adds only a
    ///     handful of muls/divs on top of the flat-fee swap path.
    ///   • **Exact-out** resolves the fee non-iteratively as the max of
    ///     the CP-proxy fee at the two ends of the realisable gross
    ///     interval `[grossUp(clean, feeFloor), grossUp(clean, baseFee)]`
    ///     (the CP distance is quasi-convex in the gross, so a fixed
    ///     point can oscillate for anchor-crossing trades; a quasi-convex
    ///     function attains its interval max at an endpoint). This
    ///     guarantees `exactInput(quoteExactOut(out)) ≥ out`, at the cost
    ///     of quoting anchor-crossing exact-out trades conservatively —
    ///     over-charged by up to `baseFee − feeFloor`, always in the
    ///     LP-favourable direction.
    /// Pools that do not need the ramp should still opt out via
    /// `feeRampBps = 0` to skip the prediction entirely.
    ///
    /// === Sizing the ramp (`feeFloorBps = 20`, `baseFee = 100`) ===
    /// Resolved fee (in bps) for a few canonical anchor deviations and
    /// ramp widths. See `EquilibraSwapMath.smoothstepFeeWad` for the
    /// full derivation; this table is the operator-facing summary.
    ///
    ///   priceMove |  ramp=   10 |  ramp=  100 |  ramp= 1000 |  ramp=10000
    ///   (% anch)  |     feeBps  |     feeBps  |     feeBps  |     feeBps
    ///   ----------+-------------+-------------+-------------+-------------
    ///       1.00% |     35.06   |     21.58   |     20.16   |     20.02
    ///       2.00% |     70.44   |     26.15   |     20.63   |     20.06
    ///       5.00% |    100.00   |     53.56   |     23.76   |     20.38
    ///      10.00% |    100.00   |     99.34   |     33.88   |     21.45
    ///      20.00% |    100.00   |    100.00   |     64.44   |     25.24
    ///      50.00% |    100.00   |    100.00   |    100.00   |     44.44
    ///     100.00% |    100.00   |    100.00   |    100.00   |     80.00
    ///     162.00% |    100.00   |    100.00   |    100.00   |    100.00
    ///
    /// Reading the table:
    ///   • Each column is one `feeRampBps` setting; rows are the anchor
    ///     deviation produced by the swap.
    ///   • Pick a column by deciding "what deviation should saturate at
    ///     `baseFee`": narrow ramps (≤ 100 bps) are aggressive — even a
    ///     1-2% move pushes the fee close to the ceiling. Wide ramps
    ///     (≥ 1000 bps) behave as a soft floor where most realistic
    ///     swaps stay near `feeFloorBps`.
    ///   • Setting `feeRampBps = 10000` is NOT equivalent to "max fees"
    ///     — it is the widest possible smoothstep, so most swaps end up
    ///     paying close to `feeFloorBps`. To bias fees high, pick a
    ///     small `feeRampBps` (≤ 100) instead.
    ///   • The ramp cannot be arbitrarily narrow: `feeRampBps ·
    ///     (BPS − baseFee)² ≥ FEE_RAMP_GUARD_MULT · BPS · (baseFee −
    ///     feeFloorBps)²` is enforced (`FeeRampTooNarrow`), keeping the
    ///     gross → clean-input map monotone — on a steeper ramp the fee
    ///     on the whole notional could grow faster than the input
    ///     itself, and the headroom shrinks with the fee ceiling.
    ///
    /// @param tokenA    First token address (any order; the factory sorts
    ///                  the pair lexicographically before storing it as
    ///                  `pool.token0` / `pool.token1`).
    /// @param tokenB    Second token address (any order; paired with
    ///                  `amountB`, both repositioned in lockstep with
    ///                  the address sort).
    /// @param config    Full pool configuration: two-knob curve
    ///                  shape (`aWad` depth, `lambdaWad` width), fees,
    ///                  repeg knobs and ramp width. See `PoolConfig`
    ///                  for individual field semantics and enforced
    ///                  ranges.
    /// @param amountA   Initial amount of `tokenA` to seed. When native
    ///                  value is attached and `tokenA` is {WETH9}, this
    ///                  side is funded by the factory from the wrapped
    ///                  `msg.value` (see the native-value rules below).
    /// @param amountB   Initial amount of `tokenB` to seed (same
    ///                  native-value rule when `tokenB` is {WETH9}).
    /// @param recipient Address that receives the freshly minted LP shares.
    ///
    /// @dev **Native-value seeding.** Attaching `msg.value` funds the
    ///      {WETH9} side of the pair: the factory wraps the value and
    ///      pays that leg itself, so the seeder needs no WETH balance
    ///      or approval for it (the other leg is still pulled via its
    ///      ERC-20 approval). `msg.value` must equal that side's seed
    ///      amount EXACTLY — a genesis mint consumes the declared
    ///      amounts in full, so a legitimate excess cannot exist and
    ///      no refund path is provided. Reverts: `NoWethLeg` when
    ///      value is attached but neither token is {WETH9};
    ///      `NativeValueMismatch` when `msg.value` differs from the
    ///      WETH-side amount. `msg.value == 0` keeps the pure ERC-20
    ///      path for both legs, WETH9 included.
    /// @return pool      Address of the newly created pool.
    /// @return sharesOut Amount of LP shares minted to `recipient`. No
    ///                   slippage guard is exposed here: a genesis mint
    ///                   has no prior pool state to race against and
    ///                   the seeder controls both inputs **and** the
    ///                   initial price, so the share count is a
    ///                   deterministic function of `(amountA, amountB)`
    ///                   (`sqrt(xWad·yWad) − MIN_INITIAL_LIQUIDITY`).
    function createPoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient
    ) external payable returns (address pool, uint256 sharesOut);

    /// @notice {createPoolAndAddLiquidity} for a PRIVATE pool: every
    ///         later mint must name a recipient on the pool's LP
    ///         allowlist ({isLpAllowed}), curated by the pool admin
    ///         (the creator — see {paramTimelock}'s `poolAdmin`).
    /// @dev The creator and the genesis `recipient` are allowlisted by
    ///      this call, so the seeding mint and the admin's own later
    ///      mints need no extra step. Privacy is immutable for the
    ///      pool's lifetime. Private pools also run the parameter
    ///      timelock on the short delay (see
    ///      `EquilibraParamTimelock.PRIVATE_DELAY`): their LP set is
    ///      known and consented, so the public exit window is not the
    ///      protection it is for an open pool.
    ///      Scope: the allowlist gates MINTING. LP shares stay ERC20-
    ///      transferable, so an allowlisted LP can pass shares to an
    ///      outsider; the gate bounds who may join by depositing, not
    ///      who may hold.
    ///      Accepts native-value seeding under the exact rules of
    ///      {createPoolAndAddLiquidity}.
    function createPrivatePoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient
    ) external payable returns (address pool, uint256 sharesOut);

    /// @notice Canonical wrapped-native token used by native-value
    ///         seeding (immutable, set at construction — the same
    ///         chain config the router's WETH9 pins).
    function WETH9() external view returns (address);

    /// @notice Whether `pool` was created private (mint-gated).
    ///         Immutable per pool.
    function isPrivatePool(address pool) external view returns (bool);

    /// @notice Whether `account` may receive freshly minted LP of
    ///         `pool`. Always `true` for public pools — the pool only
    ///         consults this when its own privacy flag is set.
    function isLpAllowed(address pool, address account) external view returns (bool);

    /// @notice Every account explicitly on `pool`'s LP allowlist.
    ///         Unordered (removals swap-and-pop) and empty for public
    ///         pools — {isLpAllowed} is the policy answer, this view is
    ///         the raw membership list.
    function getLpAllowlist(address pool) external view returns (address[] memory);

    /// @notice Number of accounts on `pool`'s LP allowlist.
    function getLpAllowlistLength(address pool) external view returns (uint256);

    /// @notice Add or remove accounts on a private pool's LP allowlist.
    ///         Pool admin only (the creator, or whoever the two-step
    ///         handover on {paramTimelock} moved the role to).
    /// @dev Reverts `NotPrivatePool` for public pools — a public pool's
    ///      allowlist would be meaningless state, and silently writing
    ///      it would suggest a gate that does not exist.
    function setLpAllowed(address pool, address[] calldata accounts, bool allowed) external;

    // ============ View Functions ============

    /// @notice Get all pools for a token pair
    /// @dev Pair lookup is order-independent — the factory sorts
    ///      `(tokenA, tokenB)` internally before hashing the key.
    function getPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory);

    /// @notice Get a page of pools for a token pair
    /// @dev Pair lookup is order-independent.
    /// @param tokenA First token address (any order)
    /// @param tokenB Second token address (any order)
    /// @param offset Start index
    /// @param limit Max number of items to return
    /// @return page Pools in requested page
    /// @return remaining Number of pools remaining after this page
    function getPoolsByPairPage(
        address tokenA,
        address tokenB,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory page, uint256 remaining);

    /// @notice Get number of pools for a token pair
    /// @dev Pair lookup is order-independent.
    function getPoolCountForPair(address tokenA, address tokenB) external view returns (uint256);

    /// @notice Get pool for a token pair by index
    /// @dev Pair lookup is order-independent.
    function getPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool);

    /// @notice Get whitelisted pools for a token pair
    /// @dev Pair lookup is order-independent.
    function getWhitelistedPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory);

    /// @notice Get whitelisted pool count for a token pair
    /// @dev Pair lookup is order-independent.
    function getWhitelistedPoolCountForPair(
        address tokenA,
        address tokenB
    ) external view returns (uint256);

    /// @notice Get whitelisted pool for a token pair by index
    /// @dev Pair lookup is order-independent.
    function getWhitelistedPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool);

    /// @notice Bind or rebind the verified Boost wrapper of `pool`.
    ///         Owner-only curation: it does not gate Boost deployment —
    ///         it attests the canonical stack. The vault must wrap
    ///         exactly this pool (`BoostPoolMismatch` otherwise); the
    ///         pool must belong to this factory (`PoolNotFound`).
    function setPoolBoost(address pool, address boostVault) external;

    /// @notice Remove the verified Boost binding of `pool`
    ///         (`BoostNotBound` when there is none). Owner-only.
    function removePoolBoost(address pool) external;

    /// @notice Verified Boost share vault of `pool` (0 = none).
    function getPoolBoost(address pool) external view returns (address boostVault);

    /// @notice All pools with a verified Boost binding.
    function getBoostedPools() external view returns (address[] memory pools);

    /// @notice Count / indexed access over the boosted-pool set.
    function getBoostedPoolCount() external view returns (uint256 count);

    function getBoostedPoolAt(uint256 index) external view returns (address pool);

    /// @notice Check whether a pool is whitelisted for a token pair
    /// @dev Pair lookup is order-independent.
    function isPoolWhitelisted(
        address tokenA,
        address tokenB,
        address pool
    ) external view returns (bool);

    /// @notice Get all pools created by an address
    function getPoolsByCreator(address creator) external view returns (address[] memory);

    /// @notice Get number of pools created by an address
    function getPoolsByCreatorCount(address creator) external view returns (uint256);

    /// @notice Get pool at the **global** index across all pairs (in
    ///         deployment order). For per-pair indexing use
    ///         {getPoolAt}.
    function allPools(uint256 index) external view returns (address);

    /// @notice Total number of pools ever created by this factory
    ///         (across all pairs).
    function allPoolsLength() external view returns (uint256);

    /// @notice Compute the deterministic address of a pool without deploying.
    function computePoolAddress(
        address tokenA,
        address tokenB,
        uint32 pairPoolIndex
    ) external view returns (address);

    /// @notice Get pool implementation address used for cloning.
    function poolImplementation() external view returns (address);

    /// @notice Get current protocol fee percentage
    function protocolFee() external view returns (uint8);

    /// @notice Get fee collector address
    function feeCollector() external view returns (address);

    /// @notice Singleton param timelock: the only account allowed to
    ///         call the pools' runtime parameter setters.
    function paramTimelock() external view returns (address);

    /// @notice Get factory owner address
    function owner() external view returns (address);

    // ============ Admin Functions ============

    /// @notice Set protocol fee percentage (owner only)
    /// @param newFee New protocol fee (% of swap fee)
    function setProtocolFee(uint8 newFee) external;

    /// @notice Set fee collector address (owner only)
    /// @param newCollector New fee collector address
    function setFeeCollector(address newCollector) external;

    /// @notice Add a pool to whitelist for a token pair (owner only)
    /// @dev Pair lookup is order-independent.
    /// @param tokenA First token address (any order)
    /// @param tokenB Second token address (any order)
    /// @param pool Pool address to whitelist
    function addPoolToWhitelist(address tokenA, address tokenB, address pool) external;

    /// @notice Remove a pool from whitelist for a token pair (owner only)
    /// @dev Pair lookup is order-independent.
    /// @param tokenA First token address (any order)
    /// @param tokenB Second token address (any order)
    /// @param pool Pool address to remove from whitelist
    function removePoolFromWhitelist(address tokenA, address tokenB, address pool) external;
}
