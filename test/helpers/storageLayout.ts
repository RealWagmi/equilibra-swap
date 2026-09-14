import hre from "hardhat";

/** Read slots from the current compiler output, not a historical layout. */
export async function storageSlot(contract: string, variable: string): Promise<bigint> {
  const info = await hre.artifacts.getBuildInfo(contract);
  if (!info) throw new Error("Missing build info: " + contract);
  const [source, name] = contract.split(":");
  const output = info.output.contracts[source][name] as unknown as {
    storageLayout: { storage: Array<{ label: string; slot: string }> };
  };
  const item = output.storageLayout.storage.find((s) => s.label === variable);
  if (!item) throw new Error("Missing storage variable: " + variable);
  return BigInt(item.slot);
}

export const POOL_CONTRACT = "contracts/EquilibraPool.sol:EquilibraPool";
export const TOKEN_CONTRACT = "contracts/mocks/MockERC20.sol:MockERC20";

/** Research-only parameter override, preserving adjacent packed fields. */
export async function setPackedPoolField(address: string, variable: string, value: bigint) {
  const info = await hre.artifacts.getBuildInfo(POOL_CONTRACT);
  if (!info) throw new Error("Missing pool build info");
  const output = info.output.contracts["contracts/EquilibraPool.sol"].EquilibraPool as unknown as {
    storageLayout: {
      storage: Array<{ label: string; slot: string; offset: number; type: string }>;
      types: Record<string, { numberOfBytes: string }>;
    };
  };
  const field = output.storageLayout.storage.find((s) => s.label === variable);
  if (!field) throw new Error("Missing pool field: " + variable);
  const bits = BigInt(output.storageLayout.types[field.type].numberOfBytes) * 8n;
  const mask = (1n << bits) - 1n;
  if (value < 0n || value > mask) throw new Error("Packed field overflow: " + variable);
  const shift = BigInt(field.offset) * 8n;
  const word = BigInt(await hre.ethers.provider.getStorage(address, BigInt(field.slot)));
  await setSlot(address, BigInt(field.slot), (word & ~(mask << shift)) | (value << shift));
}
export async function setSlot(address: string, slot: bigint | string, value: bigint) {
  await hre.network.provider.send("hardhat_setStorageAt", [
    address,
    typeof slot === "bigint" ? hre.ethers.toBeHex(slot) : slot,
    hre.ethers.toBeHex(value, 32),
  ]);
}
export function mappingSlot(account: string, slot: bigint): string {
  return hre.ethers.keccak256(hre.ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, slot]));
}

/** Read the signed persistent logarithm, without a lossy price round-trip. */
export async function poolEmaLogWad(address: string): Promise<bigint> {
  const slot = await storageSlot(POOL_CONTRACT, "_emaLogWad");
  return BigInt.asIntN(256, BigInt(await hre.ethers.provider.getStorage(address, slot)));
}
