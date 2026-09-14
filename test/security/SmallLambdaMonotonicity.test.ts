import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";
import { exactInputReferenceWithL, assertQuotePrecision } from "../helpers/continuousReference";

interface QuotePair {
  zeroForOne: boolean;
  amountInRaw: [string, string];
  amountOutRaw: [string, string];
  feeAmountRaw?: [string, string];
  rawOutputMath: [string, string];
  iterations: [number, number];
}
interface StateVector {
  id: number;
  aWad: string;
  lambdaWad: string;
  feeBps: number;
  decimals: [number, number];
  drainToken: number;
  depletionPpm: number;
  reservesRaw: [string, string];
  cases: QuotePair[];
}
const WAD = 10n ** 18n;
const REFUSALS = new Set([
  "SolverDidNotConverge",
  "LpValueDecreased",
  "AmountTooSmallAfterNormalization",
  "InsufficientLiquidity",
]);

interface Observation {
  state: number;
  pair: number;
  mechanism: "solver" | "native floor";
  depletionBeforePpm: bigint;
  depletionAfterWad: bigint;
  inputWad: bigint;
  reserveInWad: bigint;
  dropWad: bigint;
  previousOutputWad: bigint;
  referenceErrorsRaw: bigint[];
  feeRatesWad: bigint[];
}

function percent(n: bigint, d: bigint) {
  return hre.ethers.formatUnits((n * 100n * 10n ** 12n) / d, 12);
}
function summary(rows: Observation[]) {
  if (rows.length === 0) return { pairs: 0 };
  const minimum = (field: "depletionBeforePpm" | "depletionAfterWad") =>
    rows.reduce((a, b) => (a[field] < b[field] ? a : b));
  const maximum = (field: "inputWad" | "dropWad") => rows.reduce((a, b) => (a[field] > b[field] ? a : b));
  const maxRelative = rows.reduce((a, b) =>
    a.dropWad * b.previousOutputWad > b.dropWad * a.previousOutputWad ? a : b
  );
  const maxInputRatio = rows.reduce((a, b) => (a.inputWad * b.reserveInWad > b.inputWad * a.reserveInWad ? a : b));
  const point = (r: Observation) => ({ state: r.state, pair: r.pair });
  const errors = rows.flatMap((r) => r.referenceErrorsRaw);
  const rates = rows.flatMap((r) => r.feeRatesWad);
  return {
    pairs: rows.length,
    direction: "larger exact input -> smaller checked output",
    minPreDepletionPct: percent(minimum("depletionBeforePpm").depletionBeforePpm, 1_000_000n),
    minPostDepletionPct: percent(minimum("depletionAfterWad").depletionAfterWad, WAD),
    maxInputTokens: hre.ethers.formatUnits(maximum("inputWad").inputWad, 18),
    maxInputWitness: point(maximum("inputWad")),
    maxInputPctOfCurrentReserve: percent(maxInputRatio.inputWad, maxInputRatio.reserveInWad),
    maxDropTokens: hre.ethers.formatUnits(maximum("dropWad").dropWad, 18),
    maxAbsoluteDropWitness: point(maximum("dropWad")),
    maxDropPctOfPreviousQuote: percent(maxRelative.dropWad, maxRelative.previousOutputWad),
    maxRelativeDropWitness: point(maxRelative),
    minAppliedFeeBps: hre.ethers.formatUnits(
      rates.reduce((a, b) => (a < b ? a : b)),
      14
    ),
    maxAppliedFeeBps: hre.ethers.formatUnits(
      rates.reduce((a, b) => (a > b ? a : b)),
      14
    ),
    // A quote drop is NOT a continuous-error sign certificate. Compare both
    // quotes with independent rational-K bisection at the same recovered L.
    vsIndependentReference: {
      below: errors.filter((e) => e < 0n).length,
      equalAtNativePrecision: errors.filter((e) => e === 0n).length,
      above: errors.filter((e) => e > 0n).length,
    },
  };
}

function describeCorpus(fileName: string, caseCount: number, legacySolverCount: number) {
  const fixtureText = readFileSync(path.join(__dirname, "../../simulator/tests/fixtures", fileName), "utf8");
  const regression = JSON.parse(
    readFileSync(path.join(__dirname, "../../simulator/tests/fixtures/equilibra-small-lambda-regression.json"), "utf8")
  );
  expect(regression.schema).to.equal("equilibra-small-lambda-regression/v1");
  const snapshot = regression.corpora[fileName];
  expect(createHash("sha256").update(fixtureText).digest("hex"), "historical corpus identity").to.equal(
    snapshot.historicalInputSha256
  );
  const current = snapshot.historical;
  const fixtureData: {
    seedTokens: string;
    scope: { feesBps: number[]; feeFloorBps?: number; feeRampBps?: number };
    states: StateVector[];
  } = JSON.parse(fixtureText);

  const SEED = BigInt(fixtureData.seedTokens);
  const FLOOR = fixtureData.scope.feeFloorBps ?? 0;
  const RAMP = fixtureData.scope.feeRampBps ?? 0;
  const observations: Observation[] = [];
  let replayedPairs = 0;
  let refusedPairs = 0;
  const totals = {
    quotes: 0,
    completedCycles: 0,
    refusedQuotes: {} as Record<string, number>,
    refusedCycles: {} as Record<string, number>,
  };
  describe(`Small lambda ${fileName}: nonmonotonicity, direction and executed cycles`, function () {
    this.timeout(600_000);
    let math: any;
    before(async function () {
      math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
      await math.waitForDeployment();
    });

    const factories = new Map<string, () => ReturnType<typeof deployNativeQuantumFixture>>();
    for (const vector of fixtureData.states) {
      const configKey = [vector.aWad, vector.lambdaWad, vector.feeBps, ...vector.decimals].join("/");
      if (!factories.has(configKey)) {
        factories.set(configKey, async function fixture() {
          const fx = await deployNativeQuantumFixture({
            decimals: vector.decimals,
            seedRatio: [SEED, SEED],
            initialSwap: false,
            poolConfig: {
              aWad: BigInt(vector.aWad),
              lambdaWad: BigInt(vector.lambdaWad),
              baseFee: vector.feeBps,
              feeFloorBps: FLOOR,
              feeRampBps: RAMP,
              repegShareBps: 0,
            },
          });
          const config = await fx.pool.getFeeConfig();
          expect(config.baseFee).to.equal(BigInt(vector.feeBps));
          expect(config.feeFloorBps).to.equal(BigInt(FLOOR));
          expect(config.feeRampBps).to.equal(BigInt(RAMP));
          for (let i = 0; i < 2; i++) await fx.tokens[i].mint(fx.trader.target, 10n ** 15n * fx.units[i]);
          return fx;
        });
      }
      const fixture = factories.get(configKey)!;

      it(`state ${vector.id}: a=${vector.aWad}, fee=${vector.feeBps}, ${vector.decimals}, drain token${vector.drainToken} ${vector.depletionPpm}/1e6`, async function () {
        const fx = await loadFixture(fixture);
        const address = await fx.pool.getAddress();
        const wallet = await fx.trader.getAddress();
        const a = BigInt(vector.aWad),
          lambda = BigInt(vector.lambdaWad);
        // Replay the same depletion and historical inputs through actual swaps.
        // The new solver may change the shaping input by a few wei; reference
        // quotes must use the reserves we actually reached, not the old pin.
        const drain = (SEED * fx.units[vector.drainToken] * BigInt(vector.depletionPpm)) / 1_000_000n;
        let shapingInput = 0n;
        const shapingToken = fx.tokens[1 - vector.drainToken];
        const shapingBalance = await shapingToken.balanceOf(wallet);
        let remaining = drain;
        while (remaining > 0n) {
          const reserve = (await fx.pool.getReserves())[vector.drainToken];
          const scale = WAD / fx.units[vector.drainToken];
          const trialMath = remaining * scale + ((remaining * scale) / 99999999n || 1n);
          const chunk = trialMath >= reserve * scale ? (reserve * 999n) / 1000n : remaining;
          expect(chunk).to.be.gt(0n).and.at.most(remaining);
          shapingInput += await fx.pool.quoteExactOut(vector.drainToken === 1, chunk);
          await fx.trader.executeSwap(address, wallet, vector.drainToken === 1, -chunk, 0);
          remaining -= chunk;
        }
        expect(shapingBalance - (await shapingToken.balanceOf(wallet))).to.equal(shapingInput);
        const reserves = Array.from(await fx.pool.getReserves()) as bigint[];
        const expectedReserves = fx.units.map((unit) => SEED * unit);
        expectedReserves[vector.drainToken] -= drain;
        expectedReserves[1 - vector.drainToken] += shapingInput;
        expect(reserves).to.deep.equal(expectedReserves);
        expect(reserves).to.deep.equal(current.reserves[String(vector.id)].map(BigInt));
        expect(reserves[vector.drainToken]).to.equal(BigInt(vector.reservesRaw[vector.drainToken]));
        expect((await fx.pool.getOracleState()).priceScaleWad).to.equal(WAD);

        for (const [pairIndex, pair] of vector.cases.entries()) {
          const amounts = pair.amountInRaw.map(BigInt);
          expect(amounts[1]).to.be.gt(amounts[0]);
          expect(BigInt(pair.amountOutRaw[1]), "historical reversal witness").to.be.lt(BigInt(pair.amountOutRaw[0]));
          const outputs: (bigint | null)[] = [],
            rawOutputs: bigint[] = [];
          const i = pair.zeroForOne ? 0 : 1,
            o = 1 - i;
          const scaleIn = WAD / fx.units[i],
            scaleOut = WAD / fx.units[o];
          const x = reserves[i] * scaleIn,
            y = reserves[o] * scaleOut;
          const lBefore = BigInt(await math.solveLFromState(x, y, a, lambda));
          const references: bigint[] = [],
            errors: bigint[] = [],
            rates: bigint[] = [];
          let postDepletion = 0n;
          for (let k = 0; k < 2; k++) {
            const amount = amounts[k];
            const ceilingWad = BigInt(vector.feeBps) * 10n ** 14n;
            const rate =
              RAMP === 0
                ? ceilingWad
                : BigInt(
                    await math.smoothstepFeeWad(
                      await math.predictPostDistanceCp(x, y, amount * scaleIn),
                      BigInt(RAMP) * 10n ** 14n,
                      BigInt(FLOOR) * 10n ** 14n,
                      ceilingWad
                    )
                  );
            rates.push(rate);
            const floorFee = (amount * rate) / WAD;
            const fee = floorFee === 0n && rate > 0n ? 1n : floorFee;
            const expected = current.entries[vector.id + "/" + pairIndex + "/" + k];
            expect(expected, "every historical leg has a current outcome").not.to.equal(undefined);
            if (expected.forward.error) {
              const error = expected.forward.error;
              expect(REFUSALS.has(error), "known typed refusal").to.equal(true);
              if (fee >= amount) expect(error).to.equal("AmountTooSmallAfterNormalization");
              await expect(fx.pool.quoteExactIn(pair.zeroForOne, amount)).to.be.revertedWithCustomError(fx.pool, error);
              await expect(
                fx.trader.executeSwap(address, wallet, pair.zeroForOne, amount, 0)
              ).to.be.revertedWithCustomError(fx.pool, error);
              expect(Array.from(await fx.pool.getReserves())).to.deep.equal(reserves);
              expect(expected.reverse).to.equal(null);
              totals.refusedQuotes[error] = (totals.refusedQuotes[error] ?? 0) + 1;
              outputs.push(null);
              rawOutputs.push(0n);
              references.push(0n);
              continue;
            }
            expect(amount).to.be.gt(fee);
            expect(fee).to.equal(BigInt(expected.forward.fee));
            expect(rate).to.equal(BigInt(expected.forward.feeWad));
            const dx = (amount - fee) * scaleIn;
            const [rawMath, iterations] = await math.quoteExactInForward(x, y, dx, a, lambda);
            expect(iterations).to.be.at.most(40n);
            expect(iterations).to.equal(BigInt(expected.forward.iters));
            rawOutputs.push(BigInt(rawMath));
            const rawNative = BigInt(rawMath) / scaleOut;
            expect(rawNative).to.equal(BigInt(expected.forward.output));
            expect(amount).to.equal(BigInt(expected.forward.input));
            const lRaw = BigInt(await math.solveLFromState(x + amount * scaleIn, y - rawNative * scaleOut, a, lambda));
            const output = rawNative;
            expect(lRaw, "single strict LP guard; no repair").to.be.gte(lBefore);
            const reference = exactInputReferenceWithL(x, y, dx, a, lambda, lBefore) / scaleOut;
            assertQuotePrecision(
              rawNative,
              reference,
              iterations,
              (reserves[o] - 1n) / reserves[i] + 2n,
              "historical input replay"
            );
            references.push(reference);
            expect(output).to.be.greaterThan(0n);
            outputs.push(output);
            const lAfter = BigInt(await math.solveLFromState(x + amount * scaleIn, y - output * scaleOut, a, lambda));
            expect(lAfter, "strict settled LP guard").to.be.gte(lBefore);
            errors.push(output - reference);
            if (k === 1) {
              const minReserve =
                x + amount * scaleIn < y - output * scaleOut ? x + amount * scaleIn : y - output * scaleOut;
              postDepletion = minReserve < SEED * WAD ? WAD - minReserve / SEED : 0n;
            }

            const snapshot = await hre.network.provider.send("evm_snapshot");
            try {
              expect(await fx.pool.quoteExactIn(pair.zeroForOne, amount)).to.equal(output);
              const before = await Promise.all(fx.tokens.map((t) => t.balanceOf(wallet)));
              // A successful same-state quote must execute; do not catch failures here.
              const receipt = await (await fx.trader.executeSwap(address, wallet, pair.zeroForOne, amount, 0)).wait();
              const swapLogs = receipt!.logs.filter(
                (log: any) =>
                  log.address.toLowerCase() === address.toLowerCase() &&
                  log.topics[0] === fx.pool.interface.getEvent("Swap")!.topicHash
              );
              expect(swapLogs).to.have.length(1);
              expect(fx.pool.interface.parseLog(swapLogs[0])!.args.feeAmount).to.equal(fee);
              expect(before[i] - (await fx.tokens[i].balanceOf(wallet))).to.equal(amount);
              expect((await fx.tokens[o].balanceOf(wallet)) - before[o]).to.equal(output);
              totals.quotes++;
              let reverse: bigint;
              try {
                reverse = BigInt(await fx.pool.quoteExactIn(!pair.zeroForOne, output));
              } catch (error: any) {
                const data = error.data ?? error.error?.data;
                let name: string | undefined;
                try {
                  name = fx.pool.interface.parseError(data)?.name;
                } catch {}
                if (!name || !REFUSALS.has(name)) throw error;
                expect(name, "only this recorded reverse refusal is accepted").to.equal(expected.reverse.error);
                await expect(
                  fx.trader.executeSwap(address, wallet, !pair.zeroForOne, output, 0)
                ).to.be.revertedWithCustomError(fx.pool, name);
                totals.refusedCycles[name] = (totals.refusedCycles[name] ?? 0) + 1;
                continue;
              }
              expect(expected.reverse.error, "recorded successful reverse leg").to.equal(undefined);
              expect(reverse).to.equal(BigInt(expected.reverse.output));
              expect(reverse).to.be.gt(0n);
              await fx.trader.executeSwap(address, wallet, !pair.zeroForOne, output, 0);
              expect(await fx.tokens[o].balanceOf(wallet), "intermediate token fully restored").to.equal(before[o]);
              expect((await fx.tokens[i].balanceOf(wallet)) - before[i], "no positive closed-cycle profit").to.equal(
                reverse - amount
              );
              expect(reverse, "no profitable round trip, even one native unit").to.be.lte(amount);
              expect((await fx.pool.getOracleState()).priceScaleWad).to.equal(WAD);
              totals.completedCycles++;
            } finally {
              expect(await hre.network.provider.send("evm_revert", [snapshot])).to.equal(true);
            }
          }
          if (outputs.every((value) => value !== null))
            expect(references[1], "independent curve output remains nondecreasing").to.be.gte(references[0]);
          replayedPairs++;
          const [first, second] = outputs;
          if (first === null || second === null) {
            refusedPairs++;
            continue;
          }
          if (second >= first) continue;
          observations.push({
            state: vector.id,
            pair: pairIndex,
            mechanism: rawOutputs[1] < rawOutputs[0] ? "solver" : "native floor",
            depletionBeforePpm: BigInt(vector.depletionPpm),
            depletionAfterWad: postDepletion,
            inputWad: amounts[1] * scaleIn,
            reserveInWad: x,
            dropWad: (first - second) * scaleOut,
            previousOutputWad: first * scaleOut,
            referenceErrorsRaw: errors,
            feeRatesWad: rates,
          });
        }
      });
    }

    after(function () {
      expect(replayedPairs).to.equal(caseCount);
      expect(totals.quotes + Object.values(totals.refusedQuotes).reduce((n, c) => n + c, 0)).to.equal(caseCount * 2);
      expect({ replayedPairs, refusedPairs, ...totals }, "exact completed/refused historical coverage").to.deep.equal(
        current.summary
      );
      expect(totals.completedCycles + Object.values(totals.refusedCycles).reduce((n, c) => n + c, 0)).to.equal(
        totals.quotes
      );
      const solver = observations.filter((r) => r.mechanism === "solver");
      const nativeFloor = observations.filter((r) => r.mechanism === "native floor");
      expect(solver.length, "strict early tolerance must not add historical solver drops").to.be.at.most(
        legacySolverCount
      );
      expect(nativeFloor.length).to.be.at.most(caseCount - legacySolverCount);
      for (const r of solver)
        expect(r.dropWad * 10_000n, "sampled raw-solver drop ceiling").to.be.lte(r.previousOutputWad);
      console.log(
        "SMALL_LAMBDA_MONOTONICITY " +
          JSON.stringify({
            scope: "fixed 500000 tokens per side; minima/maxima on sampled grid, NOT global thresholds",
            feeConfig: { ceilingsBps: fixtureData.scope.feesBps, floorBps: FLOOR, rampBps: RAMP },
            depletion: "1 - minimum normalized reserve / original one-side reserve; before and after the larger input",
            error:
              "(previous checked output - next checked output) / previous checked output; NOT error vs exact invariant",
            replayedPairs,
            fixedHistoricalPairs: replayedPairs - observations.length - refusedPairs,
            refusedPairs,
            solver: summary(solver),
            nativeFloor: summary(nativeFloor),
            ...totals,
          })
      );
    });
  });
}
describeCorpus("equilibra-small-lambda-monotonicity.json", 300, 296);
describeCorpus("equilibra-lambda-5e13-monotonicity.json", 66, 64);
describeCorpus("equilibra-lambda-6e13-monotonicity.json", 548, 544);
describeCorpus("equilibra-lambda-6e13-alpha-99975-monotonicity.json", 264, 260);
describeCorpus("equilibra-lambda-1e14-alpha-99975-monotonicity.json", 22, 22);
describeCorpus("equilibra-lambda-1e14-alpha-max-monotonicity.json", 22, 22);
