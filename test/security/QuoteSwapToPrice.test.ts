import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

const WAD = 10n ** 18n;

// Convenience aliases mirrored from `Constants.sol` and the V3
// canonical TickMath bounds. Keeping them in TS lets the test stay
// resilient to constant-removal in the contract (the protocol may
// drop the on-chain `MIN_SQRT_RATIO` again — the test still has a
// stable yardstick).
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;

interface PoolOpts {
  decimals0?: number;
  decimals1?: number;
  // anchor expressed as token1-WAD per token0-WAD (1.0 by default).
  // For asymmetric-decimals fixtures the helper takes care of
  // re-scaling to the factory's "raw price in 1e18" convention.
  priceTok1PerTok0Wad?: bigint;
  baseFee?: number;
  feeRampBps?: number;
  feeFloorBps?: number;
  aWad?: bigint;
  lambdaWad?: bigint;
}

// Solidity-equivalent of `EquilibraSwapMath.sqrtPriceX96ToMathPriceWad`.
// Mirrors the helper bit-for-bit so the harness can construct V3
// targets at known math-space marginal prices without touching the
// contract.
function sqrtPriceX96ToMathPriceWad(sqrtPriceX96: bigint, anchorWad: bigint, scale0: bigint, scale1: bigint): bigint {
  const priceQ96 = (sqrtPriceX96 * sqrtPriceX96) / Q96;
  const WAD_SQ_X96 = WAD * WAD * Q96;
  const num = WAD_SQ_X96 / priceQ96;
  const stage = (num * scale0) / scale1;
  return stage / anchorWad;
}

// Inverse — used to construct V3 targets from a desired post-state
// math-space `pMargWad`.
function mathPriceToSqrtPriceX96(pMargWad: bigint, anchorWad: bigint, scale0: bigint, scale1: bigint): bigint {
  const numWad = (WAD * WAD) / pMargWad;
  const stepA = (numWad * scale0) / scale1;
  const priceQ96 = (stepA * Q96) / anchorWad;
  // Babylonian sqrt
  let z = priceQ96;
  let x = priceQ96 / 2n + 1n;
  while (x < z) {
    z = x;
    x = (priceQ96 / x + x) / 2n;
  }
  return z << 48n;
}

async function deployQuoterPool(opts: PoolOpts = {}) {
  const decimals0 = opts.decimals0 ?? 18;
  const decimals1 = opts.decimals1 ?? 18;
  const priceTok1PerTok0Wad = opts.priceTok1PerTok0Wad ?? WAD; // 1.0
  const baseFee = opts.baseFee ?? 100; // 1.00 %
  const feeRampBps = opts.feeRampBps ?? 1_000;
  const feeFloorBps = opts.feeFloorBps ?? 20;
  // Single-knob `alpha` sourced from `simulator/src/app/config.rs`.
  // Per-test overrides remain available for callers that need a
  // softer or sharper concentration.
  const aWad = opts.aWad ?? PRESET.aWad;
  const lambdaWad = opts.lambdaWad ?? PRESET.lambdaWad;

  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token0", "TK0", decimals0);
  const tokenB = await Token.deploy("Token1", "TK1", decimals1);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();

  const aAddr = (await tokenA.getAddress()).toLowerCase();
  const bAddr = (await tokenB.getAddress()).toLowerCase();
  // Whichever address sorts first becomes token0 — match the factory
  // logic. The decimals/price annotations follow the sort.
  const [token0, token1, dec0, dec1] =
    aAddr < bAddr ? [tokenA, tokenB, decimals0, decimals1] : [tokenB, tokenA, decimals1, decimals0];
  const scale0 = 10n ** BigInt(18 - dec0);
  const scale1 = 10n ** BigInt(18 - dec1);

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  // Drop the protocol cut so the post-swap reserves move identically
  // in raw and net terms — keeps the gas snapshot stable and avoids
  // an extra accounting wrinkle during quote/swap parity assertions.
  await factory.setProtocolFee(0);

  // Seed liquidity proportional to the value-balanced anchor.
  // `priceTok1PerTok0Wad` here is "how many token1-WAD per 1 token0-WAD",
  // so a balanced pool with reserve0 = R0 needs reserve1 = R0 *
  // priceTok1PerTok0Wad / WAD (in token1-raw units after de-WAD-ifying).
  const R0Wad = hre.ethers.parseEther("1000000"); // 1e6 in WAD scale
  const R1Wad = (R0Wad * priceTok1PerTok0Wad) / WAD;
  const seed0Raw = R0Wad / scale0; // back to raw units of token0
  const seed1Raw = R1Wad / scale1;

  const minted0 = seed0Raw * 4n;
  const minted1 = seed1Raw * 4n;
  await token0.mint(owner.address, minted0);
  await token1.mint(owner.address, minted1);
  await token0.mint(trader.address, minted0);
  await token1.mint(trader.address, minted1);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);

  // Factory normalises `priceIn18` per-decimals: the canonical "raw
  // price" must be expressed as `token1-raw * 1e18 / token0-raw`.
  // For the value-balanced anchor we want `priceTok1PerTok0Wad`
  // (token1-WAD per token0-WAD) — convert via the decimals delta.
  const priceIn18 = (priceTok1PerTok0Wad * 10n ** BigInt(dec1)) / 10n ** BigInt(dec0);

  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad,
      lambdaWad,
      baseFee,
      emaPeriod: 1200,
      // Auto-repeg disabled (`repegShareBps = 0`): the anchor — and
      // therefore the post-state `sqrtPriceX96`/`pMargWad` projections
      // in `getOracleState` — stays comparable to the one the quoter
      // sampled before the swap. This is essential: if the anchor
      // moved between quote and swap, the V3-style invariant would be
      // checked against a different reference frame. (The freeze idiom
      // `threshold = WAD` with a live share is rejected by the
      // factory's stall guard; with `share = 0` the step and both
      // dead-bands are inert, so any in-range value is fine.)
      repegStepWad: WAD,
      repegThresholdToken1UpWad: WAD,
      repegThresholdToken1DownWad: WAD,
      feeRampBps,
      feeFloorBps,
      repegShareBps: 0,
    },
    seed0Raw,
    seed1Raw,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  // Bare-bones swap helper: forwards tokens to a tiny trader contract
  // that pays the pool callback exactly. The same trader is used for
  // every swap in the suite so balances are cumulative across an
  // `it` block — safe because each `loadFixture` mounts a fresh state.
  const SwapTrader = await hre.ethers.getContractFactory("MockSwapCallbackTrader");
  const swapTrader = await SwapTrader.deploy();
  await swapTrader.waitForDeployment();
  const swapTraderAddr = await swapTrader.getAddress();

  await token0.connect(trader).transfer(swapTraderAddr, minted0 / 2n);
  await token1.connect(trader).transfer(swapTraderAddr, minted1 / 2n);

  return {
    owner,
    trader,
    token0,
    token1,
    pool,
    swapTrader,
    poolAddress,
    decimals0: dec0,
    decimals1: dec1,
    scale0,
    scale1,
  };
}

interface OracleSnapshot {
  priceScaleWad: bigint;
  emaPrice: bigint;
  aLast: bigint;
  pMargWad: bigint;
  sqrtPriceX96: bigint;
}

async function getOracle(pool: any): Promise<OracleSnapshot> {
  const s = await pool.getOracleState();
  return {
    priceScaleWad: s.priceScaleWad,
    emaPrice: s.emaPrice,
    aLast: s.aLast,
    pMargWad: s.pMargWad,
    sqrtPriceX96: s.sqrtPriceX96,
  };
}

// PayMode.Exact = 0 (mirrors `MockSwapCallbackTrader`)
const PAY_EXACT = 0;

// Convenience: run swap and return the OUTPUT amount (in raw units of
// the OUT token) by snapshotting recipient balances around the call.
async function execSwapAndMeasureOut(
  ctx: Awaited<ReturnType<typeof deployQuoterPool>>,
  zeroForOne: boolean,
  amountInRaw: bigint
): Promise<bigint> {
  const recipient = await ctx.trader.getAddress();
  const tokenOut = zeroForOne ? ctx.token1 : ctx.token0;
  const balBefore = await tokenOut.balanceOf(recipient);
  await ctx.swapTrader.executeSwap(await ctx.pool.getAddress(), recipient, zeroForOne, amountInRaw, PAY_EXACT);
  const balAfter = await tokenOut.balanceOf(recipient);
  return balAfter - balBefore;
}

// Cheap absolute-difference helper for bigints.
function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

// loadFixture needs a stable named function so hardhat-network-helpers
// can identify (and snapshot-cache) the fixture across `it` blocks.
async function symmetricFixture() {
  return deployQuoterPool();
}

async function asymmetricFixture() {
  return deployQuoterPool({
    decimals0: 8,
    decimals1: 6,
    priceTok1PerTok0Wad: 50_000n * WAD,
  });
}

describe("EquilibraPool quoteSwapToPrice", () => {
  describe("input validation / bail-outs", () => {
    it("returns (0, 0, false) for a zero V3 sqrt-price target", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const [amountIn, amountOut, crossesAnchor] = await ctx.pool.quoteSwapToPrice(true, 0n);
      expect(amountIn).to.equal(0n);
      expect(amountOut).to.equal(0n);
      expect(crossesAnchor).to.equal(false);
    });

    it("zeroForOne rejects a target on the wrong side of current price", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const oracle = await getOracle(ctx.pool);
      // zeroForOne lowers V3 sqrtP — picking a target ABOVE current is
      // wrong-direction by V3 convention. The quoter must bail with
      // the all-zero tuple instead of running a phantom swap.
      const wrongSideTarget = oracle.sqrtPriceX96 + oracle.sqrtPriceX96 / 100n;
      const [amountIn, amountOut, crossesAnchor] = await ctx.pool.quoteSwapToPrice(true, wrongSideTarget);
      expect(amountIn).to.equal(0n);
      expect(amountOut).to.equal(0n);
      expect(crossesAnchor).to.equal(false);
    });

    it("oneForZero rejects a target on the wrong side of current price", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const oracle = await getOracle(ctx.pool);
      // !zeroForOne raises V3 sqrtP — a target BELOW current is wrong.
      const wrongSideTarget = oracle.sqrtPriceX96 - oracle.sqrtPriceX96 / 100n;
      const [amountIn, amountOut, crossesAnchor] = await ctx.pool.quoteSwapToPrice(false, wrongSideTarget);
      expect(amountIn).to.equal(0n);
      expect(amountOut).to.equal(0n);
      expect(crossesAnchor).to.equal(false);
    });

    it("quotes the capped sweep at either end of the canonical domain", async () => {
      const ctx = await loadFixture(symmetricFixture);
      // Both endpoints name a price beyond anything the curve can
      // reach, i.e. an unbounded sweep in their own direction: the
      // low end sweeps zeroForOne, the high end the other way. Each
      // must quote a real amount, and the opposite direction must
      // read it as wrong-direction rather than reverting.
      const [r0, r1] = await ctx.pool.getReserves();
      for (const [zeroForOne, target] of [
        [true, MIN_SQRT_RATIO],
        [false, MAX_SQRT_RATIO - 1n],
      ] as const) {
        const [amountIn, amountOut] = await ctx.pool.quoteSwapToPrice(zeroForOne, target);
        expect(amountIn, `zfo=${zeroForOne} amountIn`).to.be.greaterThan(0n);
        expect(amountOut, `zfo=${zeroForOne} amountOut`).to.be.greaterThan(0n);
        // An unreachable endpoint target is never bracketed, so the
        // sweep must stop exactly on the documented search cap.
        const inputReserve = zeroForOne ? BigInt(r0) : BigInt(r1);
        expect(amountIn, `zfo=${zeroForOne} cap`).to.equal(inputReserve - inputReserve / 100n);

        const [oppIn, oppOut, oppCross] = await ctx.pool.quoteSwapToPrice(!zeroForOne, target);
        expect(oppIn, `zfo=${!zeroForOne} amountIn`).to.equal(0n);
        expect(oppOut, `zfo=${!zeroForOne} amountOut`).to.equal(0n);
        expect(oppCross, `zfo=${!zeroForOne} crossesAnchor`).to.equal(false);
      }
    });

    it("treats a sub-representable target the same as the first representable one", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const [inAtMin, outAtMin] = await ctx.pool.quoteSwapToPrice(true, MIN_SQRT_RATIO);
      const [inAtFirst, outAtFirst] = await ctx.pool.quoteSwapToPrice(true, 1n << 48n);
      expect(inAtMin).to.equal(inAtFirst);
      expect(outAtMin).to.equal(outAtFirst);
    });
  });

  describe("V3 price-limit invariant — quote then forward swap", () => {
    // The quoter promises that running `swap()` with the returned
    // `amountIn` lands the marginal price strictly on the start-side
    // of the user-supplied target (V3 partial-fill semantics): zfo →
    // sqrtPAfter ≥ sqrtTarget; !zfo → sqrtPAfter ≤ sqrtTarget. Both
    // halves are checked through a real `MockSwapCallbackTrader`-driven
    // swap so any divergence between the quote pipeline and the swap
    // pipeline would surface as an inverted inequality.

    it("zeroForOne: post-swap sqrtP stays at or above the target", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const before = await getOracle(ctx.pool);
      // 5% below current sqrt-price — well within reach.
      const sqrtTarget = (before.sqrtPriceX96 * 95n) / 100n;
      const [amountIn, amountOut] = await ctx.pool.quoteSwapToPrice(true, sqrtTarget);
      expect(amountIn).to.be.gt(0n);
      expect(amountOut).to.be.gt(0n);

      const traderAddr = await ctx.trader.getAddress();
      const balOutBefore = await ctx.token1.balanceOf(traderAddr);
      await ctx.swapTrader.executeSwap(await ctx.pool.getAddress(), traderAddr, true, amountIn, PAY_EXACT);
      const balOutAfter = await ctx.token1.balanceOf(traderAddr);
      const realisedOut = balOutAfter - balOutBefore;

      const after = await getOracle(ctx.pool);
      // V3 invariant (zfo): never crossed the price limit.
      expect(after.sqrtPriceX96).to.be.gte(sqrtTarget);
      // Equivalent math-space invariant.
      const pTarget = sqrtPriceX96ToMathPriceWad(sqrtTarget, before.priceScaleWad, ctx.scale0, ctx.scale1);
      expect(after.pMargWad).to.be.lte(pTarget);
      // amountOut must match quote bit-for-bit (same kernel).
      expect(realisedOut).to.equal(amountOut);
    });

    it("oneForZero: post-swap sqrtP stays at or below the target", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const before = await getOracle(ctx.pool);
      // 5% above current — symmetric counterpart of the zfo case.
      const sqrtTarget = (before.sqrtPriceX96 * 105n) / 100n;
      const [amountIn, amountOut] = await ctx.pool.quoteSwapToPrice(false, sqrtTarget);
      expect(amountIn).to.be.gt(0n);
      expect(amountOut).to.be.gt(0n);

      const traderAddr = await ctx.trader.getAddress();
      const balOutBefore = await ctx.token0.balanceOf(traderAddr);
      await ctx.swapTrader.executeSwap(await ctx.pool.getAddress(), traderAddr, false, amountIn, PAY_EXACT);
      const balOutAfter = await ctx.token0.balanceOf(traderAddr);
      const realisedOut = balOutAfter - balOutBefore;

      const after = await getOracle(ctx.pool);
      // V3 invariant (!zfo): never crossed the price limit.
      expect(after.sqrtPriceX96).to.be.lte(sqrtTarget);
      const pTarget = sqrtPriceX96ToMathPriceWad(sqrtTarget, before.priceScaleWad, ctx.scale0, ctx.scale1);
      expect(after.pMargWad).to.be.gte(pTarget);
      expect(realisedOut).to.equal(amountOut);
    });

    it("near-spot targets return a usable amount, never (0,0) (audit L-7)", async () => {
      // Regression for the discarded in-tolerance iterate: targets very
      // close to the current price used to hit the path where a
      // crossed-but-in-tolerance bisection mid broke the loop WITHOUT
      // recording an answer — returning (0,0) for a perfectly reachable
      // target (or a stale far undershoot). The fixed loop exits only
      // from the not-crossed side, so every reachable target yields a
      // non-zero, non-crossing amount.
      const ctx = await loadFixture(symmetricFixture);
      const before = await getOracle(ctx.pool);
      // Offsets in 1e-5 units: 0.01%, 0.05%, 0.2% away from spot.
      for (const off of [10n, 50n, 200n]) {
        const targetZfo = (before.sqrtPriceX96 * (100_000n - off)) / 100_000n;
        const [inZfo] = await ctx.pool.quoteSwapToPrice(true, targetZfo);
        expect(inZfo, `zfo target -${off}e-5 quoted zero`).to.be.gt(0n);

        const targetOfz = (before.sqrtPriceX96 * (100_000n + off)) / 100_000n;
        const [inOfz] = await ctx.pool.quoteSwapToPrice(false, targetOfz);
        expect(inOfz, `ofz target +${off}e-5 quoted zero`).to.be.gt(0n);
      }

      // One-sided guarantee holds on the CLOSEST target too: execute the
      // quoted amount for -0.01% and verify the limit was not crossed.
      const sqrtTarget = (before.sqrtPriceX96 * 99_990n) / 100_000n;
      const [amountIn] = await ctx.pool.quoteSwapToPrice(true, sqrtTarget);
      const traderAddr = await ctx.trader.getAddress();
      await ctx.swapTrader.executeSwap(await ctx.pool.getAddress(), traderAddr, true, amountIn, PAY_EXACT);
      const after = await getOracle(ctx.pool);
      expect(after.sqrtPriceX96, "crossed the near-spot limit").to.be.gte(sqrtTarget);
    });

    it("converges on small targets (1% slip) with sub-bps precision", async () => {
      // Tight target — exercises the bisection's tolerance early-exit
      // path. We expect `pMargAfter` to land within `pTarget / 1e6`
      // (1 ppm) of the target, comfortably inside the contract's
      // `pTarget / 1e8` exit threshold.
      const ctx = await loadFixture(symmetricFixture);
      const before = await getOracle(ctx.pool);
      const sqrtTarget = (before.sqrtPriceX96 * 99n) / 100n;
      const [amountIn] = await ctx.pool.quoteSwapToPrice(true, sqrtTarget);
      expect(amountIn).to.be.gt(0n);

      await ctx.swapTrader.executeSwap(
        await ctx.pool.getAddress(),
        await ctx.trader.getAddress(),
        true,
        amountIn,
        PAY_EXACT
      );
      const after = await getOracle(ctx.pool);
      const pTarget = sqrtPriceX96ToMathPriceWad(sqrtTarget, before.priceScaleWad, ctx.scale0, ctx.scale1);
      // Sub-ppm post-swap distance from target (start-side).
      expect(after.pMargWad).to.be.lte(pTarget);
      const tol = pTarget / 1_000_000n; // 1 ppm
      expect(absDiff(after.pMargWad, pTarget)).to.be.lt(tol);
    });
  });

  describe("monotonicity in target distance", () => {
    it("zfo: amountIn grows as the target moves further from current", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const oracle = await getOracle(ctx.pool);

      const targets = [99n, 95n, 90n].map((pct) => (oracle.sqrtPriceX96 * pct) / 100n);

      const amountsIn: bigint[] = [];
      for (const t of targets) {
        const [a] = await ctx.pool.quoteSwapToPrice(true, t);
        amountsIn.push(a);
      }
      // Each target is strictly further from the start; the implied
      // amountIn must be strictly larger.
      expect(amountsIn[0]).to.be.lt(amountsIn[1]);
      expect(amountsIn[1]).to.be.lt(amountsIn[2]);
    });

    it("!zfo: amountIn grows as the target moves further from current", async () => {
      const ctx = await loadFixture(symmetricFixture);
      const oracle = await getOracle(ctx.pool);

      const targets = [101n, 105n, 110n].map((pct) => (oracle.sqrtPriceX96 * pct) / 100n);

      const amountsIn: bigint[] = [];
      for (const t of targets) {
        const [a] = await ctx.pool.quoteSwapToPrice(false, t);
        amountsIn.push(a);
      }
      expect(amountsIn[0]).to.be.lt(amountsIn[1]);
      expect(amountsIn[1]).to.be.lt(amountsIn[2]);
    });
  });

  describe("crossesAnchor flag", () => {
    it("flags trajectories that strictly straddle pMarg = WAD", async () => {
      // Use a small pre-swap to push the pool slightly past the anchor
      // (pMarg > WAD), then quote toward a target on the OTHER side
      // (pMarg < WAD via V3 sqrtP > anchor sqrtP). The flag must fire.
      const ctx = await loadFixture(symmetricFixture);
      const traderAddr = await ctx.trader.getAddress();
      // 1% of token0 reserve seeded to nudge pMarg above WAD.
      const reserves0Raw = await ctx.token0.balanceOf(await ctx.pool.getAddress());
      const nudge = reserves0Raw / 100n;
      await ctx.swapTrader.executeSwap(await ctx.pool.getAddress(), traderAddr, true, nudge, PAY_EXACT);

      const after = await getOracle(ctx.pool);
      expect(after.pMargWad).to.be.gt(WAD);

      // Target on the OTHER side of the anchor — pMargTarget < WAD.
      const pTarget = (WAD * 99n) / 100n; // 0.99 WAD
      const sqrtTarget = mathPriceToSqrtPriceX96(pTarget, after.priceScaleWad, ctx.scale0, ctx.scale1);
      // pMargTarget < pStart so we're in !zeroForOne territory.
      const [amountIn, , crossesAnchor] = await ctx.pool.quoteSwapToPrice(false, sqrtTarget);
      expect(amountIn).to.be.gt(0n);
      expect(crossesAnchor).to.equal(true);
    });

    it("returns false when the trajectory stays on one side of the anchor", async () => {
      // Step the pool slightly above the anchor first, then quote a
      // target that ALSO stays above the anchor — single-segment
      // trajectory, flag must be false.
      const ctx = await loadFixture(symmetricFixture);
      const traderAddr = await ctx.trader.getAddress();
      const reserves0Raw = await ctx.token0.balanceOf(await ctx.pool.getAddress());
      await ctx.swapTrader.executeSwap(await ctx.pool.getAddress(), traderAddr, true, reserves0Raw / 50n, PAY_EXACT);
      const after = await getOracle(ctx.pool);
      expect(after.pMargWad).to.be.gt(WAD);
      const sqrtTarget = (after.sqrtPriceX96 * 98n) / 100n;
      const [amountIn, , crossesAnchor] = await ctx.pool.quoteSwapToPrice(true, sqrtTarget);
      expect(amountIn).to.be.gt(0n);
      expect(crossesAnchor).to.equal(false);
    });
  });

  describe("asymmetric decimals (token0 = 8 dp, token1 = 6 dp)", () => {
    // Mirrors a WBTC/USDT-style pair at 50000 USDT per WBTC. The
    // factory normalisation rescales `priceTok1PerTok0Wad = 50000 * WAD`
    // to the per-decimals raw representation it stores internally.
    it("zfo round-trip stays on the start-side of the V3 target", async () => {
      const ctx = await loadFixture(asymmetricFixture);
      const before = await getOracle(ctx.pool);
      // 3% slip — comfortable for an 8/6 pair without smashing the
      // bracket-grow ceiling.
      const sqrtTarget = (before.sqrtPriceX96 * 97n) / 100n;
      const [amountIn, amountOut] = await ctx.pool.quoteSwapToPrice(true, sqrtTarget);
      expect(amountIn).to.be.gt(0n);
      expect(amountOut).to.be.gt(0n);

      const realisedOut = await execSwapAndMeasureOut(ctx, true, amountIn);
      const after = await getOracle(ctx.pool);

      expect(after.sqrtPriceX96).to.be.gte(sqrtTarget);
      const pTarget = sqrtPriceX96ToMathPriceWad(sqrtTarget, before.priceScaleWad, ctx.scale0, ctx.scale1);
      expect(after.pMargWad).to.be.lte(pTarget);
      expect(realisedOut).to.equal(amountOut);
    });

    it("!zfo round-trip stays on the start-side of the V3 target", async () => {
      const ctx = await loadFixture(asymmetricFixture);
      const before = await getOracle(ctx.pool);
      const sqrtTarget = (before.sqrtPriceX96 * 103n) / 100n;
      const [amountIn, amountOut] = await ctx.pool.quoteSwapToPrice(false, sqrtTarget);
      expect(amountIn).to.be.gt(0n);
      expect(amountOut).to.be.gt(0n);

      const realisedOut = await execSwapAndMeasureOut(ctx, false, amountIn);
      const after = await getOracle(ctx.pool);

      expect(after.sqrtPriceX96).to.be.lte(sqrtTarget);
      const pTarget = sqrtPriceX96ToMathPriceWad(sqrtTarget, before.priceScaleWad, ctx.scale0, ctx.scale1);
      expect(after.pMargWad).to.be.gte(pTarget);
      expect(realisedOut).to.equal(amountOut);
    });
  });
});
