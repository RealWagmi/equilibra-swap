// Conservation-focused coverage for `EquilibraRouter.exactOutputSingle`.
//
// The pre-existing periphery suite called `exactOutputSingle` only twice
// (gas-report visible: 2 invocations, no rebalance / cross-anchor /
// asymmetric-decimal coverage). This file pins the hot invariants that
// matter for honest user accounting on exact-output swaps:
//
//   * **Quote is an upper bound on what the user actually pays.**
//     `realised amountIn <= quoteExactOut(amountOut)` strictly. If the
//     resolver under-quoted, the live swap would either drain the
//     user's balance beyond the cap or let the pool become insolvent
//     — the strict `<=` rules both out.
//   * **Quote does not over-state by more than ceiling rounding.**
//     `quoteExactOut - realised <= 1 wei` per leg in practice (the
//     resolver ceil-rounds the input gross-up in favour of LPs to
//     guarantee solvency under fee-on-transfer regressions; the
//     drift is therefore tiny but always present and always biased
//     toward the LP). We pin the 1-wei envelope so a future change
//     that widened the over-statement would surface as a failed
//     assertion.
//   * **The recipient receives exactly `amountOut`.** Output-side
//     rounding to LP would be a leak from the user — output is bit-
//     exact (`to.equal(amountOut)`).
//   * **Slippage cap fires as documented.** `amountInMaximum >= quoted`
//     always succeeds; a meaningful underestimate (e.g.
//     `amountInMaximum = quoted / 2`) reverts with
//     `ExcessiveInputAmount` and never mutates state.
//
// Three pool states are exercised: balanced, pre-depleted (away
// regime), and cross-anchor. Both directions (`token0→token1` and
// `token1→token0`). Both canonical presets (WETH symmetric decimals,
// WBTC asymmetric 8/6). Both fee-config flavours: pure curve (so
// any drift surfaces as a math leak) and the canonical dynamic ramp
// (so the production fee curve is also pinned).
import { expect } from "chai";
import type { Signer } from "ethers";
import { MaxUint256 } from "ethers";

import {
  buildPreset,
  deploySecurityFixture,
  deplete,
  currentBlockTime,
  type PresetName,
  type SecurityFixture,
} from "../helpers/securityFixtures";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

type Direction = "quoteToBase" | "baseToQuote";

interface SwapDirAddrs {
  tokenIn: string;
  tokenOut: string;
  zeroForOne: boolean;
}

function dirAddrs(fx: SecurityFixture, dir: Direction): SwapDirAddrs {
  if (dir === "quoteToBase") {
    return {
      tokenIn: fx.quoteAddr,
      tokenOut: fx.baseAddr,
      zeroForOne: fx.quoteIsToken0,
    };
  }
  return {
    tokenIn: fx.baseAddr,
    tokenOut: fx.quoteAddr,
    zeroForOne: !fx.quoteIsToken0,
  };
}

async function execExactOutputSingle(
  fx: SecurityFixture,
  signer: Signer,
  args: {
    tokenIn: string;
    tokenOut: string;
    amountOut: bigint;
    amountInMaximum: bigint;
    deadline?: number;
  }
): Promise<{
  amountInPulled: bigint;
  amountOutReceived: bigint;
}> {
  const recipient = await signer.getAddress();
  const tokenInCt = args.tokenIn.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.quote : fx.base;
  const tokenOutCt = args.tokenOut.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.quote : fx.base;

  const inBefore = BigInt(await tokenInCt.balanceOf(recipient));
  const outBefore = BigInt(await tokenOutCt.balanceOf(recipient));

  await fx.router.connect(signer).exactOutputSingle({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    poolIndex: 0,
    recipient,
    amountOut: args.amountOut,
    amountInMaximum: args.amountInMaximum,
    deadline: args.deadline ?? (await currentBlockTime()) + 3600,
  });

  const inAfter = BigInt(await tokenInCt.balanceOf(recipient));
  const outAfter = BigInt(await tokenOutCt.balanceOf(recipient));

  return {
    amountInPulled: inBefore - inAfter,
    amountOutReceived: outAfter - outBefore,
  };
}

// Sizes are scaled relative to the seed reserve so the same probe
// table is meaningful for both WETH and WBTC presets.
const SIZE_BPS_OF_OUT_RESERVE: bigint[] = [1n, 50n, 200n, 1_000n, 3_000n];

const PRESET_NAMES: PresetName[] = ["WETH", "WBTC"];

const DIRECTIONS: Direction[] = ["quoteToBase", "baseToQuote"];

// Maximum acceptable over-quote on `quoteExactOut`. The pool's
// dynamic-fee resolver ceil-rounds the input gross-up by ≤ 1 wei in
// favour of LPs (so `quoteExactOut` is a tight upper bound on what the
// live swap will actually pull). This budget is the documented invariant
// — anything looser would let a regression silently widen the
// over-charge.
const MAX_QUOTE_OVERSTATEMENT: bigint = 1n;

async function setupBalanced(preset: PresetName, overrides: Parameters<typeof buildPreset>[1] = {}) {
  return await deploySecurityFixture(buildPreset(preset, overrides));
}

// Resolve the seed reserve for the *output* leg of a direction. Decimal
// asymmetry + token-sort order both matter, so this picks the right
// raw-decimals reserve for whichever side `tokenOut` lands on.
function outReserveFor(fx: SecurityFixture, dir: Direction, source: "seed" | "live"): bigint {
  const isOutQuote = dir === "baseToQuote";
  if (source === "seed") {
    return isOutQuote ? fx.initialQuoteRaw : fx.initialBaseRaw;
  }
  // For live reserves the test already calls `fx.pool.getReserves()`
  // and passes the side directly via `currentReserveByToken`.
  throw new Error("outReserveFor('live') unsupported here");
}

// Read the live reserve for whichever sorted slot belongs to `tokenAddr`.
async function liveReserveOf(fx: SecurityFixture, tokenAddr: string): Promise<bigint> {
  const [r0, r1] = await fx.pool.getReserves();
  const isToken0 = tokenAddr.toLowerCase() === (fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr).toLowerCase();
  return isToken0 ? BigInt(r0) : BigInt(r1);
}

// Assert the documented input-amount envelope:
//   1. `realised <= quoted` (strict — quote is an upper bound),
//   2. `quoted - realised <= MAX_QUOTE_OVERSTATEMENT` (tiny ceiling
//      drift in favour of LPs).
function assertAmountInEnvelope(realised: bigint, quoted: bigint, label: string) {
  expect(realised, `${label}: realised=${realised} exceeded quoted=${quoted}`).to.be.lessThanOrEqual(quoted);
  expect(
    quoted - realised,
    `${label}: quoted-realised drift ${quoted - realised} > ${MAX_QUOTE_OVERSTATEMENT}`
  ).to.be.lessThanOrEqual(MAX_QUOTE_OVERSTATEMENT);
}

describe("Router.exactOutputSingle — input-amount conservation", function () {
  this.timeout(180_000);

  // -------------------------------------------------------------------------
  // Block 1 — pure curve (fees collapsed to flat 5 bps; ramp disabled).
  // Any drift between `quoteExactOut` and `amountIn` here is a math
  // leak, not a fee accounting subtlety.
  // -------------------------------------------------------------------------

  describe("pure curve (baseFee = 5, feeRampBps = 0)", function () {
    for (const presetName of PRESET_NAMES) {
      describe(`preset ${presetName}`, function () {
        for (const dir of DIRECTIONS) {
          it(`balanced: quote upper-bounds actual amountIn for ${dir} across the size sweep`, async function () {
            const fx = await setupBalanced(presetName);
            const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, dir);
            const outReserveRaw = outReserveFor(fx, dir, "seed");
            const recipient = await fx.trader.getAddress();
            const tokenOutCt = tokenOut.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.quote : fx.base;

            for (const bps of SIZE_BPS_OF_OUT_RESERVE) {
              const amountOut = (outReserveRaw * bps) / 10_000n;
              if (amountOut === 0n) continue;

              const quoted: bigint = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
              expect(quoted, `quote returned 0 for ${presetName}/${dir}/${bps}bps`).to.be.greaterThan(0n);

              const balOutBefore = BigInt(await tokenOutCt.balanceOf(recipient));

              const realised = await execExactOutputSingle(fx, fx.trader, {
                tokenIn,
                tokenOut,
                amountOut,
                amountInMaximum: MaxUint256,
              });

              // The user-facing input invariant — quoted is a tight
              // upper bound, drift ≤ MAX_QUOTE_OVERSTATEMENT in favour
              // of LPs.
              assertAmountInEnvelope(realised.amountInPulled, quoted, `${presetName}/${dir}/${bps}bps`);

              // Recipient receives EXACTLY amountOut — no rounding to
              // the LP on the output side.
              expect(realised.amountOutReceived, `${presetName}/${dir}/${bps}bps: amountOut delta`).to.equal(amountOut);

              // Sanity: tokenOut balance jumped by exactly `amountOut`.
              const balOutAfter = BigInt(await tokenOutCt.balanceOf(recipient));
              expect(balOutAfter - balOutBefore).to.equal(amountOut);
            }
          });
        }

        it(`pre-depleted (50% quote drain): envelope still holds (${presetName})`, async function () {
          const fx = await setupBalanced(presetName);
          // Push the pool deep into the away regime so the resolver
          // takes a different secant trajectory than the balanced path.
          await deplete(fx, "quote", 5_000n);
          const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, "baseToQuote");
          // Sized as a fraction of the post-depletion reserve so the
          // probe still settles inside the curve's feasibility band.
          const outReserve = await liveReserveOf(fx, tokenOut);
          for (const bps of [50n, 200n, 800n]) {
            const amountOut = (outReserve * bps) / 10_000n;
            if (amountOut === 0n) continue;
            const quoted = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
            const realised = await execExactOutputSingle(fx, fx.trader, {
              tokenIn,
              tokenOut,
              amountOut,
              amountInMaximum: MaxUint256,
            });
            assertAmountInEnvelope(realised.amountInPulled, quoted, `${presetName}/depleted/${bps}bps`);
            expect(realised.amountOutReceived).to.equal(amountOut);
          }
        });

        it(`cross-anchor: envelope holds through the anchor transition (${presetName})`, async function () {
          // Drain quote 30% so the pool sits with pMarg > anchor; an
          // exact-output buy of base then drives reserves *back through*
          // the anchor and out the other side. The resolver has to
          // handle the sign flip cleanly.
          const fx = await setupBalanced(presetName);
          await deplete(fx, "quote", 3_000n);
          const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, "baseToQuote");
          const outReserve = await liveReserveOf(fx, tokenOut);
          // Aim for ~70% of the depleted-side reserve so the swap
          // crosses the anchor on its way back.
          const amountOut = (outReserve * 7_000n) / 10_000n;
          const quoted = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
          if (quoted === 0n) {
            // Solver may refuse the cross-anchor probe if it's beyond
            // the feasibility envelope — bail honestly instead of
            // weakening the assertion.
            this.skip();
          }
          const realised = await execExactOutputSingle(fx, fx.trader, {
            tokenIn,
            tokenOut,
            amountOut,
            amountInMaximum: MaxUint256,
          });
          assertAmountInEnvelope(realised.amountInPulled, quoted, `${presetName}/cross-anchor`);
          expect(realised.amountOutReceived).to.equal(amountOut);
        });

        it(`round-trip: quoteExactIn(quoteExactOut(out)) >= out - residual (${presetName})`, async function () {
          // If the resolver under-stated `amountIn` for `out`, then
          // feeding the (under-stated) `amountIn` back through
          // `quoteExactIn` would yield strictly less than `out`. This
          // round-trip is therefore the lower-bound check that
          // complements the upper-bound `realised <= quoted` envelope:
          // together they sandwich `quoteExactOut` against the
          // curve-true minimum.
          const fx = await setupBalanced(presetName);
          const { zeroForOne } = dirAddrs(fx, "quoteToBase");
          const outReserveRaw = fx.initialBaseRaw;
          for (const bps of SIZE_BPS_OF_OUT_RESERVE) {
            const wantOut = (outReserveRaw * bps) / 10_000n;
            if (wantOut === 0n) continue;
            const dx = BigInt(await fx.pool.quoteExactOut(zeroForOne, wantOut));
            const dyBack = BigInt(await fx.pool.quoteExactIn(zeroForOne, dx));
            // Allow secant residual + ceil-rounding bias: ≤ 1 ppb of
            // wantOut + 4096 wei. Any larger drift indicates the
            // resolver under-priced `dx` for `wantOut`.
            const tol = wantOut / 10n ** 9n + 4_096n;
            expect(
              dyBack,
              `${presetName}/${bps}bps: round-trip out=${wantOut} dx=${dx} dyBack=${dyBack}`
            ).to.be.greaterThanOrEqual(wantOut - tol);
          }
        });

        it(`round-trip: quoteExactOut(quoteExactIn(in)) <= in + tiny tolerance (${presetName})`, async function () {
          const fx = await setupBalanced(presetName);
          const { zeroForOne } = dirAddrs(fx, "quoteToBase");
          const inReserveRaw = fx.initialQuoteRaw;
          for (const bps of [50n, 200n, 1_000n]) {
            const dxIn = (inReserveRaw * bps) / 10_000n;
            if (dxIn === 0n) continue;
            const dy = BigInt(await fx.pool.quoteExactIn(zeroForOne, dxIn));
            if (dy === 0n) continue;
            const dxBack = BigInt(await fx.pool.quoteExactOut(zeroForOne, dy));
            // The structural bound on `quoteExactOut` is tighter than
            // the back-leg here because the pool's exact-out resolver
            // ceil-rounds on the input side. Allow a few wei + ppb
            // bias matching the documented tolerance.
            const tol = dxIn / 10n ** 9n + 4_096n;
            expect(
              dxBack,
              `${presetName}/${bps}bps: inverse round-trip in=${dxIn} dy=${dy} dxBack=${dxBack}`
            ).to.be.lessThanOrEqual(dxIn + tol);
          }
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Block 2 — slippage cap and domain reverts.
  // -------------------------------------------------------------------------

  describe("slippage cap and domain reverts (WETH preset)", function () {
    it("amountInMaximum == quote: succeeds at the safe boundary", async function () {
      // `quoted` is the documented upper bound on what the live swap
      // pulls; setting `amountInMaximum == quoted` must therefore
      // never trip `ExcessiveInputAmount` regardless of the per-leg
      // ceil-rounding drift.
      const fx = await setupBalanced("WETH");
      const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, "quoteToBase");
      const amountOut = fx.initialBaseRaw / 1_000n; // 0.1% of base reserve
      const quoted = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
      const realised = await execExactOutputSingle(fx, fx.trader, {
        tokenIn,
        tokenOut,
        amountOut,
        amountInMaximum: quoted,
      });
      assertAmountInEnvelope(realised.amountInPulled, quoted, "boundary cap = quoted");
      expect(realised.amountOutReceived).to.equal(amountOut);
    });

    it("amountInMaximum below quote/2: reverts with ExcessiveInputAmount", async function () {
      // Half the quote is well below any plausible drift envelope,
      // so the slippage gate must fire. We deliberately do NOT use
      // `quoted - 1` here because the live `realised` may be `quoted`
      // or `quoted - 1` depending on per-leg ceiling rounding — that
      // would make the test outcome dependent on rounding rather than
      // on the cap enforcement, which is what we actually want to
      // pin.
      const fx = await setupBalanced("WETH");
      const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, "quoteToBase");
      const amountOut = fx.initialBaseRaw / 1_000n;
      const quoted = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
      const cap = quoted / 2n;
      const traderAddr = await fx.trader.getAddress();
      const balBefore = BigInt(await fx.quote.balanceOf(traderAddr));
      await expect(
        fx.router.connect(fx.trader).exactOutputSingle({
          tokenIn,
          tokenOut,
          poolIndex: 0,
          recipient: traderAddr,
          amountOut,
          amountInMaximum: cap,
          deadline: (await currentBlockTime()) + 3600,
        })
      ).to.be.revertedWithCustomError(fx.router, "ExcessiveInputAmount");
      // Trader balance must be untouched after the revert — the
      // router's check fires AFTER the pool callback, so the swap
      // tx as a whole must be rolled back.
      expect(BigInt(await fx.quote.balanceOf(traderAddr))).to.equal(balBefore);
    });

    it("amountInMaximum == 1 for a non-trivial output: reverts with ExcessiveInputAmount", async function () {
      // Degenerate cap: any meaningful output requires far more than
      // 1 wei of input. The router must reject before any state
      // mutates — the trader's input balance must be unchanged after
      // the revert.
      const fx = await setupBalanced("WETH");
      const { tokenIn, tokenOut } = dirAddrs(fx, "quoteToBase");
      const amountOut = fx.initialBaseRaw / 1_000n;
      const traderAddr = await fx.trader.getAddress();
      const balBefore = BigInt(await fx.quote.balanceOf(traderAddr));
      await expect(
        fx.router.connect(fx.trader).exactOutputSingle({
          tokenIn,
          tokenOut,
          poolIndex: 0,
          recipient: traderAddr,
          amountOut,
          amountInMaximum: 1n,
          deadline: (await currentBlockTime()) + 3600,
        })
      ).to.be.revertedWithCustomError(fx.router, "ExcessiveInputAmount");
      const balAfter = BigInt(await fx.quote.balanceOf(traderAddr));
      expect(balAfter).to.equal(balBefore);
    });

    it("amountOut == 0: reverts with InvalidAmountSpecified", async function () {
      const fx = await setupBalanced("WETH");
      const { tokenIn, tokenOut } = dirAddrs(fx, "quoteToBase");
      // Router no longer short-circuits — the pool's `swap()` rejects
      // `amountSpecified == 0` with the dedicated error.
      await expect(
        fx.router.connect(fx.trader).exactOutputSingle({
          tokenIn,
          tokenOut,
          poolIndex: 0,
          recipient: await fx.trader.getAddress(),
          amountOut: 0n,
          amountInMaximum: MaxUint256,
          deadline: (await currentBlockTime()) + 3600,
        })
      ).to.be.revertedWithCustomError(fx.pool, "InvalidAmountSpecified");
    });

    it("expired deadline: reverts with DeadlineExpired", async function () {
      const fx = await setupBalanced("WETH");
      const { tokenIn, tokenOut } = dirAddrs(fx, "quoteToBase");
      const now = await currentBlockTime();
      await expect(
        fx.router.connect(fx.trader).exactOutputSingle({
          tokenIn,
          tokenOut,
          poolIndex: 0,
          recipient: await fx.trader.getAddress(),
          amountOut: fx.initialBaseRaw / 1_000n,
          amountInMaximum: MaxUint256,
          deadline: now - 1,
        })
      ).to.be.revertedWithCustomError(fx.router, "DeadlineExpired");
    });
  });

  // -------------------------------------------------------------------------
  // Block 3 — production fee curve (canonical preset).
  // The same conservation invariants must hold under the deployed fee
  // ramp. We re-use the canonical WETH preset's `feeBps`,
  // `feeRampBps`, `feeFloorBps` so a regression in the dynamic-fee
  // exact-out resolver surfaces here, not in synthetic-fee tests.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Block 3 — production fee curve (canonical preset).
  //
  // After the resolver unification, the live exact-out path uses the
  // SAME CP-projected fee surface as exact-in (and as `quoteExactOut`).
  // This eliminates the previous quote-vs-swap divergence under the
  // canonical preset and makes `quoteExactOut(out) == realised
  // amountIn` bit-exact (modulo the standard 1-wei ceiling overcharge
  // in favour of LPs). We pin that identity here for both presets and
  // both directions.
  // -------------------------------------------------------------------------

  describe("canonical preset fees (active dynamic ramp)", function () {
    for (const presetName of PRESET_NAMES) {
      it(`${presetName}: quote upper-bounds realised amountIn under active ramp (both directions)`, async function () {
        const preset = EQUILIBRA_PRESETS[presetName];
        const fx = await setupBalanced(presetName, {
          baseFee: preset.feeBps,
          feeRampBps: preset.feeRampBps,
          feeFloorBps: preset.feeFloorBps,
          repegShareBps: preset.repegShareBps,
        });
        for (const dir of DIRECTIONS) {
          const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, dir);
          const outReserveRaw = outReserveFor(fx, dir, "seed");
          for (const bps of [10n, 100n, 500n]) {
            const amountOut = (outReserveRaw * bps) / 10_000n;
            if (amountOut === 0n) continue;
            const quoted = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
            const realised = await execExactOutputSingle(fx, fx.trader, {
              tokenIn,
              tokenOut,
              amountOut,
              amountInMaximum: MaxUint256,
            });
            // Same envelope as pure curve — quote is a tight upper
            // bound, drift ≤ MAX_QUOTE_OVERSTATEMENT in favour of LPs.
            assertAmountInEnvelope(realised.amountInPulled, quoted, `${presetName}/${dir}/${bps}bps under active ramp`);
            expect(realised.amountOutReceived).to.equal(amountOut);
          }
        }
      });
    }
  });

  // -------------------------------------------------------------------------
  // Block 4 — narrow dynamic-fee ramps (non-iterative resolver stress).
  //
  // The exact-out path resolves the fee non-iteratively in
  // `_executeExactOutWithDynamicFee` as the max of the CP-proxy fee at
  // the two ends of the realisable gross interval (the M-2 fix — the
  // CP distance is quasi-convex in the gross, so a fixed-point loop
  // would oscillate). Narrow ramps produce the steepest local
  // `dFee/dAmountIn` slope; the narrowest DEPLOYABLE ramp for a given
  // config is `ceil(FEE_RAMP_GUARD_MULT · BPS · span² / (BPS − baseFee)²)`
  // (anything below reverts `FeeRampTooNarrow`), so the sweep starts
  // exactly at that guard minimum. Because `quoteExactOut` and the swap
  // run the identical resolver, quote == swap holds exactly; we pin the
  // ≤ 1-wei quote↔swap envelope across these configs so any future
  // change to the resolver, the smoothstep math, or the gross-up
  // rounding is caught here (instead of deferring it to a
  // parity-vs-Rust failure later, where bisection is harder).
  // -------------------------------------------------------------------------

  describe("narrow dynamic-fee ramp (non-iterative resolver stress)", function () {
    const FEE_RAMP_GUARD_MULT = 12;
    const narrowRampsFor = (presetName: PresetName): number[] => {
      const preset = EQUILIBRA_PRESETS[presetName];
      const headroomFloor = Math.min(preset.feeFloorBps, Math.max(1, Math.floor(preset.feeBps / 2)));
      const span = preset.feeBps - headroomFloor;
      const inv = 10_000 - preset.feeBps;
      const minLegal = Math.ceil((FEE_RAMP_GUARD_MULT * 10_000 * span * span) / (inv * inv));
      return [...new Set([minLegal, 2 * minLegal, Math.max(50, minLegal)])].sort((a, b) => a - b);
    };

    for (const presetName of PRESET_NAMES) {
      for (const rampBps of narrowRampsFor(presetName)) {
        it(`${presetName}, feeRampBps=${rampBps}: quote ↔ swap drift ≤ 1 wei across the size sweep`, async function () {
          const preset = EQUILIBRA_PRESETS[presetName];
          // Pin `feeFloorBps` strictly below `baseFee` so the
          // smoothstep ramp always has headroom to interpolate into.
          // The factory's `FeeRampNoHeadroom` invariant rejects
          // `feeRampBps != 0` with `feeFloorBps == baseFee`, which is
          // a sane production guard — but the *purpose* of this test
          // is to stress the non-iterative endpoint-max fee resolver,
          // so we ensure the ramp is actually live regardless of how the preset
          // configures its default fee schedule (e.g. flat-fee
          // opt-out presets where `feeFloorBps == baseFee`).
          const headroomFloor = Math.min(preset.feeFloorBps, Math.max(1, Math.floor(preset.feeBps / 2)));
          const fx = await setupBalanced(presetName, {
            baseFee: preset.feeBps,
            feeRampBps: rampBps,
            feeFloorBps: headroomFloor,
            repegShareBps: preset.repegShareBps,
          });
          for (const dir of DIRECTIONS) {
            const { tokenIn, tokenOut, zeroForOne } = dirAddrs(fx, dir);
            const outReserveRaw = outReserveFor(fx, dir, "seed");
            // Size sweep brackets the narrow transition zone: tiny
            // swaps stay near the floor, large swaps saturate at
            // baseFee, mid-size swaps land inside the smoothstep
            // where the slope is steepest — the regime where the
            // endpoint-max resolver's conservatism is widest.
            for (const bps of [1n, 10n, 50n, 200n, 500n, 1_000n]) {
              const amountOut = (outReserveRaw * bps) / 10_000n;
              if (amountOut === 0n) continue;
              const quoted = BigInt(await fx.pool.quoteExactOut(zeroForOne, amountOut));
              expect(quoted, `${presetName}/ramp=${rampBps}/${dir}/${bps}bps: quote returned 0`).to.be.greaterThan(0n);

              const realised = await execExactOutputSingle(fx, fx.trader, {
                tokenIn,
                tokenOut,
                amountOut,
                amountInMaximum: MaxUint256,
              });
              assertAmountInEnvelope(realised.amountInPulled, quoted, `${presetName}/ramp=${rampBps}/${dir}/${bps}bps`);
              expect(realised.amountOutReceived).to.equal(amountOut);
            }
          }
        });
      }
    }
  });
});
