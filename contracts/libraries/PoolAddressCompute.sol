// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { LibClone } from "solady/src/utils/LibClone.sol";

/// @title PoolAddressCompute
/// @notice Derives deterministic pool addresses from factory parameters.
///         Used by the router to verify callback senders without trusting encoded data.
///         Delegates to Solady's battle-tested LibClone for init code hashing
///         and CREATE2 address prediction.
library PoolAddressCompute {
    /// @dev Returns the init code hash for a minimal proxy clone of `implementation`.
    function initCodeHash(address implementation) internal pure returns (bytes32) {
        return LibClone.initCodeHash(implementation);
    }

    /// @notice Compute pool address from pre-sorted tokens and cached init code hash.
    ///         Tokens MUST already be sorted (token0 < token1).
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
