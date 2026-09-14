/** Expensive invariant suites remain tracked and runnable with "all" / their section. */
export const STRESS_TEST_FILES = [
  "test/math/HighPrecisionHarness.test.ts",
  "test/security/AggressiveRoundTrip.test.ts",
  "test/security/CpZoneSecurity.test.ts",
  "test/security/PathAdditivity.test.ts",
  "test/security/PathAdditivityExactOut.test.ts",
  "test/security/RoundTripNoArbitrage.test.ts",
  "test/security/RoundTripParameterCorners.test.ts",
  "test/security/SmallLambdaCorners.test.ts",
] as const;

// Individual stress cases in otherwise lightweight files carry this tag.
export const CI_TEST_GREP = "^(?!.*\\[stress\\])";

export function selectTestFiles(files: string[], ci: boolean): string[] {
  if (!ci) return files;
  const stress = new Set<string>(STRESS_TEST_FILES);
  return files.filter((file) => !stress.has(file.replace(/\\/g, "/")));
}
