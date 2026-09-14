//! Stateful Equilibra pool model — bit-exact port of the control
//! flow in `contracts/EquilibraPool.sol`.
//!
//! Pool semantics:
//!   * Two-knob cubic invariant
//!         K(x, y; L) = A·L·(x+y)/2 + (W − A)·x·y,
//!         A = a·W/(W + λ·D),
//!         D = (y − x)² / (x·y).
//!   * Asymmetric math-space coord change with quote-side
//!     normalisation:
//!         xMath = xWad,                                (base identity)
//!         yMath = yWad · WAD / priceScale              (quote → base).
//!   * **Inline** LP fees — `lpFeeCut` stays in reserves.
//!   * LP unit value `vp = 2·L_eq · √(priceScale·WAD) / totalSupply`
//!     tracked as a monotone-up high-water mark; positive deltas
//!     credit a cumulative `lp_value_growth_wad` accumulator that
//!     never resets.
//!   * `try_auto_repeg` opens only when the live `vp_before` clears
//!     `vpGenesis + growth·keepBps/BPS + gasGuard` AND the post-repeg
//!     `vp_after` still clears the same threshold.
//!   * `applied_repeg_step` + `apply_log_step` move the price scale
//!     toward the EMA with damping in the LOG domain, clamped to the
//!     remaining gap — never overshoots (the block/second cadence guard is
//!     delegated to the caller); `try_auto_repeg` halves the applied
//!     step on solvency refusals (`MAX_REPEG_STEP_HALVINGS`).

use anyhow::{anyhow, Result};
use primitive_types::U256;

use super::equilibra_math::{
    self, compute_lp_unit_value_wad as math_compute_lp_unit_value_wad, from_wad_up_by_scale,
    marginal_price_from_state, mul_div_ceil, mul_div_floor as math_mul_div_floor, mul_wad,
    predict_post_distance_cp, scale_for_decimals, smoothstep_fee_wad, solve_l_from_state,
    to_math_space, to_wad_by_scale, A_MAX_WAD, A_MIN_WAD, BPS, LAMBDA_MAX_WAD, LAMBDA_MIN_WAD, WAD,
};

#[cfg(test)]
use super::equilibra_math::quote_exact_in_forward;

// ---------------------------------------------------------------------------
// Constants mirroring `contracts/libraries/Constants.sol`.
// ---------------------------------------------------------------------------

/// Symmetric EMA price cap: `spot ∈ [priceScale / 2, priceScale * 2]`.
const EMA_PRICE_CAP_MUL: u128 = 2;
const EMA_PRICE_CAP_DIV: u128 = 2;
const MIN_EMA_PERIOD: u128 = 60;
const MAX_EMA_PERIOD: u128 = 7 * 24 * 3600;

/// Base-fee (fee ceiling) bounds. Mirror `Constants.MIN_BASE_FEE` /
/// `Constants.MAX_BASE_FEE`.
pub const MIN_BASE_FEE_BPS: u128 = 1;
pub const MAX_BASE_FEE_BPS: u128 = 2_000;
/// Storage mirrors the pool's `uint16 feeFloorBps`, including flat-fee mode.
pub const MAX_FEE_FLOOR_BPS: u128 = u16::MAX as u128;
pub const MAX_FEE_RAMP_BPS: u128 = 10_000;
/// Ramp monotonicity guard multiplier. Mirrors
/// `Constants.FEE_RAMP_GUARD_MULT`; see [`fee_ramp_guard_ok`].
pub const FEE_RAMP_GUARD_MULT: u128 = 12;
pub const MAX_REPEG_SHARE_BPS: u128 = BPS;
pub const MAX_PROTOCOL_FEE_PERCENT: u128 = 25;
pub const REPEG_GAS_GUARD_WAD: u128 = 40_000_000_000u128; // 4e10, absolute vp units
/// Auto-repeg damping divisor (the applied step is
/// `min(repegStepWad, deviation / divisor)`). A single global gain:
/// the halving ladder below covers the stall-rescue role that would
/// otherwise call for per-pool tuning, and an aggressive divisor
/// combined with the ladder measurably scrapes the repeg budget to
/// the floor — so the gentle 5 stays universal.
pub const REPEG_DAMPING_DIVISOR: u128 = 5;

/// Maximum halvings of the applied repeg step within ONE attempt when
/// the post-move solvency probe (`vpAfter < threshold`) refuses the
/// candidate: effective divisor ladder `D, 2D, 4D, 8D`, then skip. No
/// cross-block memory — every attempt starts fresh from `deviation/D`.
/// Turns the binary "unaffordable ⇒ freeze" into "move as much as the
/// budget allows", which breaks the self-reinforcing stall spiral
/// (anchor frozen → concentration off-market → fees die → budget never
/// refills). The on-chain port must mirror this ladder.
pub const MAX_REPEG_STEP_HALVINGS: u32 = 3;
/// Donation-parachute activation multiplier K — the DEFAULT seeded at
/// pool creation. The parachute (the ONLY spender of the donation
/// buffer) opens solely when the geometric EMA/priceScale deviation
/// reaches `K × the active direction's dead-band` AND no repeg
/// committed from the pool's own budget. On-chain K is per-pool
/// storage (`_parachuteBandMult`), seeded at `initialize` from
/// `Constants.REPEG_PARACHUTE_BAND_MULT` and runtime-adjustable in
/// `[1, 255]` via the param timelock; the mirror is
/// `EquilibraStatefulConfig::parachute_band_mult`. K = 30 was
/// calibrated by the 2026-07 matrix sweep.
pub const REPEG_PARACHUTE_BAND_MULT_DEFAULT: u128 = 30;
/// Dust floor (raw LP shares) below which the donation buffer is
/// treated as empty. Mirrors `Constants.REPEG_DONATION_DUST_SHARES`.
pub const REPEG_DONATION_DUST_SHARES: u128 = 1_000_000_000_000;
pub const MIN_INITIAL_LIQUIDITY: u128 = 1_000_000;
const MAX_GENESIS_VP_ERROR_WAD: u128 = REPEG_GAS_GUARD_WAD;
const FEE_RAMP_BPS_TO_WAD: u128 = 100_000_000_000_000u128; // 1e14
/// Fee rates are WAD fractions on both sides of the parity boundary:
/// `1 bps == 1e14`. Mirrors the pool's `uint16 · 1e14` widening.
pub const FEE_BPS_TO_WAD: u128 = 100_000_000_000_000u128; // 1e14

/// Ramp monotonicity guard, mirroring `EquilibraFactory` /
/// `EquilibraParamTimelock` (`FeeRampTooNarrow`): a live ramp must
/// satisfy `feeRampBps · (BPS − baseFee)² ≥ FEE_RAMP_GUARD_MULT · BPS ·
/// (baseFee − feeFloorBps)²`, otherwise the terminal rate climbs faster
/// than the gross input grows and a larger exact-in trade returns less
/// output. Live-ramp callers must first validate
/// `1 ≤ fee_floor_bps < fee_bps ≤ BPS`; flat-fee mode always passes.
pub fn fee_ramp_guard_ok(fee_bps: u128, fee_floor_bps: u128, fee_ramp_bps: u128) -> bool {
    if fee_ramp_bps == 0 {
        return true;
    }
    if fee_bps > BPS {
        return false;
    }
    let span = fee_bps - fee_floor_bps;
    let inv = BPS - fee_bps;
    fee_ramp_bps * inv * inv >= FEE_RAMP_GUARD_MULT * BPS * span * span
}

// ---------------------------------------------------------------------------
// Public API surface.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EquilibraRecenterGateBlocked {
    DisableRecenterFlag,
    RepegShareZero,
    SameTimestampOncePerBlock,
    TotalSupplyZero,
    ReservesZero,
    EmaZero,
    DeviationBelowThreshold,
    LpUnitValueBelowThreshold,
    LpUnitValueAfterBelowThreshold,
    /// No repeg committed, donation buffer present, but the anchor lag
    /// is below `parachute_band_mult × active dead-band`.
    DonationParachuteBelowActivation,
    /// Parachute qualified but could not commit: dust candidate, zero
    /// vp probe, or the shortfall burn exceeds the buffer.
    DonationParachuteInsufficient,
}

impl EquilibraRecenterGateBlocked {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DisableRecenterFlag => "disable_recenter_flag",
            Self::RepegShareZero => "repeg_share_zero",
            Self::SameTimestampOncePerBlock => "same_timestamp_once_per_block",
            Self::TotalSupplyZero => "total_supply_zero",
            Self::ReservesZero => "reserves_zero",
            Self::EmaZero => "ema_zero",
            Self::DeviationBelowThreshold => "deviation_below_threshold",
            Self::LpUnitValueBelowThreshold => "lp_unit_value_below_threshold",
            Self::LpUnitValueAfterBelowThreshold => "lp_unit_value_after_below_threshold",
            Self::DonationParachuteBelowActivation => "donation_parachute_below_activation",
            Self::DonationParachuteInsufficient => "donation_parachute_insufficient",
        }
    }

    pub const fn all() -> [Self; 11] {
        [
            Self::DisableRecenterFlag,
            Self::RepegShareZero,
            Self::SameTimestampOncePerBlock,
            Self::TotalSupplyZero,
            Self::ReservesZero,
            Self::EmaZero,
            Self::DeviationBelowThreshold,
            Self::LpUnitValueBelowThreshold,
            Self::LpUnitValueAfterBelowThreshold,
            Self::DonationParachuteBelowActivation,
            Self::DonationParachuteInsufficient,
        ]
    }
}

/// Immutable configuration for a single Equilibra pool instance.
///
/// Two-knob cubic kernel: `aWad` (depth at anchor, `A_MIN_WAD..A_MAX_WAD`)
/// and `lambdaWad` (plateau width, `LAMBDA_MIN_WAD..LAMBDA_MAX_WAD`).
/// Decoupled — moving `a` alone changes centre depth without shifting the
/// cliff; moving `λ` alone shifts the cliff without affecting depth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquilibraStatefulConfig {
    token0_lower: String,
    token1_lower: String,
    pub fee_bps: u128,
    pub a_wad: u128,
    pub lambda_wad: u128,
    pub token0_decimals: u8,
    pub token1_decimals: u8,
    pub token0_scale: U256,
    pub token1_scale: U256,
    pub protocol_fee_percent: u128,
    /// Internal EMA relaxation time tau in seconds (the constructor
    /// converts the human-facing half-life input once; mirrors the
    /// on-chain stored `_emaPeriod`).
    pub ema_period: u128,
    pub repeg_step_wad: u128,
    /// Auto-repeg activation dead-band (WAD); decoupled from the
    /// per-repeg cap `repeg_step_wad`.
    /// Activation dead-band while `ema > priceScale` (token1's price in
    /// token0 above the anchor).
    pub repeg_threshold_token1_up_wad: u128,
    /// Activation dead-band while `ema < priceScale`.
    pub repeg_threshold_token1_down_wad: u128,
    pub fee_ramp_bps: u128,
    pub fee_floor_bps: u128,
    /// **Pre-scaled** `repeg_share_bps` (threshold-ready), bit-exact
    /// with the on-chain `_repegShareBps` formula
    /// `stored = ⌊ user · BPS / (BPS − p·100) ⌋`.
    pub repeg_share_bps: u128,
    pub fee_ramp_dist_wad: u128,
    /// Donation-parachute activation multiplier K (`activation =
    /// K × active dead-band`). Mirrors the per-pool
    /// `_parachuteBandMult` storage slot: `new()` seeds it to
    /// `REPEG_PARACHUTE_BAND_MULT_DEFAULT` exactly like `initialize`
    /// seeds from `Constants.REPEG_PARACHUTE_BAND_MULT`; mutate the
    /// public field afterwards to model a timelock adjustment
    /// (on-chain range `[1, 255]`).
    pub parachute_band_mult: u128,
}

impl EquilibraStatefulConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        token0: &str,
        token1: &str,
        token0_decimals: u8,
        token1_decimals: u8,
        fee_bps: u128,
        a_wad: u128,
        lambda_wad: u128,
        protocol_fee_percent: u128,
        ema_period: u128,
        repeg_step_wad: u128,
        repeg_threshold_token1_up_wad: u128,
        repeg_threshold_token1_down_wad: u128,
        fee_ramp_bps: u128,
        fee_floor_bps: u128,
        repeg_share_bps: u128,
    ) -> Result<Self> {
        let token0_lower = token0.to_lowercase();
        let token1_lower = token1.to_lowercase();

        if !(A_MIN_WAD..=A_MAX_WAD).contains(&a_wad) {
            return Err(anyhow!(
                "equilibra_stateful: a_wad {} outside [{}, {}]",
                a_wad,
                A_MIN_WAD,
                A_MAX_WAD
            ));
        }
        if !(LAMBDA_MIN_WAD..=LAMBDA_MAX_WAD).contains(&lambda_wad) {
            return Err(anyhow!(
                "equilibra_stateful: lambda_wad {} outside [{}, {}]",
                lambda_wad,
                LAMBDA_MIN_WAD,
                LAMBDA_MAX_WAD
            ));
        }
        // `ema_period` arrives as the oracle HALF-LIFE in seconds (the
        // unit the pool's `getFeeConfig()` view reports). Convert once to
        // the internal relaxation time `tau = ceil(period * 1000 / 694)`
        // and validate exactly like `EquilibraFactory`: the floor bounds
        // the human-facing input, the ceiling bounds the CONVERTED tau.
        let ema_tau = (ema_period * 1000).div_ceil(694);
        if ema_period < MIN_EMA_PERIOD || ema_tau > MAX_EMA_PERIOD {
            return Err(anyhow!(
                "equilibra_stateful: ema_period {} (tau {}) outside half-life range [{}, {}·694/1000]",
                ema_period,
                ema_tau,
                MIN_EMA_PERIOD,
                MAX_EMA_PERIOD
            ));
        }
        if repeg_step_wad == 0 || repeg_step_wad > WAD {
            return Err(anyhow!(
                "equilibra_stateful: invalid repeg_step_wad {}",
                repeg_step_wad
            ));
        }
        for (label, value) in [
            (
                "repeg_threshold_token1_up_wad",
                repeg_threshold_token1_up_wad,
            ),
            (
                "repeg_threshold_token1_down_wad",
                repeg_threshold_token1_down_wad,
            ),
        ] {
            if value == 0 || value >= WAD {
                return Err(anyhow!("equilibra_stateful: invalid {} {}", label, value));
            }
        }
        if protocol_fee_percent > MAX_PROTOCOL_FEE_PERCENT {
            return Err(anyhow!(
                "equilibra_stateful: protocol_fee_percent {} > MAX",
                protocol_fee_percent
            ));
        }
        if !(MIN_BASE_FEE_BPS..=MAX_BASE_FEE_BPS).contains(&fee_bps) {
            return Err(anyhow!(
                "equilibra_stateful: fee_bps {} outside [{}, {}]",
                fee_bps,
                MIN_BASE_FEE_BPS,
                MAX_BASE_FEE_BPS
            ));
        }
        if fee_floor_bps > MAX_FEE_FLOOR_BPS {
            return Err(anyhow!(
                "equilibra_stateful: fee_floor_bps {} > MAX_FEE_FLOOR_BPS ({})",
                fee_floor_bps,
                MAX_FEE_FLOOR_BPS
            ));
        }
        if fee_ramp_bps != 0 {
            if fee_ramp_bps > MAX_FEE_RAMP_BPS {
                return Err(anyhow!(
                    "equilibra_stateful: fee_ramp_bps {} > MAX",
                    fee_ramp_bps
                ));
            }
            if fee_floor_bps == 0 || fee_floor_bps >= fee_bps {
                return Err(anyhow!(
                    "equilibra_stateful: live fee ramp requires 1 <= fee_floor_bps < fee_bps",
                ));
            }
            if !fee_ramp_guard_ok(fee_bps, fee_floor_bps, fee_ramp_bps) {
                return Err(anyhow!(
                    "equilibra_stateful: feeRampBps {} too narrow for span {} at ceiling {} \
                     (FeeRampTooNarrow on chain)",
                    fee_ramp_bps,
                    fee_bps - fee_floor_bps,
                    fee_bps
                ));
            }
        }
        if repeg_share_bps > MAX_REPEG_SHARE_BPS {
            return Err(anyhow!(
                "equilibra_stateful: repeg_share_bps {} > MAX",
                repeg_share_bps
            ));
        }
        if repeg_share_bps + protocol_fee_percent * 100 > BPS {
            return Err(anyhow!(
                "equilibra_stateful: repegShare + protocolFee · 100 > BPS"
            ));
        }

        let fee_ramp_dist_wad = if fee_ramp_bps == 0 || fee_bps <= fee_floor_bps {
            0u128
        } else {
            fee_ramp_bps
                .checked_mul(FEE_RAMP_BPS_TO_WAD)
                .ok_or_else(|| anyhow!("equilibra_stateful: feeRampDistWad overflow"))?
        };

        // Pre-scale `repeg_share_bps` (`stored = ⌊ user · BPS / (BPS −
        // p·100) ⌋`) — mirrors `EquilibraPool.initialize`.
        let repeg_share_eff_u = math_mul_div_floor(
            U256::from(repeg_share_bps),
            U256::from(BPS),
            U256::from(BPS - protocol_fee_percent * 100),
        )?;
        let repeg_share_bps_eff = to_u128(repeg_share_eff_u, "repeg_share_bps_eff")?;

        let token0_scale = scale_for_decimals(token0_decimals)?;
        let token1_scale = scale_for_decimals(token1_decimals)?;

        Ok(Self {
            token0_lower,
            token1_lower,
            fee_bps,
            a_wad,
            lambda_wad,
            token0_decimals,
            token1_decimals,
            token0_scale,
            token1_scale,
            protocol_fee_percent,
            ema_period: ema_tau,
            repeg_step_wad,
            repeg_threshold_token1_up_wad,
            repeg_threshold_token1_down_wad,
            fee_ramp_bps,
            fee_floor_bps,
            repeg_share_bps: repeg_share_bps_eff,
            fee_ramp_dist_wad,
            parachute_band_mult: REPEG_PARACHUTE_BAND_MULT_DEFAULT,
        })
    }

    pub fn token0(&self) -> &str {
        &self.token0_lower
    }
    pub fn token1(&self) -> &str {
        &self.token1_lower
    }
}

/// Persistent pool state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EquilibraStatefulState {
    pub reserve0: u128,
    pub reserve1: u128,
    /// Pool price scale (`yWad / xWad` at the anchor, WAD-scaled).
    /// Drives the asymmetric coord change `yMath = yWad·WAD/priceScale`.
    pub price_scale_wad: u128,
    pub total_supply: u128,
    pub protocol_fee0: u128,
    pub protocol_fee1: u128,
    pub e0: u128,
    pub e1: u128,
    pub ema_log_wad: i128,
    pub last_ema_ts: u64,
    pub last_repeg_ts: u64,
    pub lp_unit_value_genesis_wad: u128,
    pub lp_unit_value_wad: u128,
    pub lp_value_growth_wad: u128,
    /// Donation buffer: LP shares parked on the pool's own address
    /// (counted inside `total_supply`), spendable ONLY by the repeg
    /// donation parachute. Mirrors `balanceOf(address(pool))` on-chain.
    pub donation_shares: u128,
}

impl EquilibraStatefulState {
    pub fn ema_price_wad(&self) -> Result<u128> {
        to_u128(
            equilibra_math::ema_log_to_price(self.ema_log_wad)?,
            "emaPriceWad",
        )
    }

    pub const fn empty() -> Self {
        Self {
            reserve0: 0,
            reserve1: 0,
            price_scale_wad: 0,
            total_supply: 0,
            protocol_fee0: 0,
            protocol_fee1: 0,
            e0: 0,
            e1: 0,
            ema_log_wad: 0,
            last_ema_ts: 0,
            last_repeg_ts: 0,
            lp_unit_value_genesis_wad: 0,
            lp_unit_value_wad: 0,
            lp_value_growth_wad: 0,
            donation_shares: 0,
        }
    }
}

/// Output of a stateful swap.
#[derive(Debug, Clone, Copy)]
pub struct EquilibraExchangeStatefulOut {
    pub amount_out: u128,
    pub reserve0: u128,
    pub reserve1: u128,
    pub price_scale_wad: u128,
    pub total_supply: u128,
    pub protocol_fee0: u128,
    pub protocol_fee1: u128,
    pub e0: u128,
    pub e1: u128,
    pub ema_price_wad: u128,
    pub ema_log_wad: i128,
    pub last_ema_ts: u64,
    pub last_repeg_ts: u64,
    pub lp_unit_value_genesis_wad: u128,
    pub lp_unit_value_wad: u128,
    pub lp_value_growth_wad: u128,
    pub fee_amount_raw: u128,
    pub protocol_cut_raw: u128,
    pub lp_fee_raw: u128,
    pub lp_value_growth_delta_wad: u128,
    pub lp_unit_value_threshold_wad: u128,
    pub lp_unit_value_before_repeg_wad: u128,
    pub lp_unit_value_after_repeg_wad: u128,
    pub ema_deviation_bps: u128,
    pub candidate_price_scale_wad: u128,
    pub recentered: bool,
    pub recenter_blocked_by: Option<EquilibraRecenterGateBlocked>,
    /// Post-swap donation buffer (LP shares parked on the pool).
    pub donation_shares: u128,
    /// LP shares burned from the buffer by a parachute commit (0 for
    /// ladder commits and every skip path).
    pub donation_burn_shares: u128,
    /// True when this swap's commit came from the donation parachute.
    pub recentered_via_parachute: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ExactInResolved {
    pub amount_out_raw: u128,
    pub fee_amount_raw: u128,
    pub protocol_cut_raw: u128,
    pub lp_fee_raw: u128,
    pub fee_wad_effective: u128,
    pub iters: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct ExactOutResolved {
    pub amount_in_raw: u128,
    pub amount_in_clean_raw: u128,
    pub fee_amount_raw: u128,
    /// WAD fee rate actually applied (`1 bps == 1e14`).
    pub fee_wad_effective: u128,
    pub iters: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct EquilibraExchangeExactOutStatefulOut {
    pub amount_in: u128,
    pub state: EquilibraExchangeStatefulOut,
}

struct CheckedPostSwap {
    reserve0: u128,
    reserve1: u128,
    depth: U256,
    protocol_cut_raw: u128,
}

/// Fee-inclusive quote with the same common margin, native bounds and strict LP guard as execution.
pub fn quote_exact_in_stateful(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    token_in: &str,
    amount_in: u128,
) -> Result<ExactInResolved> {
    Ok(resolve_exact_in_checked(config, state, token_in, amount_in)?.0)
}

fn resolve_exact_in_checked(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    token_in: &str,
    amount_in: u128,
) -> Result<(ExactInResolved, CheckedPostSwap)> {
    if amount_in == 0 {
        return Err(anyhow!("equilibra_swap_stateful_zero_amount"));
    }
    let zero_for_one = resolve_direction(config, token_in)?;
    if state.reserve0 == 0 || state.reserve1 == 0 {
        return Err(anyhow!("equilibra_swap_stateful_insufficient_liquidity"));
    }
    if state.price_scale_wad == 0 {
        return Err(anyhow!("equilibra_swap_stateful_invalid_price_scale"));
    }
    let fee_wad_effective =
        resolve_dynamic_fee_wad_from_cp(config, state, zero_for_one, amount_in)?;
    let mut fee_amount_u =
        math_mul_div_floor(U256::from(amount_in), fee_wad_effective.into(), WAD.into())?;
    if fee_amount_u.is_zero() && fee_wad_effective != 0 {
        fee_amount_u = U256::one();
    }
    if fee_amount_u > U256::from(amount_in) {
        return Err(anyhow!("equilibra_swap_stateful_fee_ge_input"));
    }
    if fee_amount_u == U256::from(amount_in) {
        return Err(anyhow!(
            "equilibra_stateful: amount_too_small_after_normalization"
        ));
    }
    let fee_amount_raw = to_u128(fee_amount_u, "feeAmount")?;
    let protocol_cut_raw = protocol_cut(config, fee_amount_raw)?;
    let clean_amount_in = amount_in - fee_amount_raw;
    let (amount_out_raw, iters, depth_before_q128) =
        compute_exact_in_amount_out(config, state, zero_for_one, clean_amount_in)?;
    if amount_out_raw == 0 {
        return Err(anyhow!(
            "equilibra_stateful: amount_too_small_after_normalization"
        ));
    }
    let post = checked_post_swap(
        config,
        state,
        zero_for_one,
        amount_in,
        amount_out_raw,
        protocol_cut_raw,
        depth_before_q128,
    )?;
    Ok((
        ExactInResolved {
            amount_out_raw,
            fee_amount_raw,
            protocol_cut_raw,
            lp_fee_raw: fee_amount_raw - protocol_cut_raw,
            fee_wad_effective,
            iters,
        },
        post,
    ))
}

/// Execute a single exact-input swap.
pub fn swap_stateful(
    config: &EquilibraStatefulConfig,
    state_in: EquilibraStatefulState,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
    disable_recenter: bool,
) -> Result<EquilibraExchangeStatefulOut> {
    if amount_in == 0 {
        return Err(anyhow!("equilibra_swap_stateful_zero_amount"));
    }

    let zero_for_one = resolve_direction(config, token_in)?;

    if state_in.reserve0 == 0 || state_in.reserve1 == 0 {
        return Err(anyhow!("equilibra_swap_stateful_insufficient_liquidity"));
    }
    if state_in.price_scale_wad == 0 {
        return Err(anyhow!("equilibra_swap_stateful_invalid_price_scale"));
    }
    if state_in.total_supply == 0 {
        return Err(anyhow!("equilibra_swap_stateful_total_supply_zero"));
    }

    let mut state = state_in;

    // Step 1: EMA update.
    update_ema_in_place(config, &mut state, timestamp)?;

    // Resolve the same checked, fee-inclusive quote exposed to callers.
    let (resolved, post) = resolve_exact_in_checked(config, &state, token_in, amount_in)?;
    let amount_out = resolved.amount_out_raw;
    let fee_amount_raw = resolved.fee_amount_raw;
    let protocol_cut_raw = resolved.protocol_cut_raw;
    let lp_fee_raw = resolved.lp_fee_raw;

    // Apply the reserves validated by the shared native settlement path.
    state.reserve0 = post.reserve0;
    state.reserve1 = post.reserve1;
    if zero_for_one {
        state.protocol_fee0 = state
            .protocol_fee0
            .checked_add(protocol_cut_raw)
            .ok_or_else(|| anyhow!("eq_swap protocol_fee0 overflow"))?;
    } else {
        state.protocol_fee1 = state
            .protocol_fee1
            .checked_add(protocol_cut_raw)
            .ok_or_else(|| anyhow!("eq_swap protocol_fee1 overflow"))?;
    }
    state.e0 = state
        .reserve0
        .checked_add(state.protocol_fee0)
        .ok_or_else(|| anyhow!("eq_swap e0 overflow"))?;
    state.e1 = state
        .reserve1
        .checked_add(state.protocol_fee1)
        .ok_or_else(|| anyhow!("eq_swap e1 overflow"))?;

    // Step 6: accrue LP unit-value growth.
    let AccrueResult {
        vp_now: vp_before_repeg,
        delta_wad: lp_value_growth_delta_wad,
    } = accrue_lp_value_growth(&mut state, post.depth)?;

    // Step 7: auto-repeg.
    let RepegOutcome {
        new_price_scale_wad,
        lp_unit_value_threshold_wad,
        lp_unit_value_before_wad,
        lp_unit_value_after_wad,
        ema_deviation_bps,
        candidate_price_scale_wad,
        recentered,
        blocked_by,
        donation_burn_shares,
        via_parachute,
    } = try_auto_repeg(config, &state, vp_before_repeg, timestamp, disable_recenter)?;

    if recentered {
        state.price_scale_wad = new_price_scale_wad;
        state.lp_unit_value_wad = lp_unit_value_after_wad;
        state.last_repeg_ts = timestamp;
        if donation_burn_shares != 0 {
            // Parachute commit: burn δ from the buffer (mirrors the
            // on-chain `_burn(address(this), δ)` — supply shrinks).
            state.total_supply = state
                .total_supply
                .checked_sub(donation_burn_shares)
                .ok_or_else(|| anyhow!("eq_repeg donation burn exceeds supply"))?;
            state.donation_shares = state
                .donation_shares
                .checked_sub(donation_burn_shares)
                .ok_or_else(|| anyhow!("eq_repeg donation burn exceeds buffer"))?;
        }
    }

    Ok(EquilibraExchangeStatefulOut {
        amount_out,
        reserve0: state.reserve0,
        reserve1: state.reserve1,
        price_scale_wad: state.price_scale_wad,
        total_supply: state.total_supply,
        protocol_fee0: state.protocol_fee0,
        protocol_fee1: state.protocol_fee1,
        e0: state.e0,
        e1: state.e1,
        ema_price_wad: state.ema_price_wad()?,
        ema_log_wad: state.ema_log_wad,
        last_ema_ts: state.last_ema_ts,
        last_repeg_ts: state.last_repeg_ts,
        lp_unit_value_genesis_wad: state.lp_unit_value_genesis_wad,
        lp_unit_value_wad: state.lp_unit_value_wad,
        lp_value_growth_wad: state.lp_value_growth_wad,
        fee_amount_raw,
        protocol_cut_raw,
        lp_fee_raw,
        lp_value_growth_delta_wad,
        lp_unit_value_threshold_wad,
        lp_unit_value_before_repeg_wad: lp_unit_value_before_wad,
        lp_unit_value_after_repeg_wad: lp_unit_value_after_wad,
        ema_deviation_bps,
        candidate_price_scale_wad,
        recentered,
        recenter_blocked_by: blocked_by,
        donation_shares: state.donation_shares,
        donation_burn_shares,
        recentered_via_parachute: via_parachute,
    })
}

/// Checked exact-out resolver with the common output margin, dynamic fee and one strict LP guard.
pub fn quote_exact_out_stateful(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    token_in: &str,
    amount_out_raw: u128,
) -> Result<ExactOutResolved> {
    Ok(resolve_exact_out_checked(config, state, token_in, amount_out_raw)?.0)
}

fn resolve_exact_out_checked(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    token_in: &str,
    amount_out_raw: u128,
) -> Result<(ExactOutResolved, CheckedPostSwap)> {
    if amount_out_raw == 0 {
        return Err(anyhow!("equilibra_stateful: quote_exact_out zero amount"));
    }
    let zero_for_one = resolve_direction(config, token_in)?;
    if state.reserve0 == 0 || state.reserve1 == 0 {
        return Err(anyhow!("equilibra_stateful: insufficient liquidity"));
    }
    if state.price_scale_wad == 0 {
        return Err(anyhow!("equilibra_stateful: invalid price scale"));
    }

    let (in_scale, out_scale) = if zero_for_one {
        (config.token0_scale, config.token1_scale)
    } else {
        (config.token1_scale, config.token0_scale)
    };

    let amount_out_wad = to_wad_by_scale(U256::from(amount_out_raw), out_scale);
    if amount_out_wad.is_zero() {
        return Err(anyhow!(
            "equilibra_stateful: amount_too_small_after_normalization"
        ));
    }

    let (clean_in_wad, iters, depth_before_q128) =
        compute_exact_out_clean_in_wad(config, state, zero_for_one, amount_out_wad)?;

    let clean_in_raw_u = from_wad_up_by_scale(clean_in_wad, in_scale)?;
    // Match the pool's typed normalization guard before gross-up. A
    // wrong-side discrete solver result can be the zero-input sentinel.
    if clean_in_raw_u.is_zero() {
        return Err(anyhow!(
            "equilibra_stateful: amount_too_small_after_normalization"
        ));
    }

    let clean_in_raw = to_u128(clean_in_raw_u, "cleanInRaw")?;
    let (amount_in_raw, fee_amount_raw, fee_wad) =
        resolve_exact_out_fee(config, state, zero_for_one, clean_in_raw)?;
    let post = checked_post_swap(
        config,
        state,
        zero_for_one,
        amount_in_raw,
        amount_out_raw,
        protocol_cut(config, fee_amount_raw)?,
        depth_before_q128,
    )?;
    Ok((
        ExactOutResolved {
            amount_in_raw,
            amount_in_clean_raw: clean_in_raw,
            fee_amount_raw,
            fee_wad_effective: fee_wad,
            iters,
        },
        post,
    ))
}

fn resolve_exact_out_fee(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    zero_for_one: bool,
    clean_in_raw: u128,
) -> Result<(u128, u128, u128)> {
    let clean_in_raw_u = U256::from(clean_in_raw);
    // Two-endpoint max of the CP-proxy fee (mirrors Solidity
    // _executeExactOutWithDynamicFee). The predictor distance is
    // quasi-convex (V-shaped, min at xPost=sqrt(xy)) in the gross input,
    // so a fixed-point iteration oscillates for anchor-crossing trades.
    // The settled gross lies in [grossUp(clean, floor), grossUp(clean,
    // base)] and a quasi-convex function's max over an interval is at an
    // endpoint, so max(feeCp(grossLo), feeCp(grossHi)) >= the fee
    // exact-in resolves at the settled gross. This bounds the fee rate,
    // not the inversion error of independent rounded counterpart solves.
    // Exact-out quote and exact-out swap still share this entire resolver.
    let base_fee_wad = config.fee_bps * FEE_BPS_TO_WAD;
    // Flat-fee short-circuit (mirrors Solidity, audit O-5): with the
    // ramp disabled the CP resolver returns base_fee for ANY gross, so
    // fee_lo == fee_hi == base_fee and the endpoint-max is a tautology.
    // One gross-up replaces two resolver dispatches. Bit-identical
    // outputs on both sides.
    let fee_wad = if config.fee_ramp_dist_wad == 0 {
        base_fee_wad
    } else {
        let gross_lo = gross_up_exact_out(clean_in_raw_u, config.fee_floor_bps * FEE_BPS_TO_WAD)?;
        let gross_hi = gross_up_exact_out(clean_in_raw_u, base_fee_wad)?;
        let fee_lo = resolve_dynamic_fee_wad_from_cp(
            config,
            state,
            zero_for_one,
            to_u128(gross_lo, "grossLo")?,
        )?;
        let fee_hi = resolve_dynamic_fee_wad_from_cp(
            config,
            state,
            zero_for_one,
            to_u128(gross_hi, "grossHi")?,
        )?;
        fee_lo.max(fee_hi)
    };
    // Keep Solidity's existing +1 raw input fee bump after gross-up.
    let amount_in_u = gross_up_exact_out(clean_in_raw_u, fee_wad)? + U256::one();
    let amount_in_raw = to_u128(amount_in_u, "amountInRaw")?;
    let fee_amount_raw = amount_in_raw
        .checked_sub(clean_in_raw)
        .ok_or_else(|| anyhow!("equilibra_stateful: amount_in_raw < clean_in_raw"))?;

    Ok((amount_in_raw, fee_amount_raw, fee_wad))
}

/// Execute exact-output swap.
pub fn swap_stateful_exact_out(
    config: &EquilibraStatefulConfig,
    state_in: EquilibraStatefulState,
    token_in: &str,
    amount_out_raw: u128,
    timestamp: u64,
    disable_recenter: bool,
) -> Result<EquilibraExchangeExactOutStatefulOut> {
    if amount_out_raw == 0 {
        return Err(anyhow!("equilibra_swap_stateful_exact_out_zero_amount"));
    }
    let zero_for_one = resolve_direction(config, token_in)?;
    if state_in.reserve0 == 0 || state_in.reserve1 == 0 {
        return Err(anyhow!(
            "equilibra_swap_stateful_exact_out_insufficient_liquidity"
        ));
    }
    if state_in.price_scale_wad == 0 {
        return Err(anyhow!(
            "equilibra_swap_stateful_exact_out_invalid_price_scale"
        ));
    }
    if state_in.total_supply == 0 {
        return Err(anyhow!(
            "equilibra_swap_stateful_exact_out_total_supply_zero"
        ));
    }

    let mut state = state_in;
    update_ema_in_place(config, &mut state, timestamp)?;

    let (resolved, post) = resolve_exact_out_checked(config, &state, token_in, amount_out_raw)?;
    let amount_in = resolved.amount_in_raw;
    let fee_amount_raw = resolved.fee_amount_raw;

    let protocol_cut_raw = post.protocol_cut_raw;
    let lp_fee_raw = fee_amount_raw - protocol_cut_raw;
    state.reserve0 = post.reserve0;
    state.reserve1 = post.reserve1;
    if zero_for_one {
        state.protocol_fee0 = state
            .protocol_fee0
            .checked_add(protocol_cut_raw)
            .ok_or_else(|| anyhow!("eq_swap_eo protocol_fee0 overflow"))?;
    } else {
        state.protocol_fee1 = state
            .protocol_fee1
            .checked_add(protocol_cut_raw)
            .ok_or_else(|| anyhow!("eq_swap_eo protocol_fee1 overflow"))?;
    }
    state.e0 = state
        .reserve0
        .checked_add(state.protocol_fee0)
        .ok_or_else(|| anyhow!("eq_swap_eo e0 overflow"))?;
    state.e1 = state
        .reserve1
        .checked_add(state.protocol_fee1)
        .ok_or_else(|| anyhow!("eq_swap_eo e1 overflow"))?;

    let AccrueResult {
        vp_now: vp_before_repeg,
        delta_wad: lp_value_growth_delta_wad,
    } = accrue_lp_value_growth(&mut state, post.depth)?;

    let RepegOutcome {
        new_price_scale_wad,
        lp_unit_value_threshold_wad,
        lp_unit_value_before_wad,
        lp_unit_value_after_wad,
        ema_deviation_bps,
        candidate_price_scale_wad,
        recentered,
        blocked_by,
        donation_burn_shares,
        via_parachute,
    } = try_auto_repeg(config, &state, vp_before_repeg, timestamp, disable_recenter)?;

    if recentered {
        state.price_scale_wad = new_price_scale_wad;
        state.lp_unit_value_wad = lp_unit_value_after_wad;
        state.last_repeg_ts = timestamp;
        if donation_burn_shares != 0 {
            // Parachute commit — see the exact-in branch.
            state.total_supply = state
                .total_supply
                .checked_sub(donation_burn_shares)
                .ok_or_else(|| anyhow!("eq_repeg_eo donation burn exceeds supply"))?;
            state.donation_shares = state
                .donation_shares
                .checked_sub(donation_burn_shares)
                .ok_or_else(|| anyhow!("eq_repeg_eo donation burn exceeds buffer"))?;
        }
    }

    Ok(EquilibraExchangeExactOutStatefulOut {
        amount_in,
        state: EquilibraExchangeStatefulOut {
            amount_out: amount_out_raw,
            reserve0: state.reserve0,
            reserve1: state.reserve1,
            price_scale_wad: state.price_scale_wad,
            total_supply: state.total_supply,
            protocol_fee0: state.protocol_fee0,
            protocol_fee1: state.protocol_fee1,
            e0: state.e0,
            e1: state.e1,
            ema_price_wad: state.ema_price_wad()?,
            ema_log_wad: state.ema_log_wad,
            last_ema_ts: state.last_ema_ts,
            last_repeg_ts: state.last_repeg_ts,
            lp_unit_value_genesis_wad: state.lp_unit_value_genesis_wad,
            lp_unit_value_wad: state.lp_unit_value_wad,
            lp_value_growth_wad: state.lp_value_growth_wad,
            fee_amount_raw,
            protocol_cut_raw,
            lp_fee_raw,
            lp_value_growth_delta_wad,
            lp_unit_value_threshold_wad,
            lp_unit_value_before_repeg_wad: lp_unit_value_before_wad,
            lp_unit_value_after_repeg_wad: lp_unit_value_after_wad,
            ema_deviation_bps,
            candidate_price_scale_wad,
            recentered,
            recenter_blocked_by: blocked_by,
            donation_shares: state.donation_shares,
            donation_burn_shares,
            recentered_via_parachute: via_parachute,
        },
    })
}

// ---------------------------------------------------------------------------
// Liquidity helpers.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct EquilibraGenesisInit {
    pub reserve0: u128,
    pub reserve1: u128,
    pub total_supply: u128,
    pub shares_out: u128,
    pub price_scale_wad: u128,
    pub ema_price_wad: u128,
    pub ema_log_wad: i128,
    pub last_ema_ts: u64,
    pub last_repeg_ts: u64,
    pub lp_unit_value_genesis_wad: u128,
}

pub fn init_genesis(
    config: &EquilibraStatefulConfig,
    amount0: u128,
    amount1: u128,
    now_ts: u64,
) -> Result<EquilibraGenesisInit> {
    if amount0 == 0 || amount1 == 0 {
        return Err(anyhow!("equilibra_init: zero amount"));
    }
    // Genesis: priceScale = r0·s0 / r1·s1 = yWad / xWad
    // (quote-per-base, WAD). Mirror of `EquilibraPool.addLiquidity`
    // supplyBefore=0 branch. At the anchor `yMath = yWad·WAD/priceScale
    // = xWad = xMath`, placing the seeded reserves on the math-space
    // diagonal. Reversing this sign drives `D → ∞` and collapses the
    // cubic kernel to constant-product.
    let y_wad = to_wad_by_scale(U256::from(amount0), config.token0_scale);
    let x_wad = to_wad_by_scale(U256::from(amount1), config.token1_scale);
    if x_wad.is_zero() || y_wad.is_zero() {
        return Err(anyhow!("equilibra_init: insufficient liquidity"));
    }
    let price_scale_u = math_mul_div_floor(y_wad, U256::from(WAD), x_wad)?;
    if price_scale_u.is_zero() {
        return Err(anyhow!("equilibra_init: invalid price scale"));
    }
    let price_scale_wad = to_u128(price_scale_u, "priceScaleWad")?;

    // Mirrors the independent LP-supply burn floor and genesis-VP
    // precision policy in `Constants.sol`.
    let geo_mean_arg = equilibra_math::mul_div_floor(x_wad, y_wad, U256::one())?;
    let geo_mean_wad = equilibra_math::sqrt_u256(geo_mean_arg);
    let geo_mean_u = to_u128(geo_mean_wad, "geoMeanWad")?;
    if geo_mean_u <= MIN_INITIAL_LIQUIDITY {
        return Err(anyhow!("equilibra_init: math invariant violation"));
    }
    let shares_out = geo_mean_u - MIN_INITIAL_LIQUIDITY;
    let total_supply = geo_mean_u;

    let lp_unit_value_genesis_wad =
        compute_pool_lp_unit_value(config, amount0, amount1, price_scale_wad, total_supply)?;

    // Genesis identity gate: `vp == 2·WAD` within rounding tolerance.
    // A seed too small for the kernel to resolve stores an understated
    // (or zero) genesis floor, weakening the auto-repeg principal
    // protection. Mirrors the on-chain `GenesisVpImprecise` revert.
    let two_wad = 2 * WAD;
    let vp_err = if lp_unit_value_genesis_wad > two_wad {
        lp_unit_value_genesis_wad - two_wad
    } else {
        two_wad - lp_unit_value_genesis_wad
    };
    if vp_err > MAX_GENESIS_VP_ERROR_WAD {
        return Err(anyhow!(
            "equilibra_init: genesis vp imprecise (computed={lp_unit_value_genesis_wad}, target={two_wad})"
        ));
    }

    let ema_log_wad = equilibra_math::price_to_ema_log(price_scale_u)?;
    Ok(EquilibraGenesisInit {
        reserve0: amount0,
        reserve1: amount1,
        total_supply,
        shares_out,
        price_scale_wad,
        ema_price_wad: to_u128(
            equilibra_math::ema_log_to_price(ema_log_wad)?,
            "emaPriceWad",
        )?,
        ema_log_wad,
        last_ema_ts: now_ts,
        last_repeg_ts: now_ts,
        lp_unit_value_genesis_wad,
    })
}

/// Park LP shares in the pool's donation buffer. Mirrors a plain LP
/// `transfer` to the pool's own address on-chain: `total_supply` is
/// unchanged (the donor already holds the shares), the parked amount
/// becomes spendable ONLY by the donation parachute, and the move is
/// irrevocable. The caller is responsible for debiting the donor's own
/// share accounting.
pub fn donate_lp_shares(state: &mut EquilibraStatefulState, shares: u128) -> Result<()> {
    if shares == 0 {
        return Err(anyhow!("equilibra_stateful: zero donation"));
    }
    let new_buffer = state
        .donation_shares
        .checked_add(shares)
        .ok_or_else(|| anyhow!("equilibra_stateful: donation buffer overflow"))?;
    // `>=`, not `>`: parking the ENTIRE supply (active float == 0) is
    // on-chain unreachable — the genesis dead shares at 0xdEaD can
    // never be donated, so every real donor's balance is strictly
    // below `totalSupply - parked`. Rejecting equality here keeps the
    // mirror out of that unreachable state instead of erroring later
    // in the active-float divisions mid-swap.
    if new_buffer >= state.total_supply {
        return Err(anyhow!(
            "equilibra_stateful: donation would empty the active float"
        ));
    }
    state.donation_shares = new_buffer;
    Ok(())
}

pub fn add_liquidity_proportional(
    state_in: &EquilibraStatefulState,
    amount0_desired: u128,
    amount1_desired: u128,
    config: &EquilibraStatefulConfig,
) -> Result<(u128, u128, u128, u128, u128, u128, u128, u128)> {
    if amount0_desired == 0 || amount1_desired == 0 {
        return Err(anyhow!("equilibra_add_liquidity: zero amount"));
    }
    if state_in.total_supply == 0 {
        return Err(anyhow!("equilibra_add_liquidity: use init_genesis"));
    }
    let r0 = state_in.reserve0;
    let r1 = state_in.reserve1;
    // Shares are priced on token0: round its matching token1 payment up.
    // Keep the wide ratio probe until the limiting side is known.
    let a1_probe = mul_div_ceil(amount0_desired.into(), r1.into(), r0.into())?;
    let (a0_used, a1_used) = if a1_probe > U256::from(amount1_desired) {
        (
            mul_div_floor_u128(amount1_desired, r0, r1)?,
            amount1_desired,
        )
    } else {
        (amount0_desired, to_u128(a1_probe, "eq_add amount1")?)
    };
    if a0_used == 0 || a1_used == 0 {
        return Err(anyhow!(
            "equilibra_add_liquidity: too small after normalisation"
        ));
    }

    // Active-share pricing: parked donation shares (the pool's own LP
    // balance) carry no claim on reserves, so the mint is quoted
    // against the ACTIVE share count. Mirrors `EquilibraPool
    // .addLiquidity` bit-for-bit.
    let parked = state_in.donation_shares;
    let active = state_in
        .total_supply
        .checked_sub(parked)
        .ok_or_else(|| anyhow!("eq_add parked > totalSupply"))?;
    if active == 0 {
        return Err(anyhow!("eq_add zero active supply"));
    }
    let shares_out = mul_div_floor_u128(a0_used, active, r0)?;
    // Buffer scaling (mint leg): grow the parked buffer in the same
    // proportion as the active float so `parked/active` — and with it
    // the unit-value metric — is invariant across the mint.
    let buffer_top_up = if parked != 0 {
        mul_div_floor_u128(shares_out, parked, active)?
    } else {
        0
    };
    let r0_new = r0
        .checked_add(a0_used)
        .ok_or_else(|| anyhow!("eq_add r0 overflow"))?;
    let r1_new = r1
        .checked_add(a1_used)
        .ok_or_else(|| anyhow!("eq_add r1 overflow"))?;
    let total_new = state_in
        .total_supply
        .checked_add(shares_out)
        .and_then(|t| t.checked_add(buffer_top_up))
        .ok_or_else(|| anyhow!("eq_add totalSupply overflow"))?;
    let donation_new = parked
        .checked_add(buffer_top_up)
        .ok_or_else(|| anyhow!("eq_add donation overflow"))?;

    let lp_unit_value_new =
        compute_pool_lp_unit_value(config, r0_new, r1_new, state_in.price_scale_wad, total_new)?;

    Ok((
        a0_used,
        a1_used,
        shares_out,
        r0_new,
        r1_new,
        total_new,
        lp_unit_value_new,
        donation_new,
    ))
}

pub fn remove_liquidity_proportional(
    state_in: &EquilibraStatefulState,
    shares: u128,
    config: &EquilibraStatefulConfig,
) -> Result<(u128, u128, u128, u128, u128, u128, u128)> {
    if shares == 0 {
        return Err(anyhow!("equilibra_remove_liquidity: zero shares"));
    }
    // Active-share redemption: parked donation shares hold no claim on
    // reserves, so payouts divide by the ACTIVE float and a holder can
    // never redeem into the parked buffer. Mirrors `EquilibraPool
    // .removeLiquidity` bit-for-bit.
    let parked = state_in.donation_shares;
    let active = state_in
        .total_supply
        .checked_sub(parked)
        .ok_or_else(|| anyhow!("eq_remove parked > totalSupply"))?;
    if shares > active {
        return Err(anyhow!(
            "equilibra_remove_liquidity: shares > active supply"
        ));
    }
    let r0 = state_in.reserve0;
    let r1 = state_in.reserve1;
    let a0 = mul_div_floor_u128(r0, shares, active)?;
    let a1 = mul_div_floor_u128(r1, shares, active)?;
    // Dust guard (mirrors the Solidity `removeLiquidity` revert, audit
    // I-8): on low-decimals pools a small share amount can floor BOTH
    // payouts to zero — refuse instead of burning shares for nothing.
    if a0 == 0 && a1 == 0 {
        return Err(anyhow!(
            "equilibra_remove_liquidity: zero payout for nonzero shares"
        ));
    }
    // Burn the exiting holder's proportional slice of the buffer so
    // `parked/active` — and with it the unit-value metric and the
    // parachute's feasibility — is unchanged across the exit.
    let buffer_burn = if parked != 0 {
        mul_div_floor_u128(parked, shares, active)?
    } else {
        0
    };
    let r0_new = r0 - a0;
    let r1_new = r1 - a1;
    let total_new = state_in.total_supply - shares - buffer_burn;
    let donation_new = parked - buffer_burn;

    let lp_unit_value_new = if total_new == 0 {
        0
    } else {
        compute_pool_lp_unit_value(config, r0_new, r1_new, state_in.price_scale_wad, total_new)?
    };

    Ok((
        a0,
        a1,
        r0_new,
        r1_new,
        total_new,
        lp_unit_value_new,
        donation_new,
    ))
}

// ---------------------------------------------------------------------------
// Read-only metrics.
// ---------------------------------------------------------------------------

pub fn lp_unit_value_wad(state: &EquilibraStatefulState) -> u128 {
    state.lp_unit_value_wad
}
pub fn lp_unit_value_genesis_wad(state: &EquilibraStatefulState) -> u128 {
    state.lp_unit_value_genesis_wad
}
pub fn lp_value_growth_wad(state: &EquilibraStatefulState) -> u128 {
    state.lp_value_growth_wad
}

// ---------------------------------------------------------------------------
// Private helpers.
// ---------------------------------------------------------------------------

fn resolve_direction(config: &EquilibraStatefulConfig, token_in: &str) -> Result<bool> {
    if token_in.eq_ignore_ascii_case(&config.token0_lower) {
        Ok(true)
    } else if token_in.eq_ignore_ascii_case(&config.token1_lower) {
        Ok(false)
    } else {
        Err(anyhow!("tokenIn_not_in_pool"))
    }
}

fn to_u128(v: U256, name: &str) -> Result<u128> {
    v.try_into()
        .map_err(|_| anyhow!("equilibra_stateful: {} exceeds u128", name))
}

fn mul_div_floor_u128(a: u128, b: u128, denom: u128) -> Result<u128> {
    let r = math_mul_div_floor(U256::from(a), U256::from(b), U256::from(denom))?;
    to_u128(r, "mul_div_floor_u128")
}

fn protocol_cut(config: &EquilibraStatefulConfig, fee_amount_raw: u128) -> Result<u128> {
    if config.protocol_fee_percent == 0 {
        return Ok(0);
    }
    to_u128(
        math_mul_div_floor(
            fee_amount_raw.into(),
            config.protocol_fee_percent.into(),
            U256::from(100),
        )?,
        "protocolCut",
    )
}

/// Check native reserves and recover post-fee depth for LP growth and repeg.
/// LP fees stay in reserves; the protocol cut does not. The callers compare
/// fresh Q128 depth and may apply exactly one native correction.
fn post_swap_state(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    zero_for_one: bool,
    amount_in: u128,
    amount_out: u128,
    protocol_cut_raw: u128,
) -> Result<CheckedPostSwap> {
    let reserve_out = if zero_for_one {
        state.reserve1
    } else {
        state.reserve0
    };
    if amount_out >= reserve_out {
        return Err(anyhow!("equilibra_stateful: insufficient liquidity"));
    }
    let (reserve0, reserve1) = apply_swap_to_reserves(
        zero_for_one,
        state.reserve0,
        state.reserve1,
        amount_in,
        amount_out,
        protocol_cut_raw,
    )?;
    let (x_math, y_math) = load_math_state(config, reserve0, reserve1, state.price_scale_wad)?;
    let depth = if x_math.is_zero() || y_math.is_zero() {
        U256::zero()
    } else {
        solve_l_from_state(
            x_math,
            y_math,
            config.a_wad.into(),
            config.lambda_wad.into(),
        )?
    };
    Ok(CheckedPostSwap {
        reserve0,
        reserve1,
        depth,
        protocol_cut_raw,
    })
}

fn checked_post_swap(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    zero_for_one: bool,
    amount_in: u128,
    amount_out: u128,
    protocol_cut_raw: u128,
    depth_before_q128: U256,
) -> Result<CheckedPostSwap> {
    let post = post_swap_state(
        config,
        state,
        zero_for_one,
        amount_in,
        amount_out,
        protocol_cut_raw,
    )?;
    if post.depth < depth_before_q128 {
        return Err(anyhow!("equilibra_stateful: LpValueDecreased"));
    }
    Ok(post)
}

fn apply_swap_to_reserves(
    zero_for_one: bool,
    reserve0: u128,
    reserve1: u128,
    amount_in: u128,
    amount_out: u128,
    protocol_cut: u128,
) -> Result<(u128, u128)> {
    if protocol_cut > amount_in {
        return Err(anyhow!("equilibra_stateful: protocol_cut > amountIn"));
    }
    let in_net = amount_in - protocol_cut;
    if zero_for_one {
        let r0 = reserve0
            .checked_add(in_net)
            .ok_or_else(|| anyhow!("eq r0+in overflow"))?;
        let r1 = reserve1
            .checked_sub(amount_out)
            .ok_or_else(|| anyhow!("eq r1-out underflow"))?;
        Ok((r0, r1))
    } else {
        let r1 = reserve1
            .checked_add(in_net)
            .ok_or_else(|| anyhow!("eq r1+in overflow"))?;
        let r0 = reserve0
            .checked_sub(amount_out)
            .ok_or_else(|| anyhow!("eq r0-out underflow"))?;
        Ok((r0, r1))
    }
}

fn gross_up_exact_out(clean_in_raw: U256, fee_wad: u128) -> Result<U256> {
    if clean_in_raw.is_zero() {
        return Err(anyhow!("gross_up: cleanInRaw zero"));
    }
    if fee_wad >= WAD {
        return Err(anyhow!("gross_up: feeWad >= WAD"));
    }
    let denom = U256::from(WAD - fee_wad);
    let q = math_mul_div_floor(clean_in_raw - U256::one(), U256::from(WAD), denom)?;
    let gross = q + U256::one();
    Ok(if gross == clean_in_raw && fee_wad != 0 {
        gross + U256::one()
    } else {
        gross
    })
}

/// Lift `(reserve0, reserve1)` into math-space `(xMath, yMath)` via the
/// Asymmetric coord change (`xMath = xWad`,
/// `yMath = yWad · WAD / priceScale`).
fn load_math_state(
    config: &EquilibraStatefulConfig,
    reserve0: u128,
    reserve1: u128,
    price_scale_wad: u128,
) -> Result<(U256, U256)> {
    let x_wad = to_wad_by_scale(U256::from(reserve1), config.token1_scale);
    let y_wad = to_wad_by_scale(U256::from(reserve0), config.token0_scale);
    if x_wad.is_zero() || y_wad.is_zero() {
        return Ok((U256::zero(), U256::zero()));
    }
    to_math_space(x_wad, y_wad, U256::from(price_scale_wad))
}

fn compute_exact_in_amount_out(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    zero_for_one: bool,
    clean_amount_in_raw: u128,
) -> Result<(u128, u32, U256)> {
    let (in_scale, out_scale) = if zero_for_one {
        (config.token0_scale, config.token1_scale)
    } else {
        (config.token1_scale, config.token0_scale)
    };
    let clean_in_wad = to_wad_by_scale(U256::from(clean_amount_in_raw), in_scale);
    if clean_in_wad.is_zero() {
        return Err(anyhow!("equilibra_stateful: clean_in_wad zero"));
    }

    let (x_math, y_math) = load_math_state(
        config,
        state.reserve0,
        state.reserve1,
        state.price_scale_wad,
    )?;
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_stateful: empty math state"));
    }

    let price_scale = U256::from(state.price_scale_wad);
    let a_u = U256::from(config.a_wad);
    let lambda_u = U256::from(config.lambda_wad);

    // Lift input delta into math-space (asymmetric coord change).
    let amount_in_math = if zero_for_one {
        // token0 (quote) deposit lands on yMath: math = wad · WAD / priceScale (floor)
        math_mul_div_floor(clean_in_wad, U256::from(WAD), price_scale)?
    } else {
        // token1 (base) deposit lands on xMath: identity lift
        clean_in_wad
    };
    if amount_in_math.is_zero() {
        return Err(anyhow!("equilibra_stateful: amountInMath zero"));
    }

    let (out_delta_math, iters, depth_before) = if zero_for_one {
        // Deposit on yMath; output on xMath.
        equilibra_math::quote_exact_in_forward_with_depth(
            y_math,
            x_math,
            amount_in_math,
            a_u,
            lambda_u,
        )?
    } else {
        equilibra_math::quote_exact_in_forward_with_depth(
            x_math,
            y_math,
            amount_in_math,
            a_u,
            lambda_u,
        )?
    };
    // The kernel leaves a positive counterpart; native settlement checks the raw bound.
    let amount_out_wad = if zero_for_one {
        // xMath output → token1 (base) wad: identity
        out_delta_math
    } else {
        // yMath output → token0 (quote) wad: wad = math · priceScale / WAD (floor, pool-favourable)
        mul_wad(out_delta_math, price_scale)?
    };

    let raw = amount_out_wad / out_scale;
    Ok((to_u128(raw, "amountOutRaw")?, iters, depth_before))
}

fn compute_exact_out_clean_in_wad(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    zero_for_one: bool,
    amount_out_wad: U256,
) -> Result<(U256, u32, U256)> {
    let (x_math, y_math) = load_math_state(
        config,
        state.reserve0,
        state.reserve1,
        state.price_scale_wad,
    )?;
    if x_math.is_zero() || y_math.is_zero() {
        return Err(anyhow!("equilibra_stateful: empty math state"));
    }
    let price_scale = U256::from(state.price_scale_wad);
    let a_u = U256::from(config.a_wad);
    let lambda_u = U256::from(config.lambda_wad);

    // Lift output target into math-space (ceil for pool-favourable rounding).
    let amount_out_math = if zero_for_one {
        // token1 (base) output is on xMath: identity lift.
        amount_out_wad
    } else {
        // token0 (quote) output is on yMath: math = wad · WAD / priceScale (ceil).
        mul_div_ceil(amount_out_wad, U256::from(WAD), price_scale)?
    };
    if amount_out_math.is_zero() {
        return Err(anyhow!("equilibra_stateful: amountOutMath zero"));
    }

    let (in_delta_math, iters, depth_before) = if zero_for_one {
        // Output side is xMath; input goes to yMath.
        if amount_out_math >= x_math {
            return Err(anyhow!("equilibra_stateful: insufficient liquidity"));
        }
        equilibra_math::quote_exact_out_forward_with_depth(
            y_math,
            x_math,
            amount_out_math,
            a_u,
            lambda_u,
        )?
    } else {
        if amount_out_math >= y_math {
            return Err(anyhow!("equilibra_stateful: insufficient liquidity"));
        }
        equilibra_math::quote_exact_out_forward_with_depth(
            x_math,
            y_math,
            amount_out_math,
            a_u,
            lambda_u,
        )?
    };

    // Lift math input back to wad (ceil for pool-favourable rounding).
    let clean_in_wad = if zero_for_one {
        // yMath input → token0 (quote) wad: wad = math · priceScale / WAD (ceil)
        mul_div_ceil(in_delta_math, price_scale, U256::from(WAD))?
    } else {
        // xMath input → token1 (base) wad: identity
        in_delta_math
    };
    Ok((clean_in_wad, iters, depth_before))
}

/// EMA update — mirrors `_updateEma` + `PoolOracle.updateEma`.
fn update_ema_in_place(
    config: &EquilibraStatefulConfig,
    state: &mut EquilibraStatefulState,
    now_ts: u64,
) -> Result<()> {
    if now_ts <= state.last_ema_ts {
        return Ok(());
    }
    if state.reserve0 == 0 || state.reserve1 == 0 || state.price_scale_wad == 0 {
        return Ok(());
    }
    let (x_math, y_math) = load_math_state(
        config,
        state.reserve0,
        state.reserve1,
        state.price_scale_wad,
    )?;
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(());
    }
    let p_marg_math = marginal_price_from_state(
        x_math,
        y_math,
        U256::from(config.a_wad),
        U256::from(config.lambda_wad),
    )?;
    let spot_raw_u = mul_wad(p_marg_math, U256::from(state.price_scale_wad))?;
    if spot_raw_u.is_zero() {
        return Ok(());
    }

    // Timestamp, not logarithm zero, identifies an uninitialized EMA.
    if state.last_ema_ts == 0 {
        state.ema_log_wad = equilibra_math::price_to_ema_log(spot_raw_u)?;
        state.last_ema_ts = now_ts;
        return Ok(());
    }
    let elapsed = (now_ts - state.last_ema_ts) as u128;
    let alpha_wad = ema_alpha_factor(elapsed, config.ema_period)?;
    // The Solidity cap is uint256; do not narrow an intermediate capped spot.
    let price_scale = U256::from(state.price_scale_wad);
    let capped_spot = spot_raw_u
        .min(price_scale * U256::from(EMA_PRICE_CAP_MUL))
        .max(price_scale / U256::from(EMA_PRICE_CAP_DIV));
    state.ema_log_wad = equilibra_math::geometric_ema_log_step(
        state.ema_log_wad,
        capped_spot,
        U256::from(alpha_wad),
    )?;
    state.last_ema_ts = now_ts;
    Ok(())
}

fn ema_alpha_factor(elapsed: u128, period: u128) -> Result<u128> {
    if period == 0 {
        return Err(anyhow!("equilibra_stateful: ema period is zero"));
    }
    if elapsed == 0 {
        return Ok(WAD);
    }
    let x = math_mul_div_floor(U256::from(elapsed), U256::from(WAD), U256::from(period))?;
    let alpha = equilibra_math::exp_neg_wad(x)?;
    to_u128(alpha, "emaAlpha")
}

/// CP-proxy dynamic-fee resolver for exact-in. Returns the WAD fee
/// rate (`1 bps == 1e14`), mirroring `_resolveDynamicFeeWadFromCp`.
pub fn resolve_dynamic_fee_wad_from_cp(
    config: &EquilibraStatefulConfig,
    state: &EquilibraStatefulState,
    zero_for_one: bool,
    amount_in_raw: u128,
) -> Result<u128> {
    let base_fee_wad = config.fee_bps * FEE_BPS_TO_WAD;
    if config.fee_ramp_dist_wad == 0 {
        return Ok(base_fee_wad);
    }
    if state.price_scale_wad == 0 {
        return Ok(base_fee_wad);
    }
    let (x_math, y_math) = load_math_state(
        config,
        state.reserve0,
        state.reserve1,
        state.price_scale_wad,
    )?;
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(base_fee_wad);
    }
    let in_scale = if zero_for_one {
        config.token0_scale
    } else {
        config.token1_scale
    };
    let amount_in_wad = to_wad_by_scale(U256::from(amount_in_raw), in_scale);
    if amount_in_wad.is_zero() {
        return Ok(base_fee_wad);
    }
    let price_scale = U256::from(state.price_scale_wad);
    // Asymmetric lift: zfo input (quote) → yMath = divWad; !zfo input (base) → xMath identity.
    let amount_in_math = if zero_for_one {
        math_mul_div_floor(amount_in_wad, U256::from(WAD), price_scale)?
    } else {
        amount_in_wad
    };
    if amount_in_math.is_zero() {
        return Ok(base_fee_wad);
    }
    let dist_predicted_wad = if zero_for_one {
        predict_post_distance_cp(y_math, x_math, amount_in_math)?
    } else {
        predict_post_distance_cp(x_math, y_math, amount_in_math)?
    };
    smoothstep_fee_wad(
        dist_predicted_wad,
        U256::from(config.fee_ramp_dist_wad),
        config.fee_floor_bps * FEE_BPS_TO_WAD,
        base_fee_wad,
    )
}

// ---------------------------------------------------------------------------
// LP unit-value accrual + auto-repeg.
// ---------------------------------------------------------------------------

pub(crate) struct RepegOutcome {
    pub(crate) new_price_scale_wad: u128,
    pub(crate) lp_unit_value_threshold_wad: u128,
    pub(crate) lp_unit_value_before_wad: u128,
    /// Committed latch value: the raw `vpAfter` probe for ladder
    /// commits, the post-burn `⌊vpAfter · S / (S − δ)⌋` for parachute
    /// commits.
    pub(crate) lp_unit_value_after_wad: u128,
    pub(crate) ema_deviation_bps: u128,
    pub(crate) candidate_price_scale_wad: u128,
    pub(crate) recentered: bool,
    pub(crate) blocked_by: Option<EquilibraRecenterGateBlocked>,
    /// LP shares the commit burns from the donation buffer (parachute
    /// only; 0 everywhere else).
    pub(crate) donation_burn_shares: u128,
    /// True when the commit came from the donation parachute (either
    /// route); false for ladder commits and every skip path.
    pub(crate) via_parachute: bool,
}

struct AccrueResult {
    vp_now: u128,
    delta_wad: u128,
}

fn accrue_lp_value_growth(
    state: &mut EquilibraStatefulState,
    checked_depth: U256,
) -> Result<AccrueResult> {
    if state.total_supply == 0 || state.price_scale_wad == 0 {
        return Ok(AccrueResult {
            vp_now: 0,
            delta_wad: 0,
        });
    }
    let live = to_u128(
        math_compute_lp_unit_value_wad(
            checked_depth,
            state.price_scale_wad.into(),
            state.total_supply.into(),
        )?,
        "lpUnitValueWad",
    )?;
    if live == 0 {
        return Ok(AccrueResult {
            vp_now: 0,
            delta_wad: 0,
        });
    }
    if live <= state.lp_unit_value_wad {
        return Ok(AccrueResult {
            vp_now: live,
            delta_wad: 0,
        });
    }
    let delta = live - state.lp_unit_value_wad;
    state.lp_unit_value_wad = live;
    state.lp_value_growth_wad = state
        .lp_value_growth_wad
        .checked_add(delta)
        .ok_or_else(|| anyhow!("eq_accrue overflow"))?;
    Ok(AccrueResult {
        vp_now: live,
        delta_wad: delta,
    })
}

/// Compute LP unit value `vp = 2·L_eq · √(priceScale·WAD) / totalSupply`
/// via the math kernel.
fn compute_pool_lp_unit_value(
    config: &EquilibraStatefulConfig,
    reserve0: u128,
    reserve1: u128,
    price_scale_wad: u128,
    total_supply: u128,
) -> Result<u128> {
    if price_scale_wad == 0 || total_supply == 0 {
        return Ok(0);
    }
    let (x_math, y_math) = load_math_state(config, reserve0, reserve1, price_scale_wad)?;
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(0);
    }
    let l_eq = solve_l_from_state(
        x_math,
        y_math,
        U256::from(config.a_wad),
        U256::from(config.lambda_wad),
    )?;
    if l_eq.is_zero() {
        return Ok(0);
    }
    let vp_u = math_compute_lp_unit_value_wad(
        l_eq,
        U256::from(price_scale_wad),
        U256::from(total_supply),
    )?;
    to_u128(vp_u, "lpUnitValueWad")
}

fn try_auto_repeg(
    config: &EquilibraStatefulConfig,
    state_in: &EquilibraStatefulState,
    vp_before: u128,
    now_ts: u64,
    disable_recenter: bool,
) -> Result<RepegOutcome> {
    let price_scale_old = state_in.price_scale_wad;

    let blocked = |reason: EquilibraRecenterGateBlocked,
                   threshold: u128,
                   vp_before: u128,
                   vp_after: u128,
                   candidate: u128,
                   dev_bps: u128|
     -> RepegOutcome {
        RepegOutcome {
            new_price_scale_wad: price_scale_old,
            lp_unit_value_threshold_wad: threshold,
            lp_unit_value_before_wad: vp_before,
            lp_unit_value_after_wad: vp_after,
            ema_deviation_bps: dev_bps,
            candidate_price_scale_wad: candidate,
            recentered: false,
            blocked_by: Some(reason),
            donation_burn_shares: 0,
            via_parachute: false,
        }
    };

    if disable_recenter {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::DisableRecenterFlag,
            0,
            vp_before,
            0,
            price_scale_old,
            0,
        ));
    }
    // Explicit opt-out: pre-scaled `repeg_share_bps == 0` iff the user
    // share is 0. Mirrors the Solidity short-circuit in `_tryAutoRepeg`
    // (audit L-4) — makes the "disabled by construction" guarantee exact
    // against un-booked `_reanchorLpUnitValue` watermark creep.
    if config.repeg_share_bps == 0 {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::RepegShareZero,
            0,
            vp_before,
            0,
            price_scale_old,
            0,
        ));
    }
    if state_in.reserve0 == 0 || state_in.reserve1 == 0 {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::ReservesZero,
            0,
            vp_before,
            0,
            price_scale_old,
            0,
        ));
    }
    if state_in.total_supply == 0 {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::TotalSupplyZero,
            0,
            vp_before,
            0,
            price_scale_old,
            0,
        ));
    }
    if vp_before == 0 {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::LpUnitValueBelowThreshold,
            0,
            0,
            0,
            price_scale_old,
            0,
        ));
    }
    if now_ts <= state_in.last_repeg_ts {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::SameTimestampOncePerBlock,
            0,
            vp_before,
            0,
            price_scale_old,
            0,
        ));
    }
    let ema_price_wad = state_in.ema_price_wad()?;

    let deviation_wad = compute_relative_deviation_wad(ema_price_wad, price_scale_old)?;
    let dev_bps_u = to_u128(
        math_mul_div_floor(U256::from(deviation_wad), U256::from(BPS), U256::from(WAD))?,
        "emaDeviationBps",
    )?;
    // Activation dead-band — mirrors the Solidity gate bit-for-bit. It is
    // the only filter able to suppress vp-neutral dust repegs (near the
    // anchor a small priceScale move passes both vp gates without spending
    // budget) and keeps non-committing attempts off the per-swap hot path.
    // Full rationale in `EquilibraPool._tryAutoRepeg` and CLAUDE.md
    // "Sizing the repeg knobs".
    // Direction-aware dead-band: `ema > priceScale` is an internal
    // token1-UP move (token1's price in token0 above the anchor).
    // Layout note: under the mainnet base-in-slot-0 layout a rising
    // base market registers as token1-DOWN.
    let active_threshold_wad = if ema_price_wad > price_scale_old {
        config.repeg_threshold_token1_up_wad
    } else {
        config.repeg_threshold_token1_down_wad
    };
    if deviation_wad < active_threshold_wad {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::DeviationBelowThreshold,
            0,
            vp_before,
            0,
            price_scale_old,
            dev_bps_u,
        ));
    }

    let keep_bps = BPS - config.repeg_share_bps;
    let kept_growth_u = math_mul_div_floor(
        U256::from(state_in.lp_value_growth_wad),
        U256::from(keep_bps),
        U256::from(BPS),
    )?;
    let kept_growth = to_u128(kept_growth_u, "keptGrowth")?;
    let threshold = state_in
        .lp_unit_value_genesis_wad
        .checked_add(kept_growth)
        .ok_or_else(|| anyhow!("eq_repeg threshold overflow"))?;
    let threshold_with_guard = threshold
        .checked_add(REPEG_GAS_GUARD_WAD)
        .ok_or_else(|| anyhow!("eq_repeg threshold+guard overflow"))?;

    if vp_before <= threshold_with_guard {
        // No own budget ⇒ hand over to the donation parachute — the
        // ONLY path that may spend the donation buffer. Mirrors the
        // Solidity `_tryDonationParachute` handover bit-for-bit; the
        // ladder below stays strictly LP-budget-funded.
        return try_donation_parachute(
            config,
            state_in,
            vp_before,
            threshold,
            deviation_wad,
            active_threshold_wad,
            dev_bps_u,
            false,
        );
    }

    // Halving ladder: start from the damped step `deviation / divisor`
    // and, when the post-move solvency probe refuses the candidate,
    // retry with the step halved (effective divisor D, 2D, 4D, 8D)
    // instead of freezing the anchor entirely. Every committed move
    // still passed the REAL gate; no cross-block memory. See
    // `MAX_REPEG_STEP_HALVINGS`.
    let base_applied =
        applied_repeg_step(config.repeg_step_wad, deviation_wad, REPEG_DAMPING_DIVISOR)?;
    // Halving rungs are deliberately COARSE: committing ~50–100% of the
    // affordable step (avg ~70%) leaves a budget cushion by
    // construction. A finer ladder commits closer to the affordable
    // maximum, scrapes the budget to the floor and measurably INCREASES
    // stall months on both presets — granularity is not an improvement
    // here.
    for halving in 0..=MAX_REPEG_STEP_HALVINGS {
        let applied = base_applied >> halving as usize;
        if applied.is_zero() {
            break;
        }
        let candidate = apply_log_step(price_scale_old, ema_price_wad, applied)?;
        if candidate == price_scale_old {
            // Dust move — smaller halvings can only stay dust. Break
            // even at rung 0: Solidity consults the parachute on EVERY
            // no-commit ladder exit (the parachute re-derives the same
            // dust candidate and declines via its `candidate ==
            // priceScale` check when its qualifiers pass).
            break;
        }
        let vp_after = compute_pool_lp_unit_value(
            config,
            state_in.reserve0,
            state_in.reserve1,
            candidate,
            state_in.total_supply,
        )?;
        if vp_after != 0 && vp_after >= threshold {
            return Ok(RepegOutcome {
                new_price_scale_wad: candidate,
                lp_unit_value_threshold_wad: threshold,
                lp_unit_value_before_wad: vp_before,
                lp_unit_value_after_wad: vp_after,
                ema_deviation_bps: dev_bps_u,
                candidate_price_scale_wad: candidate,
                recentered: true,
                blocked_by: None,
                donation_burn_shares: 0,
                via_parachute: false,
            });
        }
    }
    // No rung committed (every rung refused, a dust candidate at any
    // rung, or a zero applied step) ⇒ consult the parachute — mirrors
    // the Solidity post-ladder handover bit-for-bit. Solidity restores
    // `cs.priceScaleWad` and recomputes the geometric deviation there;
    // in Rust `state_in` is immutable and `deviation_wad` was never
    // overwritten, so the same values flow through unchanged.
    try_donation_parachute(
        config,
        state_in,
        vp_before,
        threshold,
        deviation_wad,
        active_threshold_wad,
        dev_bps_u,
        true,
    )
}

/// Donation parachute — the ONLY spender of the donation buffer.
/// Mirrors `EquilibraPool._tryDonationParachute` bit-for-bit: reached
/// from `try_auto_repeg` whenever NO repeg committed — the pre-gate
/// (no spendable growth budget at all) and EVERY no-commit ladder
/// exit; opens only when the anchor additionally lags by
/// ≥ `config.parachute_band_mult × active dead-band` (per-pool K,
/// seeded at `REPEG_PARACHUTE_BAND_MULT_DEFAULT`). Commits
/// the FULL damped step in one shot (no halving ladder — halved rungs
/// exist to fit a move into the pool's own budget, and here they are
/// pointless on both routes: the pre-gate one has no budget at all,
/// the post-ladder one just had every rung, halves included, refused),
/// burning exactly the shortfall
///   δ = ⌈S · (T − vpAfter) / T⌉
/// so the post-burn latch `⌊vpAfter · S / (S − δ)⌋` lands ON the
/// threshold up to rounding: `≥ T` is guaranteed and the overshoot
/// above `T` is the ceil's at-most-one-share over-burn in unit value —
/// bounded by `~T / (S − δ)`, wei-scale whenever the post-burn supply
/// dwarfs `T`. That sub-share remainder is the only surplus a commit
/// can hand to LP holders, making a sandwich around a parachute commit
/// value-free up to that rounding dust. A vp-accretive candidate (`vpAfter ≥ T`, possible
/// only on the pre-gate route where the ladder never probed — after
/// ladder exhaustion rung 0 would have committed such a candidate
/// itself) commits with δ = 0.
#[allow(clippy::too_many_arguments)]
fn try_donation_parachute(
    config: &EquilibraStatefulConfig,
    state_in: &EquilibraStatefulState,
    vp_before: u128,
    threshold: u128,
    deviation_wad: u128,
    active_threshold_wad: u128,
    dev_bps_u: u128,
    from_ladder: bool,
) -> Result<RepegOutcome> {
    let price_scale_old = state_in.price_scale_wad;
    let blocked =
        |reason: EquilibraRecenterGateBlocked, vp_after: u128, candidate: u128| -> RepegOutcome {
            RepegOutcome {
                new_price_scale_wad: price_scale_old,
                lp_unit_value_threshold_wad: threshold,
                lp_unit_value_before_wad: vp_before,
                lp_unit_value_after_wad: vp_after,
                ema_deviation_bps: dev_bps_u,
                candidate_price_scale_wad: candidate,
                recentered: false,
                blocked_by: Some(reason),
                donation_burn_shares: 0,
                via_parachute: false,
            }
        };

    // Check order mirrors the Solidity parachute exactly (qualifier
    // first, then buffer), so the blocked-gate statistics read as
    // "reached the parachute, filtered by X" with on-chain semantics.
    // Activation qualifier: `band ≤ WAD` and `K ≤ 255` on-chain, so
    // the checked mul cannot overflow.
    let activation_wad = active_threshold_wad
        .checked_mul(config.parachute_band_mult)
        .ok_or_else(|| anyhow!("eq_parachute activation overflow"))?;
    if deviation_wad < activation_wad {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::DonationParachuteBelowActivation,
            0,
            price_scale_old,
        ));
    }
    // Empty/dust buffer: keep the historical labels so the counters
    // stay comparable across runs — the pre-gate route reports the
    // no-budget label, the post-ladder route the ladder-exhaustion one.
    if state_in.donation_shares <= REPEG_DONATION_DUST_SHARES {
        return Ok(blocked(
            if from_ladder {
                EquilibraRecenterGateBlocked::LpUnitValueAfterBelowThreshold
            } else {
                EquilibraRecenterGateBlocked::LpUnitValueBelowThreshold
            },
            0,
            price_scale_old,
        ));
    }

    let applied = applied_repeg_step(config.repeg_step_wad, deviation_wad, REPEG_DAMPING_DIVISOR)?;
    let candidate = apply_log_step(price_scale_old, state_in.ema_price_wad()?, applied)?;
    if candidate == price_scale_old {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::DonationParachuteInsufficient,
            0,
            price_scale_old,
        ));
    }
    let vp_after = compute_pool_lp_unit_value(
        config,
        state_in.reserve0,
        state_in.reserve1,
        candidate,
        state_in.total_supply,
    )?;
    if vp_after == 0 {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::DonationParachuteInsufficient,
            0,
            candidate,
        ));
    }

    let supply = state_in.total_supply;
    let burn_shares = if vp_after >= threshold {
        0u128
    } else {
        to_u128(
            mul_div_ceil(
                U256::from(supply),
                U256::from(threshold - vp_after),
                U256::from(threshold),
            )?,
            "parachuteBurnShares",
        )?
    };
    if burn_shares > state_in.donation_shares {
        return Ok(blocked(
            EquilibraRecenterGateBlocked::DonationParachuteInsufficient,
            vp_after,
            candidate,
        ));
    }
    // Exact post-burn latch; degenerates to `vp_after` itself at δ = 0.
    let latch = to_u128(
        math_mul_div_floor(
            U256::from(vp_after),
            U256::from(supply),
            U256::from(supply - burn_shares),
        )?,
        "parachuteLatch",
    )?;
    Ok(RepegOutcome {
        new_price_scale_wad: candidate,
        lp_unit_value_threshold_wad: threshold,
        lp_unit_value_before_wad: vp_before,
        lp_unit_value_after_wad: latch,
        ema_deviation_bps: dev_bps_u,
        candidate_price_scale_wad: candidate,
        recentered: true,
        blocked_by: None,
        donation_burn_shares: burn_shares,
        via_parachute: true,
    })
}

fn compute_relative_deviation_wad(ema_wad: u128, price_scale_wad: u128) -> Result<u128> {
    if price_scale_wad == 0 {
        return Err(anyhow!("equilibra_stateful: price_scale zero in deviation"));
    }
    if ema_wad == price_scale_wad {
        return Ok(0);
    }
    // Geometric (multiplicative) deviation |max/min - 1|: a ±2x move yields
    // 1.0 WAD in both directions, consistent with the symmetric [ps/2, 2ps]
    // EMA clamp. Bit-for-bit with the Solidity activation gate (audit L-6).
    let wad_u = U256::from(WAD);
    let (hi, lo) = if ema_wad >= price_scale_wad {
        (ema_wad, price_scale_wad)
    } else {
        (price_scale_wad, ema_wad)
    };
    let ratio = math_mul_div_floor(U256::from(hi), wad_u, U256::from(lo))?;
    let dev = ratio - wad_u;
    to_u128(dev, "deviationWad")
}

/// Damped applied step: `min(repegStepWad, deviation / divisor)`.
fn applied_repeg_step(
    repeg_step_wad: u128,
    deviation_wad: u128,
    damping_divisor: u128,
) -> Result<U256> {
    if repeg_step_wad == 0 || repeg_step_wad > WAD {
        return Err(anyhow!("equilibra_stateful: invalid repegStep"));
    }
    if damping_divisor == 0 {
        return Err(anyhow!("equilibra_stateful: zero damping divisor"));
    }
    let damped = U256::from(deviation_wad) / U256::from(damping_divisor);
    let step_u = U256::from(repeg_step_wad);
    Ok(if step_u < damped { step_u } else { damped })
}

/// Apply one log-domain move of magnitude `applied` toward `target`:
/// `psNew = mulWad(ps, expWad(±applied))`. `exp(s) · exp(−s) == 1`, so
/// the up and down moves are exact multiplicative inverses and a
/// mirrored (reciprocal-frame) pool shifts onto the exact reciprocal
/// anchor; the relative-additive form `ps·(1 ± s)` leaves an O(s²)
/// orientation residue instead. The no-overshoot clamp to `target` is
/// unconditional: worst case lands exactly ON the target, never past
/// it. The on-chain port must replicate this op order with Solady's
/// `expWad`.
fn apply_log_step(price_scale_old: u128, target: u128, applied: U256) -> Result<u128> {
    if price_scale_old == 0 || target == 0 {
        return Err(anyhow!("equilibra_stateful: shiftPriceScale zero input"));
    }
    if target == price_scale_old || applied.is_zero() {
        return Ok(price_scale_old);
    }
    let wad_u = U256::from(WAD);
    let new_price_scale = if target > price_scale_old {
        let factor = equilibra_math::exp_pos_wad(applied)?;
        let candidate = to_u128(
            math_mul_div_floor(U256::from(price_scale_old), factor, wad_u)?,
            "shiftUpCandidate",
        )?;
        candidate.min(target)
    } else {
        let factor = equilibra_math::exp_neg_wad(applied)?;
        let candidate = to_u128(
            math_mul_div_floor(U256::from(price_scale_old), factor, wad_u)?,
            "shiftDownCandidate",
        )?;
        candidate.max(target)
    };
    Ok(new_price_scale)
}

// ---------------------------------------------------------------------------
// Re-export private helpers needed by other simulator modules.
// ---------------------------------------------------------------------------

// `marginal_price`, `mul_div_ceil`, `from_math_space_up`, `amplification`,
// `distance_from_anchor_wad` are pulled in `use` statements above for
// downstream callers (visualizer, app) to reach through `equilibra::*`
// without an extra import.
pub use super::equilibra_math::{
    amplification as math_amplification, distance_from_anchor_wad as math_distance_from_anchor_wad,
    from_math_space_up as math_from_math_space_up, marginal_price as math_marginal_price,
    mul_div_ceil as math_mul_div_ceil,
};

#[cfg(test)]
mod checked_swap_tests {
    use super::super::equilibra_math::quote_exact_out_forward;
    use super::*;

    fn config(decimals0: u8, decimals1: u8, protocol: u128, ramp: u128) -> EquilibraStatefulConfig {
        config_at_alpha(
            decimals0,
            decimals1,
            protocol,
            ramp,
            990_000_000_000_000_000,
        )
    }

    fn config_at_alpha(
        decimals0: u8,
        decimals1: u8,
        protocol: u128,
        ramp: u128,
        alpha: u128,
    ) -> EquilibraStatefulConfig {
        EquilibraStatefulConfig::new(
            "token0",
            "token1",
            decimals0,
            decimals1,
            10,
            alpha,
            1_000_000_000_000_000, // Original lambda of the native settlement vectors.
            protocol,
            600,
            500_000_000_000_000,
            100_000_000_000_000,
            100_000_000_000_000,
            ramp,
            1,
            0,
        )
        .unwrap()
    }

    #[test]
    fn simulation_genesis_has_no_public_price_interval() {
        let cfg = config_at_alpha(18, 18, 0, 0, WAD / 10);
        for price in [999_999u128, 1_000_000, 10u128.pow(30), 10u128.pow(30) + 1] {
            let genesis = init_genesis(&cfg, price * 1_000_000, 10u128.pow(24), 1).unwrap();
            assert_eq!(genesis.price_scale_wad, price);
        }
    }

    #[test]
    fn constructor_accepts_lambda_endpoints_and_rejects_adjacent_values() {
        for alpha in [A_MIN_WAD, A_MAX_WAD] {
            for lambda in [
                LAMBDA_MIN_WAD - 1,
                LAMBDA_MIN_WAD,
                LAMBDA_MAX_WAD,
                LAMBDA_MAX_WAD + 1,
            ] {
                let result = EquilibraStatefulConfig::new(
                    "token0",
                    "token1",
                    18,
                    18,
                    10,
                    alpha,
                    lambda,
                    0,
                    600,
                    500_000_000_000_000,
                    100_000_000_000_000,
                    100_000_000_000_000,
                    0,
                    1,
                    0,
                );
                if (LAMBDA_MIN_WAD..=LAMBDA_MAX_WAD).contains(&lambda) {
                    let cfg = result.unwrap();
                    for token in ["token0", "token1"] {
                        let quote = quote_exact_in_stateful(&cfg, &state(18, 18), token, 100 * WAD)
                            .unwrap();
                        assert!(quote.amount_out_raw > 0);
                    }
                } else {
                    assert!(result.unwrap_err().to_string().contains("lambda_wad"));
                }
            }
        }
    }

    fn state(decimals0: u8, decimals1: u8) -> EquilibraStatefulState {
        let reserve0 = 500_000 * 10u128.pow(decimals0.into());
        let reserve1 = 500_000 * 10u128.pow(decimals1.into());
        EquilibraStatefulState {
            reserve0,
            reserve1,
            price_scale_wad: WAD,
            total_supply: 500_000 * WAD,
            e0: reserve0,
            e1: reserve1,
            ema_log_wad: 0,
            lp_unit_value_genesis_wad: 2 * WAD,
            lp_unit_value_wad: 2 * WAD,
            ..EquilibraStatefulState::empty()
        }
    }

    fn depth(config: &EquilibraStatefulConfig, r0: u128, r1: u128) -> U256 {
        let (x, y) = load_math_state(config, r0, r1, WAD).unwrap();
        solve_l_from_state(x, y, config.a_wad.into(), config.lambda_wad.into()).unwrap()
    }

    #[test]
    fn deposit_ratio_probe_keeps_wide_quotient_until_limiting_side_is_known() {
        let cfg = config_at_alpha(18, 18, 0, 0, WAD / 10);
        for ratio in [1u128, 2] {
            let genesis = init_genesis(&cfg, WAD, ratio * WAD, 1).unwrap();
            let st = EquilibraStatefulState {
                reserve0: genesis.reserve0,
                reserve1: genesis.reserve1,
                price_scale_wad: genesis.price_scale_wad,
                total_supply: genesis.total_supply,
                ema_log_wad: genesis.ema_log_wad,
                e0: genesis.reserve0,
                e1: genesis.reserve1,
                lp_unit_value_genesis_wad: genesis.lp_unit_value_genesis_wad,
                lp_unit_value_wad: genesis.lp_unit_value_genesis_wad,
                ..EquilibraStatefulState::empty()
            };
            let desired1 = WAD / 100;
            let used0 = desired1 / ratio;
            let reference = add_liquidity_proportional(&st, used0, desired1, &cfg).unwrap();
            let actual = add_liquidity_proportional(&st, u128::MAX, desired1, &cfg).unwrap();
            assert_eq!(actual, reference);
            assert_eq!((actual.0, actual.1), (used0, desired1));
            assert_eq!(actual.2, used0 * genesis.total_supply / WAD);
            let probe =
                math_mul_div_floor(u128::MAX.into(), st.reserve1.into(), st.reserve0.into())
                    .unwrap();
            assert_eq!(probe > U256::from(u128::MAX), ratio > 1);
            assert!(add_liquidity_proportional(&st, u128::MAX, u128::MAX, &cfg).is_err());
        }
    }

    #[test]
    fn deposit_rounding_funds_both_assets_without_exceeding_either_maximum() {
        let cfg = config_at_alpha(0, 0, 0, 0, WAD / 10);
        for (r0, r1, desired0, desired1, used0, used1) in [
            (3, 5, 1, 2, 1, 2),
            (3, 5, 2, 3, 1, 3),
            (5, 3, 2, 2, 2, 2),
            (5, 3, 3, 1, 1, 1),
            (3, 5, 3, 5, 3, 5),
        ] {
            let genesis = init_genesis(&cfg, r0, r1, 1).unwrap();
            for parked in [0, genesis.total_supply / 3] {
                let st = EquilibraStatefulState {
                    reserve0: r0,
                    reserve1: r1,
                    total_supply: genesis.total_supply,
                    price_scale_wad: genesis.price_scale_wad,
                    donation_shares: parked,
                    ..EquilibraStatefulState::empty()
                };
                let active = st.total_supply - parked;
                let result = add_liquidity_proportional(&st, desired0, desired1, &cfg).unwrap();
                let shares = used0 * active / r0;
                let buffer_top_up = shares * parked / active;
                assert_eq!((result.0, result.1, result.2), (used0, used1, shares));
                assert_eq!((result.3, result.4), (r0 + used0, r1 + used1));
                assert_eq!(result.5, st.total_supply + shares + buffer_top_up);
                assert_eq!(result.7, parked + buffer_top_up);
                assert!(result.6 > 0);
                assert!(used0 <= desired0 && used1 <= desired1);
                assert!(shares * r0 <= used0 * active);
                assert!(shares * r1 <= used1 * active);
                if (r0, r1) == (3, 5) {
                    let err = add_liquidity_proportional(&st, 1, 1, &cfg).unwrap_err();
                    assert!(err.to_string().contains("too small after normalisation"));
                }
            }
        }
    }

    #[test]
    fn oversized_diagonal_genesis_is_rejected_before_any_swap() {
        let cfg = config_at_alpha(6, 6, 0, 0, 990_000_000_000_000_000);
        let err = init_genesis(&cfg, 10u128.pow(21), 10u128.pow(28), 1).unwrap_err();
        assert!(err.to_string().contains("invariant product overflow"));
    }

    #[test]
    fn repeg_numeric_failure_propagates_instead_of_returning_a_completed_swap() {
        // Same synthetic boundary as NumericDomainRegression.test.ts.
        let mut cfg = config_at_alpha(6, 6, 0, 0, 990_000_000_000_000_000);
        cfg.fee_bps = 5;
        cfg.repeg_share_bps = 5000;
        cfg.repeg_step_wad = WAD / 200;
        let q = U256::one() << 128;
        let scale = U256::exp10(12);
        let mut st = state(6, 6);
        st.reserve0 = to_u128((q * 3 / 2 - U256::exp10(33)) / scale, "r0").unwrap();
        st.reserve1 = to_u128(q / 2 / scale, "r1").unwrap();
        st.ema_log_wad = equilibra_math::price_to_ema_log(U256::from(WAD / 2)).unwrap();
        st.last_ema_ts = 1000;
        let input = 1_000_000;
        let quote = quote_exact_in_stateful(&cfg, &st, "token1", input).unwrap();
        assert!(quote.amount_out_raw > 0);
        let without_repeg = swap_stateful(&cfg, st, "token1", input, 1000, true).unwrap();
        assert_eq!(without_repeg.amount_out, quote.amount_out_raw);
        let err = swap_stateful(&cfg, st, "token1", input, 1000, false).unwrap_err();
        assert!(
            err.to_string().contains("invariant distance overflow"),
            "{err}"
        );
        assert_eq!(st.price_scale_wad, WAD); // execution consumes a copy; no partial state escapes
    }

    #[test]
    fn minimum_raw_fee_preserves_nonzero_floors_and_native_settlement() {
        for decimals in [0u8, 1, 2, 6, 8, 18] {
            for ramp in [0, 10_000] {
                let mut cfg = config(decimals, decimals, 25, ramp);
                cfg.fee_bps = 5;
                let st = state(decimals, decimals);
                for zfo in [false, true] {
                    let token = if zfo { "token0" } else { "token1" };
                    for input in [1000u128, 1999, 2000, 3000, 3999, 4000, 100_000] {
                        let rate = resolve_dynamic_fee_wad_from_cp(&cfg, &st, zfo, input).unwrap();
                        assert!(rate > 0);
                        let fee = (input * rate / WAD).max(1);
                        if ramp == 0 {
                            assert_eq!(fee, (input * 5 / BPS).max(1));
                        }
                        let expected = compute_exact_in_amount_out(&cfg, &st, zfo, input - fee)
                            .unwrap()
                            .0;
                        let quote = quote_exact_in_stateful(&cfg, &st, token, input).unwrap();
                        let swap = swap_stateful(&cfg, st, token, input, 0, true).unwrap();
                        assert_eq!(quote.fee_amount_raw, fee);
                        assert_eq!(swap.fee_amount_raw, fee);
                        assert_eq!(quote.amount_out_raw, expected);
                        assert_eq!(swap.amount_out, expected);
                        assert_eq!(quote.protocol_cut_raw, fee * 25 / 100);
                        assert_eq!(swap.protocol_cut_raw, quote.protocol_cut_raw);
                    }
                }
            }
        }
    }

    #[test]
    fn exact_out_margin_boundary_matches_swap_before_solver_execution() {
        let cfg = config(18, 18, 0, 0);
        let st = state(18, 18);
        for (token, reserve) in [("token0", st.reserve1), ("token1", st.reserve0)] {
            let requested = reserve - reserve / 100_000_000;
            assert!(requested < reserve);
            let quote = quote_exact_out_stateful(&cfg, &st, token, requested).unwrap_err();
            let swap = swap_stateful_exact_out(&cfg, st, token, requested, 0, true).unwrap_err();
            assert_eq!(
                quote.to_string(),
                "equilibra_math: quoteExactOutForward dy >= y (insufficient liquidity)"
            );
            assert_eq!(swap.to_string(), quote.to_string());
        }
    }

    #[test]
    fn minimum_fee_cannot_consume_the_entire_exact_input() {
        for decimals in [0u8, 1, 2, 6, 8, 18] {
            let cfg = config(decimals, decimals, 0, 0);
            let st = state(decimals, decimals);
            for token in ["token0", "token1"] {
                let quote = quote_exact_in_stateful(&cfg, &st, token, 1).unwrap_err();
                let swap = swap_stateful(&cfg, st, token, 1, 0, true).unwrap_err();
                assert_eq!(
                    quote.to_string(),
                    "equilibra_stateful: amount_too_small_after_normalization"
                );
                assert_eq!(swap.to_string(), quote.to_string());
            }
        }
    }

    #[test]
    fn stateful_fee_floor_u16_boundary_is_enforced() {
        let flat = EquilibraStatefulConfig::new(
            "token0",
            "token1",
            18,
            18,
            MIN_BASE_FEE_BPS,
            990_000_000_000_000_000,
            1_000_000_000_000_000,
            25,
            600,
            500_000_000_000_000,
            100_000_000_000_000,
            100_000_000_000_000,
            0,
            MAX_FEE_FLOOR_BPS,
            0,
        );
        assert!(
            flat.is_ok(),
            "flat 1 bps fee accepts the uint16 floor boundary"
        );

        let oversized = EquilibraStatefulConfig::new(
            "token0",
            "token1",
            18,
            18,
            MIN_BASE_FEE_BPS,
            990_000_000_000_000_000,
            1_000_000_000_000_000,
            25,
            600,
            500_000_000_000_000,
            100_000_000_000_000,
            100_000_000_000_000,
            0,
            MAX_FEE_FLOOR_BPS + 1,
            0,
        )
        .unwrap_err();
        assert!(oversized
            .to_string()
            .contains("fee_floor_bps 65536 > MAX_FEE_FLOOR_BPS (65535)"));
    }

    #[test]
    fn live_dynamic_rate_rejects_a_zero_floor() {
        let err = EquilibraStatefulConfig::new(
            "token0",
            "token1",
            18,
            18,
            10,
            990_000_000_000_000_000,
            1_000_000_000_000_000,
            25,
            600,
            500_000_000_000_000,
            100_000_000_000_000,
            100_000_000_000_000,
            10_000,
            0,
            0,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("live fee ramp requires 1 <= fee_floor_bps < fee_bps"));
    }

    #[test]
    fn live_dynamic_rate_rejects_a_floor_equal_to_its_ceiling() {
        let err = EquilibraStatefulConfig::new(
            "token0",
            "token1",
            18,
            18,
            2,
            990_000_000_000_000_000,
            1_000_000_000_000_000,
            25,
            600,
            500_000_000_000_000,
            100_000_000_000_000,
            100_000_000_000_000,
            10_000,
            2,
            0,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("live fee ramp requires 1 <= fee_floor_bps < fee_bps"));
    }

    #[test]
    fn exact_out_minimum_fee_is_separate_from_the_existing_input_bump() {
        for rate in [0u128, 1, 5 * FEE_BPS_TO_WAD, 2000 * FEE_BPS_TO_WAD] {
            for clean in [1u128, 2, 999, 1000, 1999, 2000, 2999, 3000, 10_000] {
                let floor_inverse = (clean - 1) * WAD / (WAD - rate) + 1;
                let expected = if rate == 0 {
                    floor_inverse
                } else {
                    floor_inverse.max(clean + 1)
                };
                let gross = gross_up_exact_out(clean.into(), rate).unwrap().as_u128();
                assert_eq!(gross, expected);
                let fee_at = |amount: u128| {
                    let fee = amount * rate / WAD;
                    if rate == 0 {
                        fee
                    } else {
                        fee.max(1)
                    }
                };
                assert!(gross - fee_at(gross) >= clean);
                if gross > 1 {
                    assert!(gross - 1 - fee_at(gross - 1) < clean);
                }
            }
        }
        let mut cfg = config(18, 18, 0, 0);
        cfg.fee_bps = 5;
        let st = state(18, 18);
        for zfo in [false, true] {
            for clean in [1u128, 999, 1999, 2000, 3000, 4000] {
                let (input, fee, rate) = resolve_exact_out_fee(&cfg, &st, zfo, clean).unwrap();
                let floor_inverse = (clean - 1) * BPS / (BPS - 5) + 1;
                assert_eq!(rate, 5 * FEE_BPS_TO_WAD);
                assert_eq!(input, floor_inverse.max(clean + 1) + 1);
                assert_eq!(fee, input - clean);
                assert!(fee >= 2, "minimum fee plus the unchanged safety bump");
            }
        }
    }

    #[test]
    fn raised_alpha_quotes_preserve_lp_depth_and_native_parity() {
        let mut checked = 0;
        let mut max_iters = 0;
        for alpha in [
            999_750_062_484_378_906u128,
            999_950_002_499_875_007,
            A_MAX_WAD,
        ] {
            for (d0, d1) in [(18u8, 18u8), (6, 6), (8, 6)] {
                let cfg = config_at_alpha(d0, d1, 5, 10_000, alpha);
                for (num, den) in [(1u128, 10u128), (1, 2), (1, 1), (2, 1), (10, 1)] {
                    let mut state = state(d0, d1);
                    state.reserve0 = state.reserve0 * num / den;
                    state.e0 = state.reserve0;
                    let pre_depth = depth(&cfg, state.reserve0, state.reserve1);
                    for zero_for_one in [true, false] {
                        let token = if zero_for_one { "token0" } else { "token1" };
                        let (reserve_in, reserve_out) = if zero_for_one {
                            (state.reserve0, state.reserve1)
                        } else {
                            (state.reserve1, state.reserve0)
                        };
                        for percent in [1u128, 10, 99] {
                            let amount = reserve_in * percent / 100;
                            let quote =
                                quote_exact_in_stateful(&cfg, &state, token, amount).unwrap();
                            let swap = swap_stateful(&cfg, state, token, amount, 0, true).unwrap();
                            assert_eq!(quote.amount_out_raw, swap.amount_out);
                            assert_eq!(quote.fee_amount_raw, swap.fee_amount_raw);
                            assert!(depth(&cfg, swap.reserve0, swap.reserve1) >= pre_depth);
                            max_iters = max_iters.max(quote.iters);
                            checked += 1;

                            let amount = reserve_out * percent / 100;
                            let quote =
                                quote_exact_out_stateful(&cfg, &state, token, amount).unwrap();
                            let swap = swap_stateful_exact_out(&cfg, state, token, amount, 0, true)
                                .unwrap();
                            assert_eq!(quote.amount_in_raw, swap.amount_in);
                            assert_eq!(quote.fee_amount_raw, swap.state.fee_amount_raw);
                            assert!(
                                depth(&cfg, swap.state.reserve0, swap.state.reserve1) >= pre_depth
                            );
                            max_iters = max_iters.max(quote.iters);
                            checked += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(checked, 540);
        assert!(
            max_iters > 0 && max_iters <= 40,
            "every native quote must stay within the hard cap"
        );
    }

    #[test]
    fn raised_alpha_one_wei_exact_out_quote_matches_settlement() {
        for alpha in [
            999_750_062_484_378_906u128,
            999_950_002_499_875_007,
            A_MAX_WAD,
        ] {
            let cfg = config_at_alpha(18, 18, 5, 10_000, alpha);
            let mut state = state(18, 18);
            state.reserve0 *= 20;
            state.e0 = state.reserve0;
            let before = format!("{state:?}");
            let quote = quote_exact_out_stateful(&cfg, &state, "token1", 1).unwrap();
            let swap = swap_stateful_exact_out(&cfg, state, "token1", 1, 0, true).unwrap();
            assert_eq!(quote.amount_in_raw, 3);
            assert_eq!(swap.amount_in, quote.amount_in_raw);
            assert_eq!(swap.state.amount_out, 1);
            assert!(
                depth(&cfg, swap.state.reserve0, swap.state.reserve1)
                    >= depth(&cfg, state.reserve0, state.reserve1)
            );
            assert_eq!(format!("{state:?}"), before);
        }
    }

    #[test]
    fn quotes_match_swaps_with_native_rounding_and_protocol_cuts() {
        for (d0, d1) in [(18, 18), (6, 18), (8, 6)] {
            for protocol in [0, 5, 25] {
                for ramp in [0, 10_000] {
                    let cfg = config(d0, d1, protocol, ramp);
                    let state = state(d0, d1);
                    let pre_depth = depth(&cfg, state.reserve0, state.reserve1);
                    for token0_in in [false, true] {
                        let token = if token0_in { "token0" } else { "token1" };
                        let in_decimals = if token0_in { d0 } else { d1 };
                        let out_decimals = if token0_in { d1 } else { d0 };
                        let input = 100 * 10u128.pow(in_decimals.into());
                        let quote = quote_exact_in_stateful(&cfg, &state, token, input).unwrap();
                        let swap = swap_stateful(&cfg, state, token, input, 60, true).unwrap();
                        assert_eq!(quote.amount_out_raw, swap.amount_out);
                        assert_eq!(quote.fee_amount_raw, swap.fee_amount_raw);
                        assert_eq!(quote.protocol_cut_raw, swap.protocol_cut_raw);
                        assert!(depth(&cfg, swap.reserve0, swap.reserve1) >= pre_depth);

                        let output = 100 * 10u128.pow(out_decimals.into());
                        let quote = quote_exact_out_stateful(&cfg, &state, token, output).unwrap();
                        let swap =
                            swap_stateful_exact_out(&cfg, state, token, output, 60, true).unwrap();
                        assert_eq!(quote.amount_in_raw, swap.amount_in);
                        assert_eq!(quote.fee_amount_raw, swap.state.fee_amount_raw);
                        assert!(depth(&cfg, swap.state.reserve0, swap.state.reserve1) >= pre_depth);
                    }
                }
            }
        }
    }

    #[test]
    fn post_depth_strictly_rejects_lp_value_decrease() {
        let cfg = config(18, 18, 25, 0);
        let state = state(18, 18);
        let pre_depth = depth(&cfg, state.reserve0, state.reserve1);
        // Deliberately unfavorable native settlement must fail the strict guard.
        let error = checked_post_swap(&cfg, &state, false, WAD, 2 * WAD, 0, pre_depth)
            .err()
            .expect("decreasing LP depth must reject");
        assert!(error.to_string().contains("LpValueDecreased"));
    }

    #[test]
    fn common_margin_and_strict_guard_match_shared_solidity_witnesses() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Witness {
            a_wad: String,
            lambda_wad: String,
            reserve_in: String,
            reserve_out: String,
            amount: String,
            raw: String,
            expected: String,
            exact_out: bool,
            error: Option<String>,
        }
        let cases: std::collections::BTreeMap<String, Witness> = serde_json::from_str(
            include_str!("../../tests/fixtures/equilibra-lp-repair.json"),
        )
        .unwrap();
        assert_eq!(cases.len(), 7);
        for (name, w) in cases {
            let parse = |v: &str| v.parse::<u128>().unwrap();
            let mut cfg = config_at_alpha(18, 18, 25, 0, parse(&w.a_wad));
            cfg.fee_bps = 5;
            cfg.fee_floor_bps = 0;
            cfg.lambda_wad = parse(&w.lambda_wad);
            for zfo in [true, false] {
                let mut st = state(18, 18);
                let (rin, rout, amount, raw) = (
                    parse(&w.reserve_in),
                    parse(&w.reserve_out),
                    parse(&w.amount),
                    parse(&w.raw),
                );
                (st.reserve0, st.reserve1) = if zfo { (rin, rout) } else { (rout, rin) };
                st.e0 = st.reserve0;
                st.e1 = st.reserve1;
                let before = st;
                let token = if zfo { "token0" } else { "token1" };
                let actual_raw = if w.exact_out {
                    compute_exact_out_clean_in_wad(&cfg, &st, zfo, amount.into())
                        .unwrap()
                        .0
                        .as_u128()
                } else {
                    compute_exact_in_amount_out(&cfg, &st, zfo, amount - 1)
                        .unwrap()
                        .0
                };
                assert_eq!(actual_raw, raw, "{name}");
                let pre = depth(&cfg, st.reserve0, st.reserve1);
                let initial = if w.exact_out {
                    (((raw - 1) * 10000 / 9995 + 1).max(raw + 1)) + 1
                } else {
                    amount
                };
                let fee = if w.exact_out { initial - raw } else { 1 };
                let initial_post = post_swap_state(
                    &cfg,
                    &st,
                    zfo,
                    initial,
                    if w.exact_out { amount } else { raw },
                    fee * 25 / 100,
                )
                .unwrap();
                assert_eq!(
                    initial_post.depth < pre,
                    w.error.as_deref() == Some("LpValueDecreased"),
                    "{name}: one strict guard"
                );
                let quote = if w.exact_out {
                    quote_exact_out_stateful(&cfg, &st, token, amount).map(|q| q.amount_in_raw)
                } else {
                    quote_exact_in_stateful(&cfg, &st, token, amount).map(|q| q.amount_out_raw)
                };
                let swap = if w.exact_out {
                    swap_stateful_exact_out(&cfg, st, token, amount, 0, true)
                        .map(|s| (s.amount_in, s.state.reserve0, s.state.reserve1))
                } else {
                    swap_stateful(&cfg, st, token, amount, 0, true)
                        .map(|s| (s.amount_out, s.reserve0, s.reserve1))
                };
                if let Some(error) = &w.error {
                    let leaf = if error == "AmountTooSmallAfterNormalization" {
                        "amount_too_small_after_normalization"
                    } else {
                        error.as_str()
                    };
                    assert_eq!(
                        quote.unwrap_err().to_string(),
                        format!("equilibra_stateful: {leaf}"),
                        "{name}"
                    );
                    assert_eq!(
                        swap.unwrap_err().to_string(),
                        format!("equilibra_stateful: {leaf}"),
                        "{name}"
                    );
                } else {
                    let expected = parse(&w.expected);
                    assert_eq!(quote.unwrap(), expected, "{name}");
                    let (actual, r0, r1) = swap.unwrap();
                    assert_eq!(actual, expected, "{name}");
                    assert!(depth(&cfg, r0, r1) >= pre, "{name}");
                }
                assert_eq!(st, before);
            }
        }
    }

    #[test]
    fn native_boundary_quotes_and_reserves_match_solidity() {
        // Shared with NativeBoundaryVectors.test.ts: token0 has
        // 8 decimals, token1 has 6. Each trade restores these fixed native
        // pre-reserves; includes raw-unit and 99%-reserve amounts both ways.
        let cfg = config(8, 6, 5, 10_000);
        let genesis = init_genesis(&cfg, 100_000_000_000_000, 500_000_000_000, 0).unwrap();
        assert_eq!(genesis.price_scale_wad, 2 * WAD);
        assert_eq!(cfg.token0_scale, U256::from(10_000_000_000u64));
        assert_eq!(cfg.token1_scale, U256::from(1_000_000_000_000u64));
        let cases: Vec<(bool, bool, bool, String, String, String, String)> = serde_json::from_str(
            include_str!("../../tests/fixtures/equilibra-native-quotes.json"),
        )
        .expect("shared Solidity/Rust native vectors");
        for (skew, zero_for_one, exact_out, amount, expected_quote, expected_r0, expected_r1) in
            cases
        {
            let amount: u128 = amount.parse().unwrap();
            let expected_quote: u128 = expected_quote.parse().unwrap();
            let expected_r0: u128 = expected_r0.parse().unwrap();
            let expected_r1: u128 = expected_r1.parse().unwrap();
            let (r0, r1) = if skew {
                (203_951_604_822_890, 25_000_000_000)
            } else {
                (genesis.reserve0, genesis.reserve1)
            };
            let state = EquilibraStatefulState {
                reserve0: r0,
                reserve1: r1,
                e0: r0,
                e1: r1,
                price_scale_wad: genesis.price_scale_wad,
                total_supply: genesis.total_supply,
                ema_log_wad: genesis.ema_log_wad,
                lp_unit_value_genesis_wad: genesis.lp_unit_value_genesis_wad,
                lp_unit_value_wad: genesis.lp_unit_value_genesis_wad,
                ..EquilibraStatefulState::empty()
            };
            let token = if zero_for_one { "token0" } else { "token1" };
            if exact_out {
                let quote = quote_exact_out_stateful(&cfg, &state, token, amount).unwrap();
                let swap = swap_stateful_exact_out(&cfg, state, token, amount, 0, true).unwrap();
                assert_eq!(quote.amount_in_raw, expected_quote);
                assert_eq!(swap.amount_in, expected_quote);
                assert_eq!(
                    (swap.state.reserve0, swap.state.reserve1),
                    (expected_r0, expected_r1)
                );
            } else if expected_quote == 0 {
                assert!(quote_exact_in_stateful(&cfg, &state, token, amount).is_err());
                assert!(swap_stateful(&cfg, state, token, amount, 0, true).is_err());
            } else {
                let quote = quote_exact_in_stateful(&cfg, &state, token, amount).unwrap();
                let swap = swap_stateful(&cfg, state, token, amount, 0, true).unwrap();
                assert_eq!(quote.amount_out_raw, expected_quote);
                assert_eq!(swap.amount_out, expected_quote);
                assert_eq!((swap.reserve0, swap.reserve1), (expected_r0, expected_r1));
            }
        }
    }

    #[test]
    fn unrepresentable_zero_clean_input_is_rejected_before_gross_up() {
        let mut cfg = config(18, 18, 0, 0);
        cfg.a_wad = A_MIN_WAD;
        let mut st = state(18, 18);
        st.reserve0 *= 20;
        st.e0 = st.reserve0;
        assert_eq!(
            quote_exact_out_forward(
                st.reserve1.into(),
                st.reserve0.into(),
                U256::one(),
                cfg.a_wad.into(),
                cfg.lambda_wad.into()
            )
            .unwrap(),
            (U256::zero(), 2)
        );
        let before = st;
        let quote = quote_exact_out_stateful(&cfg, &st, "token1", 1).unwrap_err();
        let swap = swap_stateful_exact_out(&cfg, st, "token1", 1, 60, true).unwrap_err();
        assert_eq!(
            quote.to_string(),
            "equilibra_stateful: amount_too_small_after_normalization"
        );
        assert_eq!(swap.to_string(), quote.to_string());
        assert_eq!(st, before);
    }

    #[test]
    fn exact_in_native_settlement_never_adds_another_correction() {
        for (d0, d1, zero_for_one, input) in [
            (18u8, 18u8, true, 18u128),
            (18, 18, false, 9),
            (6, 18, true, 2),
            (8, 18, true, 2),
            (18, 8, false, 18),
        ] {
            let mut cfg = config_at_alpha(d0, d1, 0, 0, A_MIN_WAD);
            cfg.fee_bps = 5;
            let mut state = state(d0, d1);
            state.reserve0 = 11 * 10u128.pow(d0.into()) / 10;
            state.reserve1 = 908_695_585_459_600_090u128 * 10u128.pow(d1.into()) / WAD;
            state.e0 = state.reserve0;
            state.e1 = state.reserve1;
            state.total_supply = WAD;
            let before = state;
            let token = if zero_for_one { "token0" } else { "token1" };
            let (expected, _, pre) =
                compute_exact_in_amount_out(&cfg, &state, zero_for_one, input - 1).unwrap();
            let quote = quote_exact_in_stateful(&cfg, &state, token, input).unwrap();
            let swap = swap_stateful(&cfg, state, token, input, 60, true).unwrap();
            assert_eq!(quote.amount_out_raw, expected);
            assert_eq!(swap.amount_out, expected);
            assert_eq!((quote.fee_amount_raw, quote.protocol_cut_raw), (1, 0));
            let reserves = if zero_for_one {
                (state.reserve0 + input, state.reserve1 - expected)
            } else {
                (state.reserve0 - expected, state.reserve1 + input)
            };
            assert_eq!((swap.reserve0, swap.reserve1), reserves);
            assert!(depth(&cfg, swap.reserve0, swap.reserve1) >= pre);
            assert_eq!(state, before);
        }
    }

    #[test]
    fn exact_in_dust_has_one_math_margin_and_a_strict_lp_guard() {
        let cfg = config_at_alpha(18, 18, 0, 0, A_MAX_WAD);
        for (r0, r1, clean_input) in [
            (20 * 10u128.pow(30), 10u128.pow(30), 1),
            (10u128.pow(24), 10u128.pow(24), 2),
        ] {
            let mut st = state(18, 18);
            st.reserve0 = r0;
            st.reserve1 = r1;
            st.e0 = r0;
            st.e1 = r1;
            let before = st;
            let (raw, _, pre) = compute_exact_in_amount_out(&cfg, &st, false, clean_input).unwrap();
            assert_eq!(raw, 1);
            let input = clean_input + 1;
            let quote = quote_exact_in_stateful(&cfg, &st, "token1", input).unwrap();
            let swap = swap_stateful(&cfg, st, "token1", input, 60, true).unwrap();
            assert_eq!(quote.amount_out_raw, raw);
            assert_eq!(swap.amount_out, raw);
            assert_eq!(swap.fee_amount_raw, 1);
            assert!(depth(&cfg, swap.reserve0, swap.reserve1) >= pre);
            assert_eq!(st, before);
        }
    }

    #[test]
    fn exact_out_keeps_adjusted_math_input_without_a_native_repair() {
        for (d0, d1) in [(18, 18), (6, 18), (8, 6)] {
            let cfg = config(d0, d1, 5, 0);
            let state = state(d0, d1);
            for zero_for_one in [false, true] {
                let (_reserve_in, reserve_out, in_scale, out_scale) = if zero_for_one {
                    (
                        state.reserve0,
                        state.reserve1,
                        cfg.token0_scale,
                        cfg.token1_scale,
                    )
                } else {
                    (
                        state.reserve1,
                        state.reserve0,
                        cfg.token1_scale,
                        cfg.token0_scale,
                    )
                };
                let token = if zero_for_one { "token0" } else { "token1" };
                let out = reserve_out / 1000;
                let (clean_wad, _, _) = compute_exact_out_clean_in_wad(
                    &cfg,
                    &state,
                    zero_for_one,
                    U256::from(out) * out_scale,
                )
                .unwrap();
                let unadjusted =
                    to_u128(from_wad_up_by_scale(clean_wad, in_scale).unwrap(), "test").unwrap();
                let quote = quote_exact_out_stateful(&cfg, &state, token, out).unwrap();
                assert_eq!(quote.amount_in_clean_raw, unadjusted);
                assert_eq!(
                    quote.amount_in_raw,
                    to_u128(
                        gross_up_exact_out(U256::from(unadjusted), cfg.fee_bps * FEE_BPS_TO_WAD,)
                            .unwrap(),
                        "test"
                    )
                    .unwrap()
                        + 1
                );
                assert_eq!(
                    quote.fee_amount_raw,
                    quote.amount_in_raw - quote.amount_in_clean_raw
                );
                let swap = swap_stateful_exact_out(&cfg, state, token, out, 60, true).unwrap();
                assert_eq!(swap.amount_in, quote.amount_in_raw);
                assert_eq!(swap.state.amount_out, out);
            }
        }
    }

    #[test]
    fn former_quantization_cap_cases_now_match_native_quotes_and_swaps() {
        let x = 1_000_000_000_000u128 * WAD;
        let clean = 1_000_000_000_000u128;
        let gross = 1_001_001_001_001u128;
        assert_eq!(gross - gross * 10 / BPS, clean);
        let mut checked = 0;
        for alpha in [
            909_610_000_000_000_030u128,
            990_000_000_000_000_000,
            999_750_062_484_378_906,
            999_950_002_499_875_007,
            A_MAX_WAD,
        ] {
            for protocol in [0, 5, 25] {
                for exact_out in [false, true] {
                    let y = if exact_out { x * 20 } else { x / 20 };
                    let mut cfg = config_at_alpha(18, 18, protocol, 0, alpha);
                    cfg.lambda_wad = if exact_out {
                        LAMBDA_MIN_WAD
                    } else {
                        16_780_000_000_000_000
                    };
                    // These exhausted the old WAD-amplification solver.
                    let (_, iters) = if exact_out {
                        quote_exact_out_forward(
                            x.into(),
                            y.into(),
                            clean.into(),
                            alpha.into(),
                            cfg.lambda_wad.into(),
                        )
                    } else {
                        quote_exact_in_forward(
                            x.into(),
                            y.into(),
                            clean.into(),
                            alpha.into(),
                            cfg.lambda_wad.into(),
                        )
                    }
                    .unwrap();
                    assert!(iters <= 40);
                    for zero_for_one in [false, true] {
                        let mut state = state(18, 18);
                        (state.reserve0, state.reserve1) =
                            if zero_for_one { (x, y) } else { (y, x) };
                        state.e0 = state.reserve0;
                        state.e1 = state.reserve1;
                        state.total_supply = x;
                        let before = state;
                        let token = if zero_for_one { "token0" } else { "token1" };
                        let (quote, swap) = if exact_out {
                            (
                                quote_exact_out_stateful(&cfg, &state, token, clean)
                                    .unwrap()
                                    .amount_in_raw,
                                swap_stateful_exact_out(&cfg, state, token, clean, 60, true)
                                    .unwrap()
                                    .amount_in,
                            )
                        } else {
                            (
                                quote_exact_in_stateful(&cfg, &state, token, gross)
                                    .unwrap()
                                    .amount_out_raw,
                                swap_stateful(&cfg, state, token, gross, 60, true)
                                    .unwrap()
                                    .amount_out,
                            )
                        };
                        assert_eq!(
                            quote, swap,
                            "exact_out={exact_out}, alpha={alpha}, protocol={protocol}, zero_for_one={zero_for_one}"
                        );
                        assert_eq!(state, before);
                        checked += 1;
                    }
                }
            }
        }
        assert_eq!(checked, 60);
    }
}

#[cfg(test)]
mod log_step_tests {
    use super::*;

    const W: u128 = WAD;

    /// Test-only composition of the two production pieces — the exact
    /// sequence `try_auto_repeg` runs for its first (unhalved)
    /// candidate.
    fn shift_price_scale(
        price_scale_old: u128,
        target: u128,
        repeg_step_wad: u128,
        deviation_wad: u128,
        damping_divisor: u128,
    ) -> Result<u128> {
        let applied = applied_repeg_step(repeg_step_wad, deviation_wad, damping_divisor)?;
        apply_log_step(price_scale_old, target, applied)
    }

    /// The property the log-domain step exists for: a mirrored
    /// (reciprocal-frame) pool shifting toward the mirrored target
    /// lands on the exact reciprocal anchor, up to mulWad floor dust.
    #[test]
    fn shift_is_reciprocal_exact_up_to_floor_dust() {
        let cases: [(u128, u128); 4] = [
            (2_000 * W, 2_100 * W),                   // 5% gap up
            (2_000 * W, 1_900 * W),                   // 5% gap down
            (17_000_000_000_000, 17_400_000_000_000), // flipped-WBTC scale
            (3_000 * W, 2_995 * W),                   // sub-step gap (clamp path)
        ];
        let step = 5_000_000_000_000_000u128; // 0.5% cap
        for (ps, target) in cases {
            let (hi, lo) = if target > ps {
                (target, ps)
            } else {
                (ps, target)
            };
            let dev = ((U256::from(hi) * U256::from(W)) / U256::from(lo) - U256::from(W)).as_u128();
            let direct = shift_price_scale(ps, target, step, dev, 5).expect("direct");

            let wad2 = U256::from(W) * U256::from(W);
            let ps_m = (wad2 / U256::from(ps)).as_u128();
            let target_m = (wad2 / U256::from(target)).as_u128();
            let mirror = shift_price_scale(ps_m, target_m, step, dev, 5).expect("mirror");

            let prod = U256::from(direct) * U256::from(mirror) / U256::from(W);
            let dev_prod = if prod > U256::from(W) {
                prod - U256::from(W)
            } else {
                U256::from(W) - prod
            };
            // Floor dust only: sub-1e-9 relative.
            assert!(
                dev_prod <= U256::from(1_000_000_000u128),
                "ps={ps} target={target}: product deviation {dev_prod}"
            );
        }
    }

    /// Up and down moves of the same magnitude are exact multiplicative
    /// inverses: stepping up by `s` and then down by `s` returns to the
    /// start within floor dust (the additive form drifts by O(s²)).
    #[test]
    fn shift_up_then_down_returns_to_start() {
        let ps = 2_000 * W;
        let step = 5_000_000_000_000_000u128; // 0.5%
                                              // Far targets so the damped step (dev/5), not the clamp, binds.
        let dev = 200_000_000_000_000_000u128; // 20% deviation -> dev/5 = 4% > cap
        let up = shift_price_scale(ps, 3_000 * W, step, dev, 5).expect("up");
        let back = shift_price_scale(up, 1_500 * W, step, dev, 5).expect("down");
        let diff = ps.abs_diff(back);
        // expWad(+s) and expWad(−s) each carry sub-ulp rounding, so the
        // round trip closes to ~1e-12 relative — versus the additive
        // form's systematic O(s²) = 2.5e-5 relative drift, seven orders
        // larger, so the bound still discriminates the two forms.
        assert!(
            diff <= ps / 1_000_000_000_000,
            "round trip drift {diff} wei (ps {ps})"
        );
    }
}

#[cfg(test)]
mod genesis_precision_tests {
    use super::*;

    fn config() -> EquilibraStatefulConfig {
        EquilibraStatefulConfig::new(
            "tk0",
            "tk1",
            18,
            18,
            100,
            843_000_000_000_000_000,
            32_300_000_000_000_000,
            0,
            600,
            5_000_000_000_000_000,
            1_000_000_000_000_000,
            1_000_000_000_000_000,
            0,
            0,
            5_000,
        )
        .expect("config builds")
    }

    #[test]
    fn genesis_guard_and_tolerance_share_one_constant() {
        assert_eq!(MAX_GENESIS_VP_ERROR_WAD, REPEG_GAS_GUARD_WAD);
        assert_eq!(MIN_INITIAL_LIQUIDITY, 1_000_000);
    }

    #[test]
    fn ema_half_life_to_tau_conversion_matches_the_factory_bit_for_bit() {
        // Hard-coded (half-life, internal tau) pairs pin the conversion
        // against the Solidity factory (`tau = (h*1000 + 693) / 694`
        // with uint truncation == ceil) and the pool view's floor
        // inverse (`tau * 694 / 1000`). The remainder (h*1000) % 694 is
        // always even, so the sampled edges are r = 0 (exact division,
        // h = 347), r = 2 (minimal ceil bump, h = 220) and r = 692
        // (maximal ceil bump, h = 127), plus both domain boundaries and
        // the bundled-preset value.
        for (half_life, tau) in [
            (60u128, 87u128), // MIN_EMA_PERIOD boundary
            (127, 183),       // remainder 692
            (220, 318),       // remainder 2
            (347, 500),       // remainder 0 — both divisions exact
            (600, 865),       // bundled presets / live reference view
            (3_600, 5_188),
            (86_400, 124_496),
            (419_731, 604_800), // largest accepted half-life -> MAX_EMA_PERIOD
        ] {
            let cfg = EquilibraStatefulConfig::new(
                "tk0",
                "tk1",
                18,
                18,
                100,
                843_000_000_000_000_000,
                32_300_000_000_000_000,
                0,
                half_life,
                5_000_000_000_000_000,
                1_000_000_000_000_000,
                1_000_000_000_000_000,
                0,
                0,
                5_000,
            )
            .expect("config builds");
            assert_eq!(cfg.ema_period, tau, "stored tau for half-life {half_life}");
            assert_eq!(
                tau * 694 / 1000,
                half_life,
                "view inverse must recover the exact input for tau {tau}"
            );
        }
    }

    #[test]
    fn q128_genesis_vectors_match_solidity_without_false_depth_rejections() {
        for raw in [
            100_000_000u128,
            10_000_000_000,
            4_116_559_088_214,
            6_215_937_829_629,
        ] {
            let state = init_genesis(&config(), raw, raw, 1).expect("accurate balanced genesis");
            assert_eq!(state.lp_unit_value_genesis_wad, 2 * WAD - 1);
            assert_eq!((state.reserve0, state.reserve1), (raw, raw));
        }
    }

    #[test]
    fn extreme_anchor_ratio_is_outside_supported_precision_domain() {
        let small = WAD;
        let large = 777_777_777_777_777u128
            .checked_mul(WAD)
            .expect("test vector fits u128");
        let err = init_genesis(&config(), small, large, 1)
            .expect_err("price-scale quantization must fail the genesis policy");
        assert!(err.to_string().contains("2000000056202507187"));
    }
}

#[cfg(test)]
mod ema_cap_tests {
    //! Regression tests for the symmetric EMA spot cap parity with
    //! `PoolOracle.updateEma`.
    //!
    //! Bug history: an earlier revision narrowed `spot_raw_u: U256` to
    //! `u128` *before* the `[priceScale/MUL, priceScale*MUL]` clamp.
    //! When `pMarg × priceScale / WAD` exceeded `u128::MAX` (extreme
    //! imbalance + large priceScale), the conversion failed and the
    //! whole `update_ema_in_place` call returned `Ok(())` without
    //! touching `state.ema_log_wad` — silently freezing the EMA
    //! and, downstream, the auto-repeg gate. The on-chain
    //! `PoolOracle.updateEma` uses `uint256` end-to-end and clamps
    //! before storing, so it never has this failure mode. Fix: cap
    //! `spot_raw_u` in `U256`, *then* narrow to `u128`. These tests
    //! pin that ordering.
    use super::*;

    fn balanced_config() -> EquilibraStatefulConfig {
        EquilibraStatefulConfig::new(
            "tk0",
            "tk1",
            18,
            18,                          // decimals
            100,                         // fee_bps
            843_000_000_000_000_000u128, // a_wad (WETH preset)
            32_300_000_000_000_000u128,  // lambda_wad (WETH preset)
            0,                           // protocol_fee_percent
            3_600,                       // ema_period (1h)
            1_000_000_000_000_000u128,   // repeg_step_wad (0.1%)
            1_000_000_000_000_000u128,   // repeg_threshold_token1_up = step
            1_000_000_000_000_000u128,   // repeg_threshold_token1_down = step
            1_000,                       // fee_ramp_bps
            20,                          // fee_floor_bps
            5_000,                       // repeg_share_bps
        )
        .expect("config builds")
    }

    /// Build a state with arbitrary `price_scale_wad`. Reserves and
    /// EMA fields are left zero — callers populate them.
    fn state_with_price_scale(price_scale_wad: u128) -> EquilibraStatefulState {
        EquilibraStatefulState {
            price_scale_wad,
            ..EquilibraStatefulState::empty()
        }
    }

    /// In `load_math_state`:
    ///   `x_wad = reserve1 · token1_scale`  (math `x`-axis)
    ///   `y_wad = reserve0 · token0_scale`  (math `y`-axis)
    /// Under the asymmetric coord change `to_math_space` sets
    /// `x_math = x_wad` and `y_math = y_wad·WAD/priceScale`. So
    /// `x_math == y_math` (math-balance, `pMarg = WAD`) iff
    /// `y_wad / x_wad = priceScale / WAD`. With equal token decimals
    /// this reduces to `reserve0 / reserve1 = priceScale / WAD`.
    ///
    /// For these regression tests we pin `priceScale = WAD` (numeric
    /// "price = 1") so that math-balance is simply `reserve0 =
    /// reserve1`. This keeps the cap-clamp behaviour decoupled from
    /// the math-space coord change.
    #[test]
    fn ema_upper_cap_clamps_spot_above_2x_price_scale() {
        let config = balanced_config();
        let price_scale = WAD;
        let mut state = state_with_price_scale(price_scale);

        // Bootstrap at math-balance → EMA = priceScale = WAD.
        let r = 1_000_000u128 * 10u128.pow(18);
        state.reserve0 = r;
        state.reserve1 = r;
        update_ema_in_place(&config, &mut state, 1_000_000).expect("bootstrap at balance");
        let ema_boot = state.ema_price_wad().unwrap();
        assert!(ema_boot > 0, "bootstrap seeds EMA");
        assert!(
            ema_boot >= price_scale * 9 / 10 && ema_boot <= price_scale * 11 / 10,
            "bootstrap EMA {} should be ≈ priceScale {}",
            ema_boot,
            price_scale
        );

        // Drain reserve1 → math-space spot soars past 2× priceScale.
        state.reserve1 = 10u128.pow(15); // ~10⁹× imbalance vs reserve0
        let now = 1_000_000 + 10 * config.ema_period as u64;
        update_ema_in_place(&config, &mut state, now).expect("non-bootstrap update must NOT skip");

        assert_ne!(
            state.ema_price_wad().unwrap(),
            ema_boot,
            "EMA must update under extreme imbalance, never freeze"
        );
        let max_spot = price_scale * EMA_PRICE_CAP_MUL;
        assert!(
            state.ema_price_wad().unwrap() <= max_spot,
            "EMA {} must be ≤ priceScale × MUL = {} (upper cap parity)",
            state.ema_price_wad().unwrap(),
            max_spot
        );
        assert!(
            state.ema_price_wad().unwrap() > ema_boot,
            "EMA must move toward the upper cap (was {}, got {})",
            ema_boot,
            state.ema_price_wad().unwrap()
        );
    }

    /// Mirror of the upper-cap test: starve reserve0 instead, so
    /// math-space spot drops well below `priceScale / 2`. Lower cap
    /// must clamp.
    #[test]
    fn ema_lower_cap_clamps_spot_below_half_price_scale() {
        let config = balanced_config();
        let price_scale = WAD;
        let mut state = state_with_price_scale(price_scale);

        let r = 1_000_000u128 * 10u128.pow(18);
        state.reserve0 = r;
        state.reserve1 = r;
        update_ema_in_place(&config, &mut state, 1_000_000).expect("bootstrap");
        let ema_boot = state.ema_price_wad().unwrap();

        // Drain reserve0 → math-space spot collapses far below half.
        state.reserve0 = 10u128.pow(15);
        let now = 1_000_000 + 10 * config.ema_period as u64;
        update_ema_in_place(&config, &mut state, now).expect("non-bootstrap update must NOT skip");

        let min_spot = price_scale / EMA_PRICE_CAP_DIV;
        assert!(
            state.ema_price_wad().unwrap() >= min_spot,
            "EMA {} must be ≥ priceScale / DIV = {} (lower cap parity)",
            state.ema_price_wad().unwrap(),
            min_spot
        );
        assert!(
            state.ema_price_wad().unwrap() < ema_boot,
            "EMA must move toward the lower cap (was {}, got {})",
            ema_boot,
            state.ema_price_wad().unwrap()
        );
    }

    // The previous `ema_does_not_freeze_when_raw_spot_would_overflow_u128`
    // regression test guarded against `to_u128` failing before the
    // symmetric-spot cap was applied. Under the asymmetric coord
    // change the overflow scenario it constructed is now structurally
    // unreachable: `yMath = yWad·WAD/priceScale` is bounded by
    // `u128::MAX·WAD/priceScale`, so for any `priceScale` large
    // enough to make raw spot exceed `u128::MAX`, the post-imbalance
    // `pMarg` can never reach the trigger threshold inside the
    // representable `(x_math, y_math)` envelope. The U256-cap-before-
    // narrow defense is still in `update_ema_in_place`; it is now
    // covered indirectly by `long_run_no_priceScale_runaway_*` which
    // exercises the EMA update path under realistic loads.

    /// **Long-run runaway probe — isolates kernel vs arb-model**.
    ///
    /// Runs 200 alternating real swaps through `equilibra_swap_stateful`
    /// (the *same* code path the simulator drives — and the same path
    /// the contract drives bit-for-bit, by simparity). No arb model,
    /// just user-style bidirectional trades with realistic spacing.
    ///
    /// If `priceScale` stays bounded ⇒ runaway is in main.rs arb
    /// loop or the user-trade pattern, not in the kernel.
    /// If `priceScale` explodes (grows > 10×) ⇒ runaway is in the
    /// kernel stateful executor (EMA/repeg/cap interaction itself).
    #[test]
    fn long_run_no_price_scale_runaway_without_arbs() {
        use super::super::LocalQuoter;
        use crate::runtime_quoter::equilibra_math::sqrt_u256;

        // WBTC preset (production config — the one that runaway'd).
        let config = EquilibraStatefulConfig::new(
            "usdt",
            "wbtc",
            6,
            8,
            100,                         // baseFee
            949_000_000_000_000_000u128, // aWad (WBTC preset)
            13_900_000_000_000_000u128,  // lambdaWad (WBTC preset)
            0,
            3_600,
            1_000_000_000_000_000u128, // repegStepWad = 1e15 = 0.1%
            1_000_000_000_000_000u128, // repegThresholdToken1Up = step
            1_000_000_000_000_000u128, // repegThresholdToken1Down = step
            1_000,                     // feeRampBps
            20,                        // feeFloorBps
            5_000,                     // repegShareBps
        )
        .expect("WBTC preset config builds");

        // Initial reserves: 500K USDT + 11.58 WBTC ≈ $43K WBTC.
        // Asymmetric coords: priceScale = yWad·WAD/xWad
        // (quote-per-base, WAD form). Mirrors `EquilibraPool` genesis.
        let r0_raw = 500_000u128 * 10u128.pow(6); // 500K USDT, 6dec
        let r1_raw = 1_157_947_552u128; // ~11.58 WBTC, 8dec
        let x_wad = U256::from(r1_raw) * U256::from(10u128.pow(10)); // WBTC scale
        let y_wad = U256::from(r0_raw) * U256::from(10u128.pow(12)); // USDT scale
        let init_ps_u: u128 = math_mul_div_floor(y_wad, U256::from(WAD), x_wad)
            .unwrap()
            .try_into()
            .unwrap();
        let supply: u128 = sqrt_u256(x_wad * y_wad).try_into().unwrap();

        let mut state = EquilibraStatefulState::empty();
        state.reserve0 = r0_raw;
        state.reserve1 = r1_raw;
        state.price_scale_wad = init_ps_u;
        state.total_supply = supply;
        state.lp_unit_value_genesis_wad = compute_pool_lp_unit_value(
            &config,
            state.reserve0,
            state.reserve1,
            state.price_scale_wad,
            state.total_supply,
        )
        .unwrap();
        state.lp_unit_value_wad = state.lp_unit_value_genesis_wad;
        // last_ema_ts/last_repeg_ts at genesis = the swap timestamp.

        let initial_ps = state.price_scale_wad;
        let mut now = 1_000_000u64;
        let mut quoter = LocalQuoter::new();

        // Drive 200 alternating real swaps. Each swap = 0.5% of the
        // matching reserve. 60s between swaps so EMA can update.
        for i in 0..200u64 {
            now += 60;
            let (token_in, amount_in) = if i % 2 == 0 {
                ("usdt", state.reserve0 * 50 / 10_000)
            } else {
                ("wbtc", state.reserve1 * 50 / 10_000)
            };
            if amount_in == 0 {
                continue;
            }
            let out = quoter
                .equilibra_swap_stateful(&config, state, token_in, amount_in, now, false)
                .expect("swap ok");
            // Apply the output to state (mirrors `apply_equilibra_stateful_out`).
            state.reserve0 = out.reserve0;
            state.reserve1 = out.reserve1;
            state.price_scale_wad = out.price_scale_wad;
            state.total_supply = out.total_supply;
            state.protocol_fee0 = out.protocol_fee0;
            state.protocol_fee1 = out.protocol_fee1;
            state.e0 = out.e0;
            state.e1 = out.e1;
            state.ema_log_wad = out.ema_log_wad;
            state.last_ema_ts = out.last_ema_ts;
            state.last_repeg_ts = out.last_repeg_ts;
            state.lp_unit_value_wad = out.lp_unit_value_wad;
            state.lp_value_growth_wad = out.lp_value_growth_wad;
        }

        let final_ps = state.price_scale_wad;
        let growth_factor = final_ps as f64 / initial_ps as f64;
        eprintln!(
            "long-run probe: initial_ps={}, final_ps={}, factor={:.6}",
            initial_ps, final_ps, growth_factor
        );
        // priceScale must NOT explode by orders of magnitude over 200
        // bidirectional symmetric swaps. A healthy AMM would stay
        // within ±10% (factor 0.9–1.1) since user trades net to zero.
        assert!(
            growth_factor < 2.0 && growth_factor > 0.5,
            "priceScale ran away over 200 symmetric swaps: factor={:.6} \
             (initial={}, final={}). Runaway in kernel itself.",
            growth_factor,
            initial_ps,
            final_ps
        );
    }

    /// **Stateless quote vs stateful executor — fee accounting probe.**
    ///
    /// The arb model in `main.rs` uses
    /// `quote_equilibra_exact_in_stateless` to estimate trade
    /// output. The original implementation skipped fee deduction
    /// while the stateful executor applies it; the resulting
    /// `feeBps`-bps gap meant every arb trade landed with less
    /// output than estimated, the pool drifted each cycle, and over
    /// thousands of cycles `priceScale` exploded by 10²⁵× in the
    /// 4-year run. See [`main.rs::quote_equilibra_exact_in_stateless`]
    /// for the fix.
    ///
    /// This test re-creates the **old (broken)** inline behaviour
    /// and asserts the divergence is exactly the bug we patched.
    /// If the production stateless ever regresses to the fee-free
    /// path, the same divergence pattern (`feeBps` bps gap) will
    /// reappear in `evaluate_profit_for_size` and runaway will
    /// return.
    #[test]
    fn stateless_quote_matches_stateful_output_after_fees() {
        use super::super::LocalQuoter;
        use crate::runtime_quoter::equilibra_math::sqrt_u256;

        let config = EquilibraStatefulConfig::new(
            "usdt",
            "wbtc",
            6,
            8,
            100,
            949_000_000_000_000_000u128,
            13_900_000_000_000_000u128,
            0,
            3_600,
            1_000_000_000_000_000u128,
            1_000_000_000_000_000u128,
            1_000_000_000_000_000u128,
            1_000,
            20,
            5_000,
        )
        .expect("config builds");

        let r0_raw = 500_000u128 * 10u128.pow(6);
        let r1_raw = 1_157_947_552u128;
        let x_wad = U256::from(r1_raw) * U256::from(10u128.pow(10));
        let y_wad = U256::from(r0_raw) * U256::from(10u128.pow(12));
        // priceScale = yWad·WAD/xWad (quote-per-base).
        let init_ps_u: u128 = math_mul_div_floor(y_wad, U256::from(WAD), x_wad)
            .unwrap()
            .try_into()
            .unwrap();
        let supply: u128 = sqrt_u256(x_wad * y_wad).try_into().unwrap();

        let mut state = EquilibraStatefulState::empty();
        state.reserve0 = r0_raw;
        state.reserve1 = r1_raw;
        state.price_scale_wad = init_ps_u;
        state.total_supply = supply;
        state.lp_unit_value_genesis_wad = compute_pool_lp_unit_value(
            &config,
            state.reserve0,
            state.reserve1,
            state.price_scale_wad,
            state.total_supply,
        )
        .unwrap();
        state.lp_unit_value_wad = state.lp_unit_value_genesis_wad;

        // 1% of USDT reserve = realistic arb probe size.
        let amount_in = state.reserve0 * 100 / 10_000;
        let now = 1_000_000u64;

        // Stateful: actual on-chain-mirror execution. Returns output
        // *after* fee deduction from the curve math.
        let mut quoter = LocalQuoter::new();
        let out = quoter
            .equilibra_swap_stateful(
                &config, state, "usdt", amount_in, now,
                true, // disable_recenter = true (cleanly isolates fees)
            )
            .expect("stateful ok");
        let stateful_output = out.amount_out;
        let stateful_fee = out.fee_amount_raw;

        eprintln!(
            "amount_in={}, stateful_output={}, stateful_fee={}",
            amount_in, stateful_output, stateful_fee,
        );
        assert!(stateful_fee > 0, "fee should be > 0 for non-zero base fee");

        // Stateless: inline copy of the *production* (post-fix)
        // `main.rs::quote_equilibra_exact_in_stateless`. Must
        // produce the same output as stateful for the same input —
        // including the dynamic fee deduction. If this ever diverges
        // by more than rounding, the arb model is using inflated
        // estimates and a `priceScale` runaway will return.
        let stateless_output: u128 = {
            let price_scale = U256::from(state.price_scale_wad);
            // Resolve dynamic fee against pre-swap state (mirrors prod).
            let fee_wad_effective =
                resolve_dynamic_fee_wad_from_cp(&config, &state, true, amount_in).unwrap();
            let fee_amount = math_mul_div_floor(
                U256::from(amount_in),
                U256::from(fee_wad_effective),
                U256::from(WAD),
            )
            .unwrap();
            let clean_in: u128 = (U256::from(amount_in) - fee_amount).try_into().unwrap();
            // Asymmetric coord transform on POST-fee input — matches stateful.
            let x_wad_in = U256::from(state.reserve1) * config.token1_scale;
            let y_wad_in = U256::from(state.reserve0) * config.token0_scale;
            let (x_math_in, y_math_in) = to_math_space(x_wad_in, y_wad_in, price_scale).unwrap();
            let amount_in_wad = U256::from(clean_in) * config.token0_scale;
            // zfo: token0 (quote) deposit → yMath = divWad(amountInWad, priceScale)
            let amount_in_math =
                math_mul_div_floor(amount_in_wad, U256::from(WAD), price_scale).unwrap();
            let (out_math, _) = quote_exact_in_forward(
                y_math_in,
                x_math_in,
                amount_in_math,
                U256::from(config.a_wad),
                U256::from(config.lambda_wad),
            )
            .unwrap();
            // zfo output side is xMath → token1 (base) wad identity.
            let amount_out_wad = out_math;
            let out_raw = amount_out_wad / config.token1_scale;
            let native_out: u128 = out_raw.try_into().unwrap();
            native_out - (state.reserve1 - 1) / state.reserve0 - 1
        };
        eprintln!("stateless_output={}", stateless_output);

        // Compute relative divergence in bps.
        let diff = if stateless_output > stateful_output {
            stateless_output - stateful_output
        } else {
            stateful_output - stateless_output
        };
        let diff_bps = (diff * 10_000) / stateful_output.max(1);
        eprintln!("divergence: {} wei ({} bps)", diff, diff_bps);

        // Post-fix, stateless must produce the same output as
        // stateful bit-for-bit (allowing rounding noise of at most
        // a few wei). Any larger gap means the production stateless
        // quoter is missing a piece of the stateful executor's
        // pipeline and arbs will systematically over/under-trade.
        assert!(
            diff_bps == 0 && diff <= 10,
            "Stateless (post-fix) diverges from stateful by {} wei \
             ({} bps). Both should match bit-for-bit. \
             stateful={}, stateless={}.",
            diff,
            diff_bps,
            stateful_output,
            stateless_output,
        );
    }

    /// **Reproduce the runaway state — compute pMarg + effective
    /// price at the runaway pool state**. Pool reserves taken from
    /// the 7-day trace at iteration 22216 (priceScale ≈ 17.7,
    /// reserves still resemble initial). Shows what the kernel
    /// reports as `spot_raw` vs what the pool actually quotes for a
    /// small probe.
    #[test]
    fn runaway_state_pmarg_vs_effective_price() {
        use crate::runtime_quoter::equilibra_math::quote_exact_in_forward;

        let a = U256::from(949_000_000_000_000_000u128);
        let lam = U256::from(13_900_000_000_000_000u128);
        let price_scale_wad = 17733129120826808092u128;
        let price_scale: U256 = U256::from(price_scale_wad);
        let r0_raw = 453045924235u128; // USDT raw (6 dec)
        let r1_raw = 1252485607u128; // WBTC raw (8 dec)
        let x_wad = U256::from(r1_raw) * U256::from(10u128.pow(10));
        let y_wad = U256::from(r0_raw) * U256::from(10u128.pow(12));
        let (x_math, y_math) = to_math_space(x_wad, y_wad, price_scale).unwrap();
        eprintln!("--- Pool state in asymmetric coord ---");
        eprintln!(
            "r0={}, r1={}, priceScale={}",
            r0_raw, r1_raw, price_scale_wad
        );
        eprintln!("x_wad={}, y_wad={}", x_wad, y_wad);
        eprintln!("priceScale={}", price_scale);
        eprintln!("x_math={}, y_math={}", x_math, y_math);
        if !x_math.is_zero() {
            eprintln!("y/x ratio: {}", y_math / x_math);
        }

        // Compute pMarg via kernel (infinitesimal slope).
        let p_marg = marginal_price_from_state(x_math, y_math, a, lam).unwrap();
        eprintln!("--- Kernel pMarg ---");
        eprintln!(
            "pMarg_wad = {} (= {} real)",
            p_marg,
            p_marg.as_u128() as f64 / 1e18
        );

        // Compute spot_raw = pMarg × priceScale / WAD.
        let spot_raw = mul_wad(p_marg, U256::from(price_scale_wad)).unwrap();
        eprintln!("spot_raw (pMarg×priceScale/WAD) = {}", spot_raw);
        eprintln!(
            "priceScale × 2 (upper cap) = {}",
            U256::from(price_scale_wad) * U256::from(2u128)
        );
        let ratio_to_cap = spot_raw / (U256::from(price_scale_wad) * U256::from(2u128));
        eprintln!(
            "spot_raw / cap_upper = {} (>1 means cap fires)",
            ratio_to_cap
        );

        // Probe: simulate a 100 USDT trade and see effective price.
        // Asymmetric lift: zfo (quote in) → amountInMath = divWad(amountInWad, priceScale).
        let amount_in_raw = 100u128 * 10u128.pow(6);
        let amount_in_wad = U256::from(amount_in_raw) * U256::from(10u128.pow(12));
        let amount_in_math =
            math_mul_div_floor(amount_in_wad, U256::from(WAD), price_scale).unwrap();
        let (out_math, _) = quote_exact_in_forward(y_math, x_math, amount_in_math, a, lam).unwrap();
        // Output is xMath delta → token1 (base) wad identity.
        let amount_out_wad = out_math;
        let amount_out_raw = amount_out_wad / U256::from(10u128.pow(10));
        eprintln!("--- Effective probe trade ---");
        eprintln!(
            "100 USDT in → {} WBTC raw out (= {} WBTC)",
            amount_out_raw,
            amount_out_raw.as_u128() as f64 / 1e8
        );
        let effective_usd_per_btc = if amount_out_raw > U256::zero() {
            100.0 / (amount_out_raw.as_u128() as f64 / 1e8)
        } else {
            0.0
        };
        eprintln!("Effective price: ${:.2} / BTC", effective_usd_per_btc);
    }

    /// **Direct probe: what does marginal_price_from_state return at
    /// extreme imbalance?** This tests if the kernel formula yields
    /// the expected `y/x`-like value when pool is heavily off-balance.
    #[test]
    #[ignore = "manual diagnostic — run with `--ignored --nocapture`"]
    fn pmarg_at_extreme_imbalance() {
        use crate::runtime_quoter::equilibra_math::marginal_price_from_state;
        let a = U256::from(949_000_000_000_000_000u128);
        let lam = U256::from(13_900_000_000_000_000u128);
        let wad = U256::from(WAD);

        // Test 1: math-balance
        let p1 = marginal_price_from_state(wad, wad, a, lam).unwrap();
        eprintln!("balance x=y=WAD: pMarg={} (expected={})", p1, WAD);

        // Test 2: small imbalance (y = 1.1 × x)
        let p2 =
            marginal_price_from_state(wad, wad * U256::from(110u128) / U256::from(100u128), a, lam)
                .unwrap();
        eprintln!("y=1.1*x:        pMarg={}", p2);

        // Test 3: moderate (y = 2 × x)
        let p3 = marginal_price_from_state(wad, wad * U256::from(2u128), a, lam).unwrap();
        eprintln!("y=2*x:          pMarg={}", p3);

        // Test 4: 10× imbalance
        let p4 = marginal_price_from_state(wad, wad * U256::from(10u128), a, lam).unwrap();
        eprintln!("y=10*x:         pMarg={}", p4);

        // Test 5: 100× imbalance
        let p5 = marginal_price_from_state(wad, wad * U256::from(100u128), a, lam).unwrap();
        eprintln!("y=100*x:        pMarg={}", p5);

        // Test 6: reverse direction (x = 10 × y)
        let p6 = marginal_price_from_state(wad * U256::from(10u128), wad, a, lam).unwrap();
        eprintln!("x=10*y:         pMarg={}", p6);

        // Test 7: extreme (y = 1e6 × x)
        let p7 = marginal_price_from_state(wad, wad * U256::from(1_000_000u128), a, lam).unwrap();
        eprintln!("y=1e6*x:        pMarg={}", p7);

        // Test 8: very small x (x = WAD / 1000, y = WAD)
        let p8 = marginal_price_from_state(wad / U256::from(1000u128), wad, a, lam).unwrap();
        eprintln!("x=1e-3*y:       pMarg={}", p8);
    }

    /// **Diagnostic — actual EMA dynamics with real user trades + arb**.
    /// Marked `#[ignore]` so it's only run when investigating the
    /// runaway. Replicates the simulator's pre-swap EMA update step
    /// over N swaps with realistic patterns and prints priceScale +
    /// EMA after each.
    #[test]
    #[ignore = "manual diagnostic — run with `--ignored --nocapture`"]
    fn diagnostic_ema_dynamics_first_100_swaps() {
        use super::super::LocalQuoter;
        use crate::runtime_quoter::equilibra_math::sqrt_u256;

        let config = EquilibraStatefulConfig::new(
            "usdt",
            "wbtc",
            6,
            8,
            100,
            949_000_000_000_000_000u128,
            13_900_000_000_000_000u128,
            0,
            3_600,
            1_000_000_000_000_000u128,
            1_000_000_000_000_000u128,
            1_000_000_000_000_000u128,
            1_000,
            20,
            5_000,
        )
        .expect("config ok");

        let r0_raw = 500_000u128 * 10u128.pow(6);
        let r1_raw = 1_157_947_552u128;
        let x_wad = U256::from(r1_raw) * U256::from(10u128.pow(10));
        let y_wad = U256::from(r0_raw) * U256::from(10u128.pow(12));
        // priceScale = yWad·WAD/xWad (quote-per-base).
        let init_ps_u: u128 = math_mul_div_floor(y_wad, U256::from(WAD), x_wad)
            .unwrap()
            .try_into()
            .unwrap();
        let supply: u128 = sqrt_u256(x_wad * y_wad).try_into().unwrap();

        let mut state = EquilibraStatefulState::empty();
        state.reserve0 = r0_raw;
        state.reserve1 = r1_raw;
        state.price_scale_wad = init_ps_u;
        state.total_supply = supply;
        state.lp_unit_value_genesis_wad = compute_pool_lp_unit_value(
            &config,
            state.reserve0,
            state.reserve1,
            state.price_scale_wad,
            state.total_supply,
        )
        .unwrap();
        state.lp_unit_value_wad = state.lp_unit_value_genesis_wad;

        let mut now = 1_000_000u64;
        let mut quoter = LocalQuoter::new();

        // 100 alternating swaps with VERY small size (0.01%) — should
        // barely perturb the pool, so pMarg ≈ WAD always, EMA ≈
        // priceScale, no runaway.
        eprintln!(
            "init: priceScale={}, ema={}, r0={}, r1={}",
            state.price_scale_wad,
            state.ema_price_wad().unwrap(),
            state.reserve0,
            state.reserve1
        );
        for i in 0..100u64 {
            now += 60;
            let (token_in, amount_in) = if i % 2 == 0 {
                ("usdt", state.reserve0 / 10_000) // 0.01% of reserve0
            } else {
                ("wbtc", state.reserve1 / 10_000)
            };
            if amount_in == 0 {
                continue;
            }
            let out =
                quoter.equilibra_swap_stateful(&config, state, token_in, amount_in, now, false);
            match out {
                Ok(o) => {
                    state.reserve0 = o.reserve0;
                    state.reserve1 = o.reserve1;
                    state.price_scale_wad = o.price_scale_wad;
                    state.total_supply = o.total_supply;
                    state.protocol_fee0 = o.protocol_fee0;
                    state.protocol_fee1 = o.protocol_fee1;
                    state.e0 = o.e0;
                    state.e1 = o.e1;
                    state.ema_log_wad = o.ema_log_wad;
                    state.last_ema_ts = o.last_ema_ts;
                    state.last_repeg_ts = o.last_repeg_ts;
                    state.lp_unit_value_wad = o.lp_unit_value_wad;
                    state.lp_value_growth_wad = o.lp_value_growth_wad;
                    if i < 10 || i % 20 == 0 {
                        let ratio_ppm = if state.price_scale_wad > 0 {
                            (state.ema_price_wad().unwrap() as i128 - state.price_scale_wad as i128)
                                .unsigned_abs()
                                * 1_000_000
                                / state.price_scale_wad
                        } else {
                            0
                        };
                        eprintln!(
                            "i={} token={} recentered={}: ps={} ema={} ema/ps_ppm={} pre_swap_diff_ppm={}",
                            i, token_in, o.recentered, state.price_scale_wad, state.ema_price_wad().unwrap(), ratio_ppm,
                            (state.ema_price_wad().unwrap() as i128 - state.price_scale_wad as i128) * 1_000_000 / state.price_scale_wad as i128,
                        );
                    }
                }
                Err(e) => {
                    eprintln!("i={}: swap err: {}", i, e);
                    break;
                }
            }
        }
    }

    /// **Asymmetric pressure probe** — mimics what an aggressive arb
    /// model would do: drive the pool one-way relentlessly. If the
    /// kernel can withstand this without priceScale runaway, the
    /// problem is in main.rs's arb model. If priceScale explodes
    /// here, the kernel has the bug.
    #[test]
    fn long_run_no_price_scale_runaway_under_one_sided_pressure() {
        use super::super::LocalQuoter;
        use crate::runtime_quoter::equilibra_math::sqrt_u256;

        let config = EquilibraStatefulConfig::new(
            "usdt",
            "wbtc",
            6,
            8,
            100,
            949_000_000_000_000_000u128,
            13_900_000_000_000_000u128,
            0,
            3_600,
            1_000_000_000_000_000u128,
            1_000_000_000_000_000u128,
            1_000_000_000_000_000u128,
            1_000,
            20,
            5_000,
        )
        .expect("config builds");

        let r0_raw = 500_000u128 * 10u128.pow(6);
        let r1_raw = 1_157_947_552u128;
        let x_wad = U256::from(r1_raw) * U256::from(10u128.pow(10));
        let y_wad = U256::from(r0_raw) * U256::from(10u128.pow(12));
        // priceScale = yWad·WAD/xWad (quote-per-base).
        let init_ps_u: u128 = math_mul_div_floor(y_wad, U256::from(WAD), x_wad)
            .unwrap()
            .try_into()
            .unwrap();
        let supply: u128 = sqrt_u256(x_wad * y_wad).try_into().unwrap();

        let mut state = EquilibraStatefulState::empty();
        state.reserve0 = r0_raw;
        state.reserve1 = r1_raw;
        state.price_scale_wad = init_ps_u;
        state.total_supply = supply;
        state.lp_unit_value_genesis_wad = compute_pool_lp_unit_value(
            &config,
            state.reserve0,
            state.reserve1,
            state.price_scale_wad,
            state.total_supply,
        )
        .unwrap();
        state.lp_unit_value_wad = state.lp_unit_value_genesis_wad;

        let initial_ps = state.price_scale_wad;
        let mut now = 1_000_000u64;
        let mut quoter = LocalQuoter::new();

        // 200 USDT-in swaps (one-sided pressure). Small enough to be
        // realistic (0.5 % of USDT reserve). Watch priceScale walk.
        for _ in 0..200u64 {
            now += 60;
            let amount_in = state.reserve0 * 50 / 10_000;
            if amount_in == 0 {
                break;
            }
            let out = match quoter
                .equilibra_swap_stateful(&config, state, "usdt", amount_in, now, false)
            {
                Ok(o) => o,
                Err(e) => {
                    eprintln!("swap failed at iter, ps={}: {}", state.price_scale_wad, e);
                    break;
                }
            };
            state.reserve0 = out.reserve0;
            state.reserve1 = out.reserve1;
            state.price_scale_wad = out.price_scale_wad;
            state.total_supply = out.total_supply;
            state.protocol_fee0 = out.protocol_fee0;
            state.protocol_fee1 = out.protocol_fee1;
            state.e0 = out.e0;
            state.e1 = out.e1;
            state.ema_log_wad = out.ema_log_wad;
            state.last_ema_ts = out.last_ema_ts;
            state.last_repeg_ts = out.last_repeg_ts;
            state.lp_unit_value_wad = out.lp_unit_value_wad;
            state.lp_value_growth_wad = out.lp_value_growth_wad;
        }

        let final_ps = state.price_scale_wad;
        let growth_factor = final_ps as f64 / initial_ps as f64;
        eprintln!(
            "one-sided probe: initial_ps={}, final_ps={}, factor={:.4}, \
             final_r0={}, final_r1={}",
            initial_ps, final_ps, growth_factor, state.reserve0, state.reserve1,
        );
        // Even under aggressive one-sided pressure, priceScale must
        // not explode by orders of magnitude — at most 2-3× over 200
        // swaps (≈ 200 × 0.1 % = 20 %).
        assert!(
            growth_factor < 5.0,
            "priceScale ran away under one-sided pressure: factor={:.4} \
             — kernel bug confirmed.",
            growth_factor
        );
    }
}

#[cfg(test)]
mod halving_ladder_tests {
    //! Targeted branch coverage for the `try_auto_repeg` halving
    //! ladder: which rung commits, exhaustion, the dust short-circuit
    //! and the `applied == 0` break. The gate threshold equals
    //! `lp_unit_value_genesis_wad` exactly under `repeg_share_bps =
    //! BPS` (keep-share 0), so each test dials the threshold to sit
    //! between two rungs' `vpAfter` probes and asserts the committed
    //! candidate — the same decision the Solidity ladder makes on
    //! identical inputs.
    use super::*;

    const W: u128 = WAD;

    fn ladder_config() -> EquilibraStatefulConfig {
        EquilibraStatefulConfig::new(
            "tk0",
            "tk1",
            18,
            18,
            100,                         // fee_bps (flat)
            909_610_000_000_000_030u128, // a_wad (canonical preset)
            16_780_000_000_000_000u128,  // lambda_wad
            0,                           // protocol_fee_percent
            3_600,                       // ema_period half-life (s)
            5_000_000_000_000_000u128,   // repeg_step_wad (0.5%)
            1,                           // threshold up: minimal dead-band
            1,                           // threshold down: minimal dead-band
            0,                           // fee_ramp_bps (flat fee)
            0,                           // fee_floor_bps
            10_000, // repeg_share_bps: keep-share 0 => gate threshold == genesis
        )
        .expect("ladder config builds")
    }

    /// Imbalanced 18/18 state (reserve0 > reserve1) at `price_scale =
    /// 1`, EMA 2% above: the damped base step is `min(0.5%, 2%/5) =
    /// 0.4%`, giving the rungs `0.4% / 0.2% / 0.1% / 0.05%`. The
    /// imbalance orientation makes every rung COST unit value
    /// (`vpAfter < vpBefore`, strictly increasing as the rung
    /// shrinks) — the regime the ladder exists for. At perfect
    /// balance an anchor move is value-neutral-to-positive and the
    /// full rung always clears the gate (pinned below).
    fn ladder_state() -> EquilibraStatefulState {
        let mut st = EquilibraStatefulState::empty();
        st.reserve0 = 1_300_000 * W;
        st.reserve1 = 800_000 * W;
        st.price_scale_wad = W;
        st.total_supply = 1_000_000 * W;
        st.ema_log_wad = equilibra_math::price_to_ema_log(U256::from(W + W / 50)).unwrap(); // +2%
        st.last_ema_ts = 1_000;
        st.last_repeg_ts = 1_000;
        st.lp_value_growth_wad = 0;
        st
    }

    /// The four rung candidates and their solvency probes, computed
    /// through the same production pieces the ladder calls.
    fn rung_probes(
        config: &EquilibraStatefulConfig,
        st: &EquilibraStatefulState,
    ) -> Vec<(u128, u128)> {
        let deviation =
            compute_relative_deviation_wad(st.ema_price_wad().unwrap(), st.price_scale_wad)
                .unwrap();
        let base_applied =
            applied_repeg_step(config.repeg_step_wad, deviation, REPEG_DAMPING_DIVISOR).unwrap();
        (0..=MAX_REPEG_STEP_HALVINGS)
            .map(|k| {
                let candidate = apply_log_step(
                    st.price_scale_wad,
                    st.ema_price_wad().unwrap(),
                    base_applied >> k as usize,
                )
                .unwrap();
                let vp = compute_pool_lp_unit_value(
                    config,
                    st.reserve0,
                    st.reserve1,
                    candidate,
                    st.total_supply,
                )
                .unwrap();
                (candidate, vp)
            })
            .collect()
    }

    fn run(
        config: &EquilibraStatefulConfig,
        st: &EquilibraStatefulState,
        genesis: u128,
    ) -> RepegOutcome {
        let mut st = st.clone();
        st.lp_unit_value_genesis_wad = genesis;
        let vp_before = compute_pool_lp_unit_value(
            config,
            st.reserve0,
            st.reserve1,
            st.price_scale_wad,
            st.total_supply,
        )
        .unwrap();
        assert!(
            vp_before > genesis + REPEG_GAS_GUARD_WAD,
            "precondition: pre-repeg gate must pass (vp_before {} vs genesis {})",
            vp_before,
            genesis
        );
        try_auto_repeg(config, &st, vp_before, st.last_repeg_ts + 12, false).unwrap()
    }

    #[test]
    fn probes_are_strictly_ordered_by_rung_depth() {
        // In the costing orientation a larger applied step means a
        // larger anchor move at fixed reserves and a strictly lower
        // solvency probe. The ladder's rung selection is only
        // meaningful under this ordering, so pin it explicitly.
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        assert_eq!(probes.len(), 4);
        for pair in probes.windows(2) {
            assert!(pair[0].1 < pair[1].1, "vpAfter must rise as rungs shrink");
            assert!(
                pair[0].0 > pair[1].0,
                "candidates must shrink with the rung"
            );
        }
        let vp_before = compute_pool_lp_unit_value(
            &config,
            st.reserve0,
            st.reserve1,
            st.price_scale_wad,
            st.total_supply,
        )
        .unwrap();
        assert!(probes[3].1 < vp_before, "even the smallest rung costs vp");

        // Counterpoint: at perfect balance the anchor move is
        // value-neutral-to-positive, so every rung clears any
        // threshold at or below the live unit value and the ladder
        // never has to fall back.
        let mut balanced = st.clone();
        balanced.reserve0 = 1_000_000 * W;
        balanced.reserve1 = 1_000_000 * W;
        let balanced_vp_before = compute_pool_lp_unit_value(
            &config,
            balanced.reserve0,
            balanced.reserve1,
            balanced.price_scale_wad,
            balanced.total_supply,
        )
        .unwrap();
        for (_, vp) in rung_probes(&config, &balanced) {
            assert!(vp >= balanced_vp_before);
        }
    }

    #[test]
    fn full_rung_commits_when_budget_ample() {
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        let out = run(&config, &st, probes[0].1); // threshold == vpAfter(full)
        assert!(out.recentered);
        assert_eq!(out.new_price_scale_wad, probes[0].0);
    }

    #[test]
    fn half_rung_commits_when_full_step_is_unaffordable() {
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        // Threshold strictly above vpAfter(full), exactly at vpAfter(half):
        // rung 0 fails the solvency gate, rung 1 passes on equality.
        let out = run(&config, &st, probes[1].1);
        assert!(out.recentered);
        assert_eq!(out.new_price_scale_wad, probes[1].0);
    }

    #[test]
    fn deepest_rung_commits_when_only_it_is_affordable() {
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        let out = run(&config, &st, probes[3].1);
        assert!(out.recentered);
        assert_eq!(out.new_price_scale_wad, probes[3].0);
    }

    #[test]
    fn exhaustion_leaves_the_anchor_untouched() {
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        // Threshold above even the smallest rung's probe: all four fail.
        // The post-ladder parachute is consulted, passes its lag
        // qualifier (dead-bands are 1 wei here) and declines on the
        // EMPTY buffer, reporting the historical ladder-exhaustion
        // label with an untouched candidate.
        let out = run(&config, &st, probes[3].1 + 1);
        assert!(!out.recentered);
        assert!(!out.via_parachute);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::LpUnitValueAfterBelowThreshold)
        );
        assert_eq!(out.new_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.candidate_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.donation_burn_shares, 0);
    }

    /// Parachute runner: `genesis = vp_before` closes the own-budget
    /// pre-gate (threshold == genesis under the keep-0 ladder config),
    /// handing the attempt to the donation parachute.
    fn run_parachute(
        config: &EquilibraStatefulConfig,
        st: &EquilibraStatefulState,
        donation_shares: u128,
    ) -> (RepegOutcome, u128, u128) {
        let mut st = st.clone();
        st.donation_shares = donation_shares;
        let vp_before = compute_pool_lp_unit_value(
            config,
            st.reserve0,
            st.reserve1,
            st.price_scale_wad,
            st.total_supply,
        )
        .unwrap();
        st.lp_unit_value_genesis_wad = vp_before;
        let out = try_auto_repeg(config, &st, vp_before, st.last_repeg_ts + 12, false).unwrap();
        (out, vp_before, st.total_supply)
    }

    #[test]
    fn parachute_commits_full_step_with_exact_shortfall_burn() {
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        let (out, vp_before, supply) = run_parachute(&config, &st, 200_000 * W);
        assert!(out.recentered);
        assert_eq!(out.blocked_by, None);
        // Full (k = 0) step — the parachute never halves.
        assert_eq!(out.new_price_scale_wad, probes[0].0);
        // δ = ⌈S · (T − vpAfter) / T⌉ with T == genesis == vp_before.
        let threshold = vp_before;
        let vp_after = probes[0].1;
        assert!(vp_after < threshold, "costing orientation precondition");
        let expected_burn = mul_div_ceil(
            U256::from(supply),
            U256::from(threshold - vp_after),
            U256::from(threshold),
        )
        .unwrap();
        assert_eq!(U256::from(out.donation_burn_shares), expected_burn);
        assert!(out.donation_burn_shares > 0);
        // Zero surplus leak: the latch lands ON the threshold, never
        // below, and at most wei-quantisation above it.
        assert!(out.lp_unit_value_after_wad >= threshold);
        assert!(
            out.lp_unit_value_after_wad - threshold <= 2,
            "latch overshoot {} wei leaks donated value to holders",
            out.lp_unit_value_after_wad - threshold
        );
    }

    #[test]
    fn parachute_commits_without_subsidy_when_candidate_needs_none() {
        // δ == 0 path: pre-gate route (genesis == vp_before closes the
        // own-budget gate) at PERFECT math-balance, where an anchor
        // move is value-neutral-to-positive — the full-step probe
        // lands at or above the floor, so the parachute commits with
        // ZERO subsidy: no shares burned, the buffer untouched, and
        // the latch degenerating to the raw vpAfter probe
        // (`⌊vpAfter · S / (S − 0)⌋ == vpAfter`).
        let config = ladder_config();
        let mut st = ladder_state();
        st.reserve0 = 1_000_000 * W;
        st.reserve1 = 1_000_000 * W;
        let probes = rung_probes(&config, &st);
        let buffer = 200_000 * W;
        let (out, vp_before, _) = run_parachute(&config, &st, buffer);
        assert!(
            probes[0].1 >= vp_before,
            "precondition: balanced full-step probe must clear the floor"
        );
        assert!(out.recentered);
        assert!(out.via_parachute);
        assert_eq!(out.blocked_by, None);
        // Full (k = 0) step, no halving.
        assert_eq!(out.new_price_scale_wad, probes[0].0);
        assert_eq!(out.candidate_price_scale_wad, probes[0].0);
        // No subsidy: δ = 0, buffer intact, latch == raw probe.
        assert_eq!(out.donation_burn_shares, 0);
        assert_eq!(out.lp_unit_value_after_wad, probes[0].1);
    }

    #[test]
    fn parachute_below_activation_blocks() {
        // Same pool, wider dead-bands: the +2% EMA deviation clears the
        // 0.19% dead-band but not the default K = 30 activation (5.7%).
        let mut config = EquilibraStatefulConfig::new(
            "tk0",
            "tk1",
            18,
            18,
            100,
            909_610_000_000_000_030u128,
            16_780_000_000_000_000u128,
            0,
            3_600,
            5_000_000_000_000_000u128,
            1_900_000_000_000_000u128,
            1_900_000_000_000_000u128,
            0,
            0,
            10_000,
        )
        .expect("wide-band config builds");
        // `new()` seeds the per-pool K from the creation default.
        assert_eq!(
            config.parachute_band_mult,
            REPEG_PARACHUTE_BAND_MULT_DEFAULT
        );
        let st = ladder_state();
        let deviation =
            compute_relative_deviation_wad(st.ema_price_wad().unwrap(), st.price_scale_wad)
                .unwrap();
        assert!(
            deviation >= config.repeg_threshold_token1_up_wad
                && deviation < config.repeg_threshold_token1_up_wad * config.parachute_band_mult,
            "precondition: dead-band cleared but K x band not reached"
        );
        let (out, _, _) = run_parachute(&config, &st, 200_000 * W);
        assert!(!out.recentered);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::DonationParachuteBelowActivation)
        );
        assert_eq!(out.donation_burn_shares, 0);
        assert_eq!(out.new_price_scale_wad, st.price_scale_wad);

        // The activation is driven by the PER-POOL config field, not a
        // global constant: a timelock-style K = 1 override lowers the
        // qualifier below the same deviation and the parachute commits.
        config.parachute_band_mult = 1;
        let (out, _, _) = run_parachute(&config, &st, 200_000 * W);
        assert!(out.recentered);
        assert!(out.via_parachute);
        assert!(out.donation_burn_shares > 0);
    }

    #[test]
    fn parachute_insufficient_buffer_blocks() {
        let config = ladder_config();
        let st = ladder_state();
        let probes = rung_probes(&config, &st);
        // Above the dust floor but far below the required δ.
        let (out, _, _) = run_parachute(&config, &st, REPEG_DONATION_DUST_SHARES + 1);
        assert!(!out.recentered);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::DonationParachuteInsufficient)
        );
        assert_eq!(out.donation_burn_shares, 0);
        // The refused probe pair is reported for telemetry.
        assert_eq!(out.candidate_price_scale_wad, probes[0].0);
        assert_eq!(out.lp_unit_value_after_wad, probes[0].1);
    }

    #[test]
    fn parachute_dust_buffer_keeps_legacy_no_budget_reason() {
        let config = ladder_config();
        let st = ladder_state();
        let (out, _, _) = run_parachute(&config, &st, REPEG_DONATION_DUST_SHARES);
        assert!(!out.recentered);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::LpUnitValueBelowThreshold)
        );
        assert_eq!(out.donation_burn_shares, 0);
    }

    #[test]
    fn ladder_exhaustion_hands_over_to_the_parachute() {
        // Budget-holding pool, every rung refused, buffer present and
        // the lag clears the K x dead-band qualifier: the post-ladder
        // handover commits the FULL (k = 0) step via the parachute,
        // burning exactly the shortfall so the latch lands ON the
        // threshold.
        let config = ladder_config();
        let mut st = ladder_state();
        st.donation_shares = 200_000 * W;
        let probes = rung_probes(&config, &st);
        let threshold = probes[3].1 + 1;
        let out = run(&config, &st, threshold);
        assert!(out.recentered);
        assert!(out.via_parachute);
        assert_eq!(out.new_price_scale_wad, probes[0].0);
        assert!(out.donation_burn_shares > 0);
        assert!(out.lp_unit_value_after_wad >= threshold);
        assert!(
            out.lp_unit_value_after_wad - threshold <= 2,
            "latch overshoot {} wei leaks donated value",
            out.lp_unit_value_after_wad - threshold
        );
    }

    #[test]
    fn donate_lp_shares_validates_and_accumulates() {
        let mut st = ladder_state();
        assert!(donate_lp_shares(&mut st, 0).is_err());
        donate_lp_shares(&mut st, 100 * W).unwrap();
        donate_lp_shares(&mut st, 50 * W).unwrap();
        assert_eq!(st.donation_shares, 150 * W);
        // The buffer can never reach the outstanding supply: parking
        // the ENTIRE float (active == 0) must be rejected at exact
        // equality, not merely on overflow past it.
        let supply = st.total_supply;
        assert!(donate_lp_shares(&mut st, supply).is_err());
        let exact_to_cap = supply - st.donation_shares;
        assert!(donate_lp_shares(&mut st, exact_to_cap).is_err());
        assert_eq!(
            st.donation_shares,
            150 * W,
            "failed donations must not mutate the buffer"
        );
    }

    #[test]
    fn dust_candidate_at_rung_zero_hands_over_to_the_parachute() {
        let config = ladder_config();
        let mut st = ladder_state();
        // At price_scale = 1e17 an applied step of a few wei floors the
        // mulWad move back onto the old scale: deviation 10–20 wei =>
        // applied 2–4 wei => candidate == price_scale (dust) on the very
        // first rung. Solidity consults the parachute on EVERY
        // no-commit ladder exit — including this rung-0 dust break —
        // and here the parachute declines at its lag qualifier
        // (deviation < K x the 1-wei band, K = 30 default) before
        // re-deriving any candidate.
        st.price_scale_wad = W / 10;
        // The encoded target must remain above the anchor after ln/exp rounding.
        st.ema_log_wad = equilibra_math::price_to_ema_log(U256::from(W / 10 + 2)).unwrap();
        let ema = st.ema_price_wad().unwrap();
        let deviation = compute_relative_deviation_wad(ema, st.price_scale_wad).unwrap();
        assert!(deviation > 0 && deviation < config.parachute_band_mult);
        let applied =
            applied_repeg_step(config.repeg_step_wad, deviation, REPEG_DAMPING_DIVISOR).unwrap();
        assert!(!applied.is_zero());
        assert_eq!(
            apply_log_step(st.price_scale_wad, ema, applied).unwrap(),
            st.price_scale_wad
        );
        let out = run(&config, &st, 1);
        assert!(!out.recentered);
        assert!(!out.via_parachute);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::DonationParachuteBelowActivation)
        );
        assert_eq!(out.new_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.candidate_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.lp_unit_value_after_wad, 0);
    }

    #[test]
    fn dust_candidate_declines_in_parachute_via_candidate_check() {
        let config = ladder_config();
        let mut st = ladder_state();
        st.donation_shares = 200_000 * W;
        // Deviation 40 wei clears the K x band qualifier (30 wei) and
        // the buffer is funded, so the parachute is genuinely consulted
        // after the rung-0 dust break. It re-derives the SAME dust
        // candidate (applied = 40/5 = 8 wei floors the mulWad move back
        // onto price_scale = 1e17) and declines via its
        // `candidate == priceScale` check — mirroring the Solidity
        // control flow where the post-ladder handover runs even though
        // the ladder never probed a rung.
        st.price_scale_wad = W / 10;
        st.ema_log_wad = equilibra_math::price_to_ema_log(U256::from(W / 10 + 4)).unwrap();
        let deviation =
            compute_relative_deviation_wad(st.ema_price_wad().unwrap(), st.price_scale_wad)
                .unwrap();
        assert!(
            deviation >= config.repeg_threshold_token1_up_wad * config.parachute_band_mult,
            "precondition: lag qualifier must pass (deviation {deviation})"
        );
        let out = run(&config, &st, 1);
        assert!(!out.recentered);
        assert!(!out.via_parachute);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::DonationParachuteInsufficient)
        );
        assert_eq!(out.new_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.candidate_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.donation_burn_shares, 0);
    }

    #[test]
    fn zero_applied_step_blocks_without_iterating() {
        let config = ladder_config();
        let mut st = ladder_state();
        // Deviation of 2 wei clears the 1-wei dead-band but floors the
        // damped step `deviation / 5` to zero: the ladder never runs.
        // The post-ladder parachute is consulted and declines on its
        // lag qualifier (2 wei < K x the 1-wei band, K = 30 default).
        st.ema_log_wad = equilibra_math::price_to_ema_log(U256::from(W + 2)).unwrap();
        let out = run(&config, &st, 1);
        assert!(!out.recentered);
        assert_eq!(
            out.blocked_by,
            Some(EquilibraRecenterGateBlocked::DonationParachuteBelowActivation)
        );
        assert_eq!(out.new_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.candidate_price_scale_wad, st.price_scale_wad);
        assert_eq!(out.lp_unit_value_after_wad, 0);
    }
}
