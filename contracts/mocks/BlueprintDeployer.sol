// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title BlueprintDeployer
 * @notice Helper to deploy ERC-5202 style blueprints
 * @dev Creates contracts that store arbitrary bytecode (including invalid opcodes)
 *      by using CREATE2 with a wrapper that returns the desired bytecode
 */
contract BlueprintDeployer {
    /**
     * @notice Deploy bytecode as a blueprint (ERC-5202 style)
     * @param bytecode The bytecode to store (should include 0xfe7100 preamble)
     * @return deployed The address where the bytecode is stored
     */
    function deployBlueprint(bytes memory bytecode) external returns (address deployed) {
        // Create wrapper bytecode that returns the desired bytecode
        // PUSH1 <len_hi> PUSH1 <len_lo> ... complex for variable length
        // Instead, use a simpler approach with CODECOPY

        // Wrapper: copy the appended bytecode to memory and return it
        //
        // Layout of this deployment transaction's calldata:
        // [0..3] = function selector (deployBlueprint)
        // [4..35] = offset to bytecode (always 0x20 = 32)
        // [36..67] = length of bytecode
        // [68..] = bytecode data
        //
        // We'll create init code that:
        // 1. Copies the blueprint bytecode from this contract's code into memory
        // 2. Returns it as the deployed code

        uint256 len = bytecode.length;

        // Build init code:
        // PUSH2 <len>       - push bytecode length
        // DUP1              - duplicate length for RETURN
        // PUSH1 0x0e        - offset in init code where bytecode starts (14 bytes of init code)
        // PUSH1 0x00        - memory offset
        // CODECOPY          - copy bytecode to memory
        // PUSH1 0x00        - memory offset for RETURN
        // RETURN            - return the bytecode as deployed code

        // Init code layout:
        // 0:  61 LLLL   - PUSH2 <length>     (3 bytes)
        // 3:  80        - DUP1               (1 byte)
        // 4:  60 0c     - PUSH1 0x0c         (2 bytes)  <- offset where bytecode starts
        // 6:  60 00     - PUSH1 0x00         (2 bytes)
        // 8:  39        - CODECOPY           (1 byte)
        // 9:  60 00     - PUSH1 0x00         (2 bytes)
        // 11: f3        - RETURN             (1 byte)
        // 12: <bytecode>                     <- starts at offset 0x0c (12)

        bytes memory initCode = abi.encodePacked(
            hex"61", // PUSH2
            uint16(len), // length (2 bytes, big endian)
            hex"80", // DUP1
            hex"60",
            uint8(0x0c), // PUSH1 0x0c (12 bytes of init code before bytecode)
            hex"60",
            uint8(0x00), // PUSH1 0x00 (memory destination)
            hex"39", // CODECOPY
            hex"60",
            uint8(0x00), // PUSH1 0x00 (memory offset for return)
            hex"f3", // RETURN
            bytecode // the actual bytecode to deploy
        );

        assembly {
            // Deploy using CREATE
            // add(initCode, 0x20) skips the length prefix of bytes memory
            // mload(initCode) gets the length
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }

        require(deployed != address(0), "Blueprint deployment failed");
    }
}
