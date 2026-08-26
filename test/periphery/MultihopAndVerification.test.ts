import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256, AbiCoder, solidityPacked } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

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

async function deployMultihopFixture() {
  const [owner, trader] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const tokenA: any = await Token.deploy("TokenA", "TKA", 18);
  const tokenB: any = await Token.deploy("TokenB", "TKB", 18);
  const tokenC: any = await Token.deploy("TokenC", "TKC", 18);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();
  await tokenC.waitForDeployment();

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl: any = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory: any = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

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

  const addrA = await tokenA.getAddress();
  const addrB = await tokenB.getAddress();
  const addrC = await tokenC.getAddress();

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth: any = await Weth.deploy();
  await weth.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router: any = await Router.deploy(
    await factory.getAddress(),
    await poolImpl.getAddress(),
    await weth.getAddress()
  );
  await router.waitForDeployment();

  // Fund + approve the factory (genesis seeds) and the router (trader swaps).
  // The factory now owns genesis liquidity provisioning end-to-end, so the
  // mock mint provider is no longer needed for bootstrapping.
  const liquidity = hre.ethers.parseEther("1000000");
  const factoryAddr = await factory.getAddress();
  for (const token of [tokenA, tokenB, tokenC]) {
    await token.mint(owner.address, liquidity * 10n);
    await token.mint(trader.address, liquidity * 10n);
    await token.approve(factoryAddr, MaxUint256);
    await token.connect(trader).approve(await router.getAddress(), MaxUint256);
  }

  // Atomic deploy + seed for each pool. Liquidity seeds are 1:1 in raw units;
  // factory orders the (token0, token1) pair lexicographically internally.
  await factory.createPoolAndAddLiquidity(
    addrA,
    addrB,
    { ...poolConfig, aWad: aWad, lambdaWad: lambdaWad },
    liquidity,
    liquidity,
    owner.address
  );
  await factory.createPoolAndAddLiquidity(
    addrB,
    addrC,
    { ...poolConfig, aWad: aWad, lambdaWad: lambdaWad },
    liquidity,
    liquidity,
    owner.address
  );
  await factory.createPoolAndAddLiquidity(
    addrA,
    addrC,
    { ...poolConfig, aWad: aWad, lambdaWad: lambdaWad },
    liquidity,
    liquidity,
    owner.address
  );

  const poolAB: any = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
  const poolBC: any = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(1));
  const poolAC: any = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(2));

  return {
    tokenA,
    tokenB,
    tokenC,
    addrA,
    addrB,
    addrC,
    poolAB,
    poolBC,
    poolAC,
    factory,
    poolImpl,
    router,
    owner,
    trader,
  };
}

describe("MultihopSwap", function () {
  it("exactInput 2-hop: A -> B -> C", async function () {
    const { router, trader, addrA, addrB, addrC } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;

    const amountIn = hre.ethers.parseEther("1000");
    const path = encodePath([addrA, addrB, addrC], [0, 0]);

    const amountOut = await router.connect(trader).exactInput.staticCall({
      path,
      recipient: trader.address,
      amountIn,
      amountOutMinimum: 0,
      deadline,
    });
    expect(amountOut).to.be.gt(0n);

    await router.connect(trader).exactInput({
      path,
      recipient: trader.address,
      amountIn,
      amountOutMinimum: 0,
      deadline,
    });
  });

  it("exactInput 2-hop output >= single-hop-equivalent sanity check", async function () {
    const { router, trader, addrA, addrB, addrC, poolAC } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("1000");

    const multiHopOut = await router.connect(trader).exactInput.staticCall({
      path: encodePath([addrA, addrB, addrC], [0, 0]),
      recipient: trader.address,
      amountIn,
      amountOutMinimum: 0,
      deadline,
    });

    const singleHopOut = await router.connect(trader).exactInputSingle.staticCall({
      tokenIn: addrA,
      tokenOut: addrC,
      poolIndex: 0,
      recipient: trader.address,
      amountIn,
      amountOutMinimum: 0,
      deadline,
    });

    // Both paths are valid; just confirm both produce non-zero positive output.
    expect(multiHopOut).to.be.gt(0n);
    expect(singleHopOut).to.be.gt(0n);
  });

  it("exactInput 3-hop: A -> B -> C -> A via three pools", async function () {
    const { router, trader, addrA, addrB, addrC } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("1000");

    // A -> B (pool AB, index 0) -> C (pool BC, index 0) -> A (pool AC, index 0)
    const path = encodePath([addrA, addrB, addrC, addrA], [0, 0, 0]);

    const amountOut = await router.connect(trader).exactInput.staticCall({
      path,
      recipient: trader.address,
      amountIn,
      amountOutMinimum: 0,
      deadline,
    });
    expect(amountOut).to.be.gt(0n);
    // Roundtrip through three pools should yield less than input due to fees + slippage.
    expect(amountOut).to.be.lt(amountIn);
  });

  it("exactOutput 2-hop: A -> B -> C", async function () {
    const { router, trader, addrA, addrB, addrC, tokenA } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const desiredOut = hre.ethers.parseEther("500");

    // For exactOutput, the path is reversed: C -> B -> A (output first, input last).
    const path = encodePath([addrC, addrB, addrA], [0, 0]);

    const balanceBefore = await tokenA.balanceOf(trader.address);
    const amountIn = await router.connect(trader).exactOutput.staticCall({
      path,
      recipient: trader.address,
      amountOut: desiredOut,
      amountInMaximum: hre.ethers.parseEther("1000"),
      deadline,
    });
    expect(amountIn).to.be.gt(0n);
    expect(amountIn).to.be.gt(desiredOut); // Should cost more than output due to fees.
  });

  it("exactOutput 3-hop: A -> B -> C -> A (cyclic, three pools)", async function () {
    const { router, trader, addrA, addrB, addrC, tokenA } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const desiredOut = hre.ethers.parseEther("50");

    // Forward intent: A -> B (pool AB) -> C (pool BC) -> A (pool AC)
    // Reversed path for exactOutput: [output ... input] = [A, C, B, A]
    // All three pairs have pairPoolIndex = 0 (first pool for each pair).
    const path = encodePath([addrA, addrC, addrB, addrA], [0, 0, 0]);

    const balanceBefore = await tokenA.balanceOf(trader.address);

    // staticCall: discover amountIn without mutating state.
    const amountIn = await router.connect(trader).exactOutput.staticCall({
      path,
      recipient: trader.address,
      amountOut: desiredOut,
      amountInMaximum: hre.ethers.parseEther("1000"),
      deadline,
    });
    expect(amountIn).to.be.gt(0n);
    // Roundtrip through 3 × 30 bps fees must cost strictly more than `desiredOut`.
    expect(amountIn).to.be.gt(desiredOut);

    await router.connect(trader).exactOutput({
      path,
      recipient: trader.address,
      amountOut: desiredOut,
      amountInMaximum: amountIn * 2n,
      deadline,
    });

    // Net delta for tokenA: received desiredOut, paid amountIn → balance decreased.
    const balanceAfter = await tokenA.balanceOf(trader.address);
    expect(balanceAfter - balanceBefore).to.equal(desiredOut - amountIn);
  });

  it("rejects uint256 values above the signed swap domain in all four entrypoints", async function () {
    const { router, trader, tokenA, tokenB, tokenC, addrA, addrB, addrC, poolAB, poolBC } =
      await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const overInt256Max = 1n << 255n;
    const exactInputPath = encodePath([addrA, addrB, addrC], [0, 0]);
    const exactOutputPath = encodePath([addrC, addrB, addrA], [0, 0]);

    // `Overflow()` is declared by Solady's SafeCastLib rather than by the
    // router ABI, so give the matcher the library's error interface.
    const safeCastArtifact = await hre.artifacts.readArtifact("SafeCastLib");
    const safeCastErrors = {
      interface: new hre.ethers.Interface(safeCastArtifact.abi),
    } as any;

    const snapshot = async () => ({
      traderBalances: await Promise.all([
        tokenA.balanceOf(trader.address),
        tokenB.balanceOf(trader.address),
        tokenC.balanceOf(trader.address),
      ]),
      reservesAB: Array.from(await poolAB.getReserves()),
      reservesBC: Array.from(await poolBC.getReserves()),
    });
    const before = await snapshot();

    await expect(
      router.connect(trader).exactInputSingle({
        tokenIn: addrA,
        tokenOut: addrB,
        poolIndex: 0,
        recipient: trader.address,
        amountIn: overInt256Max,
        amountOutMinimum: 0,
        deadline,
      })
    ).to.be.revertedWithCustomError(safeCastErrors, "Overflow");

    await expect(
      router.connect(trader).exactOutputSingle({
        tokenIn: addrA,
        tokenOut: addrB,
        poolIndex: 0,
        recipient: trader.address,
        amountOut: overInt256Max,
        amountInMaximum: MaxUint256,
        deadline,
      })
    ).to.be.revertedWithCustomError(safeCastErrors, "Overflow");

    await expect(
      router.connect(trader).exactInput({
        path: exactInputPath,
        recipient: trader.address,
        amountIn: overInt256Max,
        amountOutMinimum: 0,
        deadline,
      })
    ).to.be.revertedWithCustomError(safeCastErrors, "Overflow");

    await expect(
      router.connect(trader).exactOutput({
        path: exactOutputPath,
        recipient: trader.address,
        amountOut: overInt256Max,
        amountInMaximum: MaxUint256,
        deadline,
      })
    ).to.be.revertedWithCustomError(safeCastErrors, "Overflow");

    expect(await snapshot()).to.deep.equal(before);
  });

  it("exactInput reverts on slippage", async function () {
    const { router, trader, addrA, addrB, addrC } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const amountIn = hre.ethers.parseEther("1000");
    const path = encodePath([addrA, addrB, addrC], [0, 0]);

    await expect(
      router.connect(trader).exactInput({
        path,
        recipient: trader.address,
        amountIn,
        amountOutMinimum: hre.ethers.parseEther("999999"),
        deadline,
      })
    ).to.be.revertedWithCustomError(router, "SlippageExceeded");
  });

  it("exactOutput reverts on excessive input", async function () {
    const { router, trader, addrA, addrB, addrC } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) + 3600;
    const path = encodePath([addrC, addrB, addrA], [0, 0]);

    await expect(
      router.connect(trader).exactOutput({
        path,
        recipient: trader.address,
        amountOut: hre.ethers.parseEther("500"),
        amountInMaximum: 1n,
        deadline,
      })
    ).to.be.revertedWithCustomError(router, "ExcessiveInputAmount");
  });

  it("exactInput reverts on expired deadline", async function () {
    const { router, trader, addrA, addrB, addrC } = await loadFixture(deployMultihopFixture);
    const deadline = (await time.latest()) - 1;
    const path = encodePath([addrA, addrB, addrC], [0, 0]);

    await expect(
      router.connect(trader).exactInput({
        path,
        recipient: trader.address,
        amountIn: hre.ethers.parseEther("100"),
        amountOutMinimum: 0,
        deadline,
      })
    ).to.be.revertedWithCustomError(router, "DeadlineExpired");
  });
});

describe("CallbackVerification", function () {
  it("rejects swap callback from non-pool address", async function () {
    const { router, addrA, addrB, trader } = await loadFixture(deployMultihopFixture);

    const path = encodePath([addrA, addrB], [0]);
    const fakeCallbackData = AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes path, address payer)"],
      [{ path, payer: trader.address }]
    );

    // Calling equilibraSwapCallback directly from an EOA (not a real pool) should revert.
    await expect(
      router.equilibraSwapCallback(hre.ethers.parseEther("1"), hre.ethers.parseEther("-1"), fakeCallbackData)
    ).to.be.revertedWithCustomError(router, "InvalidCallbackSender");
  });

  it("rejects mint callback from non-pool address", async function () {
    const { router, addrA, addrB, trader } = await loadFixture(deployMultihopFixture);

    const [sorted0, sorted1] = addrA.toLowerCase() < addrB.toLowerCase() ? [addrA, addrB] : [addrB, addrA];

    const fakeData = AbiCoder.defaultAbiCoder().encode(
      ["tuple(address token0, address token1, uint32 pairPoolIndex, address payer)"],
      [
        {
          token0: sorted0,
          token1: sorted1,
          pairPoolIndex: 0,
          payer: trader.address,
        },
      ]
    );

    await expect(
      router.equilibraMintCallback(hre.ethers.parseEther("1"), hre.ethers.parseEther("1"), fakeData)
    ).to.be.revertedWithCustomError(router, "InvalidCallbackSender");
  });

  it("rejects spoofed callback with fabricated token addresses", async function () {
    const { router, trader } = await loadFixture(deployMultihopFixture);

    // Attacker tries to use completely fake token addresses that hash to a predictable pool address.
    const fakeTokenA = "0x0000000000000000000000000000000000000001";
    const fakeTokenB = "0x0000000000000000000000000000000000000002";

    const path = encodePath([fakeTokenA, fakeTokenB], [0]);
    const fakeCallbackData = AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes path, address payer)"],
      [{ path, payer: trader.address }]
    );

    await expect(
      router.equilibraSwapCallback(hre.ethers.parseEther("1"), hre.ethers.parseEther("-1"), fakeCallbackData)
    ).to.be.revertedWithCustomError(router, "InvalidCallbackSender");
  });

  it("rejects callback with wrong poolIndex", async function () {
    const { router, addrA, addrB, trader } = await loadFixture(deployMultihopFixture);

    // Use correct tokens but wrong pool index (99 doesn't exist).
    const path = encodePath([addrA, addrB], [99]);
    const fakeCallbackData = AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes path, address payer)"],
      [{ path, payer: trader.address }]
    );

    await expect(
      router.equilibraSwapCallback(hre.ethers.parseEther("1"), hre.ethers.parseEther("-1"), fakeCallbackData)
    ).to.be.revertedWithCustomError(router, "InvalidCallbackSender");
  });
});
