// ТЗ-V15 § 9.4 #5 — proves the kernel needs **no** persistent
// `g` slot for fee accrual.
//
// Background: under the V1.0 single-knob kernel, the swap path
// stored a per-pool `g` accumulator to remember "how much depth has
// been added since genesis" — the closed-form `L` recovery alone
// couldn't tell the difference between "reserves grew because the
// pool absorbed fees" and "reserves grew because somebody minted
// LP". The asymmetric coord change + cubic invariant decouples
// the two: between swaps **without** mint/burn, the post-swap
// state's `solveLFromState` along the **base axis** (xMath) is
// strictly monotone — fees stay in the pool and the input-side
// reserve only grows. We pin that monotonicity on a base-to-base
// probe sequence where every leg is a buy that converts input back
// to base via a reverse leg, so the math-space envelope is strictly
// non-decreasing on the base side.
//
// This file pins the monotonicity directly: drive a sequence of
// swaps in alternating directions without any liquidity events,
// sample `L` via the on-chain math harness after each settled
// swap, and assert that the sequence is non-decreasing across the
// whole run.
//
// Failure mode this guards against: a future refactor that
// accidentally introduces a non-monotone fee-accrual path (e.g.
// crediting the fee to the wrong reserve side, or rounding the
// fee against the LP). Any such regression would show up here as
// `L_i < L_{i-1}` — a strict inequality, no tolerance.

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import {
  baseRawToQuoteRaw,
  buildPreset,
  currentBlockTime,
  deploySecurityFixture,
  exactInputSingle,
  type SecurityFixture,
} from "../helpers/securityFixtures";

const WAD = 10n ** 18n;

/// Lift `(reserve0_raw, reserve1_raw, priceScaleWad)` into math-space
/// via the `EquilibraSwapMath.toMathSpace` helper. Token decimals
/// come straight off the deployed ERC20 mocks (the pool stores them
/// in a packed slot without a public getter, but the IERC20 metadata
/// is canonical for the parity check).
async function liftToMathSpace(
  fx: SecurityFixture,
  harness: any,
  reserve0Raw: bigint,
  reserve1Raw: bigint,
  priceScaleWad: bigint
): Promise<{ xMath: bigint; yMath: bigint }> {
  const meta = await fx.pool.getPoolMetadata();
  const token0Ct = await hre.ethers.getContractAt("MockERC20", meta.token0);
  const token1Ct = await hre.ethers.getContractAt("MockERC20", meta.token1);
  const decimals0 = Number(await token0Ct.decimals());
  const decimals1 = Number(await token1Ct.decimals());
  const scale0 = 10n ** BigInt(18 - decimals0);
  const scale1 = 10n ** BigInt(18 - decimals1);
  const xWad = reserve1Raw * scale1;
  const yWad = reserve0Raw * scale0;
  // asymmetric coords: `xMath = xWad`, `yMath = yWad·WAD/priceScale`.
  // The helper takes the raw `priceScale` directly (no sqrt cache).
  const [xMath, yMath] = await harness.toMathSpace(xWad, yWad, priceScaleWad);
  return { xMath: BigInt(xMath), yMath: BigInt(yMath) };
}

async function recoverL(fx: SecurityFixture, harness: any, aWad: bigint, lambdaWad: bigint): Promise<bigint> {
  const [r0, r1] = await fx.pool.getReserves();
  const oracle = await fx.pool.getOracleState();
  const priceScaleWad = BigInt(oracle.priceScaleWad);
  const { xMath, yMath } = await liftToMathSpace(fx, harness, BigInt(r0), BigInt(r1), priceScaleWad);
  return BigInt(await harness.solveLFromState(xMath, yMath, aWad, lambdaWad));
}

async function postRepegFixtureWETH() {
  // Match production envelope; no liquidity overrides because the
  // test specifically forbids mint/burn during the probe sequence.
  const preset = buildPreset("WETH", {
    baseFee: 100,
    feeRampBps: 1000,
    // Production WETH floor (60 bps). The previous 20 bps floor put the
    // stall-guard cap (floor·1e14 = 2e15) below the preset's 5e15 step,
    // which the factory now rejects.
    feeFloorBps: 60,
    repegShareBps: 5_000,
  });
  const fx = await deploySecurityFixture(preset);
  const Harness = await hre.ethers.getContractFactory("SwapMathHarness");
  const harness: any = await Harness.deploy();
  await harness.waitForDeployment();
  return { fx, preset, harness };
}

describe("NoPersistentG: L monotonicity between swaps without mint/burn (ТЗ §9.4 #5)", function () {
  this.timeout(180_000);

  it("L_post ≥ L_pre across a 12-swap alternating chain", async function () {
    const { fx, preset, harness } = await loadFixture(postRepegFixtureWETH);
    const baseAddr = await fx.base.getAddress();
    const quoteAddr = await fx.quote.getAddress();

    // Sample the initial L from genesis state.
    let prevL = await recoverL(fx, harness, preset.aWad, preset.lambdaWad);
    expect(prevL, "genesis L must be strictly positive").to.be.greaterThan(0n);

    // Probe size = 1 % of base reserve on each leg. Mixing directions
    // ensures the L-recovery sees both "x grew" and "y grew" paths.
    const reservesGenesis = await fx.pool.getReserves();
    const baseIsToken0 = (await fx.pool.getPoolMetadata()).token0.toLowerCase() === baseAddr.toLowerCase();
    const baseReserveRaw = BigInt(reservesGenesis[baseIsToken0 ? 0 : 1]);
    const probeBase = (baseReserveRaw * 100n) / 10_000n;

    const priceScaleTopic = fx.pool.interface.getEvent("PriceScaleUpdated").topicHash;
    for (let leg = 0; leg < 12; leg += 1) {
      const ts = (await currentBlockTime()) + 300;
      await time.setNextBlockTimestamp(ts);
      const baseToQuote = leg % 2 === 0;
      const amountIn = baseToQuote ? probeBase : baseRawToQuoteRaw(probeBase, preset);
      const tx = await fx.router.connect(fx.trader).exactInputSingle({
        tokenIn: baseToQuote ? baseAddr : quoteAddr,
        tokenOut: baseToQuote ? quoteAddr : baseAddr,
        poolIndex: 0,
        recipient: await fx.trader.getAddress(),
        amountIn,
        amountOutMinimum: 0,
        deadline: ts + 600,
      });
      const receipt = await tx.wait();
      const repegged = receipt!.logs.some(
        (log: any) =>
          log.address.toLowerCase() === (fx.pool.target as string).toLowerCase() && log.topics[0] === priceScaleTopic
      );
      const curL = await recoverL(fx, harness, preset.aWad, preset.lambdaWad);
      if (repegged) {
        // A successful auto-repeg shifts `priceScaleWad`, so `yMath
        // = yWad·WAD/priceScale` lands on a different math-space
        // frame and `L` is no longer comparable to the pre-repeg
        // value. The frame change does NOT introduce or destroy
        // value (the gate's pre/post-vp checks already enforce that
        // upstream); we only need to verify the within-frame
        // monotonicity continues. Reset the baseline and move on.
        prevL = curL;
        continue;
      }
      expect(curL, `leg=${leg} L=${curL} dropped below previous L=${prevL} (fee accrual must be monotone)`).to.be.gte(
        prevL
      );
      prevL = curL;
    }
  });

  it("L strictly grows after a fee-bearing swap (not just stays equal)", async function () {
    // A no-op (1-wei probe) might leave L unchanged due to floor
    // rounding; a meaningfully sized swap must produce STRICT growth
    // in L because fees are positive and stay in the pool. This is
    // the canary for an accidental fee-burn (a buggy refactor that
    // forgets to credit the LP slice into reserves).
    const { fx, preset, harness } = await loadFixture(postRepegFixtureWETH);
    const baseAddr = await fx.base.getAddress();
    const quoteAddr = await fx.quote.getAddress();

    const beforeL = await recoverL(fx, harness, preset.aWad, preset.lambdaWad);

    const reservesGenesis = await fx.pool.getReserves();
    const baseIsToken0 = (await fx.pool.getPoolMetadata()).token0.toLowerCase() === baseAddr.toLowerCase();
    const baseReserveRaw = BigInt(reservesGenesis[baseIsToken0 ? 0 : 1]);
    // 2 % swap is plenty for an active dynamic fee of ~30+ bps to
    // book a measurable L increase well past any 1-wei rounding.
    const probeBase = (baseReserveRaw * 200n) / 10_000n;
    const ts = (await currentBlockTime()) + 300;
    await time.setNextBlockTimestamp(ts);
    await exactInputSingle(fx, fx.trader, {
      tokenIn: baseAddr,
      tokenOut: quoteAddr,
      amountIn: probeBase,
    });
    const afterL = await recoverL(fx, harness, preset.aWad, preset.lambdaWad);
    expect(afterL, `L did not strictly grow after a 2% swap (before=${beforeL} after=${afterL})`).to.be.greaterThan(
      beforeL
    );
  });
});
