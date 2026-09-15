// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IEquilibraFactory
 * @notice Deploys Equilibra pools as clones, seeds their genesis liquidity atomically and keeps
 * the pool registries: per-pair enumeration, the owner-curated whitelist, the private-pool LP
 * allowlists and the verified Boost bindings.
 * @dev Pair lookups are order-independent: `(tokenA, tokenB)` is sorted before it is hashed into
 * the pair key. Several pools may exist per pair; each is addressed by a pair-local index.
 */
interface IEquilibraFactory {
    // ============ Events ============

    /**
     * @notice Emitted once per pool deployment with the pool's identity and its validated
     * initial configuration.
     * @dev Privacy is not part of the snapshot: a private pool also emits {PrivatePoolCreated}
     * in the same transaction, and {isPrivatePool} answers at any later time.
     * @param token0 Lower-sorted token of the pair.
     * @param token1 Higher-sorted token of the pair.
     * @param pool Address of the new clone.
     * @param creator `msg.sender` of the create call. Not indexed (the three topics are taken);
     * use {getPoolsByCreator} for creator-keyed enumeration.
     * @param pairPoolIndex Pair-local index of the clone; with `(token0, token1)` it is all that
     * {computePoolAddress} needs to recompute `pool`.
     * @param poolCount {allPoolsLength} after this pool was appended.
     * @param config Configuration accepted by the create call, post-validation.
     */
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        address indexed pool,
        address creator,
        uint32 pairPoolIndex,
        uint256 poolCount,
        PoolConfig config
    );
    /**
     * @notice Emitted when the owner adds a pool to or removes it from the whitelist of a pair.
     * @param token0 First token as passed by the owner (not sorted).
     * @param token1 Second token as passed by the owner (not sorted).
     * @param pool Pool whose whitelist status changed.
     * @param whitelisted `true` after an addition, `false` after a removal.
     */
    event PoolWhitelistUpdated(
        address indexed token0,
        address indexed token1,
        address indexed pool,
        bool whitelisted
    );

    /**
     * @notice Emitted alongside {PoolCreated} when the new pool is private: every mint into it
     * must name a recipient on the pool's LP allowlist.
     * @param pool Address of the new clone.
     * @param admin Creator of the pool, registered as its parameter admin on {paramTimelock}.
     */
    event PrivatePoolCreated(address indexed pool, address indexed admin);
    /**
     * @notice Emitted for every allowlist write of a private pool, including no-op re-sets.
     * Distinct from {PoolWhitelistUpdated}, the owner-curated registry of featured pools.
     * @param pool Private pool whose allowlist changed.
     * @param account Account added to or removed from the allowlist.
     * @param allowed `true` after an addition, `false` after a removal.
     */
    event PoolLpAllowlistUpdated(address indexed pool, address indexed account, bool allowed);

    /**
     * @notice Emitted when the protocol fee percentage changes, including the constructor's
     * initial setting (from `0`).
     * @param oldFee Previous protocol fee in percent of the swap fee.
     * @param newFee New protocol fee in percent of the swap fee.
     */
    event ProtocolFeeChanged(uint8 oldFee, uint8 newFee);
    /**
     * @notice Emitted when the protocol fee collector changes.
     * @param oldCollector Previous collector.
     * @param newCollector New collector.
     */
    event FeeCollectorChanged(address oldCollector, address newCollector);
    /**
     * @notice Emitted once, when the owner permanently disables pool creation on this factory.
     * @param caller Owner that deprecated the factory.
     */
    event FactoryDeprecated(address indexed caller);

    /**
     * @notice Emitted when the owner binds, rebinds or unbinds the verified Boost wrapper of a
     * pool.
     * @param pool Pool whose binding changed.
     * @param oldBoost Previously bound share vault, `address(0)` when there was none.
     * @param newBoost Newly bound share vault, `address(0)` when the binding was removed.
     */
    event PoolBoostSet(address indexed pool, address oldBoost, address newBoost);

    // ============ Structs ============

    /**
     * @notice Full per-pool configuration. The factory validates every field at creation and
     * reverts with the matching `Invalid*` / `FeeRampTooNarrow` / `RepegShareExceedsBudget`
     * error on a violation.
     */
    struct PoolConfig {
        /// Depth-at-anchor knob `a` of `K = A·L·(x+y)/2 + (W − A)·xy`, `A = a·W/(W + λ·D)`;
        /// WAD. Range `[A_MIN_WAD, A_MAX_WAD] = [1e17, WAD − 1]` (`InvalidA`); larger deepens
        /// the plateau at the anchor.
        uint64 aWad;
        /// Plateau-width knob `λ`; WAD. Range `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD] = [1e12, 1e18]`
        /// (`InvalidLambda`); larger narrows the plateau. Independent of `aWad`.
        uint64 lambdaWad;
        /// Maximum swap fee in bps, and the flat fee when `feeRampBps == 0`. Range
        /// `[MIN_BASE_FEE, MAX_BASE_FEE] = [1, 2000]` (`InvalidFee`).
        uint16 baseFee;
        /// EMA oracle half-life in seconds, stored as `tau = ceil(emaPeriod · 1000 / 694)`.
        /// Floor `MIN_PUBLIC_EMA_PERIOD` (600 s) for public and `MIN_EMA_PERIOD` (60 s) for
        /// private pools; `tau ≤ MAX_EMA_PERIOD` (7 d) caps the half-life at ≈ 4.86 d
        /// (`InvalidEmaPeriod`). The pool's `getFeeConfig()` returns `tau · 694 / 1000`.
        uint32 emaPeriod;
        /// Cap on the log-domain anchor step per repeg commit; WAD (1e15 ≈ 0.1%). The applied
        /// step is `min(repegStepWad, deviation / REPEG_DAMPING_DIVISOR)`. Range
        /// `[MIN_REPEG_STEP, MAX_REPEG_STEP] = [1, WAD]` (`InvalidRepegStep`).
        uint256 repegStepWad;
        /// Activation dead-band while `ema > priceScale`: no repeg attempt while the geometric
        /// deviation `max(ema, priceScale) / min(ema, priceScale) − 1` is below it; WAD. Range
        /// `[1, WAD)` (`InvalidRepegThreshold`). Fee-independent; crossing it permits an
        /// attempt, the LP-budget gates decide the move.
        uint256 repegThresholdToken1UpWad;
        /// Same dead-band while `ema < priceScale`; WAD, range `[1, WAD)`
        /// (`InvalidRepegThreshold`). With the base asset in slot 0 a rising base market reads
        /// as token1-down, so this band tunes bull-market catch-up.
        uint256 repegThresholdToken1DownWad;
        /// Smoothstep warm-up width in bps of WAD (`10_000` = one state-distance unit). Range
        /// `[0, MAX_FEE_RAMP_BPS]` (`InvalidFeeRamp`); `0` disables the ramp. A live ramp must
        /// pass the monotonicity guard (`FeeRampTooNarrow`).
        uint16 feeRampBps;
        /// Lower bound of the dynamic fee in bps, paid near the anchor. A live ramp requires
        /// `1 ≤ feeFloorBps < baseFee` (`InvalidFeeFloor`); ignored when `feeRampBps == 0`.
        uint16 feeFloorBps;
        /// Share of the total fee budget the auto-repeg gate may spend, in bps. `0` disables
        /// auto-repeg; `DEFAULT_REPEG_SHARE_BPS = 5_000` is the 50/50 reference. Range
        /// `[0, MAX_REPEG_SHARE_BPS]` (`InvalidRepegShare`) and
        /// `repegShareBps + protocolFee · 100 ≤ BPS` (`RepegShareExceedsBudget`). Stored grossed
        /// up by the protocol slice, so the repeg cadence is independent of `protocolFee`.
        uint16 repegShareBps;
    }

    // ============ Pool Creation ============

    /**
     * @notice Create a public pool for `(tokenA, tokenB)` and seed its genesis liquidity in one
     * transaction.
     * @dev Pools exist only through the atomic create-and-seed entrypoints, so nobody can seed an
     * empty pool first and dictate its anchor. The factory implements the mint callback: the
     * caller approves both tokens to the factory, or approves one leg and attaches native value
     * for a {WETH9} leg. The genesis mint seeds `priceScale = yWad / xWad` from the sorted
     * amounts (`y` = token0, `x` = token1), burns `MIN_INITIAL_LIQUIDITY` shares and mints
     * `sqrt(xWad · yWad) − MIN_INITIAL_LIQUIDITY` to `recipient`. No slippage guard is exposed:
     * a genesis mint has no prior state to race and the seeder fixes both inputs and the price.
     *
     * Dynamic fee. Every swap pays `feeWad = floor + (base − floor) · m(r)` with
     * `m(r) = 2r − r²` and `r = distPost / ramp` clamped to `[0, 1]`, where `distPost` is the
     * post-swap state distance, `floor = feeFloorBps · 1e14`, `base = baseFee · 1e14` and
     * `ramp = feeRampBps · 1e14`. Flat mode `feeRampBps == 0` charges `baseFee` on every swap
     * and ignores `feeFloorBps`. A live ramp requires `feeRampBps ≤ MAX_FEE_RAMP_BPS`
     * (`InvalidFeeRamp`), `1 ≤ feeFloorBps < baseFee` (`InvalidFeeFloor`) and the monotonicity
     * guard `feeRampBps · (BPS − baseFee)² ≥ FEE_RAMP_GUARD_MULT · BPS · (baseFee − feeFloorBps)²`
     * (`FeeRampTooNarrow`); on a narrower ramp a larger exact-in trade can return less output.
     *
     * Cost model. Both directions resolve the WAD fee rate on the constant-product proxy of the
     * post-swap distance, and a quote equals the swap it describes bit-for-bit. Exact-in
     * evaluates the proxy once at the gross input; the proxy can deviate from the true
     * post-state distance either way, so the rate is not guaranteed LP-favourable on large
     * swaps. Exact-out charges the maximum of the proxy fee at both ends of the realisable
     * gross interval `[grossUp(clean, floor), grossUp(clean, base)]`, at most `base − floor`
     * above the exact-in rate on anchor-crossing trades. That bounds the rate, not the rounding
     * of two independent solves: `exactInput(quoteExactOut(out)) >= out` is not guaranteed.
     *
     * Sizing the ramp (`feeFloorBps = 20`, `baseFee = 100`). Resolved fee in bps for a few
     * anchor deviations and ramp widths; see `EquilibraSwapMath.smoothstepFeeWad` for the
     * derivation:
     *
     *   priceMove |  ramp=   10 |  ramp=  100 |  ramp= 1000 |  ramp=10000
     *   (% anch)  |     feeBps  |     feeBps  |     feeBps  |     feeBps
     *   ----------+-------------+-------------+-------------+-------------
     *       1.00% |     35.06   |     21.58   |     20.16   |     20.02
     *       2.00% |     70.44   |     26.15   |     20.63   |     20.06
     *       5.00% |    100.00   |     53.56   |     23.76   |     20.38
     *      10.00% |    100.00   |     99.34   |     33.88   |     21.45
     *      20.00% |    100.00   |    100.00   |     64.44   |     25.24
     *      50.00% |    100.00   |    100.00   |    100.00   |     44.44
     *     100.00% |    100.00   |    100.00   |    100.00   |     80.00
     *     162.00% |    100.00   |    100.00   |    100.00   |    100.00
     *
     * Each column is one `feeRampBps` setting; rows are the anchor deviation produced by the
     * swap. Narrow ramps (`feeRampBps ≤ 100`) are aggressive: a 1-2% move already pushes the
     * fee close to the ceiling. Wide ramps (`feeRampBps ≥ 1000`) act as a soft floor where most
     * realistic swaps stay near `feeFloorBps`. `feeRampBps = 10000` is not "max fees": it is
     * the widest smoothstep, so most swaps pay close to `feeFloorBps`; to bias fees high, pick
     * a small `feeRampBps` (`≤ 100`) instead.
     *
     * Native value. `msg.value != 0` funds the {WETH9} leg: the factory wraps it and pays that
     * leg from its own balance; the other leg is pulled through its approval. Reverts
     * `NoWethLeg` when neither token is {WETH9} and `NativeValueMismatch` when `msg.value`
     * differs from that leg's amount (a genesis mint consumes the declared amounts in full, so
     * no refund path exists). `msg.value == 0` pulls both legs as ERC-20s, {WETH9} included.
     *
     * Also reverts `IdenticalTokens` for `tokenA == tokenB`, `ZeroAddress` for a zero token and
     * the `Invalid*` / `FeeRampTooNarrow` / `RepegShareExceedsBudget` errors listed on
     * {PoolConfig}. The pool's genesis mint rejects a seed ratio that rounds to zero or, for
     * public pools, lies outside `(MIN_PUBLIC_INITIAL_PRICE_SCALE_WAD,
     * MAX_PUBLIC_INITIAL_PRICE_SCALE_WAD)` (`InvalidPriceScale`), a geometric mean at or below
     * `MIN_INITIAL_LIQUIDITY` (`MathInvariantViolation`) and a genesis unit value farther than
     * `MAX_GENESIS_VP_ERROR_WAD` from `2·WAD` (`GenesisVpImprecise`).
     * @param tokenA First token, in either order; the factory sorts the pair into
     * `token0 < token1`.
     * @param tokenB Second token, in either order.
     * @param config Full pool configuration; see {PoolConfig} for field semantics and ranges.
     * @param amountA Seed amount of `tokenA` in raw token units; funded from `msg.value` when
     * `tokenA` is {WETH9} and native value is attached.
     * @param amountB Seed amount of `tokenB` in raw token units, under the same {WETH9} rule.
     * @param recipient Receiver of the genesis LP shares.
     * @return pool Address of the new clone.
     * @return sharesOut LP shares minted to `recipient`.
     */
    function createPoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient
    ) external payable returns (address pool, uint256 sharesOut);

    /**
     * @notice {createPoolAndAddLiquidity} for a private pool: every mint into it must name a
     * recipient on the pool's LP allowlist.
     * @dev Same validation, seeding and native-value rules as the public entrypoint, except that
     * `emaPeriod` may go down to `MIN_EMA_PERIOD` and the genesis mint skips the public
     * price-scale window. The creator and `recipient` are allowlisted by this call. Privacy is
     * immutable for the pool's lifetime and selects {paramTimelock}'s `PRIVATE_DELAY` for
     * parameter changes. The allowlist gates minting only: LP shares stay ERC-20 transferable.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param config Full pool configuration; see {PoolConfig}.
     * @param amountA Seed amount of `tokenA` in raw token units.
     * @param amountB Seed amount of `tokenB` in raw token units.
     * @param recipient Receiver of the genesis LP shares; allowlisted by this call.
     * @return pool Address of the new clone.
     * @return sharesOut LP shares minted to `recipient`.
     */
    function createPrivatePoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient
    ) external payable returns (address pool, uint256 sharesOut);

    /**
     * @notice Wrapped-native token whose seed leg attached native value can fund; immutable, set
     * at construction.
     * @return Address of the WETH9 contract.
     */
    function WETH9() external view returns (address);

    /**
     * @notice Whether `pool` was created private, i.e. its mints are gated by the LP allowlist.
     * Immutable per pool.
     * @param pool Pool to query.
     * @return `true` for a private pool; `false` for a public pool or an unknown address.
     */
    function isPrivatePool(address pool) external view returns (bool);

    /**
     * @notice Whether `account` may receive freshly minted LP shares of `pool`.
     * @dev Always `true` for public pools; a pool consults this view only when its privacy flag
     * is set.
     * @param pool Pool whose allowlist applies.
     * @param account Prospective mint recipient.
     * @return `true` when minting to `account` is permitted.
     */
    function isLpAllowed(address pool, address account) external view returns (bool);

    /**
     * @notice Every account explicitly on `pool`'s LP allowlist.
     * @dev Unordered (removals swap-and-pop) and empty for public pools; {isLpAllowed} is the
     * policy answer, this is the raw membership list.
     * @param pool Pool to query.
     * @return Allowlisted accounts.
     */
    function getLpAllowlist(address pool) external view returns (address[] memory);

    /**
     * @notice Number of accounts on `pool`'s LP allowlist.
     * @param pool Pool to query.
     * @return Allowlist size.
     */
    function getLpAllowlistLength(address pool) external view returns (uint256);

    /**
     * @notice Add or remove accounts on a private pool's LP allowlist.
     * @dev Callable only by the pool admin resolved live from {paramTimelock} (`NotPoolAdmin`
     * otherwise), so the two-step handover and renounce govern the allowlist too. Reverts
     * `NotPrivatePool` for public pools. Every entry emits {PoolLpAllowlistUpdated}, including
     * no-op re-sets.
     * @param pool Private pool whose allowlist is edited.
     * @param accounts Accounts to add or remove.
     * @param allowed `true` to add, `false` to remove.
     */
    function setLpAllowed(address pool, address[] calldata accounts, bool allowed) external;

    // ============ View Functions ============

    /**
     * @notice All pools of a token pair, ordered by pair-local index.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @return Pool addresses; empty for an unknown pair.
     */
    function getPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory);

    /**
     * @notice A page of the pools of a token pair.
     * @dev An `offset` past the end returns an empty page with `remaining == 0`; `limit == 0`
     * returns an empty page with the full remainder.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param offset Pair-local index of the first pool in the page.
     * @param limit Maximum number of pools in the page.
     * @return page Pools at indices `[offset, min(offset + limit, total))`.
     * @return remaining Number of pools after the page.
     */
    function getPoolsByPairPage(
        address tokenA,
        address tokenB,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory page, uint256 remaining);

    /**
     * @notice Number of pools of a token pair.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @return Pool count; `0` for an unknown pair.
     */
    function getPoolCountForPair(address tokenA, address tokenB) external view returns (uint256);

    /**
     * @notice Pool of a token pair by pair-local index.
     * @dev Reverts on an out-of-range index.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param index Pair-local index in `[0, getPoolCountForPair)`.
     * @return pool Pool at `index`.
     */
    function getPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool);

    /**
     * @notice Owner-whitelisted pools of a token pair.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @return Whitelisted pool addresses, unordered.
     */
    function getWhitelistedPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory);

    /**
     * @notice Number of owner-whitelisted pools of a token pair.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @return Whitelisted pool count.
     */
    function getWhitelistedPoolCountForPair(
        address tokenA,
        address tokenB
    ) external view returns (uint256);

    /**
     * @notice Owner-whitelisted pool of a token pair by index into the unordered whitelist set.
     * @dev Reverts on an out-of-range index; removals swap-and-pop, so indices are not stable.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param index Index in `[0, getWhitelistedPoolCountForPair)`.
     * @return pool Pool at `index`.
     */
    function getWhitelistedPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool);

    /**
     * @notice Bind or rebind the verified Boost share vault of `pool`. Owner only.
     * @dev Curation, not permission: anyone may deploy a Boost stack over any pool; a binding is
     * the owner's attestation of the canonical stack. Reverts `ZeroAddress` for a zero argument,
     * `PoolNotFound` when `pool` is not a pool of this factory (membership in the pair set is
     * the provenance check; the pool's self-reported metadata only selects the pair) and
     * `BoostPoolMismatch` when `boostVault.pool() != pool`.
     * @param pool Pool created by this factory.
     * @param boostVault Share vault of the Boost stack wrapping `pool`.
     */
    function setPoolBoost(address pool, address boostVault) external;

    /**
     * @notice Remove the verified Boost binding of `pool`. Owner only.
     * @dev Reverts `BoostNotBound` when no binding exists.
     * @param pool Pool whose binding is removed.
     */
    function removePoolBoost(address pool) external;

    /**
     * @notice Verified Boost share vault of `pool`.
     * @param pool Pool to query.
     * @return boostVault Bound share vault, `address(0)` when none.
     */
    function getPoolBoost(address pool) external view returns (address boostVault);

    /**
     * @notice All pools with a verified Boost binding.
     * @return pools Bound pools, unordered.
     */
    function getBoostedPools() external view returns (address[] memory pools);

    /**
     * @notice Number of pools with a verified Boost binding.
     * @return count Size of the boosted-pool set.
     */
    function getBoostedPoolCount() external view returns (uint256 count);

    /**
     * @notice Boosted pool by index into the unordered boosted-pool set.
     * @dev Reverts on an out-of-range index; removals swap-and-pop, so indices are not stable.
     * @param index Index in `[0, getBoostedPoolCount)`.
     * @return pool Pool at `index`.
     */
    function getBoostedPoolAt(uint256 index) external view returns (address pool);

    /**
     * @notice Whether `pool` is on the owner-curated whitelist of a token pair.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param pool Pool to query.
     * @return `true` when whitelisted for the pair.
     */
    function isPoolWhitelisted(
        address tokenA,
        address tokenB,
        address pool
    ) external view returns (bool);

    /**
     * @notice All pools created by `creator`, in creation order.
     * @param creator Address that called a create entrypoint.
     * @return Pool addresses.
     */
    function getPoolsByCreator(address creator) external view returns (address[] memory);

    /**
     * @notice Number of pools created by `creator`.
     * @param creator Address that called a create entrypoint.
     * @return Pool count.
     */
    function getPoolsByCreatorCount(address creator) external view returns (uint256);

    /**
     * @notice Pool by global index across all pairs, in deployment order.
     * @dev Reverts on an out-of-range index. See {getPoolAt} for per-pair indexing.
     * @param index Global index in `[0, allPoolsLength)`.
     * @return Pool at `index`.
     */
    function allPools(uint256 index) external view returns (address);

    /**
     * @notice Total number of pools created by this factory across all pairs.
     * @return Pool count.
     */
    function allPoolsLength() external view returns (uint256);

    /**
     * @notice Deterministic address of the clone at `pairPoolIndex` of a token pair, whether or
     * not it exists yet.
     * @dev `CREATE2` of the {poolImplementation} minimal proxy with salt
     * `keccak256(abi.encode(token0, token1, pairPoolIndex))` over the sorted pair.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param pairPoolIndex Pair-local index of the pool.
     * @return Predicted pool address.
     */
    function computePoolAddress(
        address tokenA,
        address tokenB,
        uint32 pairPoolIndex
    ) external view returns (address);

    /**
     * @notice Implementation every pool clone delegates to; immutable.
     * @return Implementation address.
     */
    function poolImplementation() external view returns (address);

    /**
     * @notice Protocol share of every swap fee in percent (not bps); each pool snapshots it at
     * creation.
     * @return Percentage in `[0, MAX_PROTOCOL_FEE]`.
     */
    function protocolFee() external view returns (uint8);

    /**
     * @notice Recipient of collected protocol fees; read live by the pools.
     * @return Collector address.
     */
    function feeCollector() external view returns (address);

    /**
     * @notice Singleton parameter timelock deployed by the factory constructor: the only account
     * allowed to call the pools' runtime parameter setters, and the registry of pool admins.
     * @return Timelock address.
     */
    function paramTimelock() external view returns (address);

    /**
     * @notice Factory owner: sets the protocol fee and collector, curates the whitelist and the
     * Boost registry, and may pause pools.
     * @return Owner address.
     */
    function owner() external view returns (address);

    /**
     * @notice Whether pool creation has been permanently disabled by {deprecateFactory}.
     * @dev Existing pools, the registries, the whitelist, the LP allowlists, the Boost bindings
     * and the param timelock keep working after deprecation; only the two create entrypoints
     * revert.
     * @return `true` once the factory is deprecated.
     */
    function deprecated() external view returns (bool);

    // ============ Admin Functions ============

    /**
     * @notice Permanently disable pool creation on this factory. Owner only, irreversible.
     * @dev Intended for retiring this factory in favour of a newer deployment. Both
     * {createPoolAndAddLiquidity} and {createPrivatePoolAndAddLiquidity} revert
     * `FactoryDeprecated` afterwards; every other function, including the admin surface for the
     * existing pools, is unaffected. Reverts `FactoryDeprecated` when already deprecated. Emits
     * {FactoryDeprecated}.
     */
    function deprecateFactory() external;

    /**
     * @notice Set the protocol fee percentage. Owner only.
     * @dev Reverts `InvalidProtocolFee` above `MAX_PROTOCOL_FEE`. Applies to pools created
     * afterwards; existing pools keep the value snapshotted at their creation.
     * @param newFee New protocol fee in percent of the swap fee.
     */
    function setProtocolFee(uint8 newFee) external;

    /**
     * @notice Set the protocol fee collector. Owner only.
     * @dev Reverts `ZeroAddress` for `address(0)`. Takes effect for every pool immediately.
     * @param newCollector New collector address.
     */
    function setFeeCollector(address newCollector) external;

    /**
     * @notice Add a pool to the owner-curated whitelist of its token pair. Owner only.
     * @dev Reverts `ZeroAddress` for a zero pool, `PoolNotFound` when `pool` is not a pool of
     * that pair and `PoolExists` when it is already whitelisted.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param pool Pool to whitelist.
     */
    function addPoolToWhitelist(address tokenA, address tokenB, address pool) external;

    /**
     * @notice Remove a pool from the whitelist of its token pair. Owner only.
     * @dev Reverts `PoolNotFound` when `pool` is not whitelisted for that pair.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param pool Pool to remove.
     */
    function removePoolFromWhitelist(address tokenA, address tokenB, address pool) external;
}
