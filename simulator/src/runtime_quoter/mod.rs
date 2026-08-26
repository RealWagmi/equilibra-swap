use anyhow::Result;

pub mod curve;
pub mod equilibra;
pub mod equilibra_math;
pub mod uniswap_v2;

pub use curve::{
    CurveAddLiquidityStatefulOut, CurveExchangeStatefulOut, CurveQuoteConfig, CurveQuoteState,
    CurveRebalanceGateBlocked, CurveRemoveLiquidityStatefulOut, CurveStatefulConfig,
    CurveStatefulState,
};
pub use equilibra::{
    EquilibraExchangeExactOutStatefulOut, EquilibraExchangeStatefulOut, EquilibraGenesisInit,
    EquilibraRecenterGateBlocked, EquilibraStatefulConfig, EquilibraStatefulState,
    ExactOutResolved,
};
pub use uniswap_v2::{
    UniswapV2QuoteConfig, UniswapV2QuoteState, UniswapV2StatefulNumericState,
    UniswapV2StatefulState, UniswapV2SwapStatefulNumericOut, UniswapV2SwapStatefulOut,
};

#[derive(Debug, Default)]
pub struct LocalQuoter;

impl LocalQuoter {
    pub fn new() -> Self {
        Self
    }

    pub fn quote_curve_exact_input(
        &mut self,
        config: &CurveQuoteConfig,
        state: &CurveQuoteState,
        token_in: &str,
        amount_in: u128,
    ) -> Result<u128> {
        curve::quote_exact_input(config, state, token_in, amount_in)
    }

    pub fn quote_uniswap_v2_exact_input(
        &mut self,
        config: &UniswapV2QuoteConfig,
        state: &UniswapV2QuoteState,
        token_in: &str,
        amount_in: u128,
    ) -> Result<u128> {
        uniswap_v2::quote_exact_input(config, state, token_in, amount_in)
    }

    pub fn curve_compute_d(
        &mut self,
        config: &CurveQuoteConfig,
        state: &CurveQuoteState,
    ) -> Result<u128> {
        curve::compute_d(config, state)
    }

    pub fn curve_exchange_stateful(
        &mut self,
        config: &CurveStatefulConfig,
        state: CurveStatefulState,
        token_in: &str,
        amount_in: u128,
        timestamp: u64,
        disable_rebalance: bool,
    ) -> Result<CurveExchangeStatefulOut> {
        curve::exchange_stateful(
            config,
            state,
            token_in,
            amount_in,
            timestamp,
            disable_rebalance,
        )
    }

    pub fn curve_add_liquidity_stateful(
        &mut self,
        config: &CurveStatefulConfig,
        state: CurveStatefulState,
        amount0: u128,
        amount1: u128,
        timestamp: u64,
        disable_rebalance: bool,
    ) -> Result<CurveAddLiquidityStatefulOut> {
        curve::add_liquidity_stateful(
            config,
            state,
            amount0,
            amount1,
            timestamp,
            disable_rebalance,
        )
    }

    pub fn curve_donate_stateful(
        &mut self,
        config: &CurveStatefulConfig,
        state: CurveStatefulState,
        amount0: u128,
        amount1: u128,
        timestamp: u64,
        disable_rebalance: bool,
    ) -> Result<CurveAddLiquidityStatefulOut> {
        curve::donate_stateful(
            config,
            state,
            amount0,
            amount1,
            timestamp,
            disable_rebalance,
        )
    }

    pub fn curve_remove_liquidity_stateful(
        &mut self,
        state: CurveStatefulState,
        liquidity: u128,
    ) -> Result<CurveRemoveLiquidityStatefulOut> {
        curve::remove_liquidity_stateful(state, liquidity)
    }

    /// Park LP shares in an Equilibra pool's donation buffer (the
    /// parachute's emergency fund). Mirrors a plain LP `transfer` to
    /// the pool address on-chain — supply unchanged, irrevocable.
    pub fn equilibra_donate_lp_stateful(
        &mut self,
        state: &mut EquilibraStatefulState,
        shares: u128,
    ) -> Result<()> {
        equilibra::donate_lp_shares(state, shares)
    }

    pub fn equilibra_swap_stateful(
        &mut self,
        config: &EquilibraStatefulConfig,
        state: EquilibraStatefulState,
        token_in: &str,
        amount_in: u128,
        timestamp: u64,
        disable_recenter: bool,
    ) -> Result<EquilibraExchangeStatefulOut> {
        equilibra::swap_stateful(
            config,
            state,
            token_in,
            amount_in,
            timestamp,
            disable_recenter,
        )
    }

    /// `quoteExactOut(amountOut)` mirror.
    pub fn quote_equilibra_exact_out_stateful(
        &mut self,
        config: &EquilibraStatefulConfig,
        state: &EquilibraStatefulState,
        token_in: &str,
        amount_out: u128,
    ) -> Result<ExactOutResolved> {
        equilibra::quote_exact_out_stateful(config, state, token_in, amount_out)
    }

    pub fn equilibra_swap_stateful_exact_out(
        &mut self,
        config: &EquilibraStatefulConfig,
        state: EquilibraStatefulState,
        token_in: &str,
        amount_out: u128,
        timestamp: u64,
        disable_recenter: bool,
    ) -> Result<EquilibraExchangeExactOutStatefulOut> {
        equilibra::swap_stateful_exact_out(
            config,
            state,
            token_in,
            amount_out,
            timestamp,
            disable_recenter,
        )
    }

    pub fn uniswap_v2_swap_stateful(
        &mut self,
        config: &UniswapV2QuoteConfig,
        state: &UniswapV2StatefulState,
        token_in: &str,
        amount_in: u128,
        timestamp: u64,
    ) -> Result<UniswapV2SwapStatefulOut> {
        uniswap_v2::swap_stateful(config, state, token_in, amount_in, timestamp)
    }
}
