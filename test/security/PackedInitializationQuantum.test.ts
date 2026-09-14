import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";
import { deployNativeQuantumFixture, setNativeReserves } from "../fixtures/nativeQuantum";
import { storageSlot, POOL_CONTRACT } from "../helpers/storageLayout";

const WAD = 10n ** 18n;
const SEED = 500000n;

async function fixture(protocol: number, share: number, decimals = [18, 6], aWad = 990000000000000000n) {
  const [owner, recipient] = await hre.ethers.getSigners();
  const impl = await (await hre.ethers.getContractFactory("MockEquilibraPool")).deploy();
  await impl.waitForDeployment();
  const factory = await (
    await hre.ethers.getContractFactory("EquilibraFactory")
  ).deploy(await impl.getAddress(), owner.address, owner.address, protocol);
  await factory.waitForDeployment();
  const trader = await (await hre.ethers.getContractFactory("MockSwapCallbackTrader")).deploy();
  await trader.waitForDeployment();
  const tokenFactory = await hre.ethers.getContractFactory("MockERC20");
  const tokens: Array<{ token: any; address: string; decimals: number; unit: bigint }> = [];
  for (const d of decimals) {
    const token = await tokenFactory.deploy(`Token${d}`, `T${d}`, d);
    await token.waitForDeployment();
    const unit = 10n ** BigInt(d);
    await token.mint(owner.address, SEED * 4n * unit);
    await token.mint(await trader.getAddress(), SEED * 4n * unit);
    await token.approve(await factory.getAddress(), MaxUint256);
    tokens.push({ token, address: await token.getAddress(), decimals: d, unit });
  }
  tokens.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const config = {
    aWad,
    lambdaWad: 1000000000000000n,
    baseFee: 10,
    feeFloorBps: 1,
    feeRampBps: 10000,
    emaPeriod: 601,
    repegShareBps: share,
    repegStepWad: 500000000000000n,
    repegThresholdToken1UpWad: 100000000000000n,
    repegThresholdToken1DownWad: 50000000000000n,
  };
  const tx = await factory.createPoolAndAddLiquidity(
    tokens[0].address,
    tokens[1].address,
    config,
    SEED * tokens[0].unit,
    SEED * tokens[1].unit,
    owner.address
  );
  const receipt = await tx.wait();
  const block = await hre.ethers.provider.getBlock(receipt!.blockNumber);
  const pool = await hre.ethers.getContractAt("MockEquilibraPool", await factory.allPools(0));
  return { owner, recipient, factory, pool, trader, tokens, config, timestamp: BigInt(block!.timestamp) };
}

async function snapshot(pool: any) {
  return {
    reserves: Array.from(await pool.getReserves()),
    lp: Array.from(await pool.getLpValueState()),
    fees: Array.from(await pool.getProtocolFees()),
    oracle: Array.from(await pool.getOracleState()),
    timestamps: Array.from(await pool.getOracleTimestamps()),
    supply: await pool.totalSupply(),
    entered: await pool.reentrancyGuardEntered(),
  };
}

describe("Packed initialization, common margin and single LP guard", function () {
  for (const zeroForOne of [true, false]) {
    it(`preserves exact-out native reserve and uint128 boundaries (${zeroForOne})`, async () => {
      const f = await deployNativeQuantumFixture({ initialSwap: false });
      const before = await snapshot(f.pool);
      const reserveOut = before.reserves[zeroForOne ? 1 : 0] as bigint;
      for (const amount of [reserveOut, reserveOut + 1n]) {
        await expect(f.pool.quoteExactOut(zeroForOne, amount)).to.be.revertedWithCustomError(
          f.pool,
          "InsufficientLiquidity"
        );
        await expect(
          f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, -amount, 0)
        ).to.be.revertedWithCustomError(f.pool, "InsufficientLiquidity");
      }
      const tooLarge = 1n << 128n;
      expect(await f.pool.quoteExactOut(zeroForOne, tooLarge)).to.equal(0n);
      await expect(
        f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, -tooLarge, 0)
      ).to.be.revertedWithCustomError(f.pool, "InvalidAmountSpecified");
      expect(await snapshot(f.pool)).to.deep.equal(before);
    });
  }

  it("preserves nonzero pair indices and packed native scales across pools on one pair", async function () {
    const { owner, factory, pool, tokens, config } = await fixture(5, 5500);
    const addresses = [await pool.getAddress()];
    for (let index = 1; index <= 2; index++) {
      await factory.createPoolAndAddLiquidity(
        tokens[0].address,
        tokens[1].address,
        config,
        SEED * tokens[0].unit,
        SEED * tokens[1].unit,
        owner.address
      );
      addresses.push(await factory.allPools(index));
    }
    for (let index = 0; index < addresses.length; index++) {
      const item = await hre.ethers.getContractAt("EquilibraPool", addresses[index]);
      expect((await item.getPoolMetadata()).pairPoolIndex).to.equal(BigInt(index));
      // Pin the unchanged storage layout as well as the public metadata:
      // slot 5 holds scales [0:64]/[64:128], index [128:160], K [160:168]
      // and ramp distance [168:232]. Initialization must not erase neighbors.
      const [packed] = await item.getStorageSlots([await storageSlot(POOL_CONTRACT, "_token0Scale")]);
      const bits = BigInt(packed);
      const mask64 = (1n << 64n) - 1n;
      expect(bits & mask64).to.equal(WAD / tokens[0].unit);
      expect((bits >> 64n) & mask64).to.equal(WAD / tokens[1].unit);
      expect((bits >> 128n) & ((1n << 32n) - 1n)).to.equal(BigInt(index));
      expect((bits >> 160n) & 255n).to.equal(30n);
      expect((bits >> 168n) & mask64).to.equal(BigInt(config.feeRampBps) * 10n ** 14n);
    }
    expect(await factory.getPoolCountForPair(tokens[0].address, tokens[1].address)).to.equal(3n);
  });

  it("applies the one-math-unit margin before checking native settlement", async function () {
    const f = await deployNativeQuantumFixture({ initialSwap: false });
    await setNativeReserves(f, [1100000000000000000n, 908695585459600088n]);
    const { owner, trader, pool, tokens } = f;
    const poolAddress = await pool.getAddress();
    expect(Array.from(await pool.getReserves()).slice(0, 2)).to.deep.equal([1100000000000000000n, 908695585459600088n]);
    // The minimum fee consumes one raw input unit. The common output
    // margin remains a separate one-math-unit deduction.
    expect(await pool.quoteExactIn(true, 18n)).to.equal(14n);
    const before = await snapshot(pool);
    const paidBefore = await tokens[0].balanceOf(trader.target);
    const receivedBefore = await tokens[1].balanceOf(owner.address);
    expect(await pool.quoteExactIn(true, 19n)).to.equal(15n);
    expect(await snapshot(pool), "quoting must not write state").to.deep.equal(before);
    await trader.executeSwap(poolAddress, owner.address, true, 19n, 0);
    expect(paidBefore - (await tokens[0].balanceOf(trader.target))).to.equal(19n);
    expect((await tokens[1].balanceOf(owner.address)) - receivedBefore).to.equal(15n);
    expect(Array.from(await pool.getReserves()).slice(0, 2)).to.deep.equal([1100000000000000019n, 908695585459600073n]);
    expect(Array.from(await pool.getProtocolFees())).to.deep.equal(before.fees);
    const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
    expect(
      Array.from(await math.quoteExactInForward(1100000000000000000n, 908695585459600088n, 18n, WAD / 10n, 10n ** 15n))
    ).to.deep.equal([15n, 2n]);
    const depth = await math.solveLFromState(1100000000000000000n, 908695585459600088n, WAD / 10n, 10n ** 15n);
    expect(await math.solveLFromState(1100000000000000018n, 908695585459600072n, WAD / 10n, 10n ** 15n)).to.be.lt(
      depth
    );
    expect(await math.solveLFromState(1100000000000000018n, 908695585459600073n, WAD / 10n, 10n ** 15n)).to.be.gte(
      depth
    );
  });

  for (const decimals of [
    [6, 18],
    [18, 6],
  ] as [number, number][]) {
    it(`rejects fee-only input and settles two units without a reserve-ratio deduction: ${decimals}`, async function () {
      const { owner, trader, pool, tokens, units } = await deployNativeQuantumFixture({
        decimals,
        seedRatio: [2n, 1n],
        initialSwap: false,
      });
      const input = units[0] === 10n ** 6n ? 0 : 1;
      const output = 1 - input;
      const zeroForOne = input === 0;
      const poolAddress = await pool.getAddress();
      const before = await snapshot(pool);
      const ownerLp = await pool.balanceOf(owner.address);
      const tokenBalances = await Promise.all(tokens.map((token) => token.balanceOf(poolAddress)));
      const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
      const curve = await pool.getCurveParams();
      const scale = (await pool.getOracleState()).priceScaleWad;
      const reserves = await pool.getReserves();
      const x = (reserves[1] * WAD) / units[1];
      const y = (((reserves[0] * WAD) / units[0]) * WAD) / scale;
      const nativeExpected = async (amount: bigint) => {
        const dx = ((amount - 1n) * WAD) / units[input];
        const [out] = zeroForOne
          ? await math.quoteExactInForward(y, x, (dx * WAD) / scale, curve.aWad, curve.lambdaWad)
          : await math.quoteExactInForward(x, y, dx, curve.aWad, curve.lambdaWad);
        return ((zeroForOne ? out : (out * scale) / WAD) * units[output]) / WAD;
      };
      await expect(pool.quoteExactIn(zeroForOne, 1n)).to.be.revertedWithCustomError(
        pool,
        "AmountTooSmallAfterNormalization"
      );
      expect(await snapshot(pool)).to.deep.equal(before);
      expect(await pool.balanceOf(owner.address)).to.equal(ownerLp);
      expect(await Promise.all(tokens.map((token) => token.balanceOf(poolAddress)))).to.deep.equal(tokenBalances);
      const expected = await nativeExpected(2n);
      expect(await pool.quoteExactIn(zeroForOne, 2n)).to.equal(expected);
      const paidBefore = await tokens[input].balanceOf(trader.target);
      const receivedBefore = await tokens[output].balanceOf(owner.address);
      await trader.executeSwap(poolAddress, owner.address, zeroForOne, 2n, 0);
      expect(paidBefore - (await tokens[input].balanceOf(trader.target))).to.equal(2n);
      expect((await tokens[output].balanceOf(owner.address)) - receivedBefore).to.equal(expected);
      expect(Array.from(await pool.getProtocolFees())).to.deep.equal(before.fees);
    });
  }

  for (const zeroForOne of [true, false]) {
    it("does not trim a valid payout after a nonzero fee and protocol cut: " + zeroForOne, async function () {
      const f = await deployNativeQuantumFixture({ protocol: 25, initialSwap: false });
      const input = zeroForOne ? 0 : 1,
        output = 1 - input;
      const amount = 100000n,
        fee = 50n,
        cut = 12n;
      const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
      const [raw] = await math.quoteExactInForward(WAD, WAD, amount - fee, WAD / 10n, 10n ** 15n);
      const quote = await f.pool.quoteExactIn(zeroForOne, amount);
      expect(quote).to.equal(raw);
      const paid = await f.tokens[input].balanceOf(f.trader.target);
      const received = await f.tokens[output].balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, amount, 0);
      expect(paid - (await f.tokens[input].balanceOf(f.trader.target))).to.equal(amount);
      expect((await f.tokens[output].balanceOf(f.owner.address)) - received).to.equal(quote);
      const reserves = await f.pool.getReserves();
      expect(reserves[input]).to.equal(WAD + amount - cut);
      expect(reserves[output]).to.equal(WAD - quote);
      const protocol = await f.pool.getProtocolFees();
      expect(protocol[input]).to.equal(cut);
      expect(protocol[output]).to.equal(0n);
    });

    it("applies the one-math-unit minimum exactly once: " + zeroForOne, async function () {
      const f = await deployNativeQuantumFixture({ initialSwap: false });
      const math = await (await hre.ethers.getContractFactory("SwapMathHarness")).deploy();
      // At equal reserves the math quote already includes the one-unit margin.
      expect(await f.pool.quoteExactIn(zeroForOne, 3n)).to.equal(1n);
      const [raw] = await math.quoteExactInForward(WAD, WAD, 3n, WAD / 10n, 10n ** 15n);
      expect(raw).to.equal(2n);
      expect(await f.pool.quoteExactIn(zeroForOne, 4n)).to.equal(2n);
      const output = zeroForOne ? 1 : 0;
      const received = await f.tokens[output].balanceOf(f.owner.address);
      await f.trader.executeSwap(f.pool.target, f.owner.address, zeroForOne, 4n, 0);
      expect((await f.tokens[output].balanceOf(f.owner.address)) - received).to.equal(2n);
    });
  }

  for (const protocol of [0, 5, 25]) {
    for (const share of [0, 5500, 10000 - protocol * 100]) {
      it(`round-trips public config and native scales: protocol ${protocol}%, share ${share} bps`, async function () {
        const f = await fixture(protocol, share);
        const { pool, factory, config, tokens } = f;
        const fee = await pool.getFeeConfig();
        for (const key of [
          "baseFee",
          "feeFloorBps",
          "feeRampBps",
          "emaPeriod",
          "repegShareBps",
          "repegStepWad",
          "repegThresholdToken1UpWad",
          "repegThresholdToken1DownWad",
        ] as const) {
          expect(fee[key], key).to.equal(BigInt(config[key]));
        }
        expect(fee.protocolFeePercent).to.equal(BigInt(protocol));
        expect(fee.parachuteBandMult).to.equal(30n);
        const curve = await pool.getCurveParams();
        expect(curve.aWad).to.equal(config.aWad);
        expect(curve.lambdaWad).to.equal(config.lambdaWad);
        const meta = await pool.getPoolMetadata();
        expect(meta.factory).to.equal(await factory.getAddress());
        expect(meta.token0).to.equal(tokens[0].address);
        expect(meta.token1).to.equal(tokens[1].address);
        expect(meta.pairPoolIndex).to.equal(0n);
        expect(Array.from(await pool.getOracleTimestamps())).to.deep.equal([f.timestamp, f.timestamp]);
        expect((await pool.getOracleState()).priceScaleWad).to.equal(WAD);
        expect(Array.from(await pool.paused())).to.deep.equal([false, false]);
        expect(await pool.balanceOf(f.owner.address)).to.be.greaterThan(0n);
        await expect(
          pool.initialize({
            token0: tokens[0].address,
            token1: tokens[1].address,
            feeConfigBits: 0n,
            scaleRampConfig: 0n,
            curveConfig: 0n,
            repegConfig: 0n,
            isPrivate: false,
            lpName: "duplicate",
            lpSymbol: "DUP",
          })
        ).to.be.revertedWithCustomError(pool, "AlreadyInitialized");

        // Both directions and both quote paths exercise the packed decimal
        // lifts. Reuse the pre-swap anchor when measuring pre-repeg depth.
        for (const zeroForOne of [true, false]) {
          for (const exactOut of [false, true]) {
            const input = zeroForOne ? 0 : 1;
            const output = 1 - input;
            const amount = tokens[exactOut ? output : input].unit;
            const quote = await pool[exactOut ? "quoteExactOut" : "quoteExactIn"](zeroForOne, amount);
            const reservesBefore = await pool.getReserves();
            const scale = (await pool.getOracleState()).priceScaleWad;
            const depth = async (r: any) =>
              pool.exposed_solveLFromState(
                (r[1] * WAD) / tokens[1].unit,
                (((r[0] * WAD) / tokens[0].unit) * WAD) / scale,
                config.aWad,
                config.lambdaWad
              );
            const lBefore = await depth(reservesBefore);
            const paidBefore = await tokens[input].token.balanceOf(await f.trader.getAddress());
            const receivedBefore = await tokens[output].token.balanceOf(f.recipient.address);
            await f.trader.executeSwap(
              await pool.getAddress(),
              f.recipient.address,
              zeroForOne,
              exactOut ? -amount : amount,
              0
            );
            const paid = paidBefore - (await tokens[input].token.balanceOf(await f.trader.getAddress()));
            const received = (await tokens[output].token.balanceOf(f.recipient.address)) - receivedBefore;
            expect(exactOut ? paid : received, "quote == executed amount").to.equal(quote);
            expect(
              await depth(await pool.getReserves()),
              "fees retained, protocol excluded, before repeg"
            ).to.be.at.least(lBefore);
          }
        }
      });
    }
  }

  it("executes exact-in and exact-out in both directions at A_MAX_WAD = WAD - 1", async function () {
    const f = await fixture(5, 0, [18, 6], WAD - 1n);
    expect((await f.pool.getCurveParams()).aWad).to.equal(WAD - 1n);
    for (const zeroForOne of [true, false]) {
      for (const exactOut of [false, true]) {
        const input = zeroForOne ? 0 : 1;
        const output = 1 - input;
        const amount = 100n * f.tokens[exactOut ? output : input].unit;
        const quote = await f.pool[exactOut ? "quoteExactOut" : "quoteExactIn"](zeroForOne, amount);
        expect(quote).to.be.greaterThan(0n);
        const before = await snapshot(f.pool);
        const balanceIn = await f.tokens[input].token.balanceOf(await f.trader.getAddress());
        const balanceOut = await f.tokens[output].token.balanceOf(f.recipient.address);
        await f.trader.executeSwap(
          await f.pool.getAddress(),
          f.recipient.address,
          zeroForOne,
          exactOut ? -amount : amount,
          0
        );
        const paid = balanceIn - (await f.tokens[input].token.balanceOf(await f.trader.getAddress()));
        const received = (await f.tokens[output].token.balanceOf(f.recipient.address)) - balanceOut;
        expect(exactOut ? paid : received).to.equal(quote);
        expect(exactOut ? received : paid).to.equal(amount);
        const lp = await f.pool.getLpValueState();
        expect(lp.unitValueWad).to.be.at.least(before.lp[0]);
      }
    }
  });

  it("does not restore the removed LP-depth rejection inside reserve accrual", async function () {
    const { pool, tokens } = await fixture(25, 5500);
    const before = await snapshot(pool);
    const r0 = SEED * tokens[0].unit;
    const r1 = SEED * tokens[1].unit;
    // State-constructed accounting probe, not a normal swap: lower depth
    // must neither reject nor accrue fictitious positive LP growth.
    await pool.exposed_setReservesAndAccrueLpValueGrowth(r0 - tokens[0].unit, r1 - tokens[1].unit);
    expect(Array.from(await pool.getReserves())).to.deep.equal([r0 - tokens[0].unit, r1 - tokens[1].unit]);
    expect(Array.from(await pool.getLpValueState())).to.deep.equal(before.lp);
    expect(Array.from(await pool.getProtocolFees())).to.deep.equal(before.fees);
    await pool.exposed_setReservesAndAccrueLpValueGrowth(r0, r1);
    expect(await snapshot(pool)).to.deep.equal(before);
  });

  for (const alpha of [WAD / 10n, WAD - 1n]) {
    it(`checks one-wei exact-out quote and settlement at alpha ${alpha}`, async function () {
      const { pool, trader, recipient, tokens } = await fixture(0, 0, [18, 18], alpha);
      await pool.exposed_setReservesAndAccrueLpValueGrowth(10000000n * WAD, 500000n * WAD);
      const before = await snapshot(pool);
      if (alpha === WAD / 10n) {
        await expect(pool.quoteExactOut(false, 1n)).to.be.revertedWithCustomError(
          pool,
          "AmountTooSmallAfterNormalization"
        );
        await expect(
          trader.executeSwap(await pool.getAddress(), recipient.address, false, -1n, 0)
        ).to.be.revertedWithCustomError(pool, "AmountTooSmallAfterNormalization");
        expect(await snapshot(pool)).to.deep.equal(before);
      } else {
        const quote = await pool.quoteExactOut(false, 1n);
        expect(quote).to.equal(3n);
        expect(await snapshot(pool)).to.deep.equal(before);
        const paid = await tokens[1].token.balanceOf(trader.target);
        const received = await tokens[0].token.balanceOf(recipient.address);
        const depth = await pool.exposed_solveLFromState(
          500000n * WAD,
          10000000n * WAD,
          alpha,
          (await pool.getCurveParams()).lambdaWad
        );
        await trader.executeSwap(pool.target, recipient.address, false, -1n, 0);
        expect(paid - (await tokens[1].token.balanceOf(trader.target))).to.equal(quote);
        expect((await tokens[0].token.balanceOf(recipient.address)) - received).to.equal(1n);
        const after = await pool.getReserves();
        expect(
          await pool.exposed_solveLFromState(after[1], after[0], alpha, (await pool.getCurveParams()).lambdaWad)
        ).to.be.at.least(depth);
      }
    });
  }
});
