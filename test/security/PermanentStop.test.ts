import hre from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployNativeQuantumFixture } from "../fixtures/nativeQuantum";
import {
  mappingSlot,
  setPackedPoolField,
  setSlot,
  storageSlot,
  TOKEN_CONTRACT,
  POOL_CONTRACT,
} from "../helpers/storageLayout";

async function fixture() {
  const f = await deployNativeQuantumFixture({
    decimals: [6, 18],
    seedRatio: [1000n, 1000n],
    initialSwap: false,
    protocol: 25,
  });
  const initialInput = 100n * f.units[0];
  await f.tokens[0].mint(f.trader.target, initialInput);
  await f.trader.executeSwap(f.pool.target, f.owner.address, true, initialInput, 0);
  const weth = await (await hre.ethers.getContractFactory("MockWETH9")).deploy();
  const router = await (
    await hre.ethers.getContractFactory("EquilibraRouter")
  ).deploy(f.factory.target, f.impl.target, weth.target);
  const provider = await (await hre.ethers.getContractFactory("MockMintCallbackProvider")).deploy();
  return { ...f, router, provider };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function withdrawAndCheck(f: Fixture, shares: bigint, viaRouter: boolean) {
  const poolAddress = await f.pool.getAddress();
  const reserves = Array.from(await f.pool.getReserves());
  const fees = Array.from(await f.pool.getProtocolFees());
  const lp = Array.from(await f.pool.getLpValueState());
  const supply = await f.pool.totalSupply();
  const parked = await f.pool.balanceOf(poolAddress);
  const active = supply - parked;
  const payout = reserves.map((reserve) => (reserve * shares) / active);
  const wallet = await Promise.all(f.tokens.map((token) => token.balanceOf(f.owner.address)));
  const ownerShares = await f.pool.balanceOf(f.owner.address);
  const beforeTimestamps = Array.from(await f.pool.getOracleTimestamps());
  if (viaRouter) {
    await f.pool.approve(f.router.target, shares);
    await f.router.removeLiquidity({
      tokenA: f.tokens[1].target,
      tokenB: f.tokens[0].target,
      poolIndex: 0,
      shares,
      amountAMin: payout[1],
      amountBMin: payout[0],
      recipient: f.owner.address,
      deadline: hre.ethers.MaxUint256,
    });
  } else {
    await expect(f.pool.removeLiquidity(shares, payout[0], payout[1], f.owner.address))
      .to.emit(f.pool, "LiquidityRemoved")
      .withArgs(f.owner.address, f.owner.address, payout[0], payout[1], shares);
  }
  expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves.map((r, i) => r - payout[i]));
  expect(await f.pool.balanceOf(f.owner.address)).to.equal(ownerShares - shares);
  const bufferBurn = (parked * shares) / active;
  expect(await f.pool.balanceOf(poolAddress)).to.equal(parked - bufferBurn);
  expect(await f.pool.totalSupply()).to.equal(supply - shares - bufferBurn);
  expect(Array.from(await f.pool.getProtocolFees())).to.deep.equal(fees);
  expect(Array.from(await f.pool.getLpValueState())).to.deep.equal(lp);
  expect(Array.from(await f.pool.getOracleTimestamps())).to.deep.equal(beforeTimestamps);
  for (let i = 0; i < 2; i++) {
    expect(await f.tokens[i].balanceOf(f.owner.address)).to.equal(wallet[i] + payout[i]);
    expect(await f.tokens[i].balanceOf(poolAddress)).to.equal(reserves[i] - payout[i] + fees[i]);
  }
}

describe("Permanent pool stop", function () {
  it("keeps a temporary pause reversible and rejects an unpaused stop", async () => {
    const f = await loadFixture(fixture);
    const flags = await f.pool.paused();
    expect(Array.from(flags)).to.deep.equal([false, false]);
    expect(flags.paused_).to.equal(false);
    expect(flags.stopped_).to.equal(false);
    expect(f.pool.interface.hasFunction("stopped()")).to.equal(false);
    await expect(f.pool.setPaused(false, true)).to.be.revertedWithCustomError(f.pool, "InvalidPauseState");
    await expect(f.pool.setPaused(true, false))
      .to.emit(f.pool, "PauseStateChanged")
      .withArgs(true, false, f.owner.address);
    await expect(f.pool.setPaused(false, true)).to.be.revertedWithCustomError(f.pool, "InvalidPauseState");
    expect(Array.from(await f.pool.paused())).to.deep.equal([true, false]);
    await expect(f.pool.setPaused(false, false))
      .to.emit(f.pool, "PauseStateChanged")
      .withArgs(false, false, f.owner.address);
    expect(Array.from(await f.pool.paused())).to.deep.equal([false, false]);
  });

  it("is irreversible, including after factory ownership changes", async () => {
    const f = await loadFixture(fixture);
    const [, nextOwner, outsider] = await hre.ethers.getSigners();
    await expect(f.pool.connect(outsider).setPaused(true, true)).to.be.revertedWithCustomError(f.pool, "Unauthorized");
    await expect(f.pool.setPaused(true, true))
      .to.emit(f.pool, "PauseStateChanged")
      .withArgs(true, true, f.owner.address);
    const checkLatch = async (pool: typeof f.pool) => {
      for (const [paused, stopped] of [
        [false, false],
        [true, false],
        [true, true],
      ]) {
        await expect(pool.setPaused(paused, stopped)).not.to.emit(f.pool, "PauseStateChanged");
        expect(Array.from(await f.pool.paused())).to.deep.equal([true, true]);
      }
      await expect(pool.setPaused(false, true)).to.be.revertedWithCustomError(f.pool, "InvalidPauseState");
    };
    await checkLatch(f.pool);
    await f.factory.transferOwnership(nextOwner.address);
    await expect(f.pool.setPaused(false, false)).to.be.revertedWithCustomError(f.pool, "Unauthorized");
    await checkLatch(f.pool.connect(nextOwner));
    await expect(f.pool.connect(outsider).setPaused(true, true)).to.be.revertedWithCustomError(f.pool, "Unauthorized");
  });

  it("blocks both swap modes and new liquidity permanently", async () => {
    const f = await loadFixture(fixture);
    await f.pool.setPaused(true, true);
    for (const amount of [1000n, -1000n]) {
      await expect(f.trader.executeSwap(f.pool.target, f.owner.address, true, amount, 0)).to.be.revertedWithCustomError(
        f.pool,
        "Paused"
      );
    }
    await expect(
      f.provider.addLiquidity(f.pool.target, 1000n, 1000n, 0, f.owner.address)
    ).to.be.revertedWithCustomError(f.pool, "Paused");
  });

  it("withdraws through the pool and router without reanchoring, preserving parked shares and protocol fees", async () => {
    const f = await loadFixture(fixture);
    const ownerShares = await f.pool.balanceOf(f.owner.address);
    await f.pool.transfer(f.pool.target, ownerShares / 10n);
    expect((await f.pool.getProtocolFees()).fee0).to.be.gt(0n);
    await f.pool.setPaused(true, true);
    await withdrawAndCheck(f, (await f.pool.balanceOf(f.owner.address)) / 3n, false);
    await withdrawAndCheck(f, await f.pool.balanceOf(f.owner.address), true);
    expect(await f.pool.balanceOf(f.owner.address)).to.equal(0n);
    await expect(f.pool.collectProtocolFees(f.owner.address)).not.to.be.reverted;
    expect(Array.from(await f.pool.getProtocolFees())).to.deep.equal([0n, 0n]);
  });

  it("bypasses a broken LP-depth calculation only when permanently stopped", async () => {
    const f = await loadFixture(fixture);
    // Synthetic corrupted-anchor witness: this asserts independence of the exit
    // from curve arithmetic, not reachability of this state through valid swaps.
    await setPackedPoolField(await f.pool.getAddress(), "_priceScaleWad", 1n);
    const shares = (await f.pool.balanceOf(f.owner.address)) / 2n;
    await f.pool.setPaused(true, false);
    await expect(f.pool.removeLiquidity(shares, 0, 0, f.owner.address)).to.be.revertedWithCustomError(
      f.pool,
      "MathOutOfRange"
    );
    await f.pool.setPaused(true, true);
    await withdrawAndCheck(f, shares, false);
    await withdrawAndCheck(f, await f.pool.balanceOf(f.owner.address), true);
  });

  it("keeps min-out checks atomic on the emergency path", async () => {
    const f = await loadFixture(fixture);
    await f.pool.setPaused(true, true);
    const shares = (await f.pool.balanceOf(f.owner.address)) / 2n;
    const reserves = Array.from(await f.pool.getReserves());
    const supply = await f.pool.totalSupply();
    const owned = await f.pool.balanceOf(f.owner.address);
    await expect(
      f.pool.removeLiquidity(shares, (reserves[0] * shares) / supply + 1n, 0, f.owner.address)
    ).to.be.revertedWithCustomError(f.pool, "SlippageExceeded");
    expect(await f.pool.balanceOf(f.owner.address)).to.equal(owned);
    expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves);
  });

  it("waives the post-transfer solvency check only for emergency withdrawals", async () => {
    const f = await loadFixture(fixture);
    const address = await f.pool.getAddress();
    const balanceSlot = await storageSlot(TOKEN_CONTRACT, "_balances");
    const balance = await f.tokens[0].balanceOf(address);
    // Emulate a one-unit negative rebase; the owner receives no compensating funds.
    await setSlot(await f.tokens[0].getAddress(), mappingSlot(address, balanceSlot), balance - 1n);
    const owned = await f.pool.balanceOf(f.owner.address);
    const reserves = Array.from(await f.pool.getReserves());
    await f.pool.setPaused(true, false);
    await expect(f.pool.removeLiquidity(owned / 2n, 0, 0, f.owner.address)).to.be.revertedWithCustomError(
      f.pool,
      "MathInvariantViolation"
    );
    expect(await f.pool.balanceOf(f.owner.address)).to.equal(owned);
    expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves);
    expect(await f.tokens[0].balanceOf(address)).to.equal(balance - 1n);
    await f.pool.setPaused(true, true);
    const shares = owned / 2n;
    const payout = (reserves[0] * shares) / (await f.pool.totalSupply());
    const wallet = await f.tokens[0].balanceOf(f.owner.address);
    await f.pool.removeLiquidity(shares, 0, 0, f.owner.address);
    expect(await f.pool.balanceOf(f.owner.address)).to.equal(owned - shares);
    expect(await f.tokens[0].balanceOf(f.owner.address)).to.equal(wallet + payout);
    const [r0] = await f.pool.getReserves();
    const { fee0 } = await f.pool.getProtocolFees();
    expect(await f.tokens[0].balanceOf(address)).to.equal(r0 + fee0 - 1n);
  });

  it("still rolls back failed token transfers after an emergency share burn", async () => {
    const f = await loadFixture(fixture);
    const address = await f.pool.getAddress();
    await setSlot(
      await f.tokens[0].getAddress(),
      mappingSlot(address, await storageSlot(TOKEN_CONTRACT, "_balances")),
      0n
    );
    await f.pool.setPaused(true, true);
    const shares = await f.pool.balanceOf(f.owner.address);
    const reserves = Array.from(await f.pool.getReserves());
    const transferErrors = new hre.ethers.Contract(address, ["error TransferFailed()"], f.owner);
    await expect(f.pool.removeLiquidity(shares, 0, 0, f.owner.address)).to.be.revertedWithCustomError(
      transferErrors,
      "TransferFailed"
    );
    expect(await f.pool.balanceOf(f.owner.address)).to.equal(shares);
    expect(Array.from(await f.pool.getReserves())).to.deep.equal(reserves);
  });

  it("packs the stop latch without moving existing fields", async () => {
    const info = await hre.artifacts.getBuildInfo(POOL_CONTRACT);
    const layout = (info!.output.contracts["contracts/EquilibraPool.sol"].EquilibraPool as any).storageLayout.storage;
    const field = (label: string) => layout.find((entry: any) => entry.label === label);
    expect(field("_stopped").slot).to.equal(field("_token0").slot);
    expect(field("_stopped").slot).to.equal(field("_paused").slot);
    expect(field("_stopped").offset).to.equal(field("_token0").offset + 20);
    expect(field("_token1").slot).to.equal((BigInt(field("_token0").slot) + 1n).toString());
    const f = await loadFixture(fixture);
    const before = [await f.pool.getPoolMetadata(), await f.pool.getFeeConfig(), await f.pool.getCurveParams()];
    const flagsSlot = BigInt(field("_paused").slot);
    const packedBefore = BigInt(await hre.ethers.provider.getStorage(f.pool.target, flagsSlot));
    await f.pool.setPaused(true, true);
    const pausedBit = 1n << (BigInt(field("_paused").offset) * 8n);
    const stoppedBit = 1n << (BigInt(field("_stopped").offset) * 8n);
    expect(BigInt(await hre.ethers.provider.getStorage(f.pool.target, flagsSlot))).to.equal(
      packedBefore | pausedBit | stoppedBit
    );
    expect([await f.pool.getPoolMetadata(), await f.pool.getFeeConfig(), await f.pool.getCurveParams()]).to.deep.equal(
      before
    );
  });
});
