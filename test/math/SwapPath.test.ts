import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

// Path layout: [token (20)][poolIndex (4)][token (20)][poolIndex (4)]...
// numPools = (path.length - 20) / 24.
function encodePath(tokens: string[], poolIndices: number[]): string {
  if (tokens.length !== poolIndices.length + 1) {
    throw new Error("bad path lengths");
  }
  let encoded = "0x";
  for (let i = 0; i < poolIndices.length; i++) {
    encoded += tokens[i].slice(2).toLowerCase();
    encoded += poolIndices[i].toString(16).padStart(8, "0");
  }
  encoded += tokens[tokens.length - 1].slice(2).toLowerCase();
  return encoded;
}

async function deployHarness() {
  const Harness = await hre.ethers.getContractFactory("SwapPathHarness");
  const h: any = await Harness.deploy();
  await h.waitForDeployment();
  return { h };
}

describe("SwapPath: numPools / hasMultiplePools", function () {
  it("counts a single-hop path as one pool", async function () {
    const { h } = await loadFixture(deployHarness);
    const a = "0x" + "a".repeat(40);
    const b = "0x" + "b".repeat(40);
    const path = encodePath([a, b], [0]);
    expect(await h.numPools(path)).to.equal(1n);
    expect(await h.hasMultiplePools(path)).to.equal(false);
  });

  it("counts a two-hop path as two pools", async function () {
    const { h } = await loadFixture(deployHarness);
    const a = "0x" + "a".repeat(40);
    const b = "0x" + "b".repeat(40);
    const c = "0x" + "c".repeat(40);
    const path = encodePath([a, b, c], [0, 1]);
    expect(await h.numPools(path)).to.equal(2n);
    expect(await h.hasMultiplePools(path)).to.equal(true);
  });

  it("counts a three-hop path as three pools", async function () {
    const { h } = await loadFixture(deployHarness);
    const a = "0x" + "a".repeat(40);
    const b = "0x" + "b".repeat(40);
    const c = "0x" + "c".repeat(40);
    const d = "0x" + "d".repeat(40);
    const path = encodePath([a, b, c, d], [0, 1, 2]);
    expect(await h.numPools(path)).to.equal(3n);
    expect(await h.hasMultiplePools(path)).to.equal(true);
  });
});
