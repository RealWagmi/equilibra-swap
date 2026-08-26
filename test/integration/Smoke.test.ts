// SPDX-License-Identifier: MIT
//
// End-to-end smoke test. Spins up the factory → router → pool
// stack through `securityFixtures.deploySecurityFixture` and exercises
// the swap / quote / liquidity paths to confirm the new (a, λ) cubic
// kernel boots and settles trades correctly with the symmetric coord
// change.
//
// Numerical expectations are deliberately soft (e.g. "amountOut > 0",
// "monotone in amountIn") — exact-value parity is the job of the
// dedicated math unit tests, not this smoke pass.

import { expect } from "chai";
import { MaxUint256 } from "ethers";

import { buildPreset, deploySecurityFixture, exactInputSingle, snapshotPool } from "../helpers/securityFixtures";

const WAD = 10n ** 18n;

describe("End-to-end smoke (factory + router + pool)", () => {
  it("WETH preset: pool deploys, quotes positive, swap settles, vp accrues", async () => {
    const preset = buildPreset("WETH", {
      baseFee: 100,
      feeRampBps: 1000,
      feeFloorBps: 20,
    });
    const fx = await deploySecurityFixture(preset);

    const initial = await snapshotPool(fx);
    expect(initial.reserve0, "r0 seeded").to.be.gt(0n);
    expect(initial.reserve1, "r1 seeded").to.be.gt(0n);
    expect(initial.priceScaleWad, "priceScale seeded").to.be.gt(0n);
    expect(initial.unitValueWad, "vp seeded at genesis").to.be.gt(0n);
    expect(initial.growthWad, "growth starts at 0").to.equal(0n);

    // Quote a modest swap, confirm > 0 and matches the live swap.
    const baseIn = fx.initialBaseRaw / 100n; // 1% of base
    const quoteOutQuote = BigInt(await fx.pool.quoteExactIn(!fx.quoteIsToken0, baseIn));
    expect(quoteOutQuote, "quoteExactIn > 0").to.be.gt(0n);

    const trade = await exactInputSingle(fx, fx.trader, {
      tokenIn: fx.baseAddr,
      tokenOut: fx.quoteAddr,
      amountIn: baseIn,
    });
    expect(trade.amountOut, "live swap > 0").to.be.gt(0n);
    expect(trade.amountOut, "live swap == quote (bit-exact)").to.equal(quoteOutQuote);

    const after = await snapshotPool(fx);
    // LP-fee fold-in lifts the high-water mark on a fee-bearing swap.
    expect(after.unitValueWad, "vp ↑ after swap").to.be.gte(initial.unitValueWad);
    expect(after.growthWad, "growth ↑ after swap").to.be.gte(initial.growthWad);
  });

  it("WBTC preset: monotone slippage on growing exact-in", async () => {
    const preset = buildPreset("WBTC", { baseFee: 30, feeRampBps: 0 });
    const fx = await deploySecurityFixture(preset);

    // Quote a sequence of growing amounts and confirm slippage rises.
    const sizes = [
      fx.initialBaseRaw / 1000n,
      fx.initialBaseRaw / 100n,
      fx.initialBaseRaw / 50n,
      fx.initialBaseRaw / 20n,
    ];
    let prevPricePerUnit = -1n;
    for (const sz of sizes) {
      const out = BigInt(await fx.pool.quoteExactIn(!fx.quoteIsToken0, sz));
      // Effective quote/base price = quoteOut · 1e18 / baseIn (raw units).
      const pricePerUnit = (out * WAD) / sz;
      if (prevPricePerUnit >= 0n) {
        // Slippage grows with size ⇒ effective price falls.
        expect(pricePerUnit, `slippage grows @ ${sz}`).to.be.lte(prevPricePerUnit);
      }
      prevPricePerUnit = pricePerUnit;
    }
  });

  it("Reverts on out-of-band (a, λ) at factory deploy time", async () => {
    // Force aWad below A_MIN by tweaking the preset post-build.
    const preset = buildPreset("WETH");
    const fx = await deploySecurityFixture(preset);

    const Factory = fx.factory;
    // Build a malformed config: aWad below A_MIN_WAD = 1e17.
    const badConfig = {
      aWad: 1n, // way below A_MIN_WAD
      lambdaWad: preset.lambdaWad,
      baseFee: 100,
      emaPeriod: 3600,
      repegStepWad: 10n ** 15n,
      repegThresholdToken1UpWad: 10n ** 15n,
      repegThresholdToken1DownWad: 10n ** 15n,
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps: 5000,
    };
    const Token0 = fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr;
    const Token1 = fx.quoteIsToken0 ? fx.baseAddr : fx.quoteAddr;
    await fx.quote.connect(fx.owner).approve(await Factory.getAddress(), MaxUint256);
    await fx.base.connect(fx.owner).approve(await Factory.getAddress(), MaxUint256);
    await expect(
      Factory.connect(fx.owner).createPoolAndAddLiquidity(
        Token0,
        Token1,
        badConfig,
        fx.initialQuoteRaw,
        fx.initialBaseRaw,
        await fx.owner.getAddress()
      )
    ).to.be.revertedWithCustomError(Factory, "InvalidA");
  });

  it("Reverts on out-of-band lambda at factory deploy time", async () => {
    const preset = buildPreset("WETH");
    const fx = await deploySecurityFixture(preset);
    const Factory = fx.factory;
    const badConfig = {
      aWad: preset.aWad,
      lambdaWad: 0n, // below LAMBDA_MIN_WAD = 1e15
      baseFee: 100,
      emaPeriod: 3600,
      repegStepWad: 10n ** 15n,
      repegThresholdToken1UpWad: 10n ** 15n,
      repegThresholdToken1DownWad: 10n ** 15n,
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps: 5000,
    };
    const Token0 = fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr;
    const Token1 = fx.quoteIsToken0 ? fx.baseAddr : fx.quoteAddr;
    await fx.quote.connect(fx.owner).approve(await Factory.getAddress(), MaxUint256);
    await fx.base.connect(fx.owner).approve(await Factory.getAddress(), MaxUint256);
    await expect(
      Factory.connect(fx.owner).createPoolAndAddLiquidity(
        Token0,
        Token1,
        badConfig,
        fx.initialQuoteRaw,
        fx.initialBaseRaw,
        await fx.owner.getAddress()
      )
    ).to.be.revertedWithCustomError(Factory, "InvalidLambda");
  });
});
