import { expect } from "chai";

const WAD = 10n ** 18n;

// Exact rational rewrite of the same continuous invariant. The depth L is
// recovered by the production helper, then frozen for this independent
// bisection. No secant code or floating-point arithmetic is reused.
function invariant(x: bigint, y: bigint, l: bigint, a: bigint, lambda: bigint): [bigint, bigint] {
  const n = x * y;
  const q = (x - y) ** 2n;
  const d = WAD * n + lambda * q;
  const precision = 1n << 128n;
  const h = 2n * ((WAD - a) * n + lambda * q) * precision + a * l * (x + y) * WAD;
  return [n * h, 2n * WAD * d * precision];
}

export function exactInputReferenceWithL(x: bigint, y: bigint, dx: bigint, a: bigint, lambda: bigint, lBefore: bigint) {
  const [targetN, targetD] = invariant(x, y, lBefore, a, lambda);
  let low = 0n;
  let high = y;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    const [n, d] = invariant(x + dx, mid, lBefore, a, lambda);
    if (n * targetD >= targetN * d) high = mid;
    else low = mid;
  }
  return y - high;
}

export async function exactInputReference(math: any, x: bigint, y: bigint, dx: bigint, a: bigint, lambda: bigint) {
  const lBefore = BigInt(await math.solveLFromState(x, y, a, lambda));
  const referenceMath = exactInputReferenceWithL(x, y, dx, a, lambda, lBefore);
  const [quotedMath, iterations] = await math.quoteExactInForward(x, y, dx, a, lambda);
  return { lBefore, referenceMath, quotedMath: BigInt(quotedMath), iterations: BigInt(iterations) };
}

export function assertQuotePrecision(
  quoted: bigint,
  reference: bigint,
  iterations: bigint,
  dustBudget: bigint,
  label: string
) {
  const error = quoted - reference;
  // Positive error must remain integer-scale even on the cap-certified branch.
  expect(error, `${label}: output above the independent curve`).to.be.at.most(dustBudget);
  const absolute = error < 0n ? -error : error;
  expect(iterations, label + ": iteration cap").to.be.at.most(40n);
  // Independent-reference budget: one common margin plus the solver's
  // cap tolerance. Integer exits need only the explicit dust allowance.
  const marginBudget = (reference + 99999999n) / 100000000n + 1n;
  const solverBudget = iterations === 40n ? (reference + 999999n) / 1000000n + 1n : 0n;
  expect(absolute, label + ": quote exceeded margin plus solver budget").to.be.at.most(
    marginBudget + solverBudget + dustBudget
  );
}

/** Independent rational level-set inversion; no secant or production seed. */
export function exactOutputReferenceWithL(x: bigint, y: bigint, dy: bigint, a: bigint, lambda: bigint, l: bigint) {
  return exactOutputInvariantReferenceWithL(x, y, outputBeforeMargin(dy), a, lambda, l);
}

/** Continuous invariant alone, before the output margin; useful as a split-input lower bound. */
export function exactOutputInvariantReferenceWithL(
  x: bigint,
  y: bigint,
  dy: bigint,
  a: bigint,
  lambda: bigint,
  l: bigint
) {
  const [targetN, targetD] = invariant(x, y, l, a, lambda);
  const above = (b: bigint) => {
    const [n, d] = invariant(b, y - dy, l, a, lambda);
    return n * targetD >= targetN * d;
  };
  let low = x,
    high = 2n * x;
  for (let i = 0; !above(high); ++i) {
    if (i >= 256) throw new Error("reference bracket not found");
    high *= 2n;
  }
  while (high - low > 1n) {
    const mid = (high + low) / 2n;
    if (above(mid)) high = mid;
    else low = mid;
  }
  return high - x;
}

export function assertExactOutputPrecision(
  quoted: bigint,
  reference: bigint,
  iterations: bigint,
  dust: bigint,
  label: string
) {
  expect(iterations, label).to.be.greaterThan(0n).and.at.most(40n);
  const solverBudget = iterations === 40n ? (reference + 999999n) / 1000000n + 2n : 0n;
  // This reference already includes the enlarged trial output. A local
  // certificate permits either side of that root; native settlement still
  // has to pass the strict LP guard for the original requested output.
  const error = quoted >= reference ? quoted - reference : reference - quoted;
  expect(error, label + ": expanded-output root plus solver budget").to.be.at.most(dust + 2n + solverBudget);
}

/** Upper integer preimage of u - max(1, floor(u / 100000000)). */
export const outputBeforeMargin = (requested: bigint) => requested + (requested / 99999999n || 1n);
export const outputAfterMargin = (raw: bigint) => (raw === 0n ? 0n : raw - (raw / 100000000n || 1n));
