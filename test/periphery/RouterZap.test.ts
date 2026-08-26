import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

// ---------------------------------------------------------------------------
// Fixture for the router-merged zap. The same router that owns
// `exactInputSingle` / `addLiquidity` also exposes `zapIn*` / `zapOut*` /
// `previewZap*` — the standalone `EquilibraZap.sol` no longer exists.
//
// Pool: 100 WETH / 200 000 USDC (1:2000). Alice + Bob start with 50 WETH
// + 100 000 USDC + MaxUint256 router allowance. Alice also receives
// ~10 % of the genesis LP supply for the zap-out path.
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, alice, bob] = await hre.ethers.getSigners();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const weth = await Token.deploy("Wrapped Ether", "WETH", 18);
  const usdc = await Token.deploy("USD Coin", "USDC", 6);
  await weth.waitForDeployment();
  await usdc.waitForDeployment();

  const wethAddr = await weth.getAddress();
  const usdcAddr = await usdc.getAddress();
  const [token0Addr, token1Addr] =
    wethAddr.toLowerCase() < usdcAddr.toLowerCase() ? [wethAddr, usdcAddr] : [usdcAddr, wethAddr];
  const wethIsToken0 = wethAddr === token0Addr;

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  const wethSeed = hre.ethers.parseEther("100");
  const usdcSeed = 200_000n * 10n ** 6n;
  await weth.mint(owner.address, wethSeed * 10n);
  await usdc.mint(owner.address, usdcSeed * 10n);

  const factoryAddr = await factory.getAddress();
  await weth.approve(factoryAddr, MaxUint256);
  await usdc.approve(factoryAddr, MaxUint256);

  const [amount0Desired, amount1Desired] = wethIsToken0 ? [wethSeed, usdcSeed] : [usdcSeed, wethSeed];

  await factory.createPoolAndAddLiquidity(
    token0Addr,
    token1Addr,
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
    amount0Desired,
    amount1Desired,
    owner.address
  );

  const poolAddress = await factory.allPools(0);
  const pool = await hre.ethers.getContractAt("EquilibraPool", poolAddress);

  // The router constructor requires a non-zero WETH9 sentinel. None of
  // the zap flows exercise the native-ETH branch in `_pay`, so any
  // non-zero address works — we deploy `MockWETH9` for fidelity in
  // case follow-up tests ever route native ETH through these helpers.
  const WETH = await hre.ethers.getContractFactory("MockWETH9");
  const weth9 = await WETH.deploy();
  await weth9.waitForDeployment();

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), await weth9.getAddress());
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  for (const user of [alice, bob]) {
    await weth.mint(user.address, hre.ethers.parseEther("50"));
    await usdc.mint(user.address, 100_000n * 10n ** 6n);
    await weth.connect(user).approve(routerAddr, MaxUint256);
    await usdc.connect(user).approve(routerAddr, MaxUint256);
    await pool.connect(user).approve(routerAddr, MaxUint256);
  }

  // Transfer ~10 % of the genesis LP supply to Alice for zap-out tests.
  const ownerLp = await pool.balanceOf(owner.address);
  await pool.transfer(alice.address, ownerLp / 10n);

  return {
    owner,
    alice,
    bob,
    weth,
    usdc,
    pool,
    poolAddress,
    router,
    routerAddr,
    token0Addr,
    token1Addr,
    wethIsToken0,
  };
}

async function freshDeadline(): Promise<number> {
  return (await time.latest()) + 3600;
}

describe("EquilibraRouter: zap operations", function () {
  describe("zapInSingleSided", function () {
    it("mints LP shares from a single token and refunds dust", async function () {
      const { alice, weth, usdc, pool, router, routerAddr, poolAddress } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const amountIn = hre.ethers.parseEther("1");

      const lpBefore = await pool.balanceOf(alice.address);
      const wethBefore = await weth.balanceOf(alice.address);

      const tx = await router.connect(alice).zapInSingleSided({
        tokenIn: wethAddr,
        tokenOut: usdcAddr,
        poolIndex: 0,
        recipient: alice.address,
        amountIn,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const rcpt = await tx.wait();

      const lpAfter = await pool.balanceOf(alice.address);
      const liquidity = lpAfter - lpBefore;
      expect(liquidity).to.be.greaterThan(0n);

      const wethAfter = await weth.balanceOf(alice.address);
      const wethSpent = wethBefore - wethAfter;
      expect(wethSpent).to.be.lessThanOrEqual(amountIn);
      expect(wethSpent).to.be.greaterThan(0n);

      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
      expect(await pool.balanceOf(routerAddr)).to.equal(0n);

      const evt = rcpt!.logs.find((l: any) => l.fragment && l.fragment.name === "ZapIn") as any;
      expect(evt).to.not.be.undefined;
      expect(evt.args[0]).to.equal(poolAddress);
      expect(evt.args[1]).to.equal(alice.address);
      expect(evt.args[2]).to.equal(wethAddr);
      expect(evt.args[3]).to.equal(amountIn);
      expect(evt.args[4]).to.equal(liquidity);
    });

    it("mints LP shares when seeding the off-decimal token (USDC)", async function () {
      const { alice, usdc, weth, pool, router, routerAddr } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const amountIn = 5_000n * 10n ** 6n;

      const lpBefore = await pool.balanceOf(alice.address);
      await router.connect(alice).zapInSingleSided({
        tokenIn: usdcAddr,
        tokenOut: wethAddr,
        poolIndex: 0,
        recipient: alice.address,
        amountIn,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpAfter = await pool.balanceOf(alice.address);
      expect(lpAfter - lpBefore).to.be.greaterThan(0n);

      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("reverts when minLiquidity is unattainable", async function () {
      const { alice, weth, usdc, router } = await loadFixture(deployFixture);
      await expect(
        router.connect(alice).zapInSingleSided({
          tokenIn: await weth.getAddress(),
          tokenOut: await usdc.getAddress(),
          poolIndex: 0,
          recipient: alice.address,
          amountIn: hre.ethers.parseEther("1"),
          minLiquidity: hre.ethers.parseEther("1000000"),
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "SlippageExceeded");
    });

    it("reverts when tokenIn equals tokenOut", async function () {
      const { alice, weth, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      await expect(
        router.connect(alice).zapInSingleSided({
          tokenIn: wethAddr,
          tokenOut: wethAddr,
          poolIndex: 0,
          recipient: alice.address,
          amountIn: 1_000n,
          minLiquidity: 0,
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "IdenticalTokens");
    });

    it("reverts on the empty-balance sentinel, zero recipient and zero tokenOut", async function () {
      const { alice, weth, usdc, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const deadline = await freshDeadline();

      // `amountIn == 0` is the CONTRACT_BALANCE sentinel, not a plain
      // zero-input guard: with nothing staged in the router the
      // resolved amount is zero and the zap refuses loudly.
      await expect(
        router.connect(alice).zapInSingleSided({
          tokenIn: wethAddr,
          tokenOut: usdcAddr,
          poolIndex: 0,
          recipient: alice.address,
          amountIn: 0n,
          minLiquidity: 0,
          deadline,
        })
      ).to.be.revertedWithCustomError(router, "ZeroAmount");

      await expect(
        router.connect(alice).zapInSingleSided({
          tokenIn: wethAddr,
          tokenOut: usdcAddr,
          poolIndex: 0,
          recipient: hre.ethers.ZeroAddress,
          amountIn: 1n,
          minLiquidity: 0,
          deadline,
        })
      ).to.be.revertedWithCustomError(router, "ZeroAddress");

      await expect(
        router.connect(alice).zapInSingleSided({
          tokenIn: wethAddr,
          tokenOut: hre.ethers.ZeroAddress,
          poolIndex: 0,
          recipient: alice.address,
          amountIn: 1n,
          minLiquidity: 0,
          deadline,
        })
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });
  });

  describe("zapInImbalanced", function () {
    it("mints LP from balanced two-sided amounts (≈ proportional)", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);

      const lpBefore = await pool.balanceOf(alice.address);
      await router.connect(alice).zapInImbalanced({
        tokenA: await weth.getAddress(),
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        recipient: alice.address,
        amountA: hre.ethers.parseEther("1"),
        amountB: 2_000n * 10n ** 6n,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpAfter = await pool.balanceOf(alice.address);
      expect(lpAfter - lpBefore).to.be.greaterThan(0n);

      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("mints LP from WETH-only deposit (rebalances via swap)", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);

      const lpBefore = await pool.balanceOf(alice.address);
      await router.connect(alice).zapInImbalanced({
        tokenA: await weth.getAddress(),
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        recipient: alice.address,
        amountA: hre.ethers.parseEther("2"),
        amountB: 0n,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpAfter = await pool.balanceOf(alice.address);
      expect(lpAfter - lpBefore).to.be.greaterThan(0n);

      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("mints LP from USDC-only deposit (rebalances via swap)", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);

      const lpBefore = await pool.balanceOf(alice.address);
      await router.connect(alice).zapInImbalanced({
        tokenA: await weth.getAddress(),
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        recipient: alice.address,
        amountA: 0n,
        amountB: 4_000n * 10n ** 6n,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpAfter = await pool.balanceOf(alice.address);
      expect(lpAfter - lpBefore).to.be.greaterThan(0n);

      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("rebalances heavily skewed deposits", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);

      const lpBefore = await pool.balanceOf(alice.address);
      await router.connect(alice).zapInImbalanced({
        tokenA: await weth.getAddress(),
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        recipient: alice.address,
        amountA: hre.ethers.parseEther("5"),
        amountB: 100n * 10n ** 6n,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpAfter = await pool.balanceOf(alice.address);
      expect(lpAfter - lpBefore).to.be.greaterThan(0n);

      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("rebalances when one side is in heavy excess (excess-token branch)", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);

      // 0.01 WETH (~$20) vs. 5 000 USDC — USDC is the heavy excess side
      // relative to the 1:2 000 pool ratio.
      const lpBefore = await pool.balanceOf(alice.address);
      await router.connect(alice).zapInImbalanced({
        tokenA: await weth.getAddress(),
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        recipient: alice.address,
        amountA: hre.ethers.parseEther("0.01"),
        amountB: 5_000n * 10n ** 6n,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpAfter = await pool.balanceOf(alice.address);
      expect(lpAfter - lpBefore).to.be.greaterThan(0n);

      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("reverts when both inputs are zero", async function () {
      const { alice, weth, usdc, router } = await loadFixture(deployFixture);
      await expect(
        router.connect(alice).zapInImbalanced({
          tokenA: await weth.getAddress(),
          tokenB: await usdc.getAddress(),
          poolIndex: 0,
          recipient: alice.address,
          amountA: 0n,
          amountB: 0n,
          minLiquidity: 0,
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "ZeroAmount");
    });

    it("reverts when minLiquidity is unattainable", async function () {
      const { alice, weth, usdc, router } = await loadFixture(deployFixture);
      await expect(
        router.connect(alice).zapInImbalanced({
          tokenA: await weth.getAddress(),
          tokenB: await usdc.getAddress(),
          poolIndex: 0,
          recipient: alice.address,
          amountA: hre.ethers.parseEther("1"),
          amountB: 2_000n * 10n ** 6n,
          minLiquidity: hre.ethers.parseEther("1000000"),
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "SlippageExceeded");
    });
  });

  describe("zapOutSingleSided", function () {
    it("burns LP and returns a single token (WETH)", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const liquidity = (await pool.balanceOf(alice.address)) / 10n;
      expect(liquidity).to.be.greaterThan(0n);

      const wethBefore = await weth.balanceOf(alice.address);
      await router.connect(alice).zapOutSingleSided({
        tokenA: wethAddr,
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        tokenOut: wethAddr,
        recipient: alice.address,
        liquidity,
        minAmountOut: 0,
        deadline: await freshDeadline(),
      });
      expect((await weth.balanceOf(alice.address)) - wethBefore).to.be.greaterThan(0n);

      expect(await pool.balanceOf(routerAddr)).to.equal(0n);
      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
    });

    it("burns LP and returns a single token (USDC)", async function () {
      const { alice, weth, usdc, pool, router, routerAddr } = await loadFixture(deployFixture);
      const usdcAddr = await usdc.getAddress();
      const liquidity = (await pool.balanceOf(alice.address)) / 10n;

      const usdcBefore = await usdc.balanceOf(alice.address);
      await router.connect(alice).zapOutSingleSided({
        tokenA: await weth.getAddress(),
        tokenB: usdcAddr,
        poolIndex: 0,
        tokenOut: usdcAddr,
        recipient: alice.address,
        liquidity,
        minAmountOut: 0,
        deadline: await freshDeadline(),
      });
      expect((await usdc.balanceOf(alice.address)) - usdcBefore).to.be.greaterThan(0n);

      expect(await pool.balanceOf(routerAddr)).to.equal(0n);
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("emits ZapOut with the actual amountOut", async function () {
      const { alice, weth, usdc, pool, router, poolAddress } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const liquidity = (await pool.balanceOf(alice.address)) / 10n;

      const tx = await router.connect(alice).zapOutSingleSided({
        tokenA: wethAddr,
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        tokenOut: wethAddr,
        recipient: alice.address,
        liquidity,
        minAmountOut: 0,
        deadline: await freshDeadline(),
      });
      const rcpt = await tx.wait();

      const evt = rcpt!.logs.find((l: any) => l.fragment && l.fragment.name === "ZapOut") as any;
      expect(evt).to.not.be.undefined;
      expect(evt.args[0]).to.equal(poolAddress);
      expect(evt.args[1]).to.equal(alice.address);
      expect(evt.args[2]).to.equal(wethAddr);
      expect(evt.args[3]).to.equal(liquidity);
      expect(evt.args[4]).to.be.greaterThan(0n);
    });

    it("reverts when amountOut is below the minimum", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const liquidity = (await pool.balanceOf(alice.address)) / 10n;
      await expect(
        router.connect(alice).zapOutSingleSided({
          tokenA: await weth.getAddress(),
          tokenB: await usdc.getAddress(),
          poolIndex: 0,
          tokenOut: await weth.getAddress(),
          recipient: alice.address,
          liquidity,
          minAmountOut: hre.ethers.parseEther("1000000"),
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "InsufficientOutputAmount");
    });

    it("reverts when tokenOut is not part of the pool", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const Token = await hre.ethers.getContractFactory("MockERC20");
      const stranger = await Token.deploy("Stranger", "STR", 18);
      await stranger.waitForDeployment();
      const liquidity = (await pool.balanceOf(alice.address)) / 100n;

      await expect(
        router.connect(alice).zapOutSingleSided({
          tokenA: await weth.getAddress(),
          tokenB: await usdc.getAddress(),
          poolIndex: 0,
          tokenOut: await stranger.getAddress(),
          recipient: alice.address,
          liquidity,
          minAmountOut: 0,
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "UnsupportedToken");
    });

    it("reverts on zero liquidity; recipient == 0 stages the output in the router", async function () {
      const { owner, alice, weth, usdc, router, pool } = await loadFixture(deployFixture);
      const deadline = await freshDeadline();
      await expect(
        router.connect(alice).zapOutSingleSided({
          tokenA: await weth.getAddress(),
          tokenB: await usdc.getAddress(),
          poolIndex: 0,
          tokenOut: await weth.getAddress(),
          recipient: alice.address,
          liquidity: 0n,
          minAmountOut: 0,
          deadline,
        })
      ).to.be.revertedWithCustomError(router, "ZeroAmount");

      // `recipient == address(0)` is the output-staging convention (the
      // caller chains sweepToken/unwrapWETH9 through multicall) — the
      // output lands on the router, not on the zero address.
      const routerAddr = await router.getAddress();
      const shares = (await pool.balanceOf(owner.address)) / 100n;
      await pool.connect(owner).approve(routerAddr, shares);
      const calls = [
        router.interface.encodeFunctionData("zapOutSingleSided", [
          {
            tokenA: await weth.getAddress(),
            tokenB: await usdc.getAddress(),
            poolIndex: 0,
            tokenOut: await weth.getAddress(),
            recipient: hre.ethers.ZeroAddress,
            liquidity: shares,
            minAmountOut: 0,
            deadline,
          },
        ]),
        router.interface.encodeFunctionData("sweepToken", [await weth.getAddress(), 0, alice.address]),
      ];
      const balBefore = await weth.balanceOf(alice.address);
      await router.connect(owner).multicall(calls);
      expect(await weth.balanceOf(alice.address)).to.be.greaterThan(balBefore);
      expect(await weth.balanceOf(routerAddr)).to.equal(0n);
    });
  });

  describe("zap round-trip", function () {
    it("zap-in then zap-out: net loss is bounded by ~2 % of input", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const amountIn = hre.ethers.parseEther("1");

      const lpBefore = await pool.balanceOf(alice.address);
      const wethBefore = await weth.balanceOf(alice.address);

      await router.connect(alice).zapInSingleSided({
        tokenIn: wethAddr,
        tokenOut: usdcAddr,
        poolIndex: 0,
        recipient: alice.address,
        amountIn,
        minLiquidity: 0,
        deadline: await freshDeadline(),
      });
      const lpFromZap = (await pool.balanceOf(alice.address)) - lpBefore;
      expect(lpFromZap).to.be.greaterThan(0n);

      await router.connect(alice).zapOutSingleSided({
        tokenA: wethAddr,
        tokenB: usdcAddr,
        poolIndex: 0,
        tokenOut: wethAddr,
        recipient: alice.address,
        liquidity: lpFromZap,
        minAmountOut: 0,
        deadline: await freshDeadline(),
      });

      const wethAfter = await weth.balanceOf(alice.address);
      const wethSpent = wethBefore - wethAfter;
      expect(wethSpent).to.be.lessThan(amountIn / 50n);
      expect(wethSpent).to.be.greaterThanOrEqual(0n);
    });
  });

  describe("previews", function () {
    it("previewZapIn returns a non-zero, swap-bounded estimate", async function () {
      const { weth, usdc, router } = await loadFixture(deployFixture);
      const amountIn = hre.ethers.parseEther("1");

      const [liquidity, swapAmount] = await router.previewZapIn(
        await weth.getAddress(),
        await usdc.getAddress(),
        0,
        amountIn
      );
      expect(liquidity).to.be.greaterThan(0n);
      expect(swapAmount).to.be.greaterThan(0n);
      expect(swapAmount).to.be.lessThanOrEqual(amountIn / 2n);
    });

    it("previewZapOut tracks the actual zap-out within reasonable bounds", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const liquidity = (await pool.balanceOf(alice.address)) / 50n;

      const previewed = await router.previewZapOut(wethAddr, usdcAddr, 0, liquidity, wethAddr);

      const wethBefore = await weth.balanceOf(alice.address);
      await router.connect(alice).zapOutSingleSided({
        tokenA: wethAddr,
        tokenB: usdcAddr,
        poolIndex: 0,
        tokenOut: wethAddr,
        recipient: alice.address,
        liquidity,
        minAmountOut: 0,
        deadline: await freshDeadline(),
      });
      const actual = (await weth.balanceOf(alice.address)) - wethBefore;

      expect(previewed).to.be.greaterThan(0n);
      // The preview quotes the off-side swap against the post-burn
      // reserves with the pool's own kernel and rounding, so it must
      // reproduce the executed amount bit-for-bit.
      expect(actual).to.equal(previewed);
    });

    it("prices previews on the ACTIVE float when the pool holds a donation buffer", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const poolAddr = await pool.getAddress();

      // park 10% of alice's shares: totalSupply is unchanged, the active
      // float shrinks, so a preview that divided by totalSupply would drift
      // by exactly parked/supply.
      const parked = (await pool.balanceOf(alice.address)) / 10n;
      await pool.connect(alice).transfer(poolAddr, parked);
      expect(await pool.balanceOf(poolAddr)).to.equal(parked);

      // previewZapOut must price the payout on the ACTIVE float (a
      // totalSupply division would drift by parked/active — >10% here)
      // AND quote the off-side swap post-burn: executing from the same
      // pre-state must reproduce the preview bit-for-bit.
      const liquidity = (await pool.balanceOf(alice.address)) / 20n;
      const previewed = await router.previewZapOut(
        await weth.getAddress(),
        await usdc.getAddress(),
        0,
        liquidity,
        await weth.getAddress()
      );
      expect(previewed).to.be.greaterThan(0n);

      const wethBefore = await weth.balanceOf(alice.address);
      await router.connect(alice).zapOutSingleSided({
        tokenA: await weth.getAddress(),
        tokenB: await usdc.getAddress(),
        poolIndex: 0,
        tokenOut: await weth.getAddress(),
        recipient: alice.address,
        liquidity,
        minAmountOut: previewed,
        deadline: await freshDeadline(),
      });
      expect((await weth.balanceOf(alice.address)) - wethBefore).to.equal(previewed);
    });

    it("previewZapIn equals the executed zap-in on a pool holding a donation buffer", async function () {
      const { owner, bob, weth, usdc, pool, router, routerAddr, poolAddress } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();

      // Fund the buffer through the guarded router entrypoint: the
      // donor approves the ROUTER for LP shares and pins the quoted
      // supply (maxSupply == live supply is the passing boundary).
      await pool.connect(owner).approve(routerAddr, MaxUint256);
      const tranche = (await pool.balanceOf(owner.address)) / 4n;
      await router
        .connect(owner)
        .donate(wethAddr, usdcAddr, 0, tranche, await pool.totalSupply(), await freshDeadline());
      expect(await pool.balanceOf(poolAddress)).to.equal(tranche);

      const amountIn = hre.ethers.parseEther("1");
      const [previewed, swapAmount] = await router.previewZapIn(wethAddr, usdcAddr, 0, amountIn);
      expect(previewed).to.be.greaterThan(0n);
      expect(swapAmount).to.be.greaterThan(0n);

      // Executed from the same pre-state, the zap must reproduce the
      // preview bit-for-bit: the swap projection reuses quoteExactIn
      // (quote == swap) and the mint math prices the ACTIVE float, so
      // the previewed liquidity doubles as an exact minLiquidity.
      const lpBefore = await pool.balanceOf(bob.address);
      await router.connect(bob).zapInSingleSided({
        tokenIn: wethAddr,
        tokenOut: usdcAddr,
        poolIndex: 0,
        recipient: bob.address,
        amountIn,
        minLiquidity: previewed,
        deadline: await freshDeadline(),
      });
      expect((await pool.balanceOf(bob.address)) - lpBefore).to.equal(previewed);
    });

    it("previewZapOut tracks the executed zap-out on a pool holding a donation buffer", async function () {
      const { owner, alice, weth, usdc, pool, router, routerAddr, poolAddress } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();

      await pool.connect(owner).approve(routerAddr, MaxUint256);
      const tranche = (await pool.balanceOf(owner.address)) / 4n;
      await router
        .connect(owner)
        .donate(wethAddr, usdcAddr, 0, tranche, await pool.totalSupply(), await freshDeadline());
      expect(await pool.balanceOf(poolAddress)).to.equal(tranche);

      const liquidity = (await pool.balanceOf(alice.address)) / 20n;
      const previewed = await router.previewZapOut(wethAddr, usdcAddr, 0, liquidity, wethAddr);
      expect(previewed).to.be.greaterThan(0n);

      const wethBefore = await weth.balanceOf(alice.address);
      await router.connect(alice).zapOutSingleSided({
        tokenA: wethAddr,
        tokenB: usdcAddr,
        poolIndex: 0,
        tokenOut: wethAddr,
        recipient: alice.address,
        liquidity,
        minAmountOut: 0,
        deadline: await freshDeadline(),
      });
      const actual = (await weth.balanceOf(alice.address)) - wethBefore;
      expect(actual).to.equal(previewed);
    });

    it("previewZapOut equals execution across large exits in both directions", async function () {
      const { owner, alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();

      // Concentrate LP with alice so the sweep reaches deep exits
      // (up to ~65% of the active supply), where the pre/post-burn
      // reserve gap is largest.
      await pool.connect(owner).transfer(alice.address, ((await pool.balanceOf(owner.address)) * 8n) / 10n);

      for (const pctBps of [250n, 1_000n, 2_500n, 5_000n, 9_000n]) {
        for (const tokenOut of [wethAddr, usdcAddr]) {
          const snapshot = await hre.network.provider.send("evm_snapshot", []);
          const liquidity = ((await pool.balanceOf(alice.address)) * pctBps) / 10_000n;
          const previewed = await router.previewZapOut(wethAddr, usdcAddr, 0, liquidity, tokenOut);
          expect(previewed, `pct=${pctBps} out=${tokenOut}: preview zero`).to.be.greaterThan(0n);

          const outToken = tokenOut === wethAddr ? weth : usdc;
          const before = await outToken.balanceOf(alice.address);
          // The preview doubles as an exact minAmountOut.
          await router.connect(alice).zapOutSingleSided({
            tokenA: wethAddr,
            tokenB: usdcAddr,
            poolIndex: 0,
            tokenOut,
            recipient: alice.address,
            liquidity,
            minAmountOut: previewed,
            deadline: await freshDeadline(),
          });
          expect((await outToken.balanceOf(alice.address)) - before, `pct=${pctBps} out=${tokenOut}`).to.equal(
            previewed
          );
          await hre.network.provider.send("evm_revert", [snapshot]);
        }
      }
    });

    it("previews are exact on a pool with a live protocol fee and dynamic ramp", async function () {
      const { owner, alice, bob, weth, usdc, pool, router, routerAddr, token0Addr, token1Addr } =
        await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const factory = await hre.ethers.getContractAt(
        "EquilibraFactory",
        await pool.getPoolMetadata().then((m: any) => m.factory)
      );

      // Second pool on the same pair (poolIndex 1): protocol fee takes
      // a cut of every swap fee, and the ramp makes the resolved rate
      // state-dependent — both must round-trip through the previews.
      await factory.connect(owner).setProtocolFee(25);
      const wethIsT0 = wethAddr === token0Addr;
      const wethSeed = hre.ethers.parseEther("100");
      const usdcSeed = 200_000n * 10n ** 6n;
      await weth.mint(owner.address, wethSeed);
      await usdc.mint(owner.address, usdcSeed);
      await factory.connect(owner).createPoolAndAddLiquidity(
        token0Addr,
        token1Addr,
        {
          aWad: (await pool.getCurveParams()).aWad,
          lambdaWad: (await pool.getCurveParams()).lambdaWad,
          baseFee: 30,
          emaPeriod: 1200,
          repegStepWad: hre.ethers.parseUnits("1", 15),
          repegThresholdToken1UpWad: hre.ethers.parseUnits("1", 15),
          repegThresholdToken1DownWad: hre.ethers.parseUnits("1", 15),
          feeRampBps: 100,
          feeFloorBps: 20,
          repegShareBps: 5000,
        },
        wethIsT0 ? wethSeed : usdcSeed,
        wethIsT0 ? usdcSeed : wethSeed,
        owner.address
      );
      const pool1 = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(1));
      await pool1.connect(owner).approve(routerAddr, MaxUint256);
      await pool1.connect(alice).approve(routerAddr, MaxUint256);

      // Park a donation tranche so the previews price the ACTIVE float
      // while the ramp AND the protocol cut are both live.
      await router
        .connect(owner)
        .donate(
          wethAddr,
          usdcAddr,
          1,
          (await pool1.balanceOf(owner.address)) / 10n,
          await pool1.totalSupply(),
          await freshDeadline()
        );

      // Zap-in: previewed shares must equal the minted shares exactly
      // (the reserve projection subtracts the protocol cut).
      const amountIn = hre.ethers.parseEther("10");
      const [previewedLp, swapAmount] = await router.previewZapIn(wethAddr, usdcAddr, 1, amountIn);
      expect(previewedLp).to.be.greaterThan(0n);
      expect(swapAmount).to.be.greaterThan(0n);
      const lpBefore = await pool1.balanceOf(bob.address);
      await router.connect(bob).zapInSingleSided({
        tokenIn: wethAddr,
        tokenOut: usdcAddr,
        poolIndex: 1,
        recipient: bob.address,
        amountIn,
        minLiquidity: previewedLp,
        deadline: await freshDeadline(),
      });
      expect((await pool1.balanceOf(bob.address)) - lpBefore).to.equal(previewedLp);

      // Same exactness with the 6-decimals token as the input side.
      const usdcIn = 5_000n * 10n ** 6n;
      const [previewedLp6, swapAmount6] = await router.previewZapIn(usdcAddr, wethAddr, 1, usdcIn);
      expect(previewedLp6).to.be.greaterThan(0n);
      expect(swapAmount6).to.be.greaterThan(0n);
      const lpBefore6 = await pool1.balanceOf(bob.address);
      await router.connect(bob).zapInSingleSided({
        tokenIn: usdcAddr,
        tokenOut: wethAddr,
        poolIndex: 1,
        recipient: bob.address,
        amountIn: usdcIn,
        minLiquidity: previewedLp6,
        deadline: await freshDeadline(),
      });
      expect((await pool1.balanceOf(bob.address)) - lpBefore6).to.equal(previewedLp6);

      // Zap-out on the same pool: exact against execution, preview as
      // the minAmountOut bound.
      await pool1.connect(owner).transfer(alice.address, (await pool1.balanceOf(owner.address)) / 2n);
      const liquidity = (await pool1.balanceOf(alice.address)) / 2n;
      const previewedOut = await router.previewZapOut(wethAddr, usdcAddr, 1, liquidity, usdcAddr);
      expect(previewedOut).to.be.greaterThan(0n);
      const usdcBefore = await usdc.balanceOf(alice.address);
      await router.connect(alice).zapOutSingleSided({
        tokenA: wethAddr,
        tokenB: usdcAddr,
        poolIndex: 1,
        tokenOut: usdcAddr,
        recipient: alice.address,
        liquidity,
        minAmountOut: previewedOut,
        deadline: await freshDeadline(),
      });
      expect((await usdc.balanceOf(alice.address)) - usdcBefore).to.equal(previewedOut);
    });

    it("dust exits revert identically in preview and execution", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();
      const supply = await pool.totalSupply();

      // Scan downward for a position whose kept side is non-zero but
      // whose off-side swap floors to a zero raw output: the swap path
      // rejects zero-output trades, so the preview must revert with the
      // execution path's error instead of quoting keepSide as payable.
      let dustLiq = 0n;
      for (let liq = supply / 200_000_000_000n; liq > 0n; liq /= 2n) {
        try {
          await router.previewZapOut(wethAddr, usdcAddr, 0, liq, usdcAddr);
        } catch {
          dustLiq = liq;
          break;
        }
      }
      expect(dustLiq, "no dust exit size found").to.be.greaterThan(0n);

      await expect(router.previewZapOut(wethAddr, usdcAddr, 0, dustLiq, usdcAddr)).to.be.revertedWithCustomError(
        pool,
        "AmountTooSmallAfterNormalization"
      );
      await expect(
        router.connect(alice).zapOutSingleSided({
          tokenA: wethAddr,
          tokenB: usdcAddr,
          poolIndex: 0,
          tokenOut: usdcAddr,
          recipient: alice.address,
          liquidity: dustLiq,
          minAmountOut: 0,
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(pool, "AmountTooSmallAfterNormalization");
    });

    it("a 1-wei LP position agrees between preview and execution", async function () {
      const { alice, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();

      // With both burn payouts floored to zero the pool refuses the
      // burn; the preview must refuse the same way instead of quoting
      // a zero payout for an unexecutable exit.
      await expect(router.previewZapOut(wethAddr, usdcAddr, 0, 1n, usdcAddr)).to.be.revertedWithCustomError(
        pool,
        "AmountTooSmallAfterNormalization"
      );
      await expect(
        router.connect(alice).zapOutSingleSided({
          tokenA: wethAddr,
          tokenB: usdcAddr,
          poolIndex: 0,
          tokenOut: usdcAddr,
          recipient: alice.address,
          liquidity: 1n,
          minAmountOut: 0,
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(pool, "AmountTooSmallAfterNormalization");
    });

    it("a state change between quote and execution reverts a raw-minimum call", async function () {
      const { alice, bob, weth, usdc, pool, router } = await loadFixture(deployFixture);
      const wethAddr = await weth.getAddress();
      const usdcAddr = await usdc.getAddress();

      const liquidity = (await pool.balanceOf(alice.address)) / 10n;
      const previewed = await router.previewZapOut(wethAddr, usdcAddr, 0, liquidity, usdcAddr);
      expect(previewed).to.be.greaterThan(0n);

      // Adverse intervening swap: sell WETH into the pool so the
      // off-side WETH -> USDC leg executes at a worse rate than quoted.
      await router.connect(bob).exactInputSingle({
        tokenIn: wethAddr,
        tokenOut: usdcAddr,
        poolIndex: 0,
        recipient: bob.address,
        amountIn: hre.ethers.parseEther("5"),
        amountOutMinimum: 0,
        deadline: await freshDeadline(),
      });

      // The quote is point-in-time — a raw exact minimum from a stale
      // state must revert rather than fill short.
      await expect(
        router.connect(alice).zapOutSingleSided({
          tokenA: wethAddr,
          tokenB: usdcAddr,
          poolIndex: 0,
          tokenOut: usdcAddr,
          recipient: alice.address,
          liquidity,
          minAmountOut: previewed,
          deadline: await freshDeadline(),
        })
      ).to.be.revertedWithCustomError(router, "InsufficientOutputAmount");
    });

    it("previewZapIn returns (0, 0) for amountIn == 0", async function () {
      const { weth, usdc, router } = await loadFixture(deployFixture);
      const [liquidity, swapAmount] = await router.previewZapIn(
        await weth.getAddress(),
        await usdc.getAddress(),
        0,
        0n
      );
      expect(liquidity).to.equal(0n);
      expect(swapAmount).to.equal(0n);
    });

    it("previewZapOut returns 0 for liquidity == 0", async function () {
      const { weth, usdc, router } = await loadFixture(deployFixture);
      const out = await router.previewZapOut(
        await weth.getAddress(),
        await usdc.getAddress(),
        0,
        0n,
        await weth.getAddress()
      );
      expect(out).to.equal(0n);
    });
  });

  describe("callback security", function () {
    it("rejects direct equilibraSwapCallback calls from non-pool sender", async function () {
      const { alice, weth, usdc, router } = await loadFixture(deployFixture);
      // Forge a single-hop payload — `_verifyCallback` rejects because
      // msg.sender (= alice) is not the CREATE2-derived pool address.
      const fakeData = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint32", "address"],
        [await weth.getAddress(), await usdc.getAddress(), 0, alice.address]
      );
      await expect(router.connect(alice).equilibraSwapCallback(1n, 0n, fakeData)).to.be.revertedWithCustomError(
        router,
        "InvalidCallbackSender"
      );
    });

    it("rejects direct equilibraMintCallback calls from non-pool sender", async function () {
      const { alice, weth, usdc, router } = await loadFixture(deployFixture);
      const fakeData = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,address,uint32,address)"],
        [[await weth.getAddress(), await usdc.getAddress(), 0, alice.address]]
      );
      await expect(router.connect(alice).equilibraMintCallback(1n, 0n, fakeData)).to.be.revertedWithCustomError(
        router,
        "InvalidCallbackSender"
      );
    });
  });
});
