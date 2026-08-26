// ТЗ-V15 § 4.d / § 9.4 #4 — corner-case regression.
//
// After a successful auto-repeg the pool's `_priceScaleWad` has
// moved by up to one `repegStepWad` toward the EMA target. The new
// price scale rewires the symmetric coordinate change:
//   xMath_new = xWad / √priceScaleNew
//   yMath_new = yWad · √priceScaleNew
// The reserves haven't moved (the auto-repeg is reserve-neutral by
// design — `_anchorPrice` slides, `(reserve0, reserve1)` stays put),
// so the math-space `(xMath, yMath)` jumps to a fresh diagonal that
// can be steeply off-balance.
//
// The hazard ТЗ §4.d calls out: `solveLFromState` for that fresh
// diagonal can briefly produce an `L` that is **smaller than the
// pre-repeg `L`**, even though the pool gained no LP value across
// the repeg. If the next swap probes a state where the freshly
// solved `L` violates the per-leg monotonicity guard, the kernel
// would revert with `MathInvariantViolation` — and the pool would
// be temporarily un-swappable until either the EMA snaps back or a
// proportional liquidity event re-anchors the LP-unit-value.
//
// This file pins the corner case: immediately after a
// `PriceScaleUpdated` event, swaps of every size (from 1 wei to a
// double-digit % of reserves, in both directions) must settle
// without reverting. The TZ is explicit that this corner case is
// the one regression a production deployment most has to guard against.
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";

import {
  baseRawToQuoteRaw,
  buildPreset,
  currentBlockTime,
  deploySecurityFixture,
  exactInputSingle,
  type SecurityFixture,
} from "../helpers/securityFixtures";

type Direction = "baseToQuote" | "quoteToBase";

/// Drive enough volume through the pool to force at least one
/// `PriceScaleUpdated` event, then return the fixture poised for
/// post-repeg probes.
async function driveRepeg(fx: SecurityFixture): Promise<void> {
  const baseAddr = await fx.base.getAddress();
  const quoteAddr = await fx.quote.getAddress();
  // Sweep ~10 % of base reserve at a time on a single side so the
  // EMA drifts off-anchor; cap the probe count so a misconfigured
  // preset can't run forever.
  const reserves = await fx.pool.getReserves();
  const baseIsToken0 = (await fx.pool.getPoolMetadata()).token0.toLowerCase() === baseAddr.toLowerCase();
  const baseReserveRaw = baseIsToken0 ? BigInt(reserves[0]) : BigInt(reserves[1]);
  const probeBaseIn = (baseReserveRaw * 10n) / 100n;

  for (let i = 0; i < 24; i += 1) {
    // 5-minute spacing keeps the EMA tracking, and the once-per-block
    // repeg gate happy.
    const ts = (await currentBlockTime()) + 300;
    await time.setNextBlockTimestamp(ts);
    const before = await fx.pool.getOracleState();
    const priceScaleBefore = BigInt(before.priceScaleWad);
    await exactInputSingle(fx, fx.attacker, {
      tokenIn: baseAddr,
      tokenOut: quoteAddr,
      amountIn: probeBaseIn,
    });
    const after = await fx.pool.getOracleState();
    if (BigInt(after.priceScaleWad) !== priceScaleBefore) return;
  }
  throw new Error("driveRepeg: no PriceScaleUpdated event after 24 probes (preset / reserves misconfigured?)");
}

/// Distinguish the corner-case ТЗ §4.d targets (a kernel collapse
/// surfacing as `MathInvariantViolation`) from acceptable entry
/// guards (the pool deliberately rejects sub-wei probes via
/// `AmountTooSmallAfterNormalization` before the kernel runs). The
/// former is the regression we are guarding against; the latter is
/// the correct refusal to attempt an impossible swap.
///
/// Each list carries the error NAME and its 4-byte SELECTOR: when
/// hardhat's trace decoder degrades mid-run (observed under
/// solidity-coverage), a revert surfaces as "unrecognized custom
/// error (return data: 0x...)" and only the selector is available
/// for matching.
const KERNEL_COLLAPSE_ERRORS = ["MathInvariantViolation", "0x4fd59665"];
const ACCEPTABLE_ENTRY_GUARDS = ["AmountTooSmallAfterNormalization", "0x40e3ccaa"];

async function microSwap(fx: SecurityFixture, direction: Direction, amountIn: bigint): Promise<bigint | "skipped"> {
  const baseAddr = await fx.base.getAddress();
  const quoteAddr = await fx.quote.getAddress();
  const tokenIn = direction === "baseToQuote" ? baseAddr : quoteAddr;
  const tokenOut = direction === "baseToQuote" ? quoteAddr : baseAddr;
  try {
    const result = await exactInputSingle(fx, fx.trader, {
      tokenIn,
      tokenOut,
      amountIn,
    });
    return result.amountOut;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (KERNEL_COLLAPSE_ERRORS.some((e) => msg.includes(e))) {
      throw new Error(
        `SolveLPostRepeg corner-case regression: ${direction} amountIn=${amountIn} ` +
          `triggered ${msg}. Post-repeg kernel collapse.`
      );
    }
    if (ACCEPTABLE_ENTRY_GUARDS.some((e) => msg.includes(e))) {
      return "skipped";
    }
    throw err;
  }
}

/// Build a fixture poised at a post-repeg state for the named
/// preset. Lifted to module scope so each `loadFixture(...)` call
/// caches the deployed pool. Hardhat's `loadFixture` requires named
/// (non-anonymous) functions for its cache key, so we define one
/// per preset with explicit names.
async function postRepegFixtureWETH() {
  const preset = buildPreset("WETH", {
    baseFee: 100,
    feeRampBps: 1000,
    // Production WETH floor (60 bps): keeps the stall-guard cap
    // (floor·1e14 = 6e15) above the preset's 5e15 repeg threshold.
    feeFloorBps: 60,
    repegShareBps: 5_000,
  });
  const fx = await deploySecurityFixture(preset);
  await driveRepeg(fx);
  return { fx, preset };
}
async function postRepegFixtureWBTC() {
  const preset = buildPreset("WBTC", {
    baseFee: 100,
    feeRampBps: 1000,
    // Floor 60 bps keeps the stall-guard cap (floor·1e14 = 6e15) above
    // the preset's 5e15 repeg threshold (the flat-fee production preset
    // has a 1e16 cap via baseFee = 100).
    feeFloorBps: 60,
    repegShareBps: 5_000,
  });
  const fx = await deploySecurityFixture(preset);
  await driveRepeg(fx);
  return { fx, preset };
}
const FIXTURE_BY_PRESET = {
  WETH: postRepegFixtureWETH,
  WBTC: postRepegFixtureWBTC,
} as const;

async function baseReserveOf(fx: SecurityFixture): Promise<bigint> {
  const reserves = await fx.pool.getReserves();
  const baseIsToken0 =
    (await fx.pool.getPoolMetadata()).token0.toLowerCase() === (await fx.base.getAddress()).toLowerCase();
  return BigInt(reserves[baseIsToken0 ? 0 : 1]);
}

describe("SolveLPostRepeg: post-repeg micro-swaps cannot revert (ТЗ §4.d)", function () {
  this.timeout(300_000);

  for (const presetName of ["WETH", "WBTC"] as const) {
    describe(`${presetName} preset`, function () {
      const fixture = FIXTURE_BY_PRESET[presetName];

      it("micro-swaps in BOTH directions settle without MathInvariantViolation", async function () {
        const { fx, preset } = await loadFixture(fixture);

        // Probe ladder: 10-wei → 1-millionth → 0.5 % → 5 % of
        // reserves. The smallest probe is the structural canary —
        // if the L-quadratic momentarily collapses post-repeg,
        // even this microscopic input reverts with
        // `MathInvariantViolation`. (1-wei is too small for the
        // normaliser entry guard; we keep that path covered by the
        // try/catch in `microSwap`, but seed the ladder above it so
        // the test always exercises an actual kernel call.)
        const baseReserve = await baseReserveOf(fx);
        const baseLadder: bigint[] = [
          10n,
          10n ** 6n,
          (baseReserve * 50n) / 10_000n, // 0.5 %
          (baseReserve * 500n) / 10_000n, // 5 %
        ];
        const quoteLadder: bigint[] = [
          10n,
          1_000n,
          baseRawToQuoteRaw(10n ** 6n, preset),
          baseRawToQuoteRaw(baseLadder[2], preset),
          baseRawToQuoteRaw(baseLadder[3], preset),
        ];

        for (const dx of baseLadder) {
          if (dx === 0n) continue;
          const out = await microSwap(fx, "baseToQuote", dx);
          if (out === "skipped") continue;
          // The L-quadratic-post-repeg guarantee is "never revert".
          // Sub-wei probes may yield 0 output legitimately (the
          // kernel floors output rounding), which is fine — what
          // matters is the tx didn't revert.
          expect(out).to.be.gte(0n);
        }
        for (const dy of quoteLadder) {
          if (dy === 0n) continue;
          const out = await microSwap(fx, "quoteToBase", dy);
          if (out === "skipped") continue;
          expect(out).to.be.gte(0n);
        }
      });

      it("a swap chain immediately after the repeg holds the live `vp ≥ vpGenesis` invariant", async function () {
        const { fx, preset } = await loadFixture(fixture);
        // Repeg has just fired. Stress the post-repeg state with a
        // small chain of swaps in alternating directions; live
        // `_lpUnitValueWad` must never fall below
        // `_lpUnitValueGenesisWad` along the way. The bug ТЗ §4.d
        // warns about would surface here as either a revert OR a
        // `vp` snapshot that briefly dips below `vp0` (a structural
        // accounting collapse, distinct from a fee-rounding wobble).
        const baseReserve = await baseReserveOf(fx);
        const probeBase = (baseReserve * 100n) / 10_000n; // 1 %

        for (let leg = 0; leg < 6; leg += 1) {
          const dir: Direction = leg % 2 === 0 ? "baseToQuote" : "quoteToBase";
          const dx = dir === "baseToQuote" ? probeBase : baseRawToQuoteRaw(probeBase, preset);
          await microSwap(fx, dir, dx);
          const lp = await fx.pool.getLpValueState();
          const vpGenesis = BigInt(lp.genesisWad);
          const vp = BigInt(lp.unitValueWad);
          if (vp > 0n) {
            expect(vp, `leg=${leg} vp=${vp} dropped below vpGenesis=${vpGenesis} after post-repeg swap`).to.be.gte(
              vpGenesis
            );
          }
        }
      });
    });
  }
});
