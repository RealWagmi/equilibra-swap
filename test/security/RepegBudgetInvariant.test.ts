import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const Q96_ONE = 1n << 96n;
const STEP_WAD = 1_000_000_000_000_000n; // 10 bp probe step (== repegStepWad)

// ---------------------------------------------------------------------------
// Repeg-budget PROPORTIONALITY invariants (design decision after Report.md
// "New LP inherits and scales old repeg headroom").
//
// The report showed that a proportional mint scales the ABSOLUTE budget
// B = (vp − floor)·S with supply. The protocol's considered answer is that
// this scaling is correct by design, because the IL cost of one repeg step
// scales with depth in exactly the same way:
//
//   - supply grows linearly with a proportional mint (S → k·S);
//   - the absolute impact of the SAME repeg step grows linearly too
//     (per-LP step impact |Δvp| depends only on reserves-per-share, which
//     a proportional mint leaves untouched);
//   - therefore the budget measured in REPEG STEPS — B / stepImpact — is
//     invariant: the new LP's principal underwrites exactly his pro-rata
//     share of both the budget and the per-step impacts, on entry AND on
//     exit.
//
// Combined with the factory floor bounds (MIN_BASE_FEE = 5 bps,
// MIN_EMA_PERIOD = 60 s), which make the manipulation phase of the report's
// cycle fee-negative for the attacker, this is the mitigation the protocol
// ships — no seal-on-mint. This suite pins the proportionality so any
// future accounting change that breaks it fails loudly.
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, bob, charlie, protocol] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA = await Token.deploy("Token A", "TKA", 18);
  const tokenB = await Token.deploy("Token B", "TKB", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  const [token0, token1] =
    (await tokenA.getAddress()).toLowerCase() < (await tokenB.getAddress()).toLowerCase()
      ? [tokenA, tokenB]
      : [tokenB, tokenA];
  const token0Address = await token0.getAddress();
  const token1Address = await token1.getAddress();

  // MockEquilibraPool as the implementation: bytecode-compatible subclass
  // re-exposing `_computeLpUnitValueWadAtPriceScale` so the test can price
  // a counterfactual repeg step without mutating pool state.
  const Pool = await hre.ethers.getContractFactory("MockEquilibraPool");
  const poolImpl = await Pool.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();
  await factory.setProtocolFee(0);
  await factory.setFeeCollector(protocol.address);

  const seed = hre.ethers.parseEther("1000000");
  await token0.mint(owner.address, seed);
  await token1.mint(owner.address, seed);
  for (const signer of [bob, charlie]) {
    await token0.mint(signer.address, hre.ethers.parseEther("20000000"));
    await token1.mint(signer.address, hre.ethers.parseEther("20000000"));
  }

  await token0.approve(await factory.getAddress(), MaxUint256);
  await token1.approve(await factory.getAddress(), MaxUint256);

  // Flat fee, 100% repeg share, zero protocol fee ⇒ the repeg floor IS the
  // genesis unit value, so the budget formula B = (vp − genesis)·S is exact.
  await factory.createPoolAndAddLiquidity(
    token0Address,
    token1Address,
    {
      aWad: 909_610_000_000_000_030n,
      lambdaWad: 16_780_000_000_000_000n,
      baseFee: 100, // 1% flat — growth accrues fast, ramp disabled
      emaPeriod: 60, // current MIN_EMA_PERIOD
      repegStepWad: STEP_WAD,
      repegThresholdToken1UpWad: 100_000_000_000_000n, // 1 bp
      repegThresholdToken1DownWad: 100_000_000_000_000n, // 1 bp
      feeRampBps: 0,
      feeFloorBps: 0,
      repegShareBps: 10_000,
    },
    seed,
    seed,
    owner.address
  );

  const pool = await hre.ethers.getContractAt("MockEquilibraPool", await factory.allPools(0));

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();
  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), await weth.getAddress());
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();

  for (const signer of [bob, charlie]) {
    await token0.connect(signer).approve(routerAddress, MaxUint256);
    await token1.connect(signer).approve(routerAddress, MaxUint256);
  }

  return { owner, bob, charlie, token0, token1, token0Address, token1Address, pool, router };
}

// Snapshot of every quantity the proportionality argument uses:
//   S             — total LP supply;
//   vp, genesis   — live unit value and the repeg floor (share=100%);
//   budget        — absolute spendable budget  B = (vp − genesis)·S;
//   stepImpactPerLp — |Δvp| per LP unit for ONE fixed 10 bp anchor
//                   displacement, priced against live reserves/supply via
//                   the mock probe. Sign note: vp has its MINIMUM at the
//                   diagonal (reserves balanced at the anchor), so a probe
//                   step from this fixture's diagonal state RAISES vp in
//                   either direction; the proportionality argument uses
//                   the magnitude, which is what scales with depth;
//   stepImpactAbs   — stepImpactPerLp·S (absolute per-step impact);
//   stepsAffordable — B / stepImpactAbs = (vp − genesis) / |Δvp| — supply
//                   cancels analytically; the test proves it numerically.
async function budgetSnapshot(pool: any) {
  const lp = await pool.getLpValueState();
  const supply = BigInt(await pool.totalSupply());
  const vp = BigInt(lp.unitValueWad);
  const genesis = BigInt(lp.genesisWad);
  const [reserve0, reserve1] = (await pool.getReserves()).map(BigInt);
  const ps = BigInt((await pool.getOracleState()).priceScaleWad);
  const psStepped = (ps * (WAD - STEP_WAD)) / WAD;
  const vpStepped = BigInt(await pool.exposed_computeLpUnitValueWadAtPriceScale(reserve0, reserve1, psStepped, supply));
  const stepImpactPerLp = vpStepped > vp ? vpStepped - vp : vp - vpStepped;
  return {
    supply,
    vp,
    genesis,
    stepImpactPerLp,
    budget: ((vp - genesis) * supply) / WAD,
    stepImpactAbs: (stepImpactPerLp * supply) / WAD,
  };
}

// Fee-funded growth without touching the anchor: forward swap + exact
// reverse in ONE multicall (one timestamp). The snapshot only discovers
// the reverse amount (calldata sizing, not an attack primitive).
async function buildHeadroom(
  pool: any,
  router: any,
  bob: any,
  token0Address: string,
  token1Address: string,
  cycles: number
) {
  const encodeSwap = (zeroForOne: boolean, amountIn: bigint) =>
    router.interface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn: zeroForOne ? token0Address : token1Address,
        tokenOut: zeroForOne ? token1Address : token0Address,
        poolIndex: 0,
        recipient: bob.address,
        amountIn,
        amountOutMinimum: 0n,
        deadline: MaxUint256,
      },
    ]);

  for (let cycle = 0; cycle < cycles; cycle++) {
    const [reserve0] = (await pool.getReserves()).map(BigInt);
    const amountIn = (reserve0 * 500n) / BPS; // 5% of token0 reserve
    const timestamp = BigInt(await time.latest()) + 1n;

    const snapshot = await hre.network.provider.send("evm_snapshot", []);
    await time.setNextBlockTimestamp(timestamp);
    await router.connect(bob).exactInputSingle({
      tokenIn: token0Address,
      tokenOut: token1Address,
      poolIndex: 0,
      recipient: bob.address,
      amountIn,
      amountOutMinimum: 0n,
      deadline: MaxUint256,
    });
    const [reverseAmount] = await pool.quoteSwapToPrice(false, Q96_ONE);
    await hre.network.provider.send("evm_revert", [snapshot]);

    await time.setNextBlockTimestamp(timestamp);
    await router.connect(bob).multicall([encodeSwap(true, amountIn), encodeSwap(false, BigInt(reverseAmount))]);
  }
}

describe("RepegBudgetLinearity: mint/burn scale budget and step cost proportionally", function () {
  this.timeout(120_000);

  it("per-LP quantities are invariant across a 4x mint and a full exit", async function () {
    const { bob, charlie, token0, token1, token0Address, token1Address, pool, router } = await deployFixture();

    await buildHeadroom(pool, router, bob, token0Address, token1Address, 5);

    const before = await budgetSnapshot(pool);
    expect(before.budget).to.be.greaterThan(0n);
    expect(before.stepImpactPerLp).to.be.greaterThan(0n);
    // No repeg consumed the budget while it was built.
    expect(BigInt((await pool.getOracleState()).priceScaleWad)).to.equal(WAD);

    // --- Charlie joins with 3x reserves (75% of post-mint supply) ---
    const [reserve0, reserve1] = (await pool.getReserves()).map(BigInt);
    const charlie0Before = BigInt(await token0.balanceOf(charlie.address));
    const charlie1Before = BigInt(await token1.balanceOf(charlie.address));
    await router.connect(charlie).addLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      recipient: charlie.address,
      amountADesired: reserve0 * 3n,
      amountBDesired: reserve1 * 3n,
      minShares: 0n,
      deadline: MaxUint256,
    });
    const charlieDeposit =
      charlie0Before -
      BigInt(await token0.balanceOf(charlie.address)) +
      (charlie1Before - BigInt(await token1.balanceOf(charlie.address)));

    const afterMint = await budgetSnapshot(pool);

    // Supply linear: 4x (±1% mulDiv dust).
    expect(afterMint.supply).to.be.closeTo(before.supply * 4n, before.supply / 100n);
    // Per-LP quantities invariant: unit value, floor, per-LP step impact.
    expect(afterMint.vp).to.be.closeTo(before.vp, 5n);
    expect(afterMint.genesis).to.equal(before.genesis);
    expect(afterMint.stepImpactPerLp).to.be.closeTo(before.stepImpactPerLp, 5n);

    // --- Charlie exits fully: state returns to pre-join ---
    const charlieShares = BigInt(await pool.balanceOf(charlie.address));
    await pool.connect(charlie).approve(await router.getAddress(), charlieShares);
    const charlieOut0Before = BigInt(await token0.balanceOf(charlie.address));
    const charlieOut1Before = BigInt(await token1.balanceOf(charlie.address));
    await router.connect(charlie).removeLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      shares: charlieShares,
      amountAMin: 0n,
      amountBMin: 0n,
      recipient: charlie.address,
      deadline: MaxUint256,
    });
    const charlieWithdrawn =
      BigInt(await token0.balanceOf(charlie.address)) -
      charlieOut0Before +
      (BigInt(await token1.balanceOf(charlie.address)) - charlieOut1Before);

    const afterBurn = await budgetSnapshot(pool);

    // Symmetric exit: supply back to pre-join, per-LP quantities restored.
    expect(afterBurn.supply).to.be.closeTo(before.supply, before.supply / 100n);
    expect(afterBurn.vp).to.be.closeTo(before.vp, 5n);
    expect(afterBurn.genesis).to.equal(before.genesis);
    expect(afterBurn.stepImpactPerLp).to.be.closeTo(before.stepImpactPerLp, 5n);

    // Fair pro-rata redemption: Charlie neither subsidises nor extracts —
    // he withdraws what he deposited (± rounding dust on share pricing).
    expect(charlieWithdrawn).to.be.closeTo(charlieDeposit, charlieDeposit / 10_000n + 10n ** 6n);
  });

  it("step impact and budget scale linearly with supply on mint, and shrink back on burn", async function () {
    const { bob, charlie, token0Address, token1Address, pool, router } = await deployFixture();

    await buildHeadroom(pool, router, bob, token0Address, token1Address, 5);

    const before = await budgetSnapshot(pool);

    const [reserve0, reserve1] = (await pool.getReserves()).map(BigInt);
    await router.connect(charlie).addLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      recipient: charlie.address,
      amountADesired: reserve0 * 3n,
      amountBDesired: reserve1 * 3n,
      minShares: 0n,
      deadline: MaxUint256,
    });

    const afterMint = await budgetSnapshot(pool);

    // Linearity on entry: the SAME 10 bp step impacts 4x more value in
    // absolute terms, and the absolute budget grew by the same 4x (±dust).
    expect(afterMint.stepImpactAbs).to.be.closeTo(before.stepImpactAbs * 4n, before.stepImpactAbs / 50n);
    expect(afterMint.budget).to.be.closeTo(before.budget * 4n, before.budget / 50n);

    const charlieShares = BigInt(await pool.balanceOf(charlie.address));
    await pool.connect(charlie).approve(await router.getAddress(), charlieShares);
    await router.connect(charlie).removeLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      shares: charlieShares,
      amountAMin: 0n,
      amountBMin: 0n,
      recipient: charlie.address,
      deadline: MaxUint256,
    });

    const afterBurn = await budgetSnapshot(pool);

    // Symmetry on exit: both quantities shrink back to pre-join values.
    expect(afterBurn.stepImpactAbs).to.be.closeTo(before.stepImpactAbs, before.stepImpactAbs / 50n + 1n);
    expect(afterBurn.budget).to.be.closeTo(before.budget, before.budget / 50n + 1n);
  });

  it("budget measured in repeg steps is invariant across mint and burn", async function () {
    const { bob, charlie, token0Address, token1Address, pool, router } = await deployFixture();

    await buildHeadroom(pool, router, bob, token0Address, token1Address, 5);

    // stepsAffordable = B / stepImpactAbs = (vp − genesis) / |Δvp| —
    // supply cancels analytically; assert it numerically across join/exit.
    const steps = (s: { budget: bigint; stepImpactAbs: bigint }) => (s.budget * WAD) / s.stepImpactAbs;

    const before = await budgetSnapshot(pool);

    const [reserve0, reserve1] = (await pool.getReserves()).map(BigInt);
    await router.connect(charlie).addLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      recipient: charlie.address,
      amountADesired: reserve0 * 3n,
      amountBDesired: reserve1 * 3n,
      minShares: 0n,
      deadline: MaxUint256,
    });

    const afterMint = await budgetSnapshot(pool);

    const charlieShares = BigInt(await pool.balanceOf(charlie.address));
    await pool.connect(charlie).approve(await router.getAddress(), charlieShares);
    await router.connect(charlie).removeLiquidity({
      tokenA: token0Address,
      tokenB: token1Address,
      poolIndex: 0,
      shares: charlieShares,
      amountAMin: 0n,
      amountBMin: 0n,
      recipient: charlie.address,
      deadline: MaxUint256,
    });

    const afterBurn = await budgetSnapshot(pool);

    // The conserved quantity of the design: however deep the pool gets,
    // the accumulated budget spans the SAME number of identical repeg
    // steps — the new LP underwrites his pro-rata share of both sides.
    const before2 = steps(before);
    expect(steps(afterMint)).to.be.closeTo(before2, before2 / 100n + 1n);
    expect(steps(afterBurn)).to.be.closeTo(before2, before2 / 100n + 1n);
  });
});
