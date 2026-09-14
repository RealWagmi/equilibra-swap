import { poolEmaLogWad } from "../helpers/storageLayout";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { storageSlot, POOL_CONTRACT, TOKEN_CONTRACT } from "../helpers/storageLayout";
import {
  deployNativeQuantumFixture,
  deployLpRepairFixture,
  LP_REPAIR_CASES,
  exactOutSettlement,
  setNativeReserves,
} from "../fixtures/nativeQuantum";
import {
  execExactOutputViaRustTrace,
  quoteExactInputViaRustTrace,
  type SnapshotForRustQuote,
} from "../../simulator/test_helpers/rustTestUtils";

type Fixture = Awaited<ReturnType<typeof deployNativeQuantumFixture>>;

/** Read the actual post-trade state; do not infer timestamps or token order. */
async function snapshotPool(f: Fixture): Promise<SnapshotForRustQuote> {
  const address = await f.pool.getAddress();
  const [reserve0, reserve1] = await f.pool.getReserves();
  const curve = await f.pool.getCurveParams();
  const fee = await f.pool.getFeeConfig();
  const oracle = await f.pool.getOracleState();
  const timestamps = await f.pool.getOracleTimestamps();
  const lp = await f.pool.getLpValueState();
  const [protocolFee0, protocolFee1] = await f.pool.getProtocolFees();
  return {
    poolKey: "native-quantum-parity",
    amm: "equilibra",
    token0: await f.tokens[0].getAddress(),
    token1: await f.tokens[1].getAddress(),
    token0Symbol: await f.tokens[0].symbol(),
    token1Symbol: await f.tokens[1].symbol(),
    token0Decimals: Number(await f.tokens[0].decimals()),
    token1Decimals: Number(await f.tokens[1].decimals()),
    reserve0,
    reserve1,
    feeBps: Number(fee.baseFee),
    aWad: curve.aWad,
    lambdaWad: curve.lambdaWad,
    equilibraProtocolFeePercent: fee.protocolFeePercent,
    equilibraEmaPeriod: fee.emaPeriod,
    equilibraFeeRampBps: fee.feeRampBps,
    equilibraFeeFloorBps: fee.feeFloorBps,
    equilibraRepegShareBps: fee.repegShareBps,
    equilibraProtocolFee0: protocolFee0,
    equilibraProtocolFee1: protocolFee1,
    equilibraE0: await f.tokens[0].balanceOf(address),
    equilibraE1: await f.tokens[1].balanceOf(address),
    equilibraEmaPrice: oracle.emaPriceWad,
    equilibraEmaLogWad: await poolEmaLogWad(address),
    equilibraLastTimestamp: timestamps.lastEmaTs,
    equilibraLastRecenterTimestamp: timestamps.lastRepegTs,
    equilibraRepegStepWad: fee.repegStepWad,
    equilibraRepegThresholdToken1UpWad: fee.repegThresholdToken1UpWad,
    equilibraRepegThresholdToken1DownWad: fee.repegThresholdToken1DownWad,
    equilibraParachuteBandMult: fee.parachuteBandMult,
    equilibraAnchorPriceWad: oracle.priceScaleWad,
    equilibraLpUnitValueGenesisWad: lp.genesisWad,
    equilibraLpUnitValueWad: lp.unitValueWad,
    equilibraLpValueGrowthWad: lp.growthWad,
  };
}

async function traceArgs(f: Fixture, input: number) {
  return {
    snapshot: await snapshotPool(f),
    baseSymbol: "WETH" as const,
    tokenIn: await f.tokens[input].getAddress(),
    poolAddress: await f.pool.getAddress(),
    timestamp: (await time.latest()) + 60,
  };
}

async function rustFailure(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr;
    return stderr ? stderr.toString("utf8") : String(error);
  }
  throw new Error("Rust trace unexpectedly accepted the rejected swap");
}

/** Canonical production clone, then explicitly constructed precision-stress state. */
async function deployPrecisionStressFixture(exactOut: boolean, zeroForOne: boolean) {
  const f = await deployNativeQuantumFixture({ initialSwap: false });
  const WAD = 10n ** 18n;
  const x = 10n ** 30n;
  const y = exactOut ? 20n * x : x / 20n;
  const alpha = 990000000000000000n;
  const lambda = exactOut ? 1000000000000000n : 16780000000000000n;
  for (const token of f.tokens) await token.mint(f.owner.address, 100n * x);
  await f.factory.createPoolAndAddLiquidity(
    f.tokens[0].target,
    f.tokens[1].target,
    {
      aWad: alpha,
      lambdaWad: lambda,
      baseFee: 10,
      feeFloorBps: 0,
      feeRampBps: 0,
      emaPeriod: 600,
      repegShareBps: 0,
      repegStepWad: 1000000000000000n,
      repegThresholdToken1UpWad: 100000000000000n,
      repegThresholdToken1DownWad: 100000000000000n,
    },
    x,
    x,
    f.owner.address
  );
  f.pool = await hre.ethers.getContractAt("EquilibraPool", await f.factory.allPools(1));
  const address = await f.pool.getAddress();
  const reserves = zeroForOne ? [x, y] : [y, x];
  const setSlot = async (target: string, slot: bigint | string, value: bigint) =>
    hre.network.provider.send("hardhat_setStorageAt", [
      target,
      typeof slot === "bigint" ? hre.ethers.toBeHex(slot) : slot,
      hre.ethers.toBeHex(value, 32),
    ]);
  // Derive slots from this build; getters below pin the constructed state.
  await setSlot(address, await storageSlot(POOL_CONTRACT, "_reservesPacked"), reserves[0] | (reserves[1] << 128n));
  const balancesSlot = await storageSlot(TOKEN_CONTRACT, "_balances");
  for (let i = 0; i < 2; i++) {
    const token = f.tokens[i];
    const previous = await token.balanceOf(address);
    const owned = await token.balanceOf(f.owner.address);
    const balanceSlot = (account: string) =>
      hre.ethers.keccak256(
        hre.ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, balancesSlot])
      );
    // MockERC20 balances mapping only: move the delta between pool and owner,
    // preserving total supply and matching actual balances to stored reserves.
    await setSlot(await token.getAddress(), balanceSlot(address), reserves[i]);
    await setSlot(await token.getAddress(), balanceSlot(f.owner.address), owned + previous - reserves[i]);
    expect(await token.balanceOf(address)).to.equal(reserves[i]);
  }
  const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
  await math.waitForDeployment();
  const depth = await math.solveLFromState(reserves[1], reserves[0], alpha, lambda);
  const vp = (((2n * depth * WAD) / x) * WAD) / (1n << 128n);
  await setSlot(address, await storageSlot(POOL_CONTRACT, "_lpUnitValueGenesisWad"), vp);
  await setSlot(address, await storageSlot(POOL_CONTRACT, "_lpUnitValueWad"), vp);
  await setSlot(address, await storageSlot(POOL_CONTRACT, "_lpValueGrowthWad"), 0n);
  expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves);
  expect((await f.pool.getOracleState()).priceScaleWad).to.equal(WAD);
  expect(await f.pool.totalSupply()).to.equal(x);
  return { f, math, x, y, alpha, lambda };
}

async function rollbackSnapshot(f: Fixture) {
  const address = await f.pool.getAddress();
  const accounts = [f.owner.address, await f.trader.getAddress(), address];
  return {
    pool: await snapshotPool(f),
    slots: Array.from(await f.pool.getStorageSlots(Array.from({ length: 15 }, (_, i) => BigInt(i)))),
    lpSupply: await f.pool.totalSupply(),
    lpBalances: await Promise.all(accounts.map((account) => f.pool.balanceOf(account))),
    tokens: await Promise.all(
      f.tokens.map(async (token) => ({
        supply: await token.totalSupply(),
        balances: await Promise.all(accounts.map((account) => token.balanceOf(account))),
      }))
    ),
  };
}

describe("Common margin and LP guard: production Solidity / Rust trace parity", function () {
  this.timeout(180_000);

  for (const zeroForOne of [true, false]) {
    it(`recovers the former cap refusal and matches settlement (${zeroForOne})`, async () => {
      const W = 10n ** 18n;
      const f = await deployNativeQuantumFixture({
        initialSwap: false,
        seedRatio: [1_000_000n, 1_000_000n],
        poolConfig: { aWad: W - 1n, lambdaWad: 10n ** 12n },
      });
      const x = 341100000000000000000000n,
        y = 1024324324324324324324n;
      const output = 1023914594594594594594n;
      await setNativeReserves(f, zeroForOne ? [x, y] : [y, x]);
      const args = await traceArgs(f, zeroForOne ? 0 : 1);
      const before = await rollbackSnapshot(f);
      const quote = await f.pool.quoteExactOut(zeroForOne, output);
      const rust = await execExactOutputViaRustTrace({ ...args, amountOut: output });
      expect(quote).to.be.gt(0n);
      expect(rust.amountIn).to.equal(quote);
      expect(await rollbackSnapshot(f)).to.deep.equal(before);
      await f.tokens[zeroForOne ? 0 : 1].mint(f.trader.target, quote);
      await time.setNextBlockTimestamp(args.timestamp);
      await f.trader.executeSwap(args.poolAddress, f.owner.address, zeroForOne, -output, 0);
      const reserves = await f.pool.getReserves();
      expect([rust.step.post?.reserve0, rust.step.post?.reserve1]).to.deep.equal(reserves.map(String));
    });
  }

  for (const [x, y, delta, alpha, lambda, exactOut] of [
    [1000000000000000000n, 50000000000000000n, 50000000000000000n, 999750060000000000n, 1000000000000n, false],
    [500000000000000000000000n, 500000000000000000n, 250000000000000000n, 100000000000000000n, 1000000000000n, true],
    [
      1212000000000000000000000000n,
      1245632065775950668036998n,
      349177200000000000000000000n,
      100000000000000000n,
      1000000000000n,
      false,
    ],
    [
      644321940463065049614n,
      584400000000000000000000n,
      247318080000000000000000n,
      999999999999999999n,
      1000000000000000n,
      true,
    ],
  ] as const) {
    for (const zeroForOne of [true, false]) {
      it(
        "matches the former late-branch witnesses after half-step seeding: " + exactOut + "/" + zeroForOne,
        async function () {
          const seed = (x > y ? x : y) / 10n ** 18n + 1n;
          const f = await deployNativeQuantumFixture({
            initialSwap: false,
            seedRatio: [seed, seed],
            protocol: 25,
            poolConfig: { aWad: alpha, lambdaWad: lambda },
          });
          await setNativeReserves(f, zeroForOne ? [x, y] : [y, x]);
          const h = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
          const [, iters] = await h[exactOut ? "quoteExactOutForward" : "quoteExactInForward"](
            x,
            y,
            delta,
            alpha,
            lambda
          );
          expect(iters).to.be.gt(0n).and.at.most(40n);
          if (!exactOut) expect(iters).to.be.gt(12n);
          const amount = exactOut ? delta : ((delta - 1n) * 10000n) / 9995n + 1n;
          if (!exactOut) expect(amount - (amount * 5n) / 10000n).to.equal(delta);
          const args = await traceArgs(f, zeroForOne ? 0 : 1);
          const quote = await f.pool[exactOut ? "quoteExactOut" : "quoteExactIn"](zeroForOne, amount);
          const rust = exactOut
            ? (await execExactOutputViaRustTrace({ ...args, amountOut: amount })).amountIn
            : await quoteExactInputViaRustTrace({ ...args, amountIn: amount });
          expect(rust).to.equal(quote);
          const tokenIn = f.tokens[zeroForOne ? 0 : 1],
            tokenOut = f.tokens[zeroForOne ? 1 : 0];
          await tokenIn.mint(f.trader.target, exactOut ? quote : amount);
          const paid = await tokenIn.balanceOf(f.trader.target),
            received = await tokenOut.balanceOf(f.owner.address);
          await time.setNextBlockTimestamp(args.timestamp);
          await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, exactOut ? -amount : amount, 0);
          expect(paid - (await tokenIn.balanceOf(f.trader.target))).to.equal(exactOut ? quote : amount);
          expect((await tokenOut.balanceOf(f.owner.address)) - received).to.equal(exactOut ? amount : quote);
        }
      );
    }
  }

  for (const exactOut of [false, true]) {
    for (const zeroForOne of [false, true]) {
      it(`quotes and settles the formerly exhausted ${exactOut ? "exact-out" : "exact-in"} precision stress case (${zeroForOne ? "0→1" : "1→0"})`, async function () {
        const { f, math, x, y, alpha, lambda } = await deployPrecisionStressFixture(exactOut, zeroForOne);
        const clean = 1000000000000n;
        const amount = exactOut ? clean : 1001001001001n;
        if (!exactOut) expect(amount - amount / 1000n).to.equal(clean);
        // Q128 removes the discontinuity that made these WAD-precision
        // fixtures exhaust forty iterations. They now converge in four.
        const [rawQuote, iters] = await (exactOut
          ? math.quoteExactOutForward(x, y, clean, alpha, lambda)
          : math.quoteExactInForward(x, y, clean, alpha, lambda));
        expect(iters).to.equal(4n);
        expect(rawQuote).to.equal(exactOut ? 683995169141n : 129544480589n);
        // The first LP guard passes: only the existing exact-out fee
        // gross-up and +1 fee bump remain, with no reserve-ratio correction.
        const expected = exactOut ? ((rawQuote - 1n) * 10000n) / 9990n + 2n : rawQuote;
        const args = await traceArgs(f, zeroForOne ? 0 : 1);
        const before = await rollbackSnapshot(f);
        if (exactOut) {
          const rust = await execExactOutputViaRustTrace({ ...args, amountOut: amount });
          expect(rust.amountIn).to.equal(expected);
          expect(rust.step.amountOut).to.equal(amount.toString());
        } else {
          expect(await quoteExactInputViaRustTrace({ ...args, amountIn: amount })).to.equal(expected);
        }
        expect(
          await (exactOut ? f.pool.quoteExactOut(zeroForOne, amount) : f.pool.quoteExactIn(zeroForOne, amount))
        ).to.equal(expected);
        expect(await rollbackSnapshot(f), "quotes must not mutate any tracked state").to.deep.equal(before);
        const input = zeroForOne ? 0 : 1;
        const output = 1 - input;
        const paidBefore = await f.tokens[input].balanceOf(f.trader.target);
        const receivedBefore = await f.tokens[output].balanceOf(f.owner.address);
        await time.setNextBlockTimestamp(args.timestamp);
        await f.trader.executeSwap(args.poolAddress, f.owner.address, zeroForOne, exactOut ? -amount : amount, 0, {
          gasLimit: 2000000n,
        });
        const paid = paidBefore - (await f.tokens[input].balanceOf(f.trader.target));
        const received = (await f.tokens[output].balanceOf(f.owner.address)) - receivedBefore;
        expect(paid).to.equal(exactOut ? expected : amount);
        expect(received).to.equal(exactOut ? amount : expected);
        const reserves = await f.pool.getReserves();
        expect(reserves[input]).to.equal(x + paid);
        expect(reserves[output]).to.equal(y - received);
      });
    }
  }

  it("quotes and settles 18 clean units plus the minimum input fee", async function () {
    const f = await deployNativeQuantumFixture({ initialSwap: false });
    await setNativeReserves(f, [1100000000000000000n, 908695585459600088n]);
    const args = await traceArgs(f, 0);
    expect([args.snapshot.reserve0, args.snapshot.reserve1]).to.deep.equal([1100000000000000000n, 908695585459600088n]);
    expect(await f.pool.quoteExactIn(true, 18n)).to.equal(14n);
    expect(await f.pool.quoteExactIn(true, 19n)).to.equal(15n);
    expect(await quoteExactInputViaRustTrace({ ...args, amountIn: 19n })).to.equal(15n);
    expect(await snapshotPool(f), "quoting must not mutate the pool").to.deep.equal(args.snapshot);
    const paidBefore = await f.tokens[0].balanceOf(f.trader.target);
    const receivedBefore = await f.tokens[1].balanceOf(f.owner.address);
    await time.setNextBlockTimestamp(args.timestamp);
    await (await f.trader.executeSwap(args.poolAddress, f.owner.address, true, 19n, 0)).wait();
    expect(paidBefore - (await f.tokens[0].balanceOf(f.trader.target))).to.equal(19n);
    expect((await f.tokens[1].balanceOf(f.owner.address)) - receivedBefore).to.equal(15n);
    expect(Array.from(await f.pool.getReserves())).to.deep.equal([
      args.snapshot.reserve0 + 19n,
      args.snapshot.reserve1 - 15n,
    ]);
  });

  it("keeps exact-out settlement at 15 while solving for the enlarged output", async function () {
    const f = await deployNativeQuantumFixture({ initialSwap: false });
    await setNativeReserves(f, [1100000000000000000n, 908695585459600088n]);
    const args = await traceArgs(f, 0);
    const rust = await execExactOutputViaRustTrace({ ...args, amountOut: 15n });
    // The trial output is 16; settlement stays 15. Input includes
    // one raw fee unit and the separate, unchanged +1 safety bump.
    expect(await f.pool.quoteExactOut(true, 15n)).to.equal(21n);
    expect(rust.amountIn).to.equal(21n);
    expect(rust.step.amountOut).to.equal("15");
    const paidBefore = await f.tokens[0].balanceOf(f.trader.target);
    const receivedBefore = await f.tokens[1].balanceOf(f.owner.address);
    await time.setNextBlockTimestamp(args.timestamp);
    await (await f.trader.executeSwap(args.poolAddress, f.owner.address, true, -15n, 0)).wait();
    expect(paidBefore - (await f.tokens[0].balanceOf(f.trader.target))).to.equal(21n);
    expect((await f.tokens[1].balanceOf(f.owner.address)) - receivedBefore).to.equal(15n);
    const [r0, r1] = await f.pool.getReserves();
    expect([rust.step.post?.reserve0, rust.step.post?.reserve1]).to.deep.equal([r0.toString(), r1.toString()]);
  });

  for (const decimals of [
    [6, 18],
    [18, 6],
  ] as [number, number][]) {
    it("rejects a mixed-decimal input consumed by the minimum fee: " + decimals, async function () {
      const f = await deployNativeQuantumFixture({ decimals, seedRatio: [2n, 1n], initialSwap: false });
      const input = f.units[0] === 10n ** 6n ? 0 : 1;
      const args = await traceArgs(f, input);
      const before = await rollbackSnapshot(f);
      await expect(f.pool.quoteExactIn(input === 0, 1n)).to.be.revertedWithCustomError(
        f.pool,
        "AmountTooSmallAfterNormalization"
      );
      expect(await rustFailure(quoteExactInputViaRustTrace({ ...args, amountIn: 1n }))).to.include(
        "equilibra_stateful: amount_too_small_after_normalization"
      );
      await time.setNextBlockTimestamp(args.timestamp);
      await expect(
        f.trader.executeSwap(args.poolAddress, f.owner.address, input === 0, 1n, 0)
      ).to.be.revertedWithCustomError(f.pool, "AmountTooSmallAfterNormalization");
      expect(await rollbackSnapshot(f)).to.deep.equal(before);
    });

    it("settles the same corrected payout for two mixed-decimal input units: " + decimals, async function () {
      const f = await deployNativeQuantumFixture({ decimals, seedRatio: [2n, 1n], initialSwap: false });
      const input = f.units[0] === 10n ** 6n ? 0 : 1;
      const output = 1 - input;
      const args = await traceArgs(f, input);
      const expected = await f.pool.quoteExactIn(input === 0, 2n);
      expect(await f.pool.quoteExactIn(input === 0, 2n)).to.equal(expected);
      expect(await quoteExactInputViaRustTrace({ ...args, amountIn: 2n })).to.equal(expected);
      const paidBefore = await f.tokens[input].balanceOf(f.trader.target);
      const receivedBefore = await f.tokens[output].balanceOf(f.owner.address);
      await time.setNextBlockTimestamp(args.timestamp);
      await (await f.trader.executeSwap(args.poolAddress, f.owner.address, input === 0, 2n, 0)).wait();
      expect(paidBefore - (await f.tokens[input].balanceOf(f.trader.target))).to.equal(2n);
      expect((await f.tokens[output].balanceOf(f.owner.address)) - receivedBefore).to.equal(expected);
    });
  }
  for (const zfo of [true, false]) {
    for (const kind of LP_REPAIR_CASES) {
      it("matches the common margin and single LP guard: " + kind + "/" + zfo, async function () {
        const f = await deployLpRepairFixture(kind, zfo);
        const w = f.witness;
        const args = await traceArgs(f, zfo ? 0 : 1);
        const before = await rollbackSnapshot(f);
        const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
        const raw = w.exactOut ? exactOutSettlement(w.raw) : { input: w.amount, fee: 1n, cut: 0n };
        const preDepth = await math.solveLFromState(w.reserveIn, w.reserveOut, w.aWad, w.lambdaWad);
        const rawDepth = await math.solveLFromState(
          w.reserveIn + raw.input - raw.cut,
          w.reserveOut - (w.exactOut ? w.amount : w.raw),
          w.aWad,
          w.lambdaWad
        );
        expect(rawDepth < preDepth, "one strict LP guard").to.equal(w.error === "LpValueDecreased");
        const solidityQuote = () => f.pool[w.exactOut ? "quoteExactOut" : "quoteExactIn"](zfo, w.amount);
        const rustQuote = () =>
          w.exactOut
            ? execExactOutputViaRustTrace({ ...args, amountOut: w.amount })
            : quoteExactInputViaRustTrace({ ...args, amountIn: w.amount });
        if (w.error) {
          const leaf = w.error === "LpValueDecreased" ? "LpValueDecreased" : "amount_too_small_after_normalization";
          expect(await rustFailure(rustQuote())).to.include("equilibra_stateful: " + leaf);
          await expect(solidityQuote()).to.be.revertedWithCustomError(f.pool, w.error);
          await time.setNextBlockTimestamp(args.timestamp);
          await expect(
            f.trader.executeSwap(args.poolAddress, f.owner.address, zfo, w.exactOut ? -w.amount : w.amount, 0)
          ).to.be.revertedWithCustomError(f.pool, w.error);
          expect(await rollbackSnapshot(f)).to.deep.equal(before);
        } else {
          expect(await solidityQuote()).to.equal(w.expected);
          if (w.exactOut) {
            const rust = await execExactOutputViaRustTrace({ ...args, amountOut: w.amount });
            expect(rust.amountIn).to.equal(w.expected);
            expect(rust.step.amountOut).to.equal(w.amount.toString());
            await time.setNextBlockTimestamp(args.timestamp);
            await f.trader.executeSwap(args.poolAddress, f.owner.address, zfo, -w.amount, 0);
            const r = await f.pool.getReserves();
            expect([rust.step.post?.reserve0, rust.step.post?.reserve1]).to.deep.equal(r.map(String));
          } else {
            expect(await quoteExactInputViaRustTrace({ ...args, amountIn: w.amount })).to.equal(w.expected);
            expect(await rollbackSnapshot(f)).to.deep.equal(before);
            const tokenOut = f.tokens[zfo ? 1 : 0];
            const balance = await tokenOut.balanceOf(f.owner.address);
            await time.setNextBlockTimestamp(args.timestamp);
            await f.trader.executeSwap(args.poolAddress, f.owner.address, zfo, w.amount, 0);
            expect((await tokenOut.balanceOf(f.owner.address)) - balance).to.equal(w.expected);
          }
        }
      });
    }
  }
});
