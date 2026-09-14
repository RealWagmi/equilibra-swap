//! Offchain Equilibra math kernel — bit-exact port of the on-chain
//! pool math in `contracts/libraries/EquilibraSwapMath.sol`.
//!
//! Two-knob cubic invariant with one-sided (quote-side) normalised
//! asymmetric coordinate change:
//!
//! ```text
//! priceScaleWad = (yWad / xWad) at the anchor       [quote / base]
//!
//! xMath = xWad                                      (base, untouched)
//! yMath = yWad · WAD / priceScaleWad                (quote → base)
//!
//! K(x, y; L) = A · L · (x + y) / 2  +  (W − A) · x · y
//! A = a · W / (W + λ · D)
//! D = (y − x)² / (x · y)
//! W = WAD = 1e18
//! ```
//!
//! At the anchor, `yWad/xWad = priceScale` ⇒ `yMath = xMath` and the
//! curve's symmetric kernel applies. Off-anchor, `yMath ≠ xMath` and
//! `(xMath, yMath)` carries one-sided priceScale dependence — this is
//! the source of the auto-repeg gate's IL detection (see
//! `contracts/libraries/EquilibraSwapMath.sol`).
//!
//! Polynomial degree in `yMath` (after clearing denominators) is **3**,
//! giving the secant solver a well-conditioned cubic envelope.
//!
//! Two independent knobs:
//!   * **a** (depth at anchor, WAD). `A(D=0) = a`. Range
//!     `[A_MIN_WAD, A_MAX_WAD] = [0.1·W, W−1]`.
//!   * **λ** (plateau width, WAD). `A = a/2` at `λ·D = W`. Range
//!     `[LAMBDA_MIN_WAD, LAMBDA_MAX_WAD]`.
//!
//! Rounding mirrors Solady `FixedPointMathLib`:
//!   - `mul_wad(a, b)   = floor(a*b / WAD)`
//!   - `mul_wad_up(a, b)= ceil (a*b / WAD)`
//!   - `div_wad(a, b)   = floor(a*WAD / b)`
//!   - `div_wad_up(a, b)= ceil (a*WAD / b)`
//!   - `mul_div(a,b,d)  = floor(a*b / d)`
//!   - `mul_div_up(a,b,d)= ceil (a*b / d)`

use anyhow::{anyhow, Result};
use primitive_types::{U256, U512};
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// Constants (mirror `contracts/libraries/Constants.sol`).
// ---------------------------------------------------------------------------

pub const WAD: u128 = 1_000_000_000_000_000_000u128; // 1e18
pub const BPS: u128 = 10_000u128;

/// Depth-at-anchor knob `a` bounds (WAD-scaled). Mirrors Solidity
/// `Constants.{A_MIN_WAD, A_MAX_WAD}` byte-for-byte.
pub const A_MIN_WAD: u128 = 100_000_000_000_000_000u128; // 0.1 · W
pub const A_MAX_WAD: u128 = WAD - 1; // Highest WAD integer strictly below one.

/// Plateau-width knob `λ` bounds (WAD-scaled). Mirrors Solidity
/// `Constants.{LAMBDA_MIN_WAD, LAMBDA_MAX_WAD}` byte-for-byte.
pub const LAMBDA_MIN_WAD: u128 = 1_000_000_000_000u128; // 1e12
pub const LAMBDA_MAX_WAD: u128 = 1_000_000_000_000_000_000u128; // 1e18

pub const MAX_TOKEN_DECIMALS: u8 = 18;

/// Maximum secant iterations per swap leg. Mirrors Solidity
/// `EquilibraSwapMath._MAX_SECANT_ITER`.
const MAX_SECANT_ITER: u32 = 40;
const CAP_QUOTE_EPSILON_DENOM: u64 = 1_000_001;
const QUOTE_MARGIN_DENOM: u64 = 100_000_000;
// Quote K has 18 extra fractional bits; external K diagnostics remain WAD.
const QUOTE_K_EXTRA_BITS: usize = 18;

// ---------------------------------------------------------------------------
// U256 helpers — bit-exact floor/ceil arithmetic.
// ---------------------------------------------------------------------------

#[inline(always)]
fn wad_u256() -> U256 {
    U256::from(WAD)
}

#[inline(always)]
fn q128() -> U256 {
    U256::one() << 128
}

#[inline(always)]
fn u256_one() -> U256 {
    U256::one()
}

#[inline(always)]
fn u512_to_u256(v: U512) -> Result<U256> {
    if v.0[4] != 0 || v.0[5] != 0 || v.0[6] != 0 || v.0[7] != 0 {
        return Err(anyhow!("equilibra_math: u512→u256 overflow"));
    }
    Ok(U256([v.0[0], v.0[1], v.0[2], v.0[3]]))
}

#[inline(always)]
pub fn mul_div_floor(a: U256, b: U256, denom: U256) -> Result<U256> {
    if denom.is_zero() {
        return Err(anyhow!("equilibra_math: mulDiv division by zero"));
    }
    if a.is_zero() || b.is_zero() {
        return Ok(U256::zero());
    }
    let prod = a.full_mul(b);
    u512_to_u256(prod / U512::from(denom))
}

#[inline(always)]
pub fn mul_div_ceil(a: U256, b: U256, denom: U256) -> Result<U256> {
    if denom.is_zero() {
        return Err(anyhow!("equilibra_math: mulDivUp division by zero"));
    }
    if a.is_zero() || b.is_zero() {
        return Ok(U256::zero());
    }
    let prod = a.full_mul(b);
    let d = U512::from(denom);
    let q = prod / d;
    let r = prod % d;
    if !r.is_zero() {
        u512_to_u256(q + U512::one())
    } else {
        u512_to_u256(q)
    }
}

#[inline(always)]
pub fn mul_wad(a: U256, b: U256) -> Result<U256> {
    mul_div_floor(a, b, wad_u256())
}

#[inline(always)]
pub fn mul_wad_up(a: U256, b: U256) -> Result<U256> {
    mul_div_ceil(a, b, wad_u256())
}

#[inline(always)]
pub fn div_wad(a: U256, b: U256) -> Result<U256> {
    mul_div_floor(a, wad_u256(), b)
}

#[inline(always)]
pub fn div_wad_up(a: U256, b: U256) -> Result<U256> {
    mul_div_ceil(a, wad_u256(), b)
}

/// Integer square root (Newton's method, truncates to floor).
pub fn sqrt_u256(x: U256) -> U256 {
    if x <= u256_one() {
        return x;
    }
    let bits = 256 - x.leading_zeros() as u32;
    let mut z = U256::one() << ((bits + 1) / 2) as usize;
    let mut y = (z + x / z) >> 1;
    while y < z {
        z = y;
        y = (z + x / z) >> 1;
    }
    z
}

/// `sqrt_wad(x_wad) = sqrt(x_wad * WAD)` — mirrors Solady
/// `FixedPointMathLib.sqrtWad`.
pub fn sqrt_wad(x_wad: U256) -> Result<U256> {
    if x_wad.is_zero() {
        return Ok(U256::zero());
    }
    let prod = x_wad.full_mul(wad_u256());
    if prod.0[4] != 0 || prod.0[5] != 0 || prod.0[6] != 0 || prod.0[7] != 0 {
        Ok(sqrt_u512(prod))
    } else {
        let lo = U256([prod.0[0], prod.0[1], prod.0[2], prod.0[3]]);
        Ok(sqrt_u256(lo))
    }
}

/// 512-bit floor square root via Newton's method.
fn sqrt_u512(x: U512) -> U256 {
    if x.is_zero() {
        return U256::zero();
    }
    let mut bits: u32 = 0;
    for limb_idx in (0..8).rev() {
        if x.0[limb_idx] != 0 {
            bits = (limb_idx as u32) * 64 + (64 - x.0[limb_idx].leading_zeros());
            break;
        }
    }
    let seed_shift = ((bits + 1) / 2) as usize;
    let mut z = U512::one() << seed_shift;
    loop {
        let q = x / z;
        let next = (z + q) >> 1;
        if next >= z {
            break;
        }
        z = next;
    }
    if z.0[4] != 0 || z.0[5] != 0 || z.0[6] != 0 || z.0[7] != 0 {
        U256::max_value()
    } else {
        U256([z.0[0], z.0[1], z.0[2], z.0[3]])
    }
}

// ---------------------------------------------------------------------------
// Asymmetric math-space coordinate change (quote side normalised).
// ---------------------------------------------------------------------------

/// Lift `(xWad, yWad)` into math-space:
///   `xMath = xWad`                                  (base, untouched),
///   `yMath = yWad · WAD / priceScaleWad`            (quote → base).
/// Caller supplies the **raw** `priceScaleWad` (NOT its sqrt).
pub fn to_math_space(x_wad: U256, y_wad: U256, price_scale_wad: U256) -> Result<(U256, U256)> {
    if price_scale_wad.is_zero() {
        return Err(anyhow!("equilibra_math: zero priceScale"));
    }
    let x_math = x_wad;
    let y_math = div_wad(y_wad, price_scale_wad)?;
    Ok((x_math, y_math))
}

/// Inverse of `to_math_space` with floor rounding. Use for **output**
/// amounts (pool-favourable rounding).
pub fn from_math_space_down(
    x_math: U256,
    y_math: U256,
    price_scale_wad: U256,
) -> Result<(U256, U256)> {
    if price_scale_wad.is_zero() {
        return Err(anyhow!("equilibra_math: zero priceScale"));
    }
    let x_wad = x_math;
    // yWad = yMath · priceScale / WAD  (floor)
    let y_wad = mul_wad(y_math, price_scale_wad)?;
    Ok((x_wad, y_wad))
}

/// Inverse of `to_math_space` with ceil rounding. Use for **input**
/// amounts in exact-out paths.
pub fn from_math_space_up(
    x_math: U256,
    y_math: U256,
    price_scale_wad: U256,
) -> Result<(U256, U256)> {
    if price_scale_wad.is_zero() {
        return Err(anyhow!("equilibra_math: zero priceScale"));
    }
    let x_wad = x_math;
    // yWad = yMath · priceScale / WAD  (ceil, pool-favourable for exact-out input)
    let y_wad = mul_div_ceil(y_math, price_scale_wad, wad_u256())?;
    Ok((x_wad, y_wad))
}

// ---------------------------------------------------------------------------
// Distance metrics.
// ---------------------------------------------------------------------------

/// Symmetric distance between marginal and reference prices, in WAD:
/// `dist = (p − a)² / (p · a)`.
pub fn distance_from_anchor_wad(p_marg: U256, p_ref: U256) -> Result<U256> {
    if p_marg.is_zero() || p_ref.is_zero() {
        return Err(anyhow!("equilibra_math: distanceFromAnchor zero price"));
    }
    if p_marg == p_ref {
        return Ok(U256::zero());
    }
    let diff = if p_marg > p_ref {
        p_marg - p_ref
    } else {
        p_ref - p_marg
    };
    let diff_sq = mul_wad(diff, diff)?;
    let denom = mul_wad(p_marg, p_ref)?;
    if denom.is_zero() {
        return Err(anyhow!("equilibra_math: distance denominator underflow"));
    }
    div_wad(diff_sq, denom)
}

/// State-only math-space distance: `D = (y − x)² / (x · y)`, in WAD.
pub fn distance_state_wad(x_math: U256, y_math: U256) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_math: distanceState zero reserve"));
    }
    if x_math == y_math {
        return Ok(U256::zero());
    }
    let diff = if y_math > x_math {
        y_math - x_math
    } else {
        x_math - y_math
    };
    let diff_sq = mul_wad(diff, diff)?;
    let xy = mul_wad(x_math, y_math)?;
    if xy.is_zero() {
        return Err(anyhow!("equilibra_math: distanceState xy underflow"));
    }
    div_wad(diff_sq, xy)
}

// ---------------------------------------------------------------------------
// Smoothstep dynamic-fee ramp.
// ---------------------------------------------------------------------------

/// Fee rates are WAD fractions (`1 bps == 1e14`); WAD-precision
/// resolution keeps the gross → clean-input map monotone up to a dust
/// residual on the order of one rate ulp on the notional (the inputs
/// are WAD-quantized too, so one gross wei can cross several rate
/// ulps at once). Mirrors `EquilibraSwapMath.smoothstepFeeWad`.
pub fn smoothstep_fee_wad(
    dist_post_wad: U256,
    ramp_dist_wad: U256,
    floor_wad: u128,
    fee_ceiling_wad: u128,
) -> Result<u128> {
    if ramp_dist_wad.is_zero() || fee_ceiling_wad <= floor_wad {
        return Ok(fee_ceiling_wad);
    }
    if dist_post_wad >= ramp_dist_wad {
        return Ok(fee_ceiling_wad);
    }
    let wad_u = wad_u256();
    let r = mul_div_floor(dist_post_wad, wad_u, ramp_dist_wad)?;
    let r2 = mul_wad(r, r)?;
    let two_r = r
        .checked_mul(U256::from(2u64))
        .ok_or_else(|| anyhow!("equilibra_math: smoothstep 2r overflow"))?;
    if r2 > two_r {
        return Err(anyhow!("equilibra_math: smoothstep r2 > 2r invariant"));
    }
    let m = two_r - r2;
    let span = fee_ceiling_wad - floor_wad;
    let delta = mul_div_floor(U256::from(span), m, wad_u)?;
    let delta_u = delta
        .try_into()
        .map_err(|_| anyhow!("equilibra_math: smoothstep delta exceeds u128"))?;
    floor_wad
        .checked_add(delta_u)
        .ok_or_else(|| anyhow!("equilibra_math: smoothstep feeWad overflow"))
}

// ---------------------------------------------------------------------------
// Amplification A = a·W / (W + λ·D).
// ---------------------------------------------------------------------------

/// Compute the amplification `A` and its denominator `W + λ·D`.
///
/// Returns `(amp_wad, denom_wad)`. Both are WAD-scaled.
///   * `D = 0` (anchor):  `A = a`,   `denom = W`
///   * `λ·D = W` (knee):  `A = a/2`, `denom = 2W`
///   * `D → ∞`:           `A → 0`,   `denom → ∞`
pub fn amplification(a_wad: U256, lambda_wad: U256, dist_wad: U256) -> Result<(U256, U256)> {
    let lambda_d_wad = mul_wad(lambda_wad, dist_wad)?;
    let denom_wad = wad_u256() + lambda_d_wad;
    let amp_wad = mul_div_floor(a_wad, wad_u256(), denom_wad)?;
    Ok((amp_wad, denom_wad))
}

// ---------------------------------------------------------------------------
// Invariant K and depth scale L.
// ---------------------------------------------------------------------------

/// Test access to WAD * 2^18 quote K with an explicitly supplied Q128 depth.
#[cfg(test)]
pub fn compute_k_from_l(x: U256, y: U256, depth_q128: U256, a: U256, lambda: U256) -> Result<U256> {
    compute_quote_k_from_l(x, y, depth_q128, a, lambda)
}

/// Lower bound of the continuous frozen-L invariant used by quote targets
/// and the secant solver. Amplification uses Q128, with the WAD fallback
/// retained for extreme reserve ratios, matching Solidity exactly. K uses
/// WAD * 2^18: both divisors shrink before division, preserving fractional bits.
fn compute_quote_k_from_l(x: U256, y: U256, depth: U256, a: U256, lambda: U256) -> Result<U256> {
    if x.is_zero() || y.is_zero() {
        return Ok(U256::zero());
    }
    let n = mul_div_floor(x, y, wad_u256() >> QUOTE_K_EXTRA_BITS)?;
    let sum = x
        .checked_add(y)
        .ok_or_else(|| anyhow!("equilibra_math: invariant sum overflow"))?;
    let h = mul_div_floor(depth, sum, (q128() >> QUOTE_K_EXTRA_BITS) * 2)?;
    if h == n {
        return Ok(n);
    }
    let positive = h > n;
    let round_up = !positive;
    let (theta, precision) = tight_weight_bound(x, y, a, lambda, round_up)?;
    let correction = directed_mul_div(
        theta,
        if positive { h - n } else { n - h },
        precision,
        round_up,
    )?;
    if positive {
        n.checked_add(correction)
            .ok_or_else(|| anyhow!("equilibra_math: invariant correction overflow"))
    } else {
        n.checked_sub(correction)
            .ok_or_else(|| anyhow!("equilibra_math: invariant correction underflow"))
    }
}

fn directed_mul_div(a: U256, b: U256, d: U256, upper: bool) -> Result<U256> {
    if upper {
        mul_div_ceil(a, b, d)
    } else {
        mul_div_floor(a, b, d)
    }
}

fn tight_weight_bound(
    x: U256,
    y: U256,
    a: U256,
    lambda: U256,
    upper: bool,
) -> Result<(U256, U256)> {
    let mut precision = U256::one() << 128;
    let theta = if x == y {
        directed_mul_div(a, precision, wad_u256(), upper)?
    } else {
        let difference = if x > y { x - y } else { y - x };
        let xy = x
            .checked_mul(y)
            .ok_or_else(|| anyhow!("equilibra_math: invariant product overflow"))?;
        let square = difference
            .checked_mul(difference)
            .ok_or_else(|| anyhow!("equilibra_math: invariant distance overflow"))?;
        if (square >> 127) >= xy {
            precision = wad_u256();
        }
        let distance = directed_mul_div(square, precision, xy, !upper)?;
        let denominator = precision
            .checked_add(directed_mul_div(lambda, distance, wad_u256(), !upper)?)
            .ok_or_else(|| anyhow!("equilibra_math: invariant denominator overflow"))?;
        let anchor = directed_mul_div(a, precision, wad_u256(), upper)?;
        directed_mul_div(anchor, precision, denominator, upper)?
    };
    Ok((theta, precision))
}

/// Solve the closed-form quadratic `W·L² − A·L·S − (W−A)·N = 0` for
/// the positive root `L = (A·S + √((A·S)² + 4·W·(W−A)·N)) / (2·W)`.
/// Returns Q128 depth with a normalized Q128 discriminant, matching Solidity.
/// Coordinates and parameters remain WAD; no intermediate WAD depth is used.
/// Positive states require x*y <= U256::MAX and |x-y| < 2^128, also on the diagonal.
pub fn solve_l_from_state(
    x_math: U256,
    y_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(U256::zero());
    }
    let q = q128();
    if x_math == y_math {
        if x_math >= q {
            return Err(anyhow!("equilibra_math: invariant product overflow"));
        }
        return mul_div_floor(x_math, q, wad_u256());
    }
    let r = std::cmp::max(x_math, y_math);
    let t = mul_div_floor(std::cmp::min(x_math, y_math), q, r)?;
    let (mut theta, precision) = tight_weight_bound(x_math, y_math, a_wad, lambda_wad, false)?;
    if precision != q {
        theta = mul_div_floor(theta, q, precision)?;
    }
    let head = mul_div_floor(theta, q + t, q * 4)?;
    let disc = head
        .checked_mul(head)
        .and_then(|h| {
            (q - theta)
                .checked_mul(t)
                .and_then(|tail| h.checked_add(tail))
        })
        .ok_or_else(|| anyhow!("equilibra_math: depth discriminant overflow"))?;
    let ratio = head + sqrt_u256(disc);
    mul_div_floor(r, ratio, wad_u256())
}

/// Closed-form K with L recovered from state.
pub fn compute_k(x_math: U256, y_math: U256, a_wad: U256, lambda_wad: U256) -> Result<U256> {
    let (k_wad, _) = compute_k_and_l(x_math, y_math, a_wad, lambda_wad)?;
    Ok(k_wad)
}

/// Recover Q128 depth and reduce quote K to WAD for external diagnostics.
pub fn compute_k_and_l(x: U256, y: U256, a: U256, lambda: U256) -> Result<(U256, U256)> {
    let depth_q128 = solve_l_from_state(x, y, a, lambda)?;
    Ok((
        compute_quote_k_from_l(x, y, depth_q128, a, lambda)? >> QUOTE_K_EXTRA_BITS,
        depth_q128,
    ))
}

/// Recover the balance-state depth `L_eq = √(K / W) = sqrtWad(K)`.
pub fn balance_scale_from_k(k_wad: U256) -> Result<U256> {
    mul_div_floor(sqrt_wad(k_wad)?, q128(), wad_u256())
}

// ---------------------------------------------------------------------------
// LP unit value (anchor-invariant).
// ---------------------------------------------------------------------------

/// `vp = 2·L_eq · √(priceScale·WAD) / totalSupply` — the per-LP-share
/// quote-equivalent unit value. Mirrors
/// `EquilibraSwapMath.computeLpUnitValueWad` with the asymmetric
/// coord change `yMath = yWad · WAD / priceScale`.
///
/// Under the asymmetric coord, repegs at fixed reserves shift `yMath`
/// only, so `L_eq` typically drops and the `√(priceScale·WAD)` factor
/// either partially compensates (when priceScale moves toward reserve
/// balance) or amplifies the IL signal — exactly what the auto-repeg
/// gate needs.
pub fn compute_lp_unit_value_wad(
    l_eq_q128: U256,
    price_scale_wad: U256,
    total_supply_wad: U256,
) -> Result<U256> {
    if total_supply_wad.is_zero() || l_eq_q128.is_zero() || price_scale_wad.is_zero() {
        return Ok(U256::zero());
    }
    // sqrtWad(x) returns `√(x · WAD)` in WAD form.
    let sqrt_ps_wad = sqrt_wad(price_scale_wad)?;
    let depth_per_share_q128 = mul_div_floor(l_eq_q128, wad_u256() * 2, total_supply_wad)?;
    mul_div_floor(depth_per_share_q128, sqrt_ps_wad, q128())
}

// ---------------------------------------------------------------------------
// Marginal price (analytic, math-space, n = 1).
// ---------------------------------------------------------------------------

/// Math-space marginal price `pMarg = ∂K/∂x ÷ ∂K/∂y` at `(xMath, yMath)`
/// with frozen depth `L`. Mirrors Solidity `marginalPrice` for n=1.
pub fn marginal_price(
    x_math: U256,
    y_math: U256,
    l_q128: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_math: marginalPrice zero reserve"));
    }
    if x_math == y_math {
        return Ok(wad_u256());
    }
    if l_q128.is_zero() {
        return Err(anyhow!("equilibra_math: marginalPrice zero L"));
    }
    let n_wad = mul_wad(x_math, y_math)?;
    if n_wad.is_zero() {
        return Err(anyhow!("equilibra_math: marginalPrice xy underflow"));
    }

    let abs_diff = if y_math > x_math {
        y_math - x_math
    } else {
        x_math - y_math
    };
    let diff_sq_wad = mul_wad(abs_diff, abs_diff)?;
    let dist_wad = div_wad(diff_sq_wad, n_wad)?;
    let (amp_wad, denom_wad) = amplification(a_wad, lambda_wad, dist_wad)?;

    let sum_xy = x_math + y_math;

    // H = L·S − N (sign tracked).
    let ls_wad = mul_div_floor(l_q128, sum_xy, q128() * 2)?;
    let h_positive = ls_wad >= n_wad;
    let abs_h = if h_positive {
        ls_wad - n_wad
    } else {
        n_wad - ls_wad
    };

    // |x·∂A/∂x| = (A·λ / denom) · |yMath − xMath|·(x + y) / N.
    let prefactor = mul_div_floor(amp_wad, lambda_wad, denom_wad)?;
    let num1 = mul_div_floor(abs_diff, sum_xy, wad_u256())?;
    let abs_x_dd_dx_wad = mul_div_floor(num1, wad_u256(), n_wad)?;
    let abs_x_da_dx_wad = mul_wad(prefactor, abs_x_dd_dx_wad)?;

    let abs_tau = mul_wad(abs_x_da_dx_wad, abs_h)?;

    // Sign of τ.
    let y_gt_x = y_math > x_math;
    let tau_positive = y_gt_x == h_positive;

    // base_x = A·L·x/2 + (W−A)·N, base_y = A·L·y/2 + (W−A)·N
    let al_half_q128 = mul_div_floor(amp_wad, l_q128, wad_u256() * 2)?;
    let w_minus_a = wad_u256() - amp_wad;
    let tail_wad = mul_wad(w_minus_a, n_wad)?;
    let base_x = mul_div_floor(al_half_q128, x_math, q128())? + tail_wad;
    let base_y = mul_div_floor(al_half_q128, y_math, q128())? + tail_wad;

    let (x_kx, y_ky) = if tau_positive {
        if base_y <= abs_tau {
            return Err(anyhow!("equilibra_math: marginalPrice yKy underflow"));
        }
        (base_x + abs_tau, base_y - abs_tau)
    } else {
        if base_x <= abs_tau {
            return Err(anyhow!("equilibra_math: marginalPrice xKx underflow"));
        }
        (base_x - abs_tau, base_y + abs_tau)
    };

    if y_ky.is_zero() {
        return Err(anyhow!("equilibra_math: marginalPrice yKy zero"));
    }

    // Match Solidity's large-coordinate branch without changing ordinary rounding.
    if x_math >= (U256::one() << 125) || y_math >= (U256::one() << 125) {
        let intermediate = mul_div_floor(y_math, x_kx, x_math)?;
        return mul_div_floor(intermediate, wad_u256(), y_ky);
    }
    let num = mul_div_floor(y_math, x_kx, wad_u256())?;
    let den = mul_div_floor(x_math, y_ky, wad_u256())?;
    mul_div_floor(num, wad_u256(), den)
}

/// Convenience: recover L from state then evaluate marginal price.
pub fn marginal_price_from_state(
    x_math: U256,
    y_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    let l_q128 = solve_l_from_state(x_math, y_math, a_wad, lambda_wad)?;
    marginal_price(x_math, y_math, l_q128, a_wad, lambda_wad)
}

// ---------------------------------------------------------------------------
// Swap quote functions — secant solver against the cubic K with frozen L.
// ---------------------------------------------------------------------------

/// Forward exact-input. Returns `(dyMath, iters)`.
pub fn quote_exact_in_forward(
    x_math: U256,
    y_math: U256,
    dx_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<(U256, u32)> {
    let (amount, iters, _) =
        quote_exact_in_forward_with_depth(x_math, y_math, dx_math, a_wad, lambda_wad)?;
    Ok((amount, iters))
}

/// The quote and its unchanged original pre-state depth.
pub(crate) fn quote_exact_in_forward_with_depth(
    x_math: U256,
    y_math: U256,
    dx_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<(U256, u32, U256)> {
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactInForward zero reserve"));
    }
    if dx_math.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactInForward zero amount"));
    }

    let l_pre = solve_l_from_state(x_math, y_math, a_wad, lambda_wad)?;
    let k_target = compute_quote_k_from_l(x_math, y_math, l_pre, a_wad, lambda_wad)?;
    if l_pre.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactInForward L underflow"));
    }
    if k_target.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactInForward K underflow"));
    }

    let x_post = x_math + dx_math;
    let mut y_seed = mul_div_floor(x_math, y_math, x_post)?;
    if y_seed.is_zero() {
        y_seed = u256_one();
    }

    let context = SolverContext {
        fixed_axis: x_post,
        target: k_target,
        a: a_wad,
        lambda: lambda_wad,
        depth: l_pre,
        previous: y_math,
        exact_out: false,
    };
    let (y_post, used) = solve_counterpart::<MAX_SECANT_ITER>(y_seed, &context)?;

    if y_post > y_math {
        // Wrong-side terminal iterate: no physically admissible
        // discrete quote for this input. Fail closed with a zero-output
        // sentinel (mirror of the Solidity semantics); the caller's
        // typed dust guards stop the trade.
        return Ok((U256::zero(), used, l_pre));
    }
    Ok((y_math - y_post, used, l_pre))
}

/// Forward exact-output. Returns `(dxMath, iters)`.
pub fn quote_exact_out_forward(
    x_math: U256,
    y_math: U256,
    dy_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<(U256, u32)> {
    let (amount, iters, _) =
        quote_exact_out_forward_with_depth(x_math, y_math, dy_math, a_wad, lambda_wad)?;
    Ok((amount, iters))
}

/// The quote and its unchanged original pre-state depth.
pub(crate) fn quote_exact_out_forward_with_depth(
    x_math: U256,
    y_math: U256,
    dy_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<(U256, u32, U256)> {
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactOutForward zero reserve"));
    }
    if dy_math.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactOutForward zero amount"));
    }
    if dy_math >= y_math {
        return Err(anyhow!(
            "equilibra_math: quoteExactOutForward dy >= y (insufficient liquidity)"
        ));
    }

    let l_pre = solve_l_from_state(x_math, y_math, a_wad, lambda_wad)?;
    let k_target = compute_quote_k_from_l(x_math, y_math, l_pre, a_wad, lambda_wad)?;
    if l_pre.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactOutForward L underflow"));
    }
    if k_target.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactOutForward K underflow"));
    }

    let mut y_post = y_math - dy_math;
    // Upper integer inverse of the exact-in output margin. Subtracting
    // max(1, floor(trial_output / D)) returns exactly the requested dy.
    let margin = (dy_math / U256::from(QUOTE_MARGIN_DENOM - 1)).max(U256::one());
    if margin >= y_post {
        return Err(anyhow!(
            "equilibra_math: quoteExactOutForward dy >= y (insufficient liquidity)"
        ));
    }
    y_post -= margin;
    let mut x_seed = mul_div_floor(x_math, y_math, y_post)?;
    if x_seed <= x_math {
        x_seed = x_math + U256::one();
    }

    // The cubic K is symmetric in (xMath, yMath), so passing
    // (yPost, xSeed) treats yPost as the fixed axis.
    let context = SolverContext {
        fixed_axis: y_post,
        target: k_target,
        a: a_wad,
        lambda: lambda_wad,
        depth: l_pre,
        previous: x_math,
        exact_out: true,
    };
    let (x_post, used) = solve_counterpart::<MAX_SECANT_ITER>(x_seed, &context)?;

    if x_post < x_math {
        // Wrong-side terminal iterate on the input axis (mirror of the
        // exact-in case): no physically admissible discrete quote. Fail
        // closed with a zero-input sentinel; the caller's
        // zero-clean-input typed guard stops the trade.
        return Ok((U256::zero(), used, l_pre));
    }
    Ok((x_post - x_math, used, l_pre))
}

struct SolverContext {
    fixed_axis: U256,
    target: U256,
    a: U256,
    lambda: U256,
    depth: U256,
    previous: U256,
    exact_out: bool,
}

impl SolverContext {
    fn compute_k(&self, b: U256) -> Result<U256> {
        compute_quote_k_from_l(self.fixed_axis, b, self.depth, self.a, self.lambda)
    }

    /// Amount-based local tolerance, with a one-math-raw minimum.
    /// Comparing rounded lower bounds is not a continuous certificate.
    fn quote_epsilon(&self, b: U256, denominator: u64) -> U256 {
        let amount = if self.exact_out {
            b.saturating_sub(self.previous)
        } else {
            self.previous.saturating_sub(b)
        };
        (amount / U256::from(denominator)).max(U256::one())
    }

    /// Zero means unresolved; a confirmed candidate is returned unchanged.
    /// The common margin is separate from this local rounded-K bracket.
    fn certify(&self, b: U256, k: U256, epsilon: U256) -> Result<U256> {
        if k == self.target {
            return Ok(b);
        }
        if k > self.target {
            let low = if b > epsilon {
                b - epsilon
            } else {
                U256::one()
            };
            if low < b && self.compute_k(low)? <= self.target {
                return Ok(b);
            }
        } else {
            let high = b
                .checked_add(epsilon)
                .ok_or_else(|| anyhow!("equilibra_math: solver counterpart overflow"))?;
            if self.compute_k(high)? >= self.target {
                return Ok(b);
            }
        }
        Ok(U256::zero())
    }
}

/// Refine the CP guess by freezing the curve weight at that point. If its
/// linear envelope has no positive root, use the small-counterpart tail of
/// the same invariant. Only the linear estimate is floored at CP / 1000 to
/// limit cancellation near zero. This is not an acceptance check.
fn curve_seed(cp: U256, context: &SolverContext) -> Result<U256> {
    let s = context.fixed_axis;
    let half_l = mul_div_floor(context.depth, wad_u256(), q128() * 2)?;
    let k_over_s = mul_div_floor(context.target, wad_u256() >> QUOTE_K_EXTRA_BITS, s)?;
    let max_seed_coordinate = U256::from(u128::MAX);
    if s > max_seed_coordinate || half_l > max_seed_coordinate || k_over_s > max_seed_coordinate {
        return Ok(cp);
    }
    let (theta, precision) = tight_weight_bound(s, cp, context.a, context.lambda, false)?;
    let head = mul_div_floor(theta, half_l, precision)?;
    let (numerator, denominator) = if k_over_s > head {
        (
            k_over_s - head,
            mul_div_floor(precision - theta, s, precision)? + head,
        )
    } else {
        let numerator = mul_div_floor(context.lambda, k_over_s, wad_u256())?;
        // The initializer's uint128 bounds also bound these additions.
        let denominator = mul_div_floor(context.a, half_l, wad_u256())?
            + mul_div_floor(context.lambda, s, wad_u256())?
            + numerator * 2;
        if denominator <= k_over_s {
            return Ok(cp);
        }
        (numerator, denominator - k_over_s)
    };
    if denominator.is_zero() {
        return Ok(cp);
    }
    let seed = mul_div_floor(s, numerator, denominator)?.max(U256::one());
    Ok(if k_over_s > head {
        seed.max(cp / U256::from(1000u64))
    } else {
        seed
    })
}

/// Apply the common output-side margin to positive exact-in quotes.
/// Exact-out has already enlarged its trial output before solving; there
/// is no extra input surcharge. The minimum is one math unit.
fn solve_counterpart<const LIMIT: u32>(
    b_seed: U256,
    context: &SolverContext,
) -> Result<(U256, u32)> {
    let (mut b, iters) = solve_unadjusted_counterpart::<LIMIT>(b_seed, context)?;
    if !context.exact_out && b < context.previous {
        b = b
            .checked_add(context.quote_epsilon(b, QUOTE_MARGIN_DENOM))
            .ok_or_else(|| anyhow!("equilibra_math: solver counterpart overflow"))?;
    }
    Ok((b, iters))
}

/// Equal-K and unchanged-counterpart exits apply at every iteration.
/// At the cap, check best once at 0.0001%; an unconfirmed result rejects.
/// Integer exits alone do not prove agreement with the continuous invariant.
/// The caller applies the common margin, native bounds and one strict LP guard.
/// The budget is compile-time constant;
/// production callers always use MAX_SECANT_ITER.
fn solve_unadjusted_counterpart<const LIMIT: u32>(
    b_seed: U256,
    context: &SolverContext,
) -> Result<(U256, u32)> {
    let k_target = context.target;
    let b_seed = curve_seed(b_seed, context)?;
    let mut b1 = b_seed;
    let step = (b_seed / U256::from(1000u64)).max(U256::one());
    let mut b2 = if b_seed > step {
        b_seed - step
    } else {
        b_seed
            .checked_add(step)
            .ok_or_else(|| anyhow!("equilibra_math: solver counterpart overflow"))?
    };
    // A lower point can cross the opposite squared-distance boundary.
    if context.fixed_axis >= q128() && b2 <= context.fixed_axis - q128() {
        b2 = b_seed
            .checked_add(step)
            .ok_or_else(|| anyhow!("equilibra_math: solver counterpart overflow"))?;
    }
    let mut k1 = context.compute_k(b1)?;

    let mut b_best = b1;
    let mut k_best = k1;
    let mut residual_abs_best = if k1 >= k_target {
        k1 - k_target
    } else {
        k_target - k1
    };

    for i in 0..LIMIT {
        let k2 = context.compute_k(b2)?;
        if k2 == k_target {
            return Ok((b2, i + 1));
        }

        // `resid_mag` doubles as the best-iterate residual and the
        // secant numerator below — one computation serves both
        // (mirrors Solidity `_solveCounterpart`).
        let resid_pos = k2 >= k_target;
        let resid_mag = if resid_pos {
            k2 - k_target
        } else {
            k_target - k2
        };
        if resid_mag < residual_abs_best {
            b_best = b2;
            residual_abs_best = resid_mag;
            k_best = k2;
        }

        // Signed-secant arithmetic via I256.
        let dk_pos = k2 >= k1;
        let dk_mag = if dk_pos { k2 - k1 } else { k1 - k2 };

        let db_pos = b2 >= b1;
        let db_mag = if db_pos { b2 - b1 } else { b1 - b2 };

        // step = (resid · db) / dk — signed: numerator sign is
        // `resid_pos == db_pos`, the denominator sign flips it.
        let step_pos = resid_pos == db_pos;
        let prod_mag = if dk_mag.is_zero() {
            U256::zero()
        } else {
            mul_div_floor(resid_mag, db_mag, dk_mag)?
        };
        let step_neg = !dk_pos; // dk in denominator flips the sign
        let final_step_pos = step_pos ^ step_neg; // XOR with denominator sign

        // b3 = b2 − step
        let b3 = if final_step_pos {
            if b2 > prod_mag {
                b2 - prod_mag
            } else {
                b2 / U256::from(2u8) + U256::one()
            }
        } else {
            b2.checked_add(prod_mag)
                .ok_or_else(|| anyhow!("equilibra_math: solver counterpart overflow"))?
        };
        if b3 == b2 {
            return Ok((b2, i + 1));
        }
        b1 = b2;
        k1 = k2;
        b2 = b3;
    }
    let checked = context.certify(
        b_best,
        k_best,
        context.quote_epsilon(b_best, CAP_QUOTE_EPSILON_DENOM),
    )?;
    if checked.is_zero() {
        return Err(anyhow!("equilibra_math: SolverDidNotConverge"));
    }
    Ok((checked, LIMIT))
}

// ---------------------------------------------------------------------------
// CP-proxy distance predictor (dynamic-fee resolver).
// ---------------------------------------------------------------------------

/// Predict post-swap math-space distance `D` for an exact-in trade
/// using a constant-product proxy. Mirrors Solidity
/// `predictPostDistanceCp`, including saturation once the proxy guarantees D >= 1.
pub fn predict_post_distance_cp(x_math: U256, y_math: U256, dx_math_gross: U256) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() || dx_math_gross.is_zero() {
        return Ok(U256::zero());
    }
    let x_post = x_math
        .checked_add(dx_math_gross)
        .ok_or_else(|| anyhow!("equilibra_math: CP proxy input overflow"))?;
    let n_pre = mul_wad(x_math, y_math)?;
    if n_pre.is_zero() {
        return Ok(U256::zero());
    }
    let y_proxy = mul_div_floor(x_math, y_math, x_post)?;
    if y_proxy.is_zero() {
        return Ok(wad_u256());
    }
    if y_proxy == x_post {
        return Ok(U256::zero());
    }
    let diff = if y_proxy > x_post {
        y_proxy - x_post
    } else {
        x_post - y_proxy
    };
    if diff >= q128() {
        return Ok(wad_u256());
    }
    let diff_sq_wad = mul_wad(diff, diff)?;
    let denom_wad = mul_wad(x_post, y_proxy)?;
    if denom_wad.is_zero() {
        return Ok(U256::zero());
    }
    div_wad(diff_sq_wad, denom_wad)
}

// ---------------------------------------------------------------------------
// Decimal helpers.
// ---------------------------------------------------------------------------

pub fn scale_for_decimals(decimals: u8) -> Result<U256> {
    if decimals > MAX_TOKEN_DECIMALS {
        return Err(anyhow!("equilibra_math: decimals > 18"));
    }
    let mut s = U256::one();
    for _ in 0..(MAX_TOKEN_DECIMALS - decimals) {
        s = s * U256::from(10u64);
    }
    Ok(s)
}

pub fn to_wad_by_scale(amount_raw: U256, scale: U256) -> U256 {
    if scale == u256_one() {
        amount_raw
    } else {
        amount_raw * scale
    }
}

pub fn from_wad_down_by_scale(amount_wad: U256, scale: U256) -> U256 {
    if scale == u256_one() {
        amount_wad
    } else {
        amount_wad / scale
    }
}

pub fn from_wad_up_by_scale(amount_wad: U256, scale: U256) -> Result<U256> {
    if scale == u256_one() {
        return Ok(amount_wad);
    }
    if scale.is_zero() {
        return Err(anyhow!("equilibra_math: from_wad_up_by_scale zero scale"));
    }
    // Plain 256-bit ceiling division — `ceil(a·1/s)` has no 512-bit
    // intermediate, so routing it through `mul_div_ceil` (full_mul +
    // 512→256 reduction) was pure overhead. Bit-identical result.
    let q = amount_wad / scale;
    if (amount_wad % scale).is_zero() {
        Ok(q)
    } else {
        Ok(q + u256_one())
    }
}

// ---------------------------------------------------------------------------
// Solady expWad port — bit-equivalent implementation for EMA decay.

// ---------------------------------------------------------------------------

#[allow(non_snake_case)]
struct LnExpConsts {
    exp_ln2_base: U256,
    exp_half_2_96: U256,
    exp_two_127: U256,
    exp_p_c1: U256,
    exp_p_c2: U256,
    exp_p_c3: U256,
    exp_p_c4: U256,
    exp_p_big_shift: U256,
    exp_q_c1: U256,
    exp_q_c2: U256,
    exp_q_c3: U256,
    exp_q_c4: U256,
    exp_q_c5: U256,
    exp_q_c6: U256,
    exp_final_mul: U256,
    exp_underflow_threshold: U256,
    exp_overflow_threshold: U256,
    exp_scale_96: U256,
}

#[inline(always)]
fn parse_dec(s: &str) -> U256 {
    U256::from_dec_str(s).expect("LnExpConsts decimal literal")
}

static LNE: LazyLock<LnExpConsts> = LazyLock::new(|| LnExpConsts {
    exp_ln2_base: parse_dec("54916777467707473351141471128"),
    exp_half_2_96: U256::one() << 95u32,
    exp_two_127: U256::one() << 127u32,
    exp_p_c1: parse_dec("1346386616545796478920950773328"),
    exp_p_c2: parse_dec("57155421227552351082224309758442"),
    exp_p_c3: parse_dec("94201549194550492254356042504812"),
    exp_p_c4: parse_dec("28719021644029726153956944680412240"),
    exp_p_big_shift: parse_dec("4385272521454847904659076985693276") << 96u32,
    exp_q_c1: parse_dec("2855989394907223263936484059900"),
    exp_q_c2: parse_dec("50020603652535783019961831881945"),
    exp_q_c3: parse_dec("533845033583426703283633433725380"),
    exp_q_c4: parse_dec("3604857256930695427073651918091429"),
    exp_q_c5: parse_dec("14423608567350463180887372962807573"),
    exp_q_c6: parse_dec("26449188498355588339934803723976023"),
    exp_final_mul: parse_dec("3822833074963236453042738258902158003155416615667"),
    exp_underflow_threshold: U256::from(42_139_678_854_452_767_551u128),
    exp_overflow_threshold: U256::from(135_305_999_368_893_231_589u128),
    exp_scale_96: U256::one() << 96u32,
});

#[derive(Debug, Clone, Copy)]
struct I256 {
    neg: bool,
    mag: U256,
}

impl I256 {
    #[inline(always)]
    fn zero() -> Self {
        Self {
            neg: false,
            mag: U256::zero(),
        }
    }
    #[inline(always)]
    fn is_zero(&self) -> bool {
        self.mag.is_zero()
    }
    #[inline(always)]
    fn from_u256(v: U256) -> Self {
        Self { neg: false, mag: v }
    }
    #[inline(always)]
    fn neg_mag(mag: U256) -> Self {
        if mag.is_zero() {
            Self::zero()
        } else {
            Self { neg: true, mag }
        }
    }
    #[inline(always)]
    fn neg_val(self) -> Self {
        if self.mag.is_zero() {
            Self::zero()
        } else {
            Self {
                neg: !self.neg,
                mag: self.mag,
            }
        }
    }

    fn add(a: I256, b: I256) -> Result<I256> {
        if a.neg == b.neg {
            let (sum, overflow) = a.mag.overflowing_add(b.mag);
            if overflow {
                return Err(anyhow!("equilibra_math: i256 add overflow"));
            }
            Ok(if sum.is_zero() {
                Self::zero()
            } else {
                Self {
                    neg: a.neg,
                    mag: sum,
                }
            })
        } else if a.mag >= b.mag {
            let m = a.mag - b.mag;
            Ok(if m.is_zero() {
                Self::zero()
            } else {
                Self { neg: a.neg, mag: m }
            })
        } else {
            let m = b.mag - a.mag;
            Ok(if m.is_zero() {
                Self::zero()
            } else {
                Self { neg: b.neg, mag: m }
            })
        }
    }

    fn sub(a: I256, b: I256) -> Result<I256> {
        Self::add(a, b.neg_val())
    }

    fn mul(a: I256, b: I256) -> Result<I256> {
        if a.is_zero() || b.is_zero() {
            return Ok(Self::zero());
        }
        let prod = a.mag.full_mul(b.mag);
        let m = u512_to_u256(prod)?;
        Ok(Self {
            neg: a.neg ^ b.neg,
            mag: m,
        })
    }

    fn div(a: I256, b: I256) -> Result<I256> {
        if b.is_zero() {
            return Err(anyhow!("equilibra_math: i256 div by zero"));
        }
        if a.is_zero() {
            return Ok(Self::zero());
        }
        let m = a.mag / b.mag;
        Ok(if m.is_zero() {
            Self::zero()
        } else {
            Self {
                neg: a.neg ^ b.neg,
                mag: m,
            }
        })
    }

    fn is_neg(&self) -> bool {
        self.neg && !self.mag.is_zero()
    }
}

fn sar_signed(value: I256, shift: u32) -> I256 {
    if shift == 0 {
        return value;
    }
    if value.mag.is_zero() {
        return I256::zero();
    }
    if !value.neg {
        let m = value.mag >> shift as usize;
        if m.is_zero() {
            I256::zero()
        } else {
            I256 { neg: false, mag: m }
        }
    } else {
        let mask = (U256::one() << shift as usize) - U256::one();
        let has_rounding = !(value.mag & mask).is_zero();
        let mut m = value.mag >> shift as usize;
        if has_rounding {
            m = m + U256::one();
        }
        if m.is_zero() {
            I256::zero()
        } else {
            I256 { neg: true, mag: m }
        }
    }
}

fn exp_wad(x: I256) -> Result<I256> {
    let c = &*LNE;
    if x.is_neg() && x.mag >= c.exp_underflow_threshold {
        return Ok(I256::zero());
    }
    if !x.is_neg() && x.mag >= c.exp_overflow_threshold {
        return Err(anyhow!("equilibra_math: expWad overflow"));
    }

    let scale_96 = I256::from_u256(c.exp_scale_96);
    let wad_i = I256::from_u256(wad_u256());
    let mut x = I256::mul(x, scale_96)?;
    x = I256::div(x, wad_i)?;

    let x_shifted = I256::mul(x, scale_96)?;
    let ln2_i = I256::from_u256(c.exp_ln2_base);
    let quotient = I256::div(x_shifted, ln2_i)?;
    let k_added = I256::add(quotient, I256::from_u256(c.exp_half_2_96))?;
    let k = sar_signed(k_added, 96);
    let k_times_ln2 = I256::mul(k, ln2_i)?;
    x = I256::sub(x, k_times_ln2)?;

    if k.mag >= c.exp_two_127 {
        return Err(anyhow!("equilibra_math: expWad k out of range"));
    }

    let mut y = I256::add(x, I256::from_u256(c.exp_p_c1))?;
    y = sar_signed(I256::mul(y, x)?, 96);
    y = I256::add(y, I256::from_u256(c.exp_p_c2))?;

    let mut p = I256::add(y, x)?;
    p = I256::sub(p, I256::from_u256(c.exp_p_c3))?;
    p = sar_signed(I256::mul(p, y)?, 96);
    p = I256::add(p, I256::from_u256(c.exp_p_c4))?;
    let lhs = I256::mul(p, x)?;
    p = I256::add(lhs, I256::from_u256(c.exp_p_big_shift))?;

    let mut q = I256::sub(x, I256::from_u256(c.exp_q_c1))?;
    q = sar_signed(I256::mul(q, x)?, 96);
    q = I256::add(q, I256::from_u256(c.exp_q_c2))?;
    q = sar_signed(I256::mul(q, x)?, 96);
    q = I256::sub(q, I256::from_u256(c.exp_q_c3))?;
    q = sar_signed(I256::mul(q, x)?, 96);
    q = I256::add(q, I256::from_u256(c.exp_q_c4))?;
    q = sar_signed(I256::mul(q, x)?, 96);
    q = I256::sub(q, I256::from_u256(c.exp_q_c5))?;
    q = sar_signed(I256::mul(q, x)?, 96);
    q = I256::add(q, I256::from_u256(c.exp_q_c6))?;

    let r = I256::div(p, q)?;
    let big_mul = I256::from_u256(c.exp_final_mul);
    let mul_res = I256::mul(r, big_mul)?;
    let shift_amount = if k.is_neg() {
        195i32 + k.mag.low_u32() as i32
    } else {
        195i32 - k.mag.low_u32() as i32
    };
    if shift_amount < 0 {
        return Err(anyhow!("equilibra_math: expWad shift negative"));
    }
    Ok(sar_signed(mul_res, shift_amount as u32))
}

/// `exp(-x_mag_wad)` for an unsigned WAD-scaled magnitude.
pub fn exp_neg_wad(x_mag_wad: U256) -> Result<U256> {
    if x_mag_wad.is_zero() {
        return Ok(wad_u256());
    }
    let signed_neg_x = I256::neg_mag(x_mag_wad);
    let result = exp_wad(signed_neg_x)?;
    if result.is_neg() {
        return Err(anyhow!(
            "equilibra_math: exp_neg_wad produced negative result"
        ));
    }
    Ok(result.mag)
}

/// `exp(+x_mag_wad)` for an unsigned WAD-scaled magnitude — positive
/// counterpart of `exp_neg_wad`, same Solady `expWad` core.
pub fn exp_pos_wad(x_mag_wad: U256) -> Result<U256> {
    if x_mag_wad.is_zero() {
        return Ok(wad_u256());
    }
    let result = exp_wad(I256::from_u256(x_mag_wad))?;
    if result.is_neg() {
        return Err(anyhow!(
            "equilibra_math: exp_pos_wad produced negative result"
        ));
    }
    Ok(result.mag)
}

/// Constants of the Solady `FixedPointMathLib.lnWad` rational
/// approximation, parsed once.
struct LnWadConsts {
    p_c3: U256,
    p_c2: U256,
    p_c1: U256,
    p_c0: U256,
    p_c4: U256,
    p_c5: U256,
    p_c6_shifted: U256,
    q_c0: U256,
    q_tail: [U256; 6],
    final_mul: U256,
    ln2_5p18_2p192: U256,
    offset_5p18_2p192: U256,
}

static LNW: LazyLock<LnWadConsts> = LazyLock::new(|| LnWadConsts {
    p_c3: parse_dec("3273285459638523848632254066296"),
    p_c2: parse_dec("24828157081833163892658089445524"),
    p_c1: parse_dec("43456485725739037958740375743393"),
    p_c0: parse_dec("11111509109440967052023855526967"),
    p_c4: parse_dec("45023709667254063763336534515857"),
    p_c5: parse_dec("14706773417378608786704636184526"),
    p_c6_shifted: parse_dec("795164235651350426258249787498") << 96u32,
    q_c0: parse_dec("5573035233440673466300451813936"),
    q_tail: [
        parse_dec("71694874799317883764090561454958"),
        parse_dec("283447036172924575727196451306956"),
        parse_dec("401686690394027663651624208769553"),
        parse_dec("204048457590392012362485061816622"),
        parse_dec("31853899698501571402653359427138"),
        parse_dec("909429971244387300277376558375"),
    ],
    final_mul: parse_dec("1677202110996718588342820967067443963516166"),
    ln2_5p18_2p192: parse_dec(
        "16597577552685614221487285958193947469193820559219878177908093499208371",
    ),
    offset_5p18_2p192: parse_dec(
        "600920179829731861736702779321621459595472258049074101567377883020018308",
    ),
});

/// Natural logarithm of a WAD-scaled value, WAD-scaled signed result —
/// an operation-for-operation port of Solady
/// `FixedPointMathLib.lnWad` (the (8,8)-term rational approximation on
/// the `(1, 2) · 2^96` reduced range), so a Solidity caller using
/// Solady produces bit-identical values. The assembly's branchless
/// `255 ^ log2(x)` prelude reduces to `255 − floor(log2(x))` here;
/// the equivalence is pinned by the golden vectors in the test module,
/// which were generated from a literal big-int transcription of the
/// assembly.
fn ln_wad(x: U256) -> Result<I256> {
    if x.is_zero() || x.bit(255) {
        return Err(anyhow!("equilibra_math: lnWad undefined for x <= 0"));
    }
    let c = &*LNW;
    let log2 = 255u32 - x.leading_zeros() as u32;
    let r = 255u32 - log2;
    // Reduce to (1, 2) * 2^96: the MSB lands on bit 255, so the EVM
    // `shl` discards nothing.
    let x_red = (x << r as usize) >> 159usize;
    let xi = I256::from_u256(x_red);

    let mut t = sar_signed(I256::mul(I256::add(I256::from_u256(c.p_c3), xi)?, xi)?, 96);
    t = sar_signed(I256::mul(I256::add(I256::from_u256(c.p_c2), t)?, xi)?, 96);
    t = sar_signed(I256::mul(I256::add(I256::from_u256(c.p_c1), t)?, xi)?, 96);
    let mut p = I256::sub(t, I256::from_u256(c.p_c0))?;
    p = I256::sub(sar_signed(I256::mul(p, xi)?, 96), I256::from_u256(c.p_c4))?;
    p = I256::sub(sar_signed(I256::mul(p, xi)?, 96), I256::from_u256(c.p_c5))?;
    // `p` stays in the 2^192 basis here (no shift) — mirrors the
    // assembly, which folds the scale into the final constants.
    p = I256::sub(I256::mul(p, xi)?, I256::from_u256(c.p_c6_shifted))?;

    let mut q = I256::add(I256::from_u256(c.q_c0), xi)?;
    for k in &c.q_tail {
        q = I256::add(I256::from_u256(*k), sar_signed(I256::mul(xi, q)?, 96))?;
    }

    // sdiv truncation toward zero — matches `I256::div`.
    p = I256::div(p, q)?;
    p = I256::mul(p, I256::from_u256(c.final_mul))?;
    let k_term = I256::mul(
        I256::from_u256(c.ln2_5p18_2p192),
        I256::sub(
            I256::from_u256(U256::from(159u32)),
            I256::from_u256(U256::from(r)),
        )?,
    )?;
    p = I256::add(p, k_term)?;
    p = I256::add(p, I256::from_u256(c.offset_5p18_2p192))?;
    Ok(sar_signed(p, 174))
}

/// Encode a positive WAD price as an unbiased logarithm, exactly like Solady.
/// Every supported uint256 price logarithm fits in i128; products use I256.
pub fn price_to_ema_log(price_wad: U256) -> Result<i128> {
    if price_wad > (U256::MAX >> 1) {
        return Err(anyhow!("equilibra_math: math out of range"));
    }
    ema_log_to_i128(ln_wad(price_wad)?)
}

fn ema_log_from_i128(log: i128) -> I256 {
    if log < 0 {
        I256::neg_mag(U256::from(log.unsigned_abs()))
    } else {
        I256::from_u256(U256::from(log as u128))
    }
}

fn ema_log_to_i128(log: I256) -> Result<i128> {
    if log.mag > U256::from(i128::MAX as u128) {
        return Err(anyhow!("equilibra_math: EMA logarithm out of range"));
    }
    let value = log.mag.as_u128() as i128;
    Ok(if log.neg { -value } else { value })
}

/// Decode for consumers only. Never feed this rounded price back into EMA state.
pub fn ema_log_to_price(ema_log_wad: i128) -> Result<U256> {
    Ok(exp_wad(ema_log_from_i128(ema_log_wad))?
        .mag
        .max(U256::one()))
}

/// Persistent log-domain step, with signed division truncating toward zero.
pub fn geometric_ema_log_step(ema_log_wad: i128, spot_wad: U256, alpha_wad: U256) -> Result<i128> {
    let wad = wad_u256();
    if alpha_wad > wad {
        return Err(anyhow!("equilibra_math: geometric ema alpha above WAD"));
    }
    let old = ema_log_from_i128(ema_log_wad);
    let target = ema_log_from_i128(price_to_ema_log(spot_wad)?);
    let delta = I256::sub(target, old)?;
    let scaled = I256::div(
        I256::mul(delta, I256::from_u256(wad - alpha_wad))?,
        I256::from_u256(wad),
    )?;
    ema_log_to_i128(I256::add(old, scaled)?)
}

// ---------------------------------------------------------------------------
// Sanity tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod solver_convergence_tests {
    use super::*;
    use num_bigint::BigUint;

    const GOLDEN_ALPHA: u128 = 990_000_000_000_000_000;

    fn amount(v: &str) -> U256 {
        U256::from_dec_str(v).unwrap()
    }

    fn exact_k(x: U256, y: U256, l: U256, a: U256, lambda: U256) -> (BigUint, BigUint) {
        let [x, y, l, a, lambda, w] =
            [x, y, l, a, lambda, wad_u256()].map(|v| v.to_string().parse::<BigUint>().unwrap());
        let p = &x * &y;
        let diff = if x >= y { &x - &y } else { &y - &x };
        let d = &w * &p + &lambda * &diff * &diff;
        // 2D - 2ap is nonnegative because D >= Wp and a <= W.
        let q128 = BigUint::from(1u8) << 128usize;
        let numerator =
            &p * (((&d << 1usize) - ((&a * &p) << 1usize)) * &q128 + &a * &l * (&x + &y) * &w);
        (numerator << QUOTE_K_EXTRA_BITS, 2u32 * &w * d * q128)
    }

    #[test]
    fn q128_micro_quote_is_within_one_unit_of_the_exact_rational_bracket() {
        let x = amount("1000000000000000000000000000000");
        let y = x * 20;
        let a = U256::from(A_MAX_WAD);
        let lambda = U256::from(LAMBDA_MIN_WAD);
        let (quote, iters, l) =
            quote_exact_in_forward_with_depth(x, y, U256::one(), a, lambda).unwrap();
        assert_eq!((quote, iters), (U256::one(), 2));
        let (pre_n, pre_d) = exact_k(x, y, l, a, lambda);
        let (one_n, one_d) = exact_k(x + 1, y - 1, l, a, lambda);
        let (two_n, two_d) = exact_k(x + 1, y - 2, l, a, lambda);
        assert!(&one_n * &pre_d > &pre_n * &one_d);
        assert!(&two_n * &pre_d < &pre_n * &two_d);
    }

    #[test]
    fn q128_lower_bound_covers_positive_negative_and_extreme_weight_branches() {
        for (x, y, scale) in [
            (
                amount("1000000000000000000000000000000"),
                amount("20000000000000000000000000000000"),
                1u64,
            ),
            (
                amount("1000000000000000000000000000000"),
                amount("20000000000000000000000000000000"),
                10,
            ),
            (U256::from(u128::MAX), U256::one(), 1),
            (U256::from(WAD), U256::from(WAD), 1),
        ] {
            let a = U256::from(A_MAX_WAD);
            let lambda = U256::from(LAMBDA_MIN_WAD);
            let l = solve_l_from_state(x, y, a, lambda).unwrap() / scale;
            let lo = compute_quote_k_from_l(x, y, l, a, lambda).unwrap();
            let (n, d) = exact_k(x, y, l, a, lambda);
            assert!(lo.to_string().parse::<BigUint>().unwrap() * d <= n);
        }
        let enormous = U256::one() << 200;
        assert!(compute_quote_k_from_l(
            enormous,
            U256::one(),
            U256::one(),
            U256::from(A_MIN_WAD),
            U256::from(LAMBDA_MIN_WAD)
        )
        .is_err());
    }

    #[test]
    fn solver_quotes_match_solidity_vectors() {
        let cases: Vec<(bool, String, String, String, String, String, String, usize)> =
            serde_json::from_str(include_str!(
                "../../tests/fixtures/equilibra-solver-quotes.json"
            ))
            .expect("shared Solidity/Rust solver vectors");
        for (exact_out, x, y, delta, a, lambda, expected, iters) in cases {
            let quote = if exact_out {
                quote_exact_out_forward
            } else {
                quote_exact_in_forward
            };
            assert_eq!(
                quote(
                    amount(&x),
                    amount(&y),
                    amount(&delta),
                    amount(&a),
                    amount(&lambda)
                )
                .unwrap(),
                (amount(&expected), iters as u32),
            );
        }
    }

    #[test]
    fn unchanged_counterpart_exits_match_solidity_before_and_after_twelve() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/equilibra-fixed-point-quotes.json"
        ))
        .unwrap();
        assert_eq!(cases.len(), 24);
        for case in cases {
            let value = |name: &str| amount(case[name].as_str().unwrap());
            let (x, y, delta, a, lambda) = (
                value("x"),
                value("y"),
                value("amount"),
                value("a"),
                value("lambda"),
            );
            let exact_out = case["exactOut"].as_bool().unwrap();
            let expected = value("expected");
            let iterations = case["iterations"].as_u64().unwrap() as u32;
            let quote = if exact_out {
                quote_exact_out_forward
            } else {
                quote_exact_in_forward
            };
            assert_eq!(
                quote(x, y, delta, a, lambda).unwrap(),
                (expected, iterations),
                "{case}"
            );
            let depth = solve_l_from_state(x, y, a, lambda).unwrap();
            let context = SolverContext {
                fixed_axis: if exact_out {
                    y - delta - (delta / U256::from(99_999_999u64)).max(U256::one())
                } else {
                    x + delta
                },
                target: compute_quote_k_from_l(x, y, depth, a, lambda).unwrap(),
                a,
                lambda,
                depth,
                previous: if exact_out { x } else { y },
                exact_out,
            };
            let b = if exact_out {
                x + value("unadjusted")
            } else {
                y - value("unadjusted")
            };
            let k = context.compute_k(b).unwrap();
            if case["exit"].as_str() == Some("equalK") {
                assert_eq!(k, context.target, "{case}");
                continue;
            }
            assert_eq!(case["exit"].as_str(), Some("unchanged"), "{case}");
            let before = value("previousCounterpart");
            let k_before = context.compute_k(before).unwrap();
            assert_ne!(b, before, "{case}");
            assert_ne!(k, context.target, "{case}");
            let difference = |u: U256, v: U256| if u >= v { u - v } else { v - u };
            if case["zeroDk"].as_bool().unwrap() {
                assert_eq!(k, k_before, "{case}");
            } else {
                assert_ne!(k, k_before, "{case}");
                assert!(
                    mul_div_floor(
                        difference(k, context.target),
                        difference(b, before),
                        difference(k, k_before)
                    )
                    .unwrap()
                    .is_zero(),
                    "{case}"
                );
            }
        }
    }

    #[test]
    fn former_late_zero_input_case_now_converges_in_two_iterations() {
        let x = U256::from(500_000u64) * wad_u256();
        let result = quote_exact_out_forward(
            x,
            x * 20,
            U256::one(),
            U256::from(GOLDEN_ALPHA),
            U256::from(LAMBDA_MIN_WAD),
        )
        .unwrap();
        assert_eq!(result, (U256::one(), 2));
    }

    fn adjusted_quote(raw: U256, exact_out: bool) -> U256 {
        if raw.is_zero() {
            return raw;
        }
        let margin = (raw / U256::from(100_000_000u64)).max(U256::one());
        if exact_out {
            raw
        } else {
            raw - margin
        }
    }

    #[test]
    fn curve_seed_floors_only_the_near_cancelled_linear_estimate() {
        for (x, y, delta, a, linear) in [
            (
                amount("3072000000000000000000"),
                amount("1024000000000000000000"),
                amount("1024013056132748240752"),
                U256::from(A_MAX_WAD),
                true,
            ),
            (
                amount("5000000000000000000000"),
                amount("1666666666666666666666"),
                amount("4950000000000000000000"),
                U256::from(990_000_000_000_000_000u128),
                false,
            ),
        ] {
            let lambda = U256::from(LAMBDA_MIN_WAD);
            let depth = solve_l_from_state(x, y, a, lambda).unwrap();
            let context = SolverContext {
                fixed_axis: x + delta,
                target: compute_quote_k_from_l(x, y, depth, a, lambda).unwrap(),
                a,
                lambda,
                depth,
                previous: y,
                exact_out: false,
            };
            let cp = mul_div_floor(x, y, context.fixed_axis).unwrap();
            let floor = cp / U256::from(1000u64);
            let seed = curve_seed(cp, &context).unwrap();
            if linear {
                assert_eq!(seed, floor);
            } else {
                assert!(
                    seed < floor,
                    "the tail must retain its smaller initial guess"
                );
            }
        }
    }

    #[test]
    fn former_fixed_points_now_resolve_with_the_curve_seed() {
        assert_eq!(
            quote_exact_in_forward(
                amount("165617785305"),
                amount("378632966091"),
                amount("379427672605"),
                U256::from(A_MAX_WAD),
                U256::from(LAMBDA_MIN_WAD)
            )
            .unwrap(),
            (adjusted_quote(amount("378356812505"), false), 7)
        );
        assert_eq!(
            quote_exact_in_forward(
                amount("114192734020"),
                amount("218001003310"),
                amount("241286899325"),
                U256::from(990_000_000_000_000_000u128),
                U256::from(1_000_000_000_000_000u128)
            )
            .unwrap(),
            (adjusted_quote(amount("213593248705"), false), 7)
        );
    }

    #[test]
    fn local_certificate_keeps_both_residual_sides_and_rejects_distant_candidates() {
        let b = U256::from(1_000u64) * wad_u256();
        let a = U256::from(GOLDEN_ALPHA);
        let lambda = U256::from(LAMBDA_MIN_WAD);
        let context = SolverContext {
            fixed_axis: b,
            target: compute_k_from_l(
                b,
                b,
                mul_div_floor(b, q128(), wad_u256()).unwrap(),
                a,
                lambda,
            )
            .unwrap(),
            a,
            lambda,
            depth: mul_div_floor(b, q128(), wad_u256()).unwrap(),
            previous: b * 2,
            exact_out: false,
        };
        let low = b - U256::from(2u8);
        let high = b + U256::from(2u8);
        let epsilon = U256::from(4u8);
        assert!(context.compute_k(low).unwrap() < context.target);
        assert!(context.compute_k(high).unwrap() > context.target);
        assert_eq!(context.certify(b, context.target, epsilon).unwrap(), b);
        assert_eq!(
            context
                .certify(low, context.compute_k(low).unwrap(), epsilon)
                .unwrap(),
            low
        );
        assert_eq!(
            context
                .certify(high, context.compute_k(high).unwrap(), epsilon)
                .unwrap(),
            high
        );
        let distant = b + U256::from(100u8);
        assert!(context
            .certify(distant, context.compute_k(distant).unwrap(), U256::one())
            .unwrap()
            .is_zero());
    }

    #[test]
    fn formerly_exhausted_exact_in_quantization_case_now_converges() {
        let x = amount("1000000000000000000000000000000");
        let y = x / 20;
        let dx = U256::from(1_000_000_000_000u64);
        let a = U256::from(GOLDEN_ALPHA);
        let lambda = U256::from(16_780_000_000_000_000u64);
        let (quote, iters) = quote_exact_in_forward(x, y, dx, a, lambda).unwrap();
        assert!(!quote.is_zero());
        assert!(iters <= MAX_SECANT_ITER);
    }

    #[test]
    fn formerly_exhausted_exact_out_quantization_case_now_converges() {
        let x = amount("1000000000000000000000000000000");
        let result = quote_exact_out_forward(
            x,
            x * 20,
            U256::from(1_000_000_000_000u64),
            U256::from(GOLDEN_ALPHA),
            U256::from(LAMBDA_MIN_WAD),
        )
        .unwrap();
        assert!(!result.0.is_zero());
        assert!(result.1 <= MAX_SECANT_ITER);
    }

    #[test]
    fn cap_best_rejects_error_outside_one_ten_thousandth_percent() {
        let a = U256::from(A_MAX_WAD);
        let lambda = U256::from(1_000_000_000_000u64);
        let x = amount("950238932273753758005801");
        let y = amount("50000000000000000000000");
        let dx = amount("474881901654989376525315");
        let depth = solve_l_from_state(x, y, a, lambda).unwrap();
        let context = SolverContext {
            fixed_axis: x + dx,
            target: compute_quote_k_from_l(x, y, depth, a, lambda).unwrap(),
            a,
            lambda,
            depth,
            previous: y,
            exact_out: false,
        };
        let b = amount("6464685150222072341");
        let k = context.compute_k(b).unwrap();
        assert!(context
            .certify(b, k, context.quote_epsilon(b, CAP_QUOTE_EPSILON_DENOM))
            .unwrap()
            .is_zero());
        assert_eq!(
            quote_exact_in_forward(x, y, dx, a, lambda).unwrap(),
            (adjusted_quote(amount("49996645302928404499560"), false), 4)
        );
    }

    #[test]
    fn quote_tolerances_use_quote_amount_in_both_directions_and_keep_one_unit_floor() {
        let mut context = SolverContext {
            fixed_axis: U256::one(),
            target: U256::one(),
            a: U256::one(),
            lambda: U256::one(),
            depth: U256::one(),
            previous: U256::from(2_000_001u64),
            exact_out: false,
        };
        for exact_out in [false, true] {
            context.exact_out = exact_out;
            let b = if exact_out {
                context.previous + 1_000_001
            } else {
                U256::from(1_000_000u64)
            };
            assert_eq!(
                context.quote_epsilon(b, CAP_QUOTE_EPSILON_DENOM),
                U256::one()
            );
            assert_eq!(
                context.quote_epsilon(context.previous, CAP_QUOTE_EPSILON_DENOM),
                U256::one()
            );
        }
    }

    #[test]
    fn common_margin_keeps_one_unit_minimum_at_the_new_rate() {
        let previous = U256::from(1_000_000_000u64);
        let mut c = SolverContext {
            fixed_axis: U256::one(),
            target: U256::one(),
            a: U256::one(),
            lambda: U256::one(),
            depth: U256::one(),
            previous,
            exact_out: false,
        };
        for exact_out in [false, true] {
            c.exact_out = exact_out;
            for (amount, expected) in [
                (0u64, 1u64),
                (1, 1),
                (999_999, 1),
                (99_999_999, 1),
                (100_000_000, 1),
                (199_999_999, 1),
                (200_000_000, 2),
                (999_999_999, 9),
            ] {
                let b = if exact_out {
                    previous + amount
                } else {
                    previous - amount
                };
                assert_eq!(c.quote_epsilon(b, QUOTE_MARGIN_DENOM), U256::from(expected));
            }
        }
    }

    #[test]
    fn last_iteration_keeps_fast_exits_and_certifies_cap_candidates() {
        // Compile-time test budgets exercise the SAME private algorithm;
        // production callers have no runtime budget setting and use 40.
        let x = U256::from(500_000u64) * wad_u256();
        let a = U256::from(GOLDEN_ALPHA);
        // Pin the curve of these exact iteration/result regressions.
        let lambda = U256::from(1_000_000_000_000_000u128);
        let depth = solve_l_from_state(x, x, a, lambda).unwrap();
        let target = compute_quote_k_from_l(x, x, depth, a, lambda).unwrap();
        let early = SolverContext {
            fixed_axis: x + x / 100,
            target,
            a,
            lambda,
            depth,
            previous: x,
            exact_out: false,
        };
        let seed = mul_div_floor(x, x, early.fixed_axis).unwrap();
        assert_eq!(
            solve_unadjusted_counterpart::<3>(seed, &early).unwrap(),
            (x - amount("4999010058210050000126"), 3)
        );
        // The new seed itself already satisfies a terminal certificate.
        // A zero test budget may accept it only through that same bracket check.
        let (initial, used) = solve_unadjusted_counterpart::<0>(seed, &early).unwrap();
        assert_eq!(used, 0);
        let epsilon = early.quote_epsilon(initial, CAP_QUOTE_EPSILON_DENOM);
        assert!(early.compute_k(initial + epsilon).unwrap() >= early.target);
        assert!(early.compute_k(initial - epsilon).unwrap() <= early.target);

        let y = amount("413223140495867768595041");
        let a = U256::from(999_750_060_000_000_000u128);
        let depth = solve_l_from_state(x, y, a, lambda).unwrap();
        let target = compute_quote_k_from_l(x, y, depth, a, lambda).unwrap();
        let confirmed = SolverContext {
            fixed_axis: x + U256::from(495_000u64) * wad_u256(),
            target,
            a,
            lambda,
            depth,
            previous: y,
            exact_out: false,
        };
        let seed = mul_div_floor(x, y, confirmed.fixed_axis).unwrap();
        assert_eq!(
            solve_unadjusted_counterpart::<8>(seed, &confirmed).unwrap(),
            (y - amount("403853711244928021381160"), 8)
        );

        let y = x * 20;
        let a = U256::from(GOLDEN_ALPHA);
        let depth = solve_l_from_state(x, y, a, lambda).unwrap();
        let target = compute_quote_k_from_l(x, y, depth, a, lambda).unwrap();
        let stagnating = SolverContext {
            fixed_axis: y - U256::one(),
            target,
            a,
            lambda,
            depth,
            previous: x,
            exact_out: true,
        };
        let seed = mul_div_floor(x, y, stagnating.fixed_axis)
            .unwrap()
            .max(x + U256::one());
        assert_eq!(
            solve_unadjusted_counterpart::<40>(seed, &stagnating).unwrap(),
            (x, 2)
        );
        assert_eq!(
            solve_unadjusted_counterpart::<2>(seed, &stagnating).unwrap(),
            (x, 2)
        );
    }

    #[test]
    fn output_margin_is_applied_once_and_exact_out_has_no_input_surcharge() {
        let cases = [
            (
                "500000000000000000000000",
                "500000000000000000000000",
                "5000000000000000000000",
                GOLDEN_ALPHA,
                1_000_000_000_000_000,
                false,
            ),
            (
                "500000000000000000000000",
                "500000000000000000000000",
                "5000000000000000000000",
                GOLDEN_ALPHA,
                1_000_000_000_000_000,
                true,
            ),
            (
                "50000000000000000000",
                "1020611158635000000000000",
                "102061114000000000000",
                A_MAX_WAD,
                LAMBDA_MIN_WAD,
                true,
            ),
            (
                "500000000000000000000000",
                "10000000000000000000000000",
                "1",
                GOLDEN_ALPHA,
                1_000_000_000_000_000,
                true,
            ),
        ];
        for (x, y, delta, a, lambda, exact_out) in cases {
            let (x, y, delta, a, lambda) = (
                amount(x),
                amount(y),
                amount(delta),
                U256::from(a),
                U256::from(lambda),
            );
            let depth = solve_l_from_state(x, y, a, lambda).unwrap();
            let c = SolverContext {
                fixed_axis: if exact_out {
                    y - delta - (delta / U256::from(99_999_999u64)).max(U256::one())
                } else {
                    x + delta
                },
                previous: if exact_out { x } else { y },
                exact_out,
                target: compute_quote_k_from_l(x, y, depth, a, lambda).unwrap(),
                a,
                lambda,
                depth,
            };
            let cp = mul_div_floor(x, y, c.fixed_axis).unwrap();
            let cp = if exact_out {
                cp.max(x + U256::one())
            } else {
                cp.max(U256::one())
            };
            let (raw, raw_iters) = solve_unadjusted_counterpart::<40>(cp, &c).unwrap();
            let (adjusted, iters) = solve_counterpart::<40>(cp, &c).unwrap();
            let amount = if exact_out {
                raw.saturating_sub(x)
            } else {
                y.saturating_sub(raw)
            };
            let margin = if exact_out || amount.is_zero() {
                U256::zero()
            } else {
                (amount / U256::from(100_000_000u64)).max(U256::one())
            };
            assert_eq!(adjusted, raw + margin);
            assert_eq!(iters, raw_iters);
            let (public, public_iters) = if exact_out {
                quote_exact_out_forward(x, y, delta, a, lambda)
            } else {
                quote_exact_in_forward(x, y, delta, a, lambda)
            }
            .unwrap();
            let expected = if exact_out {
                raw.saturating_sub(x)
            } else {
                y.saturating_sub(adjusted)
            };
            assert_eq!((public, public_iters), (expected, iters));
        }
    }

    #[test]
    fn continues_past_the_former_iteration_thirteen_approximate_exit() {
        let (output, iterations) = quote_exact_in_forward(
            amount("1005062000000000000000000"),
            amount("5000000000000000000000"),
            amount("4999000000000000000000"),
            amount("999750000000000000"),
            amount("50000000000000"),
        )
        .unwrap();
        assert_eq!(iterations, 14);
        assert_eq!(output / amount("10000000000000000"), U256::from(132129u64));
    }

    #[test]
    fn exact_out_trial_output_is_the_integer_inverse_of_the_output_margin() {
        assert_eq!(QUOTE_MARGIN_DENOM, 100_000_000);
        for requested in 1u64..400_001 {
            let trial = requested + (requested / (QUOTE_MARGIN_DENOM - 1)).max(1);
            assert_eq!(trial - (trial / QUOTE_MARGIN_DENOM).max(1), requested);
        }
        for quotient in [1u64, 2, 3, 1_000_000, 100_000_000] {
            for offset in [-1i64, 0, 1, 99_999_998] {
                let requested = (quotient * 99_999_999).checked_add_signed(offset).unwrap();
                let trial = requested + (requested / 99_999_999).max(1);
                assert_eq!(trial - (trial / 100_000_000).max(1), requested);
            }
        }
        let reserve = U256::from(100_000u64) * wad_u256();
        let requested = reserve - reserve / U256::from(100_000_000u64);
        let error = quote_exact_out_forward(
            reserve,
            reserve,
            requested,
            U256::from(GOLDEN_ALPHA),
            U256::from(LAMBDA_MIN_WAD),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "equilibra_math: quoteExactOutForward dy >= y (insufficient liquidity)"
        );
    }

    #[test]
    fn cap_certificate_is_one_ten_thousandth_percent_without_padding() {
        let b = U256::from(1_000u64) * wad_u256();
        let a = U256::from(GOLDEN_ALPHA);
        let lambda = U256::from(LAMBDA_MIN_WAD);
        let depth = solve_l_from_state(b, b, a, lambda).unwrap();
        let c = SolverContext {
            fixed_axis: b,
            target: compute_quote_k_from_l(b, b, depth, a, lambda).unwrap(),
            a,
            lambda,
            depth,
            previous: b * 2,
            exact_out: false,
        };
        for candidate in [b - b / 2_000_000, b + b / 2_000_000] {
            let k = c.compute_k(candidate).unwrap();
            assert_eq!(
                c.certify(
                    candidate,
                    k,
                    c.quote_epsilon(candidate, CAP_QUOTE_EPSILON_DENOM)
                )
                .unwrap(),
                candidate
            );
        }
        let candidate = b + b / 200_000;
        let k = c.compute_k(candidate).unwrap();
        assert_eq!(
            c.certify(
                candidate,
                k,
                c.quote_epsilon(candidate, CAP_QUOTE_EPSILON_DENOM)
            )
            .unwrap(),
            U256::zero()
        );
        assert_eq!(
            c.certify(candidate, k, c.quote_epsilon(candidate, 100_001))
                .unwrap(),
            candidate
        );
        let (raw, _) = solve_unadjusted_counterpart::<0>(b, &c).unwrap();
        let (adjusted, iterations) = solve_counterpart::<0>(b, &c).unwrap();
        assert_eq!(iterations, 0);
        assert_eq!(adjusted, raw + c.quote_epsilon(raw, QUOTE_MARGIN_DENOM));
    }

    #[test]
    fn quote_depth_is_the_original_depth_in_both_directions() {
        let x = U256::from(500_000u64) * wad_u256();
        let y = x / 10;
        let a = U256::from(GOLDEN_ALPHA);
        let lambda = U256::from(LAMBDA_MIN_WAD);
        let expected = solve_l_from_state(x, y, a, lambda).unwrap();
        let (_, _, forward) = quote_exact_in_forward_with_depth(x, y, x / 10, a, lambda).unwrap();
        let (_, _, reverse) = quote_exact_in_forward_with_depth(y, x, y / 10, a, lambda).unwrap();
        assert_eq!(forward, expected);
        assert_eq!(reverse, expected);
    }

    #[test]
    fn raised_alpha_quotes_match_independent_q128_k_bisection() {
        // Independent root search in the SAME frozen-L Q128 lower-bound K.
        // This checks the nominal policy on substantial trades; it is not
        // a global continuous-root bound for one-raw-unit dust.
        fn reference(
            fixed: U256,
            previous: U256,
            l: U256,
            target: U256,
            a: U256,
            lambda: U256,
        ) -> U256 {
            let mut low = U256::one();
            let mut high = previous * 2;
            while compute_quote_k_from_l(fixed, high, l, a, lambda).unwrap() < target {
                high *= 2;
            }
            while low < high {
                let mid = low + (high - low) / 2;
                if compute_quote_k_from_l(fixed, mid, l, a, lambda).unwrap() < target {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            low
        }
        assert_eq!(A_MAX_WAD, WAD - 1);
        let base = U256::from(500_000u128 * WAD);
        // Keep this original continuous-reference grid; current endpoints
        // are exercised separately, including their bounded refusals.
        let lambda = U256::from(1_000_000_000_000_000u128);
        let mut samples = 0;
        for a in [
            999_750_062_484_378_906u128,
            999_950_002_499_875_007,
            A_MAX_WAD,
        ] {
            let a = U256::from(a);
            for (num, den) in [(1u64, 10u64), (1, 2), (1, 1), (2, 1), (10, 1)] {
                for reverse in [false, true] {
                    let pair = (base, base * num / den);
                    let (x, y) = if reverse { (pair.1, pair.0) } else { pair };
                    let l = solve_l_from_state(x, y, a, lambda).unwrap();
                    let target = compute_quote_k_from_l(x, y, l, a, lambda).unwrap();
                    for percent in [1u64, 10, 99] {
                        for exact_out in [false, true] {
                            let amount = if exact_out { y } else { x } * percent / 100;
                            let (got, iters, expected) = if exact_out {
                                let (got, iters) =
                                    quote_exact_out_forward(x, y, amount, a, lambda).unwrap();
                                (
                                    got,
                                    iters,
                                    reference(
                                        y - amount
                                            - (amount / U256::from(99_999_999u64)).max(U256::one()),
                                        x,
                                        l,
                                        target,
                                        a,
                                        lambda,
                                    ) - x,
                                )
                            } else {
                                let (got, iters) =
                                    quote_exact_in_forward(x, y, amount, a, lambda).unwrap();
                                (
                                    got,
                                    iters,
                                    y - reference(x + amount, y, l, target, a, lambda),
                                )
                            };
                            assert!(!got.is_zero() && !expected.is_zero());
                            assert!(iters <= MAX_SECANT_ITER);
                            let error = if got >= expected {
                                got - expected
                            } else {
                                expected - got
                            };
                            assert!(error <= expected / 10_000 + 1, "a={a} reverse={reverse} percent={percent} exact_out={exact_out}: got={got}, reference={expected}");
                            samples += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(samples, 180);
    }
}

#[cfg(test)]
mod numeric_domain_tests {
    use super::*;

    #[test]
    fn diagonal_domain_matches_off_diagonal_product_limit() {
        let q = q128();
        for a in [A_MIN_WAD, 990_000_000_000_000_000, A_MAX_WAD] {
            for lambda in [LAMBDA_MIN_WAD, 1_000_000_000_000_000, LAMBDA_MAX_WAD] {
                assert_eq!(
                    solve_l_from_state(q - 1, q - 1, a.into(), lambda.into()).unwrap(),
                    mul_div_floor(q - 1, q, wad_u256()).unwrap()
                );
                for invalid in [q, q + 1, U256::exp10(40)] {
                    assert!(
                        solve_l_from_state(invalid, invalid, a.into(), lambda.into())
                            .unwrap_err()
                            .to_string()
                            .contains("invariant product overflow")
                    );
                }
                // No per-coordinate uint128 cap: x*y fits and |x-y| < Q.
                assert!(solve_l_from_state(q / 2, q + q / 4, a.into(), lambda.into()).is_ok());
                assert_eq!(
                    solve_l_from_state(q + 1, U256::zero(), a.into(), lambda.into()).unwrap(),
                    U256::zero()
                );
            }
        }
    }

    #[test]
    fn full_width_price_and_ema_match_shared_solidity_vectors() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/equilibra-numeric-domain.json"
        ))
        .unwrap();
        let n = |v: &serde_json::Value| U256::from_dec_str(v.as_str().unwrap()).unwrap();
        let price = &data["largeMarginalPrice"];
        let y = mul_div_floor(n(&price["yWad"]), wad_u256(), n(&price["priceScaleWad"])).unwrap();
        assert_eq!(
            marginal_price_from_state(
                n(&price["xMath"]),
                y,
                n(&data["aWad"]),
                n(&data["lambdaWad"])
            )
            .unwrap(),
            n(&price["expected"])
        );
        let ema = &data["fullWidthEma"];
        let anchor = U256::from(ema["anchorCoefficient"].as_u64().unwrap())
            * U256::exp10(ema["anchorExponent"].as_u64().unwrap() as usize);
        assert!(anchor.checked_mul(wad_u256()).is_none());
        for spot in [anchor * 2, anchor / 2] {
            let target = price_to_ema_log(spot).unwrap();
            let out = geometric_ema_log_step(price_to_ema_log(anchor).unwrap(), spot, U256::zero())
                .unwrap();
            assert_eq!(out, target);
            let decoded = ema_log_to_price(out).unwrap();
            let error = if decoded > spot {
                decoded - spot
            } else {
                spot - decoded
            };
            assert!(error <= spot / U256::exp10(15));
        }
    }

    #[test]
    fn cp_fee_proxy_saturates_only_the_extreme_distance_branches() {
        let w = wad_u256();
        let r = U256::from(500_000u64) * w;
        let dx = q128() + U256::exp10(15) - r;
        assert_eq!(predict_post_distance_cp(r, r, dx).unwrap(), w);
        assert_eq!(predict_post_distance_cp(w, w, w * w).unwrap(), w);
        assert_eq!(
            predict_post_distance_cp(2.into(), 2.into(), 1.into()).unwrap(),
            U256::zero()
        );
        for dx in [1u64, 1_000, 50_000] {
            let dx = U256::from(dx) * w;
            let post = r + dx;
            let proxy = r * r / post;
            let difference = post - proxy;
            let expected = (difference * difference / w) * w / (post * proxy / w);
            assert_eq!(predict_post_distance_cp(r, r, dx).unwrap(), expected);
        }
    }
}

#[cfg(test)]
mod sanity_tests {
    use super::*;

    fn wad_of(v: u128) -> U256 {
        U256::from(v) * wad_u256()
    }

    fn a_default() -> U256 {
        U256::from(500_000_000_000_000_000u128) // 0.5 · W
    }
    fn lambda_default() -> U256 {
        U256::from(10_000_000_000_000_000u128) // 0.01 · W
    }

    #[test]
    fn distance_state_centre_is_zero() {
        let d = distance_state_wad(wad_u256(), wad_u256()).unwrap();
        assert_eq!(d, U256::zero());
    }

    #[test]
    fn distance_state_symmetric() {
        let d1 = distance_state_wad(wad_of(2), wad_of(1)).unwrap();
        let d2 = distance_state_wad(wad_of(1), wad_of(2)).unwrap();
        assert_eq!(d1, d2);
    }

    #[test]
    fn marginal_price_at_anchor_is_one() {
        let p = marginal_price_from_state(wad_u256(), wad_u256(), a_default(), lambda_default())
            .unwrap();
        assert_eq!(p, wad_u256());
    }

    #[test]
    fn marginal_price_full_width_matches_solidity_numeric_limit_state() {
        // Native MathRange.test.ts swaps leave these reserves. Both orientations
        // must match Solidity; a sub-WAD price still floors to zero by design.
        let large = U256::from_dec_str("340214310447554775770681932510281857812").unwrap();
        let small = U256::from_dec_str("5000000000735191182").unwrap();
        for (x, y, expected) in [
            (large, small, U256::zero()),
            (
                small,
                large,
                U256::from_dec_str("68042858150597798842550535983196953019").unwrap(),
            ),
        ] {
            assert_eq!(
                marginal_price_from_state(
                    x,
                    y,
                    U256::from(990_000_000_000_000_000u128),
                    U256::from(1_000_000_000_000_000u64)
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn solve_l_at_anchor_recovers_balance() {
        // x = y ⇒ L = x exactly.
        let l = solve_l_from_state(wad_u256(), wad_u256(), a_default(), lambda_default()).unwrap();
        assert_eq!(l, q128());
    }

    #[test]
    fn k_lies_on_w_l_squared_level_set() {
        // For any reachable state, K(state, L_solve) ≈ W·L² within
        // sub-ppt tolerance.
        let cases = [
            (wad_of(1_000_000), wad_of(1_500_000)),
            (wad_of(1_500_000), wad_of(1_000_000)),
        ];
        for (x, y) in cases {
            let l = solve_l_from_state(x, y, a_default(), lambda_default()).unwrap();
            let k = compute_k(x, y, a_default(), lambda_default()).unwrap();
            let target =
                mul_div_floor(mul_div_floor(l, l, q128()).unwrap(), wad_u256(), q128()).unwrap();
            let diff = if k > target { k - target } else { target - k };
            let tolerance = target / U256::from(1_000_000_000_000u64) + U256::from(1_000u64);
            assert!(diff <= tolerance, "K vs W·L²: diff={diff} target={target}");
        }
    }

    #[test]
    fn smoothstep_disabled_ramp_returns_ceiling() {
        let got = smoothstep_fee_wad(
            U256::from(42u64),
            U256::zero(),
            20 * 100_000_000_000_000,
            100 * 100_000_000_000_000,
        )
        .unwrap();
        assert_eq!(got, 100 * 100_000_000_000_000);
    }

    #[test]
    fn smoothstep_midpoint_matches_formula() {
        let ramp = WAD;
        let dist = WAD / 2;
        let bps_wad: u128 = 100_000_000_000_000;
        let got = smoothstep_fee_wad(
            U256::from(dist),
            U256::from(ramp),
            20 * bps_wad,
            100 * bps_wad,
        )
        .unwrap();
        // r = 0.5 ⇒ m = 0.75 ⇒ rate = (20 + 0.75 · 80) bps = 80 bps in WAD.
        assert_eq!(got, 80 * bps_wad);
    }

    #[test]
    fn coord_change_diagonal_at_anchor() {
        // Under the asymmetric coord change `xMath = xWad`,
        // `yMath = yWad·WAD/priceScale`, the math state is on the
        // diagonal (`xMath == yMath`) iff `yWad/xWad == priceScale`.
        let price_scale = wad_of(5);
        let x_wad = wad_of(7);
        // priceScaleWad = yWad/xWad ⇒ yWad = priceScale·xWad/WAD.
        let y_wad = mul_wad(x_wad, price_scale).unwrap();
        let (x_math, y_math) = to_math_space(x_wad, y_wad, price_scale).unwrap();
        // Up to one wei of floor rounding in `divWad`.
        let diff = if x_math > y_math {
            x_math - y_math
        } else {
            y_math - x_math
        };
        assert!(
            diff <= U256::one(),
            "diagonal at anchor: xMath={x_math}, yMath={y_math}, diff={diff}"
        );
    }

    #[test]
    fn coord_change_roundtrip_down() {
        // `from_math_space_down(to_math_space(x, y, p), p) ≈ (x, y)`
        // up to one wei of floor rounding noise on the y-side.
        let price_scale = wad_of(5);
        let x_wad = wad_of(7);
        let y_wad = wad_of(13);
        let (x_math, y_math) = to_math_space(x_wad, y_wad, price_scale).unwrap();
        let (x_back, y_back) = from_math_space_down(x_math, y_math, price_scale).unwrap();
        assert_eq!(x_back, x_wad);
        let diff = if y_back > y_wad {
            y_back - y_wad
        } else {
            y_wad - y_back
        };
        assert!(diff <= U256::one(), "roundtrip y: diff={diff}");
    }

    /// Golden vectors generated from a literal big-int transcription of
    /// the Solady `lnWad` assembly (EVM shl/shr/sar/sdiv/byte semantics
    /// reproduced with Python integers), so the Rust port is pinned
    /// bit-for-bit to what the on-chain library returns.
    #[test]
    fn ln_wad_matches_solady_golden_vectors() {
        let vectors: [(&str, bool, &str); 14] = [
            ("1", true, "41446531673892822313"),
            ("2", true, "40753384493332877003"),
            ("999999999999999999", true, "1"),
            ("1000000000000000000", false, "0"),
            ("1000000000000000001", false, "1"),
            ("500000000000000000", true, "693147180559945310"),
            ("2000000000000000000", false, "693147180559945309"),
            ("500000000000000", true, "7600902459542082362"),
            ("3000000000000000000000", false, "8006367567650246743"),
            ("10000000000000", true, "11512925464970228421"),
            ("10000000000000000000000", false, "9210340371976182736"),
            ("333333333333333333", true, "1098612288668109693"),
            ("2718281828459045235", false, "999999999999999999"),
            (
                "28948022309329048855892746252171976963317496166410141009864396001978282409984",
                false,
                "134612852188333286279",
            ),
        ];
        for (x_str, neg, mag_str) in vectors {
            let x = U256::from_dec_str(x_str).unwrap();
            let got = ln_wad(x).expect("lnWad in domain");
            let want_mag = U256::from_dec_str(mag_str).unwrap();
            assert_eq!(
                (got.is_neg(), got.mag),
                (neg && !want_mag.is_zero(), want_mag),
                "lnWad({x_str})"
            );
        }
        assert!(ln_wad(U256::zero()).is_err(), "lnWad(0) must be undefined");
    }

    #[test]
    fn geometric_ema_minimum_matches_shared_solidity_vectors() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/equilibra-numeric-domain.json"
        ))
        .unwrap();
        let v = &data["minimumEma"];
        let n = |v: &serde_json::Value| U256::from_dec_str(v.as_str().unwrap()).unwrap();
        for ema in v["oldEmaWad"].as_array().unwrap() {
            assert_eq!(
                ema_log_to_price(
                    geometric_ema_log_step(
                        price_to_ema_log(n(ema)).unwrap(),
                        n(&v["spotWad"]),
                        U256::zero()
                    )
                    .unwrap()
                )
                .unwrap(),
                n(&v["expected"]),
                "ema={ema}"
            );
        }
        let out = geometric_ema_log_step(
            price_to_ema_log(wad_u256() * 2 + 1).unwrap(),
            U256::one(),
            U256::zero(),
        )
        .unwrap();
        assert_eq!(ema_log_to_price(out).unwrap(), U256::one());
    }

    #[test]
    fn geometric_ema_spot_equals_ema_is_an_exact_fixed_point() {
        for ema in [
            U256::one(),
            U256::from(2),
            U256::from(17_000_000_000_000u128), // 1.7e13 (flipped WBTC scale)
            wad_u256(),                         // 1.0
            U256::from(3_000u128) * wad_u256(), // 3000
            U256::from(123_456_789_012_345_678_901u128), // irregular
        ] {
            for alpha in [0u128, 1, 500_000_000_000_000_000, WAD_U128 - 1] {
                let log = price_to_ema_log(ema).unwrap();
                let out = geometric_ema_log_step(log, ema, U256::from(alpha)).expect("step");
                assert_eq!(out, log, "ema={ema} alpha={alpha}");
            }
        }
    }

    #[test]
    fn persistent_ema_retains_sub_price_unit_updates() {
        let mut log = price_to_ema_log(U256::from(1000)).unwrap();
        let alpha = exp_neg_wad(wad_u256() / U256::from(865)).unwrap();
        for _ in 0..60 {
            let next = geometric_ema_log_step(log, U256::from(2000), alpha).unwrap();
            assert!(next > log);
            log = next;
        }
        assert_eq!(ema_log_to_price(log).unwrap(), U256::from(1047));
    }

    const WAD_U128: u128 = 1_000_000_000_000_000_000;

    /// The property this step exists for: running the same price path
    /// in the reciprocal frame keeps the two EMAs exact reciprocals up
    /// to integer rounding dust — the arithmetic mix diverges by the
    /// Jensen gap instead (measured at the ~3e-3 relative scale under
    /// volatile paths).
    #[test]
    fn geometric_ema_is_reciprocal_invariant_up_to_dust() {
        let wad = wad_u256();
        let wad2 = wad * wad;
        let initial = U256::from(2_000u128) * wad;
        let mut log_a = price_to_ema_log(initial).unwrap();
        let mut log_b = price_to_ema_log(wad2 / initial).unwrap();
        let alpha = U256::from(870_000_000_000_000_000u128); // heavy smoothing
                                                             // A volatile walk: ±8% style swings around a trend.
        let path_bps: [i64; 12] = [
            800, -450, 620, -710, 300, 1200, -900, 150, -260, 980, -400, 530,
        ];
        let mut spot_a = initial;
        for bps in path_bps {
            let num = U256::from((10_000i64 + bps) as u128);
            spot_a = spot_a * num / U256::from(10_000u128);
            let spot_b = wad2 / spot_a;
            log_a = geometric_ema_log_step(log_a, spot_a, alpha).expect("direct step");
            log_b = geometric_ema_log_step(log_b, spot_b, alpha).expect("mirror step");
            let ema_a = ema_log_to_price(log_a).unwrap();
            let ema_b = ema_log_to_price(log_b).unwrap();
            // ema_a · ema_b must stay ≈ WAD² (reciprocal pair).
            let prod = ema_a * ema_b / wad;
            let dev = if prod > wad { prod - wad } else { wad - prod };
            // Integer-rounding dust only: sub-1e-9 relative.
            assert!(
                dev <= U256::from(1_000_000_000u128),
                "reciprocal drift {dev} after spot {spot_a}"
            );
        }
    }

    /// The old wrong-side dust fixture now returns a positive result.
    /// Whole-K-unit quantization at these very small reserves still matters;
    /// this is a Solidity parity fixture, not a continuous precision claim.
    #[test]
    fn q128_tiny_reserve_exact_out_matches_solidity() {
        let (dx, _iters) = quote_exact_out_forward(
            U256::from(1_000_000_000_000u128),         // xMath
            U256::from(100_000_000_000u128),           // yMath
            U256::one(),                               // dyMath
            U256::from(990_000_000_000_000_000u128),   // a = 0.99
            U256::from(1_000_000_000_000_000_000u128), // λ = 1.0
        )
        .unwrap();
        assert_eq!((dx, _iters), (U256::from(55u8), 2));
    }

    /// The previously stagnating de-anchored dust fixture now resolves with
    /// Q128. The common math margin precedes a single strict native LP-depth check.
    #[test]
    fn q128_former_exact_in_stagnation_matches_solidity() {
        let result = quote_exact_in_forward(
            U256::from(12_500u128) * wad_u256(), // input axis (quote lifted)
            U256::from(28_483_987_539_843_244_337u128), // output axis (base)
            U256::from(2_204u128),               // dxMath in the band
            U256::from(909_610_000_000_000_000u128), // a = 0.90961
            U256::from(16_780_000_000_000_000u128), // λ = 0.01678
        )
        .unwrap();
        assert_eq!(result, (U256::from(2u8), 2));
    }
}
