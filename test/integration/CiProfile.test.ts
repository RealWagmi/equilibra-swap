import { expect } from "chai";
import { existsSync } from "node:fs";
import path from "node:path";
import { CI_TEST_GREP, selectTestFiles, STRESS_TEST_FILES } from "../../scripts/test-profile";

describe("CI test profile", function () {
  it("excludes heavy suites only in CI and keeps concrete numerical regressions", function () {
    for (const file of STRESS_TEST_FILES)
      expect(existsSync(path.resolve(__dirname, "../..", file)), file).to.equal(true);
    const regressions = [
      "test/math/SolverConvergence.test.ts",
      "test/math/MathRange.test.ts",
      "test/security/SmallLambdaMonotonicity.test.ts",
      "test/security/PermanentStop.test.ts",
    ];
    const files = [...STRESS_TEST_FILES, ...regressions];
    expect(selectTestFiles(files, false)).to.deep.equal(files);
    expect(selectTestFiles(files, true)).to.deep.equal(regressions);
  });

  it("excludes tagged stress cases without excluding the surrounding suite", function () {
    const filter = new RegExp(CI_TEST_GREP);
    expect(filter.test("RepegConservation [stress] INV-I: 1000 swaps")).to.equal(false);
    expect(filter.test("SwapBatchVsSingle [stress] cross-anchor matrix")).to.equal(false);
    expect(filter.test("SwapBatchVsSingle pins WBTC 95% precision")).to.equal(true);
    expect(filter.test("RepegConservation one-step budget invariant")).to.equal(true);
  });
});
