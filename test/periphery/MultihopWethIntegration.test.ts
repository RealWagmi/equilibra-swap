import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256, ZeroAddress } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

// ---------------------------------------------------------------------------
// Integration tests: multi-hop swaps combined with WETH wrapping, Solady
// Multicall, `recipient = address(0)` capture, sweepToken and unwrapWETH9.
//
// Fixture layout (3 pools so we can build both linear and cyclic paths):
//   pool 0: WETH / tokenB
//   pool 1: tokenB / tokenC
//   pool 2: WETH / tokenC
// ---------------------------------------------------------------------------
function encodePath(tokens: string[], poolIndices: number[]): string {
  if (tokens.length !== poolIndices.length + 1) throw new Error("bad path lengths");
  let encoded = "0x";
  for (let i = 0; i < poolIndices.length; i++) {
    encoded += tokens[i].slice(2).toLowerCase();
    encoded += poolIndices[i].toString(16).padStart(8, "0");
  }
  encoded += tokens[tokens.length - 1].slice(2).toLowerCase();
  return encoded;
}

async function deployFixture() {
  const [owner, trader, recipient] = await hre.ethers.getSigners();

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth: any = await Weth.deploy();
  await weth.waitForDeployment();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenB: any = await Token.deploy("TokenB", "TKB", 18);
  const tokenC: any = await Token.deploy("TokenC", "TKC", 18);
  await tokenB.waitForDeployment();
  await tokenC.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl: any = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  const wethAddr = await weth.getAddress();
  const bAddr = await tokenB.getAddress();
  const cAddr = await tokenC.getAddress();

  const aWad = PRESET.aWad;
  const lambdaWad = PRESET.lambdaWad;
  const poolConfig = {
    baseFee: 30,
    emaPeriod: 1200,
    repegStepWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
    repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
    feeRampBps: 0,
    feeFloorBps: 20,
    repegShareBps: 5000,
  };

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), wethAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // Seed owner liquidity: equal notional units (1e24 of each side, scaled via anchor).
  const liquidity = hre.ethers.parseEther("1000000");

  // WETH side seeded by wrapping native ETH. Other side minted freely.
  await weth.deposit({ value: hre.ethers.parseEther("4000") }); // 2000 per WETH-pool
  await tokenB.mint(owner.address, liquidity * 10n);
  await tokenC.mint(owner.address, liquidity * 10n);

  // Genesis liquidity now flows through the factory (atomic deploy + seed),
  // so approve the factory on every owner-held token.
  const factoryAddr = await factory.getAddress();
  await weth.approve(factoryAddr, MaxUint256);
  await tokenB.approve(factoryAddr, MaxUint256);
  await tokenC.approve(factoryAddr, MaxUint256);

  // Seed each pool with 1e21 WETH-equivalent on both sides (simple 1:1 scale).
  // Pool 0: WETH/B  |  Pool 1: B/C  |  Pool 2: WETH/C
  const seed = hre.ethers.parseEther("1000");
  await factory.createPoolAndAddLiquidity(
    wethAddr,
    bAddr,
    { ...poolConfig, aWad: aWad, lambdaWad: lambdaWad },
    seed,
    seed,
    owner.address
  );
  await factory.createPoolAndAddLiquidity(
    bAddr,
    cAddr,
    { ...poolConfig, aWad: aWad, lambdaWad: lambdaWad },
    seed,
    seed,
    owner.address
  );
  await factory.createPoolAndAddLiquidity(
    wethAddr,
    cAddr,
    { ...poolConfig, aWad: aWad, lambdaWad: lambdaWad },
    seed,
    seed,
    owner.address
  );

  const poolWB: any = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
  const poolBC: any = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(1));
  const poolWC: any = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(2));

  // Fund + approve trader on plain ERC20s (WETH path uses native ETH via multicall).
  await tokenB.mint(trader.address, liquidity);
  await tokenC.mint(trader.address, liquidity);
  await tokenB.connect(trader).approve(routerAddr, MaxUint256);
  await tokenC.connect(trader).approve(routerAddr, MaxUint256);

  return {
    owner,
    trader,
    recipient,
    weth,
    tokenB,
    tokenC,
    wethAddr,
    bAddr,
    cAddr,
    router,
    routerAddr,
    factory,
  };
}

describe("Multi-hop + WETH + multicall integration", function () {
  it("multicall: native ETH -> B -> C (WETH wrap inside callback + refundETH)", async function () {
    const { router, routerAddr, trader, weth, tokenC, wethAddr, bAddr, cAddr } = await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("1");
    const path = encodePath([wethAddr, bAddr, cAddr], [0, 0]);

    const iface = router.interface;
    const swapCall = iface.encodeFunctionData("exactInput", [
      {
        path,
        recipient: trader.address,
        amountIn,
        amountOutMinimum: 0,
        deadline,
      },
    ]);
    const refundCall = iface.encodeFunctionData("refundETH");

    const tokenCBefore = await tokenC.balanceOf(trader.address);

    await router.connect(trader).multicall([swapCall, refundCall], { value: amountIn });

    const tokenCAfter = await tokenC.balanceOf(trader.address);

    // Trader received some C without approving any WETH beforehand.
    expect(tokenCAfter - tokenCBefore).to.be.gt(0n);

    // Router retains no leftover ETH or WETH after the batch.
    expect(await hre.ethers.provider.getBalance(routerAddr)).to.equal(0n);
    expect(await weth.balanceOf(routerAddr)).to.equal(0n);
  });

  it("multicall: WETH -> B -> C with recipient=0 + sweepToken to recipient", async function () {
    const { router, routerAddr, trader, recipient, weth, tokenB, tokenC, wethAddr, bAddr, cAddr } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("1");
    const path = encodePath([wethAddr, bAddr, cAddr], [0, 0]);

    // Pre-wrap native ETH → WETH on the trader side so transferFrom can pull.
    await weth.connect(trader).deposit({ value: amountIn });
    await weth.connect(trader).approve(routerAddr, MaxUint256);

    const iface = router.interface;
    const swapCall = iface.encodeFunctionData("exactInput", [
      {
        path,
        recipient: ZeroAddress, // capture tokenC on the router
        amountIn,
        amountOutMinimum: 0,
        deadline,
      },
    ]);
    // sweep whatever arrived on the router to a different address.
    const sweepCall = iface.encodeFunctionData("sweepToken", [cAddr, 1n, recipient.address]);

    const cBefore = await tokenC.balanceOf(recipient.address);

    await router.connect(trader).multicall([swapCall, sweepCall]);

    const cAfter = await tokenC.balanceOf(recipient.address);
    expect(cAfter - cBefore).to.be.gt(0n);

    // Router fully drained.
    expect(await tokenC.balanceOf(routerAddr)).to.equal(0n);
    expect(await tokenB.balanceOf(routerAddr)).to.equal(0n);
  });

  it("multicall: B -> C -> WETH with recipient=0 + unwrapWETH9 delivers native ETH", async function () {
    const { router, routerAddr, trader, recipient, weth, tokenB, tokenC, wethAddr, bAddr, cAddr } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("100");
    // Cross-hop: tokenB -> tokenC (pool 0 for B/C pair) -> WETH (pool 0 for WETH/C pair)
    const path = encodePath([bAddr, cAddr, wethAddr], [0, 0]);

    const iface = router.interface;
    const swapCall = iface.encodeFunctionData("exactInput", [
      {
        path,
        recipient: ZeroAddress, // leave WETH on the router for unwrap
        amountIn,
        amountOutMinimum: 0,
        deadline,
      },
    ]);
    const unwrapCall = iface.encodeFunctionData("unwrapWETH9", [1n, recipient.address]);

    const ethBefore = await hre.ethers.provider.getBalance(recipient.address);

    await router.connect(trader).multicall([swapCall, unwrapCall]);

    const ethAfter = await hre.ethers.provider.getBalance(recipient.address);
    expect(ethAfter - ethBefore).to.be.gt(0n);

    // Router holds no leftover WETH, tokenB, or tokenC.
    expect(await weth.balanceOf(routerAddr)).to.equal(0n);
    expect(await tokenB.balanceOf(routerAddr)).to.equal(0n);
    expect(await tokenC.balanceOf(routerAddr)).to.equal(0n);
    expect(await hre.ethers.provider.getBalance(routerAddr)).to.equal(0n);
  });

  // A `ERC20 -> WETH -> ERC20` exact-input route with EXCESS attached
  // `msg.value` must NOT wrap the attached ETH for the second (WETH-out)
  // hop — that hop is funded by the WETH the first hop staged in the
  // router (payer == router). Wrapping the ETH instead would spend both
  // the ERC20 input and the ETH, stranding the staged WETH plus the
  // leftover ETH for anyone to sweep. The staged WETH funds the hop and
  // the full attached ETH stays refundable.
  it("excess msg.value on B -> WETH -> C is fully refundable, no stranded WETH", async function () {
    const { router, routerAddr, trader, weth, tokenB, tokenC, wethAddr, bAddr, cAddr } =
      await loadFixture(deployFixture);

    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("1");
    // B -> WETH (WETH/B pair, idx 0) -> C (WETH/C pair, idx 0).
    const path = encodePath([bAddr, wethAddr, cAddr], [0, 0]);
    // Attached ETH exceeds the ~1 WETH the first hop stages — the exact
    // ratio at which a balance-based `balance >= value` wrap heuristic
    // would misfire.
    const excessEth = hre.ethers.parseEther("3");

    const iface = router.interface;
    const swapCall = iface.encodeFunctionData("exactInput", [
      { path, recipient: trader.address, amountIn, amountOutMinimum: 0, deadline },
    ]);
    const refundCall = iface.encodeFunctionData("refundETH");

    const cBefore = await tokenC.balanceOf(trader.address);
    const ethBefore = await hre.ethers.provider.getBalance(trader.address);

    const tx = await router.connect(trader).multicall([swapCall, refundCall], { value: excessEth });
    const rcpt = await tx.wait();
    const gas = rcpt!.gasUsed * rcpt!.gasPrice;

    // The route delivered tokenC to the trader.
    expect(await tokenC.balanceOf(trader.address)).to.be.gt(cBefore);

    // The attached ETH was never wrapped: refundETH returned all of it,
    // so the trader's net ETH change is exactly -gas (the 3 ETH round-trips).
    const ethAfter = await hre.ethers.provider.getBalance(trader.address);
    expect(ethBefore - ethAfter).to.equal(gas);

    // Nothing stranded on the router.
    expect(await weth.balanceOf(routerAddr)).to.equal(0n);
    expect(await tokenB.balanceOf(routerAddr)).to.equal(0n);
    expect(await tokenC.balanceOf(routerAddr)).to.equal(0n);
    expect(await hre.ethers.provider.getBalance(routerAddr)).to.equal(0n);
  });
});
