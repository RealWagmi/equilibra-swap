// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockERC20
/// @notice Test token with configurable decimals and open mint for owner.
contract MockERC20 is ERC20, Ownable {
    uint8 private immutable _tokenDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 tokenDecimals_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        _tokenDecimals = tokenDecimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

/// @title MockFeeOnTransferERC20
/// @notice ERC20 test token that charges fee on every transfer.
contract MockFeeOnTransferERC20 is MockERC20 {
    uint16 public immutable feeBps;
    address public immutable feeSink;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 tokenDecimals_,
        uint16 feeBps_,
        address feeSink_
    ) MockERC20(name_, symbol_, tokenDecimals_) {
        feeBps = feeBps_;
        feeSink = feeSink_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBps) / 10_000;
        uint256 net = value - fee;
        super._update(from, feeSink, fee);
        super._update(from, to, net);
    }
}
