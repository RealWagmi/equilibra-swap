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
//!     `[A_MIN_WAD, A_MAX_WAD] = [0.1·W, 0.99·W]`.
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
pub const A_MAX_WAD: u128 = 990_000_000_000_000_000u128; // 0.99 · W

/// Plateau-width knob `λ` bounds (WAD-scaled). Mirrors Solidity
/// `Constants.{LAMBDA_MIN_WAD, LAMBDA_MAX_WAD}` byte-for-byte.
pub const LAMBDA_MIN_WAD: u128 = 1_000_000_000_000_000u128; // 1e15
pub const LAMBDA_MAX_WAD: u128 = 1_000_000_000_000_000_000u128; // 1e18

pub const MAX_TOKEN_DECIMALS: u8 = 18;

/// Maximum secant iterations per swap leg. Mirrors Solidity
/// `EquilibraSwapMath._MAX_SECANT_ITER`.
const MAX_SECANT_ITER: u32 = 12;

// ---------------------------------------------------------------------------
// U256 helpers — bit-exact floor/ceil arithmetic.
// ---------------------------------------------------------------------------

#[inline(always)]
fn wad_u256() -> U256 {
    U256::from(WAD)
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

/// Closed-form invariant `K(x, y; L) = A·L·(x+y)/2 + (W−A)·xy`. Private
/// fast path used by `compute_k`/`compute_k_and_l` and the secant
/// solver.
fn compute_k_from_l(
    x_math: U256,
    y_math: U256,
    l_wad: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(U256::zero());
    }
    let n_wad = mul_wad(x_math, y_math)?;
    if n_wad.is_zero() {
        return Ok(U256::zero());
    }

    // D and A.
    let dist_wad = if x_math != y_math {
        let diff = if y_math > x_math {
            y_math - x_math
        } else {
            x_math - y_math
        };
        let diff_sq_wad = mul_wad(diff, diff)?;
        div_wad(diff_sq_wad, n_wad)?
    } else {
        U256::zero()
    };
    let (amp_wad, _denom_wad) = amplification(a_wad, lambda_wad, dist_wad)?;

    // K = A·L·(x+y)/2 + (W−A)·xy
    let sum_xy = x_math + y_math;
    let s_half_wad = sum_xy >> 1;
    let al_wad = mul_wad(amp_wad, l_wad)?;
    let head_wad = mul_wad(al_wad, s_half_wad)?;
    let w_minus_a = wad_u256() - amp_wad;
    let tail_wad = mul_wad(w_minus_a, n_wad)?;
    Ok(head_wad + tail_wad)
}

/// Solve the closed-form quadratic `W·L² − A·L·S − (W−A)·N = 0` for
/// the positive root `L = (A·S + √((A·S)² + 4·W·(W−A)·N)) / (2·W)`.
/// Mirrors Solidity `solveLFromState`.
pub fn solve_l_from_state(
    x_math: U256,
    y_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(U256::zero());
    }
    let n_wad = mul_wad(x_math, y_math)?;
    if n_wad.is_zero() {
        return Ok(U256::zero());
    }

    let dist_wad = if x_math != y_math {
        let diff = if y_math > x_math {
            y_math - x_math
        } else {
            x_math - y_math
        };
        let diff_sq_wad = mul_wad(diff, diff)?;
        div_wad(diff_sq_wad, n_wad)?
    } else {
        U256::zero()
    };
    let (amp_wad, _denom_wad) = amplification(a_wad, lambda_wad, dist_wad)?;

    let s_half_wad = (x_math + y_math) >> 1;
    let as_wad = mul_wad(amp_wad, s_half_wad)?;
    let as_sq_wad = mul_wad(as_wad, as_wad)?;
    let w_minus_a = wad_u256() - amp_wad;
    // 4 · mul_wad(W − A, N) (see Solidity NatSpec).
    let four_term_wad = mul_wad(w_minus_a, n_wad)? * U256::from(4u64);
    let discr_wad = as_sq_wad + four_term_wad;
    let sqrt_discr_wad = sqrt_wad(discr_wad)?;
    let num_l_wad = as_wad + sqrt_discr_wad;
    Ok(num_l_wad >> 1)
}

/// Closed-form K with L recovered from state.
pub fn compute_k(x_math: U256, y_math: U256, a_wad: U256, lambda_wad: U256) -> Result<U256> {
    let (k_wad, _) = compute_k_and_l(x_math, y_math, a_wad, lambda_wad)?;
    Ok(k_wad)
}

/// Joint K + L recovery in one fused pass. The shared state products —
/// `N = x·y`, distance `D`, amplification `A`, half-sum `S/2` and tail
/// `(W − A)·N` — are computed exactly once and reused by both the
/// quadratic root and the invariant evaluation. Bit-identical to
/// `solve_l_from_state` + `compute_k_from_l` back to back; mirrors the
/// Solidity `computeKAndL` fusion (audit O-4).
pub fn compute_k_and_l(
    x_math: U256,
    y_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<(U256, U256)> {
    if x_math.is_zero() || y_math.is_zero() {
        return Ok((U256::zero(), U256::zero()));
    }
    let n_wad = mul_wad(x_math, y_math)?;
    if n_wad.is_zero() {
        return Ok((U256::zero(), U256::zero()));
    }

    // D and A — single evaluation shared by both halves.
    let dist_wad = if x_math != y_math {
        let diff = if y_math > x_math {
            y_math - x_math
        } else {
            x_math - y_math
        };
        let diff_sq_wad = mul_wad(diff, diff)?;
        div_wad(diff_sq_wad, n_wad)?
    } else {
        U256::zero()
    };
    let (amp_wad, _denom_wad) = amplification(a_wad, lambda_wad, dist_wad)?;

    let s_half_wad = (x_math + y_math) >> 1;
    let as_wad = mul_wad(amp_wad, s_half_wad)?;
    // `(W − A)·N` doubles as the quadratic's 4-term (×4) and the
    // invariant's tail — computed once.
    let w_minus_a = wad_u256() - amp_wad;
    let tail_wad = mul_wad(w_minus_a, n_wad)?;

    // L: positive root of `W·L² − A·L·S − (W − A)·N = 0`.
    let as_sq_wad = mul_wad(as_wad, as_wad)?;
    let four_term_wad = tail_wad * U256::from(4u64);
    let discr_wad = as_sq_wad + four_term_wad;
    let sqrt_discr_wad = sqrt_wad(discr_wad)?;
    let l_wad = (as_wad + sqrt_discr_wad) >> 1;
    if l_wad.is_zero() {
        return Ok((U256::zero(), U256::zero()));
    }

    // K = A·L·(x+y)/2 + (W − A)·xy — amp/half-sum/tail reused.
    let al_wad = mul_wad(amp_wad, l_wad)?;
    let head_wad = mul_wad(al_wad, s_half_wad)?;
    Ok((head_wad + tail_wad, l_wad))
}

/// Recover the balance-state depth `L_eq = √(K / W) = sqrtWad(K)`.
pub fn balance_scale_from_k(k_wad: U256) -> Result<U256> {
    if k_wad.is_zero() {
        return Ok(U256::zero());
    }
    sqrt_wad(k_wad)
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
    l_eq_wad: U256,
    price_scale_wad: U256,
    total_supply_wad: U256,
) -> Result<U256> {
    if total_supply_wad.is_zero() || l_eq_wad.is_zero() || price_scale_wad.is_zero() {
        return Ok(U256::zero());
    }
    // sqrtWad(x) returns `√(x · WAD)` in WAD form.
    let sqrt_ps_wad = sqrt_wad(price_scale_wad)?;
    let double_l = l_eq_wad << 1;
    // fullMulDiv equivalent: floor(2·L · √(p·WAD) / supply).
    mul_div_floor(double_l, sqrt_ps_wad, total_supply_wad)
}

// ---------------------------------------------------------------------------
// Marginal price (analytic, math-space, n = 1).
// ---------------------------------------------------------------------------

/// Math-space marginal price `pMarg = ∂K/∂x ÷ ∂K/∂y` at `(xMath, yMath)`
/// with frozen depth `L`. Mirrors Solidity `marginalPrice` for n=1.
pub fn marginal_price(
    x_math: U256,
    y_math: U256,
    l_wad: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_math: marginalPrice zero reserve"));
    }
    if x_math == y_math {
        return Ok(wad_u256());
    }
    if l_wad.is_zero() {
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
    let s_half_wad = sum_xy >> 1;

    // H = L·S − N (sign tracked).
    let ls_wad = mul_wad(l_wad, s_half_wad)?;
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
    let al_wad = mul_wad(amp_wad, l_wad)?;
    let al_half = al_wad >> 1;
    let w_minus_a = wad_u256() - amp_wad;
    let tail_wad = mul_wad(w_minus_a, n_wad)?;
    let base_x = mul_wad(al_half, x_math)? + tail_wad;
    let base_y = mul_wad(al_half, y_math)? + tail_wad;

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

    let num = mul_wad(y_math, x_kx)?;
    let den = mul_wad(x_math, y_ky)?;
    div_wad(num, den)
}

/// Convenience: recover L from state then evaluate marginal price.
pub fn marginal_price_from_state(
    x_math: U256,
    y_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<U256> {
    let l_wad = solve_l_from_state(x_math, y_math, a_wad, lambda_wad)?;
    marginal_price(x_math, y_math, l_wad, a_wad, lambda_wad)
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
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactInForward zero reserve"));
    }
    if dx_math.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactInForward zero amount"));
    }

    // Fused K+L recovery (audit O-4): one shared N/D/A/S-half/tail pass.
    // Bit-identical to the historical `solve_l_from_state` +
    // `compute_k_from_l` sequence — see `compute_k_and_l` NatSpec.
    let (k_target, l_pre) = compute_k_and_l(x_math, y_math, a_wad, lambda_wad)?;
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

    let (y_post, used) = solve_counterpart(x_post, y_seed, k_target, a_wad, lambda_wad, l_pre)?;

    if y_post > y_math {
        // Wrong-side terminal iterate: no physically admissible
        // discrete quote for this input. Fail closed with a zero-output
        // sentinel (mirror of the Solidity semantics); the caller's
        // typed dust guards stop the trade.
        return Ok((U256::zero(), used));
    }
    Ok((y_math - y_post, used))
}

/// Forward exact-output. Returns `(dxMath, iters)`.
pub fn quote_exact_out_forward(
    x_math: U256,
    y_math: U256,
    dy_math: U256,
    a_wad: U256,
    lambda_wad: U256,
) -> Result<(U256, u32)> {
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

    // Fused K+L recovery (audit O-4) — same rationale as the exact-in path.
    let (k_target, l_pre) = compute_k_and_l(x_math, y_math, a_wad, lambda_wad)?;
    if l_pre.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactOutForward L underflow"));
    }
    if k_target.is_zero() {
        return Err(anyhow!("equilibra_math: quoteExactOutForward K underflow"));
    }

    let y_post = y_math - dy_math;
    let mut x_seed = mul_div_floor(x_math, y_math, y_post)?;
    if x_seed <= x_math {
        x_seed = x_math + U256::one();
    }

    // The cubic K is symmetric in (xMath, yMath), so passing
    // (yPost, xSeed) treats yPost as the fixed axis.
    let (x_post, used) = solve_counterpart(y_post, x_seed, k_target, a_wad, lambda_wad, l_pre)?;

    if x_post < x_math {
        // Wrong-side terminal iterate on the input axis (mirror of the
        // exact-in case): no physically admissible discrete quote. Fail
        // closed with a zero-input sentinel; the caller's
        // zero-clean-input typed guard stops the trade.
        return Ok((U256::zero(), used));
    }
    Ok((x_post - x_math, used))
}

/// Secant iteration on `K(aFixed, b; L) = kTarget` with frozen L.
/// Two-seed bootstrap + best-iterate fallback.
fn solve_counterpart(
    a_fixed: U256,
    b_seed: U256,
    k_target: U256,
    a_wad: U256,
    lambda_wad: U256,
    l_wad: U256,
) -> Result<(U256, u32)> {
    let mut b1 = b_seed;
    let mut b2 = mul_div_floor(b_seed, U256::from(1001u64), U256::from(1000u64))?;
    if b2 == b1 {
        b2 = b1 + U256::one();
    }
    let mut k1 = compute_k_from_l(a_fixed, b1, l_wad, a_wad, lambda_wad)?;

    let mut b_best = b1;
    let mut residual_abs_best = if k1 >= k_target {
        k1 - k_target
    } else {
        k_target - k1
    };

    for i in 0..MAX_SECANT_ITER {
        let k2 = compute_k_from_l(a_fixed, b2, l_wad, a_wad, lambda_wad)?;
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
        }

        // Signed-secant arithmetic via I256.
        let dk_pos = k2 >= k1;
        let dk_mag = if dk_pos { k2 - k1 } else { k1 - k2 };
        if dk_mag.is_zero() {
            return Ok((b2, i + 1));
        }

        let db_pos = b2 >= b1;
        let db_mag = if db_pos { b2 - b1 } else { b1 - b2 };

        // step = (resid · db) / dk — signed: numerator sign is
        // `resid_pos == db_pos`, the denominator sign flips it.
        let step_pos = resid_pos == db_pos;
        let prod_mag = mul_div_floor(resid_mag, db_mag, dk_mag)?;
        let step_neg = !dk_pos; // dk in denominator flips the sign
        let final_step_pos = step_pos ^ step_neg; // XOR with denominator sign

        // b3 = b2 − step
        let b3 = if final_step_pos {
            if b2 > prod_mag {
                b2 - prod_mag
            } else {
                U256::one()
            }
        } else {
            b2 + prod_mag
        };
        if b3 == b2 {
            return Ok((b2, i + 1));
        }
        b1 = b2;
        k1 = k2;
        b2 = b3;
    }
    Ok((b_best, MAX_SECANT_ITER))
}

// ---------------------------------------------------------------------------
// CP-proxy distance predictor (dynamic-fee resolver).
// ---------------------------------------------------------------------------

/// Predict post-swap math-space distance `D` for an exact-in trade
/// using a constant-product proxy. Mirrors Solidity
/// `predictPostDistanceCp`.
pub fn predict_post_distance_cp(x_math: U256, y_math: U256, dx_math_gross: U256) -> Result<U256> {
    if x_math.is_zero() || y_math.is_zero() || dx_math_gross.is_zero() {
        return Ok(U256::zero());
    }
    let x_post = x_math + dx_math_gross;
    let n_pre = mul_wad(x_math, y_math)?;
    if n_pre.is_zero() {
        return Ok(U256::zero());
    }
    let y_proxy = mul_div_floor(x_math, y_math, x_post)?;
    if y_proxy.is_zero() || y_proxy == x_post {
        return Ok(U256::zero());
    }
    let diff = if y_proxy > x_post {
        y_proxy - x_post
    } else {
        x_post - y_proxy
    };
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

/// One geometric (log-domain) EMA step:
/// `ema' = ema · exp((1 − α) · ln(spot / ema))`, all WAD-scaled.
///
/// Fixed-point op order — the on-chain port must replicate it exactly
/// with Solady's `lnWad` / `expWad`:
///   1. `ratio  = divWad_floor(spot, ema)` (must stay > 0),
///   2. `lnr    = lnWad(ratio)` (signed),
///   3. `scaled = sdiv(lnr · (WAD − α), WAD)` (truncates toward zero),
///   4. `factor = expWad(scaled)` (positive in this domain),
///   5. `ema'   = mulWad_floor(ema, factor)`.
///
/// `spot == ema` maps through `lnWad(WAD) == 0` and `expWad(0) == WAD`
/// to an EXACT fixed point. The geometric mean is
/// reciprocal-invariant — `EMA(1/p)` equals `1/EMA(p)` up to integer
/// rounding — so oracle behaviour does not depend on which pair side
/// the price is quoted in (the arithmetic mix carries a Jensen-gap
/// bias in one of the two orientations).
pub fn geometric_ema_step(ema_wad: U256, spot_wad: U256, alpha_wad: U256) -> Result<U256> {
    let wad = wad_u256();
    if ema_wad.is_zero() {
        return Err(anyhow!("equilibra_math: geometric ema step with zero ema"));
    }
    if alpha_wad > wad {
        return Err(anyhow!("equilibra_math: geometric ema alpha above WAD"));
    }
    let ratio = div_wad(spot_wad, ema_wad)?;
    if ratio.is_zero() {
        return Err(anyhow!(
            "equilibra_math: geometric ema spot/ema ratio floors to zero"
        ));
    }
    let lnr = ln_wad(ratio)?;
    let one_minus_alpha = I256::from_u256(wad - alpha_wad);
    let scaled = I256::div(I256::mul(lnr, one_minus_alpha)?, I256::from_u256(wad))?;
    let factor = exp_wad(scaled)?;
    if factor.is_neg() {
        return Err(anyhow!("equilibra_math: geometric ema factor negative"));
    }
    mul_wad(ema_wad, factor.mag)
}

// ---------------------------------------------------------------------------
// Sanity tests.
// ---------------------------------------------------------------------------

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
    fn solve_l_at_anchor_recovers_balance() {
        // x = y ⇒ L = x exactly.
        let l = solve_l_from_state(wad_u256(), wad_u256(), a_default(), lambda_default()).unwrap();
        assert_eq!(l, wad_u256());
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
            let target = mul_wad(l, l).unwrap();
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
    fn geometric_ema_spot_equals_ema_is_an_exact_fixed_point() {
        for ema in [
            U256::from(17_000_000_000_000u128), // 1.7e13 (flipped WBTC scale)
            wad_u256(),                         // 1.0
            U256::from(3_000u128) * wad_u256(), // 3000
            U256::from(123_456_789_012_345_678_901u128), // irregular
        ] {
            for alpha in [0u128, 1, 500_000_000_000_000_000, WAD_U128 - 1] {
                let out = geometric_ema_step(ema, ema, U256::from(alpha)).expect("step");
                assert_eq!(out, ema, "ema={ema} alpha={alpha}");
            }
        }
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
        let mut ema_a = U256::from(2_000u128) * wad; // 2000 quote-per-base
        let mut ema_b = wad2 / ema_a; // reciprocal frame
        let alpha = U256::from(870_000_000_000_000_000u128); // heavy smoothing
                                                             // A volatile walk: ±8% style swings around a trend.
        let path_bps: [i64; 12] = [
            800, -450, 620, -710, 300, 1200, -900, 150, -260, 980, -400, 530,
        ];
        let mut spot_a = ema_a;
        for bps in path_bps {
            let num = U256::from((10_000i64 + bps) as u128);
            spot_a = spot_a * num / U256::from(10_000u128);
            let spot_b = wad2 / spot_a;
            ema_a = geometric_ema_step(ema_a, spot_a, alpha).expect("direct step");
            ema_b = geometric_ema_step(ema_b, spot_b, alpha).expect("mirror step");
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

    /// Branch pin: a wrong-side terminal iterate of the exact-out
    /// secant reports a zero-input sentinel instead of an error.
    /// Vector reproduces `x_post < x_math` (undershoot 106_282 at the
    /// terminal iterate).
    #[test]
    fn exact_out_wrong_side_iterate_reports_zero_input() {
        let (dx, _iters) = quote_exact_out_forward(
            U256::from(1_000_000_000_000u128),         // xMath
            U256::from(100_000_000_000u128),           // yMath
            U256::one(),                               // dyMath
            U256::from(990_000_000_000_000_000u128),   // a = 0.99
            U256::from(1_000_000_000_000_000_000u128), // λ = 1.0
        )
        .expect("soft-fail must not error");
        assert!(dx.is_zero(), "expected zero-input sentinel, got {dx}");
    }

    /// Branch pin: the exact-in twin on the de-anchored pool state
    /// pinned by `test/security/DustQuoteSoftFail.test.ts` (clean input
    /// 2204 sits inside the overshoot band [2195, 73910]).
    #[test]
    fn exact_in_wrong_side_iterate_reports_zero_output() {
        let (dy, _iters) = quote_exact_in_forward(
            U256::from(12_500u128) * wad_u256(), // input axis (quote lifted)
            U256::from(28_483_987_539_843_244_337u128), // output axis (base)
            U256::from(2_204u128),               // dxMath in the band
            U256::from(909_610_000_000_000_000u128), // a = 0.90961
            U256::from(16_780_000_000_000_000u128), // λ = 0.01678
        )
        .expect("soft-fail must not error");
        assert!(dy.is_zero(), "expected zero-output sentinel, got {dy}");
    }
}
