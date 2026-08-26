import { expect } from "chai";
import hre from "hardhat";

// EIP-170 deployability guard for the PRODUCTION pool artifact. The
// in-process test network runs with `allowUnlimitedContractSize` (the
// internals-exposing MockEquilibraPool legitimately exceeds the cap),
// so this artifact-level assertion is what actually pins the shipped
// viaIR build under the mainnet limit. The coverage pipeline compiles
// without viaIR and intentionally exceeds the cap — skip there.
describe("EquilibraPool bytecode size", function () {
  it("stays within the EIP-170 runtime limit (viaIR build)", async function () {
    if (process.env.SOLIDITY_COVERAGE === "true") this.skip();
    const artifact = await hre.artifacts.readArtifact("EquilibraPool");
    const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
    expect(runtimeBytes).to.be.lte(24_576, `EquilibraPool runtime is ${runtimeBytes} bytes`);
  });
});
