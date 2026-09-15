// Shared helpers for the deploy scripts: environment probes, the
// git-tracked deployments document, and verification.
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import hre from "hardhat";

import { CORE, CoreDeployConfig } from "./config";

export const LOCAL_CHAIN_IDS = new Set([1337n, 31337n]);

export interface PoolRecord {
  name: string;
  pool: string;
  token0: string;
  token1: string;
  pairPoolIndex: number;
  isPrivate: boolean;
  txHash: string;
  createdAt: string;
}

export interface DeploymentsDoc {
  schema: "equilibra-deployments/v2";
  network: string;
  chainId: string;
  commit: string;
  deployedAt: string;
  deployer: string;
  feeCollector: string;
  protocolFeePercent: number;
  weth9: string;
  contracts: {
    poolImplementation: string;
    factory: string;
    paramTimelock: string;
    router: string;
  };
  pools: PoolRecord[];
}

export async function networkContext() {
  const [deployer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  // `localhost` is this machine's own `hardhat node` by definition —
  // the repo's config pins its chainId to 1 for the test suite, so the
  // name, not the id, is the local-dev marker there.
  const isLocalDev = hre.network.name === "hardhat" || hre.network.name === "localhost" || LOCAL_CHAIN_IDS.has(chainId);
  return { deployer, chainId, isLocalDev, networkName: hre.network.name };
}

export function coreConfig(networkName: string): CoreDeployConfig {
  const cfg = CORE[networkName];
  if (!cfg) {
    throw new Error(`No deploy config for network '${networkName}' — add it to scripts/deploy/config.ts`);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Target-chain probes (fail before spending gas on incompatible chains).
// ---------------------------------------------------------------------------

export async function assertCancunSupport(): Promise<void> {
  // Creation-call bytecode executes TSTORE(0,1), TLOAD(0), then returns
  // the loaded word. Pre-Cancun RPCs reject opcode 0x5d/0x5c.
  const probe = "0x600160005d60005c60005260206000f3";
  try {
    const result = await hre.ethers.provider.call({ data: probe });
    if (BigInt(result) !== 1n) throw new Error(`unexpected probe result ${result}`);
  } catch (error) {
    throw new Error(
      `The target RPC does not execute Cancun transient-storage opcodes required by EquilibraSwap: ${String(error)}`
    );
  }
}

export async function probeWeth9(address: string, caller: string): Promise<void> {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`WETH9 ${address} has no code`);

  const iface = new hre.ethers.Interface([
    "function balanceOf(address) view returns (uint256)",
    "function deposit() payable",
    "function withdraw(uint256)",
  ]);
  try {
    const balanceResult = await hre.ethers.provider.call({
      to: address,
      from: caller,
      data: iface.encodeFunctionData("balanceOf", [caller]),
    });
    iface.decodeFunctionResult("balanceOf", balanceResult);
    await hre.ethers.provider.call({
      to: address,
      from: caller,
      data: iface.encodeFunctionData("deposit"),
      value: 0n,
    });
    await hre.ethers.provider.call({
      to: address,
      from: caller,
      data: iface.encodeFunctionData("withdraw", [0n]),
    });
  } catch (error) {
    throw new Error(`WETH9 compatibility probe failed for ${address}: ${String(error)}`);
  }
}

export async function validateToken(addressRaw: string, label: string): Promise<string> {
  const address = hre.ethers.getAddress(addressRaw);
  if ((await hre.ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} ${address} has no code`);
  }
  return address;
}

export async function approveExact(tokenAddress: string, spender: string, amount: bigint): Promise<void> {
  const [deployer] = await hre.ethers.getSigners();
  const token = new hre.ethers.Contract(
    tokenAddress,
    ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256)"],
    deployer
  );
  const current: bigint = await token.allowance(deployer.address, spender);
  if (current >= amount) return;
  // Supports tokens such as USDT that require allowance to be zero first.
  if (current !== 0n) await (await token.approve(spender, 0n)).wait();
  await (await token.approve(spender, amount)).wait();
}

// ---------------------------------------------------------------------------
// Deployments document (git-tracked for real networks).
// ---------------------------------------------------------------------------

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");

export function deploymentsPath(networkName: string, chainId: bigint): string {
  // Local dev chains write next to the tracked files but stay
  // gitignored (`deployments/local-*.json`); the in-process network is
  // ephemeral, yet the file is still useful within a `hardhat node`
  // session. Same local-dev rule as `networkContext`.
  const name =
    networkName === "hardhat" || networkName === "localhost" || LOCAL_CHAIN_IDS.has(chainId)
      ? `local-${chainId}`
      : networkName;
  return path.join(DEPLOYMENTS_DIR, `${name}.json`);
}

export function readDeployments(networkName: string, chainId: bigint): DeploymentsDoc | null {
  const p = deploymentsPath(networkName, chainId);
  if (!fs.existsSync(p)) return null;
  const doc = JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentsDoc;
  if (doc.schema !== "equilibra-deployments/v2") {
    throw new Error(`${p}: unsupported schema '${(doc as { schema?: string }).schema}'`);
  }
  if (doc.chainId !== chainId.toString()) {
    throw new Error(`${p}: chainId mismatch (doc ${doc.chainId}, rpc ${chainId})`);
  }
  return doc;
}

export function writeDeployments(doc: DeploymentsDoc, chainId: bigint): string {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const p = deploymentsPath(doc.network, chainId);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  return p;
}

export function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Verification. Two independent channels, both non-fatal:
//
//   1. Sourcify — canonical source verification, keyless and unmetered.
//      It is a record in Sourcify's own repository: explorers do not
//      import it on their own, so it never publishes sources on a
//      contract page by itself.
//   2. The explorer's Etherscan-compatible API through hardhat-verify —
//      this is what publishes browsable sources and the Read/Write tabs.
//
// Hosted Blockscout instances may refuse scripted clients outright
// (Cloudflare challenge on Robinhood, per IP, extended by every request
// made while blocked). When that happens the plugin fails fast here and
// `npm run deploy:verify-inputs` writes the exact standard JSON inputs plus
// `artifacts/verify-inputs/<network>/verify.html`, whose pre-filled forms a
// browser submits itself; that is the path that verified the Robinhood
// deployment. A Blockscout 500 page in reply to such a form still means
// the job was accepted (the contract verifies about a minute later).
// ---------------------------------------------------------------------------

const SOURCIFY_SERVER = "https://sourcify.dev/server";
const SOURCIFY_POLL_MS = 4_000;
const SOURCIFY_POLL_ATTEMPTS = 45;

export async function verifyOnSourcify(
  label: string,
  address: string,
  contract: string,
  chainId: string
): Promise<void> {
  try {
    const existing = (await (await fetch(`${SOURCIFY_SERVER}/v2/contract/${chainId}/${address}`)).json()) as {
      match?: string;
    };
    if (existing.match) {
      console.log(`sourcify: ${label} already verified (${existing.match})`);
      return;
    }

    const buildInfo = await hre.artifacts.getBuildInfo(contract);
    if (!buildInfo) throw new Error(`no build info for ${contract} — compile first`);

    const submit = await fetch(`${SOURCIFY_SERVER}/v2/verify/${chainId}/${address}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stdJsonInput: buildInfo.input,
        compilerVersion: buildInfo.solcLongVersion,
        contractIdentifier: contract,
      }),
    });
    const job = (await submit.json()) as { verificationId?: string; customCode?: string; message?: string };
    if (!job.verificationId) {
      console.error(`sourcify: ${label} rejected (HTTP ${submit.status}): ${job.customCode ?? job.message ?? ""}`);
      return;
    }

    for (let i = 0; i < SOURCIFY_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, SOURCIFY_POLL_MS));
      const status = (await (await fetch(`${SOURCIFY_SERVER}/v2/verify/${job.verificationId}`)).json()) as {
        isJobCompleted?: boolean;
        error?: { customCode?: string; message?: string };
        contract?: { creationMatch?: string | null; runtimeMatch?: string | null };
      };
      if (!status.isJobCompleted) continue;
      if (status.error) {
        console.error(`sourcify: ${label} failed: ${status.error.customCode ?? status.error.message ?? ""}`);
        return;
      }
      const { creationMatch, runtimeMatch } = status.contract ?? {};
      console.log(`sourcify: ${label} creation=${creationMatch ?? "none"} runtime=${runtimeMatch ?? "none"}`);
      return;
    }
    console.error(`sourcify: ${label} still pending after ${SOURCIFY_POLL_ATTEMPTS} polls`);
  } catch (error) {
    console.error(`sourcify: ${label} @ ${address} errored: ${String(error)}`);
  }
}

/// Trim a standard JSON input to the transitive import closure of one
/// source, so the explorer compiles (and lists) only what the contract
/// needs instead of every file of the build, mocks included. Imports are
/// resolved the way solc does for this project: relative paths against the
/// importing file, everything else as a direct key of `sources`. Falls back
/// to the full input if any import cannot be located.
export function minimalStandardJsonInput<T extends { sources: Record<string, { content: string }> }>(
  input: T,
  sourceName: string
): T {
  const seen = new Set<string>();
  const stack = [sourceName];
  const importRe = /import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']\s*;/g;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    const entry = input.sources[current];
    if (!entry) return input;
    seen.add(current);
    for (const match of entry.content.matchAll(importRe)) {
      const target = match[1];
      stack.push(
        target.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(current), target)) : target
      );
    }
  }
  const sources: Record<string, { content: string }> = {};
  for (const name of Object.keys(input.sources).sort()) {
    if (seen.has(name)) sources[name] = input.sources[name];
  }
  return { ...input, sources };
}

/// ABI-encode constructor arguments from the artifact's constructor
/// signature; hex without the 0x prefix, empty when there is no
/// constructor input.
export async function encodeConstructorArgs(contract: string, constructorArguments: unknown[]): Promise<string> {
  const artifact = await hre.artifacts.readArtifact(contract);
  const inputs = (artifact.abi as Array<{ type: string; inputs?: unknown[] }>).find((f) => f.type === "constructor")
    ?.inputs as Array<Record<string, unknown>> | undefined;
  if (!inputs || inputs.length === 0) return "";
  return hre.ethers.AbiCoder.defaultAbiCoder()
    .encode(
      inputs.map((i) => hre.ethers.ParamType.from(i)),
      constructorArguments
    )
    .slice(2);
}

export type VerifyTarget = [label: string, address: string, constructorArguments: unknown[], contract: string];

/// The four core contracts of a deployment in verification order.
export function coreVerifyTargets(doc: DeploymentsDoc): VerifyTarget[] {
  const c = doc.contracts;
  return [
    ["EquilibraPool (implementation)", c.poolImplementation, [], "contracts/EquilibraPool.sol:EquilibraPool"],
    [
      "EquilibraFactory",
      c.factory,
      [c.poolImplementation, doc.feeCollector, doc.weth9, doc.protocolFeePercent],
      "contracts/EquilibraFactory.sol:EquilibraFactory",
    ],
    // Deployed from the factory constructor — no constructor arguments.
    ["EquilibraParamTimelock", c.paramTimelock, [], "contracts/EquilibraParamTimelock.sol:EquilibraParamTimelock"],
    [
      "EquilibraRouter",
      c.router,
      [c.factory, c.poolImplementation, doc.weth9],
      "contracts/periphery/EquilibraRouter.sol:EquilibraRouter",
    ],
  ];
}

/// Explorer endpoints of the network from `etherscan.customChains` in
/// hardhat.config.ts, so the browser page targets the same instance as
/// hardhat-verify.
export function explorerUrls(networkName: string): { apiURL: string; browserURL: string } | null {
  const cfg = (
    hre.config as unknown as {
      etherscan?: { customChains?: Array<{ network: string; urls: { apiURL: string; browserURL: string } }> };
    }
  ).etherscan;
  const chain = cfg?.customChains?.find((c) => c.network === networkName);
  return chain ? { apiURL: chain.urls.apiURL, browserURL: chain.urls.browserURL } : null;
}

export async function verifyContract(
  label: string,
  address: string,
  constructorArguments: unknown[],
  contract?: string
): Promise<void> {
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log(`verified: ${label} @ ${address}`);
  } catch (error) {
    const msg = String(error);
    if (/already.{0,10}verified/i.test(msg)) {
      console.log(`already verified: ${label} @ ${address}`);
      return;
    }
    // Verification failures must not strand a completed deployment:
    // the addresses are already persisted, and `npm run deploy:verify`
    // re-runs this step from the document.
    console.error(`VERIFY FAILED for ${label} @ ${address}: ${msg}`);
    if (/Just a moment|Unexpected token '<'|is not valid JSON|429/i.test(msg)) {
      console.error(
        "The explorer is refusing scripted clients (Cloudflare challenge or rate limit). " +
          "Run `npm run deploy:verify-inputs --network=<network>` and submit artifacts/verify-inputs/<network>/verify.html from a browser."
      );
    }
  }
}

const VERIFY_PACING_MS = 15_000;

export async function verifyCoreFromDoc(doc: DeploymentsDoc): Promise<void> {
  const targets = coreVerifyTargets(doc);
  // Hosted explorers rate-limit heavy verification submissions; pace them.
  const pace = () => new Promise((r) => setTimeout(r, VERIFY_PACING_MS));
  for (const [label, address, constructorArguments, contract] of targets) {
    await verifyOnSourcify(label, address, contract, doc.chainId);
    await verifyContract(label, address, constructorArguments, contract);
    await pace();
  }
}
