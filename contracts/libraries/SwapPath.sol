// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SwapPath
/// @notice Packed-bytes path encoding for multi-hop swaps.
///         Format: [token0 (20)][poolIndex (4)][token1 (20)][poolIndex (4)][token2 (20)]...
library SwapPath {
    error PathTooShort();
    error SliceOutOfBounds();

    uint256 private constant ADDR_SIZE = 20;
    uint256 private constant INDEX_SIZE = 4;
    uint256 private constant NEXT_OFFSET = ADDR_SIZE + INDEX_SIZE; // 24
    uint256 private constant POP_OFFSET = NEXT_OFFSET + ADDR_SIZE; // 44
    uint256 private constant MULTIPLE_POOLS_MIN_LENGTH = POP_OFFSET + NEXT_OFFSET; // 68

    function hasMultiplePools(bytes memory path) internal pure returns (bool) {
        return path.length >= MULTIPLE_POOLS_MIN_LENGTH;
    }

    function numPools(bytes memory path) internal pure returns (uint256) {
        return (path.length - ADDR_SIZE) / NEXT_OFFSET;
    }

    function decodeFirstPool(
        bytes memory path
    ) internal pure returns (address tokenA, address tokenB, uint32 poolIndex) {
        if (path.length < POP_OFFSET) revert PathTooShort();
        assembly {
            tokenA := shr(96, mload(add(path, 32)))
            poolIndex := shr(224, mload(add(path, 52)))
            tokenB := shr(96, mload(add(path, 56)))
        }
    }

    function getFirstPool(bytes memory path) internal pure returns (bytes memory) {
        return _slice(path, 0, POP_OFFSET);
    }

    function skipToken(bytes memory path) internal pure returns (bytes memory) {
        return _slice(path, NEXT_OFFSET, path.length - NEXT_OFFSET);
    }

    function _slice(
        bytes memory data,
        uint256 start,
        uint256 length
    ) private pure returns (bytes memory result) {
        if (data.length < start + length) revert SliceOutOfBounds();
        result = new bytes(length);
        assembly {
            let src := add(add(data, 32), start)
            let dst := add(result, 32)
            let remaining := length
            for {} gt(remaining, 31) {} {
                mstore(dst, mload(src))
                src := add(src, 32)
                dst := add(dst, 32)
                remaining := sub(remaining, 32)
            }
            if remaining {
                let mask := sub(shl(mul(sub(32, remaining), 8), 1), 1)
                mstore(dst, or(and(mload(dst), mask), and(mload(src), not(mask))))
            }
        }
    }
}
