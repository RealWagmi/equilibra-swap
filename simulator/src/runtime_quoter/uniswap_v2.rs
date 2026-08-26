use anyhow::{anyhow, Result};
use num_bigint::BigUint;
use num_traits::ToPrimitive;

const TS_MOD: u64 = 1u64 << 32;
const Q112_SHIFT: usize = 112usize;
const FEE_DENOMINATOR: u128 = 10_000u128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniswapV2QuoteConfig {
    token0_lower: String,
    token1_lower: String,
    fee_bps: u64,
    amount_in_multiplier: u128,
}

impl UniswapV2QuoteConfig {
    pub fn new(token0: &str, token1: &str, fee_bps: u64) -> Result<Self> {
        if fee_bps >= FEE_DENOMINATOR as u64 {
            return Err(anyhow!(
                "uniswap_v2 invalid fee_bps={}, must be < {}",
                fee_bps,
                FEE_DENOMINATOR
            ));
        }
        let amount_in_multiplier = FEE_DENOMINATOR
            .checked_sub(u128::from(fee_bps))
            .ok_or_else(|| anyhow!("uniswap_v2 fee denominator underflow"))?;
        Ok(Self {
            token0_lower: token0.to_lowercase(),
            token1_lower: token1.to_lowercase(),
            fee_bps,
            amount_in_multiplier,
        })
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
pub struct UniswapV2QuoteState {
    pub reserve0: u128,
    pub reserve1: u128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniswapV2StatefulState {
    pub reserve0: u128,
    pub reserve1: u128,
    pub block_timestamp_last: u32,
    pub price0_cumulative_last: String,
    pub price1_cumulative_last: String,
    pub k_last: String,
}

#[derive(Debug, Clone)]
pub struct UniswapV2SwapStatefulOut {
    pub amount_out: u128,
    pub reserve0: u128,
    pub reserve1: u128,
    pub block_timestamp_last: u32,
    pub price0_cumulative_last: String,
    pub price1_cumulative_last: String,
    pub k_last: String,
}

/// Numeric-counter variant of [`UniswapV2StatefulState`]. The TWAP
/// accumulators and `k_last` are held as `BigUint` so a stateful caller
/// can parse the decimal strings once at its trace-input boundary and
/// format once at its trace-output boundary instead of round-tripping
/// String ⇄ BigUint on every swap. Semantically identical to the String
/// variant: [`swap_stateful`] is a thin parse/format wrapper around
/// [`swap_stateful_numeric`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniswapV2StatefulNumericState {
    pub reserve0: u128,
    pub reserve1: u128,
    pub block_timestamp_last: u32,
    pub price0_cumulative_last: BigUint,
    pub price1_cumulative_last: BigUint,
    pub k_last: BigUint,
}

#[derive(Debug, Clone)]
pub struct UniswapV2SwapStatefulNumericOut {
    pub amount_out: u128,
    pub reserve0: u128,
    pub reserve1: u128,
    pub block_timestamp_last: u32,
    pub price0_cumulative_last: BigUint,
    pub price1_cumulative_last: BigUint,
    pub k_last: BigUint,
}

fn quote_out(
    reserve_in: u128,
    reserve_out: u128,
    amount_in: u128,
    amount_in_multiplier: u128,
) -> Result<u128> {
    if amount_in == 0 || reserve_in == 0 || reserve_out == 0 {
        return Ok(0);
    }
    let amount_in_with_fee = amount_in
        .checked_mul(amount_in_multiplier)
        .ok_or_else(|| anyhow!("uniswap quote amount_in_with_fee overflow"))?;
    let numerator = BigUint::from(amount_in_with_fee) * BigUint::from(reserve_out);
    let denominator = BigUint::from(reserve_in) * BigUint::from(FEE_DENOMINATOR)
        + BigUint::from(amount_in_with_fee);
    if denominator == BigUint::from(0u8) {
        return Ok(0);
    }
    (numerator / denominator)
        .to_u128()
        .ok_or_else(|| anyhow!("uniswap quote output overflow u128"))
}

fn parse_biguint_or_zero(dec: &str, field: &str) -> Result<BigUint> {
    let trimmed = dec.trim();
    if trimmed.is_empty() {
        return Ok(BigUint::from(0u8));
    }
    BigUint::parse_bytes(trimmed.as_bytes(), 10)
        .ok_or_else(|| anyhow!("invalid decimal bigint in {}", field))
}

pub fn quote_exact_input(
    config: &UniswapV2QuoteConfig,
    state: &UniswapV2QuoteState,
    token_in: &str,
    amount_in: u128,
) -> Result<u128> {
    if amount_in == 0 {
        return Ok(0);
    }
    let i = config.token_index(token_in)?;
    let (reserve_in, reserve_out) = if i == 0 {
        (state.reserve0, state.reserve1)
    } else {
        (state.reserve1, state.reserve0)
    };

    quote_out(
        reserve_in,
        reserve_out,
        amount_in,
        config.amount_in_multiplier,
    )
}

/// String-boundary wrapper around [`swap_stateful_numeric`]: parses the
/// three decimal counters once on entry (same trim / empty-as-zero
/// semantics as ever) and formats them once on exit. Output is
/// byte-identical to the historical all-in-one implementation.
pub fn swap_stateful(
    config: &UniswapV2QuoteConfig,
    state: &UniswapV2StatefulState,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
) -> Result<UniswapV2SwapStatefulOut> {
    let numeric_state = UniswapV2StatefulNumericState {
        reserve0: state.reserve0,
        reserve1: state.reserve1,
        block_timestamp_last: state.block_timestamp_last,
        price0_cumulative_last: parse_biguint_or_zero(
            &state.price0_cumulative_last,
            "price0_cumulative_last",
        )?,
        price1_cumulative_last: parse_biguint_or_zero(
            &state.price1_cumulative_last,
            "price1_cumulative_last",
        )?,
        k_last: parse_biguint_or_zero(&state.k_last, "k_last")?,
    };
    let out = swap_stateful_numeric(config, &numeric_state, token_in, amount_in, timestamp)?;
    Ok(UniswapV2SwapStatefulOut {
        amount_out: out.amount_out,
        reserve0: out.reserve0,
        reserve1: out.reserve1,
        block_timestamp_last: out.block_timestamp_last,
        price0_cumulative_last: out.price0_cumulative_last.to_string(),
        price1_cumulative_last: out.price1_cumulative_last.to_string(),
        k_last: out.k_last.to_string(),
    })
}

/// Core stateful swap on numeric TWAP counters. `k_last` participates in
/// no arithmetic — it is moved through unchanged (cheap limb copy).
pub fn swap_stateful_numeric(
    config: &UniswapV2QuoteConfig,
    state: &UniswapV2StatefulNumericState,
    token_in: &str,
    amount_in: u128,
    timestamp: u64,
) -> Result<UniswapV2SwapStatefulNumericOut> {
    let i = config.token_index(token_in)?;
    let reserve0 = state.reserve0;
    let reserve1 = state.reserve1;
    let (reserve_in, reserve_out) = if i == 0 {
        (reserve0, reserve1)
    } else {
        (reserve1, reserve0)
    };
    let amount_out = quote_out(
        reserve_in,
        reserve_out,
        amount_in,
        config.amount_in_multiplier,
    )?;
    if amount_out == 0 || amount_out >= reserve_out {
        return Err(anyhow!("uniswap_v2_insufficient_output"));
    }

    let amount0_out = if i == 0 { 0u128 } else { amount_out };
    let amount1_out = if i == 0 { amount_out } else { 0u128 };
    let balance0 = if i == 0 {
        reserve0
            .checked_add(amount_in)
            .ok_or_else(|| anyhow!("uniswap_v2 balance0 overflow"))?
    } else {
        reserve0
            .checked_sub(amount_out)
            .ok_or_else(|| anyhow!("uniswap_v2 balance0 underflow"))?
    };
    let balance1 = if i == 0 {
        reserve1
            .checked_sub(amount_out)
            .ok_or_else(|| anyhow!("uniswap_v2 balance1 underflow"))?
    } else {
        reserve1
            .checked_add(amount_in)
            .ok_or_else(|| anyhow!("uniswap_v2 balance1 overflow"))?
    };

    let amount0_in = if balance0 > reserve0.saturating_sub(amount0_out) {
        balance0 - reserve0.saturating_sub(amount0_out)
    } else {
        0
    };
    let amount1_in = if balance1 > reserve1.saturating_sub(amount1_out) {
        balance1 - reserve1.saturating_sub(amount1_out)
    } else {
        0
    };
    if amount0_in == 0 && amount1_in == 0 {
        return Err(anyhow!("uniswap_v2_insufficient_input"));
    }

    let balance0_adjusted = BigUint::from(balance0) * BigUint::from(FEE_DENOMINATOR)
        - BigUint::from(amount0_in) * BigUint::from(config.fee_bps);
    let balance1_adjusted = BigUint::from(balance1) * BigUint::from(FEE_DENOMINATOR)
        - BigUint::from(amount1_in) * BigUint::from(config.fee_bps);
    let lhs = &balance0_adjusted * &balance1_adjusted;
    let rhs = BigUint::from(reserve0)
        * BigUint::from(reserve1)
        * BigUint::from(FEE_DENOMINATOR)
        * BigUint::from(FEE_DENOMINATOR);
    if lhs < rhs {
        return Err(anyhow!("uniswap_v2_k_invariant"));
    }

    let block_timestamp = (timestamp % TS_MOD) as u32;
    let block_timestamp_last = state.block_timestamp_last;
    let time_elapsed =
        ((u64::from(block_timestamp) + TS_MOD) - u64::from(block_timestamp_last)) % TS_MOD;

    let mut price0_cumulative_last = state.price0_cumulative_last.clone();
    let mut price1_cumulative_last = state.price1_cumulative_last.clone();
    if time_elapsed > 0 && reserve0 > 0 && reserve1 > 0 {
        let price0 = (BigUint::from(reserve1) << Q112_SHIFT) / BigUint::from(reserve0);
        let price1 = (BigUint::from(reserve0) << Q112_SHIFT) / BigUint::from(reserve1);
        let dt = BigUint::from(time_elapsed);
        price0_cumulative_last += price0 * &dt;
        price1_cumulative_last += price1 * dt;
    }

    Ok(UniswapV2SwapStatefulNumericOut {
        amount_out,
        reserve0: balance0,
        reserve1: balance1,
        block_timestamp_last: block_timestamp,
        price0_cumulative_last,
        price1_cumulative_last,
        k_last: state.k_last.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn higher_fee_reduces_quote_output() {
        let low_fee_cfg = UniswapV2QuoteConfig::new("A", "B", 30).expect("low-fee config");
        let high_fee_cfg = UniswapV2QuoteConfig::new("A", "B", 100).expect("high-fee config");
        let state = UniswapV2QuoteState {
            reserve0: 1_000_000_000u128,
            reserve1: 1_000_000_000u128,
        };
        let amount_in = 10_000_000u128;

        let out_low = quote_exact_input(&low_fee_cfg, &state, "A", amount_in).expect("quote low");
        let out_high =
            quote_exact_input(&high_fee_cfg, &state, "A", amount_in).expect("quote high");

        assert!(out_low > out_high);
    }

    #[test]
    fn fee_bps_must_be_less_than_100_percent() {
        assert!(UniswapV2QuoteConfig::new("A", "B", 10_000).is_err());
    }

    /// The String-boundary wrapper must be an exact façade over the
    /// numeric core: identical amounts/reserves and byte-identical decimal
    /// counter serialization (including the unmodified pass-through of
    /// `k_last` and the empty-string-as-zero ingest semantics).
    #[test]
    fn string_wrapper_matches_numeric_core_byte_for_byte() {
        let cfg = UniswapV2QuoteConfig::new("A", "B", 30).expect("config");
        let string_state = UniswapV2StatefulState {
            reserve0: 5_000_000_000_000u128,
            reserve1: 9_000_000_000_000u128,
            block_timestamp_last: 1_000,
            price0_cumulative_last: "123456789012345678901234567890".to_string(),
            price1_cumulative_last: "".to_string(), // empty ingests as zero
            k_last: "45000000000000000000000000".to_string(),
        };
        let numeric_state = UniswapV2StatefulNumericState {
            reserve0: string_state.reserve0,
            reserve1: string_state.reserve1,
            block_timestamp_last: string_state.block_timestamp_last,
            price0_cumulative_last: BigUint::parse_bytes(b"123456789012345678901234567890", 10)
                .expect("p0"),
            price1_cumulative_last: BigUint::from(0u8),
            k_last: BigUint::parse_bytes(b"45000000000000000000000000", 10).expect("k"),
        };
        let amount_in = 123_456_789u128;
        let ts = 1_234_567u64;

        let via_string = swap_stateful(&cfg, &string_state, "A", amount_in, ts).expect("string");
        let via_numeric =
            swap_stateful_numeric(&cfg, &numeric_state, "A", amount_in, ts).expect("numeric");

        assert_eq!(via_string.amount_out, via_numeric.amount_out);
        assert_eq!(via_string.reserve0, via_numeric.reserve0);
        assert_eq!(via_string.reserve1, via_numeric.reserve1);
        assert_eq!(
            via_string.block_timestamp_last,
            via_numeric.block_timestamp_last
        );
        assert_eq!(
            via_string.price0_cumulative_last,
            via_numeric.price0_cumulative_last.to_string()
        );
        assert_eq!(
            via_string.price1_cumulative_last,
            via_numeric.price1_cumulative_last.to_string()
        );
        // k_last never participates in arithmetic — it must move through
        // unchanged.
        assert_eq!(via_string.k_last, "45000000000000000000000000");
        assert_eq!(via_numeric.k_last, numeric_state.k_last);
        // Cumulative counters actually advanced (time elapsed > 0).
        assert_ne!(
            via_string.price0_cumulative_last,
            string_state.price0_cumulative_last
        );
    }
}
