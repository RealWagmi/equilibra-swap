// Re-run source verification for an already-deployed core from the
// deployments document. Safe to repeat — already-verified contracts are
// reported and skipped. Useful when the explorer API flaked during the
// core deploy (the deploy never fails on verification errors).
//
//   npm run deploy:verify --network=<hardhat-network>
import { networkContext, readDeployments, verifyCoreFromDoc } from "./lib";

async function main() {
  const { chainId, isLocalDev, networkName } = await networkContext();
  if (isLocalDev) {
    console.log("Local dev chain — nothing to verify.");
    return;
  }
  const doc = readDeployments(networkName, chainId);
  if (!doc) {
    throw new Error(`No deployments document for '${networkName}' — run the core deploy first.`);
  }
  await verifyCoreFromDoc(doc);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
