use anyhow::{anyhow, Result};
use num_bigint::{BigInt, BigUint};
use num_traits::{Signed, ToPrimitive, Zero};
use primitive_types::U256;
use std::sync::OnceLock;

const WAD: u128 = 1_000_000_000_000_000_000u128;
const N_COINS: u128 = 2u128;
const A_MULTIPLIER: u128 = 10_000u128;
const CURVE_NOISE_FEE: u128 = 100_000u128;
const CURVE_FEE_PRECISION: u128 = 10_000_000_000u128;
const CURVE_MIN_FEE: u128 = 100_000u128;
const CURVE_MAX_FEE: u128 = 10_000_000_000u128;
const CURVE_MINIMUM_LIQUIDITY: u128 = 10_000u128;
const CURVE_MIN_GAMMA: u128 = 10_000_000_000u128; // 1e10
const CURVE_MAX_GAMMA_SMALL: u128 = 20_000_000_000_000_000u128; // 2e16
const CURVE_MAX_GAMMA: u128 = 199_000_000_000_000_000u128; // 199e15
const CURVE_MIN_A: u128 = 4_000u128; // N^N * A_MULTIPLIER / 10 for N=2
const CURVE_MAX_A: u128 = 40_000_000u128; // N^N * A_MULTIPLIER * 1000 for N=2
const FEE_DENOMINATOR: u128 = 10_000_000_000u128; // 10^10
/// Linear release window for donation shares (7 days), mirroring the
/// donations-enabled reference pool init.
pub const CURVE_DONATION_DURATION_SEC: u64 = 7 * 86_400;
/// Decay window of the sandwich-protection factor applied to unlocked
/// donation shares after a regular liquidity add.
const CURVE_DONATION_PROTECTION_PERIOD_SEC: u64 = 600;
/// Relative LP add (WAD) that extends the protection window by one full
/// period.
const CURVE_DONATION_PROTECTION_LP_THRESHOLD: u128 = WAD / 5; // 20%
/// Cap on total donation shares as a fraction (WAD) of total supply.
const CURVE_DONATION_SHARES_MAX_RATIO: u128 = WAD / 10; // 10%

fn bi_const(
    dec: &'static [u8],
    name: &'static str,
    slot: &'static OnceLock<BigInt>,
) -> &'static BigInt {
    slot.get_or_init(|| {
        BigInt::parse_bytes(dec, 10).unwrap_or_else(|| panic!("invalid BigInt constant: {name}"))
    })
}

fn wad_exp_min_input() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    SLOT.get_or_init(|| BigInt::from(-41_446_531_673_892_822_313i128))
}

fn wad_exp_max_input() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    SLOT.get_or_init(|| BigInt::from(135_305_999_368_893_231_589i128))
}

fn wad_exp_five_pow_18() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    SLOT.get_or_init(|| BigInt::from(5u32).pow(18))
}

fn wad_exp_log2_e_2_96() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(
        b"54916777467707473351141471128",
        "WAD_EXP_LOG2_E_2_96",
        &SLOT,
    )
}

fn wad_exp_c0() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"1346386616545796478920950773328", "WAD_EXP_C0", &SLOT)
}

fn wad_exp_c1() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"57155421227552351082224309758442", "WAD_EXP_C1", &SLOT)
}

fn wad_exp_c2() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"94201549194550492254356042504812", "WAD_EXP_C2", &SLOT)
}

fn wad_exp_c3() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"28719021644029726153956944680412240", "WAD_EXP_C3", &SLOT)
}

fn wad_exp_c4() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"4385272521454847904659076985693276", "WAD_EXP_C4", &SLOT)
}

fn wad_exp_c5() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"2855989394907223263936484059900", "WAD_EXP_C5", &SLOT)
}

fn wad_exp_c6() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"50020603652535783019961831881945", "WAD_EXP_C6", &SLOT)
}

fn wad_exp_c7() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"533845033583426703283633433725380", "WAD_EXP_C7", &SLOT)
}

fn wad_exp_c8() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"3604857256930695427073651918091429", "WAD_EXP_C8", &SLOT)
}

fn wad_exp_c9() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"14423608567350463180887372962807573", "WAD_EXP_C9", &SLOT)
}

fn wad_exp_c10() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(b"26449188498355588339934803723976023", "WAD_EXP_C10", &SLOT)
}

fn wad_exp_scale_factor() -> &'static BigInt {
    static SLOT: OnceLock<BigInt> = OnceLock::new();
    bi_const(
        b"3822833074963236453042738258902158003155416615667",
        "WAD_EXP_SCALE_FACTOR",
        &SLOT,
    )
}

/// Gate that stopped the rebalance branch of `tweak_price_by_mode` from
/// committing a `price_scale` move on this operation. Mirrors the gate
/// structure of the live reference twocrypto pool: trigger condition,
/// once-per-timestamp guard, dust dead-band, rounding hold and the
/// LP-floor commit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CurveRebalanceGateBlocked {
    /// Rebalancing is disabled for this run (`--disable-curve-rebalance`).
    RebalanceDisabled,
    /// Trigger gate: `virtual_price <= lp_xcp_profit` — the pool sits at
    /// (or below) the LP-protected profit floor, so there is no spendable
    /// budget for a move.
    VpAtOrBelowLpFloor,
    /// The EMA timestamp already advanced this second
    /// (`last_ts >= timestamp`); at most one rebalance per timestamp.
    SameTimestampOncePerBlock,
    /// `min(norm / 5, adjustment_step_max) <= adjustment_step_min` — the
    /// damped candidate move is inside the dust dead-band.
    StepBelowDustMin,
    /// The damped candidate rounds back to the current `price_scale`.
    PriceScaleUnchanged,
    /// Commit gate: vp recomputed at the candidate scale lands at or below
    /// `1e18`, or below `lp_xcp_profit` — the move would cost more than
    /// the profit cushion above the LP-protected floor.
    CommitVpBelowLpFloor,
}

impl CurveRebalanceGateBlocked {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RebalanceDisabled => "rebalance_disabled",
            Self::VpAtOrBelowLpFloor => "vp_at_or_below_lp_floor",
            Self::SameTimestampOncePerBlock => "same_timestamp_once_per_block",
            Self::StepBelowDustMin => "step_below_dust_min",
            Self::PriceScaleUnchanged => "price_scale_unchanged",
            Self::CommitVpBelowLpFloor => "commit_vp_below_lp_floor",
        }
    }

    pub const fn all() -> [Self; 6] {
        [
            Self::RebalanceDisabled,
            Self::VpAtOrBelowLpFloor,
            Self::SameTimestampOncePerBlock,
            Self::StepBelowDustMin,
            Self::PriceScaleUnchanged,
            Self::CommitVpBelowLpFloor,
        ]
    }
}

/// Outcome of the rebalance branch of one `tweak_price_by_mode` call:
/// either a committed `price_scale` move or the first gate that blocked it.
#[derive(Debug, Clone, Copy)]
pub struct CurveRebalanceOutcome {
    pub rebalanced: bool,
    pub blocked_by: Option<CurveRebalanceGateBlocked>,
    /// Donation shares burned to lift the post-move vp back to
    /// `max(lp_xcp_profit, vp)` when the rebalance committed.
    pub donation_shares_burned: u128,
}

/// Donation-share bookkeeping of the pool. Donation shares are minted to
/// the pool itself (they sit inside `total_supply` but belong to no LP),
/// unlock linearly over `CURVE_DONATION_DURATION_SEC`, and the unlocked
/// part is burned by the rebalance path to pay for `price_scale` moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CurveDonationState {
    /// Total donation shares (locked + unlocked) currently held by the pool.
    pub shares: u128,
    /// Virtual start of the current linear release window: donations and
    /// burns shift it so one imaginary donation of the current size would
    /// have exactly the observed unlocked amount now.
    pub last_release_ts: u64,
    /// Sandwich-protection expiry: unlocked shares are damped toward zero
    /// while `now < expiry` (regular liquidity adds extend it).
    pub protection_expiry_ts: u64,
    /// Sub-threshold extension carry of the protection accumulator.
    pub protection_extension_remainder: u128,
}

#[derive(Debug, Clone, Copy)]
pub struct CurveExchangeStatefulOut {
    pub amount_out: u128,
    pub reserve0: u128,
    pub reserve1: u128,
    pub curve_d: u128,
    pub curve_price_scale: u128,
    pub curve_price_oracle: u128,
    pub curve_last_prices: u128,
    pub curve_last_timestamp: u64,
    pub curve_virtual_price: u128,
    pub curve_xcp_profit: u128,
    pub curve_lp_xcp_profit: u128,
    pub curve_total_supply: u128,
    /// Fee that was actually charged on this swap, denominated in raw
    /// `token_out` units (Curve takes its fee on the output side, so the
    /// trader receives `dy_pre_fee - fee_amount_out`). Surfaced for
    /// per-swap reporting (`feePaidUsd` / `actualFeeBps`) so the metrics
    /// follow the dynamic `mid_fee → out_fee` ramp instead of always
    /// reporting the static `mid_fee`.
    pub fee_amount_out: u128,
    /// Effective fee rate (BPS) computed from `curve_fee`'s
    /// `FEE_DENOMINATOR = 1e10` value: `fee_bps = fee_rate_1e10 / 1e6`.
    pub fee_bps_effective: u64,
    /// Whether this exchange committed a `price_scale` rebalance.
    pub rebalanced: bool,
    /// First gate that blocked the rebalance when `rebalanced == false`.
    pub rebalance_blocked_by: Option<CurveRebalanceGateBlocked>,
    /// Exact donation shares burned by this exchange's rebalance commit
    /// (0 when no rebalance or no burn).
    pub donation_shares_burned: u128,
    /// Donation bookkeeping after this exchange (release / burn applied).
    pub curve_donation: CurveDonationState,
}

#[derive(Debug, Clone, Copy)]
pub struct CurveAddLiquidityStatefulOut {
    /// LP shares minted to the depositor; for the donation path these are
    /// the shares credited to the pool's donation buffer instead.
    pub minted_liquidity: u128,
    pub amount0_used: u128,
    pub amount1_used: u128,
    pub reserve0: u128,
    pub reserve1: u128,
    pub curve_d: u128,
    pub curve_price_scale: u128,
    pub curve_price_oracle: u128,
    pub curve_last_prices: u128,
    pub curve_last_timestamp: u64,
    pub curve_virtual_price: u128,
    pub curve_xcp_profit: u128,
    pub curve_lp_xcp_profit: u128,
    pub curve_total_supply: u128,
    /// Exact donation shares burned by this event's rebalance commit
    /// (0 when none). A donation add first credits `d_token` to the
    /// buffer and `tweak_price` may then burn older unlocked shares in
    /// the SAME event, so the buffer's net share change cannot recover
    /// this amount.
    pub donation_shares_burned: u128,
    /// Donation bookkeeping after this liquidity event.
    pub curve_donation: CurveDonationState,
}

#[derive(Debug, Clone, Copy)]
pub struct CurveRemoveLiquidityStatefulOut {
    pub amount0_out: u128,
    pub amount1_out: u128,
    pub reserve0: u128,
    pub reserve1: u128,
    pub curve_d: u128,
    pub curve_price_scale: u128,
    pub curve_price_oracle: u128,
    pub curve_last_prices: u128,
    pub curve_last_timestamp: u64,
    pub curve_virtual_price: u128,
    pub curve_xcp_profit: u128,
    pub curve_lp_xcp_profit: u128,
    pub curve_total_supply: u128,
    /// Donation bookkeeping (passed through unchanged: proportional remove
    /// does not touch donation shares).
    pub curve_donation: CurveDonationState,
}

#[derive(Debug, Clone, Copy)]
struct CurveState {
    price_scale: u128,
    price_oracle: u128,
    last_prices: u128,
    last_timestamp: u64,
    virtual_price: u128,
    xcp_profit: u128,
    lp_xcp_profit: u128,
    total_supply: u128,
    adjustment_step_min: u128,
    adjustment_step_max: u128,
    reserved_profit_fraction: u128,
    ma_time: u128,
    d: u128,
    donation: CurveDonationState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurveQuoteConfig {
    token0_lower: String,
    token1_lower: String,
    pub math_mode: String,
    pub a: u128,
    pub gamma: u128,
    pub mid_fee: u128,
    pub out_fee: u128,
    pub fee_gamma: u128,
    pub precisions: [u128; 2],
}

impl CurveQuoteConfig {
    pub fn new(
        token0: &str,
        token1: &str,
        math_mode: String,
        a: u128,
        gamma: u128,
        mid_fee: u128,
        out_fee: u128,
        fee_gamma: u128,
        precisions: [u128; 2],
    ) -> Self {
        Self {
            token0_lower: token0.to_lowercase(),
            token1_lower: token1.to_lowercase(),
            math_mode,
            a,
            gamma,
            mid_fee,
            out_fee,
            fee_gamma,
            precisions,
        }
    }

    #[inline]
    fn token_index(&self, token_in: &str) -> Result<usize> {
        if token_in.eq_ignore_ascii_case(&self.token0_lower) {
            Ok(0)
        } else if token_in.eq_ignore_ascii_case(&self.token1_lower) {
            Ok(1)
        } else {
            Err(anyhow!("tokenIn_not_in_pool"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveQuoteState {
    pub reserve0: u128,
    pub reserve1: u128,
    pub price_scale: u128,
    pub d: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurveStatefulConfig {
    pub quote: CurveQuoteConfig,
    pub adjustment_step_min: u128,
    pub adjustment_step_max: u128,
    /// LP-protected share of gross profit, FEE_PRECISION(=1e10) units.
    pub reserved_profit_fraction: u128,
    /// Internal EMA relaxation time tau in seconds. The constructor
    /// takes the human-facing half-life (on-chain `ma_time()` view
    /// semantics) and converts once; this field always holds tau.
    pub ma_time: u128,
}

impl CurveStatefulConfig {
    pub fn new(
        quote: CurveQuoteConfig,
        adjustment_step_min: u128,
        adjustment_step_max: u128,
        reserved_profit_fraction: u128,
        ma_time: u128,
    ) -> Self {
        Self {
            quote,
            adjustment_step_min,
            adjustment_step_max,
            reserved_profit_fraction,
            // `ma_time` arrives with the ON-CHAIN `ma_time()` view
            // semantics (EMA half-life in seconds = tau * ln2). Convert
            // once here to the internal relaxation time tau via the exact
            // integer inverse of the view's `tau * 694 / 1000` — the
            // round trip reproduces the live pools' packed value
            // (view 600 <-> tau 865). Everything downstream (state
            // clones included) carries tau.
            ma_time: (ma_time * 1000).div_ceil(694),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveStatefulState {
    pub reserve0: u128,
    pub reserve1: u128,
    pub d: u128,
    pub price_scale: u128,
    pub price_oracle: u128,
    pub last_prices: u128,
    pub last_timestamp: u64,
    pub virtual_price: u128,
    pub xcp_profit: u128,
    pub lp_xcp_profit: u128,
    pub total_supply: u128,
    pub donation: CurveDonationState,
}

#[inline]
fn mul_div_u128(a: u128, b: u128, den: u128, context: &str) -> Result<u128> {
    if den == 0 {
        return Err(anyhow!("curve division by zero in {}", context));
    }
    if a == 0 || b == 0 {
        return Ok(0);
    }
    let num = U256::from(a) * U256::from(b);
    let q = num / U256::from(den);
    u256_to_u128_checked(q, context)
}

#[inline]
fn add_u128(a: u128, b: u128, context: &str) -> Result<u128> {
    a.checked_add(b)
        .ok_or_else(|| anyhow!("curve overflow in {}: {} + {}", context, a, b))
}

#[inline]
fn sub_u128(a: u128, b: u128, context: &str) -> Result<u128> {
    a.checked_sub(b)
        .ok_or_else(|| anyhow!("curve underflow in {}: {} - {}", context, a, b))
}

#[inline]
fn u256_add(a: U256, b: U256, context: &str) -> Result<U256> {
    a.checked_add(b)
        .ok_or_else(|| anyhow!("curve overflow in {}: U256 addition", context))
}

#[inline]
fn u256_mul(a: U256, b: U256, context: &str) -> Result<U256> {
    a.checked_mul(b)
        .ok_or_else(|| anyhow!("curve overflow in {}: U256 multiplication", context))
}

#[inline]
fn u256_div(a: U256, b: U256, context: &str) -> Result<U256> {
    if b.is_zero() {
        return Err(anyhow!("curve division by zero in {}", context));
    }
    Ok(a / b)
}

#[inline]
fn u256_abs_diff(a: U256, b: U256) -> U256 {
    if a >= b {
        a - b
    } else {
        b - a
    }
}

#[inline]
fn u256_to_u128_checked(v: U256, context: &str) -> Result<u128> {
    if v > U256::from(u128::MAX) {
        return Err(anyhow!("curve overflow in {}: value exceeds u128", context));
    }
    Ok(v.low_u128())
}

/// Integer square root (exact `floor(sqrt(x))`) via Newton's method.
/// Seeded at `2^((bit_length + 1) / 2)` — the same power-of-two upper
/// bound `isqrt_u256` uses — so the descent starts one step above the
/// root instead of halving down from `x` (~bitlen/2 wasted iterations).
/// For any seed `z ≥ floor(sqrt(x))` the integer Newton iterate
/// `(z + x/z) / 2` stays `≥ floor(sqrt(x))` and strictly decreases until
/// the fixed point, so the result is exactly `floor(sqrt(x))` regardless
/// of the seed (pinned against the legacy seed-at-x variant in tests).
fn isqrt_biguint(x: &BigUint) -> BigUint {
    if x.is_zero() {
        return BigUint::zero();
    }
    let mut z: BigUint = BigUint::from(1u8) << (((x.bits() + 1) / 2) as usize);
    let mut y = (&z + x / &z) >> 1usize;
    while y < z {
        core::mem::swap(&mut z, &mut y);
        y = (&z + x / &z) >> 1usize;
    }
    z
}

#[inline]
fn to_u128_checked(v: BigUint, context: &str) -> Result<u128> {
    v.to_u128()
        .ok_or_else(|| anyhow!("curve overflow in {}: value exceeds u128", context))
}

#[inline]
fn curve_xp(balances: [u128; 2], price_scale: u128, precisions: [u128; 2]) -> Result<[u128; 2]> {
    let xp0 = balances[0]
        .checked_mul(precisions[0])
        .ok_or_else(|| anyhow!("curve_xp xp0 overflow"))?;
    let b1p1 = balances[1]
        .checked_mul(precisions[1])
        .ok_or_else(|| anyhow!("curve_xp b1*p1 overflow"))?;
    let xp1 = mul_div_u128(b1p1, price_scale, WAD, "curve_xp xp1")?;
    Ok([xp0, xp1])
}

fn newton_d_stableswap(a: u128, _gamma: u128, xp: [u128; 2], _k0_prev: u128) -> Result<u128> {
    // Mirrors the StableswapMath "!balance" entry guard: the math-level
    // hard limit is 10_000:1 (the pool-level guard is tighter, 1000:1).
    if xp[0] == 0 || xp[1] == 0 || xp[0].max(xp[1]) / xp[0].min(xp[1]) >= 10_000 {
        return Err(anyhow!("newton_d_stableswap balance guard"));
    }

    let xp0 = U256::from(xp[0]);
    let xp1 = U256::from(xp[1]);
    let s = xp0
        .checked_add(xp1)
        .ok_or_else(|| anyhow!("newton_d_stableswap S overflow"))?;
    if s.is_zero() {
        return Ok(0);
    }

    let ann = U256::from(a) * U256::from(N_COINS);
    let a_mult = U256::from(A_MULTIPLIER);
    let n_sq = U256::from(N_COINS * N_COINS);
    let n_plus_1 = U256::from(N_COINS + 1);
    let one = U256::from(1u8);

    // Hoist loop-invariant computations
    let ann_s = (ann * s) / a_mult;
    let ann_minus = if ann > a_mult {
        ann - a_mult
    } else {
        return Err(anyhow!("newton_d_stableswap Ann < A_MULTIPLIER"));
    };

    let mut d = s;
    for _iter_idx in 0..255 {
        let d_prev = d;
        // dp = d^3 / (N^2 * xp0 * xp1)
        let mut dp = (d * d) / xp0;
        dp = (dp * d) / xp1;
        dp = dp / n_sq;

        // numerator = (ann_s + 2*dp) * d
        let num_left = ann_s + dp + dp;
        // denominator = (ann-A_MULT)/A_MULT * d + (N+1)*dp
        let den_left = (ann_minus * d) / a_mult;
        let den = den_left + n_plus_1 * dp;
        if den.is_zero() {
            return Err(anyhow!("newton_d_stableswap zero denominator"));
        }
        d = (num_left * d) / den;

        let diff = u256_abs_diff(d, d_prev);
        if diff <= one {
            return u256_to_u128_checked(d, "newton_d_stableswap result");
        }
    }
    Err(anyhow!("newton_d_stableswap did not converge"))
}

fn get_y_stableswap(
    _amp: u128,
    _gamma: u128,
    xp: [u128; 2],
    d: u128,
    i: usize,
) -> Result<(u128, u128)> {
    if i >= N_COINS as usize {
        return Err(anyhow!("get_y_stableswap invalid index"));
    }
    if xp[0] == 0 || xp[1] == 0 {
        return Err(anyhow!("get_y_stableswap zero xp"));
    }

    let ann = U256::from(_amp) * U256::from(N_COINS);
    let d_u = U256::from(d);
    let n_u = U256::from(N_COINS);
    let a_mult = U256::from(A_MULTIPLIER);

    let x_other = U256::from(xp[1usize - i]);

    // c = d^2 / (x_other * N) * d * A_MULTIPLIER / (ann * N)
    let mut c = (d_u * d_u) / (x_other * n_u);
    let ann_n = ann * n_u;
    c = (c * d_u * a_mult) / ann_n;
    // b = x_other + d * A_MULTIPLIER / ann
    let b = x_other + (d_u * a_mult) / ann;

    let mut y = d_u;
    let one = U256::from(1u8);
    for _iter_idx in 0..255 {
        let y_prev = y;
        // y_next = (y^2 + c) / (2*y + b - d)
        let num = y * y + c;
        let den = y + y + b - d_u;
        if den.is_zero() {
            return Err(anyhow!("get_y_stableswap zero denominator"));
        }
        y = num / den;
        let diff = u256_abs_diff(y, y_prev);
        if diff <= one {
            return Ok((u256_to_u128_checked(y, "get_y_stableswap y")?, 0));
        }
    }
    Err(anyhow!("StableswapMath get_y did not converge"))
}

fn get_p_stableswap(xp: [u128; 2], d: u128, a: u128) -> Result<u128> {
    let ann = U256::from(a) * U256::from(N_COINS);
    let d_b = U256::from(d);
    let mut dr = d_b / U256::from(N_COINS * N_COINS);
    dr = (dr * d_b) / U256::from(xp[0]);
    dr = (dr * d_b) / U256::from(xp[1]);
    let xp0a = (ann * U256::from(xp[0])) / U256::from(A_MULTIPLIER);
    let dr_term = (dr * U256::from(xp[0])) / U256::from(xp[1]);
    let num_inner = xp0a + dr_term;
    let den = xp0a + dr;
    if den.is_zero() {
        return Err(anyhow!("get_p_stableswap zero denominator"));
    }
    u256_to_u128_checked(
        (U256::from(WAD) * num_inner) / den,
        "get_p_stableswap price",
    )
}

#[inline]
fn floor_div_signed(a: &BigInt, b: &BigInt, context: &str) -> Result<BigInt> {
    if b.is_zero() {
        return Err(anyhow!("curve division by zero in {}", context));
    }
    let q = a / b;
    let r = a % b;
    if !r.is_zero()
        && ((a.is_negative() && b.is_positive()) || (a.is_positive() && b.is_negative()))
    {
        Ok(q - BigInt::from(1u8))
    } else {
        Ok(q)
    }
}

#[inline]
fn to_u128_checked_signed(v: BigInt, context: &str) -> Result<u128> {
    if v.is_negative() {
        return Err(anyhow!(
            "curve underflow in {}: signed value is negative ({})",
            context,
            v
        ));
    }
    v.to_u128()
        .ok_or_else(|| anyhow!("curve overflow in {}: value exceeds u128", context))
}

#[inline]
fn biguint_pow10(exp: u32) -> BigUint {
    BigUint::from(10u8).pow(exp)
}

fn curve_cbrt_threshold() -> &'static BigUint {
    static SLOT: OnceLock<BigUint> = OnceLock::new();
    SLOT.get_or_init(|| {
        BigUint::parse_bytes(b"115792089237316195423570985008687907853269", 10)
            .expect("invalid curve cbrt threshold")
    })
}

fn validate_curve_math_inputs(ann: u128, gamma: u128, context: &str) -> Result<()> {
    if !(CURVE_MIN_A..=CURVE_MAX_A).contains(&ann) {
        return Err(anyhow!(
            "{} unsafe A: {}, expected [{},{}]",
            context,
            ann,
            CURVE_MIN_A,
            CURVE_MAX_A
        ));
    }
    if !(CURVE_MIN_GAMMA..=CURVE_MAX_GAMMA).contains(&gamma) {
        return Err(anyhow!(
            "{} unsafe gamma: {}, expected [{},{}]",
            context,
            gamma,
            CURVE_MIN_GAMMA,
            CURVE_MAX_GAMMA
        ));
    }
    Ok(())
}

fn log2_floor_biguint(x: &BigUint) -> u32 {
    if x.is_zero() {
        return 0;
    }
    let mut value = x.clone();
    let mut result = 0u32;
    while value > BigUint::from(1u8) {
        value >>= 1usize;
        result += 1;
    }
    result
}

fn curve_cbrt(x: &BigUint) -> Result<BigUint> {
    if x.is_zero() {
        return Ok(BigUint::zero());
    }
    let threshold = curve_cbrt_threshold();
    let threshold_wad = threshold * BigUint::from(WAD);
    let mut xx = if x >= &threshold_wad {
        x.clone()
    } else if x >= threshold {
        x * BigUint::from(WAD)
    } else {
        x * biguint_pow10(36)
    };

    let log2x = log2_floor_biguint(&xx);
    let remainder = log2x % 3;
    let pow2 = BigUint::from(1u8) << ((log2x / 3) as usize);
    let pow1260 = match remainder {
        0 => BigUint::from(1u8),
        1 => BigUint::from(1260u16),
        _ => BigUint::from(1_587_600u32),
    };
    let pow1000 = match remainder {
        0 => BigUint::from(1u8),
        1 => BigUint::from(1000u16),
        _ => BigUint::from(1_000_000u32),
    };
    let mut a = (pow2 * pow1260) / pow1000;
    if a.is_zero() {
        return Err(anyhow!("curve_cbrt initial guess is zero"));
    }

    let two = BigUint::from(2u8);
    let three = BigUint::from(3u8);
    for _ in 0..7 {
        let denom = &a * &a;
        if denom.is_zero() {
            return Err(anyhow!("curve_cbrt zero denominator"));
        }
        a = ((&two * &a) + (&xx / denom)) / &three;
    }

    if x >= &threshold_wad {
        xx = a * biguint_pow10(12);
    } else if x >= threshold {
        xx = a * biguint_pow10(6);
    } else {
        xx = a;
    }
    Ok(xx)
}

fn newton_y_twocrypto(
    ann: u128,
    gamma: u128,
    x: [u128; 2],
    d: u128,
    i: usize,
    lim_mul: u128,
) -> Result<u128> {
    if i >= 2 {
        return Err(anyhow!("newton_y_twocrypto invalid index"));
    }
    if gamma == 0 {
        return Err(anyhow!("newton_y_twocrypto gamma is zero"));
    }
    if d == 0 {
        return Err(anyhow!("newton_y_twocrypto D is zero"));
    }
    let x_j = x[1usize - i];
    if x_j == 0 {
        return Err(anyhow!("newton_y_twocrypto x_j is zero"));
    }
    if lim_mul == 0 {
        return Err(anyhow!("newton_y_twocrypto lim_mul is zero"));
    }

    let x_j_b = BigUint::from(x_j);
    let d_b = BigUint::from(d);
    let n_sq = BigUint::from(N_COINS * N_COINS);
    let mut y = (&d_b * &d_b) / (&x_j_b * &n_sq);
    let k0_i = (BigUint::from(WAD * N_COINS) * &x_j_b) / &d_b;
    let lower_k0 = biguint_pow10(36) / BigUint::from(lim_mul);
    let upper_k0 = BigUint::from(lim_mul);
    if k0_i < lower_k0 || k0_i > upper_k0 {
        return Err(anyhow!("newton_y_twocrypto unsafe values x[i]"));
    }

    let one_e14 = biguint_pow10(14);
    let convergence_limit = ((&x_j_b / &one_e14).max(&d_b / &one_e14)).max(BigUint::from(100u16));
    let gamma_b = BigUint::from(gamma);
    let ann_b = BigUint::from(ann);
    let g1k0_base = BigUint::from(gamma) + BigUint::from(WAD);
    let two = BigUint::from(2u8);
    let n_coins = BigUint::from(N_COINS);
    let wad_b = BigUint::from(WAD);

    for _ in 0..255 {
        let y_prev = y.clone();
        let k0 = (&k0_i * &y * &n_coins) / &d_b;
        let s = &x_j_b + &y;
        let g1k0 = if g1k0_base > k0 {
            (&g1k0_base - &k0) + BigUint::from(1u8)
        } else {
            (&k0 - &g1k0_base) + BigUint::from(1u8)
        };

        let mut mul1 = (&wad_b * &d_b) / &gamma_b;
        mul1 = (mul1 * &g1k0) / &gamma_b;
        mul1 = ((mul1 * &g1k0) * BigUint::from(A_MULTIPLIER)) / &ann_b;
        let mul2 = &wad_b + ((&two * &wad_b * &k0) / &g1k0);

        let mut yfprime = (&wad_b * &y) + (&s * &mul2) + &mul1;
        let dyfprime = &d_b * &mul2;
        if yfprime < dyfprime {
            y = &y_prev / 2u8;
            continue;
        }
        yfprime -= dyfprime;
        if y.is_zero() {
            return Err(anyhow!("newton_y_twocrypto y is zero"));
        }
        let fprime = &yfprime / &y;
        if fprime.is_zero() {
            return Err(anyhow!("newton_y_twocrypto fprime is zero"));
        }
        if k0.is_zero() {
            return Err(anyhow!("newton_y_twocrypto K0 is zero"));
        }
        let y_minus_base = &mul1 / &fprime;
        let y_plus = ((&yfprime + (&wad_b * &d_b)) / &fprime) + ((&y_minus_base * &wad_b) / &k0);
        let y_minus = y_minus_base + ((&wad_b * &s) / &fprime);
        y = if y_plus < y_minus {
            &y_prev / 2u8
        } else {
            &y_plus - &y_minus
        };

        let diff = if y > y_prev {
            &y - &y_prev
        } else {
            &y_prev - &y
        };
        let stop = convergence_limit.clone().max(&y / &one_e14);
        if diff < stop {
            return to_u128_checked(y, "newton_y_twocrypto result");
        }
    }
    Err(anyhow!("newton_y_twocrypto did not converge"))
}

fn get_y_twocrypto(
    ann: u128,
    gamma: u128,
    xp: [u128; 2],
    d: u128,
    i: usize,
) -> Result<(u128, u128)> {
    validate_curve_math_inputs(ann, gamma, "get_y_twocrypto")?;
    if i >= 2 {
        return Err(anyhow!("get_y_twocrypto invalid index"));
    }
    if d <= (10u128.pow(17) - 1u128) || d >= (10u128.pow(33) + 1u128) {
        return Err(anyhow!("get_y_twocrypto unsafe D values"));
    }
    if xp[0] == 0 || xp[1] == 0 {
        return Err(anyhow!("get_y_twocrypto zero xp"));
    }

    let mut lim_mul = 100u128 * WAD;
    if gamma > CURVE_MAX_GAMMA_SMALL {
        lim_mul = mul_div_u128(
            lim_mul,
            CURVE_MAX_GAMMA_SMALL,
            gamma,
            "get_y_twocrypto lim_mul",
        )?;
    }

    let ann_b = BigInt::from(ann);
    let gamma_b = BigInt::from(gamma);
    let d_b = BigInt::from(d);
    let x_j = BigInt::from(xp[1usize - i]);
    let gamma2 = &gamma_b * &gamma_b;

    let k0_i = (BigInt::from(WAD * N_COINS) * &x_j) / &d_b;
    let lower_k0 = floor_div_signed(
        &BigInt::from(10u8).pow(36),
        &BigInt::from(lim_mul),
        "get_y_twocrypto lower_k0",
    )?;
    if k0_i < lower_k0 || k0_i > BigInt::from(lim_mul) {
        return Err(anyhow!("get_y_twocrypto unsafe values x[i]"));
    }

    let ann_gamma2 = &ann_b * &gamma2;
    let one_e32 = BigInt::from(10u8).pow(32);
    let one_e14 = BigInt::from(10u8).pow(14);
    let one_e4 = BigInt::from(10u8).pow(4);
    let one_e18 = BigInt::from(WAD);
    let a_coef = one_e32.clone();
    let b_coef = (((&d_b * &ann_gamma2) / BigInt::from(400_000_000u128)) / &x_j)
        - (BigInt::from(3u8) * &one_e32)
        - (BigInt::from(2u8) * &gamma_b * &one_e14);
    let c_coef = (BigInt::from(3u8) * &one_e32)
        + (BigInt::from(4u8) * &gamma_b * &one_e14)
        + (&gamma2 / &one_e4)
        + (((BigInt::from(4u8) * &ann_gamma2) / BigInt::from(400_000_000u128)) * &x_j / &d_b)
        - ((BigInt::from(4u8) * &ann_gamma2) / BigInt::from(400_000_000u128));
    let d_coef = -((&one_e18 + &gamma_b).pow(2u32) / &one_e4);

    let mut delta0 = floor_div_signed(
        &(BigInt::from(3u8) * &a_coef * &c_coef),
        &b_coef,
        "get_y_twocrypto delta0",
    )? - &b_coef;
    let mut delta1 = (BigInt::from(3u8) * &delta0) + &b_coef
        - floor_div_signed(
            &(floor_div_signed(
                &(BigInt::from(27u8) * &a_coef * &a_coef),
                &b_coef,
                "get_y_twocrypto delta1 inner",
            )? * &d_coef),
            &b_coef,
            "get_y_twocrypto delta1",
        )?;

    let threshold = std::cmp::min(std::cmp::min(delta0.abs(), delta1.abs()), a_coef.clone());
    let mut divider = BigInt::from(1u8);
    let pow10 = |exp: u32| BigInt::from(10u8).pow(exp);
    if threshold > pow10(48) {
        divider = pow10(30);
    } else if threshold > pow10(46) {
        divider = pow10(28);
    } else if threshold > pow10(44) {
        divider = pow10(26);
    } else if threshold > pow10(42) {
        divider = pow10(24);
    } else if threshold > pow10(40) {
        divider = pow10(22);
    } else if threshold > pow10(38) {
        divider = pow10(20);
    } else if threshold > pow10(36) {
        divider = pow10(18);
    } else if threshold > pow10(34) {
        divider = pow10(16);
    } else if threshold > pow10(32) {
        divider = pow10(14);
    } else if threshold > pow10(30) {
        divider = pow10(12);
    } else if threshold > pow10(28) {
        divider = pow10(10);
    } else if threshold > pow10(26) {
        divider = pow10(8);
    } else if threshold > pow10(24) {
        divider = pow10(6);
    } else if threshold > pow10(20) {
        divider = pow10(2);
    }

    let a_s = &a_coef / &divider;
    let b_s = &b_coef / &divider;
    let c_s = &c_coef / &divider;
    let d_s = &d_coef / &divider;
    delta0 = ((BigInt::from(3u8) * &a_s * &c_s) / &b_s) - &b_s;
    delta1 = (BigInt::from(3u8) * &delta0) + &b_s
        - (((BigInt::from(27u8) * &a_s * &a_s) / &b_s * &d_s) / &b_s);

    let sqrt_arg =
        (&delta1 * &delta1) + (((BigInt::from(4u8) * &delta0 * &delta0) / &b_s) * &delta0);
    if sqrt_arg <= BigInt::zero() {
        return Ok((newton_y_twocrypto(ann, gamma, xp, d, i, lim_mul)?, 0));
    }
    let sqrt_val = BigInt::from(isqrt_biguint(
        &sqrt_arg
            .to_biguint()
            .ok_or_else(|| anyhow!("get_y_twocrypto sqrt_arg negative"))?,
    ));

    let b_cbrt = if b_s > BigInt::zero() {
        BigInt::from(curve_cbrt(
            &b_s.to_biguint()
                .ok_or_else(|| anyhow!("get_y_twocrypto b_s conversion failed"))?,
        )?)
    } else {
        -BigInt::from(curve_cbrt(
            &(-&b_s)
                .to_biguint()
                .ok_or_else(|| anyhow!("get_y_twocrypto -b_s conversion failed"))?,
        )?)
    };

    let second_cbrt = if delta1 > BigInt::zero() {
        BigInt::from(curve_cbrt(
            &((&delta1 + &sqrt_val) / BigInt::from(2u8))
                .to_biguint()
                .ok_or_else(|| anyhow!("get_y_twocrypto second_cbrt conversion failed"))?,
        )?)
    } else {
        -BigInt::from(curve_cbrt(
            &((&sqrt_val - &delta1) / BigInt::from(2u8))
                .to_biguint()
                .ok_or_else(|| anyhow!("get_y_twocrypto second_cbrt conversion failed"))?,
        )?)
    };

    let c1 = (((&b_cbrt * &b_cbrt) / &one_e18) * &second_cbrt) / &one_e18;
    if c1.is_zero() {
        return Ok((newton_y_twocrypto(ann, gamma, xp, d, i, lim_mul)?, 0));
    }
    let root = floor_div_signed(
        &((&one_e18 * &c1)
            - (&one_e18 * &b_s)
            - (floor_div_signed(&(&one_e18 * &b_s), &c1, "get_y_twocrypto root b/C1")? * &delta0)),
        &(BigInt::from(3u8) * &a_s),
        "get_y_twocrypto root",
    )?;
    if root <= BigInt::zero() {
        return Ok((newton_y_twocrypto(ann, gamma, xp, d, i, lim_mul)?, 0));
    }

    let y_out_signed = ((((&d_b * &d_b) / &x_j) * &root) / BigInt::from(4u8)) / &one_e18;
    let y_out = to_u128_checked_signed(y_out_signed, "get_y_twocrypto y_out")?;
    let k0_prev = to_u128_checked_signed(root, "get_y_twocrypto K0_prev")?;

    let frac = (BigUint::from(y_out) * BigUint::from(WAD)) / BigUint::from(d);
    let lower_frac = (biguint_pow10(36) / BigUint::from(N_COINS)) / BigUint::from(lim_mul);
    let upper_frac = BigUint::from(lim_mul) / BigUint::from(N_COINS);
    if frac < lower_frac || frac > upper_frac {
        return Err(anyhow!("get_y_twocrypto unsafe value for y"));
    }
    Ok((y_out, k0_prev))
}

fn newton_d_twocrypto(
    ann: u128,
    gamma: u128,
    x_unsorted: [u128; 2],
    k0_prev: u128,
) -> Result<u128> {
    validate_curve_math_inputs(ann, gamma, "newton_d_twocrypto")?;

    let mut x = x_unsorted;
    if x[0] < x[1] {
        x = [x_unsorted[1], x_unsorted[0]];
    }
    if x[0] <= (10u128.pow(9) - 1u128) || x[0] >= (10u128.pow(33) + 1u128) {
        return Err(anyhow!("newton_d_twocrypto unsafe values x[0]"));
    }
    if x[1] == 0 {
        return Err(anyhow!("newton_d_twocrypto x[1] is zero"));
    }
    let ratio = mul_div_u128(x[1], WAD, x[0], "newton_d_twocrypto ratio")?;
    if ratio <= (10u128.pow(14) - 1u128) {
        return Err(anyhow!("newton_d_twocrypto unsafe values x[i] (input)"));
    }

    let x0_b = BigUint::from(x[0]);
    let x1_b = BigUint::from(x[1]);
    let s = &x0_b + &x1_b;
    let mut d = if k0_prev == 0 {
        BigUint::from(N_COINS) * isqrt_biguint(&(&x0_b * &x1_b))
    } else {
        let d_guess = isqrt_biguint(
            &((BigUint::from(4u8) * &x0_b * &x1_b) / BigUint::from(k0_prev) * BigUint::from(WAD)),
        );
        if s < d_guess {
            s.clone()
        } else {
            d_guess
        }
    };

    let g1k0_base = BigUint::from(gamma) + BigUint::from(WAD);
    let gamma_b = BigUint::from(gamma);
    let ann_b = BigUint::from(ann);
    let wad_b = BigUint::from(WAD);
    let n_coins = BigUint::from(N_COINS);
    let one_e14 = biguint_pow10(14);
    let one_e16 = biguint_pow10(16);

    for _ in 0..255 {
        let d_prev = d.clone();
        if d.is_zero() {
            return Err(anyhow!("newton_d_twocrypto D==0"));
        }

        let k0 = ((&wad_b * &n_coins * &n_coins * &x0_b) / &d) * &x1_b / &d;
        let g1k0 = if g1k0_base > k0 {
            (&g1k0_base - &k0) + BigUint::from(1u8)
        } else {
            (&k0 - &g1k0_base) + BigUint::from(1u8)
        };
        if k0.is_zero() {
            return Err(anyhow!("newton_d_twocrypto K0 is zero"));
        }

        let mut mul1 = (&wad_b * &d) / &gamma_b;
        mul1 = (mul1 * &g1k0) / &gamma_b;
        mul1 = ((mul1 * &g1k0) * BigUint::from(A_MULTIPLIER)) / &ann_b;
        let mul2 = (((BigUint::from(2u8) * &wad_b) * &n_coins) * &k0) / &g1k0;

        let neg_fprime =
            (&s + ((&s * &mul2) / &wad_b)) + ((&mul1 * &n_coins) / &k0) - ((&mul2 * &d) / &wad_b);
        if neg_fprime.is_zero() {
            return Err(anyhow!("newton_d_twocrypto neg_fprime is zero"));
        }

        let d_plus = (&d * (&neg_fprime + &s)) / &neg_fprime;
        let mut d_minus = (&d * &d) / &neg_fprime;
        let d_mul = (&d * (&mul1 / &neg_fprime)) / &wad_b;
        if wad_b > k0 {
            d_minus += (&d_mul * (&wad_b - &k0)) / &k0;
        } else {
            let sub_term = (&d_mul * (&k0 - &wad_b)) / &k0;
            if d_minus < sub_term {
                return Err(anyhow!("newton_d_twocrypto D_minus underflow"));
            }
            d_minus -= sub_term;
        }

        d = if d_plus > d_minus {
            &d_plus - &d_minus
        } else {
            (&d_minus - &d_plus) / 2u8
        };

        let diff = if d > d_prev {
            &d - &d_prev
        } else {
            &d_prev - &d
        };
        if (&diff * &one_e14) < std::cmp::max(one_e16.clone(), d.clone()) {
            let lower_frac = biguint_pow10(16) / &n_coins - BigUint::from(1u8);
            let upper_frac = biguint_pow10(20) / &n_coins + BigUint::from(1u8);
            for x_i in [&x0_b, &x1_b] {
                let frac = (x_i * &wad_b) / &d;
                if frac <= lower_frac || frac >= upper_frac {
                    return Err(anyhow!("newton_d_twocrypto unsafe values x[i]"));
                }
            }
            return to_u128_checked(d, "newton_d_twocrypto result");
        }
    }

    Err(anyhow!("newton_d_twocrypto did not converge"))
}

fn get_p_twocrypto(xp: [u128; 2], d: u128, a: u128, gamma: u128) -> Result<u128> {
    validate_curve_math_inputs(a, gamma, "get_p_twocrypto")?;
    if d <= (10u128.pow(17) - 1u128) || d >= (10u128.pow(33) + 1u128) {
        return Err(anyhow!("get_p_twocrypto unsafe D values"));
    }
    if xp[0] == 0 || xp[1] == 0 {
        return Err(anyhow!("get_p_twocrypto zero xp"));
    }

    let d_b = BigUint::from(d);
    let one_e36 = biguint_pow10(36);
    let k0 = (((BigUint::from(4u8) * BigUint::from(xp[0]) * BigUint::from(xp[1])) / &d_b)
        * &one_e36)
        / &d_b;
    let k0_sq = &k0 * &k0;
    let term1 = (((BigUint::from(2u8) * &k0_sq) / &one_e36) * &k0) / &one_e36;
    let term2 = BigUint::from(gamma + WAD).pow(2u32);
    let term3 =
        ((&k0_sq / &one_e36) * BigUint::from((2u128 * gamma) + (3u128 * WAD))) / BigUint::from(WAD);
    let mut gk0 = term1 + term2;
    if gk0 < term3 {
        return Err(anyhow!("get_p_twocrypto GK0 underflow"));
    }
    gk0 -= term3;

    let nnag2 = (BigUint::from(a) * BigUint::from(gamma).pow(2u32)) / BigUint::from(A_MULTIPLIER);
    let denominator = &gk0 + ((((&nnag2 * BigUint::from(xp[0])) / &d_b) * &k0) / &one_e36);
    if denominator.is_zero() {
        return Err(anyhow!("get_p_twocrypto zero denominator"));
    }
    let num_inner = &gk0 + ((((&nnag2 * BigUint::from(xp[1])) / &d_b) * &k0) / &one_e36);
    let numerator =
        ((BigUint::from(xp[0]) * num_inner) / BigUint::from(xp[1])) * BigUint::from(WAD);
    to_u128_checked(numerator / denominator, "get_p_twocrypto price")
}

fn get_y_for_mode(
    math_mode: &str,
    a: u128,
    gamma: u128,
    xp: [u128; 2],
    d: u128,
    i: usize,
) -> Result<(u128, u128)> {
    match math_mode {
        "stableswap" => get_y_stableswap(a, gamma, xp, d, i),
        "crypto" => get_y_twocrypto(a, gamma, xp, d, i),
        _ => Err(anyhow!(
            "curve math mode `{}` is not supported in Rust runtime",
            math_mode
        )),
    }
}

fn get_p_for_mode(math_mode: &str, xp: [u128; 2], d: u128, a: u128, gamma: u128) -> Result<u128> {
    match math_mode {
        "stableswap" => get_p_stableswap(xp, d, a),
        "crypto" => get_p_twocrypto(xp, d, a, gamma),
        _ => Err(anyhow!(
            "curve math mode `{}` is not supported in Rust runtime",
            math_mode
        )),
    }
}

fn compute_d_from_mode(
    math_mode: &str,
    a: u128,
    gamma: u128,
    xp: [u128; 2],
    k0_prev: u128,
) -> Result<u128> {
    match math_mode {
        "stableswap" => newton_d_stableswap(a, gamma, xp, k0_prev),
        "crypto" => newton_d_twocrypto(a, gamma, xp, k0_prev),
        _ => Err(anyhow!(
            "curve math mode `{}` is not supported in Rust runtime",
            math_mode
        )),
    }
}

#[inline]
fn assert_balance(xp: [u128; 2], context: &str) -> Result<()> {
    // Pool-level post-operation guard (tighter than the math kernels'
    // ~10_000:1 Newton bounds): reject any state beyond 1000:1.
    if xp[0] == 0 || xp[1] == 0 || xp[0].max(xp[1]) / xp[0].min(xp[1]) >= 1_000 {
        return Err(anyhow!("curve_balance_guard in {}", context));
    }
    Ok(())
}

#[inline]
fn curve_fee(xp: [u128; 2], mid_fee: u128, out_fee: u128, fee_gamma: u128) -> Result<u128> {
    // Synthetic fee-free mode (visualizer curve-geometry probes). A real
    // pool cannot be configured this way — the chain enforces
    // mid_fee >= MIN_FEE at deploy — so the reference MIN/MAX clamp
    // below only ever applies to chain-valid parameter sets.
    if mid_fee == 0 && out_fee == 0 {
        return Ok(0);
    }
    let sum = U256::from(xp[0]) + U256::from(xp[1]);
    if fee_gamma == 0 {
        // B = 0 in the reference formula: pure out_fee.
        return Ok(out_fee.clamp(CURVE_MIN_FEE, CURVE_MAX_FEE));
    }
    if sum.is_zero() {
        return Ok(mid_fee.clamp(CURVE_MIN_FEE, CURVE_MAX_FEE));
    }
    let wad = U256::from(WAD);
    // b = WAD * N^2 * xp[0] * xp[1] / sum^2
    let mut b = wad * U256::from(N_COINS * N_COINS);
    b = (b * U256::from(xp[0])) / sum;
    b = (b * U256::from(xp[1])) / sum;

    let fee_gamma_u = U256::from(fee_gamma);
    let fee_gamma_b = fee_gamma_u * b;
    // den = fee_gamma*b/WAD + WAD - b
    let den = fee_gamma_b / wad + wad - b;
    if den.is_zero() {
        return Err(anyhow!("curve_fee zero denominator"));
    }
    b = fee_gamma_b / den;

    let out = (U256::from(mid_fee) * b + U256::from(out_fee) * (wad - b)) / wad;
    Ok(u256_to_u128_checked(out, "curve_fee out")?.clamp(CURVE_MIN_FEE, CURVE_MAX_FEE))
}

/// Integer square root for U256 using Newton's method (no heap allocation).
#[inline]
fn isqrt_u256(x: U256) -> U256 {
    if x.is_zero() {
        return U256::zero();
    }
    // Initial guess: 2^((bit_length+1)/2)
    let bits = 256 - x.leading_zeros();
    let mut z = U256::one() << ((bits + 1) / 2);
    let mut y = (z + x / z) >> 1;
    while y < z {
        z = y;
        y = (z + x / z) >> 1;
    }
    z
}

#[inline]
fn curve_xcp(d: u128, price_scale: u128) -> Result<u128> {
    let rad = U256::from(WAD) * U256::from(price_scale);
    let sqrt_price_u256 = isqrt_u256(rad);
    let sqrt_price = u256_to_u128_checked(sqrt_price_u256, "curve_xcp sqrt")?;
    if sqrt_price == 0 {
        return Ok(0);
    }
    // den = N_COINS * sqrt_price (N_COINS=2, so this fits u128)
    let den = N_COINS
        .checked_mul(sqrt_price)
        .ok_or_else(|| anyhow!("curve_xcp denominator overflow"))?;
    mul_div_u128(d, WAD, den, "curve_xcp out")
}

fn resolve_d(
    math_mode: &str,
    a: u128,
    gamma: u128,
    reserve0: u128,
    reserve1: u128,
    price_scale: u128,
    precisions: [u128; 2],
    fallback_d: u128,
) -> Result<u128> {
    if fallback_d > 0 {
        return Ok(fallback_d);
    }
    if reserve0 == 0 || reserve1 == 0 {
        return Ok(0);
    }
    let xp = curve_xp([reserve0, reserve1], price_scale, precisions)?;
    compute_d_from_mode(math_mode, a, gamma, xp, 0)
}

fn build_state(config: &CurveStatefulConfig, input_state: CurveStatefulState) -> CurveState {
    CurveState {
        price_scale: input_state.price_scale,
        price_oracle: input_state.price_oracle,
        last_prices: input_state.last_prices,
        last_timestamp: input_state.last_timestamp,
        virtual_price: input_state.virtual_price,
        xcp_profit: input_state.xcp_profit,
        lp_xcp_profit: input_state.lp_xcp_profit,
        total_supply: input_state.total_supply,
        adjustment_step_min: config.adjustment_step_min,
        adjustment_step_max: config.adjustment_step_max,
        reserved_profit_fraction: config.reserved_profit_fraction,
        ma_time: config.ma_time,
        d: input_state.d,
        donation: input_state.donation,
    }
}

fn wad_exp(x: BigInt) -> Result<BigInt> {
    if x <= *wad_exp_min_input() {
        return Ok(BigInt::zero());
    }
    if x >= *wad_exp_max_input() {
        return Err(anyhow!("math: wad_exp overflow"));
    }

    let mut x_scaled = (&x << 78usize) / wad_exp_five_pow_18();
    let k = (((&x_scaled << 96usize) / wad_exp_log2_e_2_96()) + (&BigInt::from(1u8) << 95usize))
        >> 96usize;
    x_scaled -= &k * wad_exp_log2_e_2_96();

    let mut y = (&x_scaled + wad_exp_c0()) * &x_scaled;
    y = (&y >> 96usize) + wad_exp_c1();

    let mut p = &y + &x_scaled - wad_exp_c2();
    p *= &y;
    p = (&p >> 96usize) + wad_exp_c3();
    p *= &x_scaled;
    p += wad_exp_c4() << 96usize;

    let mut q = &x_scaled - wad_exp_c5();
    q *= &x_scaled;
    q = (&q >> 96usize) + wad_exp_c6();
    q *= &x_scaled;
    q = (&q >> 96usize) - wad_exp_c7();
    q *= &x_scaled;
    q = (&q >> 96usize) + wad_exp_c8();
    q *= &x_scaled;
    q = (&q >> 96usize) - wad_exp_c9();
    q *= &x_scaled;
    q = (&q >> 96usize) + wad_exp_c10();

    let r = p / q;
    let shift = BigInt::from(195u32) - &k;
    let out = if shift > BigInt::zero() {
        let s = shift
            .to_usize()
            .ok_or_else(|| anyhow!("wad_exp positive shift overflow usize"))?;
        (r * wad_exp_scale_factor()) >> s
    } else if shift < BigInt::zero() {
        let s = (-shift)
            .to_usize()
            .ok_or_else(|| anyhow!("wad_exp negative shift overflow usize"))?;
        (r * wad_exp_scale_factor()) << s
    } else {
        r * wad_exp_scale_factor()
    };
    Ok(out)
}

/// Donation shares unlocked at `timestamp`: linear time release over
/// `CURVE_DONATION_DURATION_SEC`, optionally damped by the sandwich
/// protection factor while `protection_expiry_ts` is in the future.
fn unlocked_donation_shares(
    donation: &CurveDonationState,
    timestamp: u64,
    with_protection: bool,
) -> Result<u128> {
    let total = donation.shares;
    if total == 0 {
        return Ok(0);
    }
    let elapsed = u128::from(timestamp.saturating_sub(donation.last_release_ts));
    let unlocked = total.min(mul_div_u128(
        total,
        elapsed,
        u128::from(CURVE_DONATION_DURATION_SEC),
        "donation unlocked",
    )?);
    if !with_protection {
        return Ok(unlocked);
    }
    let mut protection_factor = 0u128;
    if donation.protection_expiry_ts > timestamp {
        protection_factor = WAD.min(mul_div_u128(
            u128::from(donation.protection_expiry_ts - timestamp),
            WAD,
            u128::from(CURVE_DONATION_PROTECTION_PERIOD_SEC),
            "donation protection factor",
        )?);
    }
    mul_div_u128(
        unlocked,
        sub_u128(WAD, protection_factor, "donation WAD-protection")?,
        WAD,
        "donation protected unlocked",
    )
}

fn tweak_price_by_mode(
    state: &mut CurveState,
    math_mode: &str,
    xp: [u128; 2],
    d: u128,
    a: u128,
    gamma: u128,
    timestamp: u64,
    disable_rebalance: bool,
    vp_preop: u128,
) -> Result<CurveRebalanceOutcome> {
    let mut price_oracle = state.price_oracle;
    let price_scale = state.price_scale;
    let last_ts = state.last_timestamp;

    if last_ts < timestamp {
        let dt = timestamp - last_ts;
        // `state.ma_time` already carries the internal relaxation time
        // tau — the half-life -> tau conversion happens exactly once in
        // `CurveStatefulConfig::new`, mirroring how the reference
        // contract stores tau and exposes the half-life only in its
        // `ma_time()` view.
        let ma_time = if state.ma_time > 0 {
            state.ma_time
        } else {
            1u128
        };
        // dt*WAD fits u128 (dt<=4e9, WAD=1e18, product<=4e27 << 3.4e38)
        let neg_val = (dt as u128) * WAD / ma_time;
        let neg = -BigInt::from(neg_val);
        let alpha_bi = wad_exp(neg)?;
        if alpha_bi.is_negative() {
            return Err(anyhow!("curve tweakPrice alpha negative"));
        }
        let alpha = alpha_bi
            .to_u128()
            .ok_or_else(|| anyhow!("curve tweakPrice alpha overflow u128"))?;

        // Symmetric spot cap into the EMA: [price_scale/2, 2*price_scale].
        let mut capped = state.last_prices;
        // Contract math is uint256; keep this guard overflow-safe on u128 runtime state.
        let twice_price_scale = price_scale
            .checked_mul(2)
            .ok_or_else(|| anyhow!("tweakPrice 2*priceScale overflow"))?;
        let half_price_scale = price_scale / 2;
        if capped < half_price_scale {
            capped = half_price_scale;
        }
        if capped > twice_price_scale {
            capped = twice_price_scale;
        }
        let w_minus_alpha = sub_u128(WAD, alpha, "tweakPrice WAD-alpha")?;
        // Use U256 to avoid BigUint heap allocation for the oracle blend
        let num = u256_add(
            u256_mul(
                U256::from(capped),
                U256::from(w_minus_alpha),
                "tweakPrice blend capped",
            )?,
            u256_mul(
                U256::from(price_oracle),
                U256::from(alpha),
                "tweakPrice blend oracle",
            )?,
            "tweakPrice blend sum",
        )?;
        price_oracle = u256_to_u128_checked(
            u256_div(num, U256::from(WAD), "tweakPrice blend /WAD")?,
            "tweakPrice oracle blend",
        )?;
        state.price_oracle = price_oracle;
        state.last_timestamp = timestamp;
    }

    let p = get_p_for_mode(math_mode, xp, d, a, gamma)?;
    state.last_prices = mul_div_u128(p, price_scale, WAD, "tweakPrice lastPrices")?;

    let total_supply = state.total_supply;
    let old_virtual_price = state.virtual_price;
    let xcp = curve_xcp(d, price_scale)?;
    let vp = if total_supply > 0 {
        mul_div_u128(WAD, xcp, total_supply, "tweakPrice vp")?
    } else {
        WAD
    };

    // The operation must not decrease vp against either baseline: the
    // stored value or the fresh pre-operation recompute (they differ by
    // rounding dust after a proportional remove rescales D).
    if vp < old_virtual_price || vp < vp_preop {
        return Err(anyhow!("curve_virtual_price_decreased"));
    }
    // Profit accounting: xcp_profit follows vp growth; lp_xcp_profit is the
    // LP-protected floor that accrues the reserved fraction of each positive
    // delta (recovery back up to 1e18 is excluded from the LP part). The
    // live pool books admin fees outside vp (admin_fee = 0 here), so the
    // floor accrual reduces to d_profit * reserved / FEE_PRECISION.
    let old_xcp_profit = state.xcp_profit;
    state.xcp_profit = add_u128(
        old_xcp_profit,
        sub_u128(vp, old_virtual_price, "tweakPrice vp-oldVp")?,
        "tweakPrice xcpProfit",
    )?;
    if state.xcp_profit > WAD {
        let d_profit = sub_u128(
            state.xcp_profit,
            old_xcp_profit.max(WAD),
            "tweakPrice dProfit",
        )?;
        state.lp_xcp_profit = add_u128(
            state.lp_xcp_profit,
            mul_div_u128(
                d_profit,
                state.reserved_profit_fraction,
                CURVE_FEE_PRECISION,
                "tweakPrice lpXcpProfit accrual",
            )?,
            "tweakPrice lpXcpProfit",
        )?;
    }

    // Unlocked donation shares boost the trigger: they sit inside
    // total_supply but belong to no LP, so xcp measured against the
    // locked supply reads higher than vp and wakes the rebalance early.
    let donation_shares_avail = unlocked_donation_shares(&state.donation, timestamp, true)?;
    let vp_boosted = if total_supply > donation_shares_avail && total_supply > 0 {
        mul_div_u128(
            WAD,
            xcp,
            sub_u128(
                total_supply,
                donation_shares_avail,
                "tweakPrice lockedSupply",
            )?,
            "tweakPrice vpBoosted",
        )?
    } else {
        vp
    };
    if vp_boosted < vp {
        return Err(anyhow!("curve_negative_donation"));
    }

    // Gate checks in the same short-circuit order as the reference
    // condition `!disable && vp_boosted > lp_xcp_profit && last_ts < ts`;
    // the first failing gate is reported as the blocked reason.
    let blocked_by: CurveRebalanceGateBlocked;
    if disable_rebalance {
        blocked_by = CurveRebalanceGateBlocked::RebalanceDisabled;
    } else if vp_boosted <= state.lp_xcp_profit {
        blocked_by = CurveRebalanceGateBlocked::VpAtOrBelowLpFloor;
    } else if last_ts >= timestamp {
        blocked_by = CurveRebalanceGateBlocked::SameTimestampOncePerBlock;
    } else {
        let mut norm = mul_div_u128(price_oracle, WAD, price_scale, "tweakPrice norm")?;
        if norm > WAD {
            norm = sub_u128(norm, WAD, "tweakPrice norm-WAD")?;
        } else {
            norm = sub_u128(WAD, norm, "tweakPrice WAD-norm")?;
        }

        // Damped gap fraction, hard-capped: min(norm/5, step_max); the
        // step_min bound below is the dust dead-band.
        let step = state.adjustment_step_max.min(norm / 5u128);
        if step <= state.adjustment_step_min {
            blocked_by = CurveRebalanceGateBlocked::StepBelowDustMin;
        } else {
            // Use U256 for intermediate products: with token0=USDT, price_scale can be
            // large (USDT/base in 1e18), and `price_scale * 1e18` may exceed u128.
            let num1 = u256_mul(
                U256::from(price_scale),
                U256::from(sub_u128(norm, step, "tweakPrice norm-step")?),
                "tweakPrice num1",
            )?;
            let num2 = u256_mul(
                U256::from(step),
                U256::from(price_oracle),
                "tweakPrice num2",
            )?;
            let p_new = u256_to_u128_checked(
                u256_div(
                    u256_add(num1, num2, "tweakPrice pNew numerator")?,
                    U256::from(norm),
                    "tweakPrice pNew",
                )?,
                "tweakPrice pNew",
            )?;
            if p_new == price_scale {
                state.d = d;
                state.virtual_price = vp;
                assert_balance(xp, "tweakPrice hold")?;
                return Ok(CurveRebalanceOutcome {
                    rebalanced: false,
                    blocked_by: Some(CurveRebalanceGateBlocked::PriceScaleUnchanged),
                    donation_shares_burned: 0,
                });
            }
            let xp_new = [
                xp[0],
                mul_div_u128(xp[1], p_new, price_scale, "tweakPrice xp_new[1]")?,
            ];
            let d_new = compute_d_from_mode(math_mode, a, gamma, xp_new, 0)?;
            let new_xcp = curve_xcp(d_new, p_new)?;
            let mut new_vp = if total_supply > 0 {
                mul_div_u128(WAD, new_xcp, total_supply, "tweakPrice new_vp")?
            } else {
                WAD
            };
            // Burn unlocked donation shares to lift the post-move vp back
            // toward max(lp_xcp_profit, vp) — the donation buffer pays for
            // the move instead of the LPs' profit cushion.
            let mut donation_burn = 0u128;
            let goal_vp = state.lp_xcp_profit.max(vp);
            if new_vp < goal_vp && total_supply > 0 {
                let tweaked_supply =
                    mul_div_u128(WAD, new_xcp, goal_vp, "tweakPrice tweakedSupply")?;
                if tweaked_supply >= total_supply {
                    return Err(anyhow!("curve tweaked supply must shrink"));
                }
                donation_burn = sub_u128(
                    total_supply,
                    tweaked_supply,
                    "tweakPrice supply-tweakedSupply",
                )?
                .min(donation_shares_avail);
                new_vp = mul_div_u128(
                    WAD,
                    new_xcp,
                    sub_u128(total_supply, donation_burn, "tweakPrice supply-burn")?,
                    "tweakPrice new_vp boosted",
                )?;
            }
            // Commit only while the LP-protected floor is preserved.
            if new_vp > WAD && new_vp >= state.lp_xcp_profit {
                state.d = d_new;
                state.virtual_price = new_vp;
                state.price_scale = p_new;
                if donation_burn > 0 {
                    // Shrink the release schedule so the protected unlocked
                    // amount drops by exactly `donation_burn`: reduce the
                    // time-unlocked amount proportionally, then shift
                    // `last_release_ts` as if one virtual donation of the
                    // remaining size had been unlocking since then.
                    let shares_unlocked =
                        unlocked_donation_shares(&state.donation, timestamp, false)?;
                    let unlocked_after = sub_u128(
                        shares_unlocked,
                        mul_div_u128(
                            donation_burn,
                            shares_unlocked,
                            donation_shares_avail,
                            "tweakPrice burn/available",
                        )?,
                        "tweakPrice unlockedAfter",
                    )?;
                    let new_total = sub_u128(
                        state.donation.shares,
                        donation_burn,
                        "tweakPrice donationShares-burn",
                    )?;
                    let new_elapsed = if new_total > 0 && unlocked_after > 0 {
                        mul_div_u128(
                            unlocked_after,
                            u128::from(CURVE_DONATION_DURATION_SEC),
                            new_total,
                            "tweakPrice newElapsed",
                        )?
                    } else {
                        0
                    };
                    state.donation.shares = new_total;
                    state.total_supply = sub_u128(
                        state.total_supply,
                        donation_burn,
                        "tweakPrice totalSupply-burn",
                    )?;
                    state.donation.last_release_ts = timestamp.saturating_sub(new_elapsed as u64);
                }
                assert_balance(xp_new, "tweakPrice commit")?;
                return Ok(CurveRebalanceOutcome {
                    rebalanced: true,
                    blocked_by: None,
                    donation_shares_burned: donation_burn,
                });
            }
            // Blocked even after offering every unlocked donation share.
            blocked_by = CurveRebalanceGateBlocked::CommitVpBelowLpFloor;
        }
    }

    state.d = d;
    state.virtual_price = vp;
    assert_balance(xp, "tweakPrice skip")?;
    Ok(CurveRebalanceOutcome {
        rebalanced: false,
        blocked_by: Some(blocked_by),
        donation_shares_burned: 0,
    })
}

fn calc_token_fee(
    amounts_received: [u128; 2],
    xp_after: [u128; 2],
    balances_before: [u128; 2],
    precisions: [u128; 2],
    mid_fee: u128,
    out_fee: u128,
    fee_gamma: u128,
    donation: bool,
) -> Result<u128> {
    if donation {
        // Donations pay no imbalance fee; NOISE_FEE only, for numerical
        // stability.
        return Ok(CURVE_NOISE_FEE);
    }
    let before0 = balances_before[0];
    let before1 = balances_before[1];
    if before0 == 0 || before1 == 0 {
        return Ok(CURVE_NOISE_FEE);
    }

    let ratio_num = mul_div_u128(before0, precisions[0], 1, "calc_token_fee ratio_num")?;
    let ratio = mul_div_u128(
        ratio_num,
        WAD,
        mul_div_u128(before1, precisions[1], 1, "calc_token_fee ratio_den")?,
        "calc_token_fee ratio",
    )?;
    let amounts_scaled = curve_xp(amounts_received, ratio, precisions)?;
    let dynamic_fee = curve_fee(xp_after, mid_fee, out_fee, fee_gamma)?;
    let fee_prime = mul_div_u128(
        dynamic_fee,
        N_COINS,
        4u128 * (N_COINS - 1u128),
        "calc_token_fee fee_prime",
    )?;

    let s = add_u128(amounts_scaled[0], amounts_scaled[1], "calc_token_fee S")?;
    if s == 0 {
        return Ok(CURVE_NOISE_FEE);
    }
    let avg = s / N_COINS;
    let sdiff = amounts_scaled[0].abs_diff(avg) + amounts_scaled[1].abs_diff(avg);
    Ok(mul_div_u128(fee_prime, sdiff, s, "calc_token_fee final")? + CURVE_NOISE_FEE)
}

pub fn compute_d(cfg: &CurveQuoteConfig, state: &CurveQuoteState) -> Result<u128> {
    resolve_d(
        &cfg.math_mode,
        cfg.a,
        cfg.gamma,
        state.reserve0,
        state.reserve1,
        state.price_scale,
        cfg.precisions,
        0,
    )
}

pub fn quote_exact_input(
    cfg: &CurveQuoteConfig,
    state: &CurveQuoteState,
    token_in: &str,
    amount_in: u128,
) -> Result<u128> {
    if amount_in == 0 {
        return Ok(0);
    }
    let i = cfg.token_index(token_in)?;
    let j = 1usize - i;

    let mut balances = [state.reserve0, state.reserve1];
    balances[i] = add_u128(balances[i], amount_in, "curve quote balances[i]+amountIn")?;
    let xp = curve_xp(balances, state.price_scale, cfg.precisions)?;
    let d_used = if state.d > 0 {
        state.d
    } else {
        resolve_d(
            &cfg.math_mode,
            cfg.a,
            cfg.gamma,
            state.reserve0,
            state.reserve1,
            state.price_scale,
            cfg.precisions,
            0,
        )?
    };
    let (y_out, _) = get_y_for_mode(&cfg.math_mode, cfg.a, cfg.gamma, xp, d_used, j)?;
    let mut dy = sub_u128(xp[j], y_out, "curve quote dy=xp[j]-y_out")?;
    if dy == 0 {
        return Ok(0);
    }

    let mut xp_for_fee = xp;
    xp_for_fee[j] = y_out;

    dy = sub_u128(dy, 1, "curve quote dy-1")?;
    if j > 0 {
        dy = mul_div_u128(
            dy,
            WAD,
            state.price_scale,
            "curve quote denorm with priceScale",
        )?;
    }
    dy = dy / cfg.precisions[j];

    let fee = curve_fee(xp_for_fee, cfg.mid_fee, cfg.out_fee, cfg.fee_gamma)?;
    let fee_part = mul_div_u128(fee, dy, FEE_DENOMINATOR, "curve quote fee deduction")?;
    if fee_part >= dy {
        return Ok(0);
    }
    Ok(dy - fee_part)
}

/// Stateful quote output augmented with the dynamic fee that was actually
/// applied. The `fee_amount_out` and `fee_rate_1e10` fields are required by
/// the simulator to populate per-swap reporting (`feePaidUsd`,
/// `actualFeeBps`) without falling back on the static `mid_fee`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CurveQuoteWithFee {
    /// Final `amount_out` returned to the caller (post-fee, in token_out
    /// units).
    pub amount_out: u128,
    /// Fee amount measured in token_out units (matches Curve's on-chain
    /// fee-on-output convention). Equal to `dy_pre_fee - amount_out` when
    /// the swap clears the +1 / -1 floors.
    pub fee_amount_out: u128,
    /// Dynamic fee rate as returned by `curve_fee`, in Curve's
    /// `FEE_DENOMINATOR = 1e10` scale (e.g. `60_000_000` ≡ 6 bps).
    pub fee_rate_1e10: u128,
    /// `k0_prev` exposed for the stateful exchange path.
    pub k0_prev: u128,
}

fn quote_exact_input_with_k0_prev(
    cfg: &CurveQuoteConfig,
    state: &CurveQuoteState,
    token_in: &str,
    amount_in: u128,
) -> Result<CurveQuoteWithFee> {
    if amount_in == 0 {
        return Ok(CurveQuoteWithFee {
            amount_out: 0,
            fee_amount_out: 0,
            fee_rate_1e10: 0,
            k0_prev: 0,
        });
    }
    let i = cfg.token_index(token_in)?;
    let j = 1usize - i;

    let mut balances = [state.reserve0, state.reserve1];
    balances[i] = add_u128(
        balances[i],
        amount_in,
        "curve quote(stateful) balances[i]+amountIn",
    )?;
    let xp = curve_xp(balances, state.price_scale, cfg.precisions)?;
    let d_used = if state.d > 0 {
        state.d
    } else {
        resolve_d(
            &cfg.math_mode,
            cfg.a,
            cfg.gamma,
            state.reserve0,
            state.reserve1,
            state.price_scale,
            cfg.precisions,
            0,
        )?
    };
    let (y_out, k0_prev) = get_y_for_mode(&cfg.math_mode, cfg.a, cfg.gamma, xp, d_used, j)?;
    let mut dy = sub_u128(xp[j], y_out, "curve quote(stateful) dy=xp[j]-y_out")?;
    if dy == 0 {
        return Ok(CurveQuoteWithFee {
            amount_out: 0,
            fee_amount_out: 0,
            fee_rate_1e10: 0,
            k0_prev,
        });
    }

    let mut xp_for_fee = xp;
    xp_for_fee[j] = y_out;

    dy = sub_u128(dy, 1, "curve quote(stateful) dy-1")?;
    if j > 0 {
        dy = mul_div_u128(
            dy,
            WAD,
            state.price_scale,
            "curve quote(stateful) denorm with priceScale",
        )?;
    }
    dy = dy / cfg.precisions[j];

    let fee_rate_1e10 = curve_fee(xp_for_fee, cfg.mid_fee, cfg.out_fee, cfg.fee_gamma)?;
    let fee_part = mul_div_u128(
        fee_rate_1e10,
        dy,
        FEE_DENOMINATOR,
        "curve quote(stateful) fee deduction",
    )?;
    if fee_part >= dy {
        return Ok(CurveQuoteWithFee {
            amount_out: 0,
            fee_amount_out: fee_part,
            fee_rate_1e10,
            k0_prev,
        });
    }
    Ok(CurveQuoteWithFee {
        amount_out: dy - fee_part,
        fee_amount_out: fee_part,
        fee_rate_1e10,
        k0_prev,
    })
}

pub fn exchange_stateful(
    config: &CurveStatefulConfig,
    initial_state: CurveStatefulState,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
    disable_rebalance: bool,
) -> Result<CurveExchangeStatefulOut> {
    let i = config.quote.token_index(token_in)?;
    let j = 1usize - i;

    let curve_d = resolve_d(
        &config.quote.math_mode,
        config.quote.a,
        config.quote.gamma,
        initial_state.reserve0,
        initial_state.reserve1,
        initial_state.price_scale,
        config.quote.precisions,
        initial_state.d,
    )?;

    let quote_state = CurveQuoteState {
        reserve0: initial_state.reserve0,
        reserve1: initial_state.reserve1,
        price_scale: initial_state.price_scale,
        d: curve_d,
    };
    let CurveQuoteWithFee {
        amount_out,
        fee_amount_out,
        fee_rate_1e10,
        k0_prev,
    } = quote_exact_input_with_k0_prev(&config.quote, &quote_state, token_in, amount_in)?;
    // The reference pool rejects dust: dx must be > 0 and dy underflows
    // to a revert when the output rounds to zero.
    if amount_in == 0 || amount_out == 0 {
        return Err(anyhow!("curve_exchange_dust"));
    }
    let vp_preop = if initial_state.total_supply > 0 {
        mul_div_u128(
            WAD,
            curve_xcp(curve_d, initial_state.price_scale)?,
            initial_state.total_supply,
            "curve exchange vpPreop",
        )?
    } else {
        0
    };

    let mut balances = [initial_state.reserve0, initial_state.reserve1];
    balances[i] = add_u128(
        balances[i],
        amount_in,
        "curve exchange balance in + amountIn",
    )?;
    if amount_out > balances[j] {
        return Err(anyhow!("curve_output_exceeds_reserve"));
    }
    balances[j] = sub_u128(
        balances[j],
        amount_out,
        "curve exchange balance out - amountOut",
    )?;

    let xp = curve_xp(balances, initial_state.price_scale, config.quote.precisions)?;
    let d_new = compute_d_from_mode(
        &config.quote.math_mode,
        config.quote.a,
        config.quote.gamma,
        xp,
        k0_prev,
    )?;
    let mut state = build_state(config, initial_state);
    state.d = d_new;
    let rebalance_outcome = tweak_price_by_mode(
        &mut state,
        &config.quote.math_mode,
        xp,
        d_new,
        config.quote.a,
        config.quote.gamma,
        timestamp,
        disable_rebalance,
        vp_preop,
    )?;

    // Curve uses a `1e10` fee denominator. `1 bps = 1e6` units in that
    // scale, so dividing produces a faithful BPS readout (no rounding loss
    // for any fee that is an integer number of bps, which is always the
    // case for the configured `mid_fee` / `out_fee` and any convex
    // combination of them).
    let fee_bps_effective = (fee_rate_1e10 / 1_000_000u128) as u64;

    Ok(CurveExchangeStatefulOut {
        amount_out,
        reserve0: balances[0],
        reserve1: balances[1],
        curve_d: state.d,
        curve_price_scale: state.price_scale,
        curve_price_oracle: state.price_oracle,
        curve_last_prices: state.last_prices,
        curve_last_timestamp: state.last_timestamp,
        curve_virtual_price: state.virtual_price,
        curve_xcp_profit: state.xcp_profit,
        curve_lp_xcp_profit: state.lp_xcp_profit,
        curve_total_supply: state.total_supply,
        fee_amount_out,
        fee_bps_effective,
        rebalanced: rebalance_outcome.rebalanced,
        rebalance_blocked_by: rebalance_outcome.blocked_by,
        donation_shares_burned: rebalance_outcome.donation_shares_burned,
        curve_donation: state.donation,
    })
}

pub fn add_liquidity_stateful(
    config: &CurveStatefulConfig,
    initial_state: CurveStatefulState,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
    disable_rebalance: bool,
) -> Result<CurveAddLiquidityStatefulOut> {
    add_liquidity_inner(
        config,
        initial_state,
        amount0,
        amount1,
        timestamp,
        disable_rebalance,
        false,
    )
}

/// Donation entry point: liquidity is credited to the pool's donation
/// buffer (no LP shares reach a receiver), pays only NOISE_FEE, and
/// unlocks linearly over `CURVE_DONATION_DURATION_SEC`.
pub fn donate_stateful(
    config: &CurveStatefulConfig,
    initial_state: CurveStatefulState,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
    disable_rebalance: bool,
) -> Result<CurveAddLiquidityStatefulOut> {
    add_liquidity_inner(
        config,
        initial_state,
        amount0,
        amount1,
        timestamp,
        disable_rebalance,
        true,
    )
}

fn add_liquidity_inner(
    config: &CurveStatefulConfig,
    initial_state: CurveStatefulState,
    amount0: u128,
    amount1: u128,
    timestamp: u64,
    disable_rebalance: bool,
    donation: bool,
) -> Result<CurveAddLiquidityStatefulOut> {
    if amount0 == 0 && amount1 == 0 {
        return Err(anyhow!("curve_add_liquidity_stateful_zero_amounts"));
    }

    let old_balances = [initial_state.reserve0, initial_state.reserve1];
    let balances = [
        add_u128(old_balances[0], amount0, "curve add balances[0] + amount0")?,
        add_u128(old_balances[1], amount1, "curve add balances[1] + amount1")?,
    ];
    let xp = curve_xp(balances, initial_state.price_scale, config.quote.precisions)?;
    let old_d = resolve_d(
        &config.quote.math_mode,
        config.quote.a,
        config.quote.gamma,
        old_balances[0],
        old_balances[1],
        initial_state.price_scale,
        config.quote.precisions,
        initial_state.d,
    )?;
    let d = compute_d_from_mode(
        &config.quote.math_mode,
        config.quote.a,
        config.quote.gamma,
        xp,
        0,
    )?;

    let token_supply = initial_state.total_supply;
    let mut d_token = if old_d > 0 {
        sub_u128(
            mul_div_u128(token_supply, d, old_d, "curve add dToken ratio")?,
            token_supply,
            "curve add dToken - tokenSupply",
        )?
    } else {
        curve_xcp(d, initial_state.price_scale)?
    };
    if d_token == 0 {
        return Err(anyhow!("curve_add_liquidity_stateful_nothing_minted"));
    }

    if old_d > 0 {
        let token_fee = calc_token_fee(
            [amount0, amount1],
            xp,
            old_balances,
            config.quote.precisions,
            config.quote.mid_fee,
            config.quote.out_fee,
            config.quote.fee_gamma,
            donation,
        )?;
        let d_token_fee = add_u128(
            mul_div_u128(token_fee, d_token, FEE_DENOMINATOR, "curve add dTokenFee")?,
            1,
            "curve add dTokenFee + 1",
        )?;
        if d_token_fee >= d_token {
            return Err(anyhow!("curve_add_liquidity_stateful_fee_exceeds_mint"));
        }
        d_token = sub_u128(d_token, d_token_fee, "curve add dToken - fee")?;
    }

    let total_supply_after = add_u128(token_supply, d_token, "curve add totalSupply + dToken")?;
    let vp_preop = if old_d > 0 && token_supply > 0 {
        mul_div_u128(
            WAD,
            curve_xcp(old_d, initial_state.price_scale)?,
            token_supply,
            "curve add vpPreop",
        )?
    } else {
        0
    };
    let mut next_state = initial_state;
    next_state.total_supply = total_supply_after;
    let mut state = build_state(config, next_state);
    let mut donation_shares_burned = 0u128;
    if old_d > 0 {
        if donation {
            let new_donation_shares = add_u128(
                state.donation.shares,
                d_token,
                "curve donate shares + dToken",
            )?;
            if mul_div_u128(
                new_donation_shares,
                WAD,
                total_supply_after,
                "curve donate cap ratio",
            )? > CURVE_DONATION_SHARES_MAX_RATIO
            {
                return Err(anyhow!("curve_donation_above_cap"));
            }
            // Preserve the currently unlocked amount across overlapping
            // donations: shift `last_release_ts` as if one virtual donation
            // of the combined size had been linearly unlocking toward the
            // amount observed now.
            let unlocked_now = unlocked_donation_shares(&state.donation, timestamp, false)?;
            let new_elapsed = mul_div_u128(
                unlocked_now,
                u128::from(CURVE_DONATION_DURATION_SEC),
                new_donation_shares,
                "curve donate newElapsed",
            )?;
            state.donation.last_release_ts = timestamp.saturating_sub(new_elapsed as u64);
            state.donation.shares = new_donation_shares;
        } else if state.donation.shares > 0 {
            // Regular adds while donations are pending extend the sandwich
            // protection window; a sub-threshold carry disincentivizes
            // spamming dust adds.
            let relative_lp_add =
                mul_div_u128(d_token, WAD, total_supply_after, "curve add relativeLpAdd")?;
            if relative_lp_add > 0 {
                let raw_extension = add_u128(
                    relative_lp_add
                        .checked_mul(u128::from(CURVE_DONATION_PROTECTION_PERIOD_SEC))
                        .ok_or_else(|| anyhow!("curve add rawExtension overflow"))?,
                    state.donation.protection_extension_remainder,
                    "curve add rawExtension",
                )?;
                let extension_seconds =
                    (raw_extension / CURVE_DONATION_PROTECTION_LP_THRESHOLD) as u64;
                let current_expiry = state.donation.protection_expiry_ts.max(timestamp);
                let max_expiry = timestamp.saturating_add(CURVE_DONATION_PROTECTION_PERIOD_SEC);
                let uncapped_expiry = current_expiry.saturating_add(extension_seconds);
                if uncapped_expiry >= max_expiry {
                    state.donation.protection_expiry_ts = max_expiry;
                    state.donation.protection_extension_remainder = 0;
                } else {
                    state.donation.protection_expiry_ts = uncapped_expiry;
                    state.donation.protection_extension_remainder =
                        raw_extension % CURVE_DONATION_PROTECTION_LP_THRESHOLD;
                }
            }
        }
        donation_shares_burned = tweak_price_by_mode(
            &mut state,
            &config.quote.math_mode,
            xp,
            d,
            config.quote.a,
            config.quote.gamma,
            timestamp,
            disable_rebalance,
            vp_preop,
        )?
        .donation_shares_burned;
    } else {
        if donation {
            return Err(anyhow!("curve_donation_on_empty_pool"));
        }
        // Empty-pool genesis: baseline all three profit trackers and
        // lock MINIMUM_LIQUIDITY (minted to the pool itself on chain, so
        // total_supply keeps it while the receiver does not).
        if d_token <= CURVE_MINIMUM_LIQUIDITY {
            return Err(anyhow!("curve_add_liquidity_stateful_initial_too_low"));
        }
        d_token = sub_u128(d_token, CURVE_MINIMUM_LIQUIDITY, "curve add genesis minLiq")?;
        state.d = d;
        state.virtual_price = WAD;
        state.xcp_profit = WAD;
        state.lp_xcp_profit = WAD;
    }

    Ok(CurveAddLiquidityStatefulOut {
        minted_liquidity: d_token,
        amount0_used: amount0,
        amount1_used: amount1,
        reserve0: balances[0],
        reserve1: balances[1],
        curve_d: state.d,
        curve_price_scale: state.price_scale,
        curve_price_oracle: state.price_oracle,
        curve_last_prices: state.last_prices,
        curve_last_timestamp: state.last_timestamp,
        curve_virtual_price: state.virtual_price,
        curve_xcp_profit: state.xcp_profit,
        curve_lp_xcp_profit: state.lp_xcp_profit,
        curve_total_supply: state.total_supply,
        donation_shares_burned,
        curve_donation: state.donation,
    })
}

pub fn remove_liquidity_stateful(
    state: CurveStatefulState,
    liquidity: u128,
) -> Result<CurveRemoveLiquidityStatefulOut> {
    if liquidity == 0 {
        return Err(anyhow!("curve_remove_liquidity_stateful_zero_liquidity"));
    }

    let reserve0 = state.reserve0;
    let reserve1 = state.reserve1;
    let token_supply = state.total_supply;
    if token_supply == 0 {
        return Err(anyhow!("curve_remove_liquidity_stateful_zero_supply"));
    }
    if liquidity > token_supply {
        return Err(anyhow!(
            "curve_remove_liquidity_stateful_insufficient_supply"
        ));
    }

    let amount0_out = if liquidity == token_supply {
        reserve0
    } else {
        mul_div_u128(
            reserve0,
            liquidity,
            token_supply,
            "curve remove amount0_out",
        )?
    };
    let amount1_out = if liquidity == token_supply {
        reserve1
    } else {
        mul_div_u128(
            reserve1,
            liquidity,
            token_supply,
            "curve remove amount1_out",
        )?
    };

    let new_d = if state.d > 0 {
        sub_u128(
            state.d,
            mul_div_u128(state.d, liquidity, token_supply, "curve remove D reduction")?,
            "curve remove new_d",
        )?
    } else {
        0
    };

    Ok(CurveRemoveLiquidityStatefulOut {
        amount0_out,
        amount1_out,
        reserve0: sub_u128(reserve0, amount0_out, "curve remove reserve0")?,
        reserve1: sub_u128(reserve1, amount1_out, "curve remove reserve1")?,
        curve_d: new_d,
        curve_price_scale: state.price_scale,
        curve_price_oracle: state.price_oracle,
        curve_last_prices: state.last_prices,
        curve_last_timestamp: state.last_timestamp,
        curve_virtual_price: state.virtual_price,
        curve_xcp_profit: state.xcp_profit,
        curve_lp_xcp_profit: state.lp_xcp_profit,
        curve_total_supply: sub_u128(token_supply, liquidity, "curve remove totalSupply")?,
        curve_donation: state.donation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_with_explicit_d_matches_auto_resolve() {
        let cfg = CurveQuoteConfig::new(
            "0xaaa",
            "0xbbb",
            "stableswap".to_string(),
            100_000,
            0,
            3_000_000,
            3_000_000,
            1_000_000_000_000_000_000,
            [1, 1],
        );
        let base_state = CurveQuoteState {
            reserve0: 1_000_000_000_000_000_000_000,
            reserve1: 1_000_000_000_000_000_000_000,
            price_scale: 1_000_000_000_000_000_000,
            d: 0,
        };
        let d = compute_d(&cfg, &base_state).unwrap();
        let probes = [
            1u128,
            1_000_000u128,
            1_000_000_000u128,
            1_000_000_000_000u128,
        ];
        for amount_in in probes {
            let auto = quote_exact_input(&cfg, &base_state, "0xaaa", amount_in).unwrap();
            let explicit_d_state = CurveQuoteState { d, ..base_state };
            let typed = quote_exact_input(&cfg, &explicit_d_state, "0xaaa", amount_in).unwrap();
            assert_eq!(
                typed, auto,
                "curve quote with explicit D diverged for amount_in={amount_in}"
            );
        }
    }

    #[test]
    fn exchange_updates_reserves_and_runtime_fields() {
        let cfg = CurveStatefulConfig::new(
            CurveQuoteConfig::new(
                "0xaaa",
                "0xbbb",
                "stableswap".to_string(),
                100_000,
                0,
                3_000_000,
                3_000_000,
                1_000_000_000_000_000_000,
                [1, 1],
            ),
            0,
            0,
            0,
            600,
        );
        let state = CurveStatefulState {
            reserve0: 1_500_000_000_000_000_000_000,
            reserve1: 900_000_000_000_000_000_000,
            d: 0,
            price_scale: 1_000_000_000_000_000_000,
            price_oracle: 1_000_000_000_000_000_000,
            last_prices: 1_000_000_000_000_000_000,
            last_timestamp: 1_700_000_000,
            virtual_price: WAD,
            xcp_profit: WAD,
            lp_xcp_profit: WAD,
            total_supply: 1_000_000_000_000_000_000_000,
            donation: CurveDonationState::default(),
        };
        let amount_in = 1_000_000_000_000u128;
        let out = exchange_stateful(&cfg, state, "0xaaa", amount_in, 1_700_000_012, false).unwrap();
        assert!(out.amount_out > 0);
        assert!(out.reserve0 > state.reserve0);
        assert!(out.reserve1 < state.reserve1);
        assert!(out.curve_d > 0);
    }

    fn donation_test_config(step_max: u128) -> CurveStatefulConfig {
        CurveStatefulConfig::new(
            CurveQuoteConfig::new(
                "0xaaa",
                "0xbbb",
                "stableswap".to_string(),
                100_000,
                0,
                3_000_000,
                3_000_000,
                1_000_000_000_000_000_000,
                [1, 1],
            ),
            100_000_000, // 1e-10 dust dead-band
            step_max,
            3_010_101_009, // ~30.1% of profit growth to the LP floor
            600,
        )
    }

    fn donation_test_state() -> CurveStatefulState {
        CurveStatefulState {
            reserve0: 1_000_000_000_000_000_000_000_000,
            reserve1: 1_000_000_000_000_000_000_000_000,
            d: 0,
            price_scale: WAD,
            price_oracle: WAD,
            last_prices: WAD,
            last_timestamp: 1_700_000_000,
            virtual_price: WAD,
            xcp_profit: WAD,
            lp_xcp_profit: WAD,
            total_supply: 990_000_000_000_000_000_000_000,
            donation: CurveDonationState::default(),
        }
    }

    #[test]
    fn donation_credits_buffer_and_releases_linearly() {
        let cfg = donation_test_config(5_000_000_000_000_000);
        let state = donation_test_state();
        let t0 = 1_700_000_100u64;
        let amount0 = 10_000_000_000_000_000_000_000u128; // 0.5% of TVL
        let out = donate_stateful(&cfg, state, amount0, 0, t0, false).unwrap();
        assert!(out.minted_liquidity > 0);
        assert_eq!(out.curve_donation.shares, out.minted_liquidity);
        assert_eq!(out.curve_donation.last_release_ts, t0);
        // No LP owns the shares: supply grew by exactly the buffer credit.
        assert_eq!(
            out.curve_total_supply,
            state.total_supply + out.minted_liquidity
        );

        // Linear release: half unlocked at half the duration, all at the end.
        let half = unlocked_donation_shares(
            &out.curve_donation,
            t0 + CURVE_DONATION_DURATION_SEC / 2,
            true,
        )
        .unwrap();
        let full =
            unlocked_donation_shares(&out.curve_donation, t0 + CURVE_DONATION_DURATION_SEC, true)
                .unwrap();
        assert!(half >= out.minted_liquidity / 2 - 1 && half <= out.minted_liquidity / 2 + 1);
        assert_eq!(full, out.minted_liquidity);
    }

    #[test]
    fn donation_above_cap_is_rejected() {
        let cfg = donation_test_config(5_000_000_000_000_000);
        let state = donation_test_state();
        // ~20% of TVL in one donation blows through the 10% shares cap.
        let amount0 = 400_000_000_000_000_000_000_000u128;
        let err = donate_stateful(&cfg, state, amount0, 0, 1_700_000_100, false).unwrap_err();
        assert!(err.to_string().contains("curve_donation_above_cap"));
    }

    #[test]
    fn overlapping_donation_preserves_unlocked_amount() {
        let cfg = donation_test_config(5_000_000_000_000_000);
        let state = donation_test_state();
        let t0 = 1_700_000_100u64;
        let amount0 = 10_000_000_000_000_000_000_000u128;
        let first = donate_stateful(&cfg, state, amount0, 0, t0, false).unwrap();

        let t1 = t0 + CURVE_DONATION_DURATION_SEC / 4;
        let unlocked_before = unlocked_donation_shares(&first.curve_donation, t1, false).unwrap();

        let mut mid_state = state;
        mid_state.reserve0 = first.reserve0;
        mid_state.reserve1 = first.reserve1;
        mid_state.d = first.curve_d;
        mid_state.virtual_price = first.curve_virtual_price;
        mid_state.xcp_profit = first.curve_xcp_profit;
        mid_state.lp_xcp_profit = first.curve_lp_xcp_profit;
        mid_state.total_supply = first.curve_total_supply;
        mid_state.donation = first.curve_donation;
        mid_state.last_timestamp = t0;

        let second = donate_stateful(&cfg, mid_state, amount0, 0, t1, false).unwrap();
        let unlocked_after = unlocked_donation_shares(&second.curve_donation, t1, false).unwrap();
        // The virtual single-donation timestamp keeps the already-unlocked
        // amount intact up to the release quantum (one second's worth of
        // the combined buffer — the elapsed time is stored in whole
        // seconds).
        let release_quantum =
            second.curve_donation.shares / u128::from(CURVE_DONATION_DURATION_SEC) + 1;
        assert!(unlocked_after.abs_diff(unlocked_before) <= release_quantum);
        assert!(second.curve_donation.shares > first.curve_donation.shares);
    }

    #[test]
    fn donation_burn_unblocks_floor_gated_rebalance() {
        let cfg = donation_test_config(5_000_000_000_000_000); // 0.5% step cap
                                                               // Settle one swap to get a self-consistent (vp, floor) pair, then
                                                               // pin the floor at the live vp: the rebalance trigger still fires
                                                               // (fee growth), but the candidate move cannot be paid for from the
                                                               // profit cushion alone. The pool is imbalanced so the move has a
                                                               // first-order cost (step x reserve imbalance).
        let mut base = donation_test_state();
        base.reserve0 = 1_400_000_000_000_000_000_000_000;
        base.reserve1 = 600_000_000_000_000_000_000_000;
        base.total_supply = 900_000_000_000_000_000_000_000;
        let settled = exchange_stateful(
            &cfg,
            base,
            "0xaaa",
            1_000_000_000_000_000_000u128,
            1_700_000_100,
            false,
        )
        .unwrap();
        let mut state = base;
        state.reserve0 = settled.reserve0;
        state.reserve1 = settled.reserve1;
        state.d = settled.curve_d;
        state.virtual_price = settled.curve_virtual_price;
        state.xcp_profit = settled.curve_xcp_profit;
        state.total_supply = settled.curve_total_supply;
        state.last_timestamp = 1_700_000_100;
        state.lp_xcp_profit = settled.curve_virtual_price; // floor pinned at vp
                                                           // The deviation is organic: the imbalanced reserves price the pool
                                                           // above the anchor, and the EMA has been converging toward that
                                                           // marginal price since the settle op.
        state.price_oracle = settled.curve_price_oracle;
        state.last_prices = settled.curve_last_prices;

        let blocked = exchange_stateful(
            &cfg,
            state,
            "0xaaa",
            1_000_000_000_000_000_000u128,
            1_700_000_500,
            false,
        )
        .unwrap();
        assert!(!blocked.rebalanced);
        assert_eq!(
            blocked.rebalance_blocked_by,
            Some(CurveRebalanceGateBlocked::CommitVpBelowLpFloor)
        );

        // Same pool, but a donation seeded earlier and fully unlocked.
        let t0 = 1_700_000_500u64;
        let donated = donate_stateful(
            &cfg,
            state,
            30_000_000_000_000_000_000_000u128,
            0,
            t0,
            false,
        )
        .unwrap();
        let mut boosted = state;
        boosted.reserve0 = donated.reserve0;
        boosted.reserve1 = donated.reserve1;
        boosted.d = donated.curve_d;
        boosted.virtual_price = donated.curve_virtual_price;
        boosted.xcp_profit = donated.curve_xcp_profit;
        boosted.lp_xcp_profit = donated.curve_lp_xcp_profit;
        boosted.total_supply = donated.curve_total_supply;
        boosted.donation = donated.curve_donation;
        boosted.price_oracle = donated.curve_price_oracle;
        boosted.last_prices = donated.curve_last_prices;
        boosted.last_timestamp = t0;

        let ts = t0 + CURVE_DONATION_DURATION_SEC; // fully unlocked
        let out = exchange_stateful(
            &cfg,
            boosted,
            "0xaaa",
            1_000_000_000_000_000_000u128,
            ts,
            false,
        )
        .unwrap();
        assert!(out.rebalanced, "blocked by {:?}", out.rebalance_blocked_by);
        assert!(out.curve_price_scale > WAD);
        // The move was paid for by burning donation shares.
        assert!(out.curve_donation.shares < donated.curve_donation.shares);
        assert!(out.curve_total_supply < boosted.total_supply);
        // The LP floor survived the move.
        assert!(out.curve_virtual_price >= out.curve_lp_xcp_profit);
    }

    #[test]
    fn quote_crypto_mode_returns_positive_output() {
        let cfg = CurveQuoteConfig::new(
            "0xaaa",
            "0xbbb",
            "crypto".to_string(),
            90_000,
            20_000_000_000_000,
            60_000_000,
            75_000_000,
            500_000_000_000_000,
            [1, 1],
        );
        let mut state = CurveQuoteState {
            reserve0: 1_000_000_000_000_000_000_000,
            reserve1: 1_000_000_000_000_000_000_000,
            price_scale: WAD,
            d: 0,
        };
        state.d = compute_d(&cfg, &state).unwrap();
        let out = quote_exact_input(&cfg, &state, "0xaaa", 1_000_000_000_000).unwrap();
        assert!(out > 0);
    }

    #[test]
    fn exchange_stateful_crypto_updates_runtime_fields() {
        let cfg = CurveStatefulConfig::new(
            CurveQuoteConfig::new(
                "0xaaa",
                "0xbbb",
                "crypto".to_string(),
                90_000,
                20_000_000_000_000,
                60_000_000,
                75_000_000,
                500_000_000_000_000,
                [1, 1],
            ),
            0,
            0,
            0,
            600,
        );
        let state = CurveStatefulState {
            reserve0: 1_500_000_000_000_000_000_000,
            reserve1: 900_000_000_000_000_000_000,
            d: 0,
            price_scale: WAD,
            price_oracle: WAD,
            last_prices: WAD,
            last_timestamp: 1_700_000_000,
            virtual_price: WAD,
            xcp_profit: WAD,
            lp_xcp_profit: WAD,
            total_supply: 1_000_000_000_000_000_000_000,
            donation: CurveDonationState::default(),
        };
        let amount_in = 1_000_000_000_000u128;
        let out = exchange_stateful(&cfg, state, "0xaaa", amount_in, 1_700_000_012, false).unwrap();
        assert!(out.amount_out > 0);
        assert!(out.reserve0 > state.reserve0);
        assert!(out.reserve1 < state.reserve1);
        assert!(out.curve_d > 0);
    }

    #[test]
    fn exchange_stateful_crypto_handles_large_price_scale_without_u128_overflow() {
        let cfg = CurveStatefulConfig::new(
            CurveQuoteConfig::new(
                "0xaaa",
                "0xbbb",
                "crypto".to_string(),
                90_000,
                20_000_000_000_000,
                60_000_000,
                75_000_000,
                500_000_000_000_000,
                [1, 1],
            ),
            0,
            5_000_000_000_000_000,
            0,
            600,
        );

        // WBTC-like scale in token0/token1 units (USDT/base, 1e18-scaled).
        let price_scale = 100_000_000_000_000_000_000_000u128;
        let state = CurveStatefulState {
            reserve0: 1_000_000_000_000_000_000_000,
            // Keep xp roughly balanced for price_scale ~= 1e23:
            // reserve1 ~= reserve0 * 1e18 / price_scale.
            reserve1: 10_000_000_000_000_000,
            d: 0,
            price_scale,
            price_oracle: 110_000_000_000_000_000_000_000,
            last_prices: 110_000_000_000_000_000_000_000,
            last_timestamp: 1_700_000_000,
            virtual_price: 1,
            xcp_profit: 0,
            lp_xcp_profit: WAD,
            total_supply: 1_000_000_000_000_000_000,
            donation: CurveDonationState::default(),
        };

        let out = exchange_stateful(
            &cfg,
            state,
            "0xaaa",
            1_000_000_000_000,
            1_700_000_012,
            false,
        )
        .unwrap();
        assert!(out.amount_out > 0);
        assert!(out.curve_price_scale > 0);
    }

    /// Legacy `isqrt_biguint` seed (z = x): the historical implementation
    /// this file shipped with before the power-of-two seed. Kept here as
    /// the reference the reseeded variant is pinned against.
    fn isqrt_biguint_legacy(x: &BigUint) -> BigUint {
        if x.is_zero() {
            return BigUint::zero();
        }
        let mut z = x.clone();
        let mut y = (&z + BigUint::from(1u8)) >> 1usize;
        while y < z {
            z = y.clone();
            y = (&z + x / &z) >> 1usize;
        }
        z
    }

    #[test]
    fn isqrt_biguint_matches_legacy_seed_exactly() {
        let mut cases: Vec<BigUint> = Vec::new();
        // Small exhaustive band.
        for v in 0u32..=10 {
            cases.push(BigUint::from(v));
        }
        // Perfect squares and their neighbours (classic stop-condition
        // corners: s², s² − 1, s² + 1, s² + 2s = (s+1)² − 1).
        for s in [
            2u128,
            3,
            10,
            255,
            256,
            65_535,
            65_536,
            1_000_000_007,
            u64::MAX as u128,
        ] {
            let s_b = BigUint::from(s);
            let sq = &s_b * &s_b;
            if sq > BigUint::from(1u8) {
                cases.push(&sq - 1u8);
            }
            cases.push(sq.clone());
            cases.push(&sq + 1u8);
            cases.push(&sq + 2u8 * &s_b);
        }
        // ~2^500-scale values (the analytic cubic path produces sqrt args
        // far beyond U256).
        let big = BigUint::from(1u8) << 500usize;
        cases.push(big.clone());
        cases.push(&big - 1u8);
        cases.push(&big + 12_345u32);
        // A non-power-of-two ~500-bit composite.
        cases.push((BigUint::from(0xDEAD_BEEF_u64) << 470usize) + BigUint::from(987_654_321u64));

        for x in cases {
            let fast = isqrt_biguint(&x);
            let legacy = isqrt_biguint_legacy(&x);
            assert_eq!(fast, legacy, "isqrt mismatch for x={x}");
            // Independent floor-sqrt property check: z² ≤ x < (z+1)².
            assert!(&fast * &fast <= x, "isqrt too large for x={x}");
            let z1 = &fast + 1u8;
            assert!(&z1 * &z1 > x, "isqrt too small for x={x}");
        }
    }
}
