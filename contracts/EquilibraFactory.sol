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

/**
 * @title EquilibraFactory
 * @notice Deploys Equilibra pools as minimal-proxy clones of one implementation, seeds them
 * atomically and keeps the pool registries.
 * @dev Pools are keyed by the order-independent pair key `keccak256(abi.encode(token0, token1))`
 * over the sorted pair; several pools may exist per pair, addressed by a pair-local index that
 * also salts the clone.
 *
 * Token admissibility. A pool assumes its token balances change only through its own swap, mint
 * and burn transfers: reserves live in `_reservesPacked` and are updated by those flows alone.
 * The strict `received != amountInRaw` check at swap settlement catches deviations within one
 * operation, not balance changes between operations, so these token classes are unsupported and
 * can strand LP funds or make withdrawals revert `MathInvariantViolation`: rebasing or
 * elastic-supply tokens; tokens with admin-controlled balance burns or upgrades; fee-on-transfer
 * tokens (every swap reverts `UnsupportedTokenBehavior`); ERC777-style tokens whose transfers
 * reenter (they interact badly with the router's exact-output transient-storage accounting).
 * Pool creation does not pre-screen tokens.
 */
contract EquilibraFactory is Ownable, IEquilibraFactory, IEquilibraMintCallback {
    using EnumerableSetLib for EnumerableSetLib.AddressSet;

    // ============ State ============

    /**
     * @notice Implementation every pool clone delegates to; immutable.
     */
    address public immutable poolImplementation;

    /**
     * @notice Singleton parameter timelock deployed by the constructor: sole caller of the pools'
     * runtime parameter setters and the registry of pool admins. Immutable, so the pools'
     * `_enforceParamTimelock` check pins to known code.
     */
    address public immutable override paramTimelock;

    /**
     * @notice Wrapped-native token; funds the WETH9 seed leg when a create call attaches native
     * value. Immutable chain configuration, the same one the router pins.
     */
    address public immutable override WETH9;

    /**
     * @notice Protocol share of every swap fee in percent (`10` = 10%); each pool snapshots it
     * at creation.
     */
    uint8 public protocolFee;

    /**
     * @notice Recipient of collected protocol fees; read live by the pools.
     */
    address public feeCollector;

    /**
     * @inheritdoc IEquilibraFactory
     */
    bool public override deprecated;

    /**
     * @notice Every pool ever created, in deployment order.
     */
    address[] public allPools;

    /**
     * @dev Pools per pair key `keccak256(abi.encode(token0, token1))` over the sorted pair.
     * Append-only, so a pool's position equals its pair-local index.
     */
    mapping(bytes32 => EnumerableSetLib.AddressSet) private _poolsByPair;

    /**
     * @dev Owner-curated subset of `_poolsByPair` under the same pair key.
     */
    mapping(bytes32 => EnumerableSetLib.AddressSet) private _whitelistedPoolsByPair;

    /**
     * @dev Pools per creator, in creation order.
     */
    mapping(address => address[]) private _poolsByCreator;

    /**
     * @dev Owner-verified Boost share vault per pool, `address(0)` when none. Curation, not
     * permission: anyone may deploy a Boost stack over any pool; a binding attests the canonical
     * one. The vault is the stack's user entry point; the other stack contracts are discoverable
     * from it and from the Boost factory registry.
     */
    mapping(address => address) private _poolBoost;

    /**
     * @dev Pools that currently have a verified Boost binding.
     */
    EnumerableSetLib.AddressSet private _boostedPools;

    /**
     * @inheritdoc IEquilibraFactory
     */
    mapping(address => bool) public override isPrivatePool;

    /**
     * @dev LP allowlist per private pool. Kept on the factory so the pool's mint gate is one
     * `staticcall` and the admin surface stays in one contract. Enumerable for {getLpAllowlist};
     * membership is a single mapping read, so only admin writes pay the set bookkeeping.
     * Meaningful only while `isPrivatePool[pool]`.
     */
    mapping(address => EnumerableSetLib.AddressSet) private _lpAllowlist;

    // ============ Constructor ============

    /**
     * @notice Deploys the factory and its singleton {EquilibraParamTimelock}.
     * @dev Reverts `ZeroAddress` for a zero implementation, collector or WETH9 and
     * `InvalidProtocolFee` above `MAX_PROTOCOL_FEE`; the fee is validated here because pools
     * snapshot it at creation. Emits {ProtocolFeeChanged} from `0`.
     * @param _poolImplementation Pool implementation every clone delegates to.
     * @param _feeCollector Initial recipient of protocol fees.
     * @param _WETH9 Wrapped-native token of the chain.
     * @param _protocolFeePercent Initial protocol fee in percent of the swap fee.
     */
    constructor(
        address _poolImplementation,
        address _feeCollector,
        address _WETH9,
        uint8 _protocolFeePercent
    ) Ownable(msg.sender) {
        if (_poolImplementation == address(0)) revert Errors.ZeroAddress();
        if (_feeCollector == address(0)) revert Errors.ZeroAddress();
        if (_WETH9 == address(0)) revert Errors.ZeroAddress();
        // Same bound as `setProtocolFee`; pools snapshot the value at creation.
        if (_protocolFeePercent > Constants.MAX_PROTOCOL_FEE) revert Errors.InvalidProtocolFee();

        poolImplementation = _poolImplementation;
        feeCollector = _feeCollector;
        WETH9 = _WETH9;
        protocolFee = _protocolFeePercent;
        emit ProtocolFeeChanged(0, _protocolFeePercent);
        paramTimelock = address(new EquilibraParamTimelock());
    }

    // ============ Atomic Pool Creation + Liquidity ============

    /**
     * @notice Payload the factory passes to the pool's genesis `addLiquidity` and decodes back in
     * {equilibraMintCallback}.
     */
    struct MintCallbackData {
        address token0;
        address token1;
        uint32 pairPoolIndex;
        address payer;
        /// Pay the WETH9 leg from the factory's just-wrapped balance instead of pulling it from
        /// `payer`.
        bool wethFromValue;
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
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

    /**
     * @inheritdoc IEquilibraFactory
     */
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

    /**
     * @dev Shared body of the public and private create entrypoints: validates the config and
     * the pair, sorts the pair, wraps attached native value, deploys and initialises the clone,
     * registers the creator as pool admin and runs the genesis mint.
     * @param tokenA First token, in either order.
     * @param tokenB Second token, in either order.
     * @param config Full pool configuration.
     * @param amountA Seed amount of `tokenA` in raw token units.
     * @param amountB Seed amount of `tokenB` in raw token units.
     * @param recipient Receiver of the genesis LP shares.
     * @param isPrivate Selects the private path: allowlist seeding, the pool's immutable privacy
     * flag and the timelock's short delay.
     * @return pool Address of the new clone.
     * @return sharesOut LP shares minted to `recipient`.
     */
    function _createAndSeed(
        address tokenA,
        address tokenB,
        PoolConfig calldata config,
        uint256 amountA,
        uint256 amountB,
        address recipient,
        bool isPrivate
    ) private returns (address pool, uint256 sharesOut) {
        if (deprecated) revert Errors.FactoryDeprecated();

        // Cheapest gate next: config bounds before any pair or storage work.
        _validatePoolConfig(config, isPrivate);

        // Symmetric check, so it runs before the sort; it also rejects the all-zero pair.
        if (tokenA == tokenB) revert Errors.IdenticalTokens();

        // Canonical `(token0, token1)` order, sorted once here: the pool storage, the CREATE2
        // salt and the amounts consume the sorted form, and `_createPool` does not sort again.
        (address token0, address token1, uint256 amount0, uint256 amount1) = tokenA < tokenB
            ? (tokenA, tokenB, amountA, amountB)
            : (tokenB, tokenA, amountB, amountA);

        // `address(0)` sorts lowest, so one `token0` check covers both inputs.
        if (token0 == address(0)) revert Errors.ZeroAddress();

        // Attached value funds the WETH9 leg and must equal it exactly: a genesis mint consumes
        // the declared amounts in full, so no refund path is needed.
        bool wethFromValue;
        if (msg.value != 0) {
            if (token0 != WETH9 && token1 != WETH9) revert Errors.NoWethLeg();
            uint256 wethSideAmount = token0 == WETH9 ? amount0 : amount1;
            if (msg.value != wethSideAmount) revert Errors.NativeValueMismatch();
            IWETH9(WETH9).deposit{ value: msg.value }();
            wethFromValue = true;
        }

        // Reuse the index `_createPool` allocated instead of re-reading the set length.
        uint32 pairPoolIndex;
        (pool, pairPoolIndex) = _createPool(token0, token1, config, isPrivate);

        if (isPrivate) {
            isPrivatePool[pool] = true;
            emit PrivatePoolCreated(pool, msg.sender);
            // Allowlist the admin and the genesis recipient, or the seeding mint fails its gate.
            _setLpAllowed(pool, msg.sender, true);
            if (recipient != msg.sender) _setLpAllowed(pool, recipient, true);
        }

        // The creator administers the runtime-tunable parameters through the timelock.
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

        // `minShares = 0`: a genesis mint has no prior state to race and the seeder fixes both
        // inputs and the initial price, so `sharesOut` is determined by `(amountA, amountB)`.
        sharesOut = IEquilibraPool(pool).addLiquidity(amount0, amount1, 0, recipient, cbData);
    }

    // ============ Internal Pool Creation ============

    /**
     * @dev Deploys and initialises one clone and records it in the registries. Internal only, so
     * no external caller can deploy an empty pool and front-run its anchor. Performs no
     * validation: the caller guarantees `token0 < token1`, `token0 != address(0)` (which after
     * the sort implies `token1 != address(0)`) and a config validated by {_validatePoolConfig}.
     * @param token0 Lower-sorted token.
     * @param token1 Higher-sorted token.
     * @param config Validated pool configuration.
     * @param isPrivate Privacy flag stored immutably in the pool.
     * @return pool Address of the new clone.
     * @return pairPoolIndex Pair-local index assigned to the clone, returned so the caller can
     * forward it into the mint-callback payload without a second set-length read.
     */
    function _createPool(
        address token0,
        address token1,
        PoolConfig calldata config,
        bool isPrivate
    ) internal returns (address pool, uint32 pairPoolIndex) {
        // Salt = sorted pair + pair-local index; the caller sorted, so hash the pair directly.
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

    /**
     * @inheritdoc IEquilibraMintCallback
     * @dev Accepts calls only from the pool registered at the payload's pair key and index
     * (`InvalidCallbackSender`). A WETH9 leg funded by native value is paid from the factory's
     * just-wrapped balance; every other leg is pulled from the payer's approval.
     */
    function equilibraMintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        MintCallbackData memory cbData = abi.decode(data, (MintCallbackData));

        // The payload carries the sorted pair, so hash it directly.
        bytes32 pairKey = keccak256(abi.encode(cbData.token0, cbData.token1));
        if (_poolsByPair[pairKey].at(cbData.pairPoolIndex) != msg.sender)
            revert Errors.InvalidCallbackSender();

        // Native-funded WETH9 leg: pay from the wrapped balance; otherwise pull from the payer.
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

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory) {
        return _poolsByPair[_getPairKey(tokenA, tokenB)].values();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
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

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getPoolCountForPair(address tokenA, address tokenB) external view returns (uint256) {
        return _poolsByPair[_getPairKey(tokenA, tokenB)].length();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool) {
        return _poolsByPair[_getPairKey(tokenA, tokenB)].at(index);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getWhitelistedPoolsByPair(
        address tokenA,
        address tokenB
    ) external view returns (address[] memory) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].values();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getWhitelistedPoolCountForPair(
        address tokenA,
        address tokenB
    ) external view returns (uint256) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].length();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getWhitelistedPoolAt(
        address tokenA,
        address tokenB,
        uint256 index
    ) external view returns (address pool) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].at(index);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function isPoolWhitelisted(
        address tokenA,
        address tokenB,
        address pool
    ) external view returns (bool) {
        return _whitelistedPoolsByPair[_getPairKey(tokenA, tokenB)].contains(pool);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getPoolsByCreator(address creator) external view returns (address[] memory) {
        return _poolsByCreator[creator];
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getPoolsByCreatorCount(address creator) external view returns (uint256) {
        return _poolsByCreator[creator].length;
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function owner() public view override(Ownable, IEquilibraFactory) returns (address) {
        return Ownable.owner();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
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

    /**
     * @inheritdoc IEquilibraFactory
     * @dev Public pools admit everyone, so their never-written raw set must not leak through as
     * a blanket `false`.
     */
    function isLpAllowed(address pool, address account) external view override returns (bool) {
        return !isPrivatePool[pool] || _lpAllowlist[pool].contains(account);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getLpAllowlist(address pool) external view override returns (address[] memory) {
        return _lpAllowlist[pool].values();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getLpAllowlistLength(address pool) external view override returns (uint256) {
        return _lpAllowlist[pool].length();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function setLpAllowed(
        address pool,
        address[] calldata accounts,
        bool allowed
    ) external override {
        if (!isPrivatePool[pool]) revert Errors.NotPrivatePool();
        // Admin resolved live from the timelock: handover and renounce govern this registry too.
        if (msg.sender != EquilibraParamTimelock(paramTimelock).poolAdmin(pool))
            revert Errors.NotPoolAdmin();
        for (uint256 i; i < accounts.length; ++i) {
            _setLpAllowed(pool, accounts[i], allowed);
        }
    }

    /**
     * @dev Idempotent single-entry write. Emits unconditionally so the log records every admin
     * write, including no-op re-sets.
     */
    function _setLpAllowed(address pool, address account, bool allowed) private {
        if (allowed) {
            _lpAllowlist[pool].add(account);
        } else {
            _lpAllowlist[pool].remove(account);
        }
        emit PoolLpAllowlistUpdated(pool, account, allowed);
    }

    // ============ Admin Functions ============

    /**
     * @inheritdoc IEquilibraFactory
     */
    function setProtocolFee(uint8 newFee) external onlyOwner {
        if (newFee > Constants.MAX_PROTOCOL_FEE) revert Errors.InvalidProtocolFee();

        uint8 oldFee = protocolFee;
        protocolFee = newFee;

        emit ProtocolFeeChanged(oldFee, newFee);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0)) revert Errors.ZeroAddress();

        address oldCollector = feeCollector;
        feeCollector = newCollector;

        emit FeeCollectorChanged(oldCollector, newCollector);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function deprecateFactory() external onlyOwner {
        if (deprecated) revert Errors.FactoryDeprecated();
        deprecated = true;
        emit FactoryDeprecated(msg.sender);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function addPoolToWhitelist(address tokenA, address tokenB, address pool) external onlyOwner {
        if (pool == address(0)) revert Errors.ZeroAddress();

        bytes32 pairKey = _getPairKey(tokenA, tokenB);
        if (!_poolsByPair[pairKey].contains(pool)) revert Errors.PoolNotFound();
        if (!_whitelistedPoolsByPair[pairKey].add(pool)) revert Errors.PoolExists();

        emit PoolWhitelistUpdated(tokenA, tokenB, pool, true);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function removePoolFromWhitelist(
        address tokenA,
        address tokenB,
        address pool
    ) external onlyOwner {
        bytes32 pairKey = _getPairKey(tokenA, tokenB);
        if (!_whitelistedPoolsByPair[pairKey].remove(pool)) revert Errors.PoolNotFound();

        emit PoolWhitelistUpdated(tokenA, tokenB, pool, false);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function setPoolBoost(address pool, address boostVault) external onlyOwner {
        if (pool == address(0) || boostVault == address(0)) revert Errors.ZeroAddress();
        // Membership in `_poolsByPair` is the provenance check (only `_createPool` inserts); the
        // self-reported metadata only selects the pair key to look under.
        IEquilibraPool.PoolMetadata memory meta = IEquilibraPool(pool).getPoolMetadata();
        if (!_poolsByPair[_getPairKey(meta.token0, meta.token1)].contains(pool))
            revert Errors.PoolNotFound();
        // The vault must wrap exactly this pool.
        if (IBoostVaultLike(boostVault).pool() != pool) revert Errors.BoostPoolMismatch();

        address old = _poolBoost[pool];
        _poolBoost[pool] = boostVault;
        _boostedPools.add(pool);

        emit PoolBoostSet(pool, old, boostVault);
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function removePoolBoost(address pool) external onlyOwner {
        address old = _poolBoost[pool];
        if (old == address(0)) revert Errors.BoostNotBound();

        delete _poolBoost[pool];
        _boostedPools.remove(pool);

        emit PoolBoostSet(pool, old, address(0));
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getPoolBoost(address pool) external view returns (address boostVault) {
        return _poolBoost[pool];
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getBoostedPools() external view returns (address[] memory pools) {
        return _boostedPools.values();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getBoostedPoolCount() external view returns (uint256 count) {
        return _boostedPools.length();
    }

    /**
     * @inheritdoc IEquilibraFactory
     */
    function getBoostedPoolAt(uint256 index) external view returns (address pool) {
        return _boostedPools.at(index);
    }

    // ============ Internal Functions ============

    /**
     * @dev Packs the validated config into the pool's initialization words and initialises the
     * clone. Enforces the cross-parameter budget `repegShareBps + protocolFee · 100 ≤ BPS`
     * (`RepegShareExceedsBudget`): every fee splits into the protocol slice, the repeg share and
     * the LP residual, and the bound keeps the residual non-negative and the pool's
     * `BPS − protocolFee · 100` gross-up denominator positive. Token decimal scales are resolved
     * here so the implementation neither links `IERC20Metadata` nor exponentiates at init.
     * @param pool Freshly deployed clone.
     * @param token0 Lower-sorted token.
     * @param token1 Higher-sorted token.
     * @param config Validated pool configuration.
     * @param pairPoolIndex Pair-local index, embedded in the LP token name and symbol.
     * @param isPrivate Privacy flag stored immutably in the pool.
     */
    function _initializePool(
        address pool,
        address token0,
        address token1,
        PoolConfig calldata config,
        uint32 pairPoolIndex,
        bool isPrivate
    ) internal {
        // Protocol slice + repeg share + LP residual must fit in BPS.
        if (uint256(config.repegShareBps) + uint256(protocolFee) * 100 > Constants.BPS)
            revert Errors.RepegShareExceedsBudget();

        string memory sym0 = _safeSymbol(token0);
        string memory sym1 = _safeSymbol(token1);

        // Resolved next to the `decimals()` call so a malformed token never reaches the pool.
        (uint64 t0Scale, uint64 t1Scale) = (_resolveTokenScale(token0), _resolveTokenScale(token1));

        IEquilibraPool(pool).initialize(
            IEquilibraPool.InitParams({
                token0: token0,
                token1: token1,
                feeConfigBits: _packInitialFeeConfig(config),
                scaleRampConfig: _packInitialScaleConfig(config, t0Scale, t1Scale, pairPoolIndex),
                curveConfig: _packInitialCurveConfig(config),
                repegConfig: _packInitialRepegConfig(config),
                isPrivate: isPrivate,
                // The pair-local index disambiguates several pools of one pair; symbols are
                // cosmetic, addresses remain the only identity.
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

    /**
     * @dev Packs the fee word the pool stores in the 88 bits above `_factory`, in the pool's
     * declaration order: `_baseFee` (16 bits at 0), `_protocolFeePercent` (8 at 16),
     * `_emaPeriod` (32 at 24, holding `tau = ceil(emaPeriod · 1000 / 694)`), `_feeFloorBps`
     * (16 at 56) and `_repegShareBps` (16 at 72, holding the share grossed up by the protocol
     * slice, `repegShareBps · BPS / (BPS − protocolFee · 100)`, at most `BPS` by the budget
     * guard). The top 8 bits are zero. Reached only after {_validatePoolConfig} and the budget
     * guard, so every field fits its width.
     * @param config Validated pool configuration.
     * @return Packed fee word.
     */
    function _packInitialFeeConfig(PoolConfig calldata config) private view returns (uint96) {
        uint256 share = (uint256(config.repegShareBps) * Constants.BPS) /
            (Constants.BPS - uint256(protocolFee) * 100);
        uint256 tau = (uint256(config.emaPeriod) * 1000 + 693) / 694;
        return
            uint96(
                uint256(config.baseFee) |
                    (uint256(protocolFee) << 16) |
                    (tau << 24) |
                    (uint256(config.feeFloorBps) << 56) |
                    (share << 72)
            );
    }

    /**
     * @dev Packs the word the pool stores at `_token0Scale.slot`, in the pool's declaration
     * order: `_token0Scale` (64 bits at 0), `_token1Scale` (64 at 64), `_pairPoolIndex` (32 at
     * 128), `_parachuteBandMult` (8 at 160, seeded with `REPEG_PARACHUTE_BAND_MULT`) and
     * `_feeRampDistWad` (64 at 168, `feeRampBps · 1e14` in WAD). The top 24 bits are zero.
     * @param config Validated pool configuration.
     * @param scale0 Decimal-lift scale of token0, `10**(18 − decimals)`.
     * @param scale1 Decimal-lift scale of token1.
     * @param index Pair-local index of the pool.
     * @return Packed scales/index/ramp word.
     */
    function _packInitialScaleConfig(
        PoolConfig calldata config,
        uint64 scale0,
        uint64 scale1,
        uint32 index
    ) private pure returns (uint256) {
        return
            uint256(scale0) |
            (uint256(scale1) << 64) |
            (uint256(index) << 128) |
            (uint256(Constants.REPEG_PARACHUTE_BAND_MULT) << 160) |
            ((uint256(config.feeRampBps) * 1e14) << 168);
    }

    /**
     * @dev Packs the word the pool stores at `_aWad.slot`, in the pool's declaration order:
     * `_aWad` (64 bits at 0), `_lambdaWad` (64 at 64) and `_repegThresholdToken1DownWad` (64 at
     * 128). All three are bounded at or below `WAD < 2^64`; the top 64 bits are zero.
     * @param config Validated pool configuration.
     * @return Packed curve word.
     */
    function _packInitialCurveConfig(PoolConfig calldata config) private pure returns (uint256) {
        return
            uint256(config.aWad) |
            (uint256(config.lambdaWad) << 64) |
            (config.repegThresholdToken1DownWad << 128);
    }

    /**
     * @dev Packs the word the pool stores at `_lastEmaTs.slot`, in the pool's declaration order:
     * `_lastEmaTs` (64 bits at 0) and `_lastRepegTs` (64 at 64), both seeded with the current
     * block timestamp, `_repegStepWad` (64 at 128) and `_repegThresholdToken1UpWad` (64 at 192);
     * the last two are bounded at or below `WAD < 2^64`.
     * @param config Validated pool configuration.
     * @return Packed repeg word.
     */
    function _packInitialRepegConfig(PoolConfig calldata config) private view returns (uint256) {
        uint256 timestamp = uint64(block.timestamp);
        return
            timestamp |
            (timestamp << 64) |
            (config.repegStepWad << 128) |
            (config.repegThresholdToken1UpWad << 192);
    }

    /**
     * @dev Reads `decimals()` and lifts it to the pool's scale `10**(18 − decimals)`. Reverts
     * `TokenDecimalsTooLarge` above `MAX_TOKEN_DECIMALS = 18`. No `try/catch`: a `decimals()`
     * revert bubbles up so a non-conformant token fails at creation instead of on the first
     * swap.
     * @param token ERC-20 token to inspect.
     * @return scale Decimal-lift scale in `[1, 1e18]`.
     */
    function _resolveTokenScale(address token) internal view returns (uint64 scale) {
        uint8 decimals = IERC20Metadata(token).decimals();
        if (decimals > Constants.MAX_TOKEN_DECIMALS) revert Errors.TokenDecimalsTooLarge();
        // Exponent in `[0, 18]`, so `10 ** 18` fits `uint64`.
        scale = uint64(10 ** (18 - decimals));
    }

    /**
     * @dev Order-independent pair key `keccak256(abi.encode(min(tokenA, tokenB), max(tokenA,
     * tokenB)))`.
     */
    function _getPairKey(address tokenA, address tokenB) internal pure returns (bytes32) {
        (address left, address right) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(left, right));
    }

    /**
     * @dev Validates every {PoolConfig} field against `Constants`; each violated bound reverts
     * with its own error: `InvalidA`, `InvalidLambda`, `InvalidFee`, `InvalidEmaPeriod` (floor
     * `MIN_PUBLIC_EMA_PERIOD` for public and `MIN_EMA_PERIOD` for private pools, and
     * `tau = ceil(emaPeriod · 1000 / 694) ≤ MAX_EMA_PERIOD`), `InvalidRepegStep`,
     * `InvalidRepegThreshold` (both bands in [1, WAD)), `InvalidRepegShare`, and for a
     * live ramp `InvalidFeeRamp` above `MAX_FEE_RAMP_BPS`, `InvalidFeeFloor` outside
     * `1 ≤ feeFloorBps < baseFee` and `FeeRampTooNarrow` when
     * `feeRampBps · (BPS − baseFee)² < FEE_RAMP_GUARD_MULT · BPS · (baseFee − feeFloorBps)²`.
     * `feeRampBps == 0` selects flat `baseFee` and skips the floor and guard checks. The
     * share-versus-protocol-fee budget is checked in {_initializePool}.
     * @param config Configuration to validate.
     * @param isPrivate Selects the private-pool EMA floor.
     */
    function _validatePoolConfig(PoolConfig calldata config, bool isPrivate) internal pure {
        if (config.aWad < Constants.A_MIN_WAD || config.aWad > Constants.A_MAX_WAD)
            revert Errors.InvalidA();
        if (
            config.lambdaWad < Constants.LAMBDA_MIN_WAD ||
            config.lambdaWad > Constants.LAMBDA_MAX_WAD
        ) revert Errors.InvalidLambda();

        if (config.baseFee < Constants.MIN_BASE_FEE || config.baseFee > Constants.MAX_BASE_FEE)
            revert Errors.InvalidFee();

        // `emaPeriod` is the half-life; the pool stores `tau = ceil(emaPeriod · 1000 / 694)`, the
        // exact integer inverse of the view's `tau · 694 / 1000`.
        if (
            config.emaPeriod <
                (isPrivate ? Constants.MIN_EMA_PERIOD : Constants.MIN_PUBLIC_EMA_PERIOD) ||
            (uint256(config.emaPeriod) * 1000 + 693) / 694 > Constants.MAX_EMA_PERIOD
        ) revert Errors.InvalidEmaPeriod();

        if (
            config.repegStepWad < Constants.MIN_REPEG_STEP ||
            config.repegStepWad > Constants.MAX_REPEG_STEP
        ) revert Errors.InvalidRepegStep();

        // Dead-bands stay below the EMA cap's 100% deviation.
        if (
            config.repegThresholdToken1UpWad < Constants.MIN_REPEG_STEP ||
            config.repegThresholdToken1UpWad >= Constants.WAD ||
            config.repegThresholdToken1DownWad < Constants.MIN_REPEG_STEP ||
            config.repegThresholdToken1DownWad >= Constants.WAD
        ) revert Errors.InvalidRepegThreshold();

        if (config.feeRampBps != 0) {
            if (config.feeRampBps > Constants.MAX_FEE_RAMP_BPS) revert Errors.InvalidFeeRamp();
            if (config.feeFloorBps == 0 || config.feeFloorBps >= config.baseFee)
                revert Errors.InvalidFeeFloor();
            // Monotonicity guard, live ramps only.
            uint256 span = uint256(config.baseFee) - uint256(config.feeFloorBps);
            uint256 inv = Constants.BPS - uint256(config.baseFee);
            if (
                uint256(config.feeRampBps) * inv * inv <
                Constants.FEE_RAMP_GUARD_MULT * Constants.BPS * span * span
            ) revert Errors.FeeRampTooNarrow();
        }

        // `uint16` makes the lower bound implicit; `MAX_REPEG_SHARE_BPS == BPS`.
        if (config.repegShareBps > Constants.MAX_REPEG_SHARE_BPS) revert Errors.InvalidRepegShare();
    }

    /**
     * @dev Cosmetic symbol reader for the LP token metadata. Solady's
     * {MetadataReaderLib.readSymbol} handles both `string symbol()` and legacy `bytes32 symbol()`
     * in one probe (Solidity `try/catch` cannot trap ABI-decoding failures). Returns `"???"` when
     * the token has no usable symbol, so a missing symbol never blocks pool creation.
     * @param token ERC-20 token to read.
     * @return Symbol string, `"???"` when unavailable.
     */
    function _safeSymbol(address token) internal view returns (string memory) {
        string memory sym = MetadataReaderLib.readSymbol(token);
        return bytes(sym).length == 0 ? "???" : sym;
    }
}
