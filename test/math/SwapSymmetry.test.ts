import hre from "hardhat";
import { expect } from "chai";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

// Standing regression for the two-knob cubic kernel: a swap
// quoted in the exact-in direction must round-trip back through
// `quoteExactOut` on the same `K = const` level set, modulo the
// secant solver's residual (≲ 1 ppb of the input plus ≲ 100 wei of
// WAD-rounding noise). A regression here would imply that
// `solveLFromState` is not returning the same `L` to both directions,
// or that `computeK` lost the round-trip property — either case would
// corrupt path-additivity.
//
// The harness constructor takes the two-knob `(aWad, lambdaWad)`
// pair directly (legacy single-knob `alpha` is gone); the rest of the
// scenario — balanced, mildly imbalanced, deeply imbalanced reserves
// × four input fractions — is preserved verbatim from the V1.0 suite.
describe("kernel exact-in/exact-out symmetry", function () {
  it("exact-in → exact-out round-trip residual ≤ a few wei", async function () {
    const Harness = await hre.ethers.getContractFactory("StatefulKernelHarness");

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

      // Probe with `zeroForOne = false` ⇒ input side is `y` (token1).
      // Bound `dx` to a safe fraction of `y` so we stay inside the
      // feasibility envelope of the central plateau for any `(a, λ)`
      // combination inside the production range.
      for (const frac of dxFractions) {
        const dx = (y * frac) / WAD;
        const dyOut = await harness.quoteExactIn(false, dx);
        if (dyOut === 0n) {
          console.log(`  dx=${dx}: dy=0 (skip)`);
          continue;
        }
        const dxBack = await harness.quoteExactOut(false, dyOut);
        const drift = dx > dxBack ? dx - dxBack : dxBack - dx;
        const driftPpm = (drift * 1_000_000n) / dx;
        console.log(
          `  frac=${(frac * 100n) / WAD}%, dx=${dx}, dy=${dyOut}, dxBack=${dxBack}, drift=${drift} (${driftPpm} ppm)`
        );
        expect(drift).to.be.lt(dx / 1_000_000_000n + 100n); // ≤ 1 ppb + 100 wei
      }
    }
  });
});
