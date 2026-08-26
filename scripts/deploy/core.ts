// Deploy the core contracts (pool implementation, factory + its
// paramTimelock, router), verify them, and persist the addresses to the
// git-tracked deployments document. Pool creation is a separate step —
// see `create-pool.ts`.
//
//   npm run deploy --network=<hardhat-network>
//
// Network parameters (WETH9, fee collector, verification switch) come
// from `scripts/deploy/config.ts`; `.env` holds only credentials.
import hre from "hardhat";

import {
  assertCancunSupport,
  coreConfig,
  gitCommit,
  networkContext,
  probeWeth9,
  readDeployments,
  verifyCoreFromDoc,
  writeDeployments,
  DeploymentsDoc,
} from "./lib";

async function resolveWeth9(
  configured: string,
  isLocalDev: boolean,
  chainId: bigint,
  deployerAddress: string
): Promise<string> {
  if (configured === "mock") {
    if (!isLocalDev) {
      throw new Error(
        `weth9: "mock" is restricted to local dev chains; chainId ${chainId} needs the canonical wrapped-native address in scripts/deploy/config.ts`
      );
    }
    const Mock = await hre.ethers.getContractFactory("MockWETH9");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    const address = await mock.getAddress();
    await probeWeth9(address, deployerAddress);
    console.log(`MockWETH9 deployed at ${address} (local chainId ${chainId})`);
    return address;
  }
  if (configured === "") {
    throw new Error(`weth9 is not set for network '${hre.network.name}' — fill scripts/deploy/config.ts`);
  }
  const address = hre.ethers.getAddress(configured);
  await probeWeth9(address, deployerAddress);
  console.log("Using external WETH9:", address);
  return address;
}

async function main() {
  const { deployer, chainId, isLocalDev, networkName } = await networkContext();
  const cfg = coreConfig(networkName);

  const existing = readDeployments(networkName, chainId);
  if (existing) {
    throw new Error(
      `Deployments document already exists for '${networkName}' (factory ${existing.contracts.factory}). ` +
        `Core contracts are immutable once live — delete the document only if you intend a full redeploy.`
    );
  }

  const feeCollector = cfg.feeCollector === "deployer" ? deployer.address : hre.ethers.getAddress(cfg.feeCollector);
  if (!Number.isInteger(cfg.protocolFeePercent) || cfg.protocolFeePercent < 0 || cfg.protocolFeePercent > 25) {
    throw new Error(`protocolFeePercent must be an integer in [0, 25], got ${cfg.protocolFeePercent}`);
  }

  console.log("Network:", networkName, `(chainId ${chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Fee collector:", feeCollector);
  console.log("Protocol fee:", `${cfg.protocolFeePercent}% of every swap fee`);

  // Fail before deploying when the target EVM or the immutable
  // wrapped-native dependency is incompatible.
  await assertCancunSupport();
  const weth9 = await resolveWeth9(cfg.weth9, isLocalDev, chainId, deployer.address);

  const PoolImpl = await hre.ethers.getContractFactory("EquilibraPool");
  const poolImplementation = await PoolImpl.deploy();
  await poolImplementation.waitForDeployment();
  console.log("EquilibraPool implementation:", await poolImplementation.getAddress());

  const Factory = await hre.ethers.getContractFactory("EquilibraFactory");
  const factory = await Factory.deploy(
    await poolImplementation.getAddress(),
    feeCollector,
    weth9,
    cfg.protocolFeePercent
  );
  await factory.waitForDeployment();
  console.log("EquilibraFactory:", await factory.getAddress());
  const paramTimelock = await factory.paramTimelock();
  console.log("EquilibraParamTimelock:", paramTimelock);

  const Router = await hre.ethers.getContractFactory("EquilibraRouter");
  const router = await Router.deploy(await factory.getAddress(), await poolImplementation.getAddress(), weth9);
  await router.waitForDeployment();
  console.log("EquilibraRouter:", await router.getAddress());

  const doc: DeploymentsDoc = {
    schema: "equilibra-deployments/v2",
    network: networkName,
    chainId: chainId.toString(),
    commit: gitCommit(),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    feeCollector,
    protocolFeePercent: cfg.protocolFeePercent,
    weth9,
    contracts: {
      poolImplementation: await poolImplementation.getAddress(),
      factory: await factory.getAddress(),
      paramTimelock,
      router: await router.getAddress(),
    },
    pools: [],
  };

  if (networkName === "hardhat") {
    // The in-process chain evaporates with the process — print the
    // document instead of persisting a dead address book.
    console.log("Ephemeral network — deployments document not written:");
    console.log(JSON.stringify(doc, null, 2));
  } else {
    const p = writeDeployments(doc, chainId);
    console.log("Deployments document written:", p);
  }

  if (cfg.verify && !isLocalDev) {
    // Explorers index freshly deployed bytecode with a lag; verifying
    // immediately often fails with "does not have bytecode".
    console.log("Waiting 30 s for the explorer to index the deployments...");
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    console.log("Verifying contracts...");
    await verifyCoreFromDoc(doc);
  } else {
    console.log("Verification skipped (local dev chain or disabled in config).");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
