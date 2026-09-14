// SPDX-License-Identifier: MIT
// Executed round trips at every production alpha/lambda corner. No profit
// tolerance. Only quote-stage nonconvergence at the widened lambda boundary
// is permitted; execution after a successful quote must always succeed.
import {
  impersonateAccount,
  loadFixture,
  setBalance,
  stopImpersonatingAccount,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

import { buildPreset, deploySecurityFixture, SecurityFixture, WAD } from "../helpers/securityFixtures";

// Exact integer boundaries from Constants.sol. In particular, do not express
// A_MAX as a JS number: Number(WAD - 1n) rounds up to the forbidden WAD.
const CORNERS = [
  { label: "A_MIN / LAMBDA_MIN", aWad: WAD / 10n, lambdaWad: WAD / 1_000_000n },
  { label: "A_MIN / LAMBDA_MAX", aWad: WAD / 10n, lambdaWad: WAD },
  { label: "A_MAX / LAMBDA_MIN", aWad: WAD - 1n, lambdaWad: WAD / 1_000_000n },
  { label: "A_MAX / LAMBDA_MAX", aWad: WAD - 1n, lambdaWad: WAD },
] as const;

const MARKETS = [
  { label: "pegged 6/18 decimals, price 1", preset: "WETH", price: 1n },
  { label: "WETH 6/18 decimals, price 2000", preset: "WETH", price: 2000n },
  { label: "WBTC 6/8 decimals, price 102354", preset: "WBTC", price: 102354n },
] as const;
const DEPTHS_BPS = [1n, 100n, 5000n, 9900n];
const STATES = ["balanced", "quote-depleted", "base-depleted"] as const;
const MODES = ["exact-in", "exact-out"] as const;
type Mode = (typeof MODES)[number];

class UnavailableQuote extends Error {}

function token(fx: SecurityFixture, quote: boolean) {
  return { contract: quote ? fx.quote : fx.base, address: quote ? fx.quoteAddr : fx.baseAddr };
}

async function reserves(fx: SecurityFixture, quoteIn: boolean): Promise<[bigint, bigint]> {
  const [r0, r1] = await fx.pool.getReserves();
  return quoteIn === fx.quoteIsToken0 ? [BigInt(r0), BigInt(r1)] : [BigInt(r1), BigInt(r0)];
}

async function balances(fx: SecurityFixture, quoteIn: boolean): Promise<[bigint, bigint]> {
  return [
    BigInt(await token(fx, quoteIn).contract.balanceOf(fx.trader.address)),
    BigInt(await token(fx, !quoteIn).contract.balanceOf(fx.trader.address)),
  ];
}

async function imbalance(fx: SecurityFixture): Promise<bigint> {
  const [reserveQuote, reserveBase] = await reserves(fx, true);
  const quoteWad = reserveQuote * 10n ** 12n;
  const baseWad = reserveBase * 10n ** BigInt(18 - fx.baseDecimals);
  const anchor = BigInt((await fx.pool.getOracleState()).priceScaleWad);
  const r0 = fx.quoteIsToken0 ? quoteWad : baseWad;
  const r1 = fx.quoteIsToken0 ? baseWad : quoteWad;
  return r1 - (r0 * WAD) / anchor;
}

async function swap(
  fx: SecurityFixture,
  quoteIn: boolean,
  mode: Mode,
  amount: bigint,
  signer = fx.trader
): Promise<{ amountIn: bigint; amountOut: bigint }> {
  const input = token(fx, quoteIn);
  const output = token(fx, !quoteIn);
  const zeroForOne = quoteIn === fx.quoteIsToken0;
  const beforeIn = BigInt(await input.contract.balanceOf(signer.address));
  const beforeOut = BigInt(await output.contract.balanceOf(signer.address));
  const anchor = (await fx.pool.getOracleState()).priceScaleWad;
  let quoted: bigint;
  try {
    quoted = BigInt(
      mode === "exact-in"
        ? await fx.pool.quoteExactIn(zeroForOne, amount)
        : await fx.pool.quoteExactOut(zeroForOne, amount)
    );
  } catch (error) {
    if ((error as { data?: string }).data === fx.pool.interface.getError("SolverDidNotConverge")!.selector) {
      throw new UnavailableQuote("quote reached the solver limit");
    }
    throw error;
  }
  expect(amount, "swap must exercise a positive amount").to.be.gt(0n);
  expect(quoted, "quote must be executable, not a zero sentinel").to.be.gt(0n);
  const common = {
    tokenIn: input.address,
    tokenOut: output.address,
    poolIndex: 0,
    recipient: signer.address,
    deadline: (await time.latest()) + 3600,
  };
  if (mode === "exact-in") {
    await fx.router.connect(signer).exactInputSingle({ ...common, amountIn: amount, amountOutMinimum: quoted });
  } else {
    await fx.router.connect(signer).exactOutputSingle({ ...common, amountOut: amount, amountInMaximum: quoted });
  }
  const amountIn = beforeIn - BigInt(await input.contract.balanceOf(signer.address));
  const amountOut = BigInt(await output.contract.balanceOf(signer.address)) - beforeOut;
  expect(amountIn, "executed input must match the same-state quote").to.equal(mode === "exact-in" ? amount : quoted);
  expect(amountOut, "executed output must match the same-state quote").to.equal(mode === "exact-in" ? quoted : amount);
  expect((await fx.pool.getOracleState()).priceScaleWad, "auto-repeg must remain disabled").to.equal(anchor);
  return { amountIn, amountOut };
}

// The reverse exact-in spends ALL intermediate tokens. Reverse exact-out
// restores ALL original input tokens instead; the intermediate-token delta
// then measures the cycle's cost/profit. No oracle valuation or EI/EO inverse
// identity is needed: one wallet balance is restored exactly, the other must
// not grow. Existing balances fund the fee on an exact-out return leg.
async function roundTrip(
  fx: SecurityFixture,
  quoteIn: boolean,
  first: Mode,
  second: Mode,
  amount: bigint,
  crossFrom?: bigint
) {
  const before = await balances(fx, quoteIn);
  const forward = await swap(fx, quoteIn, first, amount);
  if (crossFrom !== undefined) {
    expect(crossFrom * (await imbalance(fx)), "first leg must actually cross the anchor").to.be.lt(0n);
  }
  await swap(fx, !quoteIn, second, second === "exact-in" ? forward.amountOut : forward.amountIn);
  const after = await balances(fx, quoteIn);
  const restored = second === "exact-in" ? 1 : 0;
  expect(after[restored], "round trip must close one token balance exactly").to.equal(before[restored]);
  expect(
    after[1 - restored] - before[1 - restored],
    "executed round trip must not profit, even by one raw unit"
  ).to.be.lte(0n);
}

describe("RoundTripParameterCorners: all alpha/lambda min/max combinations", function () {
  this.timeout(120_000);

  for (const corner of CORNERS) {
    for (const market of MARKETS) {
      describe(`${corner.label}; ${market.label}`, function () {
        async function fixture() {
          const fx = await deploySecurityFixture({
            ...buildPreset(market.preset),
            aWad: corner.aWad,
            lambdaWad: corner.lambdaWad,
            basePriceUsd: market.price,
          });
          const curve = await fx.pool.getCurveParams();
          expect(curve.aWad).to.equal(corner.aWad);
          expect(curve.lambdaWad).to.equal(corner.lambdaWad);
          // Stress the actual swap implementation at the requested flat 1 bps.
          // The shared fixture starts from its preset fee, so use the existing
          // pool setter to isolate the deployable one-bps boundary here.
          // Do not substitute the swap math.
          const timelock = await fx.factory.paramTimelock();
          await setBalance(timelock, WAD);
          await impersonateAccount(timelock);
          try {
            await fx.pool.connect(await hre.ethers.getSigner(timelock)).setFeeParams(1, 0, 0);
          } finally {
            await stopImpersonatingAccount(timelock);
          }
          const config = await fx.pool.getFeeConfig();
          expect(config.baseFee).to.equal(1n);
          expect(config.feeRampBps).to.equal(0n);
          expect(config.feeFloorBps).to.equal(0n);
          expect(config.protocolFeePercent).to.equal(0n);
          expect(config.repegShareBps).to.equal(0n);
          return fx;
        }

        for (const state of STATES) {
          for (const quoteIn of [true, false]) {
            for (const first of MODES) {
              for (const second of MODES) {
                it(`${state}; ${quoteIn ? "quote" : "base"} first; ${first} -> ${second}; 0.01%..99%`, async function () {
                  const fx = await loadFixture(fixture);
                  if (state !== "balanced") {
                    const drainQuote = state === "quote-depleted";
                    const originalOut = drainQuote ? fx.initialQuoteRaw : fx.initialBaseRaw;
                    const target = (originalOut * 75n) / 100n;
                    // Exact-out creates the requested imbalance with an actual
                    // swap; no catch-and-shrink or best-effort state shaping.
                    await swap(fx, !drainQuote, "exact-out", target, fx.owner);
                    const [, remaining] = await reserves(fx, !drainQuote);
                    expect(remaining).to.equal(originalOut - target);
                  }
                  let completed = 0;
                  let refused = 0;
                  for (const bps of DEPTHS_BPS) {
                    const snapshot = await hre.network.provider.send("evm_snapshot");
                    try {
                      const [reserveIn, reserveOut] = await reserves(fx, quoteIn);
                      const amount = ((first === "exact-in" ? reserveIn : reserveOut) * bps) / 10_000n;
                      await roundTrip(fx, quoteIn, first, second, amount);
                      completed += 1;
                    } catch (error) {
                      if (
                        corner.aWad === WAD - 1n &&
                        corner.lambdaWad === WAD / 1_000_000n &&
                        error instanceof UnavailableQuote
                      ) {
                        refused += 1;
                      } else {
                        throw new Error(`depth=${bps}bps: ${String(error)}`);
                      }
                    } finally {
                      expect(await hre.network.provider.send("evm_revert", [snapshot])).to.equal(true);
                    }
                  }
                  expect(completed, "each corner/direction/path must execute real closed cycles").to.be.gt(0);
                  expect(completed + refused, "every depth must be checked").to.equal(DEPTHS_BPS.length);
                });
              }
            }
          }
        }

        for (const quoteIn of [true, false]) {
          for (const first of MODES) {
            for (const second of MODES) {
              it(`confirmed cross-anchor; ${quoteIn ? "quote" : "base"} first; ${first} -> ${second}`, async function () {
                const fx = await loadFixture(fixture);
                const originalOut = quoteIn ? fx.initialQuoteRaw : fx.initialBaseRaw;
                await swap(fx, !quoteIn, "exact-out", (originalOut * 30n) / 100n, fx.owner);
                const crossFrom = await imbalance(fx);
                expect(crossFrom).not.to.equal(0n);
                const [, excessReserve] = await reserves(fx, quoteIn);
                const targetOut = excessReserve / 2n;
                const amount =
                  first === "exact-out"
                    ? targetOut
                    : BigInt(await fx.pool.quoteExactOut(quoteIn === fx.quoteIsToken0, targetOut));
                await roundTrip(fx, quoteIn, first, second, amount, crossFrom);
              });
            }
          }
        }
      });
    }
  }
});
