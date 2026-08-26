// Property test: geometric-mirror invariance of the LP unit value.
//
// The law being pinned (proved analytically and verified on production
// bytecode during the repeg-symmetry audit): the kernel K is symmetric
// in (x, y) and homogeneous of degree 2, so L is homogeneous of degree
// 1 and the `√(priceScale·WAD)` factor in
//
//   vp = 2 · L_eq · √(priceScale · WAD) / totalSupply
//
// EXACTLY cancels the one-sided (quote-only) coordinate change. Two
// consequences, both pinned here to the last wei:
//
//   1. At the anchor, mirror moves of the anchor are value-identical:
//      vp(ps·u) == vp(ps/u) for any u — the repeg gate reads the same
//      cost for a ×u and a ÷u candidate. Exact in real arithmetic; the
//      two integer evaluation paths stack their floor roundings
//      independently, leaving ≤ 2 wei (~2e-20 relative) — pinned.
//   2. Token decimals fold out before the kernel: the same math-space
//      state quoted through different raw decimals yields bit-identical
//      vp (exact — the scales divide out before any rounding).
//   3. Mirrored off-anchor states (yMath = x·(1+d) with an up-move vs
//      yMath = x/(1+d) with a down-move) suffer the identical RELATIVE
//      vp change, to ≤ 1e-19 relative (observed ~7e-21).
//
// The bounds are ~10 orders of magnitude tighter than any genuine
// symmetry break would produce (a wrong normaliser or a one-sided
// rounding change shows up at 1e-9..1e-2 relative), so the tripwire
// stays maximally sensitive while tolerating honest integer floors.
//
// Why a property test: this symmetry is emergent — it follows from
// three pieces (kernel symmetry, L homogeneity, the √ps normaliser)
// agreeing with each other, and no unit test guards the agreement. Any
// future change to the coordinate lift, the vp formula, or rounding
// directions that breaks the repeg gate's up/down fairness fails here
// with the exact (preset, u, state) combination that diverged.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

const WAD = 10n ** 18n;
const PS = 2000n * WAD; // base anchor: 2000 quote per base
const SUPPLY = 10n ** 21n;

// Knob sets spanning the admissible envelope (values need not match
// production presets — the law must hold for ANY factory-valid knobs).
const KNOBS: Array<{ name: string; aWad: bigint; lambdaWad: bigint }> = [
  { name: "WETH-like (a=0.843, λ=0.0323)", aWad: 843n * 10n ** 15n, lambdaWad: 323n * 10n ** 14n },
  { name: "WBTC-like (a=0.949, λ=0.0139)", aWad: 949n * 10n ** 15n, lambdaWad: 139n * 10n ** 14n },
  { name: "envelope edge (a=0.1, λ=1.0)", aWad: 10n ** 17n, lambdaWad: 10n ** 18n },
];

// Mirror multipliers u = p/q chosen so ps·u and ps·(q/p) are both
// exact integers for ps = 2e21 (no construction rounding).
const MIRRORS: Array<[bigint, bigint]> = [
  [5n, 4n], //   ±25%
  [25n, 16n], // ±56%
  [2n, 1n], //   ±2× (the EMA clamp edge)
];

interface MirrorPool {
  pool: any;
  scale0: bigint;
  scale1: bigint;
}

// Deploys a MockEquilibraPool-backed pool (production bytecode + view
// forwarders) for the given knobs; `sixDecQuote` deploys one token with
// 6 decimals. Address sorting decides which side it lands on — all
// probe states are constructed in WAD and divided by the actual scales,
// so either sort order works.
async function deployMirrorPool(aWad: bigint, lambdaWad: bigint, sixDecQuote: boolean): Promise<MirrorPool> {
  const [owner] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("TokenA", "TKA", sixDecQuote ? 6 : 18);
  const tokenB = await Token.deploy("TokenB", "TKB", 18);
  const aAddr = (await tokenA.getAddress()).toLowerCase();
  const bAddr = (await tokenB.getAddress()).toLowerCase();
  const [token0, dec0, token1, dec1] =
    aAddr < bAddr ? [tokenA, sixDecQuote ? 6 : 18, tokenB, 18] : [tokenB, 18, tokenA, sixDecQuote ? 6 : 18];
  const scale0 = 10n ** BigInt(18 - dec0);
  const scale1 = 10n ** BigInt(18 - dec1);

  const poolImpl = await (await hre.ethers.getContractFactory("MockEquilibraPool")).deploy();
  const factory = await (
    await hre.ethers.getContractFactory("EquilibraFactory")
  ).deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);

  // Seed at the base anchor: yWad = PS · xWad with xWad = 1e21.
  const seed0 = (2n * 10n ** 24n) / scale0;
  const seed1 = 10n ** 21n / scale1;
  await token0.mint(owner.address, seed0 * 2n);
  await token1.mint(owner.address, seed1 * 2n);
  await token0.approve(await factory.getAddress(), MaxUint256);
  await token1.approve(await factory.getAddress(), MaxUint256);
  await factory.createPoolAndAddLiquidity(
    await token0.getAddress(),
    await token1.getAddress(),
    {
      aWad,
      lambdaWad,
      baseFee: 30,
      emaPeriod: 1200,
      repegStepWad: 10n ** 15n,
      repegThresholdToken1UpWad: 10n ** 15n,
      repegThresholdToken1DownWad: 10n ** 15n,
      feeRampBps: 0,
      feeFloorBps: 20,
      repegShareBps: 5000,
    },
    seed0,
    seed1,
    owner.address
  );
  const pool = await hre.ethers.getContractAt(
    "MockEquilibraPool",
    await factory.allPools((await factory.allPoolsLength()) - 1n)
  );
  return { pool, scale0, scale1 };
}

// vp probe through the exact production `_computeLpUnitValueWad` path
// the post-repeg gate evaluates, with an explicit priceScale candidate.
async function vpAt(mp: MirrorPool, yWad: bigint, xWad: bigint, psCandidate: bigint): Promise<bigint> {
  return BigInt(
    await mp.pool.exposed_computeLpUnitValueWadAtPriceScale(
      yWad / mp.scale0, // reserve0 raw (quote side)
      xWad / mp.scale1, // reserve1 raw (base side)
      psCandidate,
      SUPPLY
    )
  );
}

describe("Geometric mirror invariance of the LP unit value", function () {
  for (const knobs of KNOBS) {
    it(`anchor: vp(ps·u) == vp(ps/u) to the wei — ${knobs.name}`, async function () {
      const mp = await loadFixture(async function anchorFixture() {
        return deployMirrorPool(knobs.aWad, knobs.lambdaWad, false);
      });
      // Anchor state: yWad = PS·xWad → yMath == xMath.
      const xWad = 10n ** 21n;
      const yWad = 2n * 10n ** 24n;
      for (const [p, q] of MIRRORS) {
        const up = await vpAt(mp, yWad, xWad, (PS * p) / q);
        const down = await vpAt(mp, yWad, xWad, (PS * q) / p);
        const diff = up > down ? up - down : down - up;
        expect(diff, `u=${p}/${q}: up=${up} down=${down}`).to.be.lte(2n);
        expect(up).to.be.gt(0n);
      }
    });
  }

  it("token decimals fold out: 6-dec quote is bit-identical to 18-dec", async function () {
    const k = KNOBS[0];
    const mp18 = await loadFixture(async function dec18Fixture() {
      return deployMirrorPool(k.aWad, k.lambdaWad, false);
    });
    const mp6 = await deployMirrorPool(k.aWad, k.lambdaWad, true);
    const xWad = 10n ** 21n;
    const yWad = 2n * 10n ** 24n;
    for (const [p, q] of MIRRORS) {
      for (const ps of [(PS * p) / q, (PS * q) / p]) {
        const v18 = await vpAt(mp18, yWad, xWad, ps);
        const v6 = await vpAt(mp6, yWad, xWad, ps);
        expect(v18, `ps=${ps}`).to.equal(v6);
      }
    }
  });

  it("off-anchor mirrored states suffer the identical relative vp change", async function () {
    const mp = await loadFixture(async function offAnchorFixture() {
      return deployMirrorPool(KNOBS[0].aWad, KNOBS[0].lambdaWad, false);
    });
    // Mirrored displacement d = 5% around x = 1.05e21 (both math states
    // wei-exact): state A has yMath = x·21/20, state B has yMath = x·20/21.
    const xWad = 105n * 10n ** 19n; // 1.05e21
    const yWadA = 2205n * 10n ** 21n; // yMath = 1.1025e21
    const yWadB = 2n * 10n ** 24n; //    yMath = 1.0e21
    const SCALE = 10n ** 36n;
    for (const [p, q] of MIRRORS) {
      // A is quote-heavy (EMA above anchor) → mirror move is UP ×u;
      // B is base-heavy (EMA below) → mirror move is DOWN ÷u.
      const beforeA = await vpAt(mp, yWadA, xWad, PS);
      const afterA = await vpAt(mp, yWadA, xWad, (PS * p) / q);
      const beforeB = await vpAt(mp, yWadB, xWad, PS);
      const afterB = await vpAt(mp, yWadB, xWad, (PS * q) / p);
      const ratioA = (afterA * SCALE) / beforeA;
      const ratioB = (afterB * SCALE) / beforeB;
      const diff = ratioA > ratioB ? ratioA - ratioB : ratioB - ratioA;
      // Exact in real arithmetic; independent floor stacks across the
      // four vp evaluations leave ~7e-21 relative (observed). Bound at
      // 1e-19 relative = 1e17 units of the 1e36-scaled ratio.
      expect(diff, `u=${p}/${q}: relΔup=${ratioA} relΔdown=${ratioB}`).to.be.lte(10n ** 17n);
    }
  });
});
