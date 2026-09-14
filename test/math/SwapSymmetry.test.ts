import {
  assertQuotePrecision,
  assertExactOutputPrecision,
  exactInputReference,
  exactOutputReferenceWithL,
} from "../helpers/continuousReference";
import hre from "hardhat";
import { expect } from "chai";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

// Same-state quotes each include their own 0.000001% margin. Compare each
// direction with the independent curve; do not claim exact inverse identity.
describe("kernel exact-in/exact-out symmetry", function () {
  it("both orientations remain within the independent root and common-margin budget", async function () {
    const Harness = await hre.ethers.getContractFactory("StatefulKernelHarness");

    const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
    const WAD = 10n ** 18n;
    // Production curve trio (WETH preset) — sourced from the
    // bootstrap presets in `simulator/test_helpers/config.ts` (which
    // currently mirrors the canonical Rust defaults until Phase 2 of
    // the migration restores `loadRustBenchmarkDefaults`).
    const PRESET = EQUILIBRA_PRESETS.WETH;
    const cases: Array<[bigint, bigint, string]> = [
      [4_885_006_930_000_000_000n, 4_885_006_930_000_000_000n, "balanced"],
      [4_885_006_930_000_000_000n * 2n, 4_885_006_930_000_000_000n / 2n, "imbalanced 4:1"],
      [4_885_006_930_000_000_000n * 5n, 4_885_006_930_000_000_000n, "imbalanced 5:1"],
    ];
    const dxFractions = [
      WAD / 100n, // 1%
      WAD / 10n, // 10%
      WAD / 4n, // 25%
      WAD / 2n, // 50%
    ];

    for (const [x, y, label] of cases) {
      const harness: any = await Harness.deploy(x, y, PRESET.aWad, PRESET.lambdaWad, 18, 18);
      await harness.waitForDeployment();
      console.log(`\n--- ${label}, x=${x}, y=${y} ---`);

      const price = BigInt(await harness.priceScaleWad());
      const normalized0 = (x * WAD) / price;
      for (const zeroForOne of [true, false]) {
        const inputReserve = zeroForOne ? x : y;
        const inputMath = zeroForOne ? normalized0 : y;
        const outputMath = zeroForOne ? y : normalized0;
        for (const frac of dxFractions) {
          const dx = (inputReserve * frac) / WAD;
          const dxMath = zeroForOne ? (dx * WAD) / price : dx;
          const dyOut = BigInt(await harness.quoteExactIn(zeroForOne, dx));
          expect(dyOut).to.be.gt(0n);
          const ref = await exactInputReference(math, inputMath, outputMath, dxMath, PRESET.aWad, PRESET.lambdaWad);
          const lowerOutput = (v: bigint) => (zeroForOne ? v : (v * price) / WAD);
          expect(dyOut).to.equal(lowerOutput(ref.quotedMath));
          assertQuotePrecision(ref.quotedMath, ref.referenceMath, ref.iterations, 100n, label);
          const desiredMath = zeroForOne ? dyOut : (dyOut * WAD + price - 1n) / price;
          const [rawIn, iters] = await math.quoteExactOutForward(
            inputMath,
            outputMath,
            desiredMath,
            PRESET.aWad,
            PRESET.lambdaWad
          );
          const expected = exactOutputReferenceWithL(
            inputMath,
            outputMath,
            desiredMath,
            PRESET.aWad,
            PRESET.lambdaWad,
            ref.lBefore
          );
          assertExactOutputPrecision(BigInt(rawIn), expected, BigInt(iters), 100n, label);
          const dxBack = await harness.quoteExactOut(zeroForOne, dyOut);
          expect(dxBack).to.equal(zeroForOne ? (BigInt(rawIn) * price + WAD - 1n) / WAD : rawIn);
        }
      }
    }
  });
});
