// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { LibClone } from "solady/src/utils/LibClone.sol";

/**
 * @title PoolAddressCompute
 * @notice Deterministic pool-address derivation from factory parameters, used by the router to
 * verify callback senders without trusting encoded data.
 * @dev Delegates init-code hashing and CREATE2 prediction to Solady's `LibClone`.
 */
library PoolAddressCompute {
    /**
     * @dev Init code hash of a minimal proxy clone of `implementation`.
     */
    function initCodeHash(address implementation) internal pure returns (bytes32) {
        return LibClone.initCodeHash(implementation);
    }

    /**
     * @dev Predict the clone address of a pair and pair-local index. Tokens must already be
     * sorted (`token0 < token1`).
     * @param factory Deployer of the clone.
     * @param cachedInitCodeHash Init code hash of the pool implementation clone.
     * @param token0 Lower token address.
     * @param token1 Higher token address.
     * @param pairPoolIndex Pair-local pool index.
     * @return The predicted pool address.
     */
    function computeAddress(
        address factory,
        bytes32 cachedInitCodeHash,
        address token0,
        address token1,
        uint32 pairPoolIndex
    ) internal pure returns (address) {
        bytes32 salt = keccak256(abi.encode(token0, token1, pairPoolIndex));
        return LibClone.predictDeterministicAddress(cachedInitCodeHash, salt, factory);
    }
}
