// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved                                               
 * 
    /  |  _  /  | /      \  /      \ /  \     /  |/      | 
    $$ | / \ $$ |/$$$$$$  |/$$$$$$  |$$  \   /$$ |$$$$$$/ 
    $$ |/$  \$$ |$$ |__$$ |$$ | _$$/ $$$  \ /$$$ |  $$ |  
    $$ /$$$  $$ |$$    $$ |$$ |/    |$$$$  /$$$$ |  $$ |  
    $$ $$/$$ $$ |$$$$$$$$ |$$ |$$$$ |$$ $$ $$/$$ |  $$ |  
    $$$$/  $$$$ |$$ |  $$ |$$ \__$$ |$$ |$$$/ $$ | _$$ |_ 
    $$$/    $$$ |$$ |  $$ |$$    $$/ $$ | $/  $$ |/ $$   |  
    $$/      $$/ $$/   $$/  $$$$$$/  $$/      $$/ $$$$$$/  
 */

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { LibClone } from "solady/src/utils/LibClone.sol";
import { SafeTransferLib } from "solady/src/utils/SafeTransferLib.sol";
import { EnumerableSetLib } from "solady/src/utils/EnumerableSetLib.sol";
import { MetadataReaderLib } from "solady/src/utils/MetadataReaderLib.sol";
import { LibString } from "solady/src/utils/LibString.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IEquilibraPool } from "./interfaces/IEquilibraPool.sol";
import { IEquilibraFactory } from "./interfaces/IEquilibraFactory.sol";
import { IEquilibraMintCallback } from "./interfaces/IEquilibraMintCallback.sol";
import { IBoostVaultLike } from "./interfaces/IBoostVaultLike.sol";
import { IWETH9 } from "./interfaces/IWETH9.sol";
import { EquilibraParamTimelock } from "./EquilibraParamTimelock.sol";
import { Errors } from "./libraries/Errors.sol";
import { Constants } from "./libraries/Constants.sol";

/// @title EquilibraFactory
/// @notice Factory contract for creating Equilibra pools using Clone pattern
/// @dev Pools are indexed by an order-independent pair key.
///      Multiple pools per pair are allowed.
///
///      **Token admissibility (unsupported token classes).**
///      Equilibra pools assume that token balances change ONLY through
///      pool-mediated transfers (`transfer` / `transferFrom` from this
///      pool's own swap / mint / burn flows). The on-chain accounting
///      stores reserves in `_reservesPacked` and only updates them
///      from those flows. The strict `received != amountInRaw` delta
///      check at swap settlement catches deviations during a single
///      operation, but it does NOT protect against balance changes
///      that occur between operations. The following token classes
///      are therefore explicitly NOT supported, and pairing them
///      may permanently strand LP funds or revert withdrawals with
///      `MathInvariantViolation`:
///
///        * Elastic-supply / rebasing tokens (AMPL-style positive or
///          negative rebases that mutate `balanceOf` without a
///          `transfer` call).
///        * Tokens with admin-controlled balance burns or upgrades
///          that can shrink the pool's `balanceOf` post hoc.
///        * Fee-on-transfer / deflationary tokens (caught by the
///          per-swap strict check, but pool creation does not
///          pre-screen — every swap will revert with
///          `UnsupportedTokenBehavior`).
///        * ERC777 / callback-capable tokens whose `transfer` /
///          `transferFrom` can reenter (interacts poorly with the
///          router's exact-output transient-storage accounting).
contract EquilibraFactory is Ownable, IEquilibraFactory, IEquilibraMintCallback {
    using EnumerableSetLib for EnumerableSetLib.AddressSet;

    // ============ State ============

    /// @notice Pool implementation contract for cloning (immutable after deployment).
    address public immutable poolImplementation;

    /// @notice Singleton timelock through which pool creators
    ///         administer the runtime-safe parameter set of their
    ///         pools (see {EquilibraParamTimelock}). Deployed by this
    ///         constructor, so the address is immutable and the pools'
    ///         `_enforceParamTimelock` check pins to known code.
    address public immutable override paramTimelock;

    /// @notice Canonical wrapped-native token. Funds the WETH9-side
    ///         seed leg when a create call attaches native value —
    ///         immutable chain config, the same trust shape as the
    ///         router's WETH9.
    address public immutable override WETH9;

    /// @notice Protocol fee percentage (% of swap fee, e.g., 10 = 10%).
    uint8 public protocolFee;

    /// @notice Address that receives protocol fees.
    address public feeCollector;

    /// @notice Array of all created pools.
    address[] public allPools;

    /// @notice Enumerate pools for a token pair (order-independent)
    /// @dev pairKey = keccak256(min(tokenA, tokenB), max(tokenA, tokenB))
    mapping(bytes32 => EnumerableSetLib.AddressSet) private _poolsByPair;

    /// @notice Whitelisted pools for a token pair (order-independent)
    /// @dev Admin-managed subset of `_poolsByPair`.
    mapping(bytes32 => EnumerableSetLib.AddressSet) private _whitelistedPoolsByPair;

    /// @notice Pools created by each address
    mapping(address => address[]) private _poolsByCreator;

    /// @notice Owner-verified Boost wrapper per pool (address(0) = none).
    /// @dev Curation, not permission: anyone can deploy a Boost stack
    ///      over any pool; a binding here is the factory owner's
    ///      attestation of THE canonical stack for a pool. The stored
    ///      address is the stack's share vault (its user entry point);
    ///      the remaining stack contracts are discoverable from it and
    ///      from the Boost factory registry.
    mapping(address => address) private _poolBoost;

    /// @notice Pools that currently have a verified Boost binding.
    EnumerableSetLib.AddressSet private _boostedPools;

    /// @inheritdoc IEquilibraFactory
    mapping(address => bool) public override isPrivatePool;

    /// @dev Per-pool LP allowlist of the private pools. Lives here, not
    ///      on the pool, so the gate stays cheap for the pool and the
    ///      admin surface stays in one contract. Enumerable so the full
    ///      list is readable on-chain ({getLpAllowlist}); membership
    ///      (`contains`) is a single mapping read, so the mint-gate hot
    ///      path costs the same as a bool mapping — only admin writes
    ///      pay the set bookkeeping. Meaningful only while
    ///      `isPrivatePool[pool]`.
    mapping(address => EnumerableSetLib.AddressSet) private _lpAllowlist;

    // ============ Constructor ============

    constructor(
        address _poolImplementation,
        address _feeCollector,
        address _WETH9,
        uint8 _protocolFeePercent
    ) Ownable(msg.sender) {
        if (_poolImplementation == address(0)) revert Errors.ZeroAddress();
        if (_feeCollector == address(0)) revert Errors.ZeroAddress();
        if (_WETH9 == address(0)) revert Errors.ZeroAddress();
        // Pools SNAPSHOT the live protocol fee at creation, so the fee
        // must hold from the very first block — a post-deploy
        // `setProtocolFee` would leave a window where pools lock in a
        // zero protocol share forever. Same bounds as the setter.
        if (_protocolFeePercent > Constants.MAX_PROTOCOL_FEE) revert Errors.InvalidProtocolFee();

        poolImplementation = _poolImplementation;
        feeCollector = _feeCollector;
        WETH9 = _WETH9;
        protocolFee = _protocolFeePercent;
        emit ProtocolFeeChanged(0, _protocolFeePercent);
        paramTimelock = address(new EquilibraParamTimelock());
    }

    // ============ Atomic Pool Creation + Liquidity ============

    struct MintCallbackData {
        address token0;
        address token1;
        uint32 pairPoolIndex;
        address payer;
        // When set, the WETH9 leg is paid from this contract's
        // just-wrapped balance instead of being pulled from `payer`.
        bool wethFromValue;
    }

    /// @inheritdoc IEquilibraFactory
    function createPoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient
    ) external payable returns (address pool, uint256 sharesOut) {
        return _createAndSeed(tokenA, tokenB, config, amountA, amountB, recipient, false);
    }

    /// @inheritdoc IEquilibraFactory
    function createPrivatePoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient
    ) external payable returns (address pool, uint256 sharesOut) {
        return _createAndSeed(tokenA, tokenB, config, amountA, amountB, recipient, true);
    }

    /// @dev Shared create-and-seed body of the public and private
    ///      entrypoints. `isPrivate` is threaded into the pool's
    ///      `initialize` (immutable there) and mirrored in this
    ///      contract's registry, which the pool's mint gate and the
    ///      param timelock's delay selector both read.
    function _createAndSeed(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient,
        bool isPrivate
    ) private returns (address pool, uint256 sharesOut) {
        // Config validity — first and cheapest gate. Catches malformed
        // `alpha`, fees, repeg knobs and ramp width before we touch any
        // pair-level logic or storage.
        _validatePoolConfig(config);

        // Pair validity — fail-fast BEFORE the sort. `tokenA == tokenB`
        // is symmetric, so checking it pre-sort skips redundant work
        // (and naturally rejects the `address(0) == address(0)` case
        // before the zero-address check below).
        if (tokenA == tokenB) revert Errors.IdenticalTokens();

        // Sort the pair to canonical `(token0, token1)` ordering exactly
        // once at the API boundary; the pool's storage, the CREATE2
        // salt and the seed amounts all consume the sorted form.
        // {_createPool} below trusts this ordering and skips its own
        // sort.
        (address token0, address token1, uint256 amount0, uint256 amount1) = tokenA < tokenB
            ? (tokenA, tokenB, amountA, amountB)
            : (tokenB, tokenA, amountB, amountA);

        // Zero-address check AFTER sort. `address(0)` is the smallest
        // address, so if either input is zero the sort forces it into
        // `token0` — a single `token0 == 0` check covers both inputs.
        if (token0 == address(0)) revert Errors.ZeroAddress();

        // Native-value seeding: attached value funds the WETH9 side of
        // the pair. Strict equality with that side's declared amount —
        // a genesis mint consumes the declared amounts exactly, so a
        // legitimate excess cannot exist and no refund path is needed
        // (this contract's wrapped balance provably returns to zero
        // within the call). `msg.value == 0` keeps the pure ERC-20
        // path for both legs, WETH9 included.
        bool wethFromValue;
        if (msg.value != 0) {
            if (token0 != WETH9 && token1 != WETH9) revert Errors.NoWethLeg();
            uint256 wethSideAmount = token0 == WETH9 ? amount0 : amount1;
            if (msg.value != wethSideAmount) revert Errors.NativeValueMismatch();
            IWETH9(WETH9).deposit{ value: msg.value }();
            wethFromValue = true;
        }

        // `_createPool` returns the per-pair index it just allocated,
        // so we forward it into the mint-callback payload without a
        // second `_poolsByPair[...].length()` read.
        uint32 pairPoolIndex;
        (pool, pairPoolIndex) = _createPool(token0, token1, config, isPrivate);

        if (isPrivate) {
            isPrivatePool[pool] = true;
            emit PrivatePoolCreated(pool, msg.sender);
            // Seed the allowlist with the creator (the pool admin, who
            // must be able to top the pool up) and the genesis
            // recipient — otherwise the seeding mint below would fail
            // its own gate.
            _setLpAllowed(pool, msg.sender, true);
            if (recipient != msg.sender) _setLpAllowed(pool, recipient, true);
        }

        // The creator becomes the pool's parameter administrator: the
        // runtime-safe subset of the config stays tunable through the
        // param timelock — 24-hour delay, or `PRIVATE_DELAY` for
        // private pools (see {EquilibraParamTimelock} for the trust
        // model and the change policy).
        EquilibraParamTimelock(paramTimelock).registerPool(pool, msg.sender);

        bytes memory cbData = abi.encode(
            MintCallbackData({
                token0: token0,
                token1: token1,
                pairPoolIndex: pairPoolIndex,
                payer: msg.sender,
                wethFromValue: wethFromValue
            })
        );

        // No `minShares` slippage guard exposed at the factory API:
        // a genesis mint has no prior pool state to race against, and
        // the seeder controls both inputs **and** the initial anchor
        // price, so `sharesOut = sqrt(xWad · yWad) - MIN_INITIAL_LIQUIDITY`
        // is fully determined by `(amountA, amountB)`. We pass `0` to
        // the pool's `addLiquidity` (the parameter still matters for
        // proportional mints via the router, but not here).
        sharesOut = IEquilibraPool(pool).addLiquidity(amount0, amount1, 0, recipient, cbData);
    }

    // ============ Internal Pool Creation ============

    /// @dev Internal pool deployment + initialisation used exclusively by
    ///      {createPoolAndAddLiquidity}. Kept private to the contract so
    ///      that no external caller can deploy an empty pool and front-run
    ///      its initial price (the empty pool would otherwise grant the
    ///      next caller free anchor placement and the price-setting bonus).
    ///
    ///      **Caller contract:** the sole caller is responsible for the
    ///      pair-level invariants — `token0 < token1` (canonical sort)
    ///      and `token0 != 0` (which, after the sort, also implies
    ///      `token1 != 0`) — and for validating `config` via
    ///      {_validatePoolConfig}. This helper performs no input
    ///      validation; it just deploys + initialises the clone and
    ///      bookkeeps the registries. Returning `pairPoolIndex` lets
    ///      the caller forward it into the mint-callback payload
    ///      without a second `_poolsByPair[pairKey].length()` storage
    ///      read.
    function _createPool(
        address token0,
        address token1,
        PoolConfig calldata config,
        bool isPrivate
    ) internal returns (address pool, uint32 pairPoolIndex) {
        // Deterministic clone: salt derived from the sorted pair +
        // in-pair index. Tokens are already sorted by the caller
        // (see precondition in the NatSpec above), so we skip the
        // redundant sort inside `_getPairKey` and hash directly.
        bytes32 pairKey = keccak256(abi.encode(token0, token1));
        pairPoolIndex = uint32(_poolsByPair[pairKey].length());
        {
            bytes32 salt = keccak256(abi.encode(token0, token1, pairPoolIndex));
            pool = LibClone.cloneDeterministic(poolImplementation, salt);
        }

        _initializePool(pool, token0, token1, config, pairPoolIndex, isPrivate);

        _poolsByPair[pairKey].add(pool);
        _poolsByCreator[msg.sender].push(pool);
        allPools.push(pool);

        emit PoolCreated(token0, token1, pool, msg.sender, pairPoolIndex, allPools.length, config);
    }

    /// @inheritdoc IEquilibraMintCallback
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        MintCallbackData memory cbData = abi.decode(data, (MintCallbackData));

        // `cbData.{token0, token1}` were written by `_createPool` from the
        // already-sorted pair, so hash directly instead of going through
        // `_getPairKey` (which would sort again for no benefit).
        bytes32 pairKey = keccak256(abi.encode(cbData.token0, cbData.token1));
        if (_poolsByPair[pairKey].at(cbData.pairPoolIndex) != msg.sender)
            revert Errors.InvalidCallbackSender();

        // The WETH9 leg of a native-value seed is paid from this
        // contract's just-wrapped balance (`_createAndSeed` deposited
        // exactly that leg's amount in the same call); the other leg —
        // and every leg of a pure ERC-20 seed — is pulled from the
        // payer's approval as before.
        if (amount0Owed > 0) {
            if (cbData.wethFromValue && cbData.token0 == WETH9) {
                SafeTransferLib.safeTransfer(cbData.token0, msg.sender, amount0Owed);
            } else {
                SafeTransferLib.safeTransferFrom(
                    cbData.token0,
                    cbData.payer,
                    msg.sender,
                    amount0Owed
                );
            }
        }
        if (amount1Owed > 0) {
            if (cbData.wethFromValue && cbData.token1 == WETH9) {
                SafeTransferLib.safeTransfer(cbData.token1, msg.sender, amount1Owed);
            } else {
                SafeTransferLib.safeTransferFrom(
                    cbData.token1,
                    cbData.payer,
                    msg.sender,
                    amount1Owed
                );
            }
        }
    }

    // ============ View Functions ============

    /// @inheritdoc IEquilibraFactory
    function getPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory) {
        return _poolsByPair[_getPairKey(tokenA, tokenB)].values();
    }

    /// @inheritdoc IEquilibraFactory
    function getPoolsByPairPage(
        address tokenA,
        address tokenB,
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory page, uint256 remaining) {
        EnumerableSetLib.AddressSet storage pools = _poolsByPair[_getPairKey(tokenA, tokenB)];
        uint256 total = pools.length();
        if (offset >= total) return (new address[](0), 0);

        if (limit == 0) return (new address[](0), total - offset);

        uint256 end = offset + limit;
        if (end > total) end = total;

        uint256 size = end - offset;
        page = new address[](size);
        for (uint256 i; i < size; ++i) {
            page[i] = pools.at(offset + i);
        }
        remaining = total - end;
    }

    /// @inheritdoc IEquilibraFactory
    function getPoolCountForPair(address tokenA, address tokenB) external view returns (uint256) {
        return _poolsByPair[_getPairKey(tokenA, tokenB)].length();
    }

    /// @inheritdoc IEquilibraFactory
    function getPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool) {
        return _poolsByPair[_getPairKey(tokenA, tokenB)].at(index);
    }

    /// @inheritdoc IEquilibraFactory
    function getWhitelistedPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].values();
    }

    /// @inheritdoc IEquilibraFactory
    function getWhitelistedPoolCountForPair(
        address tokenA,
        address tokenB
    ) external view returns (uint256) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].length();
    }

    /// @inheritdoc IEquilibraFactory
    function getWhitelistedPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].at(index);
    }

    /// @inheritdoc IEquilibraFactory
    function isPoolWhitelisted(
        address tokenA,
        address tokenB,
        address pool
    ) external view returns (bool) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].contains(pool);
    }

    /// @inheritdoc IEquilibraFactory
    function getPoolsByCreator(address creator) external view returns (address[] memory) {
        return _poolsByCreator[creator];
    }

    /// @notice Get number of pools created by an address.
    function getPoolsByCreatorCount(address creator) external view returns (uint256) {
        return _poolsByCreator[creator].length;
    }

    /// @notice Get total number of pools created.
    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    /// @inheritdoc IEquilibraFactory
    function owner() public view override(Ownable, IEquilibraFactory) returns (address) {
        return Ownable.owner();
    }

    /// @notice Compute the deterministic address of a pool without deploying.
    function computePoolAddress(
        address tokenA,
        address tokenB,
        uint32 pairPoolIndex
    ) external view returns (address) {
        (address left, address right) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 salt = keccak256(abi.encode(left, right, pairPoolIndex));
        bytes32 hash = LibClone.initCodeHash(poolImplementation);
        return LibClone.predictDeterministicAddress(hash, salt, address(this));
    }

    // ============ Private-pool LP allowlist ============

    /// @inheritdoc IEquilibraFactory
    /// @dev Self-contained answer to "may `account` receive freshly
    ///      minted LP of `pool`?": public pools admit everyone, so the
    ///      raw set (never written for them) must not leak through
    ///      as a blanket `false` — integrators use this view directly.
    function isLpAllowed(address pool, address account) external view override returns (bool) {
        return !isPrivatePool[pool] || _lpAllowlist[pool].contains(account);
    }

    /// @inheritdoc IEquilibraFactory
    function getLpAllowlist(address pool) external view override returns (address[] memory) {
        return _lpAllowlist[pool].values();
    }

    /// @inheritdoc IEquilibraFactory
    function getLpAllowlistLength(address pool) external view override returns (uint256) {
        return _lpAllowlist[pool].length();
    }

    /// @inheritdoc IEquilibraFactory
    function setLpAllowed(
        address pool,
        address[] calldata accounts,
        bool allowed
    ) external override {
        if (!isPrivatePool[pool]) revert Errors.NotPrivatePool();
        // The pool admin is the creator, resolved LIVE from the param
        // timelock — so the two-step handover (and renounce, which
        // freezes the allowlist along with the parameters) governs this
        // registry too, with no second role to keep in sync.
        if (msg.sender != EquilibraParamTimelock(paramTimelock).poolAdmin(pool))
            revert Errors.NotPoolAdmin();
        for (uint256 i; i < accounts.length; ++i) {
            _setLpAllowed(pool, accounts[i], allowed);
        }
    }

    /// @dev Idempotent single-entry write + event. Emitting
    ///      unconditionally (even on a no-op re-set) keeps the event log
    ///      a faithful record of admin intent.
    function _setLpAllowed(address pool, address account, bool allowed) private {
        if (allowed) {
            _lpAllowlist[pool].add(account);
        } else {
            _lpAllowlist[pool].remove(account);
        }
        emit PoolLpAllowlistUpdated(pool, account, allowed);
    }

    // ============ Admin Functions ============

    /// @inheritdoc IEquilibraFactory
    function setProtocolFee(uint8 newFee) external onlyOwner {
        if (newFee > Constants.MAX_PROTOCOL_FEE) revert Errors.InvalidProtocolFee();

        uint8 oldFee = protocolFee;
        protocolFee = newFee;

        emit ProtocolFeeChanged(oldFee, newFee);
    }

    /// @inheritdoc IEquilibraFactory
    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0)) revert Errors.ZeroAddress();

        address oldCollector = feeCollector;
        feeCollector = newCollector;

        emit FeeCollectorChanged(oldCollector, newCollector);
    }

    /// @inheritdoc IEquilibraFactory
    function addPoolToWhitelist(address tokenA, address tokenB, address pool) external onlyOwner {
        if (pool == address(0)) revert Errors.ZeroAddress();

        bytes32 pairKey = _getPairKey(tokenA, tokenB);
        if (!_poolsByPair[pairKey].contains(pool)) revert Errors.PoolNotFound();
        if (!_whitelistedPoolsByPair[pairKey].add(pool)) revert Errors.PoolExists();

        emit PoolWhitelistUpdated(tokenA, tokenB, pool, true);
    }

    /// @inheritdoc IEquilibraFactory
    function removePoolFromWhitelist(
        address tokenA,
        address tokenB,
        address pool
    ) external onlyOwner {
        bytes32 pairKey = _getPairKey(tokenA, tokenB);
        if (!_whitelistedPoolsByPair[pairKey].remove(pool)) revert Errors.PoolNotFound();

        emit PoolWhitelistUpdated(tokenA, tokenB, pool, false);
    }

    /// @inheritdoc IEquilibraFactory
    function setPoolBoost(address pool, address boostVault) external onlyOwner {
        if (pool == address(0) || boostVault == address(0)) revert Errors.ZeroAddress();
        // Membership in `_poolsByPair` is the authoritative provenance
        // check (only `_deployPool` inserts): a crafted contract can
        // self-report any metadata, but cannot join the set. The
        // metadata only derives the pair key to look under.
        IEquilibraPool.PoolMetadata memory meta = IEquilibraPool(pool).getPoolMetadata();
        if (!_poolsByPair[_getPairKey(meta.token0, meta.token1)].contains(pool))
            revert Errors.PoolNotFound();
        // The vault must wrap exactly this pool — guards against
        // fat-fingering a stack of a different pool.
        if (IBoostVaultLike(boostVault).pool() != pool) revert Errors.BoostPoolMismatch();

        address old = _poolBoost[pool];
        _poolBoost[pool] = boostVault;
        _boostedPools.add(pool);

        emit PoolBoostSet(pool, old, boostVault);
    }

    /// @inheritdoc IEquilibraFactory
    function removePoolBoost(address pool) external onlyOwner {
        address old = _poolBoost[pool];
        if (old == address(0)) revert Errors.BoostNotBound();

        delete _poolBoost[pool];
        _boostedPools.remove(pool);

        emit PoolBoostSet(pool, old, address(0));
    }

    /// @inheritdoc IEquilibraFactory
    function getPoolBoost(address pool) external view returns (address boostVault) {
        return _poolBoost[pool];
    }

    /// @inheritdoc IEquilibraFactory
    function getBoostedPools() external view returns (address[] memory pools) {
        return _boostedPools.values();
    }

    /// @inheritdoc IEquilibraFactory
    function getBoostedPoolCount() external view returns (uint256 count) {
        return _boostedPools.length();
    }

    /// @inheritdoc IEquilibraFactory
    function getBoostedPoolAt(uint256 index) external view returns (address pool) {
        return _boostedPools.at(index);
    }

    // ============ Internal Functions ============

    function _initializePool(
        address pool,
        address token0,
        address token1,
        PoolConfig calldata config,
        uint32 pairPoolIndex,
        bool isPrivate
    ) internal {
        // Cross-parameter invariant: every fee dollar is split three
        // ways — `protocolFeePercent / 100` to the protocol, the rest
        // becomes LP unit-value growth, of which `repegShareBps / BPS`
        // funds repegs and the residual stays with LPs. To leave a
        // non-negative residual, `repegShareBps + protocolFee × 100`
        // must not exceed `BPS`. This is also what guarantees the
        // `BPS − protocolFeePercent × 100` denominator in the pool's
        // `_tryAutoRepeg` threshold formula stays strictly positive.
        if (uint256(config.repegShareBps) + uint256(protocolFee) * 100 > Constants.BPS)
            revert Errors.RepegShareExceedsBudget();

        string memory sym0 = _safeSymbol(token0);
        string memory sym1 = _safeSymbol(token1);

        // Decimal-lift scales are computed here (instead of inside
        // every pool clone's `initialize`) so the implementation
        // bytecode does not have to link `IERC20Metadata` or run two
        // `**` ops at init. Validation lives next to the `decimals()`
        // call so a malformed token never reaches the pool.
        (uint64 t0Scale, uint64 t1Scale) = (_resolveTokenScale(token0), _resolveTokenScale(token1));

        IEquilibraPool(pool).initialize(
            IEquilibraPool.InitParams({
                token0: token0,
                token1: token1,
                token0Scale: t0Scale,
                token1Scale: t1Scale,
                aWad: config.aWad,
                lambdaWad: config.lambdaWad,
                baseFee: config.baseFee,
                // Half-life -> internal relaxation time tau (validated
                // against MAX_EMA_PERIOD in {_validatePoolConfig}); the
                // pool's `getFeeConfig()` applies the exact inverse.
                emaPeriod: uint32((uint256(config.emaPeriod) * 1000 + 693) / 694),
                repegStepWad: config.repegStepWad,
                repegThresholdToken1UpWad: config.repegThresholdToken1UpWad,
                repegThresholdToken1DownWad: config.repegThresholdToken1DownWad,
                protocolFeePercent: protocolFee,
                pairPoolIndex: pairPoolIndex,
                feeRampBps: config.feeRampBps,
                feeFloorBps: config.feeFloorBps,
                repegShareBps: config.repegShareBps,
                isPrivate: isPrivate,
                // The pair-local index is part of the metadata because
                // several pools may exist for one pair — without it
                // their LP tokens would be indistinguishable by name.
                // Token symbols are attacker-controlled cosmetics;
                // addresses remain the only identity.
                lpName: string(
                    abi.encodePacked(
                        "Equilibra LP: ",
                        sym0,
                        "/",
                        sym1,
                        " #",
                        LibString.toString(pairPoolIndex)
                    )
                ),
                lpSymbol: string(
                    abi.encodePacked(
                        "ELP-",
                        sym0,
                        "-",
                        sym1,
                        "-",
                        LibString.toString(pairPoolIndex)
                    )
                )
            })
        );
    }

    /// @dev Read `decimals()` off the ERC-20 metadata extension and
    ///      lift it into the pool's `token{0,1}Scale` form
    ///      (`10**(18 - decimals)`). Reverts with
    ///      `Errors.TokenDecimalsTooLarge` for tokens whose decimals
    ///      exceed `Constants.MAX_TOKEN_DECIMALS = 18`.
    ///      No `try/catch` wrapper because non-conformant ERC-20s
    ///      cannot be paired by Equilibra anyway (every swap path
    ///      calls `transferFrom` and `transfer`, which already require
    ///      a real ERC-20). Letting the `decimals()` revert bubble up
    ///      surfaces the misconfiguration at pool-creation time
    ///      instead of on the first swap.
    function _resolveTokenScale(address token) internal view returns (uint64 scale) {
        uint8 decimals = IERC20Metadata(token).decimals();
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        // `MAX_TOKEN_DECIMALS = 18`, so the exponent is in `[0, 18]`
        // and `10 ** 18` fits in `uint64`.
        scale = uint64(10 ** (18 - decimals));
    }

    function _getPairKey(address tokenA, address tokenB) internal pure returns (bytes32) {
        (address left, address right) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(left, right));
    }

    /// @dev Validates every `PoolConfig` field against the bounds in
    ///      `Constants.sol`. Each check reverts with its dedicated
    ///      `Invalid*` / `FeeRamp*` error so off-chain consumers can
    ///      surface a precise reason. `feeRampBps == 0` is a
    ///      legitimate opt-out (every swap then pays the flat
    ///      `baseFee`); `feeRampBps != 0 && baseFee == feeFloorBps`
    ///      is rejected — the smoothstep ramp would have no headroom
    ///      to interpolate, so the misconfig must fail fast at deploy
    ///      time.
    function _validatePoolConfig(PoolConfig calldata config) internal pure {
        // Two-knob concentration parameters
        if (config.aWad < Constants.A_MIN_WAD || config.aWad > Constants.A_MAX_WAD)
            revert Errors.InvalidA();
        if (
            config.lambdaWad < Constants.LAMBDA_MIN_WAD ||
            config.lambdaWad > Constants.LAMBDA_MAX_WAD
        ) revert Errors.InvalidLambda();

        // Fees
        if (config.baseFee < Constants.MIN_BASE_FEE || config.baseFee > Constants.MAX_BASE_FEE)
            revert Errors.InvalidFee();

        // EMA period. The configured value is the oracle HALF-LIFE in
        // seconds; the pool stores the internal relaxation time
        // `tau = ceil(period * 1000 / 694)` — the exact integer inverse
        // of that view's `tau * 694 / 1000`.
        if (
            config.emaPeriod < Constants.MIN_EMA_PERIOD ||
            (uint256(config.emaPeriod) * 1000 + 693) / 694 > Constants.MAX_EMA_PERIOD
        ) revert Errors.InvalidEmaPeriod();

        // Repeg step (cap on the relative anchor move per repeg commit)
        if (
            config.repegStepWad < Constants.MIN_REPEG_STEP ||
            config.repegStepWad > Constants.MAX_REPEG_STEP
        ) revert Errors.InvalidRepegStep();

        // Direction-split repeg dead-bands; each shares the step range.
        if (
            config.repegThresholdToken1UpWad < Constants.MIN_REPEG_STEP ||
            config.repegThresholdToken1UpWad > Constants.MAX_REPEG_STEP ||
            config.repegThresholdToken1DownWad < Constants.MIN_REPEG_STEP ||
            config.repegThresholdToken1DownWad > Constants.MAX_REPEG_STEP
        ) revert Errors.InvalidRepegThreshold();

        // Smoothstep dynamic-fee warm-up width
        if (config.feeRampBps > Constants.MAX_FEE_RAMP_BPS) revert Errors.InvalidFeeRamp();

        // Floor must not exceed the ceiling (`baseFee`)
        if (config.feeFloorBps > config.baseFee) revert Errors.InvalidFeeFloor();

        // Smoothstep ramp requires strict headroom — `baseFee` must be
        // *above* `feeFloorBps` for the ramp to interpolate. Catch the
        // misconfig "I want a ramp but ceiling == floor" here so it
        // never silently collapses to the flat-fee path inside the pool.
        if (config.feeRampBps != 0 && config.baseFee == config.feeFloorBps)
            revert Errors.FeeRampNoHeadroom();

        // Monotonicity guard: on a too-narrow live ramp the terminal
        // rate climbs faster than the gross input grows
        // (`d(g·f(g))/dg > 1`), making a larger exact-in trade return
        // less output over whole input intervals. The `(BPS − baseFee)²`
        // factor scales the bound by the shrinking `1 − f` headroom at
        // high fee ceilings. See `Constants.FEE_RAMP_GUARD_MULT`.
        if (config.feeRampBps != 0) {
            uint256 span = uint256(config.baseFee) - uint256(config.feeFloorBps);
            uint256 inv = Constants.BPS - uint256(config.baseFee);
            if (
                uint256(config.feeRampBps) * inv * inv <
                Constants.FEE_RAMP_GUARD_MULT * Constants.BPS * span * span
            ) revert Errors.FeeRampTooNarrow();
        }

        // Repeg/LP profit split — implicit `≥ 0` via `uint16`,
        // explicit upper bound `MAX_REPEG_SHARE_BPS == BPS`.
        if (config.repegShareBps > Constants.MAX_REPEG_SHARE_BPS) revert Errors.InvalidRepegShare();

        // Stall guard — only meaningful when auto-repeg is live
        // (`repegShareBps == 0` short-circuits `_tryAutoRepeg` before
        // the thresholds are ever read, so they are inert and any value
        // is acceptable). Each dead-band pins the first permitted repeg
        // attempt on its side at `deviation == threshold`, where the move's
        // LP-unit-value cost grows ~quadratically in the deviation
        // while the fee-funded growth budget accrued by the very flow
        // that created the deviation grows only ~linearly. A threshold
        // far above the fee scale therefore yields a pool whose repeg
        // can never afford to fire from its own flow — at any
        // deviation — and pool parameters are immutable, so the
        // misconfig would strand the anchor until a timelocked
        // threshold or fee change lifts it. Keep each band at or below
        // the fee scale: the floor when the smoothstep ramp is live,
        // the flat `baseFee` otherwise (all read as relative
        // fractions; `1 bps == 1e14` WAD). The step cap needs no such
        // guard: a large cap only widens the per-commit ceiling, the
        // damping `deviation/5` keeps individual moves proportional.
        // See CLAUDE.md "Sizing the repeg knobs".
        if (config.repegShareBps != 0) {
            uint256 feeScaleBps = config.feeRampBps == 0
                ? uint256(config.baseFee)
                : uint256(config.feeFloorBps);
            if (
                config.repegThresholdToken1UpWad > feeScaleBps * 1e14 ||
                config.repegThresholdToken1DownWad > feeScaleBps * 1e14
            ) revert Errors.RepegThresholdExceedsFeeScale();
        }
    }

    /// @dev Cosmetic-metadata reader for the LP token's name / symbol.
    ///      Delegates to Solady's {MetadataReaderLib.readSymbol}, which
    ///      handles both standard EIP-20 Metadata `string symbol()` and
    ///      legacy `bytes32 symbol()` (MKR-style) in a single assembly
    ///      probe — Solidity's `try/catch` cannot trap ABI decode
    ///      failures, so the hand-rolled dual-interface approach is not
    ///      viable here. Returns `"???"` if the token has no `symbol()`
    ///      selector at all, so a missing symbol never blocks pool
    ///      creation.
    function _safeSymbol(address token) internal view returns (string memory) {
        string memory sym = MetadataReaderLib.readSymbol(token);
        return bytes(sym).length == 0 ? "???" : sym;
    }
}
