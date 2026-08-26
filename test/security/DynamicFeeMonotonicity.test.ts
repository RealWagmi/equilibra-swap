// Quote-surface monotonicity of the dynamic fee.
//
// The fee rate is resolved at WAD precision and applied to the whole
// gross input, so the clean input (and therefore the output) is
// monotone in the gross up to a fixed-point residual on the order of
// one rate ulp on the notional (`gross / 1e18` wei). This is a dust
// bound, not an exact per-wei guarantee: the CP distance and `r` are
// themselves WAD-quantized, so a single input wei can cross several
// rate ulps at once — the sweeps below therefore allow a small
// multiple of the one-ulp residual. What this file pins:
//
//   * exact-in: probes around former integer-bps boundaries and a
//     wide-range fuzz stay within the dust residual, and any
//     macroscopic step strictly increases the output.
//   * exact-out: on the descending branch of the CP-proxy V the
//     resolved rate falls as the requested output grows, so
//     `quoteExactOut(out+1)` may need LESS input — within the same
//     dust residual.
//
// The residual is inherent to any finite-precision terminal rate; the
// factory's `FeeRampTooNarrow` guard separately excludes ramps steep
// enough to break monotonicity in the continuous limit.
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;
const WAD = 10n ** 18n;

// Dust residual bound on a quote at gross (or quoted-input) `g`: a
// small multiple of one rate ulp on the notional (a single input wei
// can cross several WAD-quantized rate ulps), plus 2 wei for
// scale/normalization rounding.
function residual(g: bigint): bigint {
  return (g / WAD) * 16n + 2n;
}

// Deterministic LCG so the sweep is reproducible run-to-run. Two draws
// are combined per value so the range spans the full deployable trade
// domain (a single 64-bit draw caps out near 1.8e19 ≈ 18 tokens).
function* lcg(seed: bigint): Generator<bigint> {
  let s = seed;
  for (;;) {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    const hi = s;
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    yield (hi << 64n) | s;
  }
}

async function deployPresetPool() {
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
  await factory.setProtocolFee(0);

  const million = hre.ethers.parseEther("1000000");
  await token0.mint(owner.address, million * 2n);
  await token1.mint(owner.address, million * 2n);
  await token0.mint(trader.address, million);
  await token1.mint(trader.address, million);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);
  // Canonical WETH ramp on a balanced 1M/1M pool; auto-repeg disabled
  // so executed pushes leave the anchor untouched and the quote
  // surface under test depends on the fee resolver alone.
  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad: PRESET.aWad,
      lambdaWad: PRESET.lambdaWad,
      baseFee: PRESET.feeBps,
      emaPeriod: 1200,
      repegStepWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
      repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
      feeRampBps: PRESET.feeRampBps,
      feeFloorBps: PRESET.feeFloorBps,
      repegShareBps: 0,
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
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  await token0.connect(trader).approve(await router.getAddress(), MaxUint256);
  await token1.connect(trader).approve(await router.getAddress(), MaxUint256);

  return {
    trader,
    pool,
    router,
    token0Addr: await token0.getAddress(),
    token1Addr: await token1.getAddress(),
  };
}

describe("DynamicFee monotonicity (WAD rate residual)", function () {
  describe("exact-in", function () {
    it("one-wei probes around former 1-bps boundaries lose at most one rate ulp", async function () {
      const f = await loadFixture(deployPresetPool);
      // Grosses that used to sit exactly on integer-bps rate steps of
      // this preset (where a +1-wei probe once cost ~1 bps of the
      // whole notional). Probe a ±3-wei window around each.
      const boundaries = [20922300563807962841865n, 29740158886969931022676n, 60666276385110927925210n];
      for (const g0 of boundaries) {
        let prev = BigInt(await f.pool.quoteExactIn(false, g0 - 3n));
        for (let g = g0 - 2n; g <= g0 + 3n; g++) {
          const out = BigInt(await f.pool.quoteExactIn(false, g));
          expect(out, `quoteExactIn(${g}) fell more than one rate ulp`).to.be.gte(prev - residual(g));
          prev = out;
        }
      }
    });

    it("pseudo-random g1 < g2 pairs never lose more than the residual (both directions)", async function () {
      const f = await loadFixture(deployPresetPool);
      const rng = lcg(0xd1ce5eedn);
      const MAX_G = 4n * 10n ** 23n;
      for (const zeroForOne of [true, false]) {
        for (let i = 0; i < 20; i++) {
          const g1 = (rng.next().value % MAX_G) + 10n ** 15n;
          const step = (rng.next().value % (10n * WAD)) + 1n;
          const g2 = g1 + step;
          const out1 = BigInt(await f.pool.quoteExactIn(zeroForOne, g1));
          const out2 = BigInt(await f.pool.quoteExactIn(zeroForOne, g2));
          expect(out2, `quoteExactIn(${zeroForOne}, ${g2}) < quoteExactIn(${zeroForOne}, ${g1}) − residual`).to.be.gte(
            out1 - residual(g2)
          );
        }
      }
    });

    it("any macroscopic step strictly increases the output", async function () {
      const f = await loadFixture(deployPresetPool);
      // 1e12 wei of extra input dwarfs the ≤ g/1e18 residual at every
      // deployable size, so strict monotonicity must hold.
      const STEP = 10n ** 12n;
      for (const g of [10n ** 18n, 2n * 10n ** 22n, 2n * 10n ** 23n]) {
        const out = BigInt(await f.pool.quoteExactIn(false, g));
        const outStep = BigInt(await f.pool.quoteExactIn(false, g + STEP));
        expect(outStep, `quoteExactIn(${g} + 1e12) did not increase`).to.be.gt(out);
      }
    });
  });

  describe("exact-out (descending CP-proxy branch)", function () {
    it("one-wei output probes move the input by at most one rate ulp", async function () {
      const f = await loadFixture(deployPresetPool);
      // Push the pool off-anchor so exact-out quotes land on the
      // DESCENDING branch of the V-shaped CP-proxy distance, where the
      // endpoint-max rate falls as the requested output grows and the
      // quoted input can tick down.
      const deadline = (await time.latest()) + 3600;
      await f.router.connect(f.trader).exactInputSingle({
        tokenIn: f.token0Addr,
        tokenOut: f.token1Addr,
        poolIndex: 0,
        recipient: f.trader.address,
        amountIn: hre.ethers.parseEther("200000"),
        amountOutMinimum: 0,
        deadline,
      });
      const out0 = 1242237924186919719177n;
      let prev = BigInt(await f.pool.quoteExactOut(true, out0 - 3n));
      for (let out = out0 - 2n; out <= out0 + 3n; out++) {
        const quoted = BigInt(await f.pool.quoteExactOut(true, out));
        expect(quoted, `quoteExactOut(${out}) fell more than one rate ulp`).to.be.gte(prev - residual(prev));
        prev = quoted;
      }
    });

    it("any macroscopic extra output strictly increases the quoted input", async function () {
      const f = await loadFixture(deployPresetPool);
      const STEP = 10n ** 12n;
      for (const out of [10n ** 18n, 10n ** 21n, 10n ** 22n]) {
        const inSmall = BigInt(await f.pool.quoteExactOut(true, out));
        const inBig = BigInt(await f.pool.quoteExactOut(true, out + STEP));
        expect(inBig, `quoteExactOut(${out} + 1e12) did not require more input`).to.be.gt(inSmall);
      }
    });
  });
});
