// Per-network deployment configuration — the single reviewed source for
// everything that is NOT a secret. `.env` keeps only credentials
// (DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY, optional *_RPC_URL
// overrides); every address and pool parameter lives here, under git
// review.
//
// Pool parameters have NO silent defaults on purpose: pool creation is
// permissionless and the initial price is economically significant, so
// every spec below must be an explicitly reviewed snapshot (normally
// copied from `simulator/src/app/config.rs::build_default_config`, the
// canonical preset source).

export interface CoreDeployConfig {
  /// Canonical wrapped-native token for the chain. The sentinel
  /// "mock" deploys MockWETH9 and is accepted ONLY on local dev
  /// chains (in-process hardhat / chainId 1337 / 31337).
  weth9: string;
  /// Protocol fee recipient. The sentinel "deployer" resolves to the
  /// deploying signer.
  feeCollector: string;
  /// Protocol slice of every swap fee, in PERCENT (not bps), range
  /// [0, 25]. Set at construction because pools SNAPSHOT the live
  /// value at creation — a post-deploy setter call would leave a
  /// window where pools lock in a zero protocol share forever.
  protocolFeePercent: number;
  /// Run `verify:verify` for every deployed contract (skipped
  /// automatically on local dev chains).
  verify: boolean;
}

export interface PoolSpec {
  /// Unique human-readable key; the pools script is idempotent by this
  /// name (a name already present in the deployments document is
  /// skipped).
  name: string;
  /// Token addresses in any order (the factory sorts internally). On
  /// local dev chains the sentinel "mock:<SYMBOL>:<decimals>" deploys
  /// and mints a fresh MockERC20 — rejected on real networks.
  tokenA: string;
  tokenB: string;
  /// Raw-unit seed amounts as decimal strings, paired with
  /// tokenA/tokenB as written (re-paired automatically by the sort).
  amountA: string;
  amountB: string;
  /// Pay the WETH9 side of the seed with attached native value
  /// (requires one side to be the chain's WETH9; msg.value must equal
  /// that side's amount exactly, which this script guarantees).
  nativeSeed?: boolean;
  /// LP recipient; defaults to the deployer.
  lpRecipient?: string;
  /// Create as a private (mint-allowlisted) pool.
  isPrivate?: boolean;
  config: {
    aWad: string;
    lambdaWad: string;
    baseFee: number;
    emaPeriod: number;
    repegStepWad: string;
    repegThresholdToken1UpWad: string;
    repegThresholdToken1DownWad: string;
    feeRampBps: number;
    feeFloorBps: number;
    repegShareBps: number;
  };
}

export const CORE: Record<string, CoreDeployConfig> = {
  // In-process dev chain (fresh per invocation; nothing persisted).
  hardhat: {
    weth9: "mock",
    feeCollector: "deployer",
    protocolFeePercent: 5,
    verify: false,
  },
  // `npx hardhat node` on this machine.
  localhost: {
    weth9: "mock",
    feeCollector: "deployer",
    protocolFeePercent: 5,
    verify: false,
  },
  robinhoodTestnet: {
    // Fill with the canonical wrapped-native address of the testnet
    // before deploying — the script refuses "mock" outside local dev.
    weth9: "",
    feeCollector: "deployer",
    protocolFeePercent: 5,
    verify: true,
  },
  robinhood: {
    weth9: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    feeCollector: "0x9c4180d67E7121D6A150eFc6b9502965Bf7BB207",
    protocolFeePercent: 5,
    verify: true,
  },
};

// Declarative pool list per network. The pools script creates every
// entry that is not yet recorded in `deployments/<network>.json`.
//
// The commented example is an explicit snapshot of the WETH benchmark
// preset — review `build_default_config` in
// `simulator/src/app/config.rs` before production use.
export const POOLS: Record<string, PoolSpec[]> = {
  hardhat: [],
  localhost: [
    {
      name: "smoke-weth-usd",
      tokenA: "mock:WETHx:18",
      tokenB: "mock:USDx:6",
      amountA: "10000000000000000000", // 10 WETHx
      amountB: "40000000000", // 40,000 USDx (6 dec)
      config: {
        aWad: "909610000000000030",
        lambdaWad: "16780000000000000",
        baseFee: 282,
        emaPeriod: 600,
        repegStepWad: "5000000000000000",
        repegThresholdToken1UpWad: "2500000000000000",
        repegThresholdToken1DownWad: "1500000000000000",
        feeRampBps: 5000,
        feeFloorBps: 136,
        repegShareBps: 7000,
      },
    },
  ],
  robinhoodTestnet: [
    // {
    //   name: "weth-usdc-0",
    //   tokenA: "<WETH9 address>",
    //   tokenB: "<USDC address>",
    //   amountA: "<wei of tokenA>",
    //   amountB: "<raw units of tokenB>",
    //   nativeSeed: true,
    //   config: {
    //     aWad: "909610000000000030",
    //     lambdaWad: "16780000000000000",
    //     baseFee: 282,
    //     emaPeriod: 600,
    //     repegStepWad: "5000000000000000",
    //     repegThresholdToken1UpWad: "2500000000000000",
    //     repegThresholdToken1DownWad: "1500000000000000",
    //     feeRampBps: 5000,
    //     feeFloorBps: 136,
    //     repegShareBps: 7000,
    //   },
    // },
  ],
  robinhood: [],
};
