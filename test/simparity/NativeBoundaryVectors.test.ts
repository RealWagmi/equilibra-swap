import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";
import { storageSlot, setSlot, mappingSlot, POOL_CONTRACT, TOKEN_CONTRACT } from "../helpers/storageLayout";

// Literal historical precision vectors, deliberately independent of mutable presets.
const cases: [boolean, boolean, boolean, string, string, string, string][] = JSON.parse(
  readFileSync(path.join(__dirname, "../../simulator/tests/fixtures/equilibra-native-quotes.json"), "utf8")
);
async function fixture() {
  const f = await deployNativeQuantumFixture({
    decimals: [8, 6],
    seedRatio: [1000000n, 500000n],
    initialSwap: false,
    protocol: 5,
    poolConfig: {
      aWad: 990000000000000000n,
      lambdaWad: 1000000000000000n,
      baseFee: 10,
      feeFloorBps: 1,
      feeRampBps: 10000,
      emaPeriod: 600,
      repegShareBps: 0,
      repegStepWad: 500000000000000n,
      repegThresholdToken1UpWad: 100000000000000n,
      repegThresholdToken1DownWad: 100000000000000n,
    },
  });
  for (const token of f.tokens) await token.mint(f.trader.target, 10n ** 30n);
  expect(await f.tokens[0].decimals()).to.equal(8n);
  expect(await f.tokens[1].decimals()).to.equal(6n);
  expect((await f.pool.getOracleState()).priceScaleWad).to.equal(2n * 10n ** 18n);
  return f;
}
async function skewedFixture() {
  const f = await fixture();
  const reserves = [203951604822890n, 25000000000n];
  const pool = await f.pool.getAddress();
  await setSlot(pool, await storageSlot(POOL_CONTRACT, "_reservesPacked"), reserves[0] | (reserves[1] << 128n));
  const balances = await storageSlot(TOKEN_CONTRACT, "_balances");
  for (let i = 0; i < 2; i++) {
    const address = await f.tokens[i].getAddress();
    const delta = reserves[i] - (await f.tokens[i].balanceOf(pool));
    const ownerBalance = await f.tokens[i].balanceOf(f.owner.address);
    await setSlot(address, mappingSlot(pool, balances), reserves[i]);
    await setSlot(address, mappingSlot(f.owner.address, balances), ownerBalance - delta);
  }
  expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves);
  return f;
}
describe("Shared Solidity/Rust native boundary vectors", function () {
  for (const [index, [skew, zeroForOne, exactOut, amountRaw, expectedRaw, r0Raw, r1Raw]] of cases.entries()) {
    it("quotes and settles vector " + index, async function () {
      const f = await loadFixture(skew ? skewedFixture : fixture);
      const amount = BigInt(amountRaw),
        expected = BigInt(expectedRaw);
      const before = Array.from(await f.pool.getReserves());
      const quote = () => f.pool[exactOut ? "quoteExactOut" : "quoteExactIn"](zeroForOne, amount);
      const swap = () =>
        f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, exactOut ? -amount : amount, 0);
      if (expected === 0n) {
        await expect(quote()).to.be.revertedWithCustomError(f.pool, "AmountTooSmallAfterNormalization");
        await expect(swap()).to.be.revertedWithCustomError(f.pool, "AmountTooSmallAfterNormalization");
        expect(Array.from(await f.pool.getReserves())).to.deep.equal(before);
      } else {
        expect(await quote()).to.equal(expected);
        const input = zeroForOne ? 0 : 1,
          output = 1 - input;
        const paid = await f.tokens[input].balanceOf(f.trader.target);
        const received = await f.tokens[output].balanceOf(f.owner.address);
        await swap();
        expect(paid - (await f.tokens[input].balanceOf(f.trader.target))).to.equal(exactOut ? expected : amount);
        expect((await f.tokens[output].balanceOf(f.owner.address)) - received).to.equal(exactOut ? amount : expected);
        expect(Array.from(await f.pool.getReserves())).to.deep.equal([BigInt(r0Raw), BigInt(r1Raw)]);
      }
    });
  }
});
