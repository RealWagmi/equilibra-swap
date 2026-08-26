// Create + seed the pools declared in `scripts/deploy/config.ts` on an
// already-deployed core (see `core.ts`). Idempotent by pool `name`:
// entries already recorded in the deployments document are skipped, so
// re-running after adding a spec creates only the new pools.
//
//   npm run deploy:pools --network=<hardhat-network>
import hre from "hardhat";

import type { EquilibraFactory } from "../../typechain-types";

import { POOLS, PoolSpec } from "./config";
import { approveExact, networkContext, readDeployments, validateToken, writeDeployments, PoolRecord } from "./lib";

const MOCK_RE = /^mock:([A-Za-z0-9]+):(\d{1,2})$/;

async function resolveTokenSpec(
  spec: string,
  amount: bigint,
  isLocalDev: boolean,
  deployerAddress: string,
  label: string
): Promise<string> {
  const mock = MOCK_RE.exec(spec);
  if (mock) {
    if (!isLocalDev) {
      throw new Error(`${label}: mock tokens are restricted to local dev chains`);
    }
    const Token = await hre.ethers.getContractFactory("MockERC20");
    const token = await Token.deploy(mock[1], mock[1], Number(mock[2]));
    await token.waitForDeployment();
    await (await token.mint(deployerAddress, amount)).wait();
    const address = await token.getAddress();
    console.log(`  mock ${mock[1]} (${mock[2]} dec) deployed at ${address}`);
    return address;
  }
  return validateToken(spec, label);
}

async function createPool(
  factory: EquilibraFactory,
  spec: PoolSpec,
  isLocalDev: boolean,
  weth9: string,
  deployerAddress: string
): Promise<PoolRecord> {
  const amountA = BigInt(spec.amountA);
  const amountB = BigInt(spec.amountB);
  if (amountA === 0n || amountB === 0n) {
    throw new Error(`${spec.name}: seed amounts must both be greater than zero`);
  }

  const tokenA = await resolveTokenSpec(spec.tokenA, amountA, isLocalDev, deployerAddress, `${spec.name}.tokenA`);
  const tokenB = await resolveTokenSpec(spec.tokenB, amountB, isLocalDev, deployerAddress, `${spec.name}.tokenB`);
  if (tokenA === tokenB) throw new Error(`${spec.name}: tokenA and tokenB must differ`);

  const recipient = hre.ethers.getAddress(spec.lpRecipient ?? deployerAddress);
  const config = {
    aWad: BigInt(spec.config.aWad),
    lambdaWad: BigInt(spec.config.lambdaWad),
    baseFee: spec.config.baseFee,
    emaPeriod: spec.config.emaPeriod,
    repegStepWad: BigInt(spec.config.repegStepWad),
    repegThresholdToken1UpWad: BigInt(spec.config.repegThresholdToken1UpWad),
    repegThresholdToken1DownWad: BigInt(spec.config.repegThresholdToken1DownWad),
    feeRampBps: spec.config.feeRampBps,
    feeFloorBps: spec.config.feeFloorBps,
    repegShareBps: spec.config.repegShareBps,
  };

  const factoryAddress = await factory.getAddress();

  // Native-value seeding pays the WETH9 leg from attached value; the
  // other leg still needs its ERC-20 approval.
  let value = 0n;
  if (spec.nativeSeed) {
    if (tokenA === weth9) value = amountA;
    else if (tokenB === weth9) value = amountB;
    else throw new Error(`${spec.name}: nativeSeed requires one side to be WETH9 (${weth9})`);
  }
  if (tokenA !== weth9 || !spec.nativeSeed) await approveExact(tokenA, factoryAddress, amountA);
  if (tokenB !== weth9 || !spec.nativeSeed) await approveExact(tokenB, factoryAddress, amountB);

  const method = spec.isPrivate ? "createPrivatePoolAndAddLiquidity" : "createPoolAndAddLiquidity";
  const tx = await (factory as any)[method](tokenA, tokenB, config, amountA, amountB, recipient, {
    value,
  });
  const receipt = await tx.wait();

  // Resolve the pool from THIS tx's own PoolCreated log, not from an
  // allPools() index snapshotted before the tx: pool creation is
  // permissionless, so a third party's create mined in between would
  // shift the index and make us record a stranger's pool.
  let created: { pool: string; token0: string; token1: string; pairPoolIndex: number } | null = null;
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== factoryAddress.toLowerCase()) continue;
    let parsed;
    try {
      parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name === "PoolCreated") {
      created = {
        pool: parsed.args.pool as string,
        token0: parsed.args.token0 as string,
        token1: parsed.args.token1 as string,
        pairPoolIndex: Number(parsed.args.pairPoolIndex),
      };
      break;
    }
  }
  if (!created) {
    throw new Error(`${spec.name}: create succeeded but no PoolCreated log found in the receipt`);
  }
  console.log(`  pool '${spec.name}' created: ${created.pool} (pairPoolIndex ${created.pairPoolIndex})`);

  return {
    name: spec.name,
    pool: created.pool,
    token0: created.token0,
    token1: created.token1,
    pairPoolIndex: created.pairPoolIndex,
    isPrivate: Boolean(spec.isPrivate),
    txHash: receipt!.hash,
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  const { deployer, chainId, isLocalDev, networkName } = await networkContext();

  const doc = readDeployments(networkName, chainId);
  if (!doc) {
    throw new Error(
      `No deployments document for '${networkName}' — run the core deploy first (npm run deploy --network=${networkName})`
    );
  }

  const specs = POOLS[networkName] ?? [];
  const pending = specs.filter((s) => !doc.pools.some((p) => p.name === s.name));
  if (pending.length === 0) {
    console.log("Nothing to do: every configured pool is already recorded.");
    return;
  }

  const factory = await hre.ethers.getContractAt("EquilibraFactory", doc.contracts.factory);
  console.log(`Creating ${pending.length} pool(s) on factory ${doc.contracts.factory}...`);

  for (const spec of pending) {
    const record = await createPool(factory, spec, isLocalDev, doc.weth9, deployer.address);
    doc.pools.push(record);
    // Persist after EVERY pool so a mid-run failure loses nothing.
    writeDeployments(doc, chainId);
  }
  console.log("Deployments document updated.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
