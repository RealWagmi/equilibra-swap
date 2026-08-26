import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

type FixtureResult = {
  token0: any;
  token1: any;
  factory: any;
  poolImpl: any;
  pool: any;
  router: any;
  owner: Awaited<ReturnType<typeof hre.ethers.getSigners>>[0];
  traderA: Awaited<ReturnType<typeof hre.ethers.getSigners>>[1];
  traderB: Awaited<ReturnType<typeof hre.ethers.getSigners>>[2];
};

const ONE_MILLION = hre.ethers.parseEther("1000000");

// Canonical `PoolConfig` shape — depth-at-anchor `aWad` and
// plateau-width `lambdaWad` replace the legacy single-knob `alpha`.
function poolConfig(overrides: Record<string, unknown> = {}) {
  return {
    aWad: PRESET.aWad,
    lambdaWad: PRESET.lambdaWad,
    baseFee: 30,
    emaPeriod: 3600,
    repegStepWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
    feeRampBps: 0,
    feeFloorBps: 20,
    repegShareBps: 5000,
    ...overrides,
  };
}

describe("ArbitrageMath", function () {
  async function deployFixture(): Promise<FixtureResult> {
    const [owner, traderA, traderB] = await hre.ethers.getSigners();

    const Token = await hre.ethers.getContractFactory("MockERC20");
    const tokenA: any = await Token.deploy("Token0", "TK0", 18);
    const tokenB: any = await Token.deploy("Token1", "TK1", 18);
    await tokenA.waitForDeployment();
    await tokenB.waitForDeployment();

    // Canonicalise the test's `token0`/`token1` aliases to the same lex
    // order the factory uses for storage. Without this, the pool's
    // recorded `getPoolMetadata().token0` may not equal our test-side
    // `token0` whenever the EVM-assigned address ordering flips, which
    // breaks every assertion that mixes `getReserves()[0]` with the
    // test-side `token0`/`token1` references (manifests as a swap that
    // looks like it ran in the opposite direction).
    const aAddr = await tokenA.getAddress();
    const bAddr = await tokenB.getAddress();
    const [token0, token1] = aAddr.toLowerCase() < bAddr.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

    const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
    const poolImpl = await PoolImpl.deploy();
    await poolImpl.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
    const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
    await factory.waitForDeployment();

    const factoryAddr = await factory.getAddress();

    // Seed owner balances first so the factory can pull genesis liquidity.
    await token0.mint(owner.address, ONE_MILLION * 2n);
    await token1.mint(owner.address, ONE_MILLION * 2n);
    await token0.mint(traderA.address, ONE_MILLION);
    await token1.mint(traderA.address, ONE_MILLION);
    await token0.mint(traderB.address, ONE_MILLION);
    await token1.mint(traderB.address, ONE_MILLION);

    await token0.approve(factoryAddr, MaxUint256);
    await token1.approve(factoryAddr, MaxUint256);

    await factory.createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      poolConfig(),
      ONE_MILLION,
      ONE_MILLION,
      owner.address
    );

    const poolAddress = await factory.allPools(0);
    const pool: any = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
    const Weth = await hre.ethers.getContractFactory("MockWETH9");
    const weth: any = await Weth.deploy();
    await weth.waitForDeployment();
    const Router = await hre.ethers.getContractFactory("EquilibraRouter");
    const router: any = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
    await router.waitForDeployment();

    await token0.connect(traderA).approve(await router.getAddress(), MaxUint256);
    await token1.connect(traderA).approve(await router.getAddress(), MaxUint256);
    await token0.connect(traderB).approve(await router.getAddress(), MaxUint256);
    await token1.connect(traderB).approve(await router.getAddress(), MaxUint256);

    return {
      token0,
      token1,
      factory,
      poolImpl,
      pool,
      router,
      owner,
      traderA,
      traderB,
    };
  }

  it("accrues LP fees into reserves while keeping protocol fees segregated", async function () {
    const { pool, router, token0, token1, traderA } = await loadFixture(deployFixture);

    const amountIn = hre.ethers.parseEther("1000");
    const outQuote = await pool.quoteExactIn(true, amountIn);
    expect(outQuote).to.be.gt(0n);

    const [reserve0Before, reserve1Before] = await pool.getReserves();
    const [protocol0Before] = await pool.getProtocolFees();
    const balanceOutBefore = await token1.balanceOf(traderA.address);

    const deadline = (await time.latest()) + 3600;
    const t0Addr = await token0.getAddress();
    const t1Addr = await token1.getAddress();
    await router.connect(traderA).exactInputSingle({
      tokenIn: t0Addr,
      tokenOut: t1Addr,
      poolIndex: 0,
      recipient: traderA.address,
      amountIn,
      amountOutMinimum: 0,
      deadline,
    });

    const [reserve0After, reserve1After] = await pool.getReserves();
    const [protocol0After] = await pool.getProtocolFees();
    const balanceOutAfter = await token1.balanceOf(traderA.address);

    // Fee accounting: `feeRampBps == 0` ⇒ smoothstep dynamic ramp
    // is disabled and every swap pays exactly `baseFee`. The LP slice
    // accrues into reserves; the protocol slice is segregated into the
    // `protocolFees` bucket. The router does not change either rule.
    const fee = await pool.getFeeConfig();
    const baseFee = BigInt(fee.baseFee);
    const protocolFeePercent = BigInt(fee.protocolFeePercent);
    const feeAmount = (amountIn * baseFee) / 10_000n;
    const cleanIn = amountIn - feeAmount;
    const protocolCut = (feeAmount * protocolFeePercent) / 100n;
    const lpCut = feeAmount - protocolCut;

    expect(reserve0After).to.equal(reserve0Before + cleanIn + lpCut);
    expect(reserve1After).to.be.lt(reserve1Before);
    expect(protocol0After).to.equal(protocol0Before + protocolCut);
    expect(balanceOutAfter - balanceOutBefore).to.equal(outQuote);

    const amountOut = hre.ethers.parseEther("250");
    const amountInQuote = await pool.quoteExactOut(true, amountOut);
    const balanceInBefore = await token0.balanceOf(traderA.address);

    await router.connect(traderA).exactOutputSingle({
      tokenIn: t0Addr,
      tokenOut: t1Addr,
      poolIndex: 0,
      recipient: traderA.address,
      amountOut,
      amountInMaximum: amountInQuote,
      deadline: deadline + 1,
    });

    const balanceInAfter = await token0.balanceOf(traderA.address);
    const actualSpend = balanceInBefore - balanceInAfter;
    // ExactOut contract: quoter overcharges by ≤ a few wei (the safety
    // bump in `quoteExactOut`), but the swap path only pulls what the
    // kernel actually requires for `amountOut`. Therefore
    //   actualSpend ≤ amountInQuote   (router enforces amountInMaximum)
    //   actualSpend ≥ amountInQuote − overQuoteCap   (cap matches the
    //                                                  quoter sweep)
    const overQuoteCap = amountOut / 10_000_000_000_000n + 2_048n;
    expect(actualSpend).to.be.lte(amountInQuote);
    expect(actualSpend).to.be.gte(amountInQuote - overQuoteCap);
  });

  it("keeps exact-in and exact-out quotes mutually conservative", async function () {
    const { pool } = await loadFixture(deployFixture);

    const sampleIns = [
      hre.ethers.parseEther("1"),
      hre.ethers.parseEther("10"),
      hre.ethers.parseEther("1000"),
      hre.ethers.parseEther("50000"),
    ];
    const sampleOuts = [
      hre.ethers.parseEther("1"),
      hre.ethers.parseEther("10"),
      hre.ethers.parseEther("1000"),
      hre.ethers.parseEther("50000"),
    ];

    for (const zeroForOne of [true, false]) {
      for (const amountIn of sampleIns) {
        const quotedOut = BigInt(await pool.quoteExactIn(zeroForOne, amountIn));
        expect(quotedOut).to.be.gt(0n);

        const requiredInForQuotedOut = BigInt(await pool.quoteExactOut(zeroForOne, quotedOut));
        // quoteExactIn rounds output down while quoteExactOut rounds input up.
        // Allow tiny conversion drift from reciprocal rounding paths.
        expect(requiredInForQuotedOut).to.be.lte(amountIn + 3_000_000_000_000_000_000n);
      }

      for (const amountOut of sampleOuts) {
        const quotedIn = BigInt(await pool.quoteExactOut(zeroForOne, amountOut));
        expect(quotedIn).to.be.gt(0n);

        const achievableOut = BigInt(await pool.quoteExactIn(zeroForOne, quotedIn));
        expect(achievableOut).to.be.gte(amountOut);
      }
    }
  });

  it("keeps away->toward roundtrip conservative with exact-out return", async function () {
    const { pool, router, token0, token1, traderA } = await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const awayIn = hre.ethers.parseEther("20000");
    const t0Addr = await token0.getAddress();
    const t1Addr = await token1.getAddress();

    // Leg 1: move away from the price scale by selling token1 for token0.
    const token0BeforeAway = BigInt(await token0.balanceOf(traderA.address));
    const token1BeforeAway = BigInt(await token1.balanceOf(traderA.address));
    const quotedAwayOut = BigInt(await pool.quoteExactIn(false, awayIn));
    expect(quotedAwayOut).to.be.gt(0n);

    await router.connect(traderA).exactInputSingle({
      tokenIn: t1Addr,
      tokenOut: t0Addr,
      poolIndex: 0,
      recipient: traderA.address,
      amountIn: awayIn,
      amountOutMinimum: 0,
      deadline,
    });

    const token0AfterAway = BigInt(await token0.balanceOf(traderA.address));
    const token1AfterAway = BigInt(await token1.balanceOf(traderA.address));
    const awayOut = token0AfterAway - token0BeforeAway;
    expect(awayOut).to.equal(quotedAwayOut);
    expect(token1BeforeAway - token1AfterAway).to.equal(awayIn);

    // Leg 2: return exactly the same token1 amount via exact-out.
    const quotedBackIn = BigInt(await pool.quoteExactOut(true, awayIn));
    expect(quotedBackIn).to.be.gt(0n);

    await router.connect(traderA).exactOutputSingle({
      tokenIn: t0Addr,
      tokenOut: t1Addr,
      poolIndex: 0,
      recipient: traderA.address,
      amountOut: awayIn,
      amountInMaximum: quotedBackIn,
      deadline: deadline + 1,
    });

    const token0AfterBack = BigInt(await token0.balanceOf(traderA.address));
    const token1AfterBack = BigInt(await token1.balanceOf(traderA.address));
    const backInSpent = token0AfterAway - token0AfterBack;

    // ExactOut contract: the router pulls only what the kernel
    // requires for `awayIn`. The quoter returns the same value plus a
    // few wei of safety bump, so `backInSpent ≤ quotedBackIn` and the
    // gap matches the quoter sweep cap (`1e-13 · amountOut + 2048 wei`).
    const overQuoteCap = awayIn / 10_000_000_000_000n + 2_048n;
    expect(backInSpent).to.be.lte(quotedBackIn);
    expect(backInSpent).to.be.gte(quotedBackIn - overQuoteCap);
    // Token1 returns to the initial balance exactly.
    expect(token1AfterBack).to.equal(token1BeforeAway);
    // Roundtrip must stay conservative (no free profit in token0).
    const netToken0 = awayOut - backInSpent;
    expect(netToken0).to.be.lte(0n);
  });

  it("keeps split vs single execution economically close", async function () {
    const { token0, token1, factory, poolImpl, traderA, traderB, owner } = await loadFixture(deployFixture);

    const factoryAddr = await factory.getAddress();
    const poolImplAddr = await poolImpl.getAddress();

    // Token approvals to the factory are already set by `deployFixture`, but
    // the cached pool persists across tests; mint a fresh batch for the
    // second pool's seed and re-approve in case the prior test consumed it.
    await token0.mint(owner.address, ONE_MILLION);
    await token1.mint(owner.address, ONE_MILLION);
    await token0.approve(factoryAddr, MaxUint256);
    await token1.approve(factoryAddr, MaxUint256);

    await factory.createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      poolConfig({
        baseFee: 5,
        feeRampBps: 0,
        feeFloorBps: 5, // must satisfy feeFloorBps <= baseFee
        // Auto-repeg disabled: at 5 bps of fees the growth budget is
        // ~nil, so repegs never fire here — and the default 1e15
        // repeg threshold trips the factory's stall guard (cap at
        // baseFee·1e14 = 5e14 for a flat 5-bps pool) unless the
        // share is zero, which skips the guard entirely.
        repegShareBps: 0,
      }),
      ONE_MILLION,
      ONE_MILLION,
      owner.address
    );
    const secondPoolAddress = await factory.allPools(1);
    const secondPool: any = await hre.ethers.getContractAt("EquilibraPool", secondPoolAddress);
    const SecondWeth = await hre.ethers.getContractFactory("MockWETH9");
    const secondWeth: any = await SecondWeth.deploy();
    await secondWeth.waitForDeployment();
    const Router = await hre.ethers.getContractFactory("EquilibraRouter");
    const secondRouter: any = await Router.deploy(factoryAddr, poolImplAddr, await secondWeth.getAddress());
    await secondRouter.waitForDeployment();

    await token0.connect(traderA).approve(await secondRouter.getAddress(), MaxUint256);
    await token1.connect(traderA).approve(await secondRouter.getAddress(), MaxUint256);
    await token0.connect(traderB).approve(await secondRouter.getAddress(), MaxUint256);
    await token1.connect(traderB).approve(await secondRouter.getAddress(), MaxUint256);

    const firstPoolAddress = await factory.allPools(0);
    const firstPool: any = await hre.ethers.getContractAt("EquilibraPool", firstPoolAddress);
    const FirstWeth = await hre.ethers.getContractFactory("MockWETH9");
    const firstWeth: any = await FirstWeth.deploy();
    await firstWeth.waitForDeployment();
    const firstRouter: any = await Router.deploy(factoryAddr, poolImplAddr, await firstWeth.getAddress());
    await firstRouter.waitForDeployment();
    await token0.connect(traderA).approve(await firstRouter.getAddress(), MaxUint256);
    await token1.connect(traderA).approve(await firstRouter.getAddress(), MaxUint256);

    const t0Addr = await token0.getAddress();
    const t1Addr = await token1.getAddress();
    const oneShotIn = hre.ethers.parseEther("20000");
    const splitIn = oneShotIn / 10n;
    const deadline = (await time.latest()) + 3600;

    const oneShotOutBefore = await token1.balanceOf(traderA.address);
    await firstRouter.connect(traderA).exactInputSingle({
      tokenIn: t0Addr,
      tokenOut: t1Addr,
      poolIndex: 0,
      recipient: traderA.address,
      amountIn: oneShotIn,
      amountOutMinimum: 0,
      deadline,
    });
    const oneShotOutAfter = await token1.balanceOf(traderA.address);
    const oneShotOut = oneShotOutAfter - oneShotOutBefore;

    const splitOutBefore = await token1.balanceOf(traderB.address);
    for (let i = 0; i < 10; i += 1) {
      await secondRouter.connect(traderB).exactInputSingle({
        tokenIn: t0Addr,
        tokenOut: t1Addr,
        poolIndex: 1,
        recipient: traderB.address,
        amountIn: splitIn,
        amountOutMinimum: 0,
        deadline: deadline + i + 1,
      });
    }
    const splitOutAfter = await token1.balanceOf(traderB.address);
    const splitOut = splitOutAfter - splitOutBefore;

    const diff = oneShotOut > splitOut ? oneShotOut - splitOut : splitOut - oneShotOut;
    const diffBps = (BigInt(diff) * 10_000n) / BigInt(oneShotOut);
    expect(diffBps).to.be.lt(200n); // < 2%
  });
});
