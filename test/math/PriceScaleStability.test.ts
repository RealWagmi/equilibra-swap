// ТЗ-V15 § 9.4 #3 — pool-level invariance of `priceScaleWad` between
// swaps that don't trigger an auto-repeg.
//
// The asymmetric coord change drops the `_sqrtPriceScaleWad` cache slot
// the prior symmetric design relied on — the math-space lift is now
// `yMath = yWad · WAD / priceScale`, which only needs the raw
// `priceScale`. The behavioural invariant the swap path depends on is
// unchanged, though:
//   * `priceScaleWad` is written on genesis init and on every
//     successful `_tryAutoRepeg` (signalled by `PriceScaleUpdated`).
//   * Between consecutive swaps that DO NOT emit
//     `PriceScaleUpdated`, the stored value stays bit-identical.
//
// This file pins that observable contract: tiny probes never move the
// scale, and the only event that moves it is `PriceScaleUpdated`.
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";

import {
  baseRawToQuoteRaw,
  buildPreset,
  currentBlockTime,
  deploySecurityFixture,
  type SecurityFixture,
} from "../helpers/securityFixtures";

async function captureOracle(fx: SecurityFixture): Promise<{
  priceScaleWad: bigint;
  emaPriceWad: bigint;
}> {
  const oracle = await fx.pool.getOracleState();
  return {
    priceScaleWad: BigInt(oracle.priceScaleWad),
    emaPriceWad: BigInt(oracle.emaPriceWad),
  };
}

async function swapAndDetectRepeg(
  fx: SecurityFixture,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  ts: number
): Promise<boolean> {
  await time.setNextBlockTimestamp(ts);
  const tx = await fx.router.connect(fx.attacker).exactInputSingle({
    tokenIn,
    tokenOut,
    poolIndex: 0,
    recipient: await fx.attacker.getAddress(),
    amountIn,
    amountOutMinimum: 0,
    deadline: ts + 600,
  });
  const receipt = await tx.wait();
  const priceScaleTopic = fx.pool.interface.getEvent("PriceScaleUpdated").topicHash;
  return receipt!.logs.some(
    (log: any) =>
      log.address.toLowerCase() === (fx.pool.target as string).toLowerCase() && log.topics[0] === priceScaleTopic
  );
}

async function snapshotFixtureWETH() {
  const preset = buildPreset("WETH", {
    baseFee: 100,
    feeRampBps: 1000,
    // Production WETH floor (60 bps): keeps the stall-guard cap
    // (floor·1e14 = 6e15) above the preset's 5e15 repeg threshold.
    feeFloorBps: 60,
    repegShareBps: 5_000,
  });
  const fx = await deploySecurityFixture(preset);
  return { fx, preset };
}

describe("PriceScaleStability: pool-level invariance between swaps (ТЗ §9.4 #3)", function () {
  this.timeout(180_000);

  it("priceScaleWad is invariant across swaps that do NOT emit PriceScaleUpdated", async function () {
    const { fx, preset } = await loadFixture(snapshotFixtureWETH);
    const baseAddr = await fx.base.getAddress();
    const quoteAddr = await fx.quote.getAddress();

    const genesis = await captureOracle(fx);
    expect(genesis.priceScaleWad, "priceScaleWad must be > 0 at genesis").to.be.greaterThan(0n);

    // Tiny probes (sub-1 bp of base reserve) — way below the
    // `≥ 1e15` activation dead-bands, so the auto-repeg
    // gate stays shut and the price scale MUST not change.
    const reserves = await fx.pool.getReserves();
    const baseIsToken0 = (await fx.pool.getPoolMetadata()).token0.toLowerCase() === baseAddr.toLowerCase();
    const baseReserve = BigInt(reserves[baseIsToken0 ? 0 : 1]);
    const microIn = (baseReserve * 5n) / 100_000n; // 0.005 %

    let prev = genesis;
    for (let i = 0; i < 6; i += 1) {
      const ts = (await currentBlockTime()) + 300;
      const repegged = await swapAndDetectRepeg(
        fx,
        i % 2 === 0 ? baseAddr : quoteAddr,
        i % 2 === 0 ? quoteAddr : baseAddr,
        i % 2 === 0 ? microIn : baseRawToQuoteRaw(microIn, preset),
        ts
      );
      const cur = await captureOracle(fx);
      if (!repegged) {
        expect(
          cur.priceScaleWad,
          `iteration ${i}: priceScaleWad changed without a PriceScaleUpdated event ` +
            `(before=${prev.priceScaleWad} after=${cur.priceScaleWad})`
        ).to.equal(prev.priceScaleWad);
      }
      prev = cur;
    }
  });

  it("priceScaleWad moves on PriceScaleUpdated AND only on PriceScaleUpdated", async function () {
    const { fx } = await loadFixture(snapshotFixtureWETH);
    const baseAddr = await fx.base.getAddress();
    const quoteAddr = await fx.quote.getAddress();

    // Drive directional volume to force a repeg. 10 % per leg pushes
    // the EMA hard past the activation threshold.
    const reserves = await fx.pool.getReserves();
    const baseIsToken0 = (await fx.pool.getPoolMetadata()).token0.toLowerCase() === baseAddr.toLowerCase();
    const baseReserve = BigInt(reserves[baseIsToken0 ? 0 : 1]);
    const sweepIn = (baseReserve * 1_000n) / 10_000n;

    let sawRepeg = false;
    let prev = await captureOracle(fx);
    for (let i = 0; i < 24 && !sawRepeg; i += 1) {
      const ts = (await currentBlockTime()) + 300;
      const repegged = await swapAndDetectRepeg(fx, baseAddr, quoteAddr, sweepIn, ts);
      const cur = await captureOracle(fx);
      if (repegged) {
        sawRepeg = true;
        expect(
          cur.priceScaleWad,
          `PriceScaleUpdated fired but priceScale did not change ` +
            `(before=${prev.priceScaleWad} after=${cur.priceScaleWad})`
        ).to.not.equal(prev.priceScaleWad);
        // After the repeg, `priceScaleWad` must remain strictly
        // positive — collapsing to zero would brick every subsequent
        // swap's coordinate-change lift (divWad-by-zero revert).
        expect(cur.priceScaleWad, "priceScaleWad collapsed to 0 after PriceScaleUpdated").to.be.greaterThan(0n);
      } else {
        expect(
          cur.priceScaleWad,
          `iteration ${i}: priceScale changed without PriceScaleUpdated ` +
            `(before=${prev.priceScaleWad} after=${cur.priceScaleWad})`
        ).to.equal(prev.priceScaleWad);
      }
      prev = cur;
    }
    expect(sawRepeg, "scenario failed to force a repeg in 24 sweeps (preset misconfigured?)").to.equal(true);
  });
});
