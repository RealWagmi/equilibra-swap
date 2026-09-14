// SPDX-License-Identifier: MIT
// Permanent executed-cycle grid at the production λ=1e12 boundary. Only its flat
// 1 bps fee is below factory policy.
// Production arithmetic, LP guard and execution are not replaced.
import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";
import { setPackedPoolField } from "../helpers/storageLayout";

const WAD = 10n ** 18n;
const DEPLETION_PPM = [0n, 100_000n, 500_000n, 750_000n, 900_000n, 990_000n, 999_000n, 999_900n, 999_999n];
const TRADE_BPS = [1n, 100n, 5000n, 9900n];
const REFUSALS = new Set([
  "SolverDidNotConverge",
  "LpValueDecreased",
  "AmountTooSmallAfterNormalization",
  "InsufficientLiquidity",
]);

describe("SmallLambdaCorners: executed cycles and cross-anchor paths", function () {
  this.timeout(600_000);
  for (const alpha of [WAD / 10n, WAD - 1n]) {
    for (const decimals of [
      [18, 18],
      [6, 18],
      [18, 6],
    ] as [number, number][]) {
      async function fixture() {
        const fx = await deployNativeQuantumFixture({
          decimals,
          seedRatio: [500_000n, 500_000n],
          initialSwap: false,
          poolConfig: { aWad: alpha, lambdaWad: 10n ** 12n, feeFloorBps: 0, feeRampBps: 0, repegShareBps: 0 },
        });
        await setPackedPoolField(await fx.pool.getAddress(), "_baseFee", 1n);
        for (let i = 0; i < 2; i++) await fx.tokens[i].mint(await fx.trader.getAddress(), 10n ** 15n * fx.units[i]);
        return fx;
      }

      it(`alpha=${alpha}, decimals=${decimals.join("/")}`, async function () {
        const fx = await loadFixture(fixture);
        const poolAddress = await fx.pool.getAddress();
        const wallet = await fx.trader.getAddress();
        const stats = {
          alpha: alpha.toString(),
          decimals,
          shaped: 0,
          shapeRefusals: 0,
          cycles: 0,
          crossAnchor: 0,
          quoteChecks: 0,
          refused: {} as Record<string, number>,
          monoComparisons: 0,
          monoFailures: [] as unknown[],
        };

        async function balances() {
          return Promise.all(fx.tokens.map((t) => t.balanceOf(wallet)));
        }
        async function imbalance() {
          const [r0, r1] = await fx.pool.getReserves();
          return (BigInt(r1) * WAD) / fx.units[1] - (BigInt(r0) * WAD) / fx.units[0];
        }
        async function quote(zfo: boolean, eo: boolean, amount: bigint): Promise<bigint | null> {
          try {
            return BigInt(eo ? await fx.pool.quoteExactOut(zfo, amount) : await fx.pool.quoteExactIn(zfo, amount));
          } catch (e: any) {
            const data = e.data ?? e.error?.data;
            let name: string | undefined;
            try {
              name = fx.pool.interface.parseError(data)?.name;
            } catch {}
            if (!name || !REFUSALS.has(name)) throw e;
            stats.refused[name] = (stats.refused[name] ?? 0) + 1;
            return null;
          }
        }
        async function execute(zfo: boolean, eo: boolean, amount: bigint) {
          const q = await quote(zfo, eo, amount);
          if (q === null) return null;
          expect(q).to.be.gt(0n);
          const before = await balances();
          const anchor = (await fx.pool.getOracleState()).priceScaleWad;
          // Execution after a successful same-state quote must NOT be swallowed.
          await fx.trader.executeSwap(poolAddress, wallet, zfo, eo ? -amount : amount, 0);
          const after = await balances();
          const i = zfo ? 0 : 1,
            o = 1 - i;
          const input = BigInt(before[i]) - BigInt(after[i]);
          const output = BigInt(after[o]) - BigInt(before[o]);
          expect(input).to.equal(eo ? q : amount);
          expect(output).to.equal(eo ? amount : q);
          expect((await fx.pool.getOracleState()).priceScaleWad).to.equal(anchor);
          stats.quoteChecks++;
          return { input, output };
        }

        for (const depletion of DEPLETION_PPM) {
          for (const drain0 of depletion === 0n ? [true] : [true, false]) {
            const baseSnapshot = await hre.network.provider.send("evm_snapshot");
            try {
              if (depletion > 0n) {
                let remaining = (500_000n * fx.units[drain0 ? 0 : 1] * depletion) / 1_000_000n;
                const targetReserve = 500_000n * fx.units[drain0 ? 0 : 1] - remaining;
                while (remaining > 0n) {
                  const reserve = (await fx.pool.getReserves())[drain0 ? 0 : 1];
                  const scale = WAD / fx.units[drain0 ? 0 : 1];
                  const trial = remaining * scale + ((remaining * scale) / 99999999n || 1n);
                  const chunk = trial >= reserve * scale ? (reserve * 999n) / 1000n : remaining;
                  expect(chunk).to.be.gt(0n).and.at.most(remaining);
                  expect(await execute(!drain0, true, chunk), "depletion leg must execute").not.to.equal(null);
                  remaining -= chunk;
                }
                expect((await fx.pool.getReserves())[drain0 ? 0 : 1]).to.equal(targetReserve);
              }
              stats.shaped++;
              for (const zfo of [true, false]) {
                const [r0, r1] = await fx.pool.getReserves();
                const reserveIn = BigInt(zfo ? r0 : r1),
                  reserveOut = BigInt(zfo ? r1 : r0);
                for (const firstEO of [false, true]) {
                  for (const secondEO of [false, true]) {
                    for (const bps of TRADE_BPS) {
                      const snapshot = await hre.network.provider.send("evm_snapshot");
                      try {
                        const before = await balances();
                        const from = await imbalance();
                        const amount = ((firstEO ? reserveOut : reserveIn) * bps) / 10_000n;
                        const first = await execute(zfo, firstEO, amount);
                        if (!first) continue;
                        const crossed = from * (await imbalance()) < 0n;
                        const second = await execute(!zfo, secondEO, secondEO ? first.input : first.output);
                        if (!second) continue;
                        const after = await balances();
                        const restored = secondEO ? (zfo ? 0 : 1) : zfo ? 1 : 0;
                        expect(after[restored], "closed intermediate balance").to.equal(before[restored]);
                        expect(
                          BigInt(after[1 - restored]) - BigInt(before[1 - restored]),
                          `profitable cycle: depletion=${depletion} drain0=${drain0} zfo=${zfo} EO=${firstEO}/${secondEO} size=${bps}`
                        ).to.be.lte(0n);
                        stats.cycles++;
                        if (crossed) stats.crossAnchor++;
                      } finally {
                        expect(await hre.network.provider.send("evm_revert", [snapshot])).to.equal(true);
                      }
                    }
                  }
                }

                // Independent same-state scans in both exact-in/out modes.
                // Include amounts on both sides of the reserve-balance crossing.
                for (const eo of [false, true]) {
                  const scaleIn = fx.units[zfo ? 0 : 1],
                    scaleOut = fx.units[zfo ? 1 : 0];
                  const samples = new Set<bigint>(TRADE_BPS.map((b) => ((eo ? reserveOut : reserveIn) * b) / 10_000n));
                  const excess = reserveOut - (reserveIn * scaleOut) / scaleIn;
                  if (excess > 0n) {
                    const centerOut = excess / 2n;
                    const center = eo ? centerOut : await quote(zfo, true, centerOut);
                    if (center !== null && center > 0n) {
                      for (const factor of [999_900n, 999_999n, 1_000_000n, 1_000_001n, 1_000_100n])
                        samples.add((center * factor) / 1_000_000n);
                    }
                  }
                  let previous: { amount: bigint; quoted: bigint } | undefined;
                  for (const amount of [...samples]
                    .filter((x) => x > 0n)
                    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
                    const quoted = await quote(zfo, eo, amount);
                    if (quoted === null) continue;
                    if (previous) {
                      stats.monoComparisons++;
                      if (quoted < previous.quoted)
                        stats.monoFailures.push({
                          depletion: String(depletion),
                          drain0,
                          zfo,
                          eo,
                          previous: { amount: String(previous.amount), quoted: String(previous.quoted) },
                          amount: String(amount),
                          quoted: String(quoted),
                        });
                    }
                    previous = { amount, quoted };
                  }
                }
              }
            } finally {
              expect(await hre.network.provider.send("evm_revert", [baseSnapshot])).to.equal(true);
            }
          }
        }
        console.log("SMALL_LAMBDA_RESULT " + JSON.stringify(stats));
        expect(stats.shapeRefusals, "must not skip any requested depletion state").to.equal(0);
        expect(stats.shaped).to.equal(2 * DEPLETION_PPM.length - 1);
        expect(stats.cycles, "must execute real closed cycles").to.be.gt(0);
        expect(stats.crossAnchor, "must execute confirmed cross-anchor cycles").to.be.gt(0);
        expect(stats.monoFailures, "checked quotes must be nondecreasing on this grid").to.deep.equal([]);
      });
    }
  }
});
