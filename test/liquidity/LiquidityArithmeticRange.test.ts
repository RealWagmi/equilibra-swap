import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";

const WAD = 10n ** 18n;
const MAX = (1n << 256n) - 1n;
const MAX_RESERVE = (1n << 128n) - 1n;

async function withProvider(f: Awaited<ReturnType<typeof deployNativeQuantumFixture>>) {
  const provider = await (await hre.ethers.getContractFactory("MockMintCallbackProvider")).deploy();
  for (const token of f.tokens) await token.approve(provider.target, MAX);
  return { ...f, provider };
}

async function growPool(targetRaw: bigint) {
  const seedRaw = 10n ** 27n;
  const f = await withProvider(
    await deployNativeQuantumFixture({
      initialSwap: false,
      // Equal raw reserves at 0/18 decimals produce a 1e36 WAD anchor.
      isPrivate: true,
      decimals: [0, 18],
      seedRatio: [seedRaw, seedRaw / WAD],
    })
  );
  for (const token of f.tokens) {
    await token.mint(f.owner.address, targetRaw);
  }
  await f.provider.addLiquidity(f.pool.target, targetRaw - seedRaw, targetRaw - seedRaw, 0, f.owner.address);
  expect(Array.from(await f.pool.getReserves())).to.deep.equal([targetRaw, targetRaw]);
  return f;
}

async function largePayoutFixture() {
  return growPool(10n ** 38n);
}

async function largeBufferFixture() {
  const f = await growPool(10n ** 32n);
  await f.pool.transfer(f.pool.target, (await f.pool.balanceOf(f.owner.address)) / 2n);
  return f;
}

async function equalReservesFixture() {
  return withProvider(await deployNativeQuantumFixture({ initialSwap: false }));
}

async function unequalReservesFixture() {
  return withProvider(await deployNativeQuantumFixture({ initialSwap: false, seedRatio: [1n, 2n] }));
}

async function roundingFixture() {
  return withProvider(await deployNativeQuantumFixture({ initialSwap: false, seedRatio: [2n, 3n] }));
}

async function coarseRoundingFixture() {
  return withProvider(await deployNativeQuantumFixture({ initialSwap: false, decimals: [0, 0], seedRatio: [3n, 5n] }));
}

async function reverseCoarseRoundingFixture() {
  return withProvider(await deployNativeQuantumFixture({ initialSwap: false, decimals: [0, 0], seedRatio: [5n, 3n] }));
}

async function expectDeposit(
  f: Awaited<ReturnType<typeof withProvider>>,
  desired0: bigint,
  desired1: bigint,
  used0: bigint,
  used1: bigint
) {
  const [r0, r1] = await f.pool.getReserves();
  const supply = await f.pool.totalSupply();
  const parked = await f.pool.balanceOf(f.pool.target);
  const active = supply - parked;
  const ownerShares = await f.pool.balanceOf(f.owner.address);
  const shares = (used0 * active) / r0;
  const topUp = (shares * parked) / active;
  // Independent funding inequalities: neither asset may subsidize the minted shares.
  expect(used0).to.be.at.most(desired0);
  expect(used1).to.be.at.most(desired1);
  expect(shares * r0).to.be.at.most(used0 * active);
  expect(shares * r1).to.be.at.most(used1 * active);
  const before0 = await f.tokens[0].balanceOf(f.owner.address);
  const before1 = await f.tokens[1].balanceOf(f.owner.address);
  expect(await f.provider.addLiquidity.staticCall(f.pool.target, desired0, desired1, shares, f.owner.address)).to.equal(
    shares
  );
  await expect(f.provider.addLiquidity(f.pool.target, desired0, desired1, shares, f.owner.address))
    .to.emit(f.pool, "LiquidityAdded")
    .withArgs(f.provider.target, f.owner.address, used0, used1, shares);
  expect(before0 - (await f.tokens[0].balanceOf(f.owner.address))).to.equal(used0);
  expect(before1 - (await f.tokens[1].balanceOf(f.owner.address))).to.equal(used1);
  expect(Array.from(await f.pool.getReserves())).to.deep.equal([r0 + used0, r1 + used1]);
  expect(await f.pool.totalSupply()).to.equal(supply + shares + topUp);
  expect(await f.pool.balanceOf(f.owner.address)).to.equal(ownerShares + shares);
  expect(await f.pool.balanceOf(f.pool.target)).to.equal(parked + topUp);
  expect(await f.tokens[0].balanceOf(f.pool.target)).to.equal(r0 + used0);
  expect(await f.tokens[1].balanceOf(f.pool.target)).to.equal(r1 + used1);
  expect((await f.pool.getLpValueState()).unitValueWad).to.be.gt(0n);
}

describe("Deposit arithmetic range", function () {
  for (const [ratio, fixture] of [
    [1n, equalReservesFixture],
    [2n, unequalReservesFixture],
  ] as const) {
    for (const desired0 of ratio === 1n ? [MAX_RESERVE, MAX] : [MAX_RESERVE]) {
      it(`selects the small token1-limited deposit at ratio 1:${ratio} with a ${desired0 === MAX ? 256 : 128}-bit maximum`, async () => {
        const f = await loadFixture(fixture);
        const [r0, r1] = await f.pool.getReserves();
        if (desired0 === MAX) {
          expect(desired0 * r1).to.be.gt(MAX);
        }
        await expectDeposit(f, desired0, WAD / 100n, WAD / (100n * ratio), WAD / 100n);
      });
    }
  }

  it("rejects a desired maximum whose ratio quotient exceeds uint256", async () => {
    const f = await loadFixture(unequalReservesFixture);
    const [r0, r1] = await f.pool.getReserves();
    expect((MAX * r1) / r0).to.be.gt(MAX);
    const mathErrors = new hre.ethers.Contract(f.pool.target, ["error FullMulDivFailed()"], f.owner);
    await expect(
      f.provider.addLiquidity(f.pool.target, MAX, WAD / 100n, 0, f.owner.address)
    ).to.be.revertedWithCustomError(mathErrors, "FullMulDivFailed");
    expect(Array.from(await f.pool.getReserves())).to.deep.equal([r0, r1]);
  });

  it("accepts a huge token1 maximum without changing the token0-limited deposit", async () => {
    const f = await loadFixture(unequalReservesFixture);
    await expectDeposit(f, WAD / 100n, MAX, WAD / 100n, WAD / 50n);
  });

  it("uses the token1-limited branch when the old floor only appears to fit its maximum", async () => {
    const f = await loadFixture(roundingFixture);
    // ceil(3 * 3 / 2) == 5 > 4: cap token1 at 4 and floor token0 to 2.
    await expectDeposit(f, 3n, 4n, 2n, 4n);
  });

  it("rounds the matching token1 payment up when token0 is limiting", async () => {
    const f = await loadFixture(roundingFixture);
    await expectDeposit(f, 3n, 5n, 3n, 5n);
  });

  for (const parked of [false, true]) {
    for (const [name, fixture, desired0, desired1, used0, used1] of [
      ["3:5 token0-limited", coarseRoundingFixture, 1n, 2n, 1n, 2n],
      ["3:5 token1-limited", coarseRoundingFixture, 2n, 3n, 1n, 3n],
      ["5:3 token0-limited", reverseCoarseRoundingFixture, 2n, 2n, 2n, 2n],
      ["5:3 token1-limited", reverseCoarseRoundingFixture, 3n, 1n, 1n, 1n],
    ] as const) {
      it(`funds both assets at coarse decimals: ${name}, parked=${parked}`, async () => {
        const f = await loadFixture(fixture);
        if (parked) await f.pool.transfer(f.pool.target, (await f.pool.totalSupply()) / 3n);
        await expectDeposit(f, desired0, desired1, used0, used1);
      });
    }
  }

  it("rejects a token1 maximum too small to fund one token0 unit without changing balances", async () => {
    const f = await loadFixture(coarseRoundingFixture);
    const reserves = Array.from(await f.pool.getReserves());
    const supply = await f.pool.totalSupply();
    const balances = await Promise.all(f.tokens.map((t) => t.balanceOf(f.owner.address)));
    await expect(f.provider.addLiquidity(f.pool.target, 1n, 1n, 0, f.owner.address)).to.be.revertedWithCustomError(
      f.pool,
      "AmountTooSmallAfterNormalization"
    );
    expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves);
    expect(await f.pool.totalSupply()).to.equal(supply);
    expect(await Promise.all(f.tokens.map((t) => t.balanceOf(f.owner.address)))).to.deep.equal(balances);
  });

  it("keeps minShares effective when an enormous desired maximum is unused", async () => {
    const f = await loadFixture(unequalReservesFixture);
    const [r0] = await f.pool.getReserves();
    const shares = ((WAD / 200n) * (await f.pool.totalSupply())) / r0;
    await expect(
      f.provider.addLiquidity(f.pool.target, MAX_RESERVE, WAD / 100n, shares + 1n, f.owner.address)
    ).to.be.revertedWithCustomError(f.pool, "SlippageExceeded");
  });

  it("does not silently truncate an oversized deposit to remaining reserve capacity", async () => {
    const f = await loadFixture(largePayoutFixture);
    const [r0, r1] = await f.pool.getReserves();
    for (const desired of [MAX_RESERVE - r0 + 1n, MAX_RESERVE]) {
      await expect(
        f.provider.addLiquidity(f.pool.target, desired, desired, 0, f.owner.address)
      ).to.be.revertedWithCustomError(f.pool, "MathInvariantViolation");
      expect(Array.from(await f.pool.getReserves())).to.deep.equal([r0, r1]);
    }
    const amount = MAX_RESERVE - r0;
    for (const token of f.tokens) await token.mint(f.owner.address, amount);
    await expectDeposit(f, amount, amount, amount, amount);
    expect(Array.from(await f.pool.getReserves())).to.deep.equal([MAX_RESERVE, MAX_RESERVE]);
  });

  it("mints shares when the deposit-times-active-supply product exceeds uint256", async () => {
    const f = await loadFixture(largePayoutFixture);
    const amount = 10n ** 31n;
    const [reserve] = await f.pool.getReserves();
    const active = await f.pool.totalSupply();
    expect(amount * active).to.be.gt(MAX);
    expect((amount * active) / reserve).to.be.at.most(MAX);
    for (const token of f.tokens) await token.mint(f.owner.address, amount);
    await expectDeposit(f, amount, amount, amount, amount);
  });

  it("scales parked shares when the buffer product exceeds uint256", async () => {
    const f = await loadFixture(largeBufferFixture);
    const amount = 10n ** 29n;
    const [reserve] = await f.pool.getReserves();
    const parked = await f.pool.balanceOf(f.pool.target);
    const active = (await f.pool.totalSupply()) - parked;
    const shares = (amount * active) / reserve;
    expect(amount * active).to.be.at.most(MAX);
    expect(shares * parked).to.be.gt(MAX);
    expect((shares * parked) / active).to.be.at.most(MAX);
    for (const token of f.tokens) await token.mint(f.owner.address, amount);
    await expectDeposit(f, amount, amount, amount, amount);
  });
});

describe("Withdrawal arithmetic range", function () {
  for (const [name, fixture, stopped] of [
    ["reserve-times-shares product", largePayoutFixture, false],
    ["parked-times-shares product", largeBufferFixture, false],
    ["reserve-times-shares product", largePayoutFixture, true],
    ["parked-times-shares product", largeBufferFixture, true],
  ] as const) {
    it(`${stopped ? "emergency" : "normal"} exit redeems the full position despite an overflowing ${name}`, async () => {
      const f = await loadFixture(fixture);
      if (stopped) await f.pool.setPaused(true, true);
      const [r0, r1] = await f.pool.getReserves();
      const supply = await f.pool.totalSupply();
      const parked = await f.pool.balanceOf(f.pool.target);
      const active = supply - parked;
      const shares = await f.pool.balanceOf(f.owner.address);
      const expected0 = (r0 * shares) / active;
      const expected1 = (r1 * shares) / active;
      const bufferBurn = (parked * shares) / active;
      expect(supply).to.be.gt((1n << 128n) - 1n);
      if (parked === 0n) {
        expect(r0 * shares).to.be.gt(MAX);
        expect(r1 * shares).to.be.gt(MAX);
      } else {
        expect(r0 * shares).to.be.at.most(MAX);
        expect(r1 * shares).to.be.at.most(MAX);
        expect(parked * shares).to.be.gt(MAX);
      }
      expect(
        Array.from(await f.pool.removeLiquidity.staticCall(shares, expected0, expected1, f.owner.address))
      ).to.deep.equal([expected0, expected1]);
      const before0 = await f.tokens[0].balanceOf(f.owner.address);
      const before1 = await f.tokens[1].balanceOf(f.owner.address);
      await expect(f.pool.removeLiquidity(shares, expected0, expected1, f.owner.address))
        .to.emit(f.pool, "LiquidityRemoved")
        .withArgs(f.owner.address, f.owner.address, expected0, expected1, shares);
      expect((await f.tokens[0].balanceOf(f.owner.address)) - before0).to.equal(expected0);
      expect((await f.tokens[1].balanceOf(f.owner.address)) - before1).to.equal(expected1);
      expect(Array.from(await f.pool.getReserves())).to.deep.equal([r0 - expected0, r1 - expected1]);
      expect(await f.pool.balanceOf(f.owner.address)).to.equal(0n);
      expect(await f.pool.balanceOf(f.pool.target)).to.equal(parked - bufferBurn);
      expect(await f.pool.totalSupply()).to.equal(supply - shares - bufferBurn);
      expect((await f.pool.getLpValueState()).unitValueWad).to.be.gt(0n);
      expect(await f.tokens[0].balanceOf(f.pool.target)).to.equal(r0 - expected0);
      expect(await f.tokens[1].balanceOf(f.pool.target)).to.equal(r1 - expected1);
    });
  }
});
