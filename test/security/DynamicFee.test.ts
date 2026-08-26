import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

// Constants mirrored from contracts/libraries/Constants.sol
const DYN_FEE_FLOOR_BPS = 20n;
const MAX_FEE_RAMP_BPS = 10_000n;
const BPS = 10_000n;

type FeeFixtureOpts = {
  baseFee?: number;
  feeRampBps?: number;
  feeFloorBps?: number;
  aWad?: bigint;
  lambdaWad?: bigint;
};

async function deployDynFeePool(opts: FeeFixtureOpts = {}) {
  const baseFee = opts.baseFee ?? 100; // 1.00 %
  const feeRampBps = opts.feeRampBps ?? 1_000; // 0.1 WAD warm-up
  // Test-local default; mirrors the V3-style 20 bps floor that
  // production deployments tend to pick. Callers that pick a
  // `baseFee < 20` MUST override this with a value `<= baseFee`,
  // otherwise the factory reverts with `InvalidFeeFloor`.
  const feeFloorBps = opts.feeFloorBps ?? Number(DYN_FEE_FLOOR_BPS);
  // Single-knob `alpha` sourced from `simulator/src/app/config.rs` —
  // tests parametrise the dynamic-fee ramp around the same `α` that
  // ships to mainnet. Per-test overrides remain available for callers
  // that need to widen / narrow the central concentration.
  const aWad = opts.aWad ?? PRESET.aWad;
  const lambdaWad = opts.lambdaWad ?? PRESET.lambdaWad;

  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token0", "TK0", 18);
  const tokenB = await Token.deploy("Token1", "TK1", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const tokenAAddr = await tokenA.getAddress();
  const tokenBAddr = await tokenB.getAddress();
  const [token0, token1] = tokenAAddr.toLowerCase() < tokenBAddr.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  // Send all swap fees back to LPs so feeAmount in the Swap event equals
  // the total per-swap fee (no protocol cut to subtract from it).
  await factory.setProtocolFee(0);

  const million = hre.ethers.parseEther("1000000");
  await token0.mint(owner.address, million * 2n);
  await token1.mint(owner.address, million * 2n);
  await token0.mint(trader.address, million);
  await token1.mint(trader.address, million);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);
  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad,
      lambdaWad,
      baseFee,
      emaPeriod: 1200,
      repegStepWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
      feeRampBps,
      feeFloorBps,
      repegShareBps: 5000,
    },
    million,
    million,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  await token0.connect(trader).approve(await router.getAddress(), MaxUint256);
  await token1.connect(trader).approve(await router.getAddress(), MaxUint256);

  return {
    owner,
    trader,
    token0,
    token1,
    factory,
    pool,
    router,
    poolAddress,
    token0Addr: await token0.getAddress(),
    token1Addr: await token1.getAddress(),
    baseFeeBps: BigInt(baseFee),
    feeRampBpsRaw: BigInt(feeRampBps),
  };
}

// Default ramp setup used by the bulk of the suite: baseFee = 1 %,
// feeRampBps = 1000 (= 0.1 WAD warm-up). With the low-concentration
// invariant chosen above, a 1 % swap leaves the pool around the middle
// of the ramp; a 30 % swap saturates it.
async function defaultFixture() {
  return deployDynFeePool();
}

async function disabledByRampFixture() {
  return deployDynFeePool({ feeRampBps: 0 });
}

async function noHeadroomFixture() {
  // baseFee == feeFloorBps with feeRampBps != 0 — factory rejects this
  // misconfig at deploy time via `FeeRampNoHeadroom`. The fixture is
  // structured to be called inside an `expect(...).to.be.reverted...`
  // assertion (it never returns a deployed pool).
  return deployDynFeePool({ baseFee: 20 });
}

async function noHeadroomTinyFeeFixture() {
  // Same shape as {noHeadroomFixture} but with `baseFee` driven below
  // the canonical 20-bps floor — the factory still rejects, this time
  // proving the headroom check fires regardless of how low the floor
  // is set.
  return deployDynFeePool({ baseFee: 5, feeFloorBps: 5 });
}

async function execSwapDir(
  fixture: Awaited<ReturnType<typeof deployDynFeePool>>,
  zeroForOne: boolean,
  amountInRaw: bigint
) {
  const { router, trader, token0Addr, token1Addr, pool } = fixture;
  const deadline = (await time.latest()) + 3600;

  const [tokenIn, tokenOut] = zeroForOne ? [token0Addr, token1Addr] : [token1Addr, token0Addr];

  const tx = await router.connect(trader).exactInputSingle({
    tokenIn,
    tokenOut,
    poolIndex: 0,
    recipient: trader.address,
    amountIn: amountInRaw,
    amountOutMinimum: 0,
    deadline,
  });
  const receipt = await tx.wait();

  const swapTopic = pool.interface.getEvent("Swap").topicHash;
  const log = receipt!.logs.find(
    (l: any) => l.address.toLowerCase() === fixture.poolAddress.toLowerCase() && l.topics[0] === swapTopic
  );
  if (!log) throw new Error("Swap event not found");
  const parsed = pool.interface.decodeEventLog("Swap", log!.data, log!.topics);

  const amountIn: bigint = parsed.amountIn;
  const amountOut: bigint = parsed.amountOut;
  const feeAmount: bigint = parsed.feeAmount;

  const feeBps = (feeAmount * BPS) / amountIn;
  return { amountIn, amountOut, feeAmount, feeBps };
}

// Back-compat: existing fee-shape tests only ever swap token0 → token1.
async function execSwap(fixture: Awaited<ReturnType<typeof deployDynFeePool>>, amountInRaw: bigint) {
  return execSwapDir(fixture, true, amountInRaw);
}

describe("DynamicFee (smoothstep ramp)", function () {
  // ---------- Configuration round-trip ----------
  describe("Configuration", function () {
    it("stores feeRampBps and exposes it through the view", async function () {
      const f = await loadFixture(defaultFixture);
      const cfg = await f.pool.getFeeConfig();
      expect(cfg.feeRampBps).to.equal(f.feeRampBpsRaw);
      expect(cfg.baseFee).to.equal(f.baseFeeBps);
    });

    it("reverts on out-of-range feeRampBps from the factory", async function () {
      const [owner] = await hre.ethers.getSigners();
      const Token = await hre.ethers.getContractFactory("MockERC20");
      const a = await Token.deploy("Token0", "TK0", 18);
      const b = await Token.deploy("Token1", "TK1", 18);
      await a.waitForDeployment();
      await b.waitForDeployment();

      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const impl = await PoolImpl.deploy();
      await impl.waitForDeployment();
      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      const factory = await Factory.deploy(await impl.getAddress(), owner.address, owner.address, 0);
      await factory.waitForDeployment();

      await expect(
        factory.createPoolAndAddLiquidity(
          await a.getAddress(),
          await b.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 100,
            emaPeriod: 1200,
            repegStepWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
            feeRampBps: Number(MAX_FEE_RAMP_BPS) + 1,
            feeFloorBps: 20,
            repegShareBps: 5000,
          },
          1,
          1,
          owner.address
        )
      ).to.be.revertedWithCustomError(factory, "InvalidFeeRamp");
    });
  });

  // ---------- Disabled paths preserve legacy flat fee ----------
  describe("Disabled paths", function () {
    it("treats feeRampBps == 0 as a fully disabled flat fee", async function () {
      const f = await loadFixture(disabledByRampFixture);
      expect((await f.pool.getFeeConfig()).feeRampBps).to.equal(0n);

      const tiny = await execSwap(f, hre.ethers.parseEther("1"));
      const big = await execSwap(f, hre.ethers.parseEther("100000"));

      // Both swaps must charge exactly baseFee (within 1 bps rounding).
      expect(tiny.feeBps).to.equal(f.baseFeeBps);
      expect(big.feeBps).to.equal(f.baseFeeBps);
    });

    it("rejects feeRampBps != 0 when baseFee == feeFloorBps (FeeRampNoHeadroom)", async function () {
      // Factory rejects the misconfig at deploy time — the smoothstep
      // would have nothing to interpolate into. Asserting the revert
      // here instead of going through the dedicated factory test keeps
      // the per-fee-ramp-config coverage co-located.
      await expect(loadFixture(noHeadroomFixture)).to.be.revertedWithCustomError(
        await hre.ethers.getContractFactory("EquilibraFactory"),
        "FeeRampNoHeadroom"
      );
    });

    it("rejects feeRampBps != 0 when baseFee < canonical 20-bps floor (FeeRampNoHeadroom)", async function () {
      await expect(loadFixture(noHeadroomTinyFeeFixture)).to.be.revertedWithCustomError(
        await hre.ethers.getContractFactory("EquilibraFactory"),
        "FeeRampNoHeadroom"
      );
    });
  });

  // ---------- Ramp activation: shape & monotonicity ----------
  describe("Active ramp", function () {
    it("starts near the 20 bps floor for a tiny swap", async function () {
      const f = await loadFixture(defaultFixture);
      // Smallest reasonable swap that still keeps fee math non-zero.
      const r = await execSwap(f, hre.ethers.parseEther("0.01"));
      expect(r.feeBps).to.equal(DYN_FEE_FLOOR_BPS);
    });

    it("saturates at baseFee for a swap that drives distance past the ramp", async function () {
      const f = await loadFixture(defaultFixture);
      // 30% of the seed depth = clearly past the 0.1-WAD warm-up.
      const r = await execSwap(f, hre.ethers.parseEther("300000"));
      expect(r.feeBps).to.equal(f.baseFeeBps);
    });

    it("is monotonically non-decreasing as swap size grows", async function () {
      const sizes = [
        hre.ethers.parseEther("0.01"),
        hre.ethers.parseEther("100"),
        hre.ethers.parseEther("1000"),
        hre.ethers.parseEther("5000"),
        hre.ethers.parseEther("20000"),
        hre.ethers.parseEther("100000"),
        hre.ethers.parseEther("300000"),
      ];

      let prev = 0n;
      let sawIntermediate = false;
      for (const size of sizes) {
        const f = await loadFixture(defaultFixture);
        const r = await execSwap(f, size);
        expect(r.feeBps).to.be.gte(DYN_FEE_FLOOR_BPS);
        expect(r.feeBps).to.be.lte(f.baseFeeBps);
        expect(r.feeBps).to.be.gte(prev);
        if (r.feeBps > DYN_FEE_FLOOR_BPS && r.feeBps < f.baseFeeBps) {
          sawIntermediate = true;
        }
        prev = r.feeBps;
      }
      // Must hit at least one intermediate value to prove the ramp is
      // genuinely smooth (not just snapping between floor and ceiling).
      expect(sawIntermediate).to.equal(true);
    });
  });

  // ---------- Quote consistency ----------
  describe("Quote consistency", function () {
    it("quoteExactIn matches actual swap output bit-for-bit", async function () {
      const f = await loadFixture(defaultFixture);
      const sizes = [hre.ethers.parseEther("100"), hre.ethers.parseEther("5000"), hre.ethers.parseEther("100000")];

      for (const size of sizes) {
        const fLocal = await loadFixture(defaultFixture);
        const quoted = await fLocal.pool.quoteExactIn(true, size);
        const actual = await execSwap(fLocal, size);
        expect(actual.amountOut).to.equal(quoted);
      }
    });

    it("quoteExactOut: amountOut ≥ wantOut, endpoint-max over-charge bounded", async function () {
      const f = await loadFixture(defaultFixture);
      const wantOut = hre.ethers.parseEther("5000");
      const neededIn = await f.pool.quoteExactOut(true, wantOut);
      // ExactOut contract:
      //   `amountOut` MUST be delivered to the wei (>= wantOut, never less).
      //   `amountIn`  MAY overcharge by the endpoint-max fee conservatism.
      //
      // Quoter design that achieves this: the exact-out solver recovers
      // `cleanIn` from the curve, the fee is resolved as the endpoint-max
      // of the CP-proxy rate over the realisable gross interval, and the
      // raw input is bumped by +1 wei to absorb residual rounding noise
      // and turn the near-exact match into a hard ≥ guarantee.
      //
      // Practical upper bound for the over-quote: the endpoint-max fee
      // resolution charges `max(feeCp(grossLo), feeCp(grossHi))`, which
      // sits above the fee the settled gross would resolve by the
      // continuous CP-distance gap across the realisable gross
      // interval — sub-ppm relative at this size, hard-bounded by
      // `baseFee − feeFloor` only for anchor-crossing trades. We assert
      // `<= wantOut · 1e-6` to stay sensitive to any future change that
      // grows the safety bump or the resolution gap materially.
      const r = await execSwap(f, neededIn);
      expect(
        r.amountOut,
        `ExactOut violation: quoteExactOut(${wantOut}) → neededIn=${neededIn} ⇒ swap output ${r.amountOut} < wantOut`
      ).to.be.gte(wantOut);
      expect(
        r.amountOut,
        `quoteExactOut over-charged: swap output ${r.amountOut} > wantOut ${wantOut} by ${r.amountOut - wantOut} wei (expected ≤ 1 ppm)`
      ).to.be.lte(wantOut + wantOut / 1_000_000n);
    });

    it("quoteExactOut cross-anchor: amountOut ≥ wantOut after the swap crosses pStart ↔ anchor", async function () {
      // Anchor-crossing exact-out is the regime the balanced-state sweep
      // above never exercises: the swap settles in the single smooth
      // kernel (no segment walker), but the CP-proxy post-distance is
      // V-shaped in the gross with its minimum at the constant-product
      // anchor, so the endpoint-max fee resolution is at its most
      // conservative exactly here. Each direction:
      //   1. Push the pool off-anchor with a 200 k exactIn.
      //   2. Quote exact-out in the reverse direction for a `wantOut`
      //      large enough that the swap traverses `pMarg == anchor`.
      //   3. Snapshot `pMarg` before/after the actual swap; assert it
      //      flipped across `anchor` to prove the crossing fired.
      //   4. Assert `actualOut ≥ wantOut` (the wei-precision contract)
      //      and that the over-delivery stays inside the endpoint-max
      //      conservatism bound.
      //
      // Token-vs-math-space note: with the asymmetric coord change
      // (`xMath = base wad`, `yMath = quote wad / anchor`) a
      // `zeroForOne=true` swap (token0 → token1) deposits on yMath and
      // withdraws xMath, so `pMarg` INCREASES; the mirror direction
      // decreases it. Pushing 1→0 first parks `pMarg` below `anchor`,
      // the 0→1 exact-out then crosses upward; the second sub-test runs
      // the symmetric downward crossing.
      type Direction = {
        label: string;
        // Direction we use to push the pool out of balance.
        pushZfo: boolean;
        // Direction we use to quote / execute exact-out (reverse).
        crossZfo: boolean;
        // After the push, `pMarg` lies on this side of `anchor`. The
        // reverse swap must flip it to the other side.
        startsAbove: boolean;
      };
      const directions: Direction[] = [
        // Push 1→0 → pMarg drops below anchor. Cross with ZFO exact-out
        // (token0 → token1, pMarg goes back up past anchor).
        {
          label: "1→0 push, 0→1 cross",
          pushZfo: false,
          crossZfo: true,
          startsAbove: false,
        },
        // Push 0→1 → pMarg lifts above anchor. Cross with OFZ exact-out
        // (token1 → token0, pMarg drops back past anchor).
        {
          label: "0→1 push, 1→0 cross",
          pushZfo: true,
          crossZfo: false,
          startsAbove: true,
        },
      ];

      const pushIn = hre.ethers.parseEther("200000");
      const wantOut = hre.ethers.parseEther("250000");

      for (const dir of directions) {
        const fLocal = await loadFixture(defaultFixture);

        // (1) Push the pool away from balance.
        await execSwapDir(fLocal, dir.pushZfo, pushIn);

        const oraclePre = await fLocal.pool.getOracleState();
        const anchor = oraclePre.priceScaleWad;
        const pMargPre = oraclePre.pMargWad;
        if (dir.startsAbove) {
          expect(pMargPre, `${dir.label}: post-push pMarg ${pMargPre} not above anchor ${anchor}`).to.be.gt(anchor);
        } else {
          expect(pMargPre, `${dir.label}: post-push pMarg ${pMargPre} not below anchor ${anchor}`).to.be.lt(anchor);
        }

        // (2) Quote the exact-out cross swap.
        const neededIn = await fLocal.pool.quoteExactOut(dir.crossZfo, wantOut);
        expect(neededIn, `${dir.label}: quoteExactOut returned 0 — wantOut may exceed liquidity`).to.be.gt(0n);

        // (3) Execute the swap, then snapshot pMarg again.
        const r = await execSwapDir(fLocal, dir.crossZfo, neededIn);
        const oraclePost = await fLocal.pool.getOracleState();
        const pMargPost = oraclePost.pMargWad;

        // pMarg must have flipped — that's the definition of "the
        // swap crossed the anchor". Without this assertion the test
        // would silently pass even if cross-anchor never fired.
        if (dir.startsAbove) {
          expect(
            pMargPost,
            `${dir.label}: pMarg ${pMargPost} did not cross below anchor ${anchor} — cross-anchor branch was never exercised`
          ).to.be.lt(anchor);
        } else {
          expect(
            pMargPost,
            `${dir.label}: pMarg ${pMargPost} did not cross above anchor ${anchor} — cross-anchor branch was never exercised`
          ).to.be.gt(anchor);
        }

        // (4) ExactOut wei-precision contract.
        expect(
          r.amountOut,
          `${dir.label}: ExactOut violation — neededIn=${neededIn} ⇒ swap output ${r.amountOut} < wantOut ${wantOut}`
        ).to.be.gte(wantOut);

        // Cross-anchor over-quote is intentionally NOT wei-tight under
        // the M-2 dynamic-fee resolver. For anchor-crossing exact-out
        // trades the CP-proxy fee is quasi-convex (V-shaped) in the
        // gross input, so a fixed-point iteration would oscillate; the
        // pool instead charges the *max* of the CP fee at the two ends
        // of the realisable gross interval (see
        // `_executeExactOutWithDynamicFee`). That guarantees the
        // `exactInput(quoteExactOut(out)) ≥ out` identity without any
        // iteration, but it deliberately over-quotes a cross-anchor
        // trade by up to the live dynamic-fee span (`baseFee −
        // feeFloor`) — the conservative, LP-favourable direction. We
        // bound the over-delivery by that span (relative to the settled
        // input) so a genuine regression that delivers far past
        // `wantOut` still trips, while the intended conservatism passes.
        const feeSpanBps = fLocal.baseFeeBps - DYN_FEE_FLOOR_BPS;
        // Cap denominated in the OUTPUT token (extra output ≈ Δfee ×
        // gross × marginal price ≈ Δfee × wantOut) so the bound stays
        // dimensionally correct if the fixture ever moves off 1:1
        // price / equal decimals.
        const overQuoteCap = (wantOut * feeSpanBps) / BPS + 4_096n;
        const overQuote = r.amountOut - wantOut;
        expect(
          overQuote,
          `${dir.label}: excessive cross-anchor over-quote = ${overQuote} wei (expected ≤ ${overQuoteCap})`
        ).to.be.lte(overQuoteCap);
      }
    });

    it("quoteExactOut sweep: amountOut ≥ wantOut for all sizes and directions", async function () {
      // Cross-product sweep that exercises both swap directions and the
      // full range of sizes spanned by the dynamic-fee ramp:
      //   * floor regime  (≤ 0.01 ETH)        — `feeBps == DYN_FEE_FLOOR_BPS`
      //   * intermediate  (100 / 5000 ETH)    — fee climbs the smoothstep
      //   * ceiling       (≥ 100 000 ETH)     — `feeBps == baseFeeBps`
      //
      // Each entry runs `wantOut → quoteExactOut → exactInputSingle` and
      // asserts:
      //   1. `amountOut >= wantOut` — the ExactOut wei-precision contract,
      //      guaranteed by the 2-pass aSeg refit + 1-wei safety bump.
      //   2. `amountOut` over-quote is bounded by the systematic
      //      fee-resolution drift: the fee rate is resolved at WAD
      //      precision as the endpoint-max over the realisable gross
      //      interval, which sits above the fee the settled gross would
      //      resolve by the continuous CP-distance gap between the two
      //      endpoints. The gap grows with trade depth (~3e-7 relative
      //      mid-ramp, ~2.2e-5 at 33% of depth) and is hard-bounded by
      //      `baseFee − feeFloor` only for anchor-crossing trades. The
      //      cap `wantOut · 5e-5 + 2048 wei` (~2.3× the measured worst
      //      entry) admits this drift while flagging any future
      //      regression that inflates the bump or the resolution gap.
      const sizes = [
        hre.ethers.parseEther("0.01"),
        hre.ethers.parseEther("100"),
        hre.ethers.parseEther("5000"),
        hre.ethers.parseEther("100000"),
      ];

      for (const wantOut of sizes) {
        for (const zeroForOne of [true, false]) {
          const fLocal = await loadFixture(defaultFixture);
          const neededIn = await fLocal.pool.quoteExactOut(zeroForOne, wantOut);
          // Every (size, direction) pair must be feasible from the
          // balanced default fixture.
          expect(neededIn, `quoteExactOut returned 0 for (${zeroForOne ? "0→1" : "1→0"}, ${wantOut})`).to.be.gt(0n);

          const r = await execSwapDir(fLocal, zeroForOne, neededIn);

          // (1) Wei-precision contract — the headline ExactOut guarantee.
          expect(
            r.amountOut,
            `ExactOut violation @ (${zeroForOne ? "0→1" : "1→0"}, ${wantOut}): neededIn=${neededIn} ⇒ swap output ${r.amountOut} < wantOut`
          ).to.be.gte(wantOut);

          // (2) Over-quote bound — `5e-5` relative + 2048-wei base.
          const overQuoteCap = wantOut / 20_000n + 2_048n;
          const overQuote = r.amountOut - wantOut;
          expect(
            overQuote,
            `Excessive over-charge @ (${zeroForOne ? "0→1" : "1→0"}, ${wantOut}): over-quote = ${overQuote} wei (expected ≤ ${overQuoteCap})`
          ).to.be.lte(overQuoteCap);
        }
      }
    });
  });
});
