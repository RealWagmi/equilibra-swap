// Regression pin: `PriceScaleUpdated` must report the PRE-repeg price
// scale as `oldPriceScale` and the committed candidate as
// `newPriceScale`. A memory-aliasing slip in `_tryAutoRepeg`
// (`CurveSnapshot memory csAfter = cs` copies the pointer, so the
// probe's `csAfter.priceScaleWad = priceScaleNew` also rewrote
// `cs.priceScaleWad`) used to emit the committed value in BOTH
// fields, collapsing the (old, new) telemetry pair. The Rust
// simulator (`try_auto_repeg` → `RecenteringEventOut`) has always
// reported the genuine pair — this test keeps the contract aligned.
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";

import { buildPreset, currentBlockTime, deploySecurityFixture, exactInputSingle } from "../helpers/securityFixtures";

describe("PriceScaleUpdated event args (old, new) pair", function () {
  this.timeout(300_000);

  it("oldPriceScale equals the pre-repeg value, newPriceScale the committed one", async function () {
    const preset = buildPreset("WETH", {
      baseFee: 100,
      feeRampBps: 1000,
      feeFloorBps: 60,
      repegShareBps: 5_000,
    });
    const fx = await deploySecurityFixture(preset);

    const baseAddr = await fx.base.getAddress();
    const quoteAddr = await fx.quote.getAddress();
    const reserves = await fx.pool.getReserves();
    const baseIsToken0 = (await fx.pool.getPoolMetadata()).token0.toLowerCase() === baseAddr.toLowerCase();
    const baseReserveRaw = baseIsToken0 ? BigInt(reserves[0]) : BigInt(reserves[1]);
    const probeBaseIn = (baseReserveRaw * 10n) / 100n;

    // Same drive pattern as SolveLPostRepeg.driveRepeg: one-sided
    // volume with 5-minute spacing until the repeg gate commits.
    for (let i = 0; i < 24; i += 1) {
      const ts = (await currentBlockTime()) + 300;
      await time.setNextBlockTimestamp(ts);

      const psBefore = BigInt((await fx.pool.getOracleState()).priceScaleWad);
      await exactInputSingle(fx, fx.attacker, {
        tokenIn: baseAddr,
        tokenOut: quoteAddr,
        amountIn: probeBaseIn,
      });
      const psAfter = BigInt((await fx.pool.getOracleState()).priceScaleWad);
      if (psAfter === psBefore) continue;

      // The swap that moved the stored price scale must have emitted
      // exactly one PriceScaleUpdated carrying the true (old, new) pair.
      const block = await time.latestBlock();
      const events = await fx.pool.queryFilter(fx.pool.filters.PriceScaleUpdated(), block, block);
      expect(events.length, "PriceScaleUpdated events in the repeg block").to.equal(1);
      const { oldPriceScale, newPriceScale } = events[0].args;
      expect(BigInt(oldPriceScale), "oldPriceScale").to.equal(psBefore);
      expect(BigInt(newPriceScale), "newPriceScale").to.equal(psAfter);
      expect(BigInt(newPriceScale), "old vs new").to.not.equal(BigInt(oldPriceScale));
      return;
    }
    throw new Error("no repeg committed after 24 probes (preset misconfigured?)");
  });
});
