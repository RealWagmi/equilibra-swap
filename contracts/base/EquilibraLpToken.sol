// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "solady/src/tokens/ERC20.sol";
import { Errors } from "../libraries/Errors.sol";

/// @title EquilibraLpToken
/// @notice LP share token backing Equilibra pools.
/// @dev Built on top of Solady's assembly-optimised {ERC20} with EIP-2612
///      `permit` baked in so LPs can approve removals without a separate
///      transaction.
///
///      Clone-compatibility:
///      - `name`/`symbol` are kept in **storage** and seeded by the factory
///        through {_setLpTokenMetadata}, because clones do not execute the
///        implementation's constructor. Solady resolves the EIP-712
///        `DOMAIN_SEPARATOR` lazily from `name()`, so storage-backed metadata
///        plugs in seamlessly (see Solady ERC20 `_constantNameHash` fallback).
///      - Solady's namespaced storage slots for `totalSupply`/`balanceOf`/
///        `allowance`/`nonces` (assembly `sstore` of hashed seeds) do not
///        collide with the sequentially-allocated slots used elsewhere in
///        {EquilibraPool}.
///
///      Strictness overrides relative to the Solady defaults:
///      - {transfer}, {transferFrom} and {_mint} reject the zero address so
///        LP shares cannot be accidentally routed to `0x0`. `_burn` is the
///        only supply-decreasing primitive and it already requires `from` to
///        have a non-zero balance — it legitimately writes `to == address(0)`
///        via the `Transfer` event but never credits any account.
///      - {_givePermit2InfiniteAllowance} is pinned to `false` — LP shares
///        must never be silently spendable by Permit2-style singletons that
///        rely on infinite default allowances.
abstract contract EquilibraLpToken is ERC20 {
    // ============ Storage ============

    /// @dev Storage-backed name so clones can initialise metadata.
    string private _name;

    /// @dev Storage-backed symbol so clones can initialise metadata.
    string private _symbol;

    // ============ Metadata overrides ============

    /// @inheritdoc ERC20
    function name() public view virtual override returns (string memory) {
        return _name;
    }

    /// @inheritdoc ERC20
    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }

    // ============ Initialisation ============

    /// @dev Seed the LP token metadata for this clone. MUST be called
    ///      from the owning pool's initialiser, which is itself guarded
    ///      by a one-shot init modifier — that single guard is the sole
    ///      protection against re-initialisation; this setter performs
    ///      no extra check.
    /// @param name_ LP token name.
    /// @param symbol_ LP token symbol.
    function _setLpTokenMetadata(string memory name_, string memory symbol_) internal {
        _name = name_;
        _symbol = symbol_;
    }

    // ============ Zero-address guards ============

    /// @inheritdoc ERC20
    /// @dev Reject transfers to the zero address — LP shares must never be
    ///      black-holed through the public ERC20 surface.
    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (to == address(0)) revert Errors.ZeroAddress();
        return super.transfer(to, amount);
    }

    /// @inheritdoc ERC20
    /// @dev Reject `transferFrom` into the zero address. Same rationale as
    ///      {transfer}.
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        if (to == address(0)) revert Errors.ZeroAddress();
        return super.transferFrom(from, to, amount);
    }

    /// @dev Reject mints to the zero address. `_burn` intentionally does not
    ///      get a matching guard: it takes `from` (the holder) as input and
    ///      uses `address(0)` only as the sink in the emitted event.
    function _mint(address to, uint256 amount) internal virtual override {
        if (to == address(0)) revert Errors.ZeroAddress();
        super._mint(to, amount);
    }

    // ============ Permit2 policy ============

    /// @dev Disable Solady's infinite-allowance shortcut for blanket
    ///      `Permit2`-style spenders. LP shares are pool-accounting
    ///      primitives; granting any singleton a blanket spend would
    ///      surface them to arbitrary integrators without the LP's
    ///      explicit approval.
    function _givePermit2InfiniteAllowance() internal view virtual override returns (bool) {
        return false;
    }
}
