import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const WAD = 10n ** 18n;
const PRESET = EQUILIBRA_PRESETS.WETH;
const DEADLINE_OFFSET = 3600;

// ---------------------------------------------------------------------------
// Fixture: deploy Factory + Pool + Router + MockWETH9. `token0` is chosen as
// MockWETH9 so we can exercise the WETH-wrapping branch of the router's
// internal `_pay`. `token1` is a plain ERC20 (USDC-like 6 decimals) for
// sanity-check of sweep/unwrap.
// ---------------------------------------------------------------------------
async function deployFixture() {
  const [owner, alice] = await hre.ethers.getSigners();

  const Weth = await hre.ethers.getContractFactory("MockWETH9");
  const weth = await Weth.deploy();
  await weth.waitForDeployment();

  const Token = await hre.ethers.getContractFactory("MockERC20");
  const other = await Token.deploy("USDC", "USDC", 6);
  await other.waitForDeployment();

  const wethAddr = await weth.getAddress();
  const otherAddr = await other.getAddress();

  // Pool factory sorts tokens by address → identify token0/token1 up-front.
  const [token0Addr, token1Addr] =
    wethAddr.toLowerCase() < otherAddr.toLowerCase() ? [wethAddr, otherAddr] : [otherAddr, wethAddr];
  const wethIsToken0 = wethAddr === token0Addr;

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImpl = await PoolImpl.deploy();
  await poolImpl.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
  await factory.waitForDeployment();

  // Seed owner liquidity: wrap a bit of ETH to WETH + mint USDC. The factory
  // is now the only entry point that can mint genesis LP shares, so it pulls
  // both seed amounts directly via `transferFrom` during pool creation.
  await weth.deposit({ value: hre.ethers.parseEther("1000") });
  await other.mint(owner.address, 10_000_000n * 10n ** 6n);

  const factoryAddr = await factory.getAddress();
  await weth.approve(factoryAddr, MaxUint256);
  await other.approve(factoryAddr, MaxUint256);

  // Price scale: 1 WETH ≈ 2000 USDC (we store value-normalized reserves
  // as (weth-amount, usdc-amount × 1e12) behind the pool's `scaleFromRaw`).
  // Seed 100 WETH + 200_000 USDC for a 1:2000 pool.
  const wethSeed = hre.ethers.parseEther("100");
  const usdcSeed = 200_000n * 10n ** 6n;

  // Order amount0/amount1 according to pool layout.
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

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(factoryAddr, await poolImpl.getAddress(), wethAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  // Subsequent (post-genesis) liquidity / swap interactions still flow
  // through the router, so leave the router approvals in place.
  await weth.approve(routerAddr, MaxUint256);
  await other.approve(routerAddr, MaxUint256);

  return {
    owner,
    alice,
    weth,
    other,
    pool,
    router,
    routerAddr,
    wethAddr,
    otherAddr,
    token0Addr,
    token1Addr,
    wethIsToken0,
  };
}

describe("EquilibraRouter: periphery payments + multicall", function () {
  describe("Constructor validation", function () {
    it("reverts when WETH9 address is zero", async function () {
      const [owner] = await hre.ethers.getSigners();
      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();

      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
      await factory.waitForDeployment();

      const Router = await hre.ethers.getContractFactory("EquilibraRouter");
      await expect(
        Router.deploy(await factory.getAddress(), await poolImpl.getAddress(), hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError({ interface: Router.interface } as any, "ZeroAddress");
    });

    it("exposes WETH9 as immutable public getter", async function () {
      const { router, wethAddr } = await loadFixture(deployFixture);
      expect(await router.WETH9()).to.equal(wethAddr);
    });

    it("reverts when factory address is zero", async function () {
      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();

      const Weth = await hre.ethers.getContractFactory("MockWETH9");
      const weth = await Weth.deploy();
      await weth.waitForDeployment();

      const Router = await hre.ethers.getContractFactory("EquilibraRouter");
      await expect(
        Router.deploy(hre.ethers.ZeroAddress, await poolImpl.getAddress(), await weth.getAddress())
      ).to.be.revertedWithCustomError({ interface: Router.interface } as any, "ZeroAddress");
    });

    it("reverts when poolImplementation address is zero", async function () {
      const [owner] = await hre.ethers.getSigners();
      const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
      const poolImpl = await PoolImpl.deploy();
      await poolImpl.waitForDeployment();

      const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
      const factory = await Factory.deploy(await poolImpl.getAddress(), owner.address, owner.address, 0);
      await factory.waitForDeployment();

      const Weth = await hre.ethers.getContractFactory("MockWETH9");
      const weth = await Weth.deploy();
      await weth.waitForDeployment();

      const Router = await hre.ethers.getContractFactory("EquilibraRouter");
      await expect(
        Router.deploy(await factory.getAddress(), hre.ethers.ZeroAddress, await weth.getAddress())
      ).to.be.revertedWithCustomError({ interface: Router.interface } as any, "ZeroAddress");
    });
  });

  describe("receive()", function () {
    it("accepts ETH only from the canonical WETH9", async function () {
      const { router, routerAddr, weth, alice } = await loadFixture(deployFixture);

      // Direct ETH from a non-WETH caller must revert.
      await expect(
        alice.sendTransaction({
          to: routerAddr,
          value: hre.ethers.parseEther("1"),
        })
      ).to.be.revertedWithCustomError(router, "NotWETH9");

      // WETH.withdraw() → native refund path: should succeed. We impersonate
      // the WETH contract to prove the allow-list is correctly keyed on it.
      // Simpler: pre-fund router via a contract call that triggers WETH
      // withdraw — covered indirectly by unwrapWETH9 tests below.
      expect(await weth.balanceOf(routerAddr)).to.equal(0);
    });
  });

  describe("refundETH", function () {
    it("refunds the router's native balance to the caller", async function () {
      const { router, routerAddr, alice } = await loadFixture(deployFixture);

      // Force-fund the router with 1 ETH via selfdestruct (any path that
      // lands ETH on the router without a receive() check). Easier: use
      // hardhat's setBalance cheatcode — it bypasses receive().
      await hre.network.provider.send("hardhat_setBalance", [
        routerAddr,
        "0x" + hre.ethers.parseEther("2").toString(16),
      ]);

      const before = await hre.ethers.provider.getBalance(alice.address);
      const tx = await router.connect(alice).refundETH();
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;
      const after = await hre.ethers.provider.getBalance(alice.address);

      expect(after - before + gasPaid).to.equal(hre.ethers.parseEther("2"));
      expect(await hre.ethers.provider.getBalance(routerAddr)).to.equal(0);
    });

    it("is a no-op when the router has no ETH", async function () {
      const { router, alice } = await loadFixture(deployFixture);
      await expect(router.connect(alice).refundETH()).to.not.be.reverted;
    });
  });

  describe("sweepToken", function () {
    it("transfers the router's full token balance to recipient", async function () {
      const { router, routerAddr, other, owner, alice } = await loadFixture(deployFixture);

      const amount = 1_000n * 10n ** 6n;
      await other.mint(routerAddr, amount);

      await router.connect(owner).sweepToken(await other.getAddress(), 0, alice.address);

      expect(await other.balanceOf(routerAddr)).to.equal(0);
      expect(await other.balanceOf(alice.address)).to.equal(amount);
    });

    it("reverts when balance is below amountMinimum", async function () {
      const { router, routerAddr, other, owner, alice } = await loadFixture(deployFixture);

      const amount = 1_000n * 10n ** 6n;
      await other.mint(routerAddr, amount);

      await expect(
        router.connect(owner).sweepToken(await other.getAddress(), amount + 1n, alice.address)
      ).to.be.revertedWithCustomError(router, "InsufficientToken");
    });

    it("is a no-op when balance is zero and amountMinimum is zero", async function () {
      const { router, other, alice } = await loadFixture(deployFixture);
      await expect(router.sweepToken(await other.getAddress(), 0, alice.address)).to.not.be.reverted;
    });
  });

  describe("unwrapWETH9", function () {
    it("unwraps all WETH held by the router and forwards ETH", async function () {
      const { router, routerAddr, weth, owner, alice } = await loadFixture(deployFixture);

      const amount = hre.ethers.parseEther("3");
      await weth.deposit({ value: amount });
      await weth.transfer(routerAddr, amount);

      const before = await hre.ethers.provider.getBalance(alice.address);
      await router.connect(owner).unwrapWETH9(0, alice.address);
      const after = await hre.ethers.provider.getBalance(alice.address);

      expect(after - before).to.equal(amount);
      expect(await weth.balanceOf(routerAddr)).to.equal(0);
    });

    it("reverts when WETH balance is below amountMinimum", async function () {
      const { router, routerAddr, weth, alice } = await loadFixture(deployFixture);

      const amount = hre.ethers.parseEther("1");
      await weth.deposit({ value: amount });
      await weth.transfer(routerAddr, amount);

      await expect(router.unwrapWETH9(amount + 1n, alice.address)).to.be.revertedWithCustomError(
        router,
        "InsufficientWETH9"
      );
    });
  });

  describe("multicall", function () {
    it("executes multiple payment helpers in one tx", async function () {
      const { router, routerAddr, weth, other, owner, alice } = await loadFixture(deployFixture);

      // Drop 1 WETH + 500 USDC + 0.5 ETH on the router, then sweep them all
      // atomically via a single multicall from Alice.
      await weth.deposit({ value: hre.ethers.parseEther("1") });
      await weth.transfer(routerAddr, hre.ethers.parseEther("1"));
      await other.mint(routerAddr, 500n * 10n ** 6n);
      await hre.network.provider.send("hardhat_setBalance", [
        routerAddr,
        "0x" + hre.ethers.parseEther("0.5").toString(16),
      ]);

      const iface = router.interface;
      const calls = [
        iface.encodeFunctionData("unwrapWETH9", [0, alice.address]),
        iface.encodeFunctionData("sweepToken", [await other.getAddress(), 0, alice.address]),
        iface.encodeFunctionData("refundETH"),
      ];

      const aliceBefore = await hre.ethers.provider.getBalance(alice.address);
      const ownerBefore = await hre.ethers.provider.getBalance(owner.address);

      const tx = await router.connect(owner).multicall(calls);
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;

      const aliceAfter = await hre.ethers.provider.getBalance(alice.address);
      const ownerAfter = await hre.ethers.provider.getBalance(owner.address);

      // Alice receives unwrapped WETH as ETH (1 ETH).
      expect(aliceAfter - aliceBefore).to.equal(hre.ethers.parseEther("1"));
      // Owner receives refunded ETH (0.5 ETH) minus gas.
      expect(ownerAfter - ownerBefore + gasPaid).to.equal(hre.ethers.parseEther("0.5"));
      // USDC goes to Alice via sweepToken.
      expect(await other.balanceOf(alice.address)).to.equal(500n * 10n ** 6n);
      expect(await weth.balanceOf(routerAddr)).to.equal(0);
      expect(await other.balanceOf(routerAddr)).to.equal(0);
    });

    it("bubbles up inner revert data from a failing call", async function () {
      const { router, other, alice } = await loadFixture(deployFixture);

      const iface = router.interface;
      // sweepToken with amountMinimum far exceeding the zero balance.
      const calls = [
        iface.encodeFunctionData("sweepToken", [await other.getAddress(), hre.ethers.parseEther("1"), alice.address]),
      ];

      await expect(router.multicall(calls)).to.be.revertedWithCustomError(router, "InsufficientToken");
    });
  });

  describe("Native-ETH swap via multicall (exactInputSingle + WETH wrap)", function () {
    it("accepts native ETH and routes proceeds to recipient via sweepToken", async function () {
      const {
        router,
        routerAddr,
        weth,
        other,
        owner,
        alice,
        token0Addr,
        token1Addr,
        wethIsToken0,
        otherAddr,
        wethAddr,
      } = await loadFixture(deployFixture);

      const amountInEth = hre.ethers.parseEther("1");
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      // Encode a single-hop swap WETH → USDC with recipient = router (captured),
      // then sweep USDC to Alice in the same tx.
      const iface = router.interface;

      const swapCall = iface.encodeFunctionData("exactInputSingle", [
        {
          tokenIn: wethAddr,
          tokenOut: otherAddr,
          poolIndex: 0,
          recipient: hre.ethers.ZeroAddress, // captured on router
          amountIn: amountInEth,
          amountOutMinimum: 0,
          deadline,
        },
      ]);
      const sweepCall = iface.encodeFunctionData("sweepToken", [
        otherAddr,
        1n, // any positive delivery confirms the swap executed
        alice.address,
      ]);
      const refundCall = iface.encodeFunctionData("refundETH");

      const usdcBefore = await other.balanceOf(alice.address);
      const routerWethBefore = await weth.balanceOf(routerAddr);

      const tx = await router.connect(owner).multicall([swapCall, sweepCall, refundCall], { value: amountInEth });
      await tx.wait();

      const usdcAfter = await other.balanceOf(alice.address);

      expect(usdcAfter - usdcBefore).to.be.greaterThan(0n);
      // Router should not retain leftover WETH or USDC after the sweep.
      expect(await weth.balanceOf(routerAddr)).to.equal(routerWethBefore);
      expect(await other.balanceOf(routerAddr)).to.equal(0);
      // And no leftover ETH (refundETH at the tail).
      expect(await hre.ethers.provider.getBalance(routerAddr)).to.equal(0);

      // Silence "unused" lints for destructured params not needed in assertions.
      void token0Addr;
      void token1Addr;
      void wethIsToken0;
    });
  });

  // V3/SwapRouter02 composition surface: payable liquidity + zaps funded
  // from attached native ETH, the `amountIn == 0` CONTRACT_BALANCE
  // sentinel, `recipient == address(0)` output staging, and the
  // removeLiquidity wrapper — each exercised end-to-end through
  // `multicall` with the permissionless tail helpers.
  describe("V3 composition: native ETH + staged inputs", function () {
    const USDC = 10n ** 6n;

    async function fundAlice(fx: Awaited<ReturnType<typeof deployFixture>>) {
      await fx.other.mint(fx.alice.address, 1_000_000n * USDC);
      await fx.other.connect(fx.alice).approve(fx.routerAddr, MaxUint256);
    }

    function liquidityAddedArgs(rcpt: any, pool: any) {
      for (const log of rcpt.logs) {
        try {
          const parsed = pool.interface.parseLog(log);
          if (parsed?.name === "LiquidityAdded") return parsed.args;
        } catch {
          /* other contract's log */
        }
      }
      throw new Error("LiquidityAdded not emitted");
    }

    it("addLiquidity funds the WETH leg from attached ETH and refunds the excess", async function () {
      const fx = await loadFixture(deployFixture);
      await fundAlice(fx);

      const params = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        recipient: fx.alice.address,
        amountADesired: hre.ethers.parseEther("1"),
        amountBDesired: 2_000n * USDC,
        minShares: 0,
        deadline: MaxUint256,
      };
      const calls = [
        fx.router.interface.encodeFunctionData("addLiquidity", [params]),
        fx.router.interface.encodeFunctionData("refundETH"),
      ];

      const ethBefore = await hre.ethers.provider.getBalance(fx.alice.address);
      const tx = await fx.router.connect(fx.alice).multicall(calls, { value: hre.ethers.parseEther("2") });
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;
      const ethAfter = await hre.ethers.provider.getBalance(fx.alice.address);

      const args = liquidityAddedArgs(rcpt, fx.pool);
      const wethUsed = fx.wethIsToken0 ? args[2] : args[3];
      expect(await fx.pool.balanceOf(fx.alice.address)).to.be.greaterThan(0n);
      // The callback wrapped EXACTLY the used amount; everything else
      // came back through the refundETH tail.
      expect(ethBefore - ethAfter - gasPaid).to.equal(wethUsed);
      expect(await hre.ethers.provider.getBalance(fx.routerAddr)).to.equal(0n);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);
    });

    it("addLiquidity wraps only the PARTIALLY used ETH side under the proportional cap", async function () {
      const fx = await loadFixture(deployFixture);
      await fundAlice(fx);

      // 1:2000 pool; desiring 1 WETH against only 1000 USDC makes the
      // USDC side binding — roughly half of the attached ETH is used.
      const params = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        recipient: fx.alice.address,
        amountADesired: hre.ethers.parseEther("1"),
        amountBDesired: 1_000n * USDC,
        minShares: 0,
        deadline: MaxUint256,
      };
      const calls = [
        fx.router.interface.encodeFunctionData("addLiquidity", [params]),
        fx.router.interface.encodeFunctionData("refundETH"),
      ];

      const ethBefore = await hre.ethers.provider.getBalance(fx.alice.address);
      const tx = await fx.router.connect(fx.alice).multicall(calls, { value: hre.ethers.parseEther("2") });
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;
      const ethAfter = await hre.ethers.provider.getBalance(fx.alice.address);

      const args = liquidityAddedArgs(rcpt, fx.pool);
      const wethUsed = fx.wethIsToken0 ? args[2] : args[3];
      expect(wethUsed).to.be.lessThan(hre.ethers.parseEther("0.51"));
      expect(ethBefore - ethAfter - gasPaid).to.equal(wethUsed);
      expect(await hre.ethers.provider.getBalance(fx.routerAddr)).to.equal(0n);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);
    });

    it("zapInSingleSided funds the WETH input from attached ETH with no residue", async function () {
      const fx = await loadFixture(deployFixture);

      const params = {
        tokenIn: fx.wethAddr,
        tokenOut: fx.otherAddr,
        poolIndex: 0,
        recipient: fx.alice.address,
        amountIn: hre.ethers.parseEther("1"),
        minLiquidity: 0,
        deadline: MaxUint256,
      };
      await fx.router.connect(fx.alice).zapInSingleSided(params, { value: hre.ethers.parseEther("1") });

      expect(await fx.pool.balanceOf(fx.alice.address)).to.be.greaterThan(0n);
      // Exact-amount wrap: nothing native left behind, nothing staged.
      expect(await hre.ethers.provider.getBalance(fx.routerAddr)).to.equal(0n);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);
    });

    it("zapInImbalanced funds the WETH side from attached ETH", async function () {
      const fx = await loadFixture(deployFixture);
      await fundAlice(fx);

      const params = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        recipient: fx.alice.address,
        amountA: hre.ethers.parseEther("0.5"),
        amountB: 500n * USDC,
        minLiquidity: 0,
        deadline: MaxUint256,
      };
      await fx.router.connect(fx.alice).zapInImbalanced(params, { value: hre.ethers.parseEther("0.5") });

      expect(await fx.pool.balanceOf(fx.alice.address)).to.be.greaterThan(0n);
      expect(await hre.ethers.provider.getBalance(fx.routerAddr)).to.equal(0n);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);
    });

    it("amountIn == 0 sentinel zaps in the router's staged balance from a chained exactInput", async function () {
      const fx = await loadFixture(deployFixture);
      await fundAlice(fx);

      const swapParams = {
        tokenIn: fx.otherAddr,
        tokenOut: fx.wethAddr,
        poolIndex: 0,
        recipient: hre.ethers.ZeroAddress, // stage the WETH in the router
        amountIn: 2_000n * USDC,
        amountOutMinimum: 0,
        deadline: MaxUint256,
      };
      const zapParams = {
        tokenIn: fx.wethAddr,
        tokenOut: fx.otherAddr,
        poolIndex: 0,
        recipient: fx.alice.address,
        amountIn: 0, // CONTRACT_BALANCE sentinel
        minLiquidity: 0,
        deadline: MaxUint256,
      };
      const staged = await fx.router.connect(fx.alice).exactInputSingle.staticCall(swapParams);
      const calls = [
        fx.router.interface.encodeFunctionData("exactInputSingle", [swapParams]),
        fx.router.interface.encodeFunctionData("zapInSingleSided", [zapParams]),
      ];
      const tx = await fx.router.connect(fx.alice).multicall(calls);
      const rcpt = await tx.wait();

      expect(await fx.pool.balanceOf(fx.alice.address)).to.be.greaterThan(0n);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);

      // The event must carry the EFFECTIVE input (the resolved staged
      // balance), never the zero sentinel — indexers price zaps off it.
      const zapIn = rcpt!.logs
        .map((log: any) => {
          try {
            return fx.router.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "ZapIn");
      expect(zapIn, "ZapIn emitted").to.not.equal(undefined);
      expect(zapIn!.args.amountIn).to.equal(staged);
      expect(staged).to.be.greaterThan(0n);
    });

    it("amountIn == 0 sentinel reverts when nothing is staged", async function () {
      const fx = await loadFixture(deployFixture);
      await expect(
        fx.router.connect(fx.alice).zapInSingleSided({
          tokenIn: fx.wethAddr,
          tokenOut: fx.otherAddr,
          poolIndex: 0,
          recipient: fx.alice.address,
          amountIn: 0,
          minLiquidity: 0,
          deadline: MaxUint256,
        })
      ).to.be.revertedWithCustomError(fx.router, "ZeroAmount");
    });

    it("zapOutSingleSided stages to the router and unwraps to native ETH", async function () {
      const fx = await loadFixture(deployFixture);

      const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
      await fx.pool.connect(fx.owner).approve(fx.routerAddr, MaxUint256);

      // Quote first so the executed batch carries production-like
      // NON-ZERO minima on both the zap and the unwrap tail, and the
      // final assertion is an exact-delta equality.
      const quoted = await fx.router.connect(fx.owner).zapOutSingleSided.staticCall({
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        tokenOut: fx.wethAddr,
        recipient: hre.ethers.ZeroAddress,
        liquidity: shares,
        minAmountOut: 0,
        deadline: MaxUint256,
      });
      const zapOutParams = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        tokenOut: fx.wethAddr,
        recipient: hre.ethers.ZeroAddress, // stage for unwrapWETH9
        liquidity: shares,
        minAmountOut: quoted,
        deadline: MaxUint256,
      };
      const calls = [
        fx.router.interface.encodeFunctionData("zapOutSingleSided", [zapOutParams]),
        fx.router.interface.encodeFunctionData("unwrapWETH9", [quoted, fx.owner.address]),
      ];

      const ethBefore = await hre.ethers.provider.getBalance(fx.owner.address);
      const tx = await fx.router.connect(fx.owner).multicall(calls);
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;
      const ethAfter = await hre.ethers.provider.getBalance(fx.owner.address);

      expect(ethAfter - ethBefore + gasPaid).to.equal(quoted);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);
      expect(await hre.ethers.provider.getBalance(fx.routerAddr)).to.equal(0n);
    });

    it("removeLiquidity pays out both legs to an explicit recipient in caller token order", async function () {
      const fx = await loadFixture(deployFixture);

      const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
      await fx.pool.connect(fx.owner).approve(fx.routerAddr, MaxUint256);

      const params = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        shares,
        amountAMin: 0,
        amountBMin: 0,
        recipient: fx.alice.address,
        deadline: MaxUint256,
      };
      const [amountA, amountB] = await fx.router.connect(fx.owner).removeLiquidity.staticCall(params);
      await fx.router.connect(fx.owner).removeLiquidity(params);

      // Caller order: `amountA` is the WETH leg because tokenA == WETH,
      // regardless of the canonical sort.
      expect(await fx.weth.balanceOf(fx.alice.address)).to.equal(amountA);
      expect(await fx.other.balanceOf(fx.alice.address)).to.equal(amountB);
    });

    it("removeLiquidity with recipient == 0 composes into a native-ETH withdrawal", async function () {
      const fx = await loadFixture(deployFixture);

      const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
      await fx.pool.connect(fx.owner).approve(fx.routerAddr, MaxUint256);

      const params = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        shares,
        amountAMin: 0,
        amountBMin: 0,
        recipient: hre.ethers.ZeroAddress, // stage both legs in the router
        deadline: MaxUint256,
      };
      const [wethLeg, usdcLeg] = await fx.router.connect(fx.owner).removeLiquidity.staticCall(params);

      // Tail order is deliberate: every ERC20 sweep first, the native
      // transfer (the only step that hands control to the recipient)
      // last, and each leg bounded by a non-zero minimum so a short
      // payout reverts the whole batch instead of silently no-opping.
      const calls = [
        fx.router.interface.encodeFunctionData("removeLiquidity", [params]),
        fx.router.interface.encodeFunctionData("sweepToken", [fx.otherAddr, usdcLeg, fx.owner.address]),
        fx.router.interface.encodeFunctionData("unwrapWETH9", [wethLeg, fx.owner.address]),
      ];

      const ethBefore = await hre.ethers.provider.getBalance(fx.owner.address);
      const usdcBefore = await fx.other.balanceOf(fx.owner.address);
      const tx = await fx.router.connect(fx.owner).multicall(calls);
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;

      expect((await hre.ethers.provider.getBalance(fx.owner.address)) - ethBefore + gasPaid).to.equal(wethLeg);
      expect((await fx.other.balanceOf(fx.owner.address)) - usdcBefore).to.equal(usdcLeg);
      expect(await fx.weth.balanceOf(fx.routerAddr)).to.equal(0n);
      expect(await hre.ethers.provider.getBalance(fx.routerAddr)).to.equal(0n);
      expect(await fx.other.balanceOf(fx.routerAddr)).to.equal(0n);
    });

    // Both `aIsToken0` arms of removeLiquidity, deterministically: one
    // round passes the pair in canonical order (tokenA == token0), the
    // other reversed (tokenA == token1). The legs differ by many orders
    // of magnitude (18-dec WETH vs 6-dec USDC raw units), so a swapped
    // min-mapping or a swapped return-mapping cannot pass: each round
    // executes with EXACT per-leg minima (min == leg) and asserts exact
    // payouts in the caller's token order.
    it("removeLiquidity maps minima and payouts correctly in BOTH caller token orders", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.pool.connect(fx.owner).approve(fx.routerAddr, MaxUint256);

      for (const reversed of [false, true]) {
        const tokenA = reversed ? fx.token1Addr : fx.token0Addr;
        const tokenB = reversed ? fx.token0Addr : fx.token1Addr;
        const shares = (await fx.pool.balanceOf(fx.owner.address)) / 20n;

        const quoteParams = {
          tokenA,
          tokenB,
          poolIndex: 0,
          shares,
          amountAMin: 0,
          amountBMin: 0,
          recipient: fx.alice.address,
          deadline: MaxUint256,
        };
        const [legA, legB] = await fx.router.connect(fx.owner).removeLiquidity.staticCall(quoteParams);

        // Exact minima on the CALLER's legs must pass...
        const tokenAContract = await hre.ethers.getContractAt("MockERC20", tokenA);
        const tokenBContract = await hre.ethers.getContractAt("MockERC20", tokenB);
        const balABefore = await tokenAContract.balanceOf(fx.alice.address);
        const balBBefore = await tokenBContract.balanceOf(fx.alice.address);
        await fx.router.connect(fx.owner).removeLiquidity({ ...quoteParams, amountAMin: legA, amountBMin: legB });
        expect((await tokenAContract.balanceOf(fx.alice.address)) - balABefore).to.equal(legA);
        expect((await tokenBContract.balanceOf(fx.alice.address)) - balBBefore).to.equal(legB);
      }
    });

    it("removeLiquidity reverts when a per-leg minimum is not met, on either leg and order", async function () {
      const fx = await loadFixture(deployFixture);
      await fx.pool.connect(fx.owner).approve(fx.routerAddr, MaxUint256);

      for (const reversed of [false, true]) {
        const tokenA = reversed ? fx.token1Addr : fx.token0Addr;
        const tokenB = reversed ? fx.token0Addr : fx.token1Addr;
        const shares = (await fx.pool.balanceOf(fx.owner.address)) / 20n;

        const base = {
          tokenA,
          tokenB,
          poolIndex: 0,
          shares,
          amountAMin: 0,
          amountBMin: 0,
          recipient: fx.alice.address,
          deadline: MaxUint256,
        };
        const [legA, legB] = await fx.router.connect(fx.owner).removeLiquidity.staticCall(base);

        // One wei above the quoted leg — the slippage guard must fire
        // for EACH side independently (a swapped min-mapping would let
        // the tiny-units leg's min pass against the 18-dec leg).
        await expect(
          fx.router.connect(fx.owner).removeLiquidity({ ...base, amountAMin: legA + 1n })
        ).to.be.revertedWithCustomError(fx.router, "SlippageExceeded");
        await expect(
          fx.router.connect(fx.owner).removeLiquidity({ ...base, amountBMin: legB + 1n })
        ).to.be.revertedWithCustomError(fx.router, "SlippageExceeded");
      }
    });

    it("removeLiquidity validation reverts: zero shares, identical tokens, zero token, expired deadline", async function () {
      const fx = await loadFixture(deployFixture);
      const base = {
        tokenA: fx.wethAddr,
        tokenB: fx.otherAddr,
        poolIndex: 0,
        shares: 1n,
        amountAMin: 0,
        amountBMin: 0,
        recipient: fx.owner.address,
        deadline: MaxUint256,
      };

      await expect(fx.router.connect(fx.owner).removeLiquidity({ ...base, shares: 0n })).to.be.revertedWithCustomError(
        fx.router,
        "ZeroAmount"
      );
      await expect(
        fx.router.connect(fx.owner).removeLiquidity({ ...base, tokenB: fx.wethAddr })
      ).to.be.revertedWithCustomError(fx.router, "IdenticalTokens");
      await expect(
        fx.router.connect(fx.owner).removeLiquidity({ ...base, tokenA: hre.ethers.ZeroAddress })
      ).to.be.revertedWithCustomError(fx.router, "ZeroAddress");
      const past = BigInt(await time.latest()) - 1n;
      await expect(
        fx.router.connect(fx.owner).removeLiquidity({ ...base, deadline: past })
      ).to.be.revertedWithCustomError(fx.router, "DeadlineExpired");
    });

    // `multicall` delegatecalls only back into the router, so an
    // external `pool.permit(...)` can never be a batch element — the
    // selfPermit forwarder is what makes signature + action atomic.
    describe("selfPermit", function () {
      async function signLpPermit(fx: Awaited<ReturnType<typeof deployFixture>>, value: bigint, deadline: bigint) {
        const poolAddr = await fx.pool.getAddress();
        const sig = await fx.owner.signTypedData(
          {
            name: await fx.pool.name(),
            version: "1",
            chainId: (await hre.ethers.provider.getNetwork()).chainId,
            verifyingContract: poolAddr,
          },
          {
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          {
            owner: fx.owner.address,
            spender: fx.routerAddr,
            value,
            nonce: await fx.pool.nonces(fx.owner.address),
            deadline,
          }
        );
        return hre.ethers.Signature.from(sig);
      }

      it("makes signature + removeLiquidity atomic in one batch", async function () {
        const fx = await loadFixture(deployFixture);
        const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
        const deadline = MaxUint256;
        const { v, r, s } = await signLpPermit(fx, shares, deadline);
        const poolAddr = await fx.pool.getAddress();

        // No prior approval exists — the batch must create it itself.
        expect(await fx.pool.allowance(fx.owner.address, fx.routerAddr)).to.equal(0n);

        const calls = [
          fx.router.interface.encodeFunctionData("selfPermit", [poolAddr, shares, deadline, v, r, s]),
          fx.router.interface.encodeFunctionData("removeLiquidity", [
            {
              tokenA: fx.wethAddr,
              tokenB: fx.otherAddr,
              poolIndex: 0,
              shares,
              amountAMin: 0,
              amountBMin: 0,
              recipient: fx.owner.address,
              deadline,
            },
          ]),
        ];
        const wethBefore = await fx.weth.balanceOf(fx.owner.address);
        await fx.router.connect(fx.owner).multicall(calls);
        expect(await fx.weth.balanceOf(fx.owner.address)).to.be.greaterThan(wethBefore);
      });

      it("selfPermit reverts on a consumed signature; selfPermitIfNecessary no-ops", async function () {
        const fx = await loadFixture(deployFixture);
        const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
        const deadline = MaxUint256;
        const { v, r, s } = await signLpPermit(fx, shares, deadline);
        const poolAddr = await fx.pool.getAddress();

        // Front-run: anyone can lift the signature out of the mempool
        // and submit it standalone, consuming the nonce.
        await fx.pool.connect(fx.alice).permit(fx.owner.address, fx.routerAddr, shares, deadline, v, r, s);
        expect(await fx.pool.allowance(fx.owner.address, fx.routerAddr)).to.equal(shares);

        // A bare selfPermit would now fail the whole batch...
        await expect(fx.router.connect(fx.owner).selfPermit(poolAddr, shares, deadline, v, r, s)).to.be.reverted;

        // ...while the IfNecessary variant sees the live allowance and
        // skips, so the batch survives the front-run.
        await expect(fx.router.connect(fx.owner).selfPermitIfNecessary(poolAddr, shares, deadline, v, r, s)).to.not.be
          .reverted;
      });

      it("selfPermitIfNecessary forwards the permit when the allowance is insufficient", async function () {
        const fx = await loadFixture(deployFixture);
        const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
        const deadline = MaxUint256;
        const { v, r, s } = await signLpPermit(fx, shares, deadline);
        const poolAddr = await fx.pool.getAddress();

        // First-use path every UI hits: no prior allowance, so the
        // IfNecessary variant must take the FORWARDING branch and
        // actually execute the permit (not just skip).
        expect(await fx.pool.allowance(fx.owner.address, fx.routerAddr)).to.equal(0n);
        await fx.router.connect(fx.owner).selfPermitIfNecessary(poolAddr, shares, deadline, v, r, s);
        expect(await fx.pool.allowance(fx.owner.address, fx.routerAddr)).to.equal(shares);
      });

      it("selfPermit reverts on an expired deadline", async function () {
        const fx = await loadFixture(deployFixture);
        const shares = (await fx.pool.balanceOf(fx.owner.address)) / 10n;
        const expired = BigInt(await time.latest()) - 1n;
        const { v, r, s } = await signLpPermit(fx, shares, expired);
        const poolAddr = await fx.pool.getAddress();

        await expect(fx.router.connect(fx.owner).selfPermit(poolAddr, shares, expired, v, r, s)).to.be.reverted;
      });
    });
  });
});
