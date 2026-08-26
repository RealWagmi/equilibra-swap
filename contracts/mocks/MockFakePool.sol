// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.27;

/**
 * license Copyright (c) wagmi.com, 2026 - all rights reserved
 */

import { IEquilibraPool } from "../interfaces/IEquilibraPool.sol";

/// @title MockFakePool
/// @notice Test-only impostor: self-reports arbitrary pool metadata
///         (including a claimed factory) without ever having been
///         created by that factory. Used to pin that the Boost
///         curation registry rejects self-reported provenance.
contract MockFakePool {
    IEquilibraPool.PoolMetadata private _meta;

    constructor(address token0_, address token1_, address factory_) {
        _meta = IEquilibraPool.PoolMetadata({
            token0: token0_,
            token1: token1_,
            factory: factory_,
            pairPoolIndex: 0
        });
    }

    function getPoolMetadata() external view returns (IEquilibraPool.PoolMetadata memory) {
        return _meta;
    }
}
