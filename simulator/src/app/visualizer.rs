use crate::runtime_quoter::{
    equilibra_math, CurveQuoteConfig, CurveQuoteState, LocalQuoter, UniswapV2QuoteConfig,
    UniswapV2QuoteState,
};
use anyhow::{anyhow, Context, Result};
use num_bigint::BigUint;
use num_traits::ToPrimitive;
use primitive_types::U256;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const TOKEN0: &str = "0x0000000000000000000000000000000000000001";
const TOKEN1: &str = "0x0000000000000000000000000000000000000002";
const USDT_DECIMALS: u32 = 6;
const PRECISION: u128 = 1_000_000_000_000_000_000u128;
const BPS: u128 = 10_000u128;
const MAX_SEARCH_ITER: usize = 96usize;
const PENALTY_SCALE: u128 = 1_000_000u128;
/// Visualizer fee for the Uniswap V2 reference curve. Set to **zero** so the
/// round-trip cell in `Isolated swap quotes` reflects only curve-shape
/// asymmetry (not LP fee). Mirrors the Equilibra/Curve config that already
/// runs at 0 bps in the visualizer for the same reason.
const UNISWAP_V2_FEE_BPS_DEFAULT: u64 = 0u64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerSeriesRequest {
    pub preset_key: String,
    pub samples: u64,
    pub max_depletion_bps: u64,
    #[serde(default)]
    pub initial_price: Option<f64>,
    pub curve: VisualizerCurveInput,
    pub equilibra: VisualizerEquilibraInput,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerCurveInput {
    pub math_mode: String,
    #[serde(alias = "A")]
    pub a: u64,
    pub gamma: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerEquilibraInput {
    /// Depth-at-anchor knob `a` (WAD). On-chain range
    /// `Constants.A_MIN_WAD..A_MAX_WAD` = `[1e17, 99e16]` (display
    /// `0.1..0.99`). The visualizer itself accepts the wider research
    /// band (display `0.01..0.99`) — only the factory enforces the
    /// production bounds.
    pub a_wad: String,
    /// Plateau-width knob `λ` (WAD). Range
    /// `Constants.LAMBDA_MIN_WAD..LAMBDA_MAX_WAD` = `[1e15, 1e18]`.
    pub lambda_wad: String,
}

/// Lightweight stateless Equilibra config used only by the visualizer
/// backend. Carries the cubic-kernel knobs plus pre-computed
/// per-token decimal scales — enough to invoke `equilibra_math` swap
/// helpers directly without spinning up a stateful pool wrapper.
#[derive(Debug, Clone)]
pub struct EquilibraVizConfig {
    pub token0_lower: String,
    pub token1_lower: String,
    pub token0_decimals: u8,
    pub token1_decimals: u8,
    pub token0_scale: U256,
    pub token1_scale: U256,
    pub a_wad: U256,
    pub lambda_wad: U256,
}

#[derive(Debug, Clone, Copy)]
pub struct EquilibraVizState {
    pub reserve0: u128,
    pub reserve1: u128,
    /// Pool price scale, WAD-scaled. The visualizer's quote helpers
    /// lift `(reserve0, reserve1)` into math-space via the asymmetric
    /// coord change `xMath = xWad`, `yMath = yWad·WAD/priceScale`.
    pub price_scale_wad: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerSeriesResponse {
    pub preset_key: String,
    pub initial_price: f64,
    pub slippage: VisualizerSlippageResponse,
    pub coverage: VisualizerCoverageResponse,
    pub isolated_swaps: VisualizerIsolatedSwapsResponse,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerSlippageResponse {
    pub equilibra: Vec<SerializableSeries>,
    pub uniswap_v2: Vec<SerializableSeries>,
    pub curve: Vec<SerializableSeries>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializableSeries {
    pub d: f64,
    pub penalty: Option<f64>,
    pub liquidity: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerCoverageResponse {
    pub equilibra: Vec<Option<f64>>,
    pub uniswap_v2: Vec<Option<f64>>,
    pub curve: Vec<Option<f64>>,
    pub sold_pct: Vec<f64>,
    pub table: Vec<CoverageBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageBucket {
    pub bucket: String,
    pub equilibra_from: Option<f64>,
    pub equilibra_to: Option<f64>,
    pub uniswap_from: Option<f64>,
    pub uniswap_to: Option<f64>,
    pub curve_from: Option<f64>,
    pub curve_to: Option<f64>,
}

/// Isolated-swap probe table response. For each step `pct` the backend:
///   1. swaps `pct%` of `base_reserve1` (token1, USDT) into each AMM
///      via `token1 → token0` — `amount_in` is *identical* across all
///      AMMs so the table reads as a side-by-side comparison;
///   2. captures each AMM's post-fwd state (mutates a clone) and probes
///      the marginal price there;
///   3. immediately reverses the *received* token0 amount back through
///      that same post-fwd state (`token0 → token1`) — `amount_in` of
///      the reverse leg is per-AMM (= each AMM's own fwd output);
///   4. discards the post-fwd clone before the next pct (no stateful
///      accumulation between rows — every row starts from the genesis
///      reserves).
///
/// Mirrors `test/math/UsdtWbtcAwayTowardTable.test.ts` semantically but
/// runs against the synthetic balanced visualiser pool so the same
/// shape comparison can be surfaced without a Hardhat node.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualizerIsolatedSwapsResponse {
    pub token0_symbol: String,
    pub token1_symbol: String,
    pub token0_decimals: u32,
    pub token1_decimals: u32,
    pub initial_price: f64,
    pub initial_reserve0: f64,
    pub initial_reserve1: f64,
    pub rows: Vec<IsolatedSwapRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedSwapRow {
    /// `pct% × base_reserve1` is the forward `amount_in` (token1, USDT).
    pub pct: f64,
    /// Human-readable row label ("1% — 5,000 USDT round-trip").
    pub label: String,
    /// Forward `amount_in` in token1 human units. Identical across all AMMs.
    pub amount_in: Option<f64>,
    /// Forward `amount_out` (token0, WBTC) per AMM.
    pub eq_fwd_out: Option<f64>,
    pub uni_fwd_out: Option<f64>,
    pub curve_fwd_out: Option<f64>,
    /// Reverse `amount_out` (token1, USDT) returned after swapping
    /// `<eq/uni/curve>FwdOut` back through the *same AMM's* post-fwd
    /// state. Lets the UI surface round-trip slippage cost as
    /// `amountIn − <amm>RevBack`.
    pub eq_rev_back: Option<f64>,
    pub uni_rev_back: Option<f64>,
    pub curve_rev_back: Option<f64>,
    /// Marginal price (USDT per WBTC) on each AMM's post-fwd state —
    /// captured *before* the reverse leg. Shows peak price displacement
    /// the forward leg pushed the pool to.
    pub eq_pmarg_post_fwd: Option<f64>,
    pub uni_pmarg_post_fwd: Option<f64>,
    pub curve_pmarg_post_fwd: Option<f64>,
}

#[derive(Debug, Clone)]
struct SeriesPoint {
    d_bps: u64,
    penalty: f64,
    liquidity: f64,
}

#[derive(Debug, Clone, Copy)]
struct TradeSolve {
    amount_in: u128,
    amount_out: u128,
    reached: bool,
}

#[derive(Debug, Clone)]
enum VisualizerAmmState {
    Equilibra {
        config: EquilibraVizConfig,
        state: EquilibraVizState,
    },
    Curve {
        config: CurveQuoteConfig,
        state: CurveQuoteState,
    },
    UniswapV2 {
        config: UniswapV2QuoteConfig,
        state: UniswapV2QuoteState,
    },
}

impl VisualizerAmmState {
    fn reserve0(&self) -> u128 {
        match self {
            Self::Equilibra { state, .. } => state.reserve0,
            Self::Curve { state, .. } => state.reserve0,
            Self::UniswapV2 { state, .. } => state.reserve0,
        }
    }

    fn reserve1(&self) -> u128 {
        match self {
            Self::Equilibra { state, .. } => state.reserve1,
            Self::Curve { state, .. } => state.reserve1,
            Self::UniswapV2 { state, .. } => state.reserve1,
        }
    }

    fn quote_exact_input(
        &self,
        quoter: &mut LocalQuoter,
        token_in: &str,
        amount_in: u128,
    ) -> Result<u128> {
        match self {
            Self::Equilibra { config, state } => {
                equilibra_viz_quote_exact_in(config, state, token_in, amount_in)
            }
            Self::Curve { config, state } => {
                quoter.quote_curve_exact_input(config, state, token_in, amount_in)
            }
            Self::UniswapV2 { config, state } => {
                quoter.quote_uniswap_v2_exact_input(config, state, token_in, amount_in)
            }
        }
    }

    fn update_after_swap(
        &mut self,
        zero_for_one: bool,
        amount_in: u128,
        amount_out: u128,
    ) -> Result<()> {
        macro_rules! apply {
            ($state:expr) => {{
                if zero_for_one {
                    $state.reserve0 = $state
                        .reserve0
                        .checked_add(amount_in)
                        .ok_or_else(|| anyhow!("reserve0 overflow in update_after_swap"))?;
                    $state.reserve1 = $state
                        .reserve1
                        .checked_sub(amount_out)
                        .ok_or_else(|| anyhow!("reserve1 underflow in update_after_swap"))?;
                } else {
                    $state.reserve1 = $state
                        .reserve1
                        .checked_add(amount_in)
                        .ok_or_else(|| anyhow!("reserve1 overflow in update_after_swap"))?;
                    $state.reserve0 = $state
                        .reserve0
                        .checked_sub(amount_out)
                        .ok_or_else(|| anyhow!("reserve0 underflow in update_after_swap"))?;
                }
            }};
        }
        match self {
            Self::Equilibra { state, .. } => apply!(state),
            Self::Curve { state, .. } => apply!(state),
            Self::UniswapV2 { state, .. } => apply!(state),
        }
        Ok(())
    }

    /// Full settlement: mirrors what the on-chain pool does in
    /// `_settleSwap`. Equilibra carries no per-swap reference cache,
    /// so settlement is just the reserve delta for every AMM. For
    /// the Curve V2 reference we also leave `state.d` untouched
    /// because that liquidity invariant only changes on
    /// add/remove-liquidity; recomputing it from post-swap reserves
    /// would silently break the round-trip cost accounting.
    fn settle_swap(&mut self, zero_for_one: bool, amount_in: u128, amount_out: u128) -> Result<()> {
        self.update_after_swap(zero_for_one, amount_in, amount_out)
    }
}

/// Stateless Equilibra exact-in quote helper used only by the
/// visualizer. Reaches straight into `equilibra_math` — no EMA, no
/// repeg, no fee accounting (the visualizer always probes the raw
/// curve shape). Mirrors the math-space lift inside
/// `EquilibraPool._computeExactInSwapMath` for the
/// coordinate change.
fn equilibra_viz_quote_exact_in(
    config: &EquilibraVizConfig,
    state: &EquilibraVizState,
    token_in: &str,
    amount_in: u128,
) -> Result<u128> {
    if amount_in == 0 {
        return Ok(0);
    }
    let zero_for_one = if token_in.eq_ignore_ascii_case(&config.token0_lower) {
        true
    } else if token_in.eq_ignore_ascii_case(&config.token1_lower) {
        false
    } else {
        return Err(anyhow!("equilibra_viz_quote: tokenIn not in pool"));
    };
    let price_scale = U256::from(state.price_scale_wad);
    let x_wad = U256::from(state.reserve1) * config.token1_scale;
    let y_wad = U256::from(state.reserve0) * config.token0_scale;
    if x_wad.is_zero() || y_wad.is_zero() {
        return Ok(0);
    }
    let (x_math, y_math) = equilibra_math::to_math_space(x_wad, y_wad, price_scale)?;
    if x_math.is_zero() || y_math.is_zero() {
        return Ok(0);
    }
    let (in_scale, out_scale) = if zero_for_one {
        (config.token0_scale, config.token1_scale)
    } else {
        (config.token1_scale, config.token0_scale)
    };
    let amount_in_wad = U256::from(amount_in) * in_scale;
    if amount_in_wad.is_zero() {
        return Ok(0);
    }
    // Asymmetric lift: zfo (quote) → yMath = divWad; !zfo (base) → xMath identity.
    let amount_in_math = if zero_for_one {
        equilibra_math::mul_div_floor(amount_in_wad, U256::from(equilibra_math::WAD), price_scale)?
    } else {
        amount_in_wad
    };
    if amount_in_math.is_zero() {
        return Ok(0);
    }
    let amount_out_wad = if zero_for_one {
        let (out_math, _) = equilibra_math::quote_exact_in_forward(
            y_math,
            x_math,
            amount_in_math,
            config.a_wad,
            config.lambda_wad,
        )?;
        if out_math >= x_math {
            return Ok(0);
        }
        // Output is xMath → token1 (base) wad identity.
        out_math
    } else {
        let (out_math, _) = equilibra_math::quote_exact_in_forward(
            x_math,
            y_math,
            amount_in_math,
            config.a_wad,
            config.lambda_wad,
        )?;
        if out_math >= y_math {
            return Ok(0);
        }
        // Output is yMath → token0 (quote) wad = math · priceScale / WAD (floor).
        equilibra_math::mul_wad(out_math, price_scale)?
    };
    let out_raw = amount_out_wad / out_scale;
    out_raw
        .try_into()
        .map_err(|_| anyhow!("amountOut exceeds u128"))
}

fn pow10_u128(exp: u32) -> Result<u128> {
    let mut out = 1u128;
    for _ in 0..exp {
        out = out
            .checked_mul(10)
            .ok_or_else(|| anyhow!("pow10 overflow"))?;
    }
    Ok(out)
}

fn parse_u128_decimal(value: &str, field: &str) -> Result<u128> {
    value
        .trim()
        .parse::<u128>()
        .with_context(|| format!("parse {field} as u128"))
}

fn mul_div_u128(a: u128, b: u128, denominator: u128, field: &str) -> Result<u128> {
    if denominator == 0 {
        return Err(anyhow!("{field}: denominator is zero"));
    }
    let out = (BigUint::from(a) * BigUint::from(b)) / BigUint::from(denominator);
    out.to_u128()
        .ok_or_else(|| anyhow!("{field}: result does not fit u128"))
}

fn token0_symbol_for_preset(preset_key: &str) -> Result<(&'static str, u32, u128)> {
    let (symbol, decimals) = match preset_key {
        "WETH" => ("WETH", 18),
        "WBTC" => ("WBTC", 8),
        _ => return Err(anyhow!("Invalid presetKey: expected WETH or WBTC")),
    };
    // Fallback display price comes from the same canonical accessor the
    // `equilibra-offchain-config-defaults` binary (and thus the TS
    // fixtures) consume — no duplicated literals here.
    let price_wad = crate::app::config::reference_test_price_wad(symbol)?;
    Ok((symbol, decimals, price_wad))
}

/// Convert a UI-supplied f64 price (token0 in token1) into a 1e18-scaled
/// `u128`. Validates positivity, finiteness and overflow against `u128::MAX`.
/// Visualizer-only helper — keeps the conversion logic single-sourced.
fn f64_price_to_wad(price: f64) -> Result<u128> {
    if !price.is_finite() || price <= 0.0 {
        return Err(anyhow!("initialPrice must be positive and finite"));
    }
    let scaled = price * PRECISION as f64;
    if !scaled.is_finite() || scaled < 1.0 || scaled > u128::MAX as f64 {
        return Err(anyhow!(
            "initialPrice {price} produces out-of-range WAD value"
        ));
    }
    Ok(scaled.round() as u128)
}

fn price_scale_from_token0_price(price_in_18: u128) -> Result<u128> {
    if price_in_18 == 0 {
        return Err(anyhow!("priceIn18 must be > 0"));
    }
    Ok(PRECISION
        .checked_mul(PRECISION)
        .ok_or_else(|| anyhow!("priceScale overflow mul"))?
        / price_in_18)
}

fn scaled_rate_from_quote(
    quoter: &mut LocalQuoter,
    amm_state: &VisualizerAmmState,
    token_in: &str,
    probe_in: u128,
) -> Result<u128> {
    let mut probe = probe_in.max(1);
    let probe_max = probe.saturating_mul(100);
    for _ in 0..8 {
        let out = amm_state.quote_exact_input(quoter, token_in, probe)?;
        if out > 0 {
            return Ok(out
                .checked_mul(PRECISION)
                .ok_or_else(|| anyhow!("scaled rate overflow"))?
                / probe);
        }
        if probe >= probe_max {
            break;
        }
        probe = (probe.saturating_mul(10)).min(probe_max);
    }
    Ok(0)
}

fn quote_exact_input_for_amm(
    quoter: &mut LocalQuoter,
    amm_state: &VisualizerAmmState,
    token_in: &str,
    amount_in: u128,
) -> Result<u128> {
    amm_state.quote_exact_input(quoter, token_in, amount_in)
}

/// Best-effort quote: returns `None` when the underlying kernel rejects the
/// amount (e.g. numerically unsafe inputs that would overflow the 512→256 bit
/// reduction inside `predict_target_price_exact_in` for small-decimal assets
/// such as WBTC). Used by the visualizer solver to skip "physically
/// unreachable" sample points rather than aborting the whole series.
fn try_quote_exact_input_for_amm(
    quoter: &mut LocalQuoter,
    amm_state: &VisualizerAmmState,
    token_in: &str,
    amount_in: u128,
) -> Option<u128> {
    quote_exact_input_for_amm(quoter, amm_state, token_in, amount_in).ok()
}

fn find_amount_in_for_target_out(
    quoter: &mut LocalQuoter,
    amm_state: &VisualizerAmmState,
    token_in: &str,
    reserve_in: u128,
    reserve_out: u128,
    target_out: u128,
) -> Result<TradeSolve> {
    if target_out == 0 {
        return Ok(TradeSolve {
            amount_in: 0,
            amount_out: 0,
            reached: true,
        });
    }
    let mut lo = 0u128;
    let mut hi = if reserve_out > target_out {
        reserve_in
            .saturating_mul(target_out)
            .checked_div(reserve_out - target_out)
            .unwrap_or(1)
            .max(1)
    } else {
        1
    };

    // Bracket `hi` upward. If the initial estimate is already rejected by the
    // kernel (huge raw amount × small-decimal scale → 512→256 overflow in
    // `predict_target_price`), halve it until we find a quotable amount.
    // `(best_hi, best_out)` retains the largest quotable sample so a later
    // rejection does not erase partial progress.
    let (mut best_hi, mut best_out, mut out_hi) =
        match try_quote_exact_input_for_amm(quoter, amm_state, token_in, hi) {
            Some(v) => (hi, v, v),
            None => {
                let mut fallback = hi;
                let mut found: Option<(u128, u128)> = None;
                for _ in 0..MAX_SEARCH_ITER {
                    fallback /= 2;
                    if fallback == 0 {
                        break;
                    }
                    if let Some(v) =
                        try_quote_exact_input_for_amm(quoter, amm_state, token_in, fallback)
                    {
                        found = Some((fallback, v));
                        break;
                    }
                }
                match found {
                    Some((h, v)) => {
                        hi = h;
                        (h, v, v)
                    }
                    None => {
                        return Ok(TradeSolve {
                            amount_in: 0,
                            amount_out: 0,
                            reached: false,
                        });
                    }
                }
            }
        };

    for _ in 0..MAX_SEARCH_ITER {
        if out_hi >= target_out {
            break;
        }
        let next_hi = hi.saturating_mul(2);
        if next_hi == hi {
            // `hi` saturated at `u128::MAX` — cannot go higher.
            return Ok(TradeSolve {
                amount_in: best_hi,
                amount_out: best_out,
                reached: best_out >= target_out,
            });
        }
        match try_quote_exact_input_for_amm(quoter, amm_state, token_in, next_hi) {
            Some(v) => {
                hi = next_hi;
                out_hi = v;
                if v > best_out {
                    best_hi = hi;
                    best_out = v;
                }
            }
            None => {
                // Kernel rejected the doubled amount as numerically unsafe
                // (e.g. WBTC preset at slider 99% depletion). Stop the ramp
                // and fall back to the largest quotable sample we've seen.
                return Ok(TradeSolve {
                    amount_in: best_hi,
                    amount_out: best_out,
                    reached: best_out >= target_out,
                });
            }
        }
    }
    if out_hi < target_out {
        return Ok(TradeSolve {
            amount_in: hi,
            amount_out: out_hi,
            reached: false,
        });
    }

    for _ in 0..MAX_SEARCH_ITER {
        if lo.saturating_add(1) >= hi {
            break;
        }
        let mid = lo + (hi - lo) / 2;
        match try_quote_exact_input_for_amm(quoter, amm_state, token_in, mid) {
            Some(out_mid) => {
                if out_mid >= target_out {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            None => {
                // Numerically unsafe `mid` — pull `hi` down so the next
                // bisection probes a smaller, quotable range.
                hi = mid;
            }
        }
    }

    let out_lo = if lo > 0 {
        try_quote_exact_input_for_amm(quoter, amm_state, token_in, lo).unwrap_or(0)
    } else {
        0
    };
    let out_at_hi = match try_quote_exact_input_for_amm(quoter, amm_state, token_in, hi) {
        Some(v) => v,
        None => best_out,
    };
    let err_lo = out_lo.abs_diff(target_out);
    let err_hi = out_at_hi.abs_diff(target_out);
    if err_lo <= err_hi && lo > 0 {
        Ok(TradeSolve {
            amount_in: lo,
            amount_out: out_lo,
            reached: true,
        })
    } else {
        Ok(TradeSolve {
            amount_in: hi,
            amount_out: out_at_hi,
            reached: true,
        })
    }
}

/// Monotonize the penalty axis over the *finite* samples only. Non-finite
/// samples mean the kernel produced NO quote at that depth — they must
/// survive as `f64::INFINITY` so `points_to_serializable` emits
/// `penalty: null` and the chart renders a gap / clip marker instead of a
/// fabricated flat plateau at the previous finite penalty. Finite samples
/// after a non-finite stretch still monotonize against the running max of
/// the finite prefix.
fn enforce_monotonic_penalty(points: &mut [SeriesPoint]) {
    let mut prev: Option<f64> = None;
    for point in points.iter_mut() {
        if point.penalty.is_finite() {
            let cur = point.penalty.max(0.0);
            let next = prev.map_or(cur, |p| p.max(cur));
            prev = Some(next);
            point.penalty = next;
        } else {
            point.penalty = f64::INFINITY;
        }
    }
}

fn build_liquidity(points: &[SeriesPoint]) -> Vec<f64> {
    let n = points.len();
    if n == 0 {
        return Vec::new();
    }
    let mut out = vec![0.0f64; n];
    for i in 0..n {
        let p0 = &points[i.saturating_sub(1)];
        let p1 = &points[(i + 1).min(n - 1)];
        let d0 = p0.d_bps as f64 / 10_000.0;
        let d1 = p1.d_bps as f64 / 10_000.0;
        let dd = d1 - d0;
        if dd <= 0.0 || !p0.penalty.is_finite() || !p1.penalty.is_finite() {
            out[i] = 0.0;
            continue;
        }
        let slope = (p1.penalty - p0.penalty) / dd;
        if !slope.is_finite() || slope <= 0.0 {
            out[i] = 0.0;
            continue;
        }
        let d = points[i].d_bps as f64 / 10_000.0;
        out[i] = ((1.0 - d) / slope).max(0.0);
    }
    out
}

fn enforce_monotonic_liquidity(points: &mut [SeriesPoint]) {
    if points.is_empty() {
        return;
    }
    let mut center = points[0].liquidity.max(0.0);
    if points.len() > 1 {
        center = center.max(points[1].liquidity.max(0.0));
    }
    if points.len() > 2 {
        center = center.max(points[2].liquidity.max(0.0));
    }
    points[0].liquidity = center;
    for i in 1..points.len() {
        let prev = points[i - 1].liquidity.max(0.0);
        let cur = points[i].liquidity.max(0.0);
        points[i].liquidity = prev.min(cur);
    }
}

fn interpolate_penalty(points: &[SeriesPoint], d_bps: u64) -> f64 {
    if points.is_empty() {
        return f64::INFINITY;
    }
    if d_bps <= points[0].d_bps {
        return points[0].penalty;
    }
    if d_bps >= points[points.len() - 1].d_bps {
        return points[points.len() - 1].penalty;
    }
    for i in 1..points.len() {
        let a = &points[i - 1];
        let b = &points[i];
        if d_bps <= b.d_bps {
            let width = (b.d_bps - a.d_bps) as f64;
            if width <= 0.0 {
                return b.penalty;
            }
            let t = (d_bps - a.d_bps) as f64 / width;
            return a.penalty + (b.penalty - a.penalty) * t;
        }
    }
    points[points.len() - 1].penalty
}

fn price_from_penalty(initial_price: f64, penalty: f64) -> Option<f64> {
    if !penalty.is_finite() {
        return None;
    }
    let v = initial_price * (1.0 + penalty);
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

fn price_from_penalty_for_bps(initial_price: f64, penalty: f64, bps: u64) -> Option<f64> {
    // Allow `bps == 10_000` so the last coverage bucket (90-100%) has a
    // finite `to` price. Values above 10_000 are still rejected defensively.
    if bps > 10_000 {
        return None;
    }
    price_from_penalty(initial_price, penalty)
}

/// P2 guard: like `price_from_penalty_for_bps`, but additionally returns
/// `None` for any `bps` strictly greater than the deepest *sampled* point
/// (`max_sampled_bps == req.max_depletion_bps`). Without this guard
/// `interpolate_penalty` clamps to the last sample's penalty, masking the
/// fact that the bucket sits beyond what the kernel actually quoted —
/// which the UI mis-renders as a finite "ceiling" price on the unreachable
/// tail. Returning `None` makes the table cell render as `-` and the
/// coverage chart drop a marker, matching the physical "no quote" state.
fn price_from_penalty_capped(
    initial_price: f64,
    penalty: f64,
    bps: u64,
    max_sampled_bps: u64,
) -> Option<f64> {
    if bps > max_sampled_bps {
        return None;
    }
    price_from_penalty_for_bps(initial_price, penalty, bps)
}

fn points_to_serializable(points: &[SeriesPoint]) -> Vec<SerializableSeries> {
    points
        .iter()
        .map(|p| SerializableSeries {
            d: p.d_bps as f64 / 10_000.0,
            penalty: if p.penalty.is_finite() {
                Some(p.penalty.max(0.0))
            } else {
                None
            },
            liquidity: if p.liquidity.is_finite() {
                p.liquidity.max(0.0)
            } else {
                0.0
            },
        })
        .collect()
}

fn build_coverage(
    initial_price: f64,
    eq: &[SeriesPoint],
    uni: &[SeriesPoint],
    curve: &[SeriesPoint],
    max_sampled_bps: u64,
) -> VisualizerCoverageResponse {
    let mut sold_pct = Vec::<f64>::new();
    let mut eq_prices = Vec::<Option<f64>>::new();
    let mut uni_prices = Vec::<Option<f64>>::new();
    let mut curve_prices = Vec::<Option<f64>>::new();
    for pct in 0..=100u64 {
        let bps = pct * 100;
        sold_pct.push(pct as f64);
        // P2: cap by `max_sampled_bps` — anything beyond that is unreachable
        // territory the kernel never quoted, so render as `None` instead of
        // extrapolating the last finite penalty.
        eq_prices.push(price_from_penalty_capped(
            initial_price,
            interpolate_penalty(eq, bps),
            bps,
            max_sampled_bps,
        ));
        uni_prices.push(price_from_penalty_capped(
            initial_price,
            interpolate_penalty(uni, bps),
            bps,
            max_sampled_bps,
        ));
        curve_prices.push(price_from_penalty_capped(
            initial_price,
            interpolate_penalty(curve, bps),
            bps,
            max_sampled_bps,
        ));
    }

    let mut table = Vec::<CoverageBucket>::new();
    for i in 0..10u64 {
        let from_bps = i * 1000;
        let to_bps_nominal = (i + 1) * 1000;
        // Skip vertical / unreachable buckets where even `from` is past
        // the sampled depth — emitting a fully empty row just confuses
        // the operator. With `max_depletion_bps >= 1000` this only
        // ever skips buckets at the deep tail.
        if from_bps >= max_sampled_bps {
            continue;
        }
        // Clamp `to_bps` to the deepest sample so the "last" bucket
        // shows the *reachable* slice instead of going dark — e.g. at
        // `max_depletion_bps = 9000` the 9th bucket renders as
        // "80-90%" with a finite `to` price; at `max_depletion_bps =
        // 9900` it renders as "90-99%". The label tracks the clamp so
        // the operator immediately sees how far the kernel actually
        // probed.
        let to_bps = to_bps_nominal.min(max_sampled_bps);
        let from_pct = i * 10;
        let to_pct_nominal = (i + 1) * 10;
        let bucket = if to_bps == to_bps_nominal {
            format!("{}-{}%", from_pct, to_pct_nominal)
        } else {
            // Render fractional pct as integer when the clamp lands on
            // a round 100 bps step (typical), else fall back to one
            // decimal so e.g. `max_depletion_bps = 9750` reads as
            // "90-97.5%" rather than rounding to "90-97%".
            let to_pct_int = max_sampled_bps / 100;
            let to_pct_frac = max_sampled_bps % 100;
            if to_pct_frac == 0 {
                format!("{}-{}%", from_pct, to_pct_int)
            } else {
                format!("{}-{}.{}%", from_pct, to_pct_int, to_pct_frac / 10)
            }
        };
        table.push(CoverageBucket {
            bucket,
            equilibra_from: price_from_penalty_capped(
                initial_price,
                interpolate_penalty(eq, from_bps),
                from_bps,
                max_sampled_bps,
            ),
            equilibra_to: price_from_penalty_capped(
                initial_price,
                interpolate_penalty(eq, to_bps),
                to_bps,
                max_sampled_bps,
            ),
            uniswap_from: price_from_penalty_capped(
                initial_price,
                interpolate_penalty(uni, from_bps),
                from_bps,
                max_sampled_bps,
            ),
            uniswap_to: price_from_penalty_capped(
                initial_price,
                interpolate_penalty(uni, to_bps),
                to_bps,
                max_sampled_bps,
            ),
            curve_from: price_from_penalty_capped(
                initial_price,
                interpolate_penalty(curve, from_bps),
                from_bps,
                max_sampled_bps,
            ),
            curve_to: price_from_penalty_capped(
                initial_price,
                interpolate_penalty(curve, to_bps),
                to_bps,
                max_sampled_bps,
            ),
        });
    }

    VisualizerCoverageResponse {
        equilibra: eq_prices,
        uniswap_v2: uni_prices,
        curve: curve_prices,
        sold_pct,
        table,
    }
}

/// Sample a single `d_bps` point on the slippage curve. Mirrors the per-point
/// loop body of the historical uniform sampler so it can be reused both for
/// the initial uniform pass and for adaptive subdivision.
fn sample_penalty_at_d_bps(
    quoter: &mut LocalQuoter,
    quote_state: &VisualizerAmmState,
    base_rate: u128,
    base_reserve_in: u128,
    base_reserve_out: u128,
    probe_in: u128,
    d_bps: u64,
) -> SeriesPoint {
    let token_in = TOKEN0;
    let mut sim_state = quote_state.clone();
    let target_out = base_reserve_out.saturating_mul(BPS.saturating_sub(d_bps as u128)) / BPS;
    if base_reserve_out > target_out {
        let need_out = base_reserve_out - target_out;
        let solved = match find_amount_in_for_target_out(
            quoter,
            &sim_state,
            token_in,
            base_reserve_in,
            base_reserve_out,
            need_out,
        ) {
            Ok(v) => v,
            Err(_) => {
                return SeriesPoint {
                    d_bps,
                    penalty: f64::INFINITY,
                    liquidity: 0.0,
                };
            }
        };
        if !solved.reached {
            return SeriesPoint {
                d_bps,
                penalty: f64::INFINITY,
                liquidity: 0.0,
            };
        }
        // `settle_swap` (vs raw `update_after_swap`) deliberately skips
        // recomputing Curve's `D` so the liquidity invariant persists
        // across swaps. Without this, round-trip quotes can yield
        // positive PnL, masking real slippage and producing
        // artefactual penalty curves.
        if sim_state
            .settle_swap(true, solved.amount_in, solved.amount_out)
            .is_err()
        {
            return SeriesPoint {
                d_bps,
                penalty: f64::INFINITY,
                liquidity: 0.0,
            };
        }
    }
    let rate = match scaled_rate_from_quote(quoter, &sim_state, token_in, probe_in) {
        Ok(v) => v,
        Err(_) => 0,
    };
    let penalty = if rate > 0 {
        (base_rate.saturating_mul(PENALTY_SCALE) / rate) as f64 / PENALTY_SCALE as f64 - 1.0
    } else {
        f64::INFINITY
    };
    SeriesPoint {
        d_bps,
        penalty: if penalty.is_finite() {
            penalty.max(0.0)
        } else {
            f64::INFINITY
        },
        liquidity: 0.0,
    }
}

/// Sample (penalty, liquidity-placeholder) at every d_bps in `grid` using the
/// same U256 quoter the on-chain pool uses. Does not perform adaptive
/// refinement and does not mutate the grid — used both for the uniform pass
/// before refinement and for re-sampling the *secondary* AMMs (Uniswap/Curve)
/// onto the grid that adaptive refinement settled on for Equilibra.
fn sample_uniform_at_grid(
    quoter: &mut LocalQuoter,
    quote_state: &VisualizerAmmState,
    baseline_state: &VisualizerAmmState,
    grid: &[u64],
) -> Result<Vec<SeriesPoint>> {
    let token_in = TOKEN0;
    let base_reserve_in = quote_state.reserve0();
    let base_reserve_out = quote_state.reserve1();
    let probe_in = (base_reserve_in / 1_000_000).max(1);
    // Base rate comes from a tiny probe swap on the baseline (fee-free) state.
    // If the kernel rejects this probe (extreme slider values pushing the
    // state distance `(y - x)²/(xy)` into a 512→256 overflow), we return
    // an all-unreachable series rather than a 400 — keeps the visualizer
    // responsive while the user tweaks parameters.
    let base_rate = match scaled_rate_from_quote(quoter, baseline_state, token_in, probe_in) {
        Ok(v) => v,
        Err(_) => 0,
    };
    if base_rate == 0 {
        return Ok(grid
            .iter()
            .map(|d| SeriesPoint {
                d_bps: *d,
                penalty: f64::INFINITY,
                liquidity: 0.0,
            })
            .collect());
    }

    let mut points: Vec<SeriesPoint> = Vec::with_capacity(grid.len());
    for &d_bps in grid {
        points.push(sample_penalty_at_d_bps(
            quoter,
            quote_state,
            base_rate,
            base_reserve_in,
            base_reserve_out,
            probe_in,
            d_bps,
        ));
    }
    Ok(points)
}

/// Adaptive refinement of `points` by inserting midpoints into segments with
/// the largest |Δpenalty| or those that straddle a finite ↔ unreachable
/// transition. Performed in two rounds with a budget of `base_n / 4` new
/// samples each — keeps the result ≤ 1.5×base_n while bringing visual
/// resolution close to true U256 behaviour at the curve's near-vertical tail.
///
/// Returns the refined point list (sorted by d_bps, deduplicated).
fn adaptive_refine_points(
    quoter: &mut LocalQuoter,
    quote_state: &VisualizerAmmState,
    baseline_state: &VisualizerAmmState,
    mut points: Vec<SeriesPoint>,
    base_n: usize,
) -> Result<Vec<SeriesPoint>> {
    if points.len() < 2 || base_n == 0 {
        return Ok(points);
    }

    // Re-derive base_rate / probe so adaptive midpoints reuse exactly the
    // same baseline as the uniform pass.
    let token_in = TOKEN0;
    let base_reserve_in = quote_state.reserve0();
    let base_reserve_out = quote_state.reserve1();
    let probe_in = (base_reserve_in / 1_000_000).max(1);
    let base_rate = match scaled_rate_from_quote(quoter, baseline_state, token_in, probe_in) {
        Ok(v) => v,
        Err(_) => return Ok(points),
    };
    if base_rate == 0 {
        return Ok(points);
    }

    for _round in 0..2 {
        if points.len() < 2 {
            break;
        }
        let mut prio: Vec<(f64, usize)> = Vec::with_capacity(points.len());
        for i in 0..points.len() - 1 {
            let a = &points[i];
            let b = &points[i + 1];
            if b.d_bps <= a.d_bps + 1 {
                continue;
            }
            let priority = match (a.penalty.is_finite(), b.penalty.is_finite()) {
                (true, true) => (b.penalty - a.penalty).abs(),
                (true, false) | (false, true) => f64::MAX / 2.0,
                (false, false) => continue,
            };
            prio.push((priority, i));
        }
        if prio.is_empty() {
            break;
        }
        prio.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let take = ((base_n / 4).max(4)).min(prio.len());
        let mut additions: Vec<SeriesPoint> = Vec::with_capacity(take);
        for &(_, i) in prio.iter().take(take) {
            let mid_bps = (points[i].d_bps + points[i + 1].d_bps) / 2;
            additions.push(sample_penalty_at_d_bps(
                quoter,
                quote_state,
                base_rate,
                base_reserve_in,
                base_reserve_out,
                probe_in,
                mid_bps,
            ));
        }
        points.append(&mut additions);
        points.sort_by_key(|p| p.d_bps);
        points.dedup_by_key(|p| p.d_bps);
    }

    Ok(points)
}

/// Apply the post-sampling smoothing pipeline: enforce monotonic penalty,
/// derive liquidity from finite differences, then enforce monotonic liquidity.
/// Centralised so the equilibra path and the uni/curve resample path produce
/// identical post-processing semantics.
fn finalize_points(points: &mut Vec<SeriesPoint>) {
    enforce_monotonic_penalty(points);
    let liquidity = build_liquidity(points);
    for (i, value) in liquidity.into_iter().enumerate() {
        points[i].liquidity = value;
    }
    enforce_monotonic_liquidity(points);
}

/// Build a fully-refined Equilibra series (uniform pass + adaptive refinement
/// + post-processing). Returns the refined point list whose d_bps grid is the
/// authoritative axis the other AMMs (Uniswap/Curve) re-sample onto.
fn build_series_for_amm(
    quoter: &mut LocalQuoter,
    quote_state: &VisualizerAmmState,
    baseline_state: &VisualizerAmmState,
    d_bps_list: &[u64],
) -> Result<Vec<SeriesPoint>> {
    let uniform = sample_uniform_at_grid(quoter, quote_state, baseline_state, d_bps_list)?;
    let mut refined = adaptive_refine_points(
        quoter,
        quote_state,
        baseline_state,
        uniform,
        d_bps_list.len(),
    )?;
    finalize_points(&mut refined);
    Ok(refined)
}

/// Re-sample a *secondary* AMM (Uniswap or Curve, both inherently smooth) at
/// the refined Equilibra grid. Skipping adaptive refinement here is safe —
/// the secondary curves never produce near-vertical slopes at typical bench
/// reserves, and forcing them onto the equilibra grid is the only way the
/// frontend's index-aligned chart datasets (`dVals[i] ↔ uniVals[i]`) can stay
/// coherent.
fn resample_secondary_at_grid(
    quoter: &mut LocalQuoter,
    quote_state: &VisualizerAmmState,
    baseline_state: &VisualizerAmmState,
    grid: &[u64],
) -> Result<Vec<SeriesPoint>> {
    let mut points = sample_uniform_at_grid(quoter, quote_state, baseline_state, grid)?;
    finalize_points(&mut points);
    Ok(points)
}

/// Sample a *coverage-only* point set: takes the chart's uniform grid and
/// augments it with the exact bucket boundaries (1000, 2000, ..., 9000 bps)
/// plus `max_depletion_bps` so the coverage table doesn't need to linearly
/// interpolate across the kernel's non-linear penalty curve at those
/// boundaries — the previous interpolated values could drift by 1-5% on
/// steep regions. Critically this pass does *not* feed back into the
/// chart series, so the central-difference liquidity calculation
/// continues to operate on uniform spacing and stays smooth.
///
/// We only run `enforce_monotonic_penalty` here (no liquidity / monotonic
/// liquidity), since the coverage table only consumes the penalty axis.
fn sample_coverage_grid(
    quoter: &mut LocalQuoter,
    quote_state: &VisualizerAmmState,
    baseline_state: &VisualizerAmmState,
    main_grid: &[u64],
    max_depletion_bps: u64,
) -> Result<Vec<SeriesPoint>> {
    let mut grid: Vec<u64> = main_grid.to_vec();
    for boundary in (1000u64..=9000u64).step_by(1000) {
        if boundary <= max_depletion_bps {
            grid.push(boundary);
        }
    }
    grid.push(max_depletion_bps);
    grid.sort_unstable();
    grid.dedup();
    let mut points = sample_uniform_at_grid(quoter, quote_state, baseline_state, &grid)?;
    enforce_monotonic_penalty(&mut points);
    Ok(points)
}

/// Convert a raw token amount (u128, native decimals) into a `f64` in
/// human units for serialisation. Returns `None` for amounts that don't
/// round-trip through `f64` cleanly (above ~1e15 of base units the
/// mantissa runs out — this is well past anything the visualiser
/// actually quotes, so emitting `None` lets the UI render `-` instead
/// of a silently rounded number).
fn raw_to_human(raw: u128, decimals: u32) -> Option<f64> {
    if raw == 0 {
        return Some(0.0);
    }
    let scale = match 10f64.powi(decimals as i32) {
        v if v.is_finite() && v > 0.0 => v,
        _ => return None,
    };
    let raw_f = raw as f64;
    if !raw_f.is_finite() {
        return None;
    }
    let v = raw_f / scale;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

/// Result bundle from running a single AMM's round-trip leg: forward
/// (token1 → token0), then reverse (token0 → token1) on the post-fwd
/// state. `pmarg_post_fwd` is captured *between* the two legs and is
/// the marginal price (USDT per WBTC) the pool would offer at peak
/// displacement — i.e. before the reverse leg pushes it back.
#[derive(Debug, Clone, Copy)]
struct RoundTripLeg {
    fwd_out_raw: u128,
    rev_back_raw: u128,
    pmarg_post_fwd: f64,
}

/// Settle a forward `token1 → token0` swap onto a cloned AMM state and
/// produce the reverse-leg quote + post-fwd marginal price. Returns
/// `None` for any failure (kernel rejection, overflow on update,
/// negative reserves) so the caller can render `-` for that AMM.
///
/// The reverse leg uses the *same* `fwd_out` as its `amount_in` —
/// (immediately after that swap, on the saved state, swap the received
/// token amount back). State is
/// dropped after this call; the next pct row starts from genesis.
fn run_round_trip_for_amm(
    quoter: &mut LocalQuoter,
    base_state: &VisualizerAmmState,
    fwd_amount_in: u128,
    fwd_amount_out: u128,
    token0_decimals: u32,
    token1_decimals: u32,
) -> Option<RoundTripLeg> {
    if fwd_amount_in == 0 || fwd_amount_out == 0 {
        return None;
    }
    let mut post = base_state.clone();
    // Forward leg was token1 → token0, so `zero_for_one = false`.
    // `settle_swap` (vs raw `update_after_swap`) is needed for Curve:
    // it deliberately skips recomputing `D`, since the liquidity
    // invariant must persist across swaps.
    post.settle_swap(false, fwd_amount_in, fwd_amount_out)
        .ok()?;

    let rev_back_raw = post
        .quote_exact_input(quoter, TOKEN0, fwd_amount_out)
        .ok()?;

    // Marginal price on the post-fwd state via a tiny token0 probe.
    // Uses the same probe sizing (`reserve0 / 1e6`, floor 1) as the
    // slippage-curve sampler so the displayed pMarg is consistent with
    // the chart's measured base rate.
    let probe_in = (post.reserve0() / 1_000_000).max(1);
    let probe_out = post.quote_exact_input(quoter, TOKEN0, probe_in).ok()?;
    let probe_in_h = raw_to_human(probe_in, token0_decimals)?;
    let probe_out_h = raw_to_human(probe_out, token1_decimals)?;
    let pmarg_post_fwd = if probe_in_h > 0.0 {
        probe_out_h / probe_in_h
    } else {
        return None;
    };

    Some(RoundTripLeg {
        fwd_out_raw: fwd_amount_out,
        rev_back_raw,
        pmarg_post_fwd,
    })
}

/// Build the round-trip probe table. Each row swaps `pct% × reserve1`
/// of token1 (USDT) into the pool, immediately swaps the *received*
/// token0 (WBTC) back through the post-fwd state, captures the post-fwd
/// marginal price, and discards the state before the next pct.
///
/// `amount_in` is identical across all AMMs so the user can read the
/// table as "for the same input, AMM X gives me Y, AMM Z gives me W,
/// and the round-trip costs me C". Reverse-leg `amount_in` is per-AMM
/// (it equals each AMM's own forward output).
fn build_isolated_swaps(
    quoter: &mut LocalQuoter,
    eq_state: &VisualizerAmmState,
    uni_state: &VisualizerAmmState,
    curve_state: &VisualizerAmmState,
    token0_symbol: &str,
    token1_symbol: &str,
    token0_decimals: u32,
    token1_decimals: u32,
    initial_price: f64,
) -> Result<VisualizerIsolatedSwapsResponse> {
    // Round-trip probe percentages — `pct% × base_reserve1` USDT goes
    // into the pool on the forward leg. Logarithmic-ish spacing so the
    // table covers shallow (1-10%) where AMM shapes diverge most plus
    // the deep tail (90-99%) where Equilibra's concentration kicks in.
    const ROUND_TRIP_PCTS: [u64; 14] = [1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99];

    let base_reserve_in = eq_state.reserve0();
    let base_reserve_out = eq_state.reserve1();
    if base_reserve_in == 0 || base_reserve_out == 0 {
        return Err(anyhow!(
            "isolated swaps: base reserves must be non-zero (r0={}, r1={})",
            base_reserve_in,
            base_reserve_out,
        ));
    }
    if uni_state.reserve0() != base_reserve_in
        || uni_state.reserve1() != base_reserve_out
        || curve_state.reserve0() != base_reserve_in
        || curve_state.reserve1() != base_reserve_out
    {
        return Err(anyhow!(
            "isolated swaps: AMM states must share base reserves"
        ));
    }

    let mut rows = Vec::<IsolatedSwapRow>::with_capacity(ROUND_TRIP_PCTS.len());

    for &pct in &ROUND_TRIP_PCTS {
        // `amount_in_token1 = pct% × reserve1`. At pct=99% this is
        // already enormous on most AMMs and many will partial-fill or
        // reject — we still emit the row, just with `None` cells where
        // the kernel said no.
        let amount_in_raw = base_reserve_out.saturating_mul(pct as u128) / 100;
        if amount_in_raw == 0 {
            continue;
        }

        // Forward leg: same `amount_in_raw` for every AMM. Each one
        // returns a different `fwd_out_raw` according to its curve
        // shape — that's the comparison signal we want.
        let eq_fwd_out_raw = eq_state
            .quote_exact_input(quoter, TOKEN1, amount_in_raw)
            .ok();
        let uni_fwd_out_raw = uni_state
            .quote_exact_input(quoter, TOKEN1, amount_in_raw)
            .ok();
        let curve_fwd_out_raw = curve_state
            .quote_exact_input(quoter, TOKEN1, amount_in_raw)
            .ok();

        // Settle + reverse + post-fwd pMarg per AMM. Each call clones
        // its own state, so there's no cross-AMM contamination.
        let eq_leg = match eq_fwd_out_raw {
            Some(o) if o > 0 => run_round_trip_for_amm(
                quoter,
                eq_state,
                amount_in_raw,
                o,
                token0_decimals,
                token1_decimals,
            ),
            _ => None,
        };
        let uni_leg = match uni_fwd_out_raw {
            Some(o) if o > 0 => run_round_trip_for_amm(
                quoter,
                uni_state,
                amount_in_raw,
                o,
                token0_decimals,
                token1_decimals,
            ),
            _ => None,
        };
        let curve_leg = match curve_fwd_out_raw {
            Some(o) if o > 0 => run_round_trip_for_amm(
                quoter,
                curve_state,
                amount_in_raw,
                o,
                token0_decimals,
                token1_decimals,
            ),
            _ => None,
        };

        let amount_in_h = raw_to_human(amount_in_raw, token1_decimals);
        // Label is just the percentage — the human-readable amountIn
        // already lives in its own column, no need to duplicate.
        let label = format!("{}%", pct);

        rows.push(IsolatedSwapRow {
            pct: pct as f64,
            label,
            amount_in: amount_in_h,
            eq_fwd_out: eq_leg.and_then(|l| raw_to_human(l.fwd_out_raw, token0_decimals)),
            uni_fwd_out: uni_leg.and_then(|l| raw_to_human(l.fwd_out_raw, token0_decimals)),
            curve_fwd_out: curve_leg.and_then(|l| raw_to_human(l.fwd_out_raw, token0_decimals)),
            eq_rev_back: eq_leg.and_then(|l| raw_to_human(l.rev_back_raw, token1_decimals)),
            uni_rev_back: uni_leg.and_then(|l| raw_to_human(l.rev_back_raw, token1_decimals)),
            curve_rev_back: curve_leg.and_then(|l| raw_to_human(l.rev_back_raw, token1_decimals)),
            eq_pmarg_post_fwd: eq_leg
                .map(|l| l.pmarg_post_fwd)
                .filter(|v| v.is_finite() && *v > 0.0),
            uni_pmarg_post_fwd: uni_leg
                .map(|l| l.pmarg_post_fwd)
                .filter(|v| v.is_finite() && *v > 0.0),
            curve_pmarg_post_fwd: curve_leg
                .map(|l| l.pmarg_post_fwd)
                .filter(|v| v.is_finite() && *v > 0.0),
        });
    }

    Ok(VisualizerIsolatedSwapsResponse {
        token0_symbol: token0_symbol.to_string(),
        token1_symbol: token1_symbol.to_string(),
        token0_decimals,
        token1_decimals,
        initial_price,
        initial_reserve0: raw_to_human(base_reserve_in, token0_decimals).unwrap_or(0.0),
        initial_reserve1: raw_to_human(base_reserve_out, token1_decimals).unwrap_or(0.0),
        rows,
    })
}

pub fn build_visualizer_series(raw_request: Value) -> Result<VisualizerSeriesResponse> {
    let req: VisualizerSeriesRequest = serde_json::from_value(raw_request)
        .map_err(|e| anyhow!("Invalid visualizer request: {e}"))?;
    if !(20..=400).contains(&req.samples) {
        return Err(anyhow!("Invalid samples: expected [20,400]"));
    }
    if !(1_000..=9_900).contains(&req.max_depletion_bps) {
        return Err(anyhow!("Invalid maxDepletionBps: expected [1000,9900]"));
    }
    if req.curve.math_mode != "crypto" && req.curve.math_mode != "stableswap" {
        return Err(anyhow!("Invalid curve.mathMode"));
    }
    let (token0_symbol, token0_decimals, fallback_price_wad) =
        token0_symbol_for_preset(&req.preset_key)?;
    let token1_symbol: &str = "USDT";

    // Resolve the *effective* token0 price (token0 in token1, 1e18-scaled).
    // The user-supplied `initialPrice` (oracle / market value) takes
    // precedence; falling back to the per-preset constant only if no input
    // is provided. **Same** value is then used for reserves, Equilibra
    // anchor and Curve `priceScale`, so all three AMMs share identical
    // baseline spot — no more "Equilibra anchored to 64k while Uniswap
    // spot is 102k" mismatch in the visualizer table.
    let effective_price_wad = match req.initial_price {
        Some(v) if v.is_finite() && v > 0.0 => f64_price_to_wad(v)?,
        _ => fallback_price_wad,
    };
    let initial_price = effective_price_wad as f64 / 1e18f64;

    // Per-side pool depth is derived from the benchmark's canonical
    // passive-LP deposit (`config::PASSIVE_LP_INITIAL_USD` split across
    // the two sides) so the visualizer's synthetic pool always matches
    // the depth a real benchmark run seeds.
    let half_usd: u128 = crate::app::config::visualizer_pool_half_depth_usd()?;
    let reserve1 = half_usd
        .checked_mul(pow10_u128(USDT_DECIMALS)?)
        .ok_or_else(|| anyhow!("reserve1 overflow"))?;
    let reserve0_nominal = half_usd
        .checked_mul(pow10_u128(token0_decimals)?)
        .ok_or_else(|| anyhow!("reserve0 overflow mul decimals"))?;
    let reserve0 = mul_div_u128(
        reserve0_nominal,
        PRECISION,
        effective_price_wad,
        "reserve0 base construction",
    )?;

    let eq_a_wad = parse_u128_decimal(&req.equilibra.a_wad, "equilibra.aWad")?;
    let eq_lambda_wad = parse_u128_decimal(&req.equilibra.lambda_wad, "equilibra.lambdaWad")?;

    // Genesis: priceScale = (r0·t0Scale) / (r1·t1Scale) = yWad / xWad
    // (quote-per-base, WAD). Matches `EquilibraPool.addLiquidity` (genesis
    // branch) — places the seeded reserves on the asymmetric math-space
    // diagonal so `yMath = yWad·WAD/priceScale = xWad = xMath` and the
    // cubic kernel evaluates at `D = 0` (full plateau). Reversing this
    // sign drives `D → ∞`, collapsing `A → 0` and degenerating the kernel
    // to pure constant-product — the curve visually fuses with Uniswap.
    let token1_scale = pow10_u128(18u32.saturating_sub(USDT_DECIMALS))?;
    let token0_scale = pow10_u128(18u32.saturating_sub(token0_decimals))?;
    let x_wad = reserve1
        .checked_mul(token1_scale)
        .ok_or_else(|| anyhow!("eq visualizer xWad overflow"))?;
    let y_wad = reserve0
        .checked_mul(token0_scale)
        .ok_or_else(|| anyhow!("eq visualizer yWad overflow"))?;
    let price_scale_wad = mul_div_u128(y_wad, PRECISION, x_wad, "eq visualizer price_scale_wad")?;
    let eq_config = EquilibraVizConfig {
        token0_lower: TOKEN0.to_lowercase(),
        token1_lower: TOKEN1.to_lowercase(),
        token0_decimals: token0_decimals as u8,
        token1_decimals: USDT_DECIMALS as u8,
        token0_scale: U256::from(token0_scale),
        token1_scale: U256::from(token1_scale),
        a_wad: U256::from(eq_a_wad),
        lambda_wad: U256::from(eq_lambda_wad),
    };

    let eq_state = VisualizerAmmState::Equilibra {
        config: eq_config,
        state: EquilibraVizState {
            reserve0,
            reserve1,
            price_scale_wad,
        },
    };
    let eq_baseline = eq_state.clone();
    let eq_state_chart = eq_state.clone();
    let eq_baseline_chart = eq_state_chart.clone();

    let curve_price_scale = price_scale_from_token0_price(effective_price_wad)?;
    let curve_precisions = [
        pow10_u128(18u32.saturating_sub(token0_decimals))?,
        pow10_u128(18u32.saturating_sub(USDT_DECIMALS))?,
    ];
    let curve_gamma = parse_u128_decimal(&req.curve.gamma, "curve.gamma")?;
    let curve_cfg = CurveQuoteConfig::new(
        TOKEN0,
        TOKEN1,
        req.curve.math_mode.clone(),
        u128::from(req.curve.a),
        curve_gamma,
        0,
        0,
        0,
        curve_precisions,
    );
    let mut quoter = LocalQuoter::new();
    let mut curve_quote_state = CurveQuoteState {
        reserve0,
        reserve1,
        price_scale: curve_price_scale,
        d: 0,
    };
    curve_quote_state.d = quoter.curve_compute_d(&curve_cfg, &curve_quote_state)?;
    let curve_state = VisualizerAmmState::Curve {
        config: curve_cfg.clone(),
        state: curve_quote_state,
    };
    let curve_baseline = curve_state.clone();

    let uniswap_state = VisualizerAmmState::UniswapV2 {
        config: UniswapV2QuoteConfig::new(TOKEN0, TOKEN1, UNISWAP_V2_FEE_BPS_DEFAULT)?,
        state: UniswapV2QuoteState { reserve0, reserve1 },
    };
    let uniswap_baseline = uniswap_state.clone();

    // Uniform sampling grid for the chart series (penalty / liquidity).
    // We deliberately keep this *uniform*: `build_liquidity` derives the
    // depth-per-d via central differences (`points[i-1]` ↔ `points[i+1]`),
    // so any non-uniform spacing — e.g. injecting bucket boundaries at
    // 1000/2000/.../9000 bps — produces visibly wavy / staircase
    // artefacts on the liquidity chart. Coverage-table accuracy at exact
    // bucket boundaries is solved separately via `sample_coverage_grid`,
    // which runs an independent sampling pass that does not feed into
    // the chart series.
    let mut d_bps_list = Vec::<u64>::with_capacity(req.samples as usize + 1);
    for i in 0..=req.samples {
        d_bps_list.push((req.max_depletion_bps.saturating_mul(i) + req.samples / 2) / req.samples);
    }

    // Equilibra is the cliff-prone curve, so we run the full uniform +
    // adaptive-refinement + post-processing pipeline on it first. The
    // resulting d_bps grid (≤ 1.5× the base) is the authoritative axis.
    // Use `eq_state_chart` (forced endpoint) so the chart remains smooth
    // independent of the user's selected aSeg mode.
    let eq_series = build_series_for_amm(
        &mut quoter,
        &eq_state_chart,
        &eq_baseline_chart,
        d_bps_list.as_slice(),
    )?;

    // Uniswap and Curve are inherently smooth — adaptive refinement would
    // never insert points there — but they still must share *exactly* the
    // same d_bps grid as Equilibra, otherwise the frontend's index-aligned
    // chart datasets (`dVals[i] ↔ uniVals[i] ↔ curveVals[i]`) drift and the
    // overlay curves visibly desynchronise. So we extract the refined grid
    // from `eq_series` and force the secondary AMMs onto it.
    let refined_grid: Vec<u64> = eq_series.iter().map(|p| p.d_bps).collect();

    let uni_series = resample_secondary_at_grid(
        &mut quoter,
        &uniswap_state,
        &uniswap_baseline,
        refined_grid.as_slice(),
    )?;
    let curve_series = resample_secondary_at_grid(
        &mut quoter,
        &curve_state,
        &curve_baseline,
        refined_grid.as_slice(),
    )?;

    // Independent coverage sampling pass — see `sample_coverage_grid`
    // for why this stays separate from the chart series. Uses the
    // *uniform* `d_bps_list` (not the post-refinement grid) as its
    // base so the boundary samples are interpolated against a known
    // smooth axis rather than competing with adaptive midpoints.
    // Coverage table also uses the chart-only (endpoint) state, so the
    // "Equilibra price range" column matches the rendered curve. Otherwise
    // a state-FP user would see endpoint-shaped chart but state-FP-priced
    // buckets — confusing. Round-trip semantics live in the isolated table.
    let eq_cov = sample_coverage_grid(
        &mut quoter,
        &eq_state_chart,
        &eq_baseline_chart,
        d_bps_list.as_slice(),
        req.max_depletion_bps,
    )?;
    let uni_cov = sample_coverage_grid(
        &mut quoter,
        &uniswap_state,
        &uniswap_baseline,
        d_bps_list.as_slice(),
        req.max_depletion_bps,
    )?;
    let curve_cov = sample_coverage_grid(
        &mut quoter,
        &curve_state,
        &curve_baseline,
        d_bps_list.as_slice(),
        req.max_depletion_bps,
    )?;

    // Build the isolated-swap probe table on the *baseline* AMM states
    // (no fees, fresh reserves) so the per-AMM `amount_in` differences
    // reflect curve shape rather than recentering / EMA bookkeeping.
    let isolated_swaps = build_isolated_swaps(
        &mut quoter,
        &eq_baseline,
        &uniswap_baseline,
        &curve_baseline,
        token0_symbol,
        token1_symbol,
        token0_decimals,
        USDT_DECIMALS,
        initial_price,
    )?;

    Ok(VisualizerSeriesResponse {
        preset_key: req.preset_key,
        initial_price,
        slippage: VisualizerSlippageResponse {
            equilibra: points_to_serializable(eq_series.as_slice()),
            uniswap_v2: points_to_serializable(uni_series.as_slice()),
            curve: points_to_serializable(curve_series.as_slice()),
        },
        coverage: build_coverage(
            initial_price,
            eq_cov.as_slice(),
            uni_cov.as_slice(),
            curve_cov.as_slice(),
            req.max_depletion_bps,
        ),
        isolated_swaps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(d_bps: u64, penalty: f64) -> SeriesPoint {
        SeriesPoint {
            d_bps,
            penalty,
            liquidity: 0.0,
        }
    }

    /// A finite prefix followed by an unreachable (INFINITY) tail must
    /// survive the full post-processing pipeline with the tail serialized
    /// as `penalty: null` — the chart shows a gap where the kernel has NO
    /// quote instead of a fabricated flat plateau.
    #[test]
    fn finalize_points_preserves_unreachable_tail() {
        let mut points = vec![
            point(0, 0.0),
            point(100, 0.5),
            point(200, 1.5),
            point(300, f64::INFINITY),
            point(400, f64::INFINITY),
        ];
        finalize_points(&mut points);
        assert!(points[0].penalty.is_finite());
        assert!(points[1].penalty.is_finite());
        assert!(points[2].penalty.is_finite());
        assert!(points[3].penalty.is_infinite());
        assert!(points[4].penalty.is_infinite());

        let ser = points_to_serializable(points.as_slice());
        assert_eq!(ser[0].penalty, Some(0.0));
        assert_eq!(ser[1].penalty, Some(0.5));
        assert_eq!(ser[2].penalty, Some(1.5));
        assert_eq!(ser[3].penalty, None);
        assert_eq!(ser[4].penalty, None);
        // Liquidity around non-finite endpoints stays zeroed, never NaN.
        for p in &ser {
            assert!(p.liquidity.is_finite());
        }
    }

    /// An all-unreachable series (e.g. the baseline probe failed for an
    /// unquotable config) must serialize as all-null, not all-zero.
    #[test]
    fn all_unreachable_series_serializes_as_all_null() {
        let mut points = vec![
            point(0, f64::INFINITY),
            point(100, f64::INFINITY),
            point(200, f64::INFINITY),
        ];
        finalize_points(&mut points);
        let ser = points_to_serializable(points.as_slice());
        assert!(ser.iter().all(|p| p.penalty.is_none()));
    }

    /// Finite samples after a non-finite stretch still monotonize against
    /// the finite prefix; interior gaps stay non-finite.
    #[test]
    fn monotonic_penalty_bridges_interior_gap_over_finite_prefix() {
        let mut points = vec![
            point(0, 0.4),
            point(100, f64::INFINITY),
            point(200, 0.1),
            point(300, 0.9),
        ];
        enforce_monotonic_penalty(&mut points);
        assert_eq!(points[0].penalty, 0.4);
        assert!(points[1].penalty.is_infinite());
        // 0.1 lifts to the running max of the finite prefix (0.4).
        assert_eq!(points[2].penalty, 0.4);
        assert_eq!(points[3].penalty, 0.9);
    }

    /// Coverage price mapping: an unreachable (non-finite) penalty must
    /// yield `None` (rendered as `-`), a reachable one an unchanged price.
    #[test]
    fn coverage_price_mapping_keeps_unreachable_unreachable() {
        let pts = vec![
            point(0, 0.0),
            point(1_000, 1.0),
            point(2_000, f64::INFINITY),
        ];
        // Reachable bucket boundary: finite penalty, finite price.
        let p_fin = interpolate_penalty(&pts, 1_000);
        assert_eq!(p_fin, 1.0);
        assert_eq!(
            price_from_penalty_capped(100.0, p_fin, 1_000, 9_000),
            Some(200.0)
        );
        // Unreachable sample: non-finite penalty maps to None.
        let p_inf = interpolate_penalty(&pts, 2_000);
        assert!(!p_inf.is_finite());
        assert_eq!(price_from_penalty_capped(100.0, p_inf, 2_000, 9_000), None);
        // Beyond the sampled depth: capped to None regardless of penalty.
        assert_eq!(price_from_penalty_capped(100.0, 1.0, 9_500, 9_000), None);
    }
}
