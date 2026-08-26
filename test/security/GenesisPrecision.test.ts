import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MaxUint256 } from "ethers";

// Genesis LP-unit-value precision gate.
//
// In exact arithmetic every non-degenerate genesis state yields
// vp = 2·WAD; only integer rounding perturbs it. Insufficient normalized
// depth or an extreme ratio that quantizes priceScale too coarsely can
// store an inaccurate genesis floor, which would let auto-repeg spend LP
// principal the floor is meant to preserve. The pool rejects such a genesis
// (`GenesisVpImprecise`), so the whole "dust pool -> later material
// liquidity -> repeg below baseline" vector is structurally closed: the
// dust pool cannot be created in the first place.

const WAD = 10n ** 18n;
const TWO_WAD = 2n * WAD;
const TOL = 4n * 10n ** 10n; // Constants.MAX_GENESIS_VP_ERROR_WAD

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

async function stack() {
  const [owner] = await hre.ethers.getSigners();
  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const impl = await PoolImpl.deploy();
  await impl.waitForDeployment();
  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await impl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth: any = await Weth.deploy();
  await weth.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(await factory.getAddress(), await impl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  return { owner, factory, router };
}

async function makeTokens(decA: number, decB: number) {
  const [owner] = await hre.ethers.getSigners();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const ta: any = await Token.deploy("A", "A", decA);
  const tb: any = await Token.deploy("B", "B", decB);
  await ta.waitForDeployment();
  await tb.waitForDeployment();
  await ta.mint(owner.address, MaxUint256 / 2n);
  await tb.mint(owner.address, MaxUint256 / 2n);
  return { ta, tb };
}

const CFG = {
  aWad: 843n * 10n ** 15n,
  lambdaWad: 323n * 10n ** 14n,
  baseFee: 100,
  emaPeriod: 600,
  repegStepWad: 5n * 10n ** 15n,
  repegThresholdToken1UpWad: 1n * 10n ** 15n,
  repegThresholdToken1DownWad: 1n * 10n ** 15n,
  feeRampBps: 0,
  feeFloorBps: 0,
  repegShareBps: 5000,
};

// Deploy one pool with the given raw seeds; returns the pool or throws.
async function seed(factory: any, ta: any, tb: any, rawA: bigint, rawB: bigint, cfg = CFG) {
  await ta.approve(await factory.getAddress(), MaxUint256);
  await tb.approve(await factory.getAddress(), MaxUint256);
  const aAddr = (await ta.getAddress()).toLowerCase();
  const bAddr = (await tb.getAddress()).toLowerCase();
  const aIs0 = aAddr < bAddr;
  const owner = (await hre.ethers.getSigners())[0];
  await factory.createPoolAndAddLiquidity(
    aIs0 ? await ta.getAddress() : await tb.getAddress(),
    aIs0 ? await tb.getAddress() : await ta.getAddress(),
    cfg,
    aIs0 ? rawA : rawB,
    aIs0 ? rawB : rawA,
    owner.address
  );
  const n = await factory.allPoolsLength();
  return hre.ethers.getContractAt("EquilibraPool", await factory.allPools(n - 1n));
}

describe("Genesis precision gate", () => {
  async function fixture() {
    return stack();
  }

  it("rejects a dust seed (1001/1001, 18-dec) before it can exist", async () => {
    const { factory } = await loadFixture(fixture);
    const { ta, tb } = await makeTokens(18, 18);
    const Pool = await hre.ethers.getContractFactory("EquilibraPool");
    // geomean 1001 <= 1e6 supply floor -> MathInvariantViolation.
    await expect(seed(factory, ta, tb, 1001n, 1001n)).to.be.revertedWithCustomError(Pool, "MathInvariantViolation");
  });

  it("rejects the degenerate (nWad=0) and understated (nWad>0) regions above the supply floor", async () => {
    const { factory } = await loadFixture(fixture);
    const Pool = await hre.ethers.getContractFactory("EquilibraPool");
    // 1e8 clears the 1e6 supply floor but floors nWad to 0 -> vp 0.
    {
      const { ta, tb } = await makeTokens(18, 18);
      await expect(seed(factory, ta, tb, 10n ** 8n, 10n ** 8n))
        .to.be.revertedWithCustomError(Pool, "GenesisVpImprecise")
        .withArgs(0n); // degenerate: nWad floors to 0 -> vp 0
    }
    // 1e10 has nWad > 0 but a materially understated L -> vp far off 2·WAD.
    {
      const { ta, tb } = await makeTokens(18, 18);
      await expect(seed(factory, ta, tb, 10n ** 10n, 10n ** 10n)).to.be.revertedWithCustomError(
        Pool,
        "GenesisVpImprecise"
      );
    }
  });

  it("accepts material seeds across decimals and ratios, storing vp within tolerance", async () => {
    const { factory } = await loadFixture(fixture);
    // (decA, decB, rawA-in-tokens, rawB-in-tokens): balanced and skewed.
    const cases: [number, number, bigint, bigint][] = [
      [18, 18, 1n, 1n],
      [18, 18, 1n, 3000n],
      [18, 6, 5n, 5n],
      [6, 18, 10n, 30000n],
      [8, 18, 2n, 6000n],
      [6, 6, 1n, 1n],
    ];
    for (const [dA, dB, uA, uB] of cases) {
      const { ta, tb } = await makeTokens(dA, dB);
      const pool: any = await seed(factory, ta, tb, uA * 10n ** BigInt(dA), uB * 10n ** BigInt(dB));
      const lv = await pool.getLpValueState();
      expect(
        absDiff(lv.genesisWad, TWO_WAD),
        `dec ${dA}/${dB} seed ${uA}/${uB}: genesis ${lv.genesisWad}`
      ).to.be.lessThanOrEqual(TOL);
      // The stored high-water mark equals genesis at creation.
      expect(lv.unitValueWad).to.equal(lv.genesisWad);
    }
  });

  it("straddles the tolerance boundary: accepts just inside, rejects just outside", async () => {
    const { factory } = await loadFixture(fixture);
    const Pool = await hre.ethers.getContractFactory("EquilibraPool");

    // Exact production-kernel vectors straddling TOL (= 4e10). Acceptance
    // is a VP-error policy, not a monotone raw-reserve threshold: the
    // larger second vector has slightly worse fixed-point cancellation and
    // lands just OUTSIDE the band, so it must be rejected.
    {
      const { ta, tb } = await makeTokens(18, 18);
      const pool: any = await seed(factory, ta, tb, 4_116_559_088_214n, 4_116_559_088_214n);
      const lv = await pool.getLpValueState();
      // 88_308 wei inside the tolerance (TOL - 88_308).
      expect(absDiff(lv.genesisWad, TWO_WAD)).to.equal(39_999_911_692n);
      expect(absDiff(lv.genesisWad, TWO_WAD)).to.be.lessThanOrEqual(TOL);
    }
    {
      const { ta, tb } = await makeTokens(18, 18);
      // vpErr = 40_000_721_825 = TOL + 721_825, just outside the band.
      await expect(seed(factory, ta, tb, 6_215_937_829_629n, 6_215_937_829_629n))
        .to.be.revertedWithCustomError(Pool, "GenesisVpImprecise")
        .withArgs(1_999_999_959_999_278_175n);
    }
  });

  it("rejects an extreme anchor ratio whose priceScale quantization cannot meet policy", async () => {
    const { factory } = await loadFixture(fixture);
    const { ta, tb } = await makeTokens(18, 18);
    const Pool = await hre.ethers.getContractFactory("EquilibraPool");
    const aIsToken0 = (await ta.getAddress()).toLowerCase() < (await tb.getAddress()).toLowerCase();
    const small = WAD;
    const large = 777_777_777_777_777n * WAD;
    // Force token0/y to the small side and token1/x to the large side,
    // producing priceScaleWad=1285. Proportional seed growth cannot improve
    // that ratio quantization, so the error text must not promise that it can.
    const rawA = aIsToken0 ? small : large;
    const rawB = aIsToken0 ? large : small;
    await expect(seed(factory, ta, tb, rawA, rawB))
      .to.be.revertedWithCustomError(Pool, "GenesisVpImprecise")
      .withArgs(2_000_000_056_202_507_187n);
  });

  it("an accepted pool quotes and swaps in both directions", async () => {
    const { owner, factory, router } = await loadFixture(fixture);
    const { ta, tb } = await makeTokens(18, 18);
    const pool: any = await seed(factory, ta, tb, 1000n * WAD, 3_000_000n * WAD);
    const meta = await pool.getPoolMetadata();
    const token0: any = (await ta.getAddress()).toLowerCase() === meta.token0.toLowerCase() ? ta : tb;
    const token1: any = token0 === ta ? tb : ta;
    await token0.approve(await router.getAddress(), MaxUint256);
    await token1.approve(await router.getAddress(), MaxUint256);

    for (const [tokenIn, tokenOut] of [
      [token0, token1],
      [token1, token0],
    ] as const) {
      const zeroForOne = (await tokenIn.getAddress()).toLowerCase() === meta.token0.toLowerCase();
      expect(await pool.quoteExactIn(zeroForOne, WAD)).to.be.greaterThan(0n);
      const before = await tokenOut.balanceOf(owner.address);
      await router.exactInputSingle({
        tokenIn: await tokenIn.getAddress(),
        tokenOut: await tokenOut.getAddress(),
        poolIndex: 0,
        amountIn: WAD,
        amountOutMinimum: 1n,
        recipient: owner.address,
        deadline: MaxUint256,
      });
      expect(await tokenOut.balanceOf(owner.address)).to.be.greaterThan(before);
    }
  });

  it("an accepted near-boundary seed cannot gain more than one guard of unbooked headroom", async () => {
    const { owner, factory, router } = await loadFixture(fixture);
    const { ta, tb } = await makeTokens(18, 18);
    const pool: any = await seed(factory, ta, tb, 4_116_559_088_214n, 4_116_559_088_214n);
    const meta = await pool.getPoolMetadata();
    const token0: any = (await ta.getAddress()).toLowerCase() === meta.token0.toLowerCase() ? ta : tb;
    const token1: any = token0 === ta ? tb : ta;
    await token0.approve(await router.getAddress(), MaxUint256);
    await token1.approve(await router.getAddress(), MaxUint256);
    const genesis = (await pool.getLpValueState()).genesisWad;

    await router.addLiquidity({
      tokenA: meta.token0,
      tokenB: meta.token1,
      poolIndex: 0,
      amountADesired: WAD,
      amountBDesired: WAD,
      minShares: 0n,
      recipient: owner.address,
      deadline: MaxUint256,
    });

    const after = await pool.getLpValueState();
    expect(after.genesisWad).to.equal(genesis);
    const unbookedHeadroom = after.unitValueWad > genesis ? after.unitValueWad - genesis : 0n;
    expect(unbookedHeadroom).to.be.lessThanOrEqual(TOL);
  });
});
