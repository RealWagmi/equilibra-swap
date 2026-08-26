// EXPERIMENT (not part of any suite glob): does token0/token1 ordering
// change pool economics? Two pools with identical seeds and configs are
// deployed so that the 6-decimal "stable" lands as token0 in one and as
// token1 in the other. Every state-changing action (including pool
// creation) is executed for BOTH pools inside the SAME block, so the
// EMA/repeg time grid is identical and any divergence is attributable
// to the token-order representation alone.
//
// Tier 1: flat fee, auto-repeg off  -> pure curve-kernel mirror test.
// Tier 2: live ramp + EMA + repeg   -> full-pipeline mirror test.
import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MaxUint256 } from "ethers";

const STABLE_SEED = 1_000_000n * 10n ** 6n; // 1M, 6 decimals
const VOL_SEED = 500n * 10n ** 18n; // 500, 18 decimals

const BASE_CONFIG = {
  aWad: 909610000000000030n,
  lambdaWad: 16780000000000000n,
  baseFee: 282,
  emaPeriod: 600,
  repegStepWad: 5n * 10n ** 15n,
  repegThresholdToken1UpWad: 2n * 10n ** 15n,
  repegThresholdToken1DownWad: 2n * 10n ** 15n,
  feeRampBps: 5000,
  feeFloorBps: 136,
  repegShareBps: 7000,
};

// Send several raw calls into ONE block: disable automine, submit via
// bare eth_sendTransaction (returns tx hashes immediately), mine once,
// fetch receipts directly. No ethers response/wait plumbing — it is not
// reliable under automine=false.
type RawCall = { from: string; to: string; data: string };
async function inOneBlock(calls: RawCall[]): Promise<number[]> {
  await hre.network.provider.send("evm_setAutomine", [false]);
  try {
    const hashes: string[] = [];
    for (const c of calls) {
      hashes.push(
        await hre.network.provider.send("eth_sendTransaction", [
          { from: c.from, to: c.to, data: c.data, gas: "0x4c4b40" }, // 5M
        ])
      );
    }
    await hre.network.provider.send("evm_mine");
    const blocks: number[] = [];
    for (const h of hashes) {
      const rc = await hre.network.provider.send("eth_getTransactionReceipt", [h]);
      if (!rc || rc.status !== "0x1") {
        throw new Error(`batched tx failed or not mined: ${h} status=${rc?.status}`);
      }
      blocks.push(parseInt(rc.blockNumber, 16));
    }
    return blocks;
  } finally {
    await hre.network.provider.send("evm_setAutomine", [true]);
  }
}

async function deployMirrorFixture(config: typeof BASE_CONFIG) {
  const [owner, trader] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");

  const stables: any[] = [];
  const vols: any[] = [];
  for (let i = 0; i < 6; i++) {
    stables.push(await Token.deploy(`S${i}`, `S${i}`, 6));
    vols.push(await Token.deploy(`V${i}`, `V${i}`, 18));
  }
  const addr = async (t: any) => (await t.getAddress()).toLowerCase();

  let pairA: [any, any] | null = null; // stable < vol  -> stable is token0
  let pairB: [any, any] | null = null; // vol < stable  -> stable is token1
  for (const s of stables) {
    for (const v of vols) {
      if (!pairA && (await addr(s)) < (await addr(v))) pairA = [s, v];
      if (!pairB && (await addr(v)) < (await addr(s))) pairB = [s, v];
    }
  }
  if (!pairA || !pairB) throw new Error("could not find both sort orders among candidates");

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  const factoryAddr = await factory.getAddress();
  const WETH9 = await hre.ethers.getContractFactory("MockWETH9");
  const weth9 = await WETH9.deploy();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth9.getAddress());
  const routerAddr = await router.getAddress();

  for (const [s, v] of [pairA, pairB]) {
    await s.mint(owner.address, STABLE_SEED * 4n);
    await s.connect(owner).approve(factoryAddr, MaxUint256);
    await s.mint(trader.address, STABLE_SEED * 100n);
    await s.connect(trader).approve(routerAddr, MaxUint256);
    await v.mint(owner.address, VOL_SEED * 4n);
    await v.connect(owner).approve(factoryAddr, MaxUint256);
    await v.mint(trader.address, VOL_SEED * 100n);
    await v.connect(trader).approve(routerAddr, MaxUint256);
  }

  // Create BOTH pools in the same block so genesis EMA timestamps match.
  const cfgTuple = (c: typeof BASE_CONFIG) => ({
    aWad: c.aWad,
    lambdaWad: c.lambdaWad,
    baseFee: c.baseFee,
    emaPeriod: c.emaPeriod,
    repegStepWad: c.repegStepWad,
    repegThresholdToken1UpWad: c.repegThresholdToken1UpWad,
    repegThresholdToken1DownWad: c.repegThresholdToken1DownWad,
    feeRampBps: c.feeRampBps,
    feeFloorBps: c.feeFloorBps,
    repegShareBps: c.repegShareBps,
  });
  const mkCreate = (s: any, v: any) => ({
    from: owner.address,
    to: factoryAddr,
    data: factory.interface.encodeFunctionData("createPoolAndAddLiquidity", [
      s.target,
      v.target,
      cfgTuple(config),
      STABLE_SEED,
      VOL_SEED,
      owner.address,
    ]),
  });
  const genesisBlocks = await inOneBlock([mkCreate(pairA[0], pairA[1]), mkCreate(pairB[0], pairB[1])]);
  if (genesisBlocks[0] !== genesisBlocks[1]) {
    throw new Error(`genesis not co-blocked: ${genesisBlocks.join(",")}`);
  }

  const poolA = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
  const poolB = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(1));

  const metaA = await poolA.getPoolMetadata();
  const metaB = await poolB.getPoolMetadata();
  expect(metaA.token0).to.equal(await pairA[0].getAddress()); // stable IS token0 in A
  expect(metaB.token0).to.equal(await pairB[1].getAddress()); // vol IS token0 in B

  return { owner, trader, router, poolA, poolB, pairA, pairB };
}

type Diffs = {
  maxOut: bigint;
  maxStableReserve: bigint;
  maxVolReserve: bigint;
  maxVp: bigint;
  psDev: bigint;
  repegsA: number;
  repegsB: number;
};

async function runMirrorScenario(config: typeof BASE_CONFIG): Promise<Diffs> {
  const fx = await deployMirrorFixture(config);
  const { trader, router } = fx;

  function swapParams(pool: "A" | "B", dir: "stableToVol" | "volToStable") {
    const [stable, vol] = pool === "A" ? fx.pairA : fx.pairB;
    const tokenIn = dir === "stableToVol" ? stable : vol;
    const tokenOut = dir === "stableToVol" ? vol : stable;
    return { tokenIn, tokenOut };
  }

  const script: Array<["stableToVol" | "volToStable", bigint]> = [
    ["stableToVol", 50_000n * 10n ** 6n],
    ["stableToVol", 120_000n * 10n ** 6n],
    ["volToStable", 30n * 10n ** 18n],
    ["stableToVol", 200_000n * 10n ** 6n],
    ["volToStable", 55n * 10n ** 18n],
    ["stableToVol", 90_000n * 10n ** 6n],
    ["stableToVol", 150_000n * 10n ** 6n],
    ["volToStable", 10n * 10n ** 18n],
  ];

  const d: Diffs = {
    maxOut: 0n,
    maxStableReserve: 0n,
    maxVolReserve: 0n,
    maxVp: 0n,
    psDev: 0n,
    repegsA: 0,
    repegsB: 0,
  };
  const absd = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

  for (const [dir, amountIn] of script) {
    const a = swapParams("A", dir);
    const b = swapParams("B", dir);
    const mk = (p: { tokenIn: any; tokenOut: any }) => ({
      tokenIn: (p.tokenIn as any).target,
      tokenOut: (p.tokenOut as any).target,
      poolIndex: 0,
      recipient: trader.address,
      amountIn,
      amountOutMinimum: 0,
      deadline: MaxUint256,
    });
    // Measure both outputs against the same pre-state, then execute both
    // swaps in ONE block so the EMA sees identical timestamps.
    const outA = await router.connect(trader).exactInputSingle.staticCall(mk(a));
    const outB = await router.connect(trader).exactInputSingle.staticCall(mk(b));
    d.maxOut = d.maxOut > absd(outA, outB) ? d.maxOut : absd(outA, outB);
    const routerAddr = (router as any).target;
    const mkRaw = (p: ReturnType<typeof mk>) => ({
      from: trader.address,
      to: routerAddr,
      data: router.interface.encodeFunctionData("exactInputSingle", [p]),
    });
    const blocks = await inOneBlock([mkRaw(mk(a)), mkRaw(mk(b))]);
    if (blocks[0] !== blocks[1]) {
      throw new Error(`swaps not co-blocked: ${blocks.join(",")}`);
    }
    await time.increase(120);

    const [ra0, ra1] = await fx.poolA.getReserves();
    const [rb0, rb1] = await fx.poolB.getReserves();
    const lpA = await fx.poolA.getLpValueState();
    const lpB = await fx.poolB.getLpValueState();
    d.maxStableReserve = d.maxStableReserve > absd(ra0, rb1) ? d.maxStableReserve : absd(ra0, rb1);
    d.maxVolReserve = d.maxVolReserve > absd(ra1, rb0) ? d.maxVolReserve : absd(ra1, rb0);
    d.maxVp =
      d.maxVp > absd(BigInt(lpA.unitValueWad), BigInt(lpB.unitValueWad))
        ? d.maxVp
        : absd(BigInt(lpA.unitValueWad), BigInt(lpB.unitValueWad));
  }

  const oA = await fx.poolA.getOracleState();
  const oB = await fx.poolB.getOracleState();
  const psA = BigInt(oA.priceScaleWad);
  const psB = BigInt(oB.priceScaleWad);
  const WAD = 10n ** 18n;
  const psProduct = (psA * psB) / WAD;
  d.psDev = psProduct > WAD ? psProduct - WAD : WAD - psProduct;
  // EMA reciprocity probe: emaA tracks p, emaB tracks 1/p. The
  // geometric (log-domain) EMA is reciprocal-invariant, so
  // emaA·emaB must sit at WAD² up to fixed-point dust; the logged
  // deviation is the observed residual.
  const emaA = BigInt(oA.emaPriceWad);
  const emaB = BigInt(oB.emaPriceWad);
  const emaProduct = (emaA * emaB) / WAD;
  const emaDev = emaProduct > WAD ? emaProduct - WAD : WAD - emaProduct;
  console.log("      [ema] emaA*emaB/WAD dev from WAD (wei):", emaDev.toString());

  const evA = await fx.poolA.queryFilter(fx.poolA.filters.PriceScaleUpdated());
  const evB = await fx.poolB.queryFilter(fx.poolB.filters.PriceScaleUpdated());
  d.repegsA = evA.length;
  d.repegsB = evB.length;
  console.log(
    "      [repeg blocks] A:",
    evA.map((e) => e.blockNumber).join(","),
    " B:",
    evB.map((e) => e.blockNumber).join(",")
  );
  return d;
}

describe("token order mirror experiment", function () {
  it("tier 1: pure kernel (flat fee, repeg off) mirrors", async function () {
    const d = await runMirrorScenario({
      ...BASE_CONFIG,
      feeRampBps: 0,
      feeFloorBps: 282,
      repegShareBps: 0,
    });
    console.log("      [tier1] max output diff (wei):        ", d.maxOut.toString());
    console.log("      [tier1] max stable-reserve diff (raw):", d.maxStableReserve.toString());
    console.log("      [tier1] max vol-reserve diff (wei):   ", d.maxVolReserve.toString());
    console.log("      [tier1] max vp diff (wei):            ", d.maxVp.toString());
    console.log("      [tier1] psA*psB/WAD dev (wei):        ", d.psDev.toString());
    console.log("      [tier1] repegs A/B:                   ", d.repegsA, d.repegsB);
  });

  it("tier 1.5: flat fee + repeg ON (isolates the repeg path)", async function () {
    const d = await runMirrorScenario({
      ...BASE_CONFIG,
      feeRampBps: 0,
      feeFloorBps: 282,
    });
    console.log("      [tier1.5] max output diff (wei):        ", d.maxOut.toString());
    console.log("      [tier1.5] max stable-reserve diff (raw):", d.maxStableReserve.toString());
    console.log("      [tier1.5] max vol-reserve diff (wei):   ", d.maxVolReserve.toString());
    console.log("      [tier1.5] max vp diff (wei):            ", d.maxVp.toString());
    console.log("      [tier1.5] psA*psB/WAD dev (wei):        ", d.psDev.toString());
    console.log("      [tier1.5] repegs A/B:                   ", d.repegsA, d.repegsB);
  });

  it("tier 2: full pipeline (ramp + EMA + repeg) mirrors", async function () {
    const d = await runMirrorScenario(BASE_CONFIG);
    console.log("      [tier2] max output diff (wei):        ", d.maxOut.toString());
    console.log("      [tier2] max stable-reserve diff (raw):", d.maxStableReserve.toString());
    console.log("      [tier2] max vol-reserve diff (wei):   ", d.maxVolReserve.toString());
    console.log("      [tier2] max vp diff (wei):            ", d.maxVp.toString());
    console.log("      [tier2] psA*psB/WAD dev (wei):        ", d.psDev.toString());
    console.log("      [tier2] repegs A/B:                   ", d.repegsA, d.repegsB);
  });
});
