import hre from "hardhat";
import { deployNativeQuantumFixture } from "./nativeQuantum";

export async function deployNativeRouterFixture(options: Parameters<typeof deployNativeQuantumFixture>[0] = {}) {
  const f = await deployNativeQuantumFixture(options);
  const weth = await (await hre.ethers.getContractFactory("MockWETH9")).deploy();
  await weth.waitForDeployment();
  const router = await (
    await hre.ethers.getContractFactory("EquilibraRouter")
  ).deploy(f.factory.target, f.impl.target, weth.target);
  await router.waitForDeployment();
  for (const token of f.tokens) await token.approve(router.target, hre.ethers.MaxUint256);
  return { ...f, router };
}
