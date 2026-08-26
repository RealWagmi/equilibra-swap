// Bit-exact parity between the **real** Vyper Curve V2 Twocrypto pool
// (deployed on-chain through the blueprint factory) and the off-chain
// Rust port at `simulator/src/runtime_quoter/curve.rs`.
//
// Why this matters
// ----------------
//   The Rust simulator includes a full reimplementation of Curve V2
//   cryptoswap (D solver, fee `_fee(xp)`, EMA price oracle, repeg
//   step, virtual-price / xcp_profit accounting). Until now NO test
//   confirmed the Rust port matches the Vyper bytecode bit-for-bit
//   under live state evolution — `RepegConservation` runs both pools
//   side by side but only checks that each independently respects
//   the structural conservation invariant ("vp ≥ ½·Σfees floor").
//   That left a gap: a Rust kernel drift could silently mis-price
//   every Curve quote in the simulator (and therefore in the
//   benchmark / dashboard) without any test catching it.
//
//   This file closes that gap. It deploys the real Vyper bytecode
//   from `test/fixtures/curve-artifacts/` (local-only, gitignored —
//   the suite self-skips when the artifacts are absent), runs a deterministic
//   mixed-action scenario (swap → swap → add → swap → remove → swap)
//   against the on-chain pool, captures the post-state after every
//   step, then replays the same sequence through the Rust trace
//   runner and asserts every state field matches bit-for-bit.
//
// What is asserted at each step
// -----------------------------
//   • reserves (`balances(0)`, `balances(1)`)
//   • LP supply (`totalSupply()`)
//   • Curve invariant (`D()`)
//   • Oracle trio (`price_scale`, `price_oracle`, `last_prices`,
//     `last_timestamp`)
//   • LP value accounting (`virtual_price`, `xcp_profit`)
//   • Swap-action outputs: `amountOut` (exact-in)
//   • Liquidity-action outputs: `mintedShares`, `amount0Out`,
//     `amount1Out`
//
// No tolerances. Any drift means the Rust port has diverged from the
// Vyper bytecode and the simulator's Curve numbers cannot be trusted
// downstream.
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { ContractFactory, MaxUint256 } from "ethers";

import * as fs from "node:fs";
import * as path from "node:path";

// Pre-compiled third-party pool artifacts. Local-only, never tracked
// by git. When the artifacts are absent this suite self-skips instead
// of failing, so fresh clones stay green without the optional fixture.
//
// The Rust port mirrors the 2026-05 twocrypto version (adjustment_step
// [min, max] pair, once-per-block rebalance gated by lp_xcp_profit,
// symmetric EMA spot cap). Artifacts must be compiled from THAT
// version; the older single-step factory ABI (allowed_extra_profit +
// adjustment_step) is incompatible with the deploy call below.
//
// Build recipe (each artifact is a `{abi, bytecode}` JSON):
//   1. Sources: curvefi/twocrypto-ng @ cc7dd9446e86d6e216a60927159e0904363825c9,
//      contracts/main/{Twocrypto,TwocryptoFactory,TwocryptoView,StableswapMath}.vy
//   2. Compiler: vyper 0.4.3 + snekmate 0.1.2 (e.g. in python:3.11-slim);
//      `vyper -f abi` / `vyper -f bytecode` per contract.
//   3. Twocrypto.vy needs one wiring-only patch before compiling: the
//      MATH / VIEW immutables are normally source-patched by Curve's
//      blueprint deploy scripts, so convert both declarations to storage
//      (`MATH: public(Math)`, assignments via `self.`, call sites
//      `staticcall self.MATH.`) and append an admin-gated
//      `set_periphery(views, math)` setter (guard: `self._check_admin()`).
//      No math or accounting line changes.
const CURVE_ARTIFACTS_DIR = path.join(__dirname, "..", "fixtures", "curve-artifacts");
const CURVE_ARTIFACT_FILES = ["Twocrypto.json", "TwocryptoFactory.json", "TwocryptoView.json", "StableswapMath.json"];

const curveArtifactsPresent = CURVE_ARTIFACT_FILES.every((f) => fs.existsSync(path.join(CURVE_ARTIFACTS_DIR, f)));

function loadCurveArtifact(name: string): { abi: any[]; bytecode: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(CURVE_ARTIFACTS_DIR, name));
}

import { CURVE, CURVE_PRESETS } from "../../simulator/test_helpers/config";
import { runRustSimulatorTrace } from "../../simulator/test_helpers/rustTestUtils";

const WAD = 10n ** 18n;
const PRICE_USD_PER_WETH = 2_000n * WAD;

// Pool depth — uniform 18-decimal mock tokens. 1M USDT-equivalent +
// 500 WETH-equivalent matches the simulator's typical seeded liquidity
// at $2000/ETH.
const RESERVE_USDT = 1_000_000n * WAD;
const RESERVE_WETH = 500n * WAD;

const PRESET = CURVE_PRESETS.WETH;
const CURVE_A = BigInt(PRESET.A);
const CURVE_GAMMA = PRESET.gamma;
const CURVE_MID_FEE = PRESET.midFee;
const CURVE_OUT_FEE = PRESET.outFee;
const CURVE_FEE_GAMMA = PRESET.feeGamma;
const CURVE_ADJ_STEP_MIN = PRESET.adjustmentStepMin;
const CURVE_ADJ_STEP_MAX = PRESET.adjustmentStepMax;
const CURVE_RESERVED_PROFIT_FRACTION = PRESET.reservedProfitFraction;
const CURVE_MA_TIME = PRESET.maTime;
// The factory's `ma_exp_time` deploy argument is the INTERNAL relaxation
// time tau, while the preset carries the on-chain `ma_time()` VIEW value
// (half-life = tau * 694 / 1000). Convert with the exact integer inverse
// so the deployed pool's view reads back exactly `PRESET.maTime`, and the
// Rust trace side — which applies the same conversion in
// `CurveStatefulConfig::new` — runs the identical EMA speed.
const CURVE_MA_EXP_TIME = (BigInt(CURVE_MA_TIME) * 1000n + 693n) / 694n;

type Direction = "USDT_TO_WETH" | "WETH_TO_USDT";

type Action =
  | { kind: "swap"; direction: Direction; amountIn: bigint }
  | { kind: "add"; amount0: bigint; amount1: bigint }
  | { kind: "remove"; shares: bigint };

type CurveState = {
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  d: bigint;
  priceScale: bigint;
  priceOracle: bigint;
  lastPrices: bigint;
  lastTimestamp: bigint;
  virtualPrice: bigint;
  xcpProfit: bigint;
  lpXcpProfit: bigint;
};

type RecordedStep = {
  action: Action;
  timestamp: number;
  // Direct on-chain measurements taken right after the tx commits.
  amountIn?: bigint;
  amountOut?: bigint;
  amount0Used?: bigint;
  amount1Used?: bigint;
  mintedShares?: bigint;
  amount0Out?: bigint;
  amount1Out?: bigint;
  pre: CurveState;
  post: CurveState;
};

type Fixture = Awaited<ReturnType<typeof deployCurve>>;

async function deployCurve() {
  // Lazy-loaded so the module still parses on clones without the
  // locally-built artifact fixtures (the suite self-skips upstream).
  const TwocryptoArtifact = loadCurveArtifact("Twocrypto.json");
  const TwocryptoFactoryArtifact = loadCurveArtifact("TwocryptoFactory.json");
  const TwocryptoViewArtifact = loadCurveArtifact("TwocryptoView.json");
  const StableswapMathArtifact = loadCurveArtifact("StableswapMath.json");

  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const usdt = await Token.deploy("USDT", "USDT", 18);
  const weth = await Token.deploy("WETH", "WETH", 18);
  await usdt.waitForDeployment();
  await weth.waitForDeployment();

  const usdtAddr = (await usdt.getAddress()).toLowerCase();
  const wethAddr = (await weth.getAddress()).toLowerCase();
  // Curve does NOT sort tokens — it accepts the array in the order
  // the deployer passes them. We keep a canonical "USDT first" wiring
  // so both directions of every test are unambiguous.
  const isUsdtToken0 = true;
  const token0 = usdt;
  const token1 = weth;

  // 100× depth bankroll for both LP & trader so the long mixed-action
  // sequence never bumps into a balance ceiling.
  const mintAmt = RESERVE_USDT * 100n;
  for (const acct of [owner, trader]) {
    await usdt.mint(acct.address, mintAmt);
    await weth.mint(acct.address, mintAmt);
  }

  // Deploy Curve infrastructure (math + view + factory + blueprint
  // pool implementation) and seed initial liquidity. Mirrors the
  // setup in `test/security/RepegConservation.test.ts`.
  const cMath = await new ContractFactory(StableswapMathArtifact.abi, StableswapMathArtifact.bytecode, owner).deploy();
  await cMath.waitForDeployment();
  const cView = await new ContractFactory(TwocryptoViewArtifact.abi, TwocryptoViewArtifact.bytecode, owner).deploy();
  await cView.waitForDeployment();
  const cFactory = await new ContractFactory(
    TwocryptoFactoryArtifact.abi,
    TwocryptoFactoryArtifact.bytecode,
    owner
  ).deploy();
  await cFactory.waitForDeployment();
  await (cFactory as any).initialise_ownership(owner.address, owner.address);

  const blueprintDeployer = await (await hre.ethers.getContractFactory("BlueprintDeployer")).deploy();
  await blueprintDeployer.waitForDeployment();
  const blueprintBytecode = "0xfe7100" + ((TwocryptoArtifact as any).bytecode as string).slice(2);
  const poolImplAddr = await blueprintDeployer.deployBlueprint.staticCall(blueprintBytecode);
  await blueprintDeployer.deployBlueprint(blueprintBytecode);

  await (cFactory as any).set_pool_implementation(poolImplAddr, 0);
  await (cFactory as any).set_math_implementation(await cMath.getAddress());
  await (cFactory as any).set_views_implementation(await cView.getAddress());

  // initial_price = USDT per WETH (we always wire USDT as token0).
  const cInitialPrice = PRICE_USD_PER_WETH;
  const deployTx = await (cFactory as any).deploy_pool(
    "TestPool",
    "TP",
    [await token0.getAddress(), await token1.getAddress()],
    0,
    CURVE_A,
    CURVE_GAMMA,
    CURVE_MID_FEE,
    CURVE_OUT_FEE,
    CURVE_FEE_GAMMA,
    CURVE_ADJ_STEP_MIN,
    CURVE_ADJ_STEP_MAX,
    CURVE_MA_EXP_TIME,
    cInitialPrice
  );
  const receipt = await deployTx.wait();

  let cPoolAddr: string | null = null;
  for (const log of receipt!.logs) {
    try {
      const parsed = (cFactory as any).interface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (parsed?.name === "TwocryptoPoolDeployed") {
        cPoolAddr = parsed.args.pool;
        break;
      }
    } catch {}
  }
  if (!cPoolAddr) throw new Error("Curve: TwocryptoPoolDeployed event not found");

  const cPool = new hre.ethers.Contract(cPoolAddr, TwocryptoArtifact.abi, hre.ethers.provider);
  await (cPool as any).connect(owner).set_periphery(await cView.getAddress(), await cMath.getAddress());
  // The magic preset gamma (11111111111) marks the pool as init-required:
  // `deploy_eoa` is latched at deploy and the first add_liquidity reverts
  // with "!init" until the deployer runs the one-time `initialize`. Use it
  // to set the live reference split (per-pool reserved fraction,
  // admin_fee = 0 — exactly what the Rust port models), no policy hook,
  // the same initial price the factory seeded, and no LP allowlist.
  await (cPool as any)
    .connect(owner)
    .initialize(CURVE_RESERVED_PROFIT_FRACTION, 0n, hre.ethers.ZeroAddress, cInitialPrice, []);

  // Semantic self-check: the pool's `ma_time()` view (tau * 694 / 1000)
  // must read back exactly the preset's view-space value. Guards the
  // tau <-> half-life contract between the deploy argument above and
  // the `curveMaTime` trace field the Rust side consumes.
  expect(await (cPool as any).ma_time()).to.equal(BigInt(CURVE_MA_TIME));

  for (const acct of [owner, trader]) {
    await usdt.connect(acct).approve(cPoolAddr, MaxUint256);
    await weth.connect(acct).approve(cPoolAddr, MaxUint256);
  }

  // Seed initial liquidity. Seeded amounts are passed in the same
  // (token0, token1) order the pool was deployed with.
  await (cPool as any)
    .connect(owner)
    ["add_liquidity(uint256[2],uint256,address,bool)"]([RESERVE_USDT, RESERVE_WETH], 0n, owner.address, false);

  const initTs = Number((await hre.ethers.provider.getBlock(await hre.ethers.provider.getBlockNumber()))!.timestamp);

  return {
    owner,
    trader,
    isUsdtToken0,
    usdt,
    weth,
    token0,
    token1,
    token0Addr: (await token0.getAddress()).toLowerCase(),
    token1Addr: (await token1.getAddress()).toLowerCase(),
    cPool,
    cPoolAddr: cPoolAddr.toLowerCase(),
    initTs,
  };
}

async function snapshotCurve(f: Fixture): Promise<CurveState> {
  const cPool: any = f.cPool;
  const [
    reserve0,
    reserve1,
    totalSupply,
    d,
    priceScale,
    priceOracle,
    lastPrices,
    lastTimestamp,
    virtualPrice,
    xcpProfit,
    lpXcpProfit,
  ] = await Promise.all([
    cPool.balances(0),
    cPool.balances(1),
    cPool.totalSupply(),
    cPool.D(),
    cPool.price_scale(),
    cPool.price_oracle(),
    cPool.last_prices(),
    cPool.last_timestamp(),
    cPool.virtual_price(),
    cPool.xcp_profit(),
    cPool.lp_xcp_profit(),
  ]);
  return {
    reserve0: BigInt(reserve0),
    reserve1: BigInt(reserve1),
    totalSupply: BigInt(totalSupply),
    d: BigInt(d),
    priceScale: BigInt(priceScale),
    priceOracle: BigInt(priceOracle),
    lastPrices: BigInt(lastPrices),
    lastTimestamp: BigInt(lastTimestamp),
    virtualPrice: BigInt(virtualPrice),
    xcpProfit: BigInt(xcpProfit),
    lpXcpProfit: BigInt(lpXcpProfit),
  };
}

async function execAction(
  f: Fixture,
  action: Action,
  ts: number
): Promise<{
  pre: CurveState;
  post: CurveState;
  amountOut?: bigint;
  amount0Used?: bigint;
  amount1Used?: bigint;
  mintedShares?: bigint;
  amount0Out?: bigint;
  amount1Out?: bigint;
}> {
  const pre = await snapshotCurve(f);
  await time.setNextBlockTimestamp(ts);

  if (action.kind === "swap") {
    const i = action.direction === "USDT_TO_WETH" ? 0 : 1;
    const j = 1 - i;
    const outToken = action.direction === "USDT_TO_WETH" ? f.weth : f.usdt;
    const balBefore = BigInt(await outToken.balanceOf(f.trader.address));
    await (f.cPool as any)
      .connect(f.trader)
      ["exchange(uint256,uint256,uint256,uint256,address)"](i, j, action.amountIn, 0n, f.trader.address);
    const balAfter = BigInt(await outToken.balanceOf(f.trader.address));
    const post = await snapshotCurve(f);
    return { pre, post, amountOut: balAfter - balBefore };
  }

  if (action.kind === "add") {
    const lpBalBefore = BigInt(await (f.cPool as any).balanceOf(f.owner.address));
    const t0Bal = BigInt(await f.token0.balanceOf(f.owner.address));
    const t1Bal = BigInt(await f.token1.balanceOf(f.owner.address));
    await (f.cPool as any)
      .connect(f.owner)
      ["add_liquidity(uint256[2],uint256,address,bool)"]([action.amount0, action.amount1], 0n, f.owner.address, false);
    const lpBalAfter = BigInt(await (f.cPool as any).balanceOf(f.owner.address));
    const t0BalAfter = BigInt(await f.token0.balanceOf(f.owner.address));
    const t1BalAfter = BigInt(await f.token1.balanceOf(f.owner.address));
    const post = await snapshotCurve(f);
    return {
      pre,
      post,
      mintedShares: lpBalAfter - lpBalBefore,
      amount0Used: t0Bal - t0BalAfter,
      amount1Used: t1Bal - t1BalAfter,
    };
  }

  // remove
  const t0Bal = BigInt(await f.token0.balanceOf(f.owner.address));
  const t1Bal = BigInt(await f.token1.balanceOf(f.owner.address));
  await (f.cPool as any)
    .connect(f.owner)
    ["remove_liquidity(uint256,uint256[2],address)"](action.shares, [0n, 0n], f.owner.address);
  const t0BalAfter = BigInt(await f.token0.balanceOf(f.owner.address));
  const t1BalAfter = BigInt(await f.token1.balanceOf(f.owner.address));
  const post = await snapshotCurve(f);
  return {
    pre,
    post,
    amount0Out: t0BalAfter - t0Bal,
    amount1Out: t1BalAfter - t1Bal,
  };
}

type RustState = {
  reserve0?: string;
  reserve1?: string;
  totalSupply?: string;
  curveD?: string;
  curvePriceScale?: string;
  curvePriceOracle?: string;
  curveLastPrices?: string;
  curveLastTimestamp?: string;
  curveVirtualPrice?: string;
  curveXcpProfit?: string;
  curveLpXcpProfit?: string;
};

type RustStep = {
  action: string;
  amountIn?: string;
  amountOut?: string;
  amount0?: string;
  amount1?: string;
  mintedLiquidity?: string;
  amount0Out?: string;
  amount1Out?: string;
  pre: RustState;
  post: RustState;
};

type RustOut = { steps: RustStep[] };

function buildTraceInput(f: Fixture, initialState: CurveState, steps: RecordedStep[]) {
  const pool: Record<string, unknown> = {
    contextName: "curve-parity",
    amm: "curve",
    baseSymbol: "WETH",
    token0: f.token0Addr,
    token1: f.token1Addr,
    // Opaque symbols: the trace format carries explicit decimals below,
    // so the pool never consults the simulator's canonical symbol table.
    token0Symbol: "TKA",
    token1Symbol: "TKB",
    token0Decimals: 18,
    token1Decimals: 18,
    reserve0: initialState.reserve0.toString(),
    reserve1: initialState.reserve1.toString(),
    feeBps: Number(CURVE_MID_FEE / 10n ** 6n) || 0,
    totalSupply: initialState.totalSupply.toString(),
    curveA: CURVE_A.toString(),
    curveGamma: CURVE_GAMMA.toString(),
    curveMidFee: CURVE_MID_FEE.toString(),
    curveOutFee: CURVE_OUT_FEE.toString(),
    curveFeeGamma: CURVE_FEE_GAMMA.toString(),
    curveAdjustmentStepMin: CURVE_ADJ_STEP_MIN.toString(),
    curveAdjustmentStepMax: CURVE_ADJ_STEP_MAX.toString(),
    curveReservedProfitFraction: CURVE_RESERVED_PROFIT_FRACTION.toString(),
    curveMaTime: CURVE_MA_TIME.toString(),
    curvePriceScale: initialState.priceScale.toString(),
    curveD: initialState.d.toString(),
    curvePriceOracle: initialState.priceOracle.toString(),
    curveLastPrices: initialState.lastPrices.toString(),
    curveLastTimestamp: initialState.lastTimestamp.toString(),
    curveVirtualPrice: initialState.virtualPrice.toString(),
    curveXcpProfit: initialState.xcpProfit.toString(),
    curveLpXcpProfit: initialState.lpXcpProfit.toString(),
    curveTotalSupply: initialState.totalSupply.toString(),
    // The on-chain Twocrypto pool delegates `newton_D` / `get_y` /
    // `get_p` to an EXTERNAL math contract injected at deploy time
    // via `MATH = Math(_math)` (see Twocrypto.vy `__init__`). The
    // factory in our test mounts `StableswapMath`
    // (`set_math_implementation(cMath)`), so the live pool runs
    // stableswap math. The Rust kernel must use the matching mode —
    // that's `CURVE.mathMode == "stableswap"` from the simulator
    // defaults.
    curveMathMode: CURVE.mathMode,
  };

  const stepPayloads = steps.map((s) => {
    if (s.action.kind === "swap") {
      return {
        action: "swap",
        tokenIn: s.action.direction === "USDT_TO_WETH" ? f.token0Addr : f.token1Addr,
        amountIn: s.action.amountIn.toString(),
        timestamp: s.timestamp,
      };
    }
    if (s.action.kind === "add") {
      return {
        action: "addLiquidity",
        amount0: s.action.amount0.toString(),
        amount1: s.action.amount1.toString(),
        timestamp: s.timestamp,
      };
    }
    return {
      action: "removeLiquidity",
      liquidity: s.action.shares.toString(),
      timestamp: s.timestamp,
    };
  });

  return {
    startTimestamp: f.initTs,
    pool,
    steps: stepPayloads,
  };
}

function assertStateEq(
  label: string,
  onchain: CurveState,
  rust: RustState,
  // Whether to compare the live oracle (`price_oracle()`). On-chain
  // `price_oracle()` is a view that decays the cached value to
  // `block.timestamp` on every read, while Rust trace output emits
  // the **cached** value. The two agree only when `block.timestamp
  // == last_timestamp_storage` — i.e. when the action that produced
  // this snapshot updated the EMA. For actions that don't touch the
  // EMA (`remove_liquidity`), pass `compareOracle=false` and the
  // assertion drops oracle comparison while keeping reserves / D /
  // totalSupply / virtualPrice / xcp_profit / last_prices /
  // last_timestamp checks strict.
  compareOracle: boolean
) {
  expect(BigInt(rust.reserve0!), `${label}: reserve0`).to.equal(onchain.reserve0);
  expect(BigInt(rust.reserve1!), `${label}: reserve1`).to.equal(onchain.reserve1);
  expect(BigInt(rust.totalSupply!), `${label}: totalSupply`).to.equal(onchain.totalSupply);
  expect(BigInt(rust.curveD!), `${label}: D`).to.equal(onchain.d);
  expect(BigInt(rust.curvePriceScale!), `${label}: priceScale`).to.equal(onchain.priceScale);
  if (compareOracle) {
    expect(BigInt(rust.curvePriceOracle!), `${label}: priceOracle`).to.equal(onchain.priceOracle);
  }
  expect(BigInt(rust.curveLastPrices!), `${label}: lastPrices`).to.equal(onchain.lastPrices);
  expect(BigInt(rust.curveLastTimestamp!), `${label}: lastTimestamp`).to.equal(onchain.lastTimestamp);
  expect(BigInt(rust.curveVirtualPrice!), `${label}: virtualPrice`).to.equal(onchain.virtualPrice);
  expect(BigInt(rust.curveXcpProfit!), `${label}: xcpProfit`).to.equal(onchain.xcpProfit);
  expect(BigInt(rust.curveLpXcpProfit!), `${label}: lpXcpProfit`).to.equal(onchain.lpXcpProfit);
}

describe("Curve V2 parity (real Vyper bytecode vs Rust simulator)", function () {
  before(function () {
    // Optional fixture: the pre-compiled Vyper artifacts are local-only
    // and never published. Skip (not fail) when absent.
    if (!curveArtifactsPresent) this.skip();
  });

  this.timeout(600_000);

  it("matches bit-exactly across a mixed-action scenario (WETH preset)", async function () {
    const f = await deployCurve();

    // Initial state (right after the seed mint).
    const initialState = await snapshotCurve(f);
    let current = initialState;

    // Deterministic mixed-action plan. Spacing of 60 s between steps
    // lets the EMA decay non-trivially between updates so any drift
    // in the Rust EMA decay surfaces.
    const PLAN: { ts: number; action: Action }[] = [
      {
        ts: f.initTs + 60,
        action: {
          kind: "swap",
          direction: "USDT_TO_WETH",
          amountIn: 5_000n * WAD,
        },
      },
      {
        ts: f.initTs + 120,
        action: { kind: "swap", direction: "WETH_TO_USDT", amountIn: 2n * WAD },
      },
      {
        ts: f.initTs + 180,
        action: {
          kind: "swap",
          direction: "USDT_TO_WETH",
          amountIn: 25_000n * WAD,
        },
      },
      {
        ts: f.initTs + 240,
        action: { kind: "add", amount0: 50_000n * WAD, amount1: 25n * WAD },
      },
      {
        ts: f.initTs + 300,
        action: {
          kind: "swap",
          direction: "USDT_TO_WETH",
          amountIn: 10_000n * WAD,
        },
      },
      {
        ts: f.initTs + 360,
        action: { kind: "swap", direction: "WETH_TO_USDT", amountIn: 8n * WAD },
      },
      // Burn 5% of LP supply (we own everything we just added + the
      // genesis seed). Picked off the live state to stay proportional
      // to whatever the prior steps left.
      {
        ts: f.initTs + 420,
        action: { kind: "remove", shares: 0n /* set below */ },
      },
      {
        ts: f.initTs + 480,
        action: {
          kind: "swap",
          direction: "USDT_TO_WETH",
          amountIn: 7_000n * WAD,
        },
      },
    ];
    // Resolve the dynamic remove-shares amount.
    const lpOwner = BigInt(await (f.cPool as any).balanceOf(f.owner.address));
    PLAN[6].action = { kind: "remove", shares: (lpOwner * 500n) / 10_000n };

    const recorded: RecordedStep[] = [];
    for (const step of PLAN) {
      const result = await execAction(f, step.action, step.ts);
      recorded.push({
        action: step.action,
        timestamp: step.ts,
        amountIn: step.action.kind === "swap" ? step.action.amountIn : undefined,
        amountOut: result.amountOut,
        amount0Used: result.amount0Used,
        amount1Used: result.amount1Used,
        mintedShares: result.mintedShares,
        amount0Out: result.amount0Out,
        amount1Out: result.amount1Out,
        pre: result.pre,
        post: result.post,
      });
      current = result.post;
    }

    // Sanity: at least one swap actually drove the oracle forward
    // (otherwise the parity check is trivial — no EMA evolution).
    expect(current.lastTimestamp, "Curve oracle advanced").to.be.greaterThan(initialState.lastTimestamp);

    // Replay through Rust trace runner.
    const trace = buildTraceInput(f, initialState, recorded);
    const rust = runRustSimulatorTrace<RustOut>(trace);

    expect(rust.steps.length, "rust step count").to.equal(recorded.length);

    for (let i = 0; i < recorded.length; i++) {
      const step = recorded[i];
      const r = rust.steps[i];
      const label = `step#${i}[${step.action.kind}]`;

      // Pre-state oracle is comparable iff the previous action
      // updated the EMA at the SAME block we're now snapshotting at —
      // for our deterministic plan this is the immediately preceding
      // swap/add. The very first step's pre-state reads at the
      // deploy block (last_timestamp == block.timestamp), so always
      // comparable. After a `remove`, the on-chain view will have
      // decayed past the cached value at the next read, so skip
      // oracle compare in those cases.
      const prevWasNonEma = i > 0 && recorded[i - 1].action.kind === "remove";
      // Post-state oracle is comparable iff this step itself updated
      // the EMA (swap or add). `remove` doesn't touch the EMA so the
      // on-chain `price_oracle()` view drifts; we drop oracle compare
      // for the post snapshot and keep all reserve / D / vp /
      // xcp_profit assertions strict.
      const thisIsNonEma = step.action.kind === "remove";

      assertStateEq(`${label} pre`, step.pre, r.pre, !prevWasNonEma);
      assertStateEq(`${label} post`, step.post, r.post, !thisIsNonEma);

      if (step.action.kind === "swap") {
        expect(r.action, `${label} action`).to.equal("swap");
        expect(BigInt(r.amountIn ?? "0"), `${label} amountIn`).to.equal(step.action.amountIn);
        expect(BigInt(r.amountOut ?? "0"), `${label} amountOut`).to.equal(step.amountOut!);
      } else if (step.action.kind === "add") {
        expect(r.action, `${label} action`).to.equal("addLiquidity");
        expect(BigInt(r.amount0 ?? "0"), `${label} amount0Used`).to.equal(step.amount0Used!);
        expect(BigInt(r.amount1 ?? "0"), `${label} amount1Used`).to.equal(step.amount1Used!);
        expect(BigInt(r.mintedLiquidity ?? "0"), `${label} mintedShares`).to.equal(step.mintedShares!);
      } else {
        expect(r.action, `${label} action`).to.equal("removeLiquidity");
        expect(BigInt(r.amount0Out ?? "0"), `${label} amount0Out`).to.equal(step.amount0Out!);
        expect(BigInt(r.amount1Out ?? "0"), `${label} amount1Out`).to.equal(step.amount1Out!);
      }
    }

    // Compact terminal summary (helps when triaging future
    // regressions — shows what the scenario actually exercised).
    const swaps = recorded.filter((s) => s.action.kind === "swap").length;
    const adds = recorded.filter((s) => s.action.kind === "add").length;
    const removes = recorded.filter((s) => s.action.kind === "remove").length;
    console.log(
      `      [Curve] steps=${recorded.length}  swaps=${swaps}  adds=${adds}  removes=${removes}  D₀=${initialState.d}  D_final=${current.d}`
    );
  });
});
