// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "solady/src/tokens/ERC20.sol";
import { Errors } from "../libraries/Errors.sol";

/**
 * @title EquilibraLpToken
 * @notice LP share token of Equilibra pools: Solady ERC20 with EIP-2612 permit.
 * @dev Clone compatibility: `name` and `symbol` live in storage and are seeded by the pool
 * initialiser through `_setLpTokenMetadata`, because clones do not run the implementation
 * constructor; Solady resolves the EIP-712 domain separator lazily from `name()`. Solady's
 * namespaced storage slots for supply, balances, allowances and nonces do not collide with the
 * pool's sequential slots. Strictness overrides: `transfer`, `transferFrom` and `_mint` reject
 * the zero address, and the Permit2 infinite-allowance shortcut is disabled.
 */
abstract contract EquilibraLpToken is ERC20 {
    // ============ Storage ============

    /**
     * @dev Storage-backed name so clones can initialise metadata.
     */
    string private _name;

    /**
     * @dev Storage-backed symbol so clones can initialise metadata.
     */
    string private _symbol;

    // ============ Metadata overrides ============

    /**
     * @inheritdoc ERC20
     */
    function name() public view virtual override returns (string memory) {
        return _name;
    }

    /**
     * @inheritdoc ERC20
     */
    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }

    // ============ Initialisation ============

    /**
     * @dev Seed the LP token metadata of this clone. Must be called from the owning pool's
     * initialiser, whose one-shot guard is the only protection against re-initialisation; this
     * setter performs no check of its own.
     * @param name_ LP token name.
     * @param symbol_ LP token symbol.
     */
    function _setLpTokenMetadata(string calldata name_, string calldata symbol_) internal {
        _name = name_;
        _symbol = symbol_;
    }

    // ============ Zero-address guards ============

    /**
     * @inheritdoc ERC20
     * @dev Reverts `ZeroAddress` when `to` is the zero address, so LP shares cannot be
     * black-holed through the public ERC20 surface.
     */
    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (to == address(0)) revert Errors.ZeroAddress();
        return super.transfer(to, amount);
    }

    /**
     * @inheritdoc ERC20
     * @dev Reverts `ZeroAddress` when `to` is the zero address.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        if (to == address(0)) revert Errors.ZeroAddress();
        return super.transferFrom(from, to, amount);
    }

    /**
     * @dev Reverts `ZeroAddress` on a mint to the zero address. `_burn` needs no matching guard:
     * it takes the holder as `from` and uses `address(0)` only as the event sink.
     */
    function _mint(address to, uint256 amount) internal virtual override {
        if (to == address(0)) revert Errors.ZeroAddress();
        super._mint(to, amount);
    }

    // ============ Permit2 policy ============

    /**
     * @dev Disable Solady's infinite-allowance shortcut for Permit2-style spenders: LP shares are
     * never spendable by a singleton without the holder's explicit approval.
     */
    function _givePermit2InfiniteAllowance() internal view virtual override returns (bool) {
        return false;
    }
}
