import hre from "hardhat";
import { expect } from "chai";

// Unit-level coverage for the cosmetic-metadata fallback in
// `EquilibraFactory._safeSymbol`. The factory delegates to Solady's
// `MetadataReaderLib.readSymbol`, which is responsible for trying the
// standard `string symbol()` and falling back to legacy `bytes32
// symbol()` (MKR-style) in a single assembly probe. We bypass full
// pool deployment by going through `EquilibraFactoryHarness`, which
// subclasses the factory and re-exposes the internal helper.
async function deployHarness() {
  const Harness = await hre.ethers.getContractFactory("EquilibraFactoryHarness");
  // The constructor only checks non-zero on impl + feeCollector + WETH9 — we
  // never call any pool-deployment path here, so any non-zero
  // sentinel works.
  const sentinel = "0x000000000000000000000000000000000000dEaD";
  const harness: any = await Harness.deploy(sentinel, sentinel, sentinel);
  await harness.waitForDeployment();
  return harness;
}

describe("EquilibraFactory._safeSymbol fallback chain", () => {
  it("returns the string symbol for standard EIP-20 Metadata tokens", async () => {
    const harness = await deployHarness();
    const Token = await hre.ethers.getContractFactory("MockSymbolString");
    const tok = await Token.deploy("USDC");
    await tok.waitForDeployment();

    expect(await harness.exposed_safeSymbol(await tok.getAddress())).to.equal("USDC");
  });

  it("decodes a bytes32 symbol (MKR-style) on string-decode failure", async () => {
    const harness = await deployHarness();
    const Token = await hre.ethers.getContractFactory("MockSymbolBytes32");
    const raw = hre.ethers.encodeBytes32String("MKR");
    const tok = await Token.deploy(raw);
    await tok.waitForDeployment();

    expect(await harness.exposed_safeSymbol(await tok.getAddress())).to.equal("MKR");
  });

  it("strips trailing NUL padding on short bytes32 symbols", async () => {
    const harness = await deployHarness();
    const Token = await hre.ethers.getContractFactory("MockSymbolBytes32");
    // 'A','B' + 30 NUL bytes ⇒ "AB".
    const raw = "0x" + "4142" + "00".repeat(30);
    const tok = await Token.deploy(raw);
    await tok.waitForDeployment();

    expect(await harness.exposed_safeSymbol(await tok.getAddress())).to.equal("AB");
  });

  it("returns '???' when the token has no symbol() selector at all", async () => {
    const harness = await deployHarness();
    const Token = await hre.ethers.getContractFactory("MockSymbolNone");
    const tok = await Token.deploy();
    await tok.waitForDeployment();

    expect(await harness.exposed_safeSymbol(await tok.getAddress())).to.equal("???");
  });

  it("returns '???' when the target address has no code", async () => {
    const harness = await deployHarness();
    // EOA / empty address — `staticcall` succeeds with empty returndata.
    const empty = hre.ethers.getAddress("0x000000000000000000000000000000000000beef");
    expect(await harness.exposed_safeSymbol(empty)).to.equal("???");
  });
});
