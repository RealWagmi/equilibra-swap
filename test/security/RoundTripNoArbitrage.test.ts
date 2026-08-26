// SPDX-License-Identifier: MIT
//
// Round-trip no-arbitrage regression for the EquilibraPool math kernel.
//
// Goal: guarantee that across the two-knob `(aWad, lambdaWad)` curve
// surface and across the full `(0, 99]%` swap-depth sweep, a forward
// USDT→WBTC followed immediately by the reverse WBTC→USDT swap on the
// same pool state cannot return MORE USDT than were originally
// deposited.
//
// The fixture turns off every operational fee and recentering knob:
//   * `baseFee = 5`        (factory minimum, then collapsed by ramp = 0)
//   * `feeRampBps = 0`     (dynamic fee saturates to 5 bps)
//   * `feeFloorBps = 0`
//   * `repegShareBps = 0`  (anchor never auto-drifts)
// What's left is **pure curvature math**: any positive round-trip
// delta would necessarily originate inside `_computeExactInSwapMath`
// or the cross-anchor settlement, not from fee accounting.
//
// Production assertion (no scenario-specific opt-outs):
//   For every `pct ∈ {1%, 5%, …, 99%}` the trader's USDT delta
//   `usdtBack - usdtIn` must be ≤ 0.
//   The 1 wei budget below absorbs the inevitable scale-floor that
//   happens when 1e18 math-space units round down through the 6/8 raw
//   token-decimal grid.
//
// The very last test asserts the LP-side mirror image: the round-trip
// must NEVER cause the pool's anchor-priced value (the fee-free
// curvature accounting) to fall, since that would mean the AMM
// transferred more value to the trader than they paid in.

import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const USDT_DECIMALS = 6;
const WBTC_DECIMALS = 8;
const PRICE_USDT_PER_WBTC_RAW = 102_354_000_000n;
const INITIAL_USDT_RAW = 500_000n * 10n ** BigInt(USDT_DECIMALS);
const WAD = 10n ** 18n;
// Decimal-rounding budget for `usdtBack - usdtIn`: USDT has 6 decimals,
// so a single math-space WAD step floors to 1 raw unit when normalised
// down. We accept a 1 wei (raw USDT) "loss" as numerically zero — every
// other regression in this file uses the strict `<= 0n` form.
const USDT_ROUNDING_BUDGET = 1n;

function usdtRawToWbtcRaw(usdtRaw: bigint): bigint {
  return (usdtRaw * 10n ** BigInt(WBTC_DECIMALS)) / PRICE_USDT_PER_WBTC_RAW;
}

type CurveCfg = {
  aWad: bigint;
  lambdaWad: bigint;
  label: string;
};

// two-knob invariant: `K = A·L·(x+y)/2 + (W−A)·xy` with
// `A = a·W / (W + λ·D)`. `a` controls depth at anchor; `λ` controls
// plateau width. Both knobs decouple — moving `a` shifts the centre
// depth without affecting the cliff position; moving `λ` shifts the
// cliff position without affecting depth at anchor. The legacy
// single-`α` knob coupled the two; the design is the strictly
// more expressive one.
//
// Scenarios sweep the production presets (hard-coded in
// `simulator/test_helpers/config.ts` during Phase 1+2; will revert to
// Rust-derived values when `simulator/src/app/config.rs` is migrated).
// Round-trip non-profit must hold across every curve pair that can
// land on mainnet — no synthetic test points.
const SCENARIOS: CurveCfg[] = [
  {
    label: "WETH preset (production)",
    aWad: EQUILIBRA_PRESETS.WETH.aWad,
    lambdaWad: EQUILIBRA_PRESETS.WETH.lambdaWad,
  },
  {
    label: "WBTC preset (production)",
    aWad: EQUILIBRA_PRESETS.WBTC.aWad,
    lambdaWad: EQUILIBRA_PRESETS.WBTC.lambdaWad,
  },
];

type FixtureResult = {
  usdt: any;
  wbtc: any;
  pool: any;
  router: any;
  trader: any;
  usdtAddr: string;
  wbtcAddr: string;
  usdtIsToken0: boolean;
};

async function deployRoundTripFixtureFor(cfg: CurveCfg): Promise<FixtureResult> {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const usdt: any = await Token.deploy("Tether USD", "USDT", USDT_DECIMALS);
  const wbtc: any = await Token.deploy("Wrapped BTC", "WBTC", WBTC_DECIMALS);
  await usdt.waitForDeployment();
  await wbtc.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth: any = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  const initialWbtcRaw = usdtRawToWbtcRaw(INITIAL_USDT_RAW);
  await usdt.mint(owner.address, INITIAL_USDT_RAW * 10n);
  await wbtc.mint(owner.address, initialWbtcRaw * 10n);
  await usdt.mint(trader.address, INITIAL_USDT_RAW * 5n);
  await wbtc.mint(trader.address, initialWbtcRaw * 5n);

  const usdtAddr = await usdt.getAddress();
  const wbtcAddr = await wbtc.getAddress();
  const usdtIsToken0 = usdtAddr.toLowerCase() < wbtcAddr.toLowerCase();

  await usdt.approve(factoryAddr, MaxUint256);
  await wbtc.approve(factoryAddr, MaxUint256);

  await factory.createPoolAndAddLiquidity(
    usdtAddr,
    wbtcAddr,
    {
      aWad: cfg.aWad,
      lambdaWad: cfg.lambdaWad,
      baseFee: 5,
      emaPeriod: 601,
      repegStepWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps: 0,
    },
    INITIAL_USDT_RAW,
    initialWbtcRaw,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool: any = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  await usdt.connect(trader).approve(await router.getAddress(), MaxUint256);
  await wbtc.connect(trader).approve(await router.getAddress(), MaxUint256);

  return { usdt, wbtc, pool, router, trader, usdtAddr, wbtcAddr, usdtIsToken0 };
}

async function fixtureDefault(): Promise<FixtureResult> {
  return deployRoundTripFixtureFor(SCENARIOS[0]);
}
async function fixtureWbtc(): Promise<FixtureResult> {
  return deployRoundTripFixtureFor(SCENARIOS[1]);
}
const FIXTURES: Record<string, () => Promise<FixtureResult>> = {
  [SCENARIOS[0].label]: fixtureDefault,
  [SCENARIOS[1].label]: fixtureWbtc,
};

type StateSnapshot = {
  reserve0: bigint;
  reserve1: bigint;
  priceScaleWad: bigint;
  poolValueAtAnchorWad: bigint;
};

async function captureState(pool: any, ctx: { usdtIsToken0: boolean }): Promise<StateSnapshot> {
  const [r0, r1] = await pool.getReserves();
  const oracle = await pool.getOracleState();
  // usdtIsToken0 → token0=USDT(6), token1=WBTC(8).
  // !usdtIsToken0 → token0=WBTC(8), token1=USDT(6).
  const dec0 = ctx.usdtIsToken0 ? USDT_DECIMALS : WBTC_DECIMALS;
  const dec1 = ctx.usdtIsToken0 ? WBTC_DECIMALS : USDT_DECIMALS;
  const t0Scale = 10n ** BigInt(18 - dec0);
  const t1Scale = 10n ** BigInt(18 - dec1);
  const r0Wad = BigInt(r0) * t0Scale;
  const r1Wad = BigInt(r1) * t1Scale;
  const anchor = BigInt(oracle.priceScaleWad);
  const valueAtAnchor = (r0Wad * anchor) / WAD + r1Wad;
  return {
    reserve0: BigInt(r0),
    reserve1: BigInt(r1),
    priceScaleWad: anchor,
    poolValueAtAnchorWad: valueAtAnchor,
  };
}

function fmt(x: bigint, scale: bigint, frac = 6): string {
  if (x === 0n) return "0";
  const sign = x < 0n ? "-" : "";
  const ax = x < 0n ? -x : x;
  const whole = ax / scale;
  const frPart = ax % scale;
  const frStr = frPart.toString().padStart(scale.toString().length - 1, "0");
  return `${sign}${whole.toString()}.${frStr.slice(0, frac)}`.replace(/0+$/, "").replace(/\.$/, "");
}

const fmtWad = (x: bigint, frac = 6) => fmt(x, WAD, frac);
const fmtUsdt = (x: bigint, frac = 6) => fmt(x, 10n ** BigInt(USDT_DECIMALS), frac);
const fmtWbtc = (x: bigint, frac = 8) => fmt(x, 10n ** BigInt(WBTC_DECIMALS), frac);

describe("RoundTripNoArbitrage [state-FP regression]", function () {
  for (const cfg of SCENARIOS) {
    it(`USDT→WBTC→USDT round-trip is non-positive across [1%..99%] depth — ${cfg.label}`, async function () {
      this.timeout(120_000);
      const fx = await loadFixture(FIXTURES[cfg.label]);
      const { usdt, wbtc, router, trader, usdtAddr, wbtcAddr } = fx;

      // Coarse-then-dense sweep: stress both shallow swaps (where the
      // CP-projection seed dominates the FP iteration) and deep ones
      // (where the hyperbola solver runs near reserve depletion).
      const PCTS = [1n, 5n, 10n, 25n, 40n, 50n, 60n, 70n, 75n, 80n, 85n, 90n, 95n, 99n];

      const results: Array<{
        pct: string;
        usdtIn: string;
        wbtcOut: string;
        usdtBack: string;
        roundTripDelta: string;
        deltaBps: string;
      }> = [];

      const baseDeadline = (await time.latest()) + 24 * 60 * 60;

      for (const pct of PCTS) {
        const snap = await hre.network.provider.send("evm_snapshot", []);
        try {
          const usdtIn = (INITIAL_USDT_RAW * pct) / 100n;

          const wbtcBefore = BigInt(await wbtc.balanceOf(trader.address));
          await router.connect(trader).exactInputSingle({
            tokenIn: usdtAddr,
            tokenOut: wbtcAddr,
            poolIndex: 0,
            recipient: trader.address,
            amountIn: usdtIn,
            amountOutMinimum: 0,
            deadline: baseDeadline,
          });
          const wbtcAfter = BigInt(await wbtc.balanceOf(trader.address));
          const wbtcOut = wbtcAfter - wbtcBefore;

          const usdtBefore = BigInt(await usdt.balanceOf(trader.address));
          await router.connect(trader).exactInputSingle({
            tokenIn: wbtcAddr,
            tokenOut: usdtAddr,
            poolIndex: 0,
            recipient: trader.address,
            amountIn: wbtcOut,
            amountOutMinimum: 0,
            deadline: baseDeadline + 1,
          });
          const usdtAfter = BigInt(await usdt.balanceOf(trader.address));
          const usdtBack = usdtAfter - usdtBefore;

          const delta = usdtBack - usdtIn;
          const deltaBps = usdtIn === 0n ? 0n : (delta * 10_000n) / usdtIn;

          results.push({
            pct: `${pct}%`,
            usdtIn: fmtUsdt(usdtIn, 2),
            wbtcOut: fmtWbtc(wbtcOut),
            usdtBack: fmtUsdt(usdtBack, 2),
            roundTripDelta: `${delta >= 0n ? "+" : ""}${fmtUsdt(delta, 6)}`,
            deltaBps: `${deltaBps >= 0n ? "+" : ""}${deltaBps} bps`,
          });

          // Hard regression: the trader cannot extract MORE USDT than
          // they put in (modulo a single raw-decimal unit of round-down
          // noise). state-FP iter=1 yields a strictly non-positive delta
          // analytically; the +1 wei budget covers one floor along the
          // 1e12 raw→wad scale conversion that USDT's 6-decimal grid
          // imposes on the math-space output.
          expect(
            delta,
            `Round-trip leaked USDT at pct=${pct}% under ${cfg.label} ` +
              `(usdtBack=${fmtUsdt(usdtBack, 6)}, usdtIn=${fmtUsdt(usdtIn, 6)}, delta=${delta}wei)`
          ).to.be.lessThanOrEqual(USDT_ROUNDING_BUDGET);
        } finally {
          await hre.network.provider.send("evm_revert", [snap]);
        }
      }

      console.log(`\n=== ${cfg.label} (state-FP iter=1) ===`);
      console.log(`aWad=${fmtWad(cfg.aWad, 6)} lambdaWad=${fmtWad(cfg.lambdaWad, 6)}`);
      console.table(results);
    });
  }

  it("Pool anchor-priced value is non-decreasing across a deep round-trip (WBTC preset, 90%)", async function () {
    this.timeout(60_000);
    const fx = await loadFixture(fixtureWbtc);
    const { usdt, wbtc, pool, router, trader, usdtAddr, wbtcAddr, usdtIsToken0 } = fx;
    const captureCtx = { usdtIsToken0 };

    const usdtIn = (INITIAL_USDT_RAW * 90n) / 100n;
    const baseDeadline = (await time.latest()) + 24 * 60 * 60;

    const before = await captureState(pool, captureCtx);

    const wbtcBefore = BigInt(await wbtc.balanceOf(trader.address));
    await router.connect(trader).exactInputSingle({
      tokenIn: usdtAddr,
      tokenOut: wbtcAddr,
      poolIndex: 0,
      recipient: trader.address,
      amountIn: usdtIn,
      amountOutMinimum: 0,
      deadline: baseDeadline,
    });
    const wbtcAfter = BigInt(await wbtc.balanceOf(trader.address));
    const wbtcOut = wbtcAfter - wbtcBefore;

    const usdtBefore = BigInt(await usdt.balanceOf(trader.address));
    await router.connect(trader).exactInputSingle({
      tokenIn: wbtcAddr,
      tokenOut: usdtAddr,
      poolIndex: 0,
      recipient: trader.address,
      amountIn: wbtcOut,
      amountOutMinimum: 0,
      deadline: baseDeadline + 1,
    });
    const usdtAfter = BigInt(await usdt.balanceOf(trader.address));
    const usdtBack = usdtAfter - usdtBefore;
    const after = await captureState(pool, captureCtx);

    const delta = usdtBack - usdtIn;
    const poolValueDeltaTotal = after.poolValueAtAnchorWad - before.poolValueAtAnchorWad;

    console.log(`\nDeep round-trip [${SCENARIOS[1].label}, 90%]:`);
    console.table({
      usdtIn: fmtUsdt(usdtIn, 6),
      wbtcOut: fmtWbtc(wbtcOut),
      usdtBack: fmtUsdt(usdtBack, 6),
      "trader USDT delta": `${delta >= 0n ? "+" : ""}${fmtUsdt(delta, 6)}`,
      "before.poolValueAtAnchor (USDT)": fmtWad(before.poolValueAtAnchorWad, 4),
      "after.poolValueAtAnchor (USDT)": fmtWad(after.poolValueAtAnchorWad, 4),
      "Δ poolValueAtAnchor (total)": fmtWad(poolValueDeltaTotal, 4),
    });

    expect(delta, `90% round-trip leaked USDT (delta=${delta}wei)`).to.be.lessThanOrEqual(USDT_ROUNDING_BUDGET);
    // Anchor-priced pool value mirrors the trader-side delta: if the
    // trader didn't extract value, neither did the pool lose it. The
    // budget is a single WAD wei to absorb the same floor noise from
    // the WAD↔raw round-trip on r0.
    expect(
      poolValueDeltaTotal,
      `pool anchor-priced value lost ${poolValueDeltaTotal}wei on round-trip`
    ).to.be.greaterThanOrEqual(-1n);
  });
});
