import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";
import { quoteExactInputViaRustTrace, type SnapshotForRustQuote } from "../../simulator/test_helpers/rustTestUtils";
import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

type PresetName = "WETH" | "WBTC";

/**
 * Dynamic-fee parity: every swap runs through both the on-chain pool
 * and the Rust off-chain simulator, then their `amountOut` is compared
 * bit-for-bit. Any drift signals a divergence between
 * `EquilibraPool._resolveDynamicFeeWadFromCp` /
 * `_executeExactInWithDynamicFee` on the Solidity side and
 * `simulator::runtime_quoter::equilibra::resolve_dynamic_fee_wad_from_cp`
 * / `compute_exact_input_swap` on the Rust side.
 *
 * Scenarios exercised:
 *   • Active smoothstep ramp with the default 100 bps / 20 bps band.
 *   • Disabled ramp (`feeRampBps == 0` — legacy flat-fee path).
 *   • Disabled ramp (`feeRampBps == 0` — explicit opt-out branch).
 *   • 100 % repeg-share routing (gate threshold collapses to vp0).
 *   • 0 %   repeg-share routing (gate threshold == vp0 + growth, never opens).
 *
 * The test manages timestamps deterministically: we pin the pool's init
 * block via `time.setNextBlockTimestamp(initTs)` and every swap via
 * `time.setNextBlockTimestamp(swapTs)`. Because we only ever perform a
 * single swap per fixture, `_lastEmaTs == _lastRepegTs == initTs` on the
 * pre-swap snapshot — meaning we do not need storage-slot spelunking to
 * reconstruct those fields, which is what makes the snapshot buildable
 * without an extra Lens contract.
 */

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

/**
 * Build a fresh pool at a deterministic `initTs`. The timestamp is
 * pinned via `time.setNextBlockTimestamp` on the *next* block, so the
 * EVM tags the creation tx with the exact value we pass into Rust — we
 * need that match to replay the swap off-chain without any slack.
 */
async function deployParityPool(presetName: PresetName = "WETH", opts: FixtureOpts = {}): Promise<PoolFixture> {
  // Defaults sourced from the canonical Rust simulator preset (mirrors
  // `simulator/src/app/config.rs::build_default_config`). Per-test
  // overrides are still honoured via `opts.*`. Pinning the parity test
  // to the deployed preset is the whole point: any drift between
  // Solidity and Rust under the *real* fee ramp must surface here, not
  // be papered over with synthetic constants.
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

  // Large enough bankroll to cover the biggest sweep size (300k) plus the
  // initial liquidity seed; padding x4 keeps the trader solvent across
  // re-used hardhat fixtures without bumping mint limits.
  const bankroll = (seed0 + seed1) * 4n;
  await token0.mint(owner.address, bankroll);
  await token1.mint(owner.address, bankroll);
  await token0.mint(trader.address, bankroll);
  await token1.mint(trader.address, bankroll);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);

  // All ancillary deploys and approvals BEFORE we pin the init
  // timestamp, so the creation tx is the only block affected by our
  // `setNextBlockTimestamp`. Otherwise each subsequent tx auto-bumps
  // `block.timestamp`, and by the time we reach the swap the EVM clock
  // has already advanced past `initTs + 1`.
  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  await token0.connect(trader).approve(await router.getAddress(), MaxUint256);
  await token1.connect(trader).approve(await router.getAddress(), MaxUint256);

  // Pin the pool-creation timestamp so the Rust trace has a stable
  // `lastEmaTs`/`lastRepegTs` seed. Headroom of ~100 s over
  // `time.latest()` leaves room for a strictly-monotonic
  // `setNextBlockTimestamp(swapTs)` in the ensuing swap tx (hardhat
  // refuses same/earlier timestamps when
  // `allowBlocksWithSameTimestamp: false`).
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

/**
 * Build a `SnapshotForRustQuote` from the live pool. Only fields that
 * cannot be derived from the fixture (post-init state) are read on-chain
 * via IEquilibraPool getters; everything the pool keeps in packed-slot
 * storage without a getter (`_emaPeriod`, `_repegStepWad`, `_lastEmaTs`,
 * `_lastRepegTs`, etc.) is populated from the deterministic fixture
 * inputs. The mapping mirrors the `TracePoolInput` layout consumed by
 * `simulator::main::run_trace`.
 */
async function snapshotPool(f: PoolFixture): Promise<SnapshotForRustQuote> {
  const [r0, r1] = await f.pool.getReserves();
  const oracle = await f.pool.getOracleState();
  // `OracleState.anchorPrice` → `priceScaleWad`;
  // `OracleState.emaPrice` → `emaPriceWad`. Local identifier kept
  // for trace-JSON consistency with HEAD's prefixed field names
  // (`equilibraAnchorPriceWad`, `equilibraEmaPrice`).
  const anchor = oracle.priceScaleWad;
  const ema = oracle.emaPriceWad;
  const lpState = await f.pool.getLpValueState();
  const lpUnitValueGenesis = lpState.genesisWad;
  const lpUnitValue = lpState.unitValueWad;
  const lpValueGrowth = lpState.growthWad;
  const [pFee0, pFee1] = await f.pool.getProtocolFees();
  const fee = await f.pool.getFeeConfig();
  const baseFee = fee.baseFee;
  const feeRampBps = fee.feeRampBps;
  const feeFloorBps = fee.feeFloorBps;
  const repegShareBps = fee.repegShareBps;
  const protocolFeePercent = fee.protocolFeePercent;

  const bal0 = await f.token0.balanceOf(f.poolAddress);
  const bal1 = await f.token1.balanceOf(f.poolAddress);

  return {
    poolKey: "dynamic-fee-parity",
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
    feeBps: Number(baseFee),
    aWad: f.aWad,
    lambdaWad: f.lambdaWad,
    equilibraProtocolFeePercent: BigInt(protocolFeePercent),
    equilibraEmaPeriod: BigInt(f.emaPeriod),
    equilibraFeeRampBps: BigInt(feeRampBps),
    equilibraFeeFloorBps: BigInt(feeFloorBps),
    equilibraRepegShareBps: BigInt(repegShareBps),
    equilibraProtocolFee0: BigInt(pFee0),
    equilibraProtocolFee1: BigInt(pFee1),
    equilibraE0: BigInt(bal0),
    equilibraE1: BigInt(bal1),
    equilibraEmaPrice: BigInt(ema),
    equilibraLastTimestamp: BigInt(f.initTs),
    equilibraLastRecenterTimestamp: BigInt(f.initTs),
    equilibraRepegStepWad: BigInt(f.repegStepWad),
    equilibraRepegThresholdToken1UpWad: BigInt(f.repegThresholdWad),
    equilibraRepegThresholdToken1DownWad: BigInt(f.repegThresholdWad),
    equilibraAnchorPriceWad: BigInt(anchor),
    equilibraLpUnitValueGenesisWad: BigInt(lpUnitValueGenesis),
    equilibraLpUnitValueWad: BigInt(lpUnitValue),
    equilibraLpValueGrowthWad: BigInt(lpValueGrowth),
  };
}

type SwapExec = {
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
  timestamp: number;
};

async function execSwap(
  f: PoolFixture,
  amountInRaw: bigint,
  tokenIn: "token0" | "token1",
  swapTs: number
): Promise<SwapExec> {
  const { router, trader, token0Addr, token1Addr, pool, poolAddress } = f;
  const [inAddr, outAddr] = tokenIn === "token0" ? [token0Addr, token1Addr] : [token1Addr, token0Addr];

  await time.setNextBlockTimestamp(swapTs);
  const tx = await router.connect(trader).exactInputSingle({
    tokenIn: inAddr,
    tokenOut: outAddr,
    poolIndex: 0,
    recipient: trader.address,
    amountIn: amountInRaw,
    amountOutMinimum: 0,
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
    amountIn: BigInt(parsed.amountIn),
    amountOut: BigInt(parsed.amountOut),
    feeAmount: BigInt(parsed.feeAmount),
    timestamp: swapTs,
  };
}

async function assertParity(f: PoolFixture, amountIn: bigint, label: string, tokenIn: "token0" | "token1") {
  // Snapshot the pre-swap state so Rust replays from the same vantage
  // point as the on-chain EVM tx.
  const snapshot = await snapshotPool(f);
  const swapTs = f.initTs + 1; // strictly after init; EMA will update by 1 sec
  const on = await execSwap(f, amountIn, tokenIn, swapTs);

  const inAddr = tokenIn === "token0" ? f.token0Addr : f.token1Addr;
  const rust = await quoteExactInputViaRustTrace({
    snapshot,
    baseSymbol: f.presetName,
    tokenIn: inAddr,
    amountIn,
    poolAddress: f.poolAddress,
    timestamp: swapTs,
  });

  expect(rust, `${label}: amountOut parity (on=${on.amountOut} rust=${rust})`).to.equal(on.amountOut);
}

describe("DynamicFee parity (on-chain vs Rust simulator)", function () {
  const SWEEP_SIZES = [
    hre.ethers.parseEther("1"),
    hre.ethers.parseEther("100"),
    hre.ethers.parseEther("1000"),
    hre.ethers.parseEther("10000"),
    hre.ethers.parseEther("100000"),
    hre.ethers.parseEther("300000"),
  ];
  // Both directions exercised explicitly so any asymmetry in the
  // Solidity vs Rust fee resolver (e.g. zeroForOne vs !zeroForOne sign
  // handling in the CP-proxy predictor) shows up immediately.
  const DIRECTIONS: Array<"token0" | "token1"> = ["token0", "token1"];
  const PRESET_NAMES: PresetName[] = ["WETH", "WBTC"];

  describe("Active ramp (canonical preset)", function () {
    for (const preset of PRESET_NAMES) {
      for (const dir of DIRECTIONS) {
        it(`${preset} / ${dir}: matches on-chain for every size in the sweep`, async function () {
          this.timeout(600_000);
          for (const size of SWEEP_SIZES) {
            const f = await deployParityPool(preset);
            await assertParity(f, size, `ramp-active/${preset}/${dir}/${size}`, dir);
          }
        });
      }
    }
  });

  describe("Disabled ramp (feeRampBps == 0)", function () {
    for (const preset of PRESET_NAMES) {
      it(`${preset}: matches on-chain when the ramp is opted out`, async function () {
        this.timeout(180_000);
        for (const size of [hre.ethers.parseEther("10"), hre.ethers.parseEther("50000")]) {
          const f = await deployParityPool(preset, { feeRampBps: 0 });
          await assertParity(f, size, `ramp-disabled/${preset}/${size}`, "token0");
        }
      });
    }
  });

  describe("Repeg share variants", function () {
    it("matches on-chain with 100 % repeg share (threshold collapses to vp0)", async function () {
      this.timeout(120_000);
      const f = await deployParityPool("WETH", { repegShareBps: 10_000 });
      await assertParity(f, hre.ethers.parseEther("5000"), "share-full", "token0");
    });

    it("matches on-chain with 0 % repeg share (gate stays shut)", async function () {
      this.timeout(120_000);
      const f = await deployParityPool("WETH", { repegShareBps: 0 });
      await assertParity(f, hre.ethers.parseEther("5000"), "share-zero", "token0");
    });
  });
});
