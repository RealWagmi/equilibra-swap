// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { EquilibraSwapMath } from "../libraries/EquilibraSwapMath.sol";
import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";

/// @title StatefulKernelHarness (asymmetric coords)
/// @notice Minimal swap-only pool stub for exercising the canonical
///         {EquilibraSwapMath} (closed-form cubic with frozen-L per
///         leg). No fees, no LP token, no oracle, no auto-repeg —
///         pure curve-math validator.
///
/// @dev    Mirrors `EquilibraPool`'s asymmetric math-space
///         convention with one-sided quote normalisation:
///           xMath = reserve1Wad                     (base, identity)
///           yMath = reserve0Wad · WAD / priceScale  (quote → base)
///         with `priceScale = divWad(r0Wad, r1Wad) = yWad / xWad` seeded
///         at deploy from the initial reserve ratio. The asymmetric
///         coord change is what gives the auto-repeg gate a real IL
///         signal — see the pool's `_tryAutoRepeg` NatSpec.
contract StatefulKernelHarness {
    uint256 internal constant WAD = 1e18;

    uint256 public reserve0Wad;
    uint256 public reserve1Wad;
    uint256 public immutable aWad;
    uint256 public immutable lambdaWad;
    /// @dev Seeded from initial reserve ratio; immutable for the
    ///      lifetime of the harness (no auto-repeg in this test
    ///      stub — tests isolate pure curve mechanics).
    uint256 public immutable priceScaleWad;
    uint8 public immutable decimals0;
    uint8 public immutable decimals1;

    event Swap(
        bool zeroForOne,
        uint256 amountInRaw,
        uint256 amountOutRaw,
        uint256 reserve0WadAfter,
        uint256 reserve1WadAfter,
        uint256 iters
    );

    constructor(
        uint256 initialReserve0Wad,
        uint256 initialReserve1Wad,
        uint256 _aWad,
        uint256 _lambdaWad,
        uint8 _decimals0,
        uint8 _decimals1
    ) {
        require(initialReserve0Wad > 0 && initialReserve1Wad > 0, "Harness: empty");
        reserve0Wad = initialReserve0Wad;
        reserve1Wad = initialReserve1Wad;
        aWad = _aWad;
        lambdaWad = _lambdaWad;
        decimals0 = _decimals0;
        decimals1 = _decimals1;
        // priceScale = yWad / xWad = r0Wad / r1Wad (quote / base, WAD form).
        priceScaleWad = FixedPointMathLib.divWad(initialReserve0Wad, initialReserve1Wad);
    }

    // ========================================================================
    // Quote views
    // ========================================================================

    function quoteExactIn(
        bool zeroForOne,
        uint256 amountInRaw
    ) external view returns (uint256 amountOutRaw) {
        if (amountInRaw == 0) return 0;
        (uint256 xMath, uint256 yMath, uint8 dIn, uint8 dOut, bool inputIsQuote) = _orientMath(
            zeroForOne
        );
        uint256 amountInWad = _toWad(amountInRaw, dIn);
        if (amountInWad == 0) return 0;

        // Lift input into math (asymmetric coords):
        //   quote-side → divWad(·, priceScale)
        //   base-side  → identity
        uint256 amountInMath = inputIsQuote
            ? FixedPointMathLib.divWad(amountInWad, priceScaleWad)
            : amountInWad;
        if (amountInMath == 0) return 0;

        (uint256 dyMath, ) = EquilibraSwapMath.quoteExactInForward(
            xMath,
            yMath,
            amountInMath,
            aWad,
            lambdaWad
        );

        // Lower math output into trader's token:
        //   quote-in → base-out (output on xMath, identity to base WAD)
        //   base-in  → quote-out (output on yMath, mulWad(·, priceScale))
        uint256 amountOutWad = inputIsQuote
            ? dyMath
            : FixedPointMathLib.mulWad(dyMath, priceScaleWad);
        amountOutRaw = _fromWadDown(amountOutWad, dOut);
    }

    function quoteExactOut(
        bool zeroForOne,
        uint256 amountOutRaw
    ) external view returns (uint256 amountInRaw) {
        if (amountOutRaw == 0) return 0;
        (uint256 xMath, uint256 yMath, uint8 dIn, uint8 dOut, bool inputIsQuote) = _orientMath(
            zeroForOne
        );
        uint256 amountOutWad = _toWad(amountOutRaw, dOut);
        if (amountOutWad == 0) return 0;

        // Lift output target into math (ceil rounding):
        //   inputIsQuote (zfo) → output is base on x → identity to x-math
        //   !inputIsQuote      → output is quote on y → mulDivUp(·, WAD, priceScale)
        uint256 amountOutMath = inputIsQuote
            ? amountOutWad
            : FixedPointMathLib.mulDivUp(amountOutWad, WAD, priceScaleWad);
        if (amountOutMath == 0 || amountOutMath >= yMath) return 0;

        (uint256 dxMath, ) = EquilibraSwapMath.quoteExactOutForward(
            xMath,
            yMath,
            amountOutMath,
            aWad,
            lambdaWad
        );

        // Lift input back to trader's token (ceil for pool-favourable
        // rounding):
        //   inputIsQuote → input on y, lift to quote: mulDivUp(·, priceScale, WAD)
        //   !inputIsQuote → input on x, identity (base WAD)
        uint256 amountInWad = inputIsQuote
            ? FixedPointMathLib.mulDivUp(dxMath, priceScaleWad, WAD)
            : dxMath;
        amountInRaw = _fromWadUp(amountInWad, dIn);
    }

    // ========================================================================
    // State-mutating swaps
    // ========================================================================

    function swapExactIn(
        bool zeroForOne,
        uint256 amountInRaw
    ) external returns (uint256 amountOutRaw) {
        require(amountInRaw > 0, "Harness: zero in");
        (uint256 xMath, uint256 yMath, uint8 dIn, uint8 dOut, bool inputIsQuote) = _orientMath(
            zeroForOne
        );
        uint256 amountInWad = _toWad(amountInRaw, dIn);
        require(amountInWad > 0, "Harness: dxWad = 0");

        uint256 amountInMath = inputIsQuote
            ? FixedPointMathLib.divWad(amountInWad, priceScaleWad)
            : amountInWad;
        require(amountInMath > 0, "Harness: dxMath = 0");

        (uint256 dyMath, uint256 iters) = EquilibraSwapMath.quoteExactInForward(
            xMath,
            yMath,
            amountInMath,
            aWad,
            lambdaWad
        );
        uint256 amountOutWad = inputIsQuote
            ? dyMath
            : FixedPointMathLib.mulWad(dyMath, priceScaleWad);
        amountOutRaw = _fromWadDown(amountOutWad, dOut);
        require(amountOutRaw > 0, "Harness: dy = 0");

        _persistReservesAfterSwap(zeroForOne, amountInRaw, amountOutRaw);

        emit Swap(zeroForOne, amountInRaw, amountOutRaw, reserve0Wad, reserve1Wad, iters);
    }

    function swapExactOut(
        bool zeroForOne,
        uint256 amountOutRaw
    ) external returns (uint256 amountInRaw) {
        require(amountOutRaw > 0, "Harness: zero out");
        (uint256 xMath, uint256 yMath, uint8 dIn, uint8 dOut, bool inputIsQuote) = _orientMath(
            zeroForOne
        );
        uint256 amountOutWad = _toWad(amountOutRaw, dOut);
        require(amountOutWad > 0, "Harness: dyWad = 0");

        uint256 amountOutMath = inputIsQuote
            ? amountOutWad
            : FixedPointMathLib.mulDivUp(amountOutWad, WAD, priceScaleWad);
        require(amountOutMath > 0 && amountOutMath < yMath, "Harness: invalid dy");

        (uint256 dxMath, uint256 iters) = EquilibraSwapMath.quoteExactOutForward(
            xMath,
            yMath,
            amountOutMath,
            aWad,
            lambdaWad
        );
        // The kernel's dust soft-fail reports a zero input for a
        // wrong-side iterate; the production pool rejects that in its
        // zero-clean-input guard before settlement. Mirror the refusal
        // here so the harness cannot model a free exact-out and persist
        // reduced reserves.
        require(dxMath > 0, "Harness: dxMath = 0");
        uint256 amountInWad = inputIsQuote
            ? FixedPointMathLib.mulDivUp(dxMath, priceScaleWad, WAD)
            : dxMath;
        amountInRaw = _fromWadUp(amountInWad, dIn);

        _persistReservesAfterSwap(zeroForOne, amountInRaw, amountOutRaw);

        emit Swap(zeroForOne, amountInRaw, amountOutRaw, reserve0Wad, reserve1Wad, iters);
    }

    // ========================================================================
    // Read helpers
    // ========================================================================

    function getReserves() external view returns (uint256, uint256) {
        return (reserve0Wad, reserve1Wad);
    }

    function getReservesRaw() external view returns (uint256, uint256) {
        return (_fromWadDown(reserve0Wad, decimals0), _fromWadDown(reserve1Wad, decimals1));
    }

    function getInvariantK() external view returns (uint256) {
        (uint256 xMath, uint256 yMath) = _mathSpace();
        return EquilibraSwapMath.computeK(xMath, yMath, aWad, lambdaWad);
    }

    function getMathReserves() external view returns (uint256 xMath, uint256 yMath) {
        return _mathSpace();
    }

    // ========================================================================
    // Internal utilities
    // ========================================================================

    /// @dev Math-space layout (asymmetric):
    ///        xMath = r1Wad                       (base, identity)
    ///        yMath = r0Wad · WAD / priceScale    (quote → base)
    function _mathSpace() internal view returns (uint256 xMath, uint256 yMath) {
        xMath = reserve1Wad;
        yMath = FixedPointMathLib.divWad(reserve0Wad, priceScaleWad);
    }

    /// @dev `inputIsQuote == zeroForOne` (token0 is the quote side
    ///      by convention). For zeroForOne, the deposit hits yMath
    ///      and the withdrawal comes from xMath — pass (yMath, xMath)
    ///      to the kernel so it treats the input axis as its first
    ///      argument.
    function _orientMath(
        bool zeroForOne
    )
        internal
        view
        returns (uint256 xMath, uint256 yMath, uint8 dIn, uint8 dOut, bool inputIsQuote)
    {
        (xMath, yMath) = _mathSpace();
        if (zeroForOne) {
            return (yMath, xMath, decimals0, decimals1, true);
        }
        return (xMath, yMath, decimals1, decimals0, false);
    }

    function _persistReservesAfterSwap(
        bool zeroForOne,
        uint256 amountInRaw,
        uint256 amountOutRaw
    ) internal {
        if (zeroForOne) {
            uint256 newR0 = _fromWadDown(reserve0Wad, decimals0) + amountInRaw;
            uint256 newR1 = _fromWadDown(reserve1Wad, decimals1) - amountOutRaw;
            reserve0Wad = _toWad(newR0, decimals0);
            reserve1Wad = _toWad(newR1, decimals1);
        } else {
            uint256 newR0 = _fromWadDown(reserve0Wad, decimals0) - amountOutRaw;
            uint256 newR1 = _fromWadDown(reserve1Wad, decimals1) + amountInRaw;
            reserve0Wad = _toWad(newR0, decimals0);
            reserve1Wad = _toWad(newR1, decimals1);
        }
    }

    function _toWad(uint256 raw, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return raw;
        return raw * (10 ** (18 - dec));
    }

    function _fromWadDown(uint256 wad, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return wad;
        return wad / (10 ** (18 - dec));
    }

    function _fromWadUp(uint256 wad, uint8 dec) internal pure returns (uint256) {
        if (dec == 18) return wad;
        uint256 scale = 10 ** (18 - dec);
        return FixedPointMathLib.mulDivUp(wad, 1, scale);
    }
}
