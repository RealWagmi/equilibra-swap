// Bit-exact parity between the Solidity exact-out path and the Rust
// off-chain simulator's `swap_stateful_exact_out`.
//
// What this test guards
// ---------------------
//   The on-chain `EquilibraPool._executeExactOutWithDynamicFee` is the
//   single resolver shared by both `quoteExactOut(amountOut)` and the
//   live `exactOutputSingle(amountOut, ...)` swap path. After the
//   2026-05 unification commit the two on-chain paths are bit-exact;
//   the off-chain Rust kernel must mirror the same closed form
//   (CP-projected post-state fee resolver, non-iterative endpoint-max
//   over the realisable gross interval `[grossUp(clean, feeFloor),
//   grossUp(clean, baseFee)]`, gross-up `ceil`, +1 wei safety bump).
//   Any drift between Solidity and Rust here
//   means the dashboard / report layer would mis-price an exact-out
//   swap by at least one wei, and the simparity guarantee for the
//   exact-in path no longer extends to its dual.
//
// What this test asserts (per (preset, direction, size) cell)
// -----------------------------------------------------------
//   1. `rust_amountIn === sol_quoteAmountIn`
//      (the Rust trace runner's `swapExactOut` action returns the
//       same `amountIn` Solidity's `quoteExactOut` does).
//   2. `sol_quoteAmountIn === sol_realisedAmountIn`
//      (the on-chain `quoteExactOut` matches what the live
//       `exactOutputSingle` actually charged — already covered
//       inside the security suite, replayed here for honesty
//       so a regression in the Solidity unification cannot hide
//       behind the Rust comparison).
//   3. Output: `sol_realisedAmountOut === amountOut`
//      (the swap delivered the requested target exactly — there is
//       no ambiguous +1 wei delivery on the user side).
//
// Coverage
// --------
//   * Both canonical presets (WETH, WBTC) under their full active
//     dynamic-fee ramp, sourced from `simulator/src/app/config.rs`.
//   * Both swap directions (token0 → token1, token1 → token0).
//   * Six probe sizes from 1 unit up to ~30% of the seed reserve.
//   * One disabled-ramp pin (`feeRampBps == 0`) per preset to make
//     sure the flat-fee branch is also bit-exact (the endpoint-max
//     resolver short-circuits to `baseFee` when the ramp is off).
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { execExactOutputViaRustTrace, type SnapshotForRustQuote } from "../../simulator/test_helpers/rustTestUtils";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

type PresetName = "WETH" | "WBTC";

type FixtureOpts = {
  baseFee?: number;
  feeRampBps?: number;
  feeFloorBps?: number;
  repegShareBps?: number;
  aWad?: bigint;
  lambdaWad?: bigint;
  emaPeriod?: number;
  repegStepWad?: bigint;
  repegThresholdWad?: bigint;
  seed0?: bigint;
  seed1?: bigint;
};

type PoolFixture = {
  owner: any;
  trader: any;
  token0: any;
  token1: any;
  factory: any;
  pool: any;
  router: any;
  poolAddress: string;
  token0Addr: string;
  token1Addr: string;
  presetName: PresetName;
  baseFee: number;
  feeRampBps: number;
  feeFloorBps: number;
  repegShareBps: number;
  aWad: bigint;
  lambdaWad: bigint;
  emaPeriod: number;
  repegStepWad: bigint;
  repegThresholdWad: bigint;
  initTs: number;
};

// Build a fresh pool at a deterministic `initTs`. The timestamp is
// pinned via `time.setNextBlockTimestamp` on the *next* block, so the
// EVM tags the creation tx with the exact value we pass into Rust.
async function deployParityPool(presetName: PresetName, opts: FixtureOpts = {}): Promise<PoolFixture> {
  const preset = EQUILIBRA_PRESETS[presetName];
  const baseFee = opts.baseFee ?? preset.feeBps;
  const feeRampBps = opts.feeRampBps ?? preset.feeRampBps;
  const feeFloorBps = opts.feeFloorBps ?? preset.feeFloorBps;
  const repegShareBps = opts.repegShareBps ?? preset.repegShareBps;
  const aWad = opts.aWad ?? preset.aWad;
  const lambdaWad = opts.lambdaWad ?? preset.lambdaWad;
  const emaPeriod = opts.emaPeriod ?? preset.emaPeriod;
  const repegStepWad = opts.repegStepWad ?? preset.repegStepWad;
  // Dead-band defaults to the resolved step so the activation gate stays
  // coupled to the step cap across the whole parity sweep.
  const repegThresholdWad = opts.repegThresholdWad ?? repegStepWad;
  const seed0 = opts.seed0 ?? hre.ethers.parseEther("1000000");
  const seed1 = opts.seed1 ?? hre.ethers.parseEther("1000000");

  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token0", "TK0", 18);
  const tokenB = await Token.deploy("Token1", "TK1", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const aAddr = (await tokenA.getAddress()).toLowerCase();
  const bAddr = (await tokenB.getAddress()).toLowerCase();
  const [token0, token1] = aAddr < bAddr ? [tokenA, tokenB] : [tokenB, tokenA];

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();
  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  const bankroll = (seed0 + seed1) * 4n;
  await token0.mint(owner.address, bankroll);
  await token1.mint(owner.address, bankroll);
  await token0.mint(trader.address, bankroll);
  await token1.mint(trader.address, bankroll);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  await token0.connect(trader).approve(await router.getAddress(), MaxUint256);
  await token1.connect(trader).approve(await router.getAddress(), MaxUint256);

  const nowTs = await time.latest();
  const initTs = nowTs + 100;
  await time.setNextBlockTimestamp(initTs);

  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad,
      lambdaWad,
      baseFee,
      emaPeriod,
      repegStepWad,
      repegThresholdToken1UpWad: repegThresholdWad,
      repegThresholdToken1DownWad: repegThresholdWad,
      feeRampBps,
      feeFloorBps,
      repegShareBps,
    },
    seed0,
    seed1,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
  const tok0Addr = await token0.getAddress();
  const tok1Addr = await token1.getAddress();

  return {
    owner,
    trader,
    token0,
    token1,
    factory,
    pool,
    router,
    poolAddress,
    token0Addr: tok0Addr,
    token1Addr: tok1Addr,
    presetName,
    baseFee,
    feeRampBps,
    feeFloorBps,
    repegShareBps,
    aWad,
    lambdaWad,
    emaPeriod,
    repegStepWad,
    repegThresholdWad,
    initTs,
  };
}

async function snapshotPool(f: PoolFixture): Promise<SnapshotForRustQuote> {
  const [r0, r1] = await f.pool.getReserves();
  const oracle = await f.pool.getOracleState();
  const lpState = await f.pool.getLpValueState();
  const [pFee0, pFee1] = await f.pool.getProtocolFees();
  const fee = await f.pool.getFeeConfig();

  const bal0 = await f.token0.balanceOf(f.poolAddress);
  const bal1 = await f.token1.balanceOf(f.poolAddress);

  return {
    poolKey: "exact-out-parity",
    amm: "equilibra",
    token0: f.token0Addr,
    token1: f.token1Addr,
    token0Symbol: "TK0",
    token1Symbol: "TK1",
    // 18-dec mocks (see the fixture's MockERC20 deployments); the trace
    // format requires explicit decimals for synthetic symbols.
    token0Decimals: 18,
    token1Decimals: 18,
    reserve0: BigInt(r0),
    reserve1: BigInt(r1),
    feeBps: Number(fee.baseFee),
    aWad: f.aWad,
    lambdaWad: f.lambdaWad,
    equilibraProtocolFeePercent: BigInt(fee.protocolFeePercent),
    equilibraEmaPeriod: BigInt(f.emaPeriod),
    equilibraFeeRampBps: BigInt(fee.feeRampBps),
    equilibraFeeFloorBps: BigInt(fee.feeFloorBps),
    equilibraRepegShareBps: BigInt(fee.repegShareBps),
    equilibraProtocolFee0: BigInt(pFee0),
    equilibraProtocolFee1: BigInt(pFee1),
    equilibraE0: BigInt(bal0),
    equilibraE1: BigInt(bal1),
    equilibraEmaPrice: BigInt(oracle.emaPriceWad),
    equilibraLastTimestamp: BigInt(f.initTs),
    equilibraLastRecenterTimestamp: BigInt(f.initTs),
    equilibraRepegStepWad: BigInt(f.repegStepWad),
    equilibraRepegThresholdToken1UpWad: BigInt(f.repegThresholdWad),
    equilibraRepegThresholdToken1DownWad: BigInt(f.repegThresholdWad),
    equilibraAnchorPriceWad: BigInt(oracle.priceScaleWad),
    equilibraLpUnitValueGenesisWad: BigInt(lpState.genesisWad),
    equilibraLpUnitValueWad: BigInt(lpState.unitValueWad),
    equilibraLpValueGrowthWad: BigInt(lpState.growthWad),
  };
}

type ExactOutSwapResult = {
  realisedAmountIn: bigint;
  realisedAmountOut: bigint;
  feeAmount: bigint;
};

async function execExactOut(
  f: PoolFixture,
  amountOutRaw: bigint,
  tokenIn: "token0" | "token1",
  swapTs: number
): Promise<ExactOutSwapResult> {
  const { router, trader, token0Addr, token1Addr, pool, poolAddress } = f;
  const [inAddr, outAddr] = tokenIn === "token0" ? [token0Addr, token1Addr] : [token1Addr, token0Addr];

  await time.setNextBlockTimestamp(swapTs);
  const tx = await router.connect(trader).exactOutputSingle({
    tokenIn: inAddr,
    tokenOut: outAddr,
    poolIndex: 0,
    recipient: trader.address,
    amountOut: amountOutRaw,
    amountInMaximum: MaxUint256,
    deadline: swapTs + 60,
  });
  const receipt = await tx.wait();

  const swapTopic = pool.interface.getEvent("Swap").topicHash;
  const log = receipt!.logs.find(
    (l: any) => l.address.toLowerCase() === poolAddress.toLowerCase() && l.topics[0] === swapTopic
  );
  if (!log) throw new Error("Swap event not found in receipt");
  const parsed = pool.interface.decodeEventLog("Swap", log!.data, log!.topics);

  return {
    realisedAmountIn: BigInt(parsed.amountIn),
    realisedAmountOut: BigInt(parsed.amountOut),
    feeAmount: BigInt(parsed.feeAmount),
  };
}

async function capturePostStateOnchain(f: PoolFixture) {
  const [r0, r1] = await f.pool.getReserves();
  const oracle = await f.pool.getOracleState();
  const lpState = await f.pool.getLpValueState();
  const [pFee0, pFee1] = await f.pool.getProtocolFees();
  return {
    reserve0: BigInt(r0),
    reserve1: BigInt(r1),
    protocolFee0: BigInt(pFee0),
    protocolFee1: BigInt(pFee1),
    anchorPriceWad: BigInt(oracle.priceScaleWad),
    emaPriceWad: BigInt(oracle.emaPriceWad),
    lpUnitValueGenesisWad: BigInt(lpState.genesisWad),
    lpUnitValueWad: BigInt(lpState.unitValueWad),
    lpValueGrowthWad: BigInt(lpState.growthWad),
  };
}

async function assertExactOutParity(f: PoolFixture, amountOut: bigint, label: string, tokenIn: "token0" | "token1") {
  // Snapshot the pre-swap state so Rust replays from the same vantage
  // point as the on-chain EVM tx.
  const snapshot = await snapshotPool(f);
  const swapTs = f.initTs + 1;

  const inAddr = tokenIn === "token0" ? f.token0Addr : f.token1Addr;
  const zeroForOne = tokenIn === "token0";

  // Solidity quote (the unified resolver — same value the live
  // `exactOutputSingle` will pull from the user).
  const sol_quoteAmountIn: bigint = BigInt(await f.pool.quoteExactOut(zeroForOne, amountOut));

  // Rust trace replay of the same exact-out swap (full step output so
  // we can compare the post-state below).
  const rust = await execExactOutputViaRustTrace({
    snapshot,
    baseSymbol: f.presetName,
    tokenIn: inAddr,
    amountOut,
    poolAddress: f.poolAddress,
    timestamp: swapTs,
  });
  const rust_amountIn = rust.amountIn;
  const rust_post = rust.step.post;

  // Live on-chain swap — runs the same `_executeExactOutWithDynamicFee`
  // helper as `quoteExactOut`, so the realised input amount must
  // equal the quote bit-for-bit.
  const live = await execExactOut(f, amountOut, tokenIn, swapTs);
  const livePost = await capturePostStateOnchain(f);

  expect(
    rust_amountIn,
    `${label}: Rust amountIn=${rust_amountIn} ≠ Solidity quoteExactOut amountIn=${sol_quoteAmountIn}`
  ).to.equal(sol_quoteAmountIn);
  expect(
    live.realisedAmountIn,
    `${label}: live amountIn=${live.realisedAmountIn} ≠ Solidity quoteExactOut amountIn=${sol_quoteAmountIn} (Solidity unification regression)`
  ).to.equal(sol_quoteAmountIn);
  expect(
    live.realisedAmountOut,
    `${label}: live amountOut=${live.realisedAmountOut} ≠ requested amountOut=${amountOut}`
  ).to.equal(amountOut);

  // Post-state parity. The Rust trace runner serializes the same
  // pool-storage fields the on-chain pool exposes; any drift here
  // means the simulator's reserve / EMA / repeg / LP-value pipeline
  // diverges from the Solidity exact-out swap. No tolerance.
  expect(rust_post, `${label}: rust trace step missing post snapshot`).to.exist;
  expect(BigInt(rust_post!.reserve0!), `${label}: post reserve0`).to.equal(livePost.reserve0);
  expect(BigInt(rust_post!.reserve1!), `${label}: post reserve1`).to.equal(livePost.reserve1);
  expect(BigInt(rust_post!.protocolFee0!), `${label}: post protocolFee0`).to.equal(livePost.protocolFee0);
  expect(BigInt(rust_post!.protocolFee1!), `${label}: post protocolFee1`).to.equal(livePost.protocolFee1);
  expect(BigInt(rust_post!.equilibraAnchorPriceWad!), `${label}: post anchorPriceWad`).to.equal(
    livePost.anchorPriceWad
  );
  expect(BigInt(rust_post!.equilibraEmaPrice!), `${label}: post emaPriceWad`).to.equal(livePost.emaPriceWad);
  expect(BigInt(rust_post!.equilibraLpUnitValueGenesisWad!), `${label}: post lpUnitValueGenesisWad`).to.equal(
    livePost.lpUnitValueGenesisWad
  );
  expect(BigInt(rust_post!.equilibraLpUnitValueWad!), `${label}: post lpUnitValueWad`).to.equal(
    livePost.lpUnitValueWad
  );
  expect(BigInt(rust_post!.equilibraLpValueGrowthWad!), `${label}: post lpValueGrowthWad`).to.equal(
    livePost.lpValueGrowthWad
  );
  // `_lastEmaTs` and `_lastRepegTs` have no public on-chain getter,
  // so we don't have a value to check the Rust trace against here.
  // GeneralRustParity already exercises both timestamps across its
  // long mixed-action scenarios via its TS-side tracker — adding a
  // duplicate mirror in this single-step suite would buy us nothing.
}

describe("ExactOut parity (on-chain vs Rust simulator)", function () {
  // Probe sizes are expressed in `parseEther` of the (uniform 18-dp)
  // mock tokens; with a 1e6 ETH-equivalent seed on each side, this
  // sweeps from dust (1 wei-of-ether) up to ~30% of the output
  // reserve.
  const SWEEP_OUTPUT_SIZES = [
    1n,
    hre.ethers.parseEther("0.000001"),
    hre.ethers.parseEther("1"),
    hre.ethers.parseEther("100"),
    hre.ethers.parseEther("10000"),
    hre.ethers.parseEther("100000"),
    hre.ethers.parseEther("300000"),
  ];
  // Both directions exercised explicitly so any asymmetry in the
  // gross-up + safety-bump path between zeroForOne and !zeroForOne
  // surfaces immediately.
  const DIRECTIONS: Array<"token0" | "token1"> = ["token0", "token1"];
  const PRESET_NAMES: PresetName[] = ["WETH", "WBTC"];

  describe("Active dynamic-fee ramp (canonical preset)", function () {
    for (const preset of PRESET_NAMES) {
      for (const dir of DIRECTIONS) {
        it(`${preset} / ${dir}: exact-out amountIn matches on-chain for every size`, async function () {
          this.timeout(600_000);
          for (const size of SWEEP_OUTPUT_SIZES) {
            const f = await deployParityPool(preset);
            await assertExactOutParity(f, size, `ramp-active/${preset}/${dir}/${size}`, dir);
          }
        });
      }
    }
  });

  describe("Disabled ramp (feeRampBps == 0)", function () {
    for (const preset of PRESET_NAMES) {
      it(`${preset}: exact-out amountIn matches on-chain when the ramp is opted out`, async function () {
        this.timeout(180_000);
        for (const size of [hre.ethers.parseEther("100"), hre.ethers.parseEther("50000")]) {
          const f = await deployParityPool(preset, { feeRampBps: 0 });
          await assertExactOutParity(f, size, `ramp-disabled/${preset}/${size}`, "token0");
        }
      });
    }
  });
});
