//! Permanent reproductions of the small-lambda monotonicity study.
//! Shared JSON preserves historical reversal inputs across lambda/alpha controls.
//! Solidity replays every historical input against an independent reference;
//! the dense Rust sweep rejects new reversals outside that corpus.
//! Regenerate the ENTIRE grid so new reversals outside those witnesses fail.
//! Flat 1 bps is the deployable factory boundary; guards stay intact.
use equilibra_offchain_simulator::runtime_quoter::{equilibra as eq, equilibra_math as math};
use primitive_types::U256;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const WAD: u128 = 1_000_000_000_000_000_000;
const OUTPUT_MARGIN_BOUNDARY: &str = "exact-out output-margin reserve boundary";

fn output_margin_boundary(
    c: &eq::EquilibraStatefulConfig,
    s: &eq::EquilibraStatefulState,
    zfo: bool,
    amount: u128,
) -> bool {
    let (reserve, scale) = if zfo {
        (s.reserve1, c.token1_scale)
    } else {
        (s.reserve0, c.token0_scale)
    };
    let (reserve_math, requested_math) = if zfo {
        (U256::from(reserve) * scale, U256::from(amount) * scale)
    } else {
        let price = U256::from(s.price_scale_wad);
        let requested = U256::from(amount) * scale * U256::from(WAD);
        (
            U256::from(reserve) * scale * U256::from(WAD) / price,
            requested / price + U256::from((!(requested % price).is_zero()) as u8),
        )
    };
    requested_math >= reserve_math
        || (requested_math / U256::from(99_999_999u64)).max(U256::one())
            >= reserve_math - requested_math
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema: String,
    seed_tokens: String,
    scope: Scope,
    states: Vec<StateVector>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    alphas: Vec<String>,
    lambda_wad: String,
    fees_bps: Vec<u128>,
    #[serde(default)]
    fee_floor_bps: u128,
    #[serde(default)]
    fee_ramp_bps: u128,
    decimals: Vec<[u8; 2]>,
    depletion_ppm: Vec<u128>,
    amount_ppm: Vec<u128>,
    neighbor_divisor: String,
    micro_amounts_raw: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateVector {
    id: usize,
    a_wad: String,
    lambda_wad: String,
    fee_bps: u128,
    decimals: [u8; 2],
    drain_token: usize,
    depletion_ppm: u128,
    reserves_raw: [String; 2],
    cases: Vec<QuotePair>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotePair {
    zero_for_one: bool,
    amount_in_raw: [String; 2],
    amount_out_raw: [String; 2],
    raw_output_math: [String; 2],
    iterations: [u32; 2],
}
#[derive(Clone, Copy)]
struct Quote {
    input: u128,
    output: u128,
    fee: u128,
    fee_wad: u128,
    iters: u32,
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn number(s: &str) -> u128 {
    s.parse().expect("literal integer fixture")
}
fn token(zfo: bool) -> &'static str {
    if zfo {
        "t0"
    } else {
        "t1"
    }
}

fn config(
    a: u128,
    lambda: u128,
    fee: u128,
    d: [u8; 2],
    floor: u128,
    ramp: u128,
) -> eq::EquilibraStatefulConfig {
    let c = eq::EquilibraStatefulConfig::new(
        "t0",
        "t1",
        d[0],
        d[1],
        fee,
        a,
        lambda,
        0,
        600,
        1_000_000_000_000_000,
        100_000_000_000_000,
        100_000_000_000_000,
        ramp,
        floor,
        0,
    )
    .expect("production curve bounds");
    c
}
fn genesis(c: &eq::EquilibraStatefulConfig, seed: u128, d: [u8; 2]) -> eq::EquilibraStatefulState {
    let g = eq::init_genesis(
        c,
        seed * 10u128.pow(d[0].into()),
        seed * 10u128.pow(d[1].into()),
        1,
    )
    .expect("balanced genesis");
    eq::EquilibraStatefulState {
        reserve0: g.reserve0,
        reserve1: g.reserve1,
        e0: g.reserve0,
        e1: g.reserve1,
        total_supply: g.total_supply,
        price_scale_wad: g.price_scale_wad,
        ema_log_wad: g.ema_log_wad,
        last_ema_ts: g.last_ema_ts,
        last_repeg_ts: g.last_repeg_ts,
        lp_unit_value_genesis_wad: g.lp_unit_value_genesis_wad,
        lp_unit_value_wad: g.lp_unit_value_genesis_wad,
        ..eq::EquilibraStatefulState::empty()
    }
}
fn after(e: eq::EquilibraExchangeStatefulOut) -> eq::EquilibraStatefulState {
    assert!(!e.recentered);
    assert_eq!(e.price_scale_wad, WAD);
    eq::EquilibraStatefulState {
        reserve0: e.reserve0,
        reserve1: e.reserve1,
        total_supply: e.total_supply,
        price_scale_wad: e.price_scale_wad,
        protocol_fee0: e.protocol_fee0,
        protocol_fee1: e.protocol_fee1,
        e0: e.e0,
        e1: e.e1,
        ema_log_wad: e.ema_log_wad,
        last_ema_ts: e.last_ema_ts,
        last_repeg_ts: e.last_repeg_ts,
        lp_unit_value_genesis_wad: e.lp_unit_value_genesis_wad,
        lp_unit_value_wad: e.lp_unit_value_wad,
        lp_value_growth_wad: e.lp_value_growth_wad,
        donation_shares: e.donation_shares,
    }
}

fn quote_result(
    c: &eq::EquilibraStatefulConfig,
    s: &eq::EquilibraStatefulState,
    zfo: bool,
    eo: bool,
    amount: u128,
) -> Result<Quote, String> {
    let result = if eo {
        eq::quote_exact_out_stateful(c, s, token(zfo), amount).map(|q| Quote {
            input: q.amount_in_raw,
            output: amount,
            fee: q.fee_amount_raw,
            fee_wad: q.fee_wad_effective,
            iters: q.iters,
        })
    } else {
        eq::quote_exact_in_stateful(c, s, token(zfo), amount).map(|q| Quote {
            input: amount,
            output: q.amount_out_raw,
            fee: q.fee_amount_raw,
            fee_wad: q.fee_wad_effective,
            iters: q.iters,
        })
    };
    match result {
        Ok(q) => {
            assert!(q.input > 0 && q.output > 0);
            assert!(q.fee_wad <= c.fee_bps * 100_000_000_000_000);
            if c.fee_ramp_bps != 0 {
                assert!(q.fee_wad >= c.fee_floor_bps * 100_000_000_000_000);
            }
            Ok(q)
        }
        Err(e) => {
            let mut reason = e.to_string();
            if matches!(
                reason.as_str(),
                "equilibra_math: quoteExactOutForward dy >= y (insufficient liquidity)"
                    | "equilibra_stateful: insufficient liquidity"
            ) {
                assert!(
                    eo && output_margin_boundary(c, s, zfo, amount),
                    "unexpected liquidity refusal: {e:#}"
                );
                reason = OUTPUT_MARGIN_BOUNDARY.into();
            }
            assert!(
                matches!(
                    reason.as_str(),
                    OUTPUT_MARGIN_BOUNDARY
                        | "equilibra_math: SolverDidNotConverge"
                        | "equilibra_stateful: amount_too_small_after_normalization"
                        | "equilibra_stateful: LpValueDecreased"
                ),
                "unexpected quote error: {e:#}"
            );
            Err(reason)
        }
    }
}

#[derive(Default)]
struct QuoteLog {
    counts: BTreeMap<String, usize>,
    digest: Sha256,
}

fn quote(
    c: &eq::EquilibraStatefulConfig,
    s: &eq::EquilibraStatefulState,
    zfo: bool,
    eo: bool,
    amount: u128,
    log: &mut QuoteLog,
) -> Option<Quote> {
    let result = quote_result(c, s, zfo, eo, amount);
    // Pin the identity of accepted/refused probes, not just their totals.
    // A replacement refusal with the same count must also fail the baseline.
    log.digest.update(format!(
        "{}/{}/{}/{}/{}/{}/{}/{}/{}/{}\n",
        c.a_wad,
        c.lambda_wad,
        c.fee_bps,
        c.token0_scale,
        c.token1_scale,
        s.reserve0,
        s.reserve1,
        zfo,
        eo,
        amount
    ));
    log.digest
        .update(result.as_ref().err().map(String::as_str).unwrap_or("OK"));
    log.digest.update(b"\n");
    match result {
        Ok(q) => Some(q),
        Err(reason) => {
            *log.counts.entry(reason).or_default() += 1;
            None
        }
    }
}

fn deplete(
    c: &eq::EquilibraStatefulConfig,
    seed: u128,
    d: [u8; 2],
    drain: usize,
    ppm: u128,
) -> eq::EquilibraStatefulState {
    let mut shaped = genesis(c, seed, d);
    let mut remaining = seed * 10u128.pow(d[drain].into()) * ppm / 1_000_000;
    let target = seed * 10u128.pow(d[drain].into()) - remaining;
    while remaining > 0 {
        let reserve = if drain == 0 {
            shaped.reserve0
        } else {
            shaped.reserve1
        };
        // A sequence can reach the extreme state even when one exact-out
        // would consume the common margin's reserve.
        let chunk = if output_margin_boundary(c, &shaped, drain == 1, remaining) {
            reserve * 999 / 1000
        } else {
            remaining
        };
        assert!(chunk > 0 && chunk <= remaining);
        let q = quote_result(c, &shaped, drain == 1, true, chunk)
            .expect("every depletion leg must execute");
        shaped = execute(c, shaped, drain == 1, true, q);
        remaining -= chunk;
    }
    assert_eq!(
        if drain == 0 {
            shaped.reserve0
        } else {
            shaped.reserve1
        },
        target
    );
    shaped
}

// Quotes may refuse a search probe; execution after an accepted same-state
// quote may not. Use the actual stateful path, not manual reserve arithmetic.
fn execute(
    c: &eq::EquilibraStatefulConfig,
    s: eq::EquilibraStatefulState,
    zfo: bool,
    eo: bool,
    q: Quote,
) -> eq::EquilibraStatefulState {
    let e = if eo {
        let e = eq::swap_stateful_exact_out(c, s, token(zfo), q.output, 1, true)
            .expect("accepted exact-out quote MUST execute");
        assert_eq!(e.amount_in, q.input);
        e.state
    } else {
        eq::swap_stateful(c, s, token(zfo), q.input, 1, true)
            .expect("accepted exact-in quote MUST execute")
    };
    assert_eq!(e.amount_out, q.output);
    assert_eq!(e.fee_amount_raw, q.fee);
    assert_eq!(e.protocol_cut_raw, 0);
    assert_eq!(
        (e.reserve0, e.reserve1),
        if zfo {
            (s.reserve0 + q.input, s.reserve1 - q.output)
        } else {
            (s.reserve0 - q.output, s.reserve1 + q.input)
        }
    );
    after(e)
}

fn state_key(a: u128, lambda: u128, fee: u128, d: [u8; 2], drain: usize, ppm: u128) -> String {
    format!("{a}/{lambda}/{fee}/{}/{}/{drain}/{ppm}", d[0], d[1])
}
fn pair_key(state: &str, zfo: bool, a: u128, b: u128) -> String {
    format!("{state}/{zfo}/{a}/{b}")
}

fn measure_dense_grid(fixture_json: &str, expected_cases: usize) -> Value {
    let f: Fixture = serde_json::from_str(fixture_json).expect("shared Solidity/Rust witnesses");
    assert_eq!(f.schema, "equilibra-small-lambda-monotonicity/v1");
    let seed = number(&f.seed_tokens);
    let lambda = number(&f.scope.lambda_wad);
    let mut known = BTreeMap::new();
    for s in &f.states {
        let initial = seed * 10u128.pow(s.decimals[s.drain_token].into());
        assert_eq!(
            number(&s.reserves_raw[s.drain_token]),
            initial - initial * s.depletion_ppm / 1_000_000
        );
        let key = state_key(
            number(&s.a_wad),
            number(&s.lambda_wad),
            s.fee_bps,
            s.decimals,
            s.drain_token,
            s.depletion_ppm,
        );
        for p in &s.cases {
            assert!(
                number(&p.amount_out_raw[1]) < number(&p.amount_out_raw[0]),
                "historical pair must record a negative output delta"
            );
            assert!(p.iterations.iter().all(|&n| n > 0 && n <= 40));
            assert!(p.raw_output_math.iter().all(|v| number(v) > 0));
            let pk = pair_key(
                &key,
                p.zero_for_one,
                number(&p.amount_in_raw[0]),
                number(&p.amount_in_raw[1]),
            );
            assert!(
                known.insert(pk, (s, p)).is_none(),
                "duplicate recorded pair"
            );
        }
    }
    assert_eq!(known.len(), expected_cases);
    let mut found = BTreeSet::new();
    let mut shapes = 0;
    let mut comparisons = 0;
    let mut cycles = 0;
    let mut cross_cycles = 0;
    let mut boundary_cross_cycles = 0;
    let mut refused_quotes = QuoteLog::default();
    let mut refused_cycles = QuoteLog::default();
    let mut fee_regimes = BTreeMap::<&str, usize>::new();

    for a in &f.scope.alphas {
        for &fee in &f.scope.fees_bps {
            for &d in &f.scope.decimals {
                let c = config(
                    number(a),
                    lambda,
                    fee,
                    d,
                    f.scope.fee_floor_bps,
                    f.scope.fee_ramp_bps,
                );
                for &ppm in &f.scope.depletion_ppm {
                    for drain in 0..if ppm == 0 { 1 } else { 2 } {
                        let s = deplete(&c, seed, d, drain, ppm);
                        shapes += 1;
                        let key = state_key(number(a), lambda, fee, d, drain, ppm);
                        for zfo in [true, false] {
                            for eo in [true, false] {
                                let reserve = match (zfo, eo) {
                                    (true, false) | (false, true) => s.reserve0,
                                    _ => s.reserve1,
                                };
                                // true marks original coarse points, used for the cycle matrix.
                                let mut inputs = BTreeMap::<u128, bool>::new();
                                for &fraction in &f.scope.amount_ppm {
                                    let amount = reserve * fraction / 1_000_000;
                                    if amount == 0 {
                                        continue;
                                    }
                                    inputs.insert(amount, true);
                                    for delta in [1, amount / number(&f.scope.neighbor_divisor)] {
                                        for x in [amount.saturating_sub(delta), amount + delta] {
                                            if x > 0 && (!eo || x < reserve) {
                                                inputs.entry(x).or_insert(false);
                                            }
                                        }
                                    }
                                }
                                for amount in &f.scope.micro_amounts_raw {
                                    inputs.insert(number(amount), false);
                                }
                                let mut previous: Option<Quote> = None;
                                for (amount, coarse) in inputs {
                                    let Some(q) =
                                        quote(&c, &s, zfo, eo, amount, &mut refused_quotes)
                                    else {
                                        continue;
                                    };
                                    if c.fee_ramp_bps != 0 {
                                        let regime =
                                            if q.fee_wad == c.fee_floor_bps * 100_000_000_000_000 {
                                                "floor"
                                            } else if q.fee_wad == c.fee_bps * 100_000_000_000_000 {
                                                "ceiling"
                                            } else {
                                                "transition"
                                            };
                                        *fee_regimes.entry(regime).or_default() += 1;
                                    }
                                    if let Some(prev) = previous {
                                        comparisons += 1;
                                        let (before, now) = if eo {
                                            (prev.input, q.input)
                                        } else {
                                            (prev.output, q.output)
                                        };
                                        if now < before {
                                            assert!(!eo, "new exact-out reversal in {key}");
                                            let pk = pair_key(&key, zfo, prev.input, q.input);
                                            known.get(&pk).unwrap_or_else(|| {
                                                panic!("NEW unrecorded reversal: {pk}")
                                            });
                                            // The historical corpus pins inputs and depletion, not the
                                            // old shaping quote: K precision can change its input by wei.
                                            assert!(prev.iters <= 40 && q.iters <= 40);
                                            let (ri, ro, si, so) = if zfo {
                                                (
                                                    s.reserve0,
                                                    s.reserve1,
                                                    c.token0_scale,
                                                    c.token1_scale,
                                                )
                                            } else {
                                                (
                                                    s.reserve1,
                                                    s.reserve0,
                                                    c.token1_scale,
                                                    c.token0_scale,
                                                )
                                            };
                                            let mut raw_outputs = [U256::zero(); 2];
                                            for (index, v) in [prev, q].iter().enumerate() {
                                                let (raw, _) = math::quote_exact_in_forward(
                                                    U256::from(ri) * si,
                                                    U256::from(ro) * so,
                                                    U256::from(v.input - v.fee) * si,
                                                    number(a).into(),
                                                    lambda.into(),
                                                )
                                                .expect("raw quote for accepted witness");
                                                raw_outputs[index] = raw;
                                                assert_eq!(
                                                    (raw / so).as_u128(),
                                                    v.output,
                                                    "no second native margin"
                                                );
                                            }
                                            // Native conversion does not add a second margin.
                                            if raw_outputs[1] < raw_outputs[0] {
                                                assert!(
                                                    raw_outputs[0] - raw_outputs[1]
                                                        <= raw_outputs[0] / 10_000 + U256::one(),
                                                    "remaining raw drop exceeds the quote budget: {pk}"
                                                );
                                            }
                                            assert!(found.insert(pk));
                                        }
                                    }
                                    previous = Some(q);
                                    if !coarse {
                                        continue;
                                    }
                                    let post = execute(&c, s, zfo, eo, q);
                                    let imbalance = |v: &eq::EquilibraStatefulState| {
                                        (U256::from(v.reserve0) * c.token0_scale)
                                            .cmp(&(U256::from(v.reserve1) * c.token1_scale))
                                    };
                                    let crossed = matches!(
                                        (imbalance(&s), imbalance(&post)),
                                        (std::cmp::Ordering::Less, std::cmp::Ordering::Greater)
                                            | (
                                                std::cmp::Ordering::Greater,
                                                std::cmp::Ordering::Less
                                            )
                                    );
                                    for back_eo in [false, true] {
                                        let amount_back = if back_eo { q.input } else { q.output };
                                        let boundaries_before = refused_cycles
                                            .counts
                                            .get(OUTPUT_MARGIN_BOUNDARY)
                                            .copied()
                                            .unwrap_or(0);
                                        let Some(back) = quote(
                                            &c,
                                            &post,
                                            !zfo,
                                            back_eo,
                                            amount_back,
                                            &mut refused_cycles,
                                        ) else {
                                            if crossed
                                                && refused_cycles
                                                    .counts
                                                    .get(OUTPUT_MARGIN_BOUNDARY)
                                                    .copied()
                                                    .unwrap_or(0)
                                                    > boundaries_before
                                            {
                                                boundary_cross_cycles += 1;
                                            }
                                            continue;
                                        };
                                        let closed = execute(&c, post, !zfo, back_eo, back);
                                        let index = if zfo { 0 } else { 1 };
                                        let before_reserves = [s.reserve0, s.reserve1];
                                        let after_reserves = [closed.reserve0, closed.reserve1];
                                        let restored = if back_eo { index } else { 1 - index };
                                        assert_eq!(
                                            after_reserves[restored], before_reserves[restored],
                                            "closed intermediate balance"
                                        );
                                        assert!(after_reserves[1 - restored] >= before_reserves[1 - restored],
                                            "profitable cycle: {key}, zfo={zfo}, exact-out={eo}/{back_eo}, input={}", q.input);
                                        cycles += 1;
                                        if crossed {
                                            cross_cycles += 1
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(
        found.is_subset(&known.keys().cloned().collect()),
        "no unrecorded reversals"
    );
    let depletion_states: usize = f
        .scope
        .depletion_ppm
        .iter()
        .map(|&ppm| if ppm == 0 { 1 } else { 2 })
        .sum();
    assert_eq!(
        shapes,
        f.scope.alphas.len() * f.scope.fees_bps.len() * f.scope.decimals.len() * depletion_states
    );
    if f.scope.fee_ramp_bps != 0 {
        for regime in ["floor", "transition", "ceiling"] {
            assert!(
                fee_regimes.get(regime).copied().unwrap_or(0) > 0,
                "uncovered dynamic fee regime: {regime}"
            );
        }
    }
    serde_json::json!({
        "lambdaWad": f.scope.lambda_wad, "alphas": f.scope.alphas,
        "feeFloorBps": f.scope.fee_floor_bps, "feeRampBps": f.scope.fee_ramp_bps,
        "feeRegimes": fee_regimes,
        "states": shapes, "comparisons": comparisons, "knownOutputDrops": found.len(),
        "exactOutInputDrops": 0, "completedCycles": cycles, "crossAnchorCycles": cross_cycles,
        "profitableCycles": 0, "quoteRefusals": refused_quotes.counts, "cycleRefusals": refused_cycles.counts,
        "quoteClassificationSha256": hex(refused_quotes.digest.finalize()),
        "cycleClassificationSha256": hex(refused_cycles.digest.finalize()),
        "marginLimitedCrossAnchorCycles": boundary_cross_cycles,
        "scope": "sampled grid; frozen current anchor, not moving-anchor or LP deposit/withdraw cycles"
    })
}

fn error_name(reason: &str) -> &'static str {
    match reason {
        "equilibra_math: SolverDidNotConverge" => "SolverDidNotConverge",
        "equilibra_stateful: LpValueDecreased" => "LpValueDecreased",
        "equilibra_stateful: amount_too_small_after_normalization" => {
            "AmountTooSmallAfterNormalization"
        }
        OUTPUT_MARGIN_BOUNDARY => "InsufficientLiquidity",
        _ => panic!("unexpected refusal: {reason}"),
    }
}

fn quote_value(q: Quote) -> Value {
    json!({
        "input": q.input.to_string(), "output": q.output.to_string(),
        "fee": q.fee.to_string(), "feeWad": q.fee_wad.to_string(), "iters": q.iters,
    })
}

fn measure_historical(fixture_json: &str) -> Value {
    let f: Fixture = serde_json::from_str(fixture_json).unwrap();
    let mut states = BTreeMap::new();
    let mut entries = BTreeMap::new();
    let mut quotes = 0;
    let mut cycles = 0;
    let mut pairs = 0;
    let mut refused_pairs = 0;
    let mut refused_quotes = BTreeMap::<String, usize>::new();
    let mut refused_cycles = BTreeMap::<String, usize>::new();
    for vector in &f.states {
        let c = config(
            number(&vector.a_wad),
            number(&vector.lambda_wad),
            vector.fee_bps,
            vector.decimals,
            f.scope.fee_floor_bps,
            f.scope.fee_ramp_bps,
        );
        let s = deplete(
            &c,
            number(&f.seed_tokens),
            vector.decimals,
            vector.drain_token,
            vector.depletion_ppm,
        );
        assert!(states
            .insert(
                vector.id.to_string(),
                [s.reserve0.to_string(), s.reserve1.to_string()]
            )
            .is_none());
        for (pair_index, pair) in vector.cases.iter().enumerate() {
            let mut refused = false;
            for (leg, amount) in pair.amount_in_raw.iter().enumerate() {
                let amount = number(amount);
                let zfo = pair.zero_for_one;
                let result = quote_result(&c, &s, zfo, false, amount);
                let entry = match result {
                    Err(reason) => {
                        // Keep fee-only historical inputs as negative quote AND swap tests.
                        assert_eq!(
                            eq::swap_stateful(&c, s, token(zfo), amount, 1, true)
                                .unwrap_err()
                                .to_string(),
                            reason
                        );
                        let name = error_name(&reason);
                        *refused_quotes.entry(name.into()).or_default() += 1;
                        refused = true;
                        json!({"forward": {"error": name}, "reverse": null})
                    }
                    Ok(q) => {
                        quotes += 1;
                        let post = execute(&c, s, zfo, false, q);
                        let reverse = match quote_result(&c, &post, !zfo, false, q.output) {
                            Err(reason) => {
                                assert_eq!(
                                    eq::swap_stateful(&c, post, token(!zfo), q.output, 1, true)
                                        .unwrap_err()
                                        .to_string(),
                                    reason
                                );
                                let name = error_name(&reason);
                                *refused_cycles.entry(name.into()).or_default() += 1;
                                json!({"error": name})
                            }
                            Ok(back) => {
                                let closed = execute(&c, post, !zfo, false, back);
                                let (original_in, final_in, original_out, final_out) = if zfo {
                                    (s.reserve0, closed.reserve0, s.reserve1, closed.reserve1)
                                } else {
                                    (s.reserve1, closed.reserve1, s.reserve0, closed.reserve0)
                                };
                                assert_eq!(original_out, final_out, "closed intermediate balance");
                                assert!(
                                    final_in >= original_in && back.output <= amount,
                                    "profitable historical cycle"
                                );
                                cycles += 1;
                                quote_value(back)
                            }
                        };
                        json!({"forward": quote_value(q), "reverse": reverse})
                    }
                };
                assert!(entries
                    .insert(format!("{}/{pair_index}/{leg}", vector.id), entry)
                    .is_none());
            }
            pairs += 1;
            refused_pairs += usize::from(refused);
        }
    }
    json!({
        "reserves": states, "entries": entries,
        "summary": {"replayedPairs": pairs, "refusedPairs": refused_pairs,
            "quotes": quotes, "completedCycles": cycles,
            "refusedQuotes": refused_quotes, "refusedCycles": refused_cycles}
    })
}

// The old corpus is immutable evidence: inputs, original outputs and old fees
// describe the historical reversal, not the current quote expectation.
// Only the separate regression snapshot is regenerated after reviewed changes.
const CORPORA: [(&str, &str, usize); 6] = [
    (
        "equilibra-small-lambda-monotonicity.json",
        include_str!("fixtures/equilibra-small-lambda-monotonicity.json"),
        300,
    ),
    (
        "equilibra-lambda-5e13-monotonicity.json",
        include_str!("fixtures/equilibra-lambda-5e13-monotonicity.json"),
        66,
    ),
    (
        "equilibra-lambda-6e13-monotonicity.json",
        include_str!("fixtures/equilibra-lambda-6e13-monotonicity.json"),
        548,
    ),
    (
        "equilibra-lambda-6e13-alpha-99975-monotonicity.json",
        include_str!("fixtures/equilibra-lambda-6e13-alpha-99975-monotonicity.json"),
        264,
    ),
    (
        "equilibra-lambda-1e14-alpha-99975-monotonicity.json",
        include_str!("fixtures/equilibra-lambda-1e14-alpha-99975-monotonicity.json"),
        22,
    ),
    (
        "equilibra-lambda-1e14-alpha-max-monotonicity.json",
        include_str!("fixtures/equilibra-lambda-1e14-alpha-max-monotonicity.json"),
        22,
    ),
];

fn measure_corpus(index: usize) -> Value {
    let (file, data, count) = CORPORA[index];
    let dense = measure_dense_grid(data, count);
    println!("SMALL_LAMBDA_DENSE {dense}");
    let historical = measure_historical(data);
    println!(
        "SMALL_LAMBDA_REPLAY {}",
        json!({"file": file, "summary": historical["summary"]})
    );
    json!({"historicalInputSha256": hex(Sha256::digest(data.as_bytes())),
        "dense": dense, "historical": historical})
}

pub fn regenerate() -> Value {
    let corpora: BTreeMap<_, _> = CORPORA
        .iter()
        .enumerate()
        .map(|(i, (name, _, _))| (*name, measure_corpus(i)))
        .collect();
    json!({"schema": "equilibra-small-lambda-regression/v1", "corpora": corpora})
}

#[test]
fn historical_quotes_and_swaps_match_shared_solidity_outcomes() {
    let baseline: Value = serde_json::from_str(include_str!(
        "fixtures/equilibra-small-lambda-regression.json"
    ))
    .unwrap();
    assert_eq!(baseline["schema"], "equilibra-small-lambda-regression/v1");
    for (name, data, _) in CORPORA {
        let expected = &baseline["corpora"][name];
        assert_eq!(
            hex(Sha256::digest(data.as_bytes())),
            expected["historicalInputSha256"].as_str().unwrap()
        );
        assert_eq!(measure_historical(data), expected["historical"], "{name}");
    }
}

#[cfg(test)]
fn check_corpus(index: usize) {
    let baseline: Value = serde_json::from_str(include_str!(
        "fixtures/equilibra-small-lambda-regression.json"
    ))
    .unwrap();
    assert_eq!(baseline["schema"], "equilibra-small-lambda-regression/v1");
    let actual = measure_corpus(index);
    let expected = &baseline["corpora"][CORPORA[index].0];
    assert_eq!(
        actual["historicalInputSha256"], expected["historicalInputSha256"],
        "historical corpus changed"
    );
    // Exact totals plus classification digests: refusals never substitute for
    // completed cycles, and moving a refusal to another input also fails.
    assert_eq!(
        actual["dense"], expected["dense"],
        "dense coverage/refusal drift"
    );
    assert_eq!(
        actual["historical"], expected["historical"],
        "historical quote or execution drift"
    );
}

#[test]
#[ignore = "manual dense matrix: run with --ignored"]
fn dense_grid_at_1e12_replays_known_drops_and_checks_executed_round_trips() {
    check_corpus(0);
}

#[test]
#[ignore = "manual dense matrix: run with --ignored"]
fn dense_grid_at_5e13_replays_known_drops_and_checks_executed_round_trips() {
    check_corpus(1);
}

#[test]
#[ignore = "manual dense matrix: run with --ignored"]
fn dense_grid_at_6e13_replays_known_drops_and_checks_executed_round_trips() {
    check_corpus(2);
}

#[test]
#[ignore = "manual dense matrix: run with --ignored"]
fn dense_grid_at_6e13_alpha_99975_replays_known_drops_and_checks_executed_round_trips() {
    check_corpus(3);
}

#[test]
#[ignore = "manual dense matrix: run with --ignored"]
fn dense_grid_at_1e14_alpha_99975_replays_known_drops_and_checks_executed_round_trips() {
    check_corpus(4);
}

#[test]
#[ignore = "manual dense matrix: run with --ignored"]
fn dense_grid_at_1e14_alpha_max_replays_known_drops_and_checks_executed_round_trips() {
    check_corpus(5);
}
