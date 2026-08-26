// Owner-curated Boost registry on the factory (phase-5 of the Boost
// wrapper): binding is attestation, not permission — the setter
// validates that the pool belongs to this factory and that the vault
// wraps exactly that pool; rebind and unbind are first-class.
import { expect } from "chai";
import hre from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { deploySecurityFixture, buildPreset } from "../helpers/securityFixtures";

async function fixture() {
  const fx = await deploySecurityFixture(buildPreset("WETH"));
  const [owner, stranger] = await hre.ethers.getSigners();
  const Mock = await hre.ethers.getContractFactory("MockBoostVault");
  const goodVault: any = await Mock.deploy(await fx.pool.getAddress());
  const wrongVault: any = await Mock.deploy(await stranger.getAddress()); // wraps "another pool"
  return { ...fx, owner, stranger, goodVault, wrongVault };
}

describe("EquilibraFactory: Boost curation registry", function () {
  it("owner binds, rebinds and unbinds; views track the set", async function () {
    const fx = await loadFixture(fixture);
    const pool = await fx.pool.getAddress();
    const vault = await fx.goodVault.getAddress();

    await expect(fx.factory.setPoolBoost(pool, vault))
      .to.emit(fx.factory, "PoolBoostSet")
      .withArgs(pool, hre.ethers.ZeroAddress, vault);
    expect(await fx.factory.getPoolBoost(pool)).to.equal(vault);
    expect(await fx.factory.getBoostedPoolCount()).to.equal(1n);
    expect(await fx.factory.getBoostedPoolAt(0)).to.equal(pool);
    expect(await fx.factory.getBoostedPools()).to.deep.equal([pool]);

    // Rebind to a fresh stack: event carries (old, new); set stays deduped.
    const Mock = await hre.ethers.getContractFactory("MockBoostVault");
    const vault2: any = await Mock.deploy(pool);
    await expect(fx.factory.setPoolBoost(pool, await vault2.getAddress()))
      .to.emit(fx.factory, "PoolBoostSet")
      .withArgs(pool, vault, await vault2.getAddress());
    expect(await fx.factory.getBoostedPoolCount()).to.equal(1n);

    // Unbind.
    await expect(fx.factory.removePoolBoost(pool))
      .to.emit(fx.factory, "PoolBoostSet")
      .withArgs(pool, await vault2.getAddress(), hre.ethers.ZeroAddress);
    expect(await fx.factory.getPoolBoost(pool)).to.equal(hre.ethers.ZeroAddress);
    expect(await fx.factory.getBoostedPoolCount()).to.equal(0n);
  });

  it("rejects non-owner, foreign pools, mismatched vaults and empty unbinds", async function () {
    const fx = await loadFixture(fixture);
    const pool = await fx.pool.getAddress();

    await expect(
      fx.factory.connect(fx.stranger).setPoolBoost(pool, await fx.goodVault.getAddress())
    ).to.be.revertedWithCustomError(fx.factory, "OwnableUnauthorizedAccount");
    await expect(fx.factory.connect(fx.stranger).removePoolBoost(pool)).to.be.revertedWithCustomError(
      fx.factory,
      "OwnableUnauthorizedAccount"
    );

    // Zero vault is not the unbind path — removePoolBoost is.
    await expect(fx.factory.setPoolBoost(pool, hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(
      fx.factory,
      "ZeroAddress"
    );

    // A pool the factory did not create (mock vault pretends to be one).
    await expect(fx.factory.setPoolBoost(await fx.wrongVault.getAddress(), await fx.goodVault.getAddress())).to.be
      .reverted; // getPoolMetadata() missing -> call fails

    // An impostor that SELF-REPORTS the right metadata (this factory,
    // real tokens) but was never created by it: provenance is decided
    // by `_poolsByPair` membership, not by the pool's own claim.
    const meta = await fx.pool.getPoolMetadata();
    const FakePool = await hre.ethers.getContractFactory("MockFakePool");
    const fakePool: any = await FakePool.deploy(meta.token0, meta.token1, await fx.factory.getAddress());
    const MockVault = await hre.ethers.getContractFactory("MockBoostVault");
    const fakeVault: any = await MockVault.deploy(await fakePool.getAddress());
    await expect(
      fx.factory.setPoolBoost(await fakePool.getAddress(), await fakeVault.getAddress())
    ).to.be.revertedWithCustomError(fx.factory, "PoolNotFound");

    // Vault wrapping a different pool.
    await expect(fx.factory.setPoolBoost(pool, await fx.wrongVault.getAddress())).to.be.revertedWithCustomError(
      fx.factory,
      "BoostPoolMismatch"
    );

    // Unbinding when nothing is bound.
    await expect(fx.factory.removePoolBoost(pool)).to.be.revertedWithCustomError(fx.factory, "BoostNotBound");
  });
});
