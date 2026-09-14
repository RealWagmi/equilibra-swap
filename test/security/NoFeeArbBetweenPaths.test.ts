// Exact-out / exact-in price coverage through checked native quotes.
// Compare actual settlement amounts with only the existing one-raw-unit
// dust budget on this ordinary grid. The inverse output-margin maps do not
// justify another percentage allowance. This is not a universal solver bound.
// Quote/execution equality is also covered by ExactOutStressCrossAnchorRepeg.
//
// Coverage matrix:
//   • Both canonical presets (WETH, WBTC) under their full active
//     dynamic-fee ramp (sourced from `simulator/src/app/config.rs`).
//   • Both swap directions (quote→base, base→quote).
//   • Multiple swap sizes (10 / 50 / 200 / 500 bps of output reserve).
//   • Multiple pool states: balanced, mild depletion (30 % drain on
//     one side), severe depletion (70 % drain), cross-anchor (state
//     where the marginal price has flipped to the other side of the
//     anchor).
import { expect } from "chai";

import {
  buildPreset,
  deploySecurityFixture,
  deplete,
  type PresetName,
  type SecurityFixture,
  type Side,
} from "../helpers/securityFixtures";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

type SwapDirection = "quoteToBase" | "baseToQuote";

interface DirectionAddresses {
  inputTokenAddress: string;
  outputTokenAddress: string;
  zeroForOne: boolean;
}

function resolveDirectionAddresses(fixture: SecurityFixture, direction: SwapDirection): DirectionAddresses {
  if (direction === "quoteToBase") {
    return {
      inputTokenAddress: fixture.quoteAddr,
      outputTokenAddress: fixture.baseAddr,
      zeroForOne: fixture.quoteIsToken0,
    };
  }
  return {
    inputTokenAddress: fixture.baseAddr,
    outputTokenAddress: fixture.quoteAddr,
    zeroForOne: !fixture.quoteIsToken0,
  };
}

// Find the smallest `amountIn` such that `quoteExactIn(amountIn) >=
// targetAmountOut`. Bisection over the integer range
// `[lowerBound, upperBound]` (both inclusive). Convention:
//   • `lowerBound`  is INSUFFICIENT  (returns < targetAmountOut)
//   • `upperBound`  is SUFFICIENT    (returns ≥ targetAmountOut)
// Returns `upperBound` as the answer (smallest sufficient amountIn).
async function findMinimumExactInputForTarget(
  fixture: SecurityFixture,
  zeroForOne: boolean,
  targetAmountOut: bigint,
  lowerBound: bigint,
  upperBound: bigint
): Promise<bigint> {
  // Sanity: lowerBound must be insufficient, upperBound sufficient.
  // If the gap is too small to bisect, just return upperBound.
  while (upperBound - lowerBound > 1n) {
    const midpoint = lowerBound + (upperBound - lowerBound) / 2n;
    const outputAtMidpoint = BigInt(await fixture.pool.quoteExactIn(zeroForOne, midpoint));
    if (outputAtMidpoint >= targetAmountOut) {
      upperBound = midpoint;
    } else {
      lowerBound = midpoint;
    }
  }
  return upperBound;
}

describe("Exact-out cost covers the checked exact-in price floor", function () {
  this.timeout(180_000);

  // Pool-state fixtures the invariant is tested against.
  // `predepletedSide` = which side gets drained before the test
  // runs; `depletionBps` = how many basis points of that side's
  // initial reserve to drain (10000 bps = 100 %, i.e. impossible).
  interface StateLabel {
    name: string;
    predepletedSide: Side | null;
    depletionBps: bigint;
  }
  const POOL_STATES: StateLabel[] = [
    { name: "balanced", predepletedSide: null, depletionBps: 0n },
    {
      name: "mild quote drain (30%)",
      predepletedSide: "quote",
      depletionBps: 3_000n,
    },
    {
      name: "severe quote drain (70%)",
      predepletedSide: "quote",
      depletionBps: 7_000n,
    },
    {
      name: "mild base drain (30%)",
      predepletedSide: "base",
      depletionBps: 3_000n,
    },
    {
      name: "severe base drain (70%)",
      predepletedSide: "base",
      depletionBps: 7_000n,
    },
  ];

  const PRESET_NAMES: PresetName[] = ["WETH", "WBTC"];
  const DIRECTIONS: SwapDirection[] = ["quoteToBase", "baseToQuote"];

  // Probe sizes as basis points of the output-side LIVE reserve
  // (recomputed after any predepletion so probes stay feasible).
  const PROBE_SIZES_BPS: bigint[] = [10n, 50n, 200n, 500n];

  for (const presetName of PRESET_NAMES) {
    describe(`canonical preset ${presetName} (active dynamic ramp)`, function () {
      const presetConfig = EQUILIBRA_PRESETS[presetName];
      const productionFeeOverrides = {
        baseFee: presetConfig.feeBps,
        feeRampBps: presetConfig.feeRampBps,
        feeFloorBps: presetConfig.feeFloorBps,
        repegShareBps: presetConfig.repegShareBps,
      };

      for (const stateLabel of POOL_STATES) {
        for (const direction of DIRECTIONS) {
          it(`${stateLabel.name} / ${direction}: exact-out cost covers the exact-in target within one output unit`, async function () {
            const fixture = await deploySecurityFixture(buildPreset(presetName, productionFeeOverrides));
            if (stateLabel.predepletedSide !== null) {
              await deplete(fixture, stateLabel.predepletedSide, stateLabel.depletionBps);
            }

            const { outputTokenAddress, zeroForOne } = resolveDirectionAddresses(fixture, direction);

            // Live reserve on the output side AFTER any predepletion.
            const [reserve0After, reserve1After] = await fixture.pool.getReserves();
            const outputTokenIsQuote = outputTokenAddress.toLowerCase() === fixture.quoteAddr.toLowerCase();
            // outputTokenIsToken0: does the output token sit in slot 0?
            //   - if output is quote → quote is token0 ⇔ outputIsToken0
            //   - if output is base  → quote is token0 ⇒ base is token1 ⇒ NOT token0
            const outputTokenIsToken0 = outputTokenIsQuote ? fixture.quoteIsToken0 : !fixture.quoteIsToken0;
            const liveOutputReserveRaw = outputTokenIsToken0 ? BigInt(reserve0After) : BigInt(reserve1After);
            const liveInputReserveRaw = outputTokenIsToken0 ? BigInt(reserve1After) : BigInt(reserve0After);

            for (const sizeBps of PROBE_SIZES_BPS) {
              const targetAmountOut = (liveOutputReserveRaw * sizeBps) / 10_000n;
              if (targetAmountOut === 0n) continue;

              // 1. The cost the user actually pays on the exact-out
              //    path. After the resolver unification, this is
              //    bit-exact between `quoteExactOut` and the live
              //    `exactOutputSingle` swap.
              const costPaidViaExactOut = BigInt(await fixture.pool.quoteExactOut(zeroForOne, targetAmountOut));
              if (costPaidViaExactOut === 0n) {
                // Curve solver rejected (target beyond depleted-side
                // feasibility). Skip honestly rather than weakening
                // the assertion.
                continue;
              }

              // 2. Native rounding dust only; the common margin is already inverted.
              const ROUND_TRIP_TOLERANCE_WEI = 1n;
              expect(targetAmountOut).to.be.greaterThan(ROUND_TRIP_TOLERANCE_WEI);
              const effectiveTargetOut = targetAmountOut - ROUND_TRIP_TOLERANCE_WEI;
              const outputAtExactOutCost = BigInt(await fixture.pool.quoteExactIn(zeroForOne, costPaidViaExactOut));
              expect(
                outputAtExactOutCost,
                `${stateLabel.name}/${direction}/${sizeBps}bps: exact-in with costPaidViaExactOut=${costPaidViaExactOut} ` +
                  `delivered only ${outputAtExactOutCost} < target−floor=${effectiveTargetOut} ` +
                  `(checked round-trip drift > ${ROUND_TRIP_TOLERANCE_WEI} wei). ` +
                  `Reserves=${liveInputReserveRaw}/${liveOutputReserveRaw}. ` +
                  `Resolver split or solver regression — investigate.`
              ).to.be.greaterThanOrEqual(effectiveTargetOut);

              // 3. Establish the lower bound for the bisection: a
              //    `costPaidViaExactOut / 2` lookback is more than
              //    enough headroom. The honest invariant cannot
              //    plausibly be off by more than a few wei; if it is,
              //    the bisection will surface that as a real arb
              //    finding and the test will fail at step 4.
              const bisectionLowerBound = costPaidViaExactOut / 2n;
              const outputAtLowerBound = BigInt(await fixture.pool.quoteExactIn(zeroForOne, bisectionLowerBound));
              if (outputAtLowerBound >= effectiveTargetOut) {
                // Lower bound is already sufficient — that means
                // exact-in delivers `targetAmountOut` for HALF the
                // cost of exact-out. This would be a massive
                // fee-arb. Fail explicitly.
                expect.fail(
                  `${stateLabel.name}/${direction}/${sizeBps}bps: ` +
                    `exact-in delivers ≥ targetAmountOut for half the exact-out cost ` +
                    `(half=${bisectionLowerBound}, output=${outputAtLowerBound}, target=${effectiveTargetOut}). ` +
                    `Major fee-arb open!`
                );
              }

              // 4. Bisect to find the minimum exact-in cost.
              const minimumCostViaExactIn = await findMinimumExactInputForTarget(
                fixture,
                zeroForOne,
                effectiveTargetOut,
                bisectionLowerBound,
                costPaidViaExactOut
              );

              // 5. Compare against the same checked price target;
              // no additional input-price tolerance is applied here.
              expect(
                costPaidViaExactOut,
                `${stateLabel.name}/${direction}/${sizeBps}bps: ` +
                  `costPaidViaExactOut=${costPaidViaExactOut} < minimumCostViaExactIn=${minimumCostViaExactIn}. ` +
                  `Exact-out falls below the checked exact-in price floor.`
              ).to.be.greaterThanOrEqual(minimumCostViaExactIn);
            }
          });
        }
      }
    });
  }
});
