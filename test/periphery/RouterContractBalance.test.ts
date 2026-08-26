// CONTRACT_BALANCE sentinel on the exact-input entrypoints:
// `amountIn == type(uint256).max` consumes the router's entire current
// balance of the leg's input token and pays the leg from the router.
// Composition target: multicall fans where earlier legs stage output on
// the router (`recipient = address(0)`) and the sentinel leg absorbs
// the whole staged pot (drift included), closed by sweepToken.
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

const CONFIG = {
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
};

const SEED = hre.ethers.parseEther("100000");
const SENTINEL = MaxUint256;

describe("Router CONTRACT_BALANCE sentinel", function () {
  async function deployFixture() {
    const [owner, trader] = await hre.ethers.getSigners();

    const Token = await hre.ethers.getContractFactory("MockERC20");
    const tokenA = await Token.deploy("TokenA", "TKA", 18);
    const tokenB = await Token.deploy("TokenB", "TKB", 18);
    const tokenC = await Token.deploy("TokenC", "TKC", 18);
    for (const t of [tokenA, tokenB, tokenC]) await t.waitForDeployment();

    const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
    const poolImpl = await PoolImpl.deploy();
    await poolImpl.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
    const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();

    const Weth = await hre.ethers.getContractFactory("MockWETH9");
    const weth = await Weth.deploy();
    await weth.waitForDeployment();

    const Router = await hre.ethers.getContractFactory("EquilibraRouter");
    const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth.getAddress());
    await router.waitForDeployment();
    const routerAddr = await router.getAddress();

    const [aAddr, bAddr, cAddr] = await Promise.all([tokenA.getAddress(), tokenB.getAddress(), tokenC.getAddress()]);

    for (const t of [tokenA, tokenB, tokenC]) {
      await t.mint(owner.address, SEED * 8n);
      await t.approve(factoryAddr, MaxUint256);
    }
    // Pair A/B gets TWO pools (fan across pools of one pair) + pair B/C.
    await factory.createPoolAndAddLiquidity(aAddr, bAddr, CONFIG, SEED, SEED, owner.address);
    await factory.createPoolAndAddLiquidity(aAddr, bAddr, CONFIG, SEED, SEED, owner.address);
    await factory.createPoolAndAddLiquidity(bAddr, cAddr, CONFIG, SEED, SEED, owner.address);
    await factory.createPoolAndAddLiquidity(aAddr, cAddr, CONFIG, SEED, SEED, owner.address);

    const poolsAB = await factory.getPoolsByPair(aAddr, bAddr);
    const poolsBC = await factory.getPoolsByPair(bAddr, cAddr);
    const poolsAC = await factory.getPoolsByPair(aAddr, cAddr);
    const poolAB0 = await hre.ethers.getContractAt("EquilibraPool", poolsAB[0]);
    const poolAB1 = await hre.ethers.getContractAt("EquilibraPool", poolsAB[1]);
    const poolBC = await hre.ethers.getContractAt("EquilibraPool", poolsBC[0]);
    const poolAC = await hre.ethers.getContractAt("EquilibraPool", poolsAC[0]);

    await tokenA.mint(trader.address, SEED);
    await tokenA.connect(trader).approve(routerAddr, MaxUint256);

    async function quote(pool: any, tokenIn: string, amountIn: bigint): Promise<bigint> {
      const meta = await pool.getPoolMetadata();
      return pool.quoteExactIn(meta.token0 === tokenIn, amountIn);
    }

    function encSwapSingle(
      tokenIn: string,
      tokenOut: string,
      poolIndex: number,
      amountIn: bigint,
      recipient: string,
      amountOutMinimum: bigint
    ) {
      return router.interface.encodeFunctionData("exactInputSingle", [
        { tokenIn, tokenOut, poolIndex, recipient, amountIn, amountOutMinimum, deadline: MaxUint256 },
      ]);
    }

    return {
      owner,
      trader,
      tokenA,
      tokenB,
      tokenC,
      aAddr,
      bAddr,
      cAddr,
      router,
      routerAddr,
      poolAB0,
      poolAB1,
      poolBC,
      poolAC,
      quote,
      encSwapSingle,
    };
  }

  async function expectNoResidue(fx: Awaited<ReturnType<typeof deployFixture>>) {
    for (const t of [fx.tokenA, fx.tokenB, fx.tokenC]) {
      expect(await t.balanceOf(fx.routerAddr)).to.equal(0n);
    }
  }

  it("consumes the whole staged balance and pays from the router (single-hop chain)", async function () {
    const fx = await loadFixture(deployFixture);
    const x = hre.ethers.parseEther("5");
    const outB = await fx.quote(fx.poolAB0, fx.aAddr, x);
    const outC = await fx.quote(fx.poolBC, fx.bAddr, outB);

    await fx.router.connect(fx.trader).multicall([
      fx.encSwapSingle(fx.aAddr, fx.bAddr, 0, x, hre.ethers.ZeroAddress, outB),
      // Sentinel leg: exact quotes make the staged balance fully
      // predictable, so the minimum can pin the output bit-exactly.
      fx.encSwapSingle(fx.bAddr, fx.cAddr, 0, SENTINEL, fx.trader.address, outC),
    ]);

    expect(await fx.tokenC.balanceOf(fx.trader.address)).to.equal(outC);
    await expectNoResidue(fx);
  });

  it("fan: exact wallet legs stage output on two pools, the sentinel leg absorbs the pot", async function () {
    const fx = await loadFixture(deployFixture);
    const x1 = hre.ethers.parseEther("3");
    const x2 = hre.ethers.parseEther("7");
    // Stray tokenB sent to the router in a SEPARATE earlier transaction:
    // the sentinel consumes the LIVE balance regardless of provenance,
    // so the pot is out1 + out2 + stray (in production such a stray is
    // equally sweepable by anyone — never pre-fund deliberately).
    const stray = hre.ethers.parseEther("0.5") + 1n;
    await fx.tokenB.mint(fx.routerAddr, stray);
    const out1 = await fx.quote(fx.poolAB0, fx.aAddr, x1);
    const out2 = await fx.quote(fx.poolAB1, fx.aAddr, x2);
    const outC = await fx.quote(fx.poolBC, fx.bAddr, out1 + out2 + stray);

    await fx.router
      .connect(fx.trader)
      .multicall([
        fx.encSwapSingle(fx.aAddr, fx.bAddr, 0, x1, hre.ethers.ZeroAddress, out1),
        fx.encSwapSingle(fx.aAddr, fx.bAddr, 1, x2, hre.ethers.ZeroAddress, out2),
        fx.encSwapSingle(fx.bAddr, fx.cAddr, 0, SENTINEL, hre.ethers.ZeroAddress, outC),
        fx.router.interface.encodeFunctionData("sweepToken", [fx.cAddr, outC, fx.trader.address]),
      ]);

    expect(await fx.tokenC.balanceOf(fx.trader.address)).to.equal(outC);
    await expectNoResidue(fx);
  });

  it("accepts the sentinel on a genuine multi-hop exactInput (B -> C -> A)", async function () {
    const fx = await loadFixture(deployFixture);
    const x = hre.ethers.parseEther("4");
    const outB = await fx.quote(fx.poolAB0, fx.aAddr, x);
    const outC = await fx.quote(fx.poolBC, fx.bAddr, outB);
    const outA = await fx.quote(fx.poolAC, fx.cAddr, outC);
    const balABefore = await fx.tokenA.balanceOf(fx.trader.address);

    // 68-byte path => the hasMultiplePools branch runs, and the second
    // hop is funded by the router-payer handoff on top of the sentinel.
    const path = hre.ethers.solidityPacked(
      ["address", "uint32", "address", "uint32", "address"],
      [fx.bAddr, 0, fx.cAddr, 0, fx.aAddr]
    );
    await fx.router
      .connect(fx.trader)
      .multicall([
        fx.encSwapSingle(fx.aAddr, fx.bAddr, 0, x, hre.ethers.ZeroAddress, outB),
        fx.router.interface.encodeFunctionData("exactInput", [
          { path, recipient: fx.trader.address, amountIn: SENTINEL, amountOutMinimum: outA, deadline: MaxUint256 },
        ]),
      ]);

    expect(await fx.tokenA.balanceOf(fx.trader.address)).to.equal(balABefore - x + outA);
    await expectNoResidue(fx);
  });

  it("empty router balance under the sentinel fails the pool's zero-amount check", async function () {
    const fx = await loadFixture(deployFixture);
    await expect(
      fx.router.connect(fx.trader).exactInputSingle({
        tokenIn: fx.bAddr,
        tokenOut: fx.cAddr,
        poolIndex: 0,
        recipient: fx.trader.address,
        amountIn: SENTINEL,
        amountOutMinimum: 0n,
        deadline: MaxUint256,
      })
    ).to.be.revertedWithCustomError(fx.poolBC, "InvalidAmountSpecified");
  });

  it("enforces amountOutMinimum on the sentinel leg", async function () {
    const fx = await loadFixture(deployFixture);
    const x = hre.ethers.parseEther("5");
    const outB = await fx.quote(fx.poolAB0, fx.aAddr, x);
    const outC = await fx.quote(fx.poolBC, fx.bAddr, outB);

    await expect(
      fx.router
        .connect(fx.trader)
        .multicall([
          fx.encSwapSingle(fx.aAddr, fx.bAddr, 0, x, hre.ethers.ZeroAddress, outB),
          fx.encSwapSingle(fx.bAddr, fx.cAddr, 0, SENTINEL, fx.trader.address, outC + 1n),
        ])
    ).to.be.revertedWithCustomError(fx.router, "SlippageExceeded");
  });

  it("keeps rejecting every non-sentinel value above the int256 range", async function () {
    const fx = await loadFixture(deployFixture);
    // Solady's SafeCastLib reverts `Overflow()`; the error is not part
    // of the router ABI, so match the raw revert selector.
    const overflowSelector = hre.ethers.id("Overflow()").slice(0, 10);
    for (const amountIn of [SENTINEL - 1n, 1n << 255n]) {
      try {
        await fx.router.connect(fx.trader).exactInputSingle.staticCall({
          tokenIn: fx.aAddr,
          tokenOut: fx.bAddr,
          poolIndex: 0,
          recipient: fx.trader.address,
          amountIn,
          amountOutMinimum: 0n,
          deadline: MaxUint256,
        });
        expect.fail("expected Overflow() revert");
      } catch (e: any) {
        expect(e.data).to.equal(overflowSelector);
      }
    }
  });
});
