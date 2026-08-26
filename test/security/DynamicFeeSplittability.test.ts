// SPDX-License-Identifier: MIT
//
// L-3 behaviour lock: the smoothstep dynamic fee is *splittable*.
//
// The per-swap fee is keyed to the POST-swap state distance of that one
// swap (`predictPostDistanceCp` → `smoothstepFeeWad`), charged on that
// leg's own input. For a directional sequence the post-distance grows
// 0 → D_final, so a single swap pays the rectangle `f(D_final)·total`
// while N legs pay the area-under-curve `Σ f(D_k)·chunk ≈ ∫ f(D) dx`.
// Because `f` is strictly increasing on the ramp, the split total is
// strictly smaller.
//
// This is an ACCEPTED, inherent property of *any* instantaneous-state-
// distance fee. It is NOT
// an LP drain: the integral the splitter pays is the marginal-cost-fair
// charge, and a single swap merely *over*-charges the early units; the
// only consistent non-splittable fee is the integral itself, which would
// LOWER fees for everyone. See the math audit, finding L-3.
//
// The `SwapBatchVsSingle` suite runs under a flat 1 bps fee (it tests
// curve concavity of OUTPUT), so it deliberately does NOT exercise this.
// This file pins the fee-splittability with the ramp ENABLED so a future
// change to the fee model is not silently mistaken for a "fix".

import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import {
  buildPreset,
  currentBlockTime,
  deploySecurityFixture,
  type PresetName,
  type SecurityFixture,
} from "../helpers/securityFixtures";

const PRESETS_UNDER_TEST: PresetName[] = ["WETH", "WBTC"];

// Live ramp: floor 60 bps → ceiling 220 bps over a 0.1-WAD warm-up.
const RAMP_OVERRIDES = { baseFee: 220, feeRampBps: 1_000, feeFloorBps: 60 };

// Execute one exact-in swap through the router and read the realised
// total fee straight off the pool's `Swap` event (feeAmount), plus the
// realised output from the recipient balance delta.
async function swapAndGetFee(
  fx: SecurityFixture,
  args: { tokenIn: string; tokenOut: string; amountIn: bigint }
): Promise<{ out: bigint; fee: bigint }> {
  const signer = fx.trader;
  const recipient = await signer.getAddress();
  const outCt = args.tokenOut.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.quote : fx.base;
  const balBefore = BigInt(await outCt.balanceOf(recipient));

  const tx = await fx.router.connect(signer).exactInputSingle({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    poolIndex: 0,
    recipient,
    amountIn: args.amountIn,
    amountOutMinimum: 0n,
    deadline: (await currentBlockTime()) + 3600,
  });
  const receipt = await tx.wait();
  const balAfter = BigInt(await outCt.balanceOf(recipient));

  let fee = 0n;
  for (const log of receipt!.logs) {
    if (log.address.toLowerCase() !== fx.poolAddr.toLowerCase()) continue;
    let parsed;
    try {
      parsed = fx.pool.interface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed && parsed.name === "Swap") {
      fee = BigInt(parsed.args.feeAmount);
      break;
    }
  }
  return { out: balAfter - balBefore, fee };
}

describe("DynamicFee splittability [ramp enabled — L-3 accepted-behaviour lock]", function () {
  this.timeout(180_000);

  for (const presetName of PRESETS_UNDER_TEST) {
    const preset = buildPreset(presetName, RAMP_OVERRIDES);
    const fixtureFor = async () => deploySecurityFixture(preset);

    it(`${presetName}: splitting a large quote→base push pays strictly less total fee`, async function () {
      const fx = await loadFixture(fixtureFor);
      const tokenIn = fx.quoteAddr;
      const tokenOut = fx.baseAddr;
      // ~30% of the quote reserve — a sizable off-anchor push that drives
      // the post-swap distance well up the smoothstep ramp.
      const totalIn = (fx.initialQuoteRaw * 30n) / 100n;
      const SPLITS = 16;

      // Single big swap from the balanced state (snapshot/revert so the
      // split below starts from the IDENTICAL pre-swap state).
      const snap = await hre.network.provider.send("evm_snapshot", []);
      const single = await swapAndGetFee(fx, { tokenIn, tokenOut, amountIn: totalIn });
      await hre.network.provider.send("evm_revert", [snap]);

      // N consecutive legs from the same starting state.
      let splitFee = 0n;
      const chunk = totalIn / BigInt(SPLITS);
      for (let i = 0; i < SPLITS; i++) {
        const amt = i === SPLITS - 1 ? totalIn - chunk * BigInt(SPLITS - 1) : chunk;
        const r = await swapAndGetFee(fx, { tokenIn, tokenOut, amountIn: amt });
        splitFee += r.fee;
      }

      const savedBps = ((single.fee - splitFee) * 10_000n) / single.fee;
      // Core L-3 property: the split pays strictly less total fee.
      expect(splitFee, `${presetName}: split fee ${splitFee} not < single fee ${single.fee}`).to.be.lt(single.fee);
      // ...and the gap is material (not floor dust): at 16 legs the split
      // dodges a meaningful slice of the dynamic-fee premium. If this
      // ever fails it means the fee stopped being a function of the
      // instantaneous post-state — i.e. the model changed.
      expect(savedBps, `${presetName}: split saved only ${savedBps}/10000 of the fee (expected ≥ 5%)`).to.be.gte(500n);
    });

    it(`${presetName}: splitting a large base→quote push pays strictly less total fee`, async function () {
      const fx = await loadFixture(fixtureFor);
      const tokenIn = fx.baseAddr;
      const tokenOut = fx.quoteAddr;
      const totalIn = (fx.initialBaseRaw * 30n) / 100n;
      const SPLITS = 16;

      const snap = await hre.network.provider.send("evm_snapshot", []);
      const single = await swapAndGetFee(fx, { tokenIn, tokenOut, amountIn: totalIn });
      await hre.network.provider.send("evm_revert", [snap]);

      let splitFee = 0n;
      const chunk = totalIn / BigInt(SPLITS);
      for (let i = 0; i < SPLITS; i++) {
        const amt = i === SPLITS - 1 ? totalIn - chunk * BigInt(SPLITS - 1) : chunk;
        const r = await swapAndGetFee(fx, { tokenIn, tokenOut, amountIn: amt });
        splitFee += r.fee;
      }

      const savedBps = ((single.fee - splitFee) * 10_000n) / single.fee;
      expect(splitFee, `${presetName}: split fee ${splitFee} not < single fee ${single.fee}`).to.be.lt(single.fee);
      expect(savedBps, `${presetName}: split saved only ${savedBps}/10000 of the fee (expected ≥ 5%)`).to.be.gte(500n);
    });
  }
});
