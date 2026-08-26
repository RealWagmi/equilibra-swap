import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const WAD = 10n ** 18n;
const PRESET = EQUILIBRA_PRESETS.WETH;
// Mirrors `Constants.MIN_INITIAL_LIQUIDITY` — the wei-count of "dead
// shares" burned to `address(0xdEaD)` on the genesis mint. The pool rejects any
// genesis seed whose geometric mean (`sqrt(xWad * yWad)`) does not
// exceed this floor with `MathInvariantViolation`.
const MIN_INITIAL_LIQUIDITY = 1_000_000n;

async function deployFixture() {
  const [owner, lp2] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const token0 = await Token.deploy("Token0", "TK0", 18);
  const token1 = await Token.deploy("Token1", "TK1", 18);
  await token0.waitForDeployment();
  await token1.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  const Provider = await hre.ethers.getContractFactory("MockMintCallbackProvider");
  const provider = await Provider.deploy();
  await provider.waitForDeployment();
  const providerAddr = await provider.getAddress();
  const factoryAddr = await factory.getAddress();

  const supply = hre.ethers.parseEther("10000000");
  await token0.mint(owner.address, supply);
  await token1.mint(owner.address, supply);
  await token0.mint(lp2.address, supply);
  await token1.mint(lp2.address, supply);

  // Owner seeds the bootstrap via the factory; subsequent deposits flow
  // through the mock callback provider (still requires approvals).
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);
  await token0.approve(providerAddr, MaxUint256);
  await token1.approve(providerAddr, MaxUint256);
  await token0.connect(lp2).approve(providerAddr, MaxUint256);
  await token1.connect(lp2).approve(providerAddr, MaxUint256);

  // Helper: bootstraps a pool with the supplied seed amounts and returns
  // its address (atomic create + initial mint via the factory).
  async function bootstrap(
    a0: bigint,
    a1: bigint,
    minShares: bigint = 0n,
    recipient: string = owner.address
  ): Promise<string> {
    await factory.createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      {
        aWad: PRESET.aWad,
        lambdaWad: PRESET.lambdaWad,
        baseFee: 30,
        emaPeriod: 1200,
        repegStepWad: hre.ethers.parseUnits("1", 15),
        repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
        repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
        feeRampBps: 0,
        feeFloorBps: 20,
        repegShareBps: 5000,
      },
      a0,
      a1,
      recipient
    );
    return await factory.allPools((await factory.allPoolsLength()) - 1n);
  }

  return { owner, lp2, token0, token1, factory, provider, bootstrap };
}

describe("ProportionalDeposit", function () {
  it("bootstrap mints sqrt-based shares minus dead shares", async function () {
    const { owner, bootstrap } = await loadFixture(deployFixture);

    const a0 = hre.ethers.parseEther("1000");
    const a1 = hre.ethers.parseEther("4000");

    const poolAddress = await bootstrap(a0, a1);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

    const totalSupply = await pool.totalSupply();
    // sqrt(1000e18 * 4000e18) = sqrt(4e42) = 2e21 = 2000e18
    const expectedShares = 2000n * WAD - MIN_INITIAL_LIQUIDITY;
    expect(totalSupply).to.equal(expectedShares + MIN_INITIAL_LIQUIDITY);

    const ownerBal = await pool.balanceOf(owner.address);
    expect(ownerBal).to.equal(expectedShares);
  });

  it("second equal deposit gives equal shares", async function () {
    const { owner, lp2, provider, bootstrap } = await loadFixture(deployFixture);

    const a0 = hre.ethers.parseEther("1000");
    const a1 = hre.ethers.parseEther("1000");

    const poolAddress = await bootstrap(a0, a1);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
    const sharesOwner = await pool.balanceOf(owner.address);

    await provider.connect(lp2).addLiquidity(poolAddress, a0, a1, 0, lp2.address);
    const sharesLp2 = await pool.balanceOf(lp2.address);

    // LP2 gets slightly more than owner because owner was diluted by
    // dead shares (`MIN_INITIAL_LIQUIDITY` wei).
    expect(sharesLp2 - sharesOwner).to.equal(MIN_INITIAL_LIQUIDITY);
  });

  it("returns excess token1 when amount1 is too large", async function () {
    const { lp2, token1, provider, bootstrap } = await loadFixture(deployFixture);

    const a0 = hre.ethers.parseEther("1000");
    const a1 = hre.ethers.parseEther("1000");
    const poolAddress = await bootstrap(a0, a1);

    // LP2 deposits proportional amount0 but excess amount1.
    // With callback pattern, only the used amount is pulled — no excess transferred.
    const deposit0 = hre.ethers.parseEther("500");
    const deposit1 = hre.ethers.parseEther("2000"); // 4x the needed ratio

    const bal1Before = await token1.balanceOf(lp2.address);
    await provider.connect(lp2).addLiquidity(poolAddress, deposit0, deposit1, 0, lp2.address);
    const bal1After = await token1.balanceOf(lp2.address);

    // Should have spent only 500 of token1 (matching 500 token0 at 1:1 ratio).
    const spent1 = bal1Before - bal1After;
    expect(spent1).to.equal(deposit0); // 500e18

    expect(bal1After).to.equal(bal1Before - deposit0);
  });

  it("returns excess token0 when amount0 is too large", async function () {
    const { lp2, token0, provider, bootstrap } = await loadFixture(deployFixture);

    const a0 = hre.ethers.parseEther("1000");
    const a1 = hre.ethers.parseEther("1000");
    const poolAddress = await bootstrap(a0, a1);

    const deposit0 = hre.ethers.parseEther("3000");
    const deposit1 = hre.ethers.parseEther("500");

    const bal0Before = await token0.balanceOf(lp2.address);
    await provider.connect(lp2).addLiquidity(poolAddress, deposit0, deposit1, 0, lp2.address);
    const bal0After = await token0.balanceOf(lp2.address);

    const spent0 = bal0Before - bal0After;
    expect(spent0).to.equal(deposit1); // 500e18 at 1:1 ratio
  });

  it("no excess when amounts are perfectly proportional", async function () {
    const { lp2, token0, token1, provider, bootstrap } = await loadFixture(deployFixture);

    const a0 = hre.ethers.parseEther("1000");
    const a1 = hre.ethers.parseEther("1000");
    const poolAddress = await bootstrap(a0, a1);

    const bal0Before = await token0.balanceOf(lp2.address);
    const bal1Before = await token1.balanceOf(lp2.address);

    const deposit = hre.ethers.parseEther("500");
    await provider.connect(lp2).addLiquidity(poolAddress, deposit, deposit, 0, lp2.address);

    const spent0 = bal0Before - (await token0.balanceOf(lp2.address));
    const spent1 = bal1Before - (await token1.balanceOf(lp2.address));
    expect(spent0).to.equal(deposit);
    expect(spent1).to.equal(deposit);
  });

  it("emits LiquidityAdded with actual used amounts", async function () {
    const { lp2, provider, bootstrap } = await loadFixture(deployFixture);

    const poolAddress = await bootstrap(hre.ethers.parseEther("1000"), hre.ethers.parseEther("1000"));
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

    const deposit0 = hre.ethers.parseEther("500");
    const deposit1 = hre.ethers.parseEther("2000");
    const providerAddr = await provider.getAddress();

    await expect(provider.connect(lp2).addLiquidity(poolAddress, deposit0, deposit1, 0, lp2.address))
      .to.emit(pool, "LiquidityAdded")
      .withArgs(
        providerAddr, // sender is the provider contract (msg.sender of pool)
        lp2.address,
        deposit0, // amount0Used = 500 (binding side)
        deposit0, // amount1Used = 500 (proportional at 1:1)
        (shares: bigint) => shares > 0n
      );
  });

  it("proportional deposit does not move anchor price", async function () {
    const { lp2, provider, bootstrap } = await loadFixture(deployFixture);

    const poolAddress = await bootstrap(hre.ethers.parseEther("1000"), hre.ethers.parseEther("1000"));
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

    const anchorBefore = (await pool.getOracleState()).priceScaleWad;

    await provider
      .connect(lp2)
      .addLiquidity(poolAddress, hre.ethers.parseEther("500"), hre.ethers.parseEther("500"), 0, lp2.address);

    const anchorAfter = (await pool.getOracleState()).priceScaleWad;
    expect(anchorAfter).to.equal(anchorBefore);
  });

  it("reverts on slippage when minShares not met", async function () {
    const { lp2, provider, bootstrap } = await loadFixture(deployFixture);

    const poolAddress = await bootstrap(hre.ethers.parseEther("1000"), hre.ethers.parseEther("1000"));
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

    await expect(
      provider.connect(lp2).addLiquidity(
        poolAddress,
        hre.ethers.parseEther("100"),
        hre.ethers.parseEther("100"),
        hre.ethers.parseEther("999999"), // impossibly high minShares
        lp2.address
      )
    ).to.be.revertedWithCustomError(pool, "SlippageExceeded");
  });

  it("shares scale linearly with deposit size", async function () {
    const { lp2, provider, bootstrap } = await loadFixture(deployFixture);

    const base = hre.ethers.parseEther("1000");
    const poolAddress = await bootstrap(base, base);
    const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

    // Deposit 1x
    await provider.connect(lp2).addLiquidity(poolAddress, base, base, 0, lp2.address);
    const shares1x = await pool.balanceOf(lp2.address);

    // Fresh fixture for the 2x leg: bootstrap a brand-new pool, then
    // deposit 2x base from lp2.
    const fixture2 = await loadFixture(deployFixture);
    const pa2 = await fixture2.bootstrap(base, base);
    const pool2 = await hre.ethers.getContractAt("EquilibraPool", pa2);
    await fixture2.provider.connect(fixture2.lp2).addLiquidity(pa2, base * 2n, base * 2n, 0, fixture2.lp2.address);
    const shares2x = await pool2.balanceOf(fixture2.lp2.address);

    // 2x deposit gives 2x shares within a single wei. The 1-wei tolerance
    // tracks the `mulDiv(amount0, supplyBefore, reserve0)` floor — a
    // tighter bound is structurally impossible without rounding the
    // shares formula upwards (which would inflate the supply by 1 wei
    // on every legit deposit).
    expect(shares2x).to.be.closeTo(shares1x * 2n, 1n);
  });

  // -------------------------------------------------------------------------
  // Negative paths and boundary conditions on the genesis + follow-up
  // mint pipeline. These exercise the pool's structural guards that the
  // earlier "happy path" tests rely on but never explicitly trigger.
  // -------------------------------------------------------------------------

  describe("genesis revert paths", function () {
    it("rejects amount0 == 0 with ZeroAmount", async function () {
      const { owner, factory, token0, token1 } = await loadFixture(deployFixture);
      // The `_addLiquidity` guard at line 650 fires before any of the
      // genesis-specific math, so this revert path is shared with the
      // follow-up deposit code path.
      await expect(
        factory.createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 30,
            emaPeriod: 1200,
            repegStepWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
            feeRampBps: 0,
            feeFloorBps: 20,
            repegShareBps: 5_000,
          },
          0n, // amount0 == 0
          hre.ethers.parseEther("1000"),
          owner.address
        )
      ).to.be.revertedWithCustomError(await hre.ethers.getContractFactory("EquilibraPool"), "ZeroAmount");
    });

    it("rejects amount1 == 0 with ZeroAmount", async function () {
      const { owner, factory, token0, token1 } = await loadFixture(deployFixture);
      await expect(
        factory.createPoolAndAddLiquidity(
          await token0.getAddress(),
          await token1.getAddress(),
          {
            aWad: PRESET.aWad,
            lambdaWad: PRESET.lambdaWad,
            baseFee: 30,
            emaPeriod: 1200,
            repegStepWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
            repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
            feeRampBps: 0,
            feeFloorBps: 20,
            repegShareBps: 5_000,
          },
          hre.ethers.parseEther("1000"),
          0n,
          owner.address
        )
      ).to.be.revertedWithCustomError(await hre.ethers.getContractFactory("EquilibraPool"), "ZeroAmount");
    });

    it("rejects genesis seeds whose geomean does not exceed MIN_INITIAL_LIQUIDITY", async function () {
      const { bootstrap } = await loadFixture(deployFixture);
      const Pool = await hre.ethers.getContractFactory("EquilibraPool");
      // geomean == floor: strict `<= MIN_INITIAL_LIQUIDITY` reverts
      // before the precision gate is even reached.
      await expect(bootstrap(MIN_INITIAL_LIQUIDITY, MIN_INITIAL_LIQUIDITY)).to.be.revertedWithCustomError(
        Pool,
        "MathInvariantViolation"
      );
      await expect(bootstrap(1n, 1n)).to.be.revertedWithCustomError(Pool, "MathInvariantViolation");
    });

    it("rejects genesis seeds that clear the supply floor but under-resolve the kernel", async function () {
      const { bootstrap } = await loadFixture(deployFixture);
      const Pool = await hre.ethers.getContractFactory("EquilibraPool");
      // Both seeds clear the 1e6 supply floor yet sit in the region
      // where the asymmetric-coord kernel cannot resolve the `2·WAD`
      // genesis identity, so the precision gate (`GenesisVpImprecise`)
      // rejects them. Without this gate the stored genesis floor would
      // understate the LP principal the auto-repeg gate protects.
      //   1e8 raw 18-dec: nWad = floor((1e8)² / 1e18) = 0 -> vp 0.
      await expect(bootstrap(10n ** 8n, 10n ** 8n)).to.be.revertedWithCustomError(Pool, "GenesisVpImprecise");
      //   1e9 raw 18-dec: nWad > 0 but L is materially understated
      //   -> vp ~= 0.90961·WAD (live WETH preset a), ~1.09e18 off 2·WAD.
      await expect(bootstrap(10n ** 9n, 10n ** 9n)).to.be.revertedWithCustomError(Pool, "GenesisVpImprecise");
    });

    it("accepts a material genesis seed and stores vp within tolerance of 2·WAD", async function () {
      const { bootstrap } = await loadFixture(deployFixture);
      // 1 whole 18-dec token per side: the kernel resolves the identity
      // to within a few wei of 2·WAD, so genesis is accepted.
      const poolAddress = await bootstrap(WAD, WAD);
      const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
      const lv = await pool.getLpValueState();
      const twoWad = 2n * WAD;
      const err = lv.genesisWad > twoWad ? lv.genesisWad - twoWad : twoWad - lv.genesisWad;
      expect(err).to.be.lessThanOrEqual(4n * 10n ** 10n);
      // Supply is the geomean; recipient got geomean - dead shares.
      const totalSupply = await pool.totalSupply();
      expect(totalSupply).to.equal(WAD);
      expect(await pool.balanceOf((await hre.ethers.getSigners())[0].address)).to.be.greaterThan(0n);
    });
  });

  describe("mint callback strict delta check", function () {
    it("reverts with UnsupportedTokenBehavior when the callback under-pays token0", async function () {
      // Genesis the pool first via the well-behaved factory path, then
      // try a follow-up deposit through a deliberately under-paying
      // mint provider. The pool's `bal0Before == bal0After + amount0Used`
      // check (line 747-750 in EquilibraPool.sol) must reject by
      // exactly 1 wei.
      const { lp2, token0, token1, bootstrap } = await loadFixture(deployFixture);
      const seed = hre.ethers.parseEther("1000");
      const poolAddress = await bootstrap(seed, seed);

      const Provider = await hre.ethers.getContractFactory("MockUnderpayingMintProvider");
      const evil = await Provider.deploy();
      await evil.waitForDeployment();
      const evilAddr = await evil.getAddress();

      // LP2 must approve the under-paying provider so the callback
      // even has a shot at pulling funds (it'll then short the
      // transfer by `shortfall0` wei).
      await token0.connect(lp2).approve(evilAddr, MaxUint256);
      await token1.connect(lp2).approve(evilAddr, MaxUint256);
      await evil.setShortfall0(1n);

      const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);
      await expect(
        evil
          .connect(lp2)
          .addLiquidity(poolAddress, hre.ethers.parseEther("100"), hre.ethers.parseEther("100"), 0, lp2.address)
      ).to.be.revertedWithCustomError(pool, "UnsupportedTokenBehavior");
    });
  });
});

describe("removeLiquidity dust guard (audit I-8)", function () {
  // Low-decimals pool: raw reserves (1e12) sit far below the WAD-scale
  // LP supply (~1e24), so a small-but-nonzero share amount floors BOTH
  // proportional payouts to zero. Before the guard the pool silently
  // burned those shares for nothing.
  async function lowDecimalsFixture() {
    const [owner] = await hre.ethers.getSigners();
    const Token = await hre.ethers.getContractFactory("MockERC20");
    const token0 = await Token.deploy("USD Six", "USD6", 6);
    const token1 = await Token.deploy("EUR Six", "EUR6", 6);

    const poolImpl = await (await hre.ethers.getContractFactory("EquilibraPool")).deploy();
    const factory = await (
      await hre.ethers.getContractFactory("EquilibraFactory")
    ).deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);

    const seedRaw = 10n ** 12n; // 1e6 whole units at 6 decimals
    await token0.mint(owner.address, seedRaw * 4n);
    await token1.mint(owner.address, seedRaw * 4n);
    await token0.approve(await factory.getAddress(), MaxUint256);
    await token1.approve(await factory.getAddress(), MaxUint256);

    await factory.createPoolAndAddLiquidity(
      await token0.getAddress(),
      await token1.getAddress(),
      {
        aWad: PRESET.aWad,
        lambdaWad: PRESET.lambdaWad,
        baseFee: 30,
        emaPeriod: 1200,
        repegStepWad: hre.ethers.parseUnits("1", 15),
        repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
        repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
        feeRampBps: 0,
        feeFloorBps: 20,
        repegShareBps: 5000,
      },
      seedRaw,
      seedRaw,
      owner.address
    );
    const pool = await hre.ethers.getContractAt(
      "EquilibraPool",
      await factory.allPools((await factory.allPoolsLength()) - 1n)
    );
    return { owner, pool, token0, token1 };
  }

  it("reverts instead of burning shares for zero output", async function () {
    const { owner, pool } = await loadFixture(lowDecimalsFixture);
    const supply = await pool.totalSupply();
    const [r0] = await pool.getReserves();
    // Shares strictly below one raw-unit's worth: both payouts floor to 0.
    const dustShares = supply / r0 / 2n;
    expect(dustShares).to.be.gt(0n);
    const balBefore = await pool.balanceOf(owner.address);
    await expect(pool.removeLiquidity(dustShares, 0, 0, owner.address)).to.be.revertedWithCustomError(
      pool,
      "AmountTooSmallAfterNormalization"
    );
    // Shares untouched by the reverted call.
    expect(await pool.balanceOf(owner.address)).to.equal(balBefore);
  });

  it("still pays out normally above the dust threshold", async function () {
    const { owner, pool, token0, token1 } = await loadFixture(lowDecimalsFixture);
    const supply = await pool.totalSupply();
    const [r0] = await pool.getReserves();
    const okShares = (supply / r0) * 10n; // ~10 raw units' worth
    const bal0Before = await token0.balanceOf(owner.address);
    const bal1Before = await token1.balanceOf(owner.address);
    await pool.removeLiquidity(okShares, 0, 0, owner.address);
    const paid0 = (await token0.balanceOf(owner.address)) - bal0Before;
    const paid1 = (await token1.balanceOf(owner.address)) - bal1Before;
    expect(paid0 + paid1).to.be.gt(0n);
  });
});
