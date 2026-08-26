import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256, Signature, TypedDataDomain } from "ethers";

import { EQUILIBRA_PRESETS } from "../../simulator/test_helpers/config";

const PRESET = EQUILIBRA_PRESETS.WETH;

// Canonical Permit2 singleton (Uniswap).
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function deployFixture() {
  const [owner, alice, bob, charlie] = await hre.ethers.getSigners();

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

  // Fund owner + alice up-front so the factory can pull genesis liquidity and
  // alice has share-headroom for the permit flows below.
  const supply = hre.ethers.parseEther("10000000");
  await token0.mint(owner.address, supply);
  await token1.mint(owner.address, supply);
  await token0.mint(alice.address, supply);
  await token1.mint(alice.address, supply);

  const factoryAddr = await factory.getAddress();
  await token0.approve(factoryAddr, MaxUint256);
  await token1.approve(factoryAddr, MaxUint256);

  // Atomic deploy + seed: factory is now the only entry point that can mint
  // genesis LP shares. `owner` is the seed LP so there is something to permit.
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
    hre.ethers.parseEther("1000"),
    hre.ethers.parseEther("1000"),
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
  const routerAddr = await router.getAddress();

  // Subsequent (post-genesis) liquidity additions still flow through the
  // router, so keep the router approvals in place for both signers.
  await token0.approve(routerAddr, MaxUint256);
  await token1.approve(routerAddr, MaxUint256);
  await token0.connect(alice).approve(routerAddr, MaxUint256);
  await token1.connect(alice).approve(routerAddr, MaxUint256);

  const token0Addr = await token0.getAddress();
  const token1Addr = await token1.getAddress();

  // The factory always sorts the pair lexicographically before storing it
  // on the pool, so the LP-token name reflects the SORTED order rather
  // than the deploy order. In the full Hardhat run nonces are not reset
  // between fixtures, so the deploy order alone cannot guarantee that
  // `TK0`'s address is lex-smaller than `TK1`'s. Resolve the symbols by
  // querying the actual `(token0, token1)` stored on the pool.
  const sym0 = await token0.symbol();
  const sym1 = await token1.symbol();
  const [lpSym0, lpSym1] = token0Addr.toLowerCase() < token1Addr.toLowerCase() ? [sym0, sym1] : [sym1, sym0];
  const lpName = `Equilibra LP: ${lpSym0}/${lpSym1} #0`;
  const lpSymbol = `ELP-${lpSym0}-${lpSym1}-0`;

  // Move a meaningful share stack to Alice so she has something to sign over.
  const aliceShares = hre.ethers.parseEther("100");
  await pool.transfer(alice.address, aliceShares);

  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const domain: TypedDataDomain = {
    name: await pool.name(),
    version: "1",
    chainId,
    verifyingContract: poolAddress,
  };

  const permitTypes = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  return {
    owner,
    alice,
    bob,
    charlie,
    token0,
    token1,
    pool,
    poolAddress,
    router,
    routerAddr,
    token0Addr,
    token1Addr,
    lpName,
    lpSymbol,
    domain,
    permitTypes,
    aliceShares,
  };
}

async function signPermit(
  signer: Awaited<ReturnType<typeof hre.ethers.getSigners>>[number],
  domain: TypedDataDomain,
  types: Record<string, { name: string; type: string }[]>,
  value: {
    owner: string;
    spender: string;
    value: bigint;
    nonce: bigint;
    deadline: bigint;
  }
): Promise<{ v: number; r: string; s: string }> {
  const raw = await signer.signTypedData(domain, types, value);
  const sig = Signature.from(raw);
  return { v: sig.v, r: sig.r, s: sig.s };
}

describe("EquilibraLpToken (solady ERC20 + EIP-2612 permit)", function () {
  describe("metadata", function () {
    it("exposes LP token name, symbol, decimals from the factory template", async function () {
      const { pool, lpName, lpSymbol } = await loadFixture(deployFixture);
      expect(await pool.name()).to.equal(lpName);
      expect(await pool.symbol()).to.equal(lpSymbol);
      expect(await pool.decimals()).to.equal(18);
    });

    it("exposes a non-zero DOMAIN_SEPARATOR consistent with EIP-712", async function () {
      const { pool, poolAddress, lpName } = await loadFixture(deployFixture);
      const domainSeparator: string = await pool.DOMAIN_SEPARATOR();
      expect(domainSeparator).to.not.equal(hre.ethers.ZeroHash);

      const chainId = (await hre.ethers.provider.getNetwork()).chainId;
      const typeHash = hre.ethers.keccak256(
        hre.ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
      );
      const nameHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(lpName));
      const versionHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("1"));
      const expected = hre.ethers.keccak256(
        hre.ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "bytes32", "bytes32", "uint256", "address"],
          [typeHash, nameHash, versionHash, chainId, poolAddress]
        )
      );
      expect(domainSeparator).to.equal(expected);
    });

    it("starts nonce at zero for every account", async function () {
      const { pool, alice, bob } = await loadFixture(deployFixture);
      expect(await pool.nonces(alice.address)).to.equal(0n);
      expect(await pool.nonces(bob.address)).to.equal(0n);
    });
  });

  describe("permit (EIP-2612)", function () {
    it("sets allowance and bumps nonce on a valid signature", async function () {
      const { pool, alice, bob, domain, permitTypes, aliceShares } = await loadFixture(deployFixture);

      const deadline = BigInt((await time.latest()) + 600);
      const nonce = await pool.nonces(alice.address);
      const { v, r, s } = await signPermit(alice, domain, permitTypes, {
        owner: alice.address,
        spender: bob.address,
        value: aliceShares,
        nonce,
        deadline,
      });

      await expect(pool.permit(alice.address, bob.address, aliceShares, deadline, v, r, s))
        .to.emit(pool, "Approval")
        .withArgs(alice.address, bob.address, aliceShares);

      expect(await pool.allowance(alice.address, bob.address)).to.equal(aliceShares);
      expect(await pool.nonces(alice.address)).to.equal(nonce + 1n);
    });

    it("rejects a replay of a consumed signature", async function () {
      const { pool, alice, bob, domain, permitTypes, aliceShares } = await loadFixture(deployFixture);

      const deadline = BigInt((await time.latest()) + 600);
      const nonce = await pool.nonces(alice.address);
      const { v, r, s } = await signPermit(alice, domain, permitTypes, {
        owner: alice.address,
        spender: bob.address,
        value: aliceShares,
        nonce,
        deadline,
      });

      await pool.permit(alice.address, bob.address, aliceShares, deadline, v, r, s);

      await expect(
        pool.permit(alice.address, bob.address, aliceShares, deadline, v, r, s)
      ).to.be.revertedWithCustomError(pool, "InvalidPermit");
    });

    it("reverts when the deadline has expired", async function () {
      const { pool, alice, bob, domain, permitTypes, aliceShares } = await loadFixture(deployFixture);

      const now = await time.latest();
      const deadline = BigInt(now + 120);
      const nonce = await pool.nonces(alice.address);
      const { v, r, s } = await signPermit(alice, domain, permitTypes, {
        owner: alice.address,
        spender: bob.address,
        value: aliceShares,
        nonce,
        deadline,
      });

      await time.increaseTo(Number(deadline) + 1);

      await expect(
        pool.permit(alice.address, bob.address, aliceShares, deadline, v, r, s)
      ).to.be.revertedWithCustomError(pool, "PermitExpired");
    });

    it("reverts when another signer forges the signature", async function () {
      const { pool, alice, bob, charlie, domain, permitTypes, aliceShares } = await loadFixture(deployFixture);

      const deadline = BigInt((await time.latest()) + 600);
      const nonce = await pool.nonces(alice.address);
      const { v, r, s } = await signPermit(charlie, domain, permitTypes, {
        owner: alice.address,
        spender: bob.address,
        value: aliceShares,
        nonce,
        deadline,
      });

      await expect(
        pool.permit(alice.address, bob.address, aliceShares, deadline, v, r, s)
      ).to.be.revertedWithCustomError(pool, "InvalidPermit");
    });

    it("enables permit + transferFrom end-to-end without a prior approve tx", async function () {
      const { pool, alice, bob, domain, permitTypes, aliceShares } = await loadFixture(deployFixture);

      const deadline = BigInt((await time.latest()) + 600);
      const nonce = await pool.nonces(alice.address);
      const { v, r, s } = await signPermit(alice, domain, permitTypes, {
        owner: alice.address,
        spender: bob.address,
        value: aliceShares,
        nonce,
        deadline,
      });

      expect(await pool.allowance(alice.address, bob.address)).to.equal(0n);

      await pool.connect(bob).permit(alice.address, bob.address, aliceShares, deadline, v, r, s);

      // Bob now moves the LP shares in the same session.
      await pool.connect(bob).transferFrom(alice.address, bob.address, aliceShares);

      expect(await pool.balanceOf(alice.address)).to.equal(0n);
      expect(await pool.balanceOf(bob.address)).to.equal(aliceShares);
      expect(await pool.allowance(alice.address, bob.address)).to.equal(0n);
    });

    it("enables permit + transferFrom + removeLiquidity (delegated exit via EIP-2612)", async function () {
      const { pool, alice, bob, token0, token1, domain, permitTypes, aliceShares } = await loadFixture(deployFixture);

      const deadline = BigInt((await time.latest()) + 600);
      const nonce = await pool.nonces(alice.address);
      const { v, r, s } = await signPermit(alice, domain, permitTypes, {
        owner: alice.address,
        spender: bob.address,
        value: aliceShares,
        nonce,
        deadline,
      });

      await pool.connect(bob).permit(alice.address, bob.address, aliceShares, deadline, v, r, s);

      // Bob pulls Alice's shares into his own account and then exits the pool
      // on his own behalf — exactly the flow an aggregator / vault would use
      // when offering a gasless "withdraw my LP" integration for end users.
      await pool.connect(bob).transferFrom(alice.address, bob.address, aliceShares);

      const t0Before = await token0.balanceOf(bob.address);
      const t1Before = await token1.balanceOf(bob.address);

      await pool.connect(bob).removeLiquidity(aliceShares, 0, 0, bob.address);

      expect(await pool.balanceOf(bob.address)).to.equal(0n);
      expect(await token0.balanceOf(bob.address)).to.be.gt(t0Before);
      expect(await token1.balanceOf(bob.address)).to.be.gt(t1Before);
    });
  });

  describe("Permit2 infinite-allowance shortcut is disabled", function () {
    it("reports zero Permit2 allowance by default", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      expect(await pool.allowance(alice.address, PERMIT2)).to.equal(0n);
    });

    it("treats Permit2 exactly like any other spender (no auto-infinity)", async function () {
      const { pool, alice } = await loadFixture(deployFixture);
      const amount = hre.ethers.parseEther("7");
      await pool.connect(alice).approve(PERMIT2, amount);
      expect(await pool.allowance(alice.address, PERMIT2)).to.equal(amount);
    });
  });

  describe("zero-address strictness", function () {
    it("rejects transfer to the zero address", async function () {
      const { pool, owner } = await loadFixture(deployFixture);
      await expect(pool.connect(owner).transfer(hre.ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
        pool,
        "ZeroAddress"
      );
    });

    it("rejects transferFrom to the zero address", async function () {
      const { pool, owner, alice } = await loadFixture(deployFixture);
      await pool.connect(owner).approve(alice.address, MaxUint256);
      await expect(
        pool.connect(alice).transferFrom(owner.address, hre.ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("standard ERC20 accounting", function () {
    it("approve + transferFrom consumes a finite allowance", async function () {
      const { pool, owner, alice, aliceShares } = await loadFixture(deployFixture);

      const allowance = hre.ethers.parseEther("50");
      await pool.connect(owner).approve(alice.address, allowance);
      expect(await pool.allowance(owner.address, alice.address)).to.equal(allowance);

      const aliceBalBefore = await pool.balanceOf(alice.address);
      const move = hre.ethers.parseEther("20");
      await pool.connect(alice).transferFrom(owner.address, alice.address, move);
      expect(await pool.allowance(owner.address, alice.address)).to.equal(allowance - move);
      expect(await pool.balanceOf(alice.address)).to.equal(aliceBalBefore + move);
      expect(aliceBalBefore).to.equal(aliceShares);
    });

    it("transferFrom with type(uint256).max allowance keeps the allowance intact", async function () {
      const { pool, owner, alice } = await loadFixture(deployFixture);

      await pool.connect(owner).approve(alice.address, MaxUint256);
      const move = hre.ethers.parseEther("5");
      await pool.connect(alice).transferFrom(owner.address, alice.address, move);
      expect(await pool.allowance(owner.address, alice.address)).to.equal(MaxUint256);
    });

    it("rejects transferFrom over the granted allowance", async function () {
      const { pool, owner, alice } = await loadFixture(deployFixture);

      const allowance = hre.ethers.parseEther("1");
      await pool.connect(owner).approve(alice.address, allowance);
      await expect(
        pool.connect(alice).transferFrom(owner.address, alice.address, allowance + 1n)
      ).to.be.revertedWithCustomError(pool, "InsufficientAllowance");
    });

    it("rejects transfer over balance", async function () {
      const { pool, alice, bob } = await loadFixture(deployFixture);
      const bal = await pool.balanceOf(alice.address);
      await expect(pool.connect(alice).transfer(bob.address, bal + 1n)).to.be.revertedWithCustomError(
        pool,
        "InsufficientBalance"
      );
    });
  });
});
