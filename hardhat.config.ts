import { HardhatUserConfig, subtask } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { TASK_COMPILE_SOLIDITY_CHECK_ERRORS } from "hardhat/builtin-tasks/task-names";
import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

// Solady (pragma floor ^0.8.4) still uses the NatSpec
// `memory-safe-assembly` comments and identifiers that solc 0.8.31+
// flags with 0.9.0 deprecation warnings — ~250 per compile, none
// actionable in this repo. Filter the compiler diagnostics before
// Hardhat prints them: drop warnings originating in solady sources,
// plus solc's location-less ">256 warnings" cap notice (code 4591),
// which only ever fires on that suppressed flood. Errors of any
// severity and warnings from contracts/ pass through untouched.
subtask(TASK_COMPILE_SOLIDITY_CHECK_ERRORS, async (args: any, _hre, runSuper) => {
  const errors = args?.output?.errors;
  if (Array.isArray(errors)) {
    args.output.errors = errors.filter((e) => {
      if (e.severity !== "warning") return true;
      if (e.sourceLocation?.file?.startsWith("solady/")) return false;
      return e.errorCode !== "4591";
    });
  }
  return runSuper(args);
});

// Coverage runs compile through the legacy (non-viaIR) codegen so that
// solidity-coverage's per-statement hit counts stay accurate (the plugin
// CAN instrument viaIR builds since 0.8.7, but the optimizer then merges
// and reorders statements, distorting the counts — and coverage of the
// optimized IR is not what we want to measure anyway). `npm run coverage`
// sets SOLIDITY_COVERAGE=true; the argv check covers a bare
// `npx hardhat coverage` so both entry points get the same pipeline.
const isCoverage = process.env.SOLIDITY_COVERAGE === "true" || process.argv.includes("coverage");
// Normalise the env var so the bare-argv entry point behaves exactly like
// `npm run coverage` for every downstream consumer (the solidity-coverage
// plugin's own extendConfig hook and the coverage-aware test timeouts).
if (isCoverage) process.env.SOLIDITY_COVERAGE = "true";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      // Main project contracts (EquilibraSwap)
      {
        version: "0.8.36",
        settings: {
          // The pool bytecode hovers near the 24 KB Spurious Dragon
          // limit. `runs = 2000` is the measured operating point: vs
          // the historical 9999 it frees ~1.2 KB of EIP-170 headroom
          // for +278 gas on an `exactInputSingle` (~0.2%) — headroom
          // the donation parachute + active-share accounting spend.
          // Coverage builds flip to `runs = 1`: coverage measures hit
          // counts, not gas, and the size-optimised legacy build keeps
          // the un-instrumented pool under the limit.
          optimizer: { enabled: true, runs: isCoverage ? 1 : 2000 },
          // Keep the CBOR metadata tail (53 bytes: ipfs hash + solc
          // version): explorers and hardhat-verify infer the compiler
          // version from it, and Sourcify "perfect match" needs the
          // embedded hash. The pool's EIP-170 headroom absorbs the 53
          // bytes (see test/security/BytecodeSize.test.ts).
          metadata: { appendCBOR: true },
          evmVersion: "cancun",
          // Coverage flips to the legacy codegen (see `isCoverage`
          // above), so every contract must stay within the 16-slot
          // stack limit on BOTH pipelines.
          viaIR: !isCoverage,
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    artifacts: "./artifacts",
    cache: "./cache",
  },
  // Test-only access to internal pool helpers is provided by
  // `contracts/mocks/MockEquilibraPool.sol` instead of the broader
  // `hardhat-exposed` plugin. The mock subclasses `EquilibraPool` and
  // re-exposes only the hand-picked `internal` helpers exercised by
  // `test/security/RepegProfitShare.test.ts`, keeping the deployable
  // implementation bytecode comfortably below the Spurious Dragon
  // 24 KB limit even as more `internal` logic lands in the pool.
  gasReporter: {
    enabled: true,
    excludeContracts: [
      "MockERC20",
      "BlueprintDeployer",
      "StatefulKernelHarness",
      "MockMintCallbackProvider",
      "MockSwapCallbackTrader",
      "MockUnderpayingMintProvider",
      "MockWETH9",
      "MockEquilibraPool",
      "MockSymbolBytes32",
      "MockSymbolNone",
      "MockSymbolString",
    ],
  },
  mocha: { timeout: 120000 },
  networks: {
    hardhat: {
      //hardfork: "istanbul",
      // Coverage-only pin: on hardforks >= osaka solidity-coverage caps
      // per-transaction gas at 2^24 (EIP-7825), and the instrumented,
      // optimizer-off MockEquilibraPool deploy (~78.6 KB runtime) needs
      // more than that. Pinning the chain to the compiler's own EVM
      // target ("cancun") restores the plugin's unlimited tx gas so the
      // mock fixtures (RepegProfitShare / RepegConservation /
      // GeometricMirrorInvariance) can deploy. Production/test runs keep
      // Hardhat's default hardfork.
      ...(isCoverage ? { hardfork: "cancun" } : {}),
      chainId: 1,
      allowBlocksWithSameTimestamp: false,
      // The in-process test network lifts EIP-170 unconditionally:
      // MockEquilibraPool (the internals-exposing test subclass) and
      // the legacy (non-viaIR) coverage build of EquilibraPool both
      // exceed the cap, and neither is ever a deployment artifact.
      // The PRODUCTION pool's deployability is pinned by an explicit
      // artifact-size assertion instead
      // (test/security/BytecodeSize.test.ts), which is a stronger
      // guarantee than network-level enforcement — it measures the
      // exact viaIR build that ships.
      allowUnlimitedContractSize: true,
      blockGasLimit: 15000000,
      gas: 15000000,
      gasPrice: "auto",
      loggingEnabled: false,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 5,
        accountsBalance: "1000000000000000000000000000000000",
        passphrase: "",
      },
    },
    // Live deploy targets (Arbitrum Nitro L2, ETH gas token). `accounts`
    // degrades to an empty list when DEPLOYER_PRIVATE_KEY is unset so
    // the config stays loadable for local test runs; the public RPC
    // URLs are overridable for keyed endpoints.
    robinhood: {
      url: process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Blockscout speaks the Etherscan-compatible API; hardhat-verify
    // requires a non-empty key per network, Blockscout ignores it.
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY ?? "",
      // Hosted Blockscout rate-limits its Etherscan-compatible /api
      // aggressively, per instance host. A Blockscout account key meters
      // the central gateway (api.blockscout.com/<chainId>/api) and does
      // not raise an instance's own limit, so verification runs still
      // have to be paced. "empty" is the accepted no-key placeholder.
      robinhood: process.env.BLOCKSCOUT_API_KEY ?? "empty",
      robinhoodTestnet: process.env.BLOCKSCOUT_API_KEY ?? "empty",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          // Verification writes must go to the chain's own Blockscout
          // instance; the central gateway (api.blockscout.com/4663/api,
          // where the account API key applies) serves reads only and
          // answers 500 on unverified addresses.
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
    ],
  },
  // The plugin's Sourcify step answers with an HTML page here, which
  // surfaces as a JSON-parse error on every verify run. Sourcify itself
  // supports the target chains, so `scripts/deploy/lib.ts` submits to
  // its v2 API directly instead of going through the plugin.
  sourcify: {
    enabled: false,
  },
};

export default config;
