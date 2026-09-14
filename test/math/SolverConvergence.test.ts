import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  exactInputReference,
  assertQuotePrecision,
  outputBeforeMargin,
  outputAfterMargin,
  exactInputReferenceWithL,
  exactOutputReferenceWithL,
  assertExactOutputPrecision,
} from "../helpers/continuousReference";

const adjusted = (q: bigint, exactOut = false) => (exactOut ? q : outputAfterMargin(q));

const WAD = 10n ** 18n;
const A = 990000000000000000n;
const LAMBDA = 1000000000000000n;

async function fixture() {
  const h = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
  await h.waitForDeployment();
  return h;
}

// Independent exact-rational continuous invariant at the production-frozen L.
// No floating point and no copy of the iterative counterpart solver.
function invariant(x: bigint, y: bigint, l: bigint): [bigint, bigint] {
  const n = x * y;
  const distanceNumerator = (x - y) ** 2n;
  const denominator = WAD * n + LAMBDA * distanceNumerator;
  const q128 = 1n << 128n;
  const head = 2n * ((WAD - A) * n + LAMBDA * distanceNumerator) * q128 + A * l * (x + y) * WAD;
  return [n * head, 2n * WAD * denominator * q128];
}

function referenceCounterpart(x: bigint, y: bigint, fixed: bigint, l: bigint): bigint {
  const [targetN, targetD] = invariant(x, y, l);
  const atOrAbove = (b: bigint) => {
    const [n, d] = invariant(fixed, b, l);
    return n * targetD >= targetN * d;
  };
  let low = 1n;
  let high = x + y;
  while (!atOrAbove(high)) high *= 2n;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (atOrAbove(mid)) high = mid;
    else low = mid;
  }
  return high;
}

describe("Q128 counterpart solver: uniform integer exits and cap certification within forty steps", function () {
  it("inverts the integer output margin at dust, quotient boundaries and large amounts", function () {
    for (let want = 1n; want <= 200001n; ++want) {
      expect(outputAfterMargin(outputBeforeMargin(want))).to.equal(want);
    }
    // Exhausting the small range alone would miss scale-dependent arithmetic mistakes.
    for (const quotient of [1n, 2n, 3n, 99999999n, 100000000n, 10n ** 18n, 1n << 128n]) {
      for (const offset of [-1n, 0n, 1n, 99999998n]) {
        const want = quotient * 99999999n + offset;
        expect(outputAfterMargin(outputBeforeMargin(want))).to.equal(want);
      }
    }
  });

  it("keeps ordinary math inversion within one unit without spending the common margin twice", async function () {
    const h = await loadFixture(fixture);
    const curves = [
      [WAD / 10n, WAD],
      [A, LAMBDA],
      [909610000000000030n, 16780000000000000n],
      [WAD - 1n, 10n ** 12n],
    ];
    for (const [a, lambda] of curves) {
      for (const [x, y] of [
        [500000n * WAD, 500000n * WAD],
        [3072n * WAD, 1024n * WAD],
        [1024n * WAD, 3072n * WAD],
      ]) {
        for (const bps of [1n, 100n, 1000n, 5000n, 9000n]) {
          const want = (y * bps) / 10000n;
          const [input, outIters] = await h.quoteExactOutForward(x, y, want, a, lambda);
          const [got, inIters] = await h.quoteExactInForward(x, y, input, a, lambda);
          const label = `a=${a}, lambda=${lambda}, x=${x}, y=${y}, want=${want}`;
          // A measured property of this grid, not a guarantee for every early exit.
          expect(outIters, label).to.be.at.most(12n);
          expect(inIters, label).to.be.at.most(12n);
          expect(got, label).to.be.at.least(want - 1n);
        }
      }
    }
  });

  it("charges exactly one margin relative to the independent curve in both quote modes", async function () {
    const h = await loadFixture(fixture);
    const x = 500000n * WAD,
      y = x;
    const depth = BigInt(await h.solveLFromState(x, y, A, LAMBDA));
    for (const amount of [WAD / 20n, 1000n * WAD, 50000n * WAD]) {
      const [out, inIters] = await h.quoteExactInForward(x, y, amount, A, LAMBDA);
      const rawReference = exactInputReferenceWithL(x, y, amount, A, LAMBDA, depth);
      const expected = outputAfterMargin(rawReference);
      const gap = out >= expected ? out - expected : expected - out;
      expect(inIters).to.be.at.most(12n);
      expect(gap, "exact-in applies the output margin once").to.be.at.most(32n);
      const [input, outIters] = await h.quoteExactOutForward(x, y, amount, A, LAMBDA);
      const inputReference = exactOutputReferenceWithL(x, y, amount, A, LAMBDA, depth);
      expect(outIters).to.be.at.most(12n);
      assertExactOutputPrecision(input, inputReference, outIters, 32n, "exact-out inverts the margin once");
    }
  });

  it("checks both numerical errors separately when a same-state inversion reaches the late phase", async function () {
    const h = await loadFixture(fixture);
    const x = 341100n * WAD,
      y = 1024324324324324324324n,
      a = WAD - 1n,
      lambda = 10n ** 12n;
    const depth = BigInt(await h.solveLFromState(x, y, a, lambda));
    // An existing exact-out tail witness, independent of the repaired linear seed.
    const want = 1023914594594594594594n;
    const [input, outIters] = await h.quoteExactOutForward(x, y, want, a, lambda);
    const [got, inIters] = await h.quoteExactInForward(x, y, input, a, lambda);
    expect(outIters > 12n || inIters > 12n, "late comparison must actually be exercised").to.equal(true);
    const inputReference = exactOutputReferenceWithL(x, y, want, a, lambda, depth);
    assertExactOutputPrecision(input, inputReference, outIters, 32n, "late inverse leg");
    const rawOutputReference = exactInputReferenceWithL(x, y, input, a, lambda, depth);
    const outputReference = outputAfterMargin(rawOutputReference);
    const forwardBudget = (inIters === 40n ? (rawOutputReference + 999999n) / 1000000n : 0n) + 32n;
    const forwardError = got >= outputReference ? got - outputReference : outputReference - got;
    expect(forwardError, "late forward leg: solver error only, margin already applied").to.be.at.most(forwardBudget);
    // Evaluate the effect of exact-out input rounding in OUTPUT units, instead
    // of adding unlike units or allowing another blanket percentage margin.
    const inverseEffect = want > outputReference ? want - outputReference : 0n;
    expect(got, "combined inversion bound").to.be.at.least(want - inverseEffect - forwardBudget);
  });

  const fixedPoints = JSON.parse(
    readFileSync(path.join(__dirname, "../../simulator/tests/fixtures/equilibra-fixed-point-quotes.json"), "utf8")
  );
  for (const sample of fixedPoints) {
    it(`applies the common margin once to the integer exit at iteration ${sample.iterations}, case ${sample.id}`, async () => {
      const h = await loadFixture(fixture);
      const [x, y, amount, a, lambda, expected] = [
        sample.x,
        sample.y,
        sample.amount,
        sample.a,
        sample.lambda,
        sample.expected,
      ].map(BigInt);
      const result = await h[sample.exactOut ? "quoteExactOutForward" : "quoteExactInForward"](x, y, amount, a, lambda);
      expect(Array.from(result)).to.deep.equal([expected, BigInt(sample.iterations)]);
      const depth = await h.solveLFromState(x, y, a, lambda);
      const target = await h.computeQuoteK(x, y, depth, a, lambda);
      const fixedAxis = sample.exactOut ? y - outputBeforeMargin(amount) : x + amount;
      const raw = BigInt(sample.unadjusted);
      expect(expected).to.equal(adjusted(raw, sample.exactOut));
      const b = sample.exactOut ? x + raw : y - raw;
      const k = await h.computeQuoteK(fixedAxis, b, depth, a, lambda);
      if (sample.exit === "equalK") {
        expect(k).to.equal(target);
        return;
      }
      expect(sample.exit).to.equal("unchanged");
      const previous = BigInt(sample.previousCounterpart);
      const kPrevious = await h.computeQuoteK(fixedAxis, previous, depth, a, lambda);
      expect(b).not.to.equal(previous);
      expect(k).not.to.equal(target);
      const abs = (v: bigint) => (v < 0n ? -v : v);
      if (sample.zeroDk) expect(k).to.equal(kPrevious);
      else {
        expect(k).not.to.equal(kPrevious);
        expect((abs(k - target) * abs(b - previous)) / abs(k - kPrevious)).to.equal(0n);
      }
    });
  }

  it("rescues the near-cancelled linear seed without an additional quote margin", async function () {
    const h = await loadFixture(fixture);
    const args = [3072n * WAD, 1024n * WAD, 1024013056132748240752n, WAD - 1n, 10n ** 12n] as const;
    const result = await exactInputReference(h, ...args);
    expect(result.iterations).to.be.at.most(12n);
    const expected = outputAfterMargin(result.referenceMath);
    const error = result.quotedMath >= expected ? result.quotedMath - expected : expected - result.quotedMath;
    expect(error, "one margin around the independent curve").to.be.at.most(2n);
    // The unbounded linear initializer took 19 iterations and 98324 harness gas.
    expect(await h.quoteExactInForward.estimateGas(...args)).to.be.lt(80000n);
  });

  it("does not raise an already accurate tail seed to the linear floor", async function () {
    const h = await loadFixture(fixture);
    const args = [5000n * WAD, (5000n * WAD) / 3n, 4950n * WAD, A, 10n ** 12n] as const;
    expect(Array.from(await h.quoteExactInForward(...args))).to.deep.equal([
      adjusted(1666645991994673868810n, false),
      4n,
    ]);
    // Applying the CP / 1000 floor to the tail would require 13 iterations.
    expect(await h.quoteExactInForward.estimateGas(...args)).to.be.lt(55000n);
  });

  it("resolves the former stagnant refusal with the curve-aware seed", async () => {
    const h = await loadFixture(fixture);
    expect(
      Array.from(
        await h.quoteExactInForward(165617785305n, 378632966091n, 379427672605n, WAD - 1n, 10n ** 12n, {
          gasLimit: 180000n,
        })
      )
    ).to.deep.equal([adjusted(378356812505n, false), 7n]);
  });

  it("resolves the former certified fixed point before the late phase", async () => {
    const h = await loadFixture(fixture);
    const args = [114192734020n, 218001003310n, 241286899325n, A, LAMBDA] as const;
    expect(Array.from(await h.quoteExactInForward(...args))).to.deep.equal([adjusted(213593248705n, false), 7n]);
    // The pre-fix call used 40 iterations and 175759 transaction gas.
    expect(await h.quoteExactInForward.estimateGas(...args)).to.be.lt(175000n);
  });

  it("pins Q128 ordinary exact-in and exact-out integer exits", async function () {
    const h = await loadFixture(fixture);
    expect(Array.from(await h.quoteExactInForward(500000n * WAD, 500000n * WAD, 5000n * WAD, A, LAMBDA))).to.deep.equal(
      [adjusted(4999010058210050000126n, false), 3n]
    );
    expect(
      Array.from(await h.quoteExactOutForward(500000n * WAD, 500000n * WAD, outputAfterMargin(5000n * WAD), A, LAMBDA))
    ).to.deep.equal([adjusted(5000990333954514774556n, true), 3n]);
  });

  it("continues past the former iteration-thirteen approximate exit", async function () {
    const h = await loadFixture(fixture);
    const [output, iterations] = await h.quoteExactInForward(
      1005062n * WAD,
      5000n * WAD,
      4999n * WAD,
      999750000000000000n,
      50000000000000n
    );
    expect(iterations).to.equal(14n);
    expect(output / 10n ** 16n).to.equal(132129n);
  });

  for (const exactOut of [false, true]) {
    it(`resolves the old twelve-iteration ${exactOut ? "exact-out depletion" : "exact-in imbalance"} corner`, async function () {
      const h = await loadFixture(fixture);
      const x = 500000n * WAD;
      const y = (exactOut ? 50000n : 25000n) * WAD;
      const amount = exactOut ? outputAfterMargin(49350n * WAD) : 55000n * WAD;
      const l = BigInt(await h.solveLFromState(x, y, A, LAMBDA));
      const [quoted, iterations] = exactOut
        ? await h.quoteExactOutForward(x, y, amount, A, LAMBDA)
        : await h.quoteExactInForward(x, y, amount, A, LAMBDA);
      const counterpart = referenceCounterpart(x, y, exactOut ? y - outputBeforeMargin(amount) : x + amount, l);
      const reference = exactOut ? counterpart - x : y - counterpart;
      const error = quoted >= reference ? quoted - reference : reference - quoted;
      expect(iterations).to.equal(exactOut ? 11n : 8n);
      // This is a bound for these explicit, well-scaled regressions, not a
      // universal continuous-root guarantee for the rounded-K certificate.
      expect(error).to.be.at.most((reference + 99999999n) / 100000000n + 2n);
      if (exactOut) expect(quoted).to.be.at.least(reference);
      else expect(quoted).to.be.at.most(reference);
    });
  }

  it("distinguishes zero and positive one-unit exact-out quotes with the output margin", async function () {
    const h = await loadFixture(fixture);
    expect(
      Array.from(await h.quoteExactOutForward(500000n * WAD, 10000000n * WAD, 1n, WAD / 10n, LAMBDA))
    ).to.deep.equal([0n, 2n]);
    expect(Array.from(await h.quoteExactOutForward(500000n * WAD, 10000000n * WAD, 1n, A, LAMBDA))).to.deep.equal([
      1n,
      2n,
    ]);
  });

  it("resolves the exact-in precision stress case that previously exhausted forty iterations", async function () {
    const h = await loadFixture(fixture);
    const x = 10n ** 30n;
    const y = x / 20n;
    const dx = 10n ** 12n;
    const lambda = 16780000000000000n;
    // With WAD-rounded coefficients this exhausted the limit. Q128 removes
    // that artificial discontinuity; this is no longer a cap-refusal witness.
    expect(Array.from(await h.quoteExactInForward(x, y, dx, A, lambda))).to.deep.equal([
      adjusted(129544481884n, false),
      4n,
    ]);
  });

  it("resolves the exact-out precision stress case that previously exhausted forty iterations", async function () {
    const h = await loadFixture(fixture);
    const x = 10n ** 30n;
    expect(
      Array.from(await h.quoteExactOutForward(x, x * 20n, outputAfterMargin(10n ** 12n), A, LAMBDA))
    ).to.deep.equal([adjusted(683995162301n, true), 4n]);
  });

  for (const [a, y, dx] of [
    [999750060000000000n, 192771644714765873682201n, 250000n * WAD],
    [999750060000000000n, 413223140495867768595041n, 495000n * WAD],
    [WAD - 1n, 192771644714765873682201n, 250000n * WAD],
    [WAD - 1n, 413223140495867768595041n, 495000n * WAD],
  ]) {
    it(`checks the former non-dust late frontier at alpha ${a}, reserve ${y}`, async function () {
      const h = await loadFixture(fixture);
      const result = await exactInputReference(h, 500000n * WAD, y, dx, a, LAMBDA);
      expect(result.iterations).to.be.at.most(12n);
      assertQuotePrecision(result.quotedMath, result.referenceMath, result.iterations, 1n, "late frontier");
    });
  }

  it("resolves the formerly cap-certified result to integer precision", async function () {
    const h = await loadFixture(fixture);
    const result = await exactInputReference(
      h,
      950238932273753758005801n,
      50000000000000000000000n,
      474881901654989376525315n,
      WAD - 1n,
      1000000000000n
    );
    expect(result.iterations).to.equal(4n);
    expect(result.quotedMath).to.equal(adjusted(49996645302928404499560n));
    assertQuotePrecision(result.quotedMath, result.referenceMath, result.iterations, 1n, "former cap");
    const depth = result.lBefore;
    const fixedAxis = 950238932273753758005801n + 474881901654989376525315n;
    const previous = 50000000000000000000000n;
    const target = await h.computeQuoteK(950238932273753758005801n, previous, depth, WAD - 1n, 1000000000000n);
    const context = { fixedAxis, target, a: WAD - 1n, lambda: 1000000000000n, depth, previous, exactOut: false };
    const b = 6464685150222072341n;
    const k = await h.computeQuoteK(fixedAxis, b, depth, context.a, context.lambda);
    expect(await h.certifyCounterpart(context, b, k, (previous - b) / 1000001n)).to.equal(0n);
    expect(await h.certifyCounterpart(context, b, k, (previous - b) / 100001n)).to.equal(0n);
    expect(await h.certifyCounterpart(context, b, k, (previous - b) / 10001n)).to.be.gt(0n);
  });

  // The shared successful-quote corpus pins both former cap refusals.

  it("resolves the former zero-output late exact-in sentinel", async function () {
    const h = await loadFixture(fixture);
    expect(
      Array.from(
        await h.quoteExactInForward(12500n * WAD, 28483987539843244337n, 2204n, 909610000000000000n, 16780000000000000n)
      )
    ).to.deep.equal([2n, 2n]);
  });

  it("does not amplify the reported one-wei input at maximum alpha and huge reserves", async function () {
    const h = await loadFixture(fixture);
    expect(Array.from(await h.quoteExactInForward(10n ** 30n, 2n * 10n ** 31n, 1n, WAD - 1n, LAMBDA))).to.deep.equal([
      1n,
      2n,
    ]);
  });
  it("pins all shared Solidity/Rust math vectors", async function () {
    const h = await loadFixture(fixture);
    const cases = JSON.parse(
      readFileSync(path.join(__dirname, "../../simulator/tests/fixtures/equilibra-solver-quotes.json"), "utf8")
    );
    for (const [exactOut, x, y, amount, a, lambda, expected, iters] of cases) {
      const result = await h[exactOut ? "quoteExactOutForward" : "quoteExactInForward"](x, y, amount, a, lambda);
      expect(Array.from(result)).to.deep.equal([BigInt(expected), BigInt(iters)]);
    }
  });

  it("certifies equal K and both residual sides; refuses an unbracketed candidate", async function () {
    const h = await loadFixture(fixture);
    const b = 1000n * WAD;
    const depth = await h.solveLFromState(b, b, A, LAMBDA);
    const k = await h.computeQuoteK(b, b, depth, A, LAMBDA);
    const context = { fixedAxis: b, target: k, a: A, lambda: LAMBDA, depth, previous: 2n * b, exactOut: false };
    const kAt = (value: bigint) => h.computeQuoteK(b, value, depth, A, LAMBDA);
    const low = b - 2n,
      high = b + 2n;
    expect(await kAt(low)).to.be.lessThan(k);
    expect(await kAt(high)).to.be.greaterThan(k);
    expect(await h.certifyCounterpart(context, b, k, 4n)).to.equal(b);
    expect(await h.certifyCounterpart(context, low, await kAt(low), 4n)).to.equal(low);
    expect(await h.certifyCounterpart(context, high, await kAt(high), 4n)).to.equal(high);
    expect(await h.certifyCounterpart(context, b + 100n, await kAt(b + 100n), 1n)).to.equal(0n);
    expect(await h.certifyCounterpart(context, b - 100n, await kAt(b - 100n), 1n)).to.equal(0n);
    const tiny = { ...context, target: 0n };
    // b <= epsilon clamps low to 1. At b=1 there is no lower endpoint.
    expect(await h.certifyCounterpart(tiny, 1n, 1n, 2n)).to.equal(0n);
    const kOne = await kAt(1n);
    const kTwo = await kAt(2n);
    expect(kTwo).to.be.gt(kOne);
    expect(await h.certifyCounterpart({ ...context, target: kOne }, 2n, kTwo, 4n)).to.equal(2n);
  });
  it("preserves wide intermediate products when simplifying the rounded-K helper", async function () {
    const h = await loadFixture(fixture);
    const reserve = (1n << 128n) - 1n;
    // depth * (x+y) exceeds uint256 although its quotient and K both fit.
    // The original directed floor helper uses fullMulDiv, not mulDiv.
    expect(reserve * (reserve + reserve)).to.be.greaterThan((1n << 256n) - 1n);
    const q = 1n << 128n;
    const depth = BigInt(await h.solveLFromState(reserve, reserve, A, LAMBDA));
    expect(depth * (reserve + reserve)).to.be.greaterThan((1n << 256n) - 1n);
    const n = (reserve * reserve) / (WAD >> 18n);
    const head = (depth * reserve) / (q >> 18n);
    expect(n - head).to.be.at.most(1n << 18n);
    const thetaUp = (A * q + WAD - 1n) / WAD;
    const correction = (thetaUp * (n - head) + q - 1n) / q;
    expect(await h.computeQuoteK(reserve, reserve, depth, A, LAMBDA)).to.equal(n - correction);
  });
  it("certifies best at 0.0001% once without padding and rejects the former 0.001% band", async function () {
    const h = await loadFixture(fixture);
    const b = 1000n * WAD;
    const depth = await h.solveLFromState(b, b, A, LAMBDA);
    const target = await h.computeQuoteK(b, b, depth, A, LAMBDA);
    const c = { fixedAxis: b, target, a: A, lambda: LAMBDA, depth, previous: 2n * b, exactOut: false };
    for (const candidate of [b - b / 2000000n, b + b / 2000000n]) {
      const k = await h.computeQuoteK(b, candidate, depth, A, LAMBDA);
      expect(await h.certifyCounterpart(c, candidate, k, (c.previous - candidate) / 1000001n)).to.equal(candidate);
    }
    const candidate = b + b / 200000n;
    const k = await h.computeQuoteK(b, candidate, depth, A, LAMBDA);
    expect(await h.certifyCounterpart(c, candidate, k, (c.previous - candidate) / 1000001n)).to.equal(0n);
    expect(await h.certifyCounterpart(c, candidate, k, (c.previous - candidate) / 100001n)).to.equal(candidate);
  });

  it("halves a nonpositive secant proposal and applies the exact-out margin once", async function () {
    const h = await loadFixture(fixture);
    const result = await h.quoteExactOutForward(
      50000000000000000000n,
      1020611158635000000000000n,
      outputAfterMargin(102061114000000000000n),
      WAD - 1n,
      10n ** 12n
    );
    expect(Array.from(result)).to.deep.equal([adjusted(245562761914828962n, true), 12n]);
  });
});
