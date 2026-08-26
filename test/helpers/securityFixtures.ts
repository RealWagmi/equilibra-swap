// SPDX-License-Identifier: MIT
//
// Shared deployment + state-shaping helpers for the security suite.
//
// All tests in this suite reuse the **real** Equilibra curve presets
// resolved through `simulator/test_helpers/config` — the single source
// of truth that itself reads `simulator/src/app/config.rs`. Tests
// override only the fee / repeg parameters to expose the **pure curve
// math** to the trader:
//   • `baseFee = 5`        (factory minimum, 5 bps)
//   • `feeRampBps = 0`     (flat fee — no smoothstep)
//   • `feeFloorBps = 0`    (no extra anchor floor)
//   • `repegShareBps = 0`  (auto-repeg disabled — anchor frozen)
// Under this configuration, any positive trader profit on a closed
// round-trip would have to come from an arithmetic leak inside the
// invariant solver, not from fee accounting or repeg drift.
//
// The fixture seeds a pool at the canonical USDT-per-base ratio and
// deliberately keeps both reserves fresh so individual tests can move
// the pool to any target depletion (or even cross the anchor) by
// staging a pre-swap from the LP signer before the trader plays.

import hre from "hardhat";
import type { Signer } from "ethers";
import { MaxUint256 } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

export const WAD = 10n ** 18n;
export const BPS = 10_000n;

// ---------------------------------------------------------------------------
// Curve-pair access. The presets are read from
// `simulator/src/app/config.rs` via `simulator/test_helpers/config`,
// so any production-side tweak in Rust automatically propagates to
// every contract test without further edits here.
//
// Tests that only need the curve knob (`alpha`) can import this
// `REAL_PRESETS` alias for backwards compatibility; new code should
// reach for `EQUILIBRA_PRESETS` directly. The historical `lambda` and
// `gamma` knobs have been retired together with the V2 blend invariant
// — only `alpha` survives in the simplified single-parameter kernel.
// ---------------------------------------------------------------------------
export type PresetName = "WETH" | "WBTC";

export const REAL_PRESETS: Record<PresetName, { aWad: bigint; lambdaWad: bigint }> = {
  WETH: {
    aWad: EQUILIBRA_PRESETS.WETH.aWad,
    lambdaWad: EQUILIBRA_PRESETS.WETH.lambdaWad,
  },
  WBTC: {
    aWad: EQUILIBRA_PRESETS.WBTC.aWad,
    lambdaWad: EQUILIBRA_PRESETS.WBTC.lambdaWad,
  },
};

// Real-world reference prices — pinned to round numbers so the fixture
// math stays trivial to reason about. These are NOT calibrated to a
// specific timestamp; they're sized to keep both reserves at non-trivial
// raw magnitudes (≥ 1e8 raw on each side) under the standard $500K seed.
export const REFERENCE_PRICES = {
  WETH: 2_000n, // $2,000 / WETH
  WBTC: 102_354n, // $102,354 / WBTC
} as const;

export interface SecurityPresetOverrides {
  baseFee?: number;
  feeRampBps?: number;
  feeFloorBps?: number;
  repegShareBps?: number;
  emaPeriod?: number;
  repegStepWad?: bigint;
  repegThresholdToken1UpWad?: bigint;
  repegThresholdToken1DownWad?: bigint;
  initialQuoteUsd?: bigint; // raw USDT count (in whole units, NOT 6-dec raw)
}

export interface SecurityPreset {
  name: PresetName;
  aWad: bigint;
  lambdaWad: bigint;
  baseFee: number;
  feeRampBps: number;
  feeFloorBps: number;
  repegShareBps: number;
  emaPeriod: number;
  repegStepWad: bigint;
  repegThresholdToken1UpWad: bigint;
  repegThresholdToken1DownWad: bigint;
  basePriceUsd: bigint;
  initialQuoteUsd: bigint;
}

export function buildPreset(name: PresetName, overrides: SecurityPresetOverrides = {}): SecurityPreset {
  const base = EQUILIBRA_PRESETS[name];
  return {
    name,
    aWad: base.aWad,
    lambdaWad: base.lambdaWad,
    baseFee: overrides.baseFee ?? 5,
    feeRampBps: overrides.feeRampBps ?? 0,
    feeFloorBps: overrides.feeFloorBps ?? 0,
    repegShareBps: overrides.repegShareBps ?? 0,
    emaPeriod: overrides.emaPeriod ?? base.emaPeriod,
    repegStepWad: overrides.repegStepWad ?? base.repegStepWad,
    repegThresholdToken1UpWad: overrides.repegThresholdToken1UpWad ?? base.repegThresholdToken1UpWad,
    repegThresholdToken1DownWad: overrides.repegThresholdToken1DownWad ?? base.repegThresholdToken1DownWad,
    basePriceUsd: REFERENCE_PRICES[name],
    initialQuoteUsd: overrides.initialQuoteUsd ?? 500_000n,
  };
}

// ---------------------------------------------------------------------------
// Token decimal layout (immutable across the security suite).
// USDT is the quote leg in every preset so the fixture infrastructure
// can treat the trader's PnL in a single, fixed-decimal currency.
// ---------------------------------------------------------------------------
export const QUOTE_DECIMALS = 6;
export const BASE_DECIMALS: Record<PresetName, number> = {
  WETH: 18,
  WBTC: 8,
};

export const QUOTE_SCALE = 10n ** BigInt(QUOTE_DECIMALS);
export const BASE_SCALES: Record<PresetName, bigint> = {
  WETH: 10n ** 18n,
  WBTC: 10n ** 8n,
};

// ---------------------------------------------------------------------------
// Fixture: deploy factory + router + pool seeded at the preset price.
// ---------------------------------------------------------------------------
export interface SecurityFixture {
  preset: SecurityPreset;
  // Typed as HardhatEthersSigner (not the bare ethers-v6 `Signer`) so
  // tests can use the synchronous `.address` under `--typecheck`.
  owner: HardhatEthersSigner;
  trader: HardhatEthersSigner;
  attacker: HardhatEthersSigner;
  victim: HardhatEthersSigner;
  // Tokens
  quote: any; // USDT (6 decimals)
  base: any; // WETH or WBTC
  quoteAddr: string;
  baseAddr: string;
  quoteIsToken0: boolean;
  baseDecimals: number;
  // Contracts
  factory: any;
  router: any;
  pool: any;
  poolAddr: string;
  // Initial seed (in raw smallest units)
  initialQuoteRaw: bigint;
  initialBaseRaw: bigint;
}

export function quoteRawToBaseRaw(quoteRaw: bigint, preset: SecurityPreset): bigint {
  const baseScale = BASE_SCALES[preset.name];
  const quoteScale = QUOTE_SCALE;
  // baseRaw = (quoteRaw / quoteScale) / basePriceUsd × baseScale
  return (quoteRaw * baseScale) / (preset.basePriceUsd * quoteScale);
}

export function baseRawToQuoteRaw(baseRaw: bigint, preset: SecurityPreset): bigint {
  const baseScale = BASE_SCALES[preset.name];
  const quoteScale = QUOTE_SCALE;
  return (baseRaw * preset.basePriceUsd * quoteScale) / baseScale;
}

export async function deploySecurityFixture(preset: SecurityPreset): Promise<SecurityFixture> {
  const [owner, trader, attacker, victim] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const quote: any = await Token.deploy("Tether USD", "USDT", QUOTE_DECIMALS);
  const base: any = await Token.deploy(preset.name, preset.name, BASE_DECIMALS[preset.name]);
  await quote.waitForDeployment();
  await base.waitForDeployment();

  const quoteAddr = (await quote.getAddress()).toLowerCase();
  const baseAddr = (await base.getAddress()).toLowerCase();
  const quoteIsToken0 = quoteAddr < baseAddr;

  // Pool implementation + factory.
  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(
    await poolImpl.getAddress(),
    await owner.getAddress(),
    await owner.getAddress()
  , 0);
  await factory.waitForDeployment();
  // Disable protocol fee — keeps fee accounting symmetric for the suite.
  await factory.setProtocolFee(0);

  // Router with mock WETH9 (the suite never touches native ETH paths).
  const Weth9 = await hre.ethers.getContractFactory("MockWETH9");
  const weth9: any = await Weth9.deploy();
  await weth9.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(
    await factory.getAddress(),
    await poolImpl.getAddress(),
    await weth9.getAddress()
  );
  await router.waitForDeployment();

  // Mint enough so even pathological scenarios (cross-anchor + JIT
  // liquidity bursts) cannot run signers out of balance.
  const initialQuoteRaw = preset.initialQuoteUsd * QUOTE_SCALE;
  const initialBaseRaw = quoteRawToBaseRaw(initialQuoteRaw, preset);

  const mintQuote = initialQuoteRaw * 1000n;
  const mintBase = initialBaseRaw * 1000n;
  for (const signer of [owner, trader, attacker, victim]) {
    const addr = await signer.getAddress();
    await quote.mint(addr, mintQuote);
    await base.mint(addr, mintBase);
  }

  const factoryAddr = await factory.getAddress();
  await quote.connect(owner).approve(factoryAddr, MaxUint256);
  await base.connect(owner).approve(factoryAddr, MaxUint256);

  const sortedAmt0 = quoteIsToken0 ? initialQuoteRaw : initialBaseRaw;
  const sortedAmt1 = quoteIsToken0 ? initialBaseRaw : initialQuoteRaw;
  const token0 = quoteIsToken0 ? await quote.getAddress() : await base.getAddress();
  const token1 = quoteIsToken0 ? await base.getAddress() : await quote.getAddress();

  await factory.connect(owner).createPoolAndAddLiquidity(
    token0,
    token1,
    {
      aWad: preset.aWad,
      lambdaWad: preset.lambdaWad,
      baseFee: preset.baseFee,
      emaPeriod: preset.emaPeriod,
      repegStepWad: preset.repegStepWad,
      repegThresholdToken1UpWad: preset.repegThresholdToken1UpWad,
      repegThresholdToken1DownWad: preset.repegThresholdToken1DownWad,
      feeRampBps: preset.feeRampBps,
      feeFloorBps: preset.feeFloorBps,
      repegShareBps: preset.repegShareBps,
    },
    sortedAmt0,
    sortedAmt1,
    await owner.getAddress()
  );

  const poolAddr = await factory.allPools(0);
  const pool: any = await hre.ethers.getContractAt("EquilibraPool", poolAddr);

  // Approve router for every actor — security tests hop between signers
  // mid-scenario, and the router is the only entry-point we use.
  const routerAddr = await router.getAddress();
  for (const signer of [owner, trader, attacker, victim]) {
    await quote.connect(signer).approve(routerAddr, MaxUint256);
    await base.connect(signer).approve(routerAddr, MaxUint256);
  }
  // Owner also keeps a direct pool approval for `addLiquidity` paths
  // that bypass the router (proportional re-seeding etc.).
  await quote.connect(owner).approve(poolAddr, MaxUint256);
  await base.connect(owner).approve(poolAddr, MaxUint256);

  return {
    preset,
    owner,
    trader,
    attacker,
    victim,
    quote,
    base,
    quoteAddr: await quote.getAddress(),
    baseAddr: await base.getAddress(),
    quoteIsToken0,
    baseDecimals: BASE_DECIMALS[preset.name],
    factory,
    router,
    pool,
    poolAddr,
    initialQuoteRaw,
    initialBaseRaw,
  };
}

// ---------------------------------------------------------------------------
// State shaping: bring the pool to a target depletion via owner pre-swap.
// `side = "quote"` means the QUOTE leg is depleted by `pctBps` of its
// initial balanced reserve (owner sells base→quote). `side = "base"` is
// the mirror image. The owner is used so the trader's wallet history
// stays clean for PnL accounting.
// ---------------------------------------------------------------------------
export type Side = "quote" | "base";

export interface DepleteResult {
  amountIn: bigint;
  realisedDrop: bigint;
  targetDrop: bigint;
}

export async function deplete(fx: SecurityFixture, side: Side, pctBps: bigint): Promise<DepleteResult> {
  if (pctBps === 0n) {
    return { amountIn: 0n, realisedDrop: 0n, targetDrop: 0n };
  }
  if (pctBps >= BPS) {
    throw new Error(`deplete: pctBps must satisfy 0 < pctBps < BPS (got ${pctBps})`);
  }

  // We bias the pool by selling (BASE → QUOTE) when `side=quote` should
  // become depleted. Selling base means trader receives quote → quote
  // reserve drops. Mirror logic for the opposite side.
  const tokenIn = side === "quote" ? fx.baseAddr : fx.quoteAddr;
  const tokenOut = side === "quote" ? fx.quoteAddr : fx.baseAddr;
  const reserveOutRaw = side === "quote" ? fx.initialQuoteRaw : fx.initialBaseRaw;
  // Upper bound for `amountIn` is sized in INPUT units; the OUT-side
  // reserve is denominated in completely different decimals (USDT 6dp
  // vs BASE 8dp/18dp), so reusing it would wedge the bisection
  // immediately for asymmetric pairs. V2's hybrid invariant
  // concentrates liquidity tighter near the anchor than the V1 walker
  // did, so deep drains (≥ 80% of the output reserve) require much
  // more input than V1 used to. We seed `hi` at 256× the input reserve
  // — the secant solver still settles in ≤ 7 iterations there, and the
  // grow-up loop below halves until it finds the largest valid probe.
  const reserveInRaw = side === "quote" ? fx.initialBaseRaw : fx.initialQuoteRaw;

  // We don't know the curve's `dx` for a target `dy = pctBps × reserveOut`
  // analytically without invoking the on-chain solver. Bisect on
  // `quoteExactIn` until the realised drop matches the target.
  const targetDrop = (reserveOutRaw * pctBps) / BPS;

  let lo = 1n;
  let hi = reserveInRaw * 256n;
  let bestAmountIn = 0n;
  let bestRealisedDrop = 0n;
  const inIsToken0 = tokenIn.toLowerCase() === (fx.quoteIsToken0 ? fx.quoteAddr : fx.baseAddr).toLowerCase();
  const zeroForOne = inIsToken0;

  // First, find the largest valid `hi` for which `quoteExactIn` does
  // not revert. The seed is wide enough that V2's secant solver
  // typically returns a clean output on the very first probe; the
  // halving fallback only kicks in for pathological reserve / decimal
  // combinations where even 256× of input is rejected by the kernel.
  let maxValidIn = 0n;
  let maxValidOut = 0n;
  let probeHi = hi;
  for (let i = 0; i < 32; i++) {
    try {
      const out = BigInt(await fx.pool.quoteExactIn(zeroForOne, probeHi));
      maxValidIn = probeHi;
      maxValidOut = out;
      break;
    } catch {
      probeHi = probeHi / 2n;
      if (probeHi <= 1n) break;
    }
  }
  if (maxValidIn === 0n) {
    throw new Error(`deplete: solver always reverts at side=${side} pctBps=${pctBps}`);
  }
  hi = maxValidIn;

  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2n;
    let out: bigint;
    try {
      out = BigInt(await fx.pool.quoteExactIn(zeroForOne, mid));
    } catch {
      hi = mid;
      continue;
    }
    if (out >= targetDrop) {
      hi = mid;
      bestAmountIn = mid;
      bestRealisedDrop = out;
    } else {
      lo = mid;
    }
    if (hi - lo <= 1n) break;
  }
  if (bestAmountIn === 0n) {
    // Best-effort depletion: the blend invariant concentrates liquidity
    // hard enough that some `pctBps` requests sit beyond the curve's
    // feasibility envelope (the `αL · xPost ≥ kTarget` gate inside
    // `quoteExactInForward` reverts before the solver even runs). When
    // the requested `targetDrop` is unreachable we drain as deep as
    // the curve allows so the test harness can still place the pool
    // into a strongly-imbalanced regime without short-circuiting the
    // surrounding scenario. Callers that explicitly need the precise
    // depletion level should validate `realisedDrop` against
    // `targetDrop` themselves.
    bestAmountIn = maxValidIn;
    bestRealisedDrop = maxValidOut;
  }

  await fx.router.connect(fx.owner).exactInputSingle({
    tokenIn,
    tokenOut,
    poolIndex: 0,
    recipient: await fx.owner.getAddress(),
    amountIn: bestAmountIn,
    amountOutMinimum: 0,
    deadline: (await currentBlockTime()) + 3600,
  });
  return {
    amountIn: bestAmountIn,
    realisedDrop: bestRealisedDrop,
    targetDrop,
  };
}

export async function currentBlockTime(): Promise<number> {
  const block = await hre.ethers.provider.getBlock("latest");
  return Number(block!.timestamp);
}

// ---------------------------------------------------------------------------
// Pool snapshot — used by every scenario for assertions / table logging.
// ---------------------------------------------------------------------------
export interface PoolSnapshot {
  reserve0: bigint;
  reserve1: bigint;
  reserveQuoteRaw: bigint;
  reserveBaseRaw: bigint;
  priceScaleWad: bigint;
  emaPriceWad: bigint;
  pMargWad: bigint;
  unitValueWad: bigint;
  growthWad: bigint;
  totalSupply: bigint;
  poolValueQuoteWad: bigint;
  position: number; // [0, 1] - 0.5 means balanced by value
}

export async function snapshotPool(fx: SecurityFixture): Promise<PoolSnapshot> {
  const [r0, r1] = await fx.pool.getReserves();
  const oracle = await fx.pool.getOracleState();
  const lpv = await fx.pool.getLpValueState();
  const total = BigInt(await fx.pool.totalSupply());

  const reserve0 = BigInt(r0);
  const reserve1 = BigInt(r1);
  const reserveQuoteRaw = fx.quoteIsToken0 ? reserve0 : reserve1;
  const reserveBaseRaw = fx.quoteIsToken0 ? reserve1 : reserve0;

  // Pool value in quote WAD using the static reference price (NOT anchor),
  // so adversarial anchor drift surfaces as a value loss in the snapshot.
  const baseScale = BASE_SCALES[fx.preset.name];
  const quoteScale = QUOTE_SCALE;
  const quoteWad = (reserveQuoteRaw * WAD) / quoteScale;
  const baseValueWad = (reserveBaseRaw * fx.preset.basePriceUsd * WAD) / baseScale;
  const poolValueQuoteWad = quoteWad + baseValueWad;

  const totalValueWad = quoteWad + baseValueWad;
  const position = totalValueWad === 0n ? 0.5 : Number(baseValueWad) / Number(totalValueWad);

  return {
    reserve0,
    reserve1,
    reserveQuoteRaw,
    reserveBaseRaw,
    priceScaleWad: BigInt(oracle.priceScaleWad),
    emaPriceWad: BigInt(oracle.emaPriceWad),
    pMargWad: BigInt(oracle.pMargWad),
    unitValueWad: BigInt(lpv.unitValueWad),
    growthWad: BigInt(lpv.growthWad),
    totalSupply: total,
    poolValueQuoteWad,
    position,
  };
}

// ---------------------------------------------------------------------------
// Trader helpers: a single-pool exact-in swap routed through `EquilibraRouter`.
// Returns the realised `amountOut` taken from the recipient's balance delta
// so callers don't have to thread router return values through `wait()`.
// ---------------------------------------------------------------------------
export interface SwapResult {
  amountIn: bigint;
  amountOut: bigint;
  tokenIn: string;
  tokenOut: string;
}

export async function exactInputSingle(
  fx: SecurityFixture,
  signer: Signer,
  args: {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    amountOutMinimum?: bigint;
    deadline?: number;
  }
): Promise<SwapResult> {
  const recipient = await signer.getAddress();
  const tokenOutCt = args.tokenOut.toLowerCase() === fx.quoteAddr.toLowerCase() ? fx.quote : fx.base;
  const balBefore = BigInt(await tokenOutCt.balanceOf(recipient));

  await fx.router.connect(signer).exactInputSingle({
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    poolIndex: 0,
    recipient,
    amountIn: args.amountIn,
    amountOutMinimum: args.amountOutMinimum ?? 0n,
    deadline: args.deadline ?? (await currentBlockTime()) + 3600,
  });
  const balAfter = BigInt(await tokenOutCt.balanceOf(recipient));
  return {
    amountIn: args.amountIn,
    amountOut: balAfter - balBefore,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
  };
}

// Decimal-aware formatting helpers used by every test's `console.table`.
export function fmtRaw(raw: bigint, scale: bigint, frac = 6): string {
  if (raw === 0n) return "0";
  const sign = raw < 0n ? "-" : "";
  const ax = raw < 0n ? -raw : raw;
  const whole = ax / scale;
  const frPart = ax % scale;
  const padLen = scale.toString().length - 1;
  const frStr = frPart.toString().padStart(padLen, "0");
  return `${sign}${whole.toString()}.${frStr.slice(0, frac)}`.replace(/0+$/, "").replace(/\.$/, "");
}

export function fmtQuote(raw: bigint, frac = 6): string {
  return fmtRaw(raw, QUOTE_SCALE, frac);
}
export function fmtBase(raw: bigint, name: PresetName, frac = 8): string {
  return fmtRaw(raw, BASE_SCALES[name], frac);
}
export function fmtWad(raw: bigint, frac = 6): string {
  return fmtRaw(raw, WAD, frac);
}
