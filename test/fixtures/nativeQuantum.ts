import hre from "hardhat";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MaxUint256 } from "ethers";
import { storageSlot, setSlot, mappingSlot, POOL_CONTRACT, TOKEN_CONTRACT } from "../helpers/storageLayout";

const WAD = 10n ** 18n;
/** Historical precision regression parameters, not a preset. */
export const PRECISION_CONFIG = {
  aWad: WAD / 10n,
  lambdaWad: 10n ** 15n,
  baseFee: 5,
  feeFloorBps: 0,
  feeRampBps: 0,
  emaPeriod: 600,
  repegShareBps: 0,
  repegStepWad: 10n ** 15n,
  repegThresholdToken1UpWad: 10n ** 14n,
  repegThresholdToken1DownWad: 10n ** 14n,
};

/** Public factory + production implementation; no reserve or storage overrides. */
export async function deployNativeQuantumFixture(
  options: {
    decimals?: [number, number];
    seedRatio?: [bigint, bigint];
    seedAmountsRaw?: [bigint, bigint];
    initialSwap?: boolean;
    isPrivate?: boolean;
    protocol?: number;
    poolConfig?: Partial<typeof PRECISION_CONFIG>;
  } = {}
) {
  const [owner] = await hre.ethers.getSigners();
  const impl = await (await hre.ethers.getContractFactory("EquilibraPool")).deploy();
  await impl.waitForDeployment();
  const factory = await (
    await hre.ethers.getContractFactory("EquilibraFactory")
  ).deploy(await impl.getAddress(), owner.address, owner.address, options.protocol ?? 0);
  await factory.waitForDeployment();
  const trader = await (await hre.ethers.getContractFactory("MockSwapCallbackTrader")).deploy();
  await trader.waitForDeployment();
  const Token = await hre.ethers.getContractFactory("MockERC20");
  const decimals = options.decimals ?? [18, 18];
  const seedRatio = options.seedRatio ?? [1n, 1n];
  // Assign decimals to canonical token order without trial redeployments.
  const nonce = await owner.getNonce();
  const firstIs0 =
    BigInt(hre.ethers.getCreateAddress({ from: owner.address, nonce })) <
    BigInt(hre.ethers.getCreateAddress({ from: owner.address, nonce: nonce + 1 }));
  const tokens = [
    await Token.deploy("First", "FIRST", decimals[firstIs0 ? 0 : 1]),
    await Token.deploy("Second", "SECOND", decimals[firstIs0 ? 1 : 0]),
  ];
  for (const token of tokens) await token.waitForDeployment();
  tokens.sort((a, b) => (BigInt(a.target.toString()) < BigInt(b.target.toString()) ? -1 : 1));
  const units = await Promise.all(tokens.map(async (token) => 10n ** BigInt(await token.decimals())));
  const seedAmounts = options.seedAmountsRaw ?? seedRatio.map((ratio, i) => ratio * units[i]);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    await token.mint(owner.address, 4n * seedAmounts[i]);
    await token.mint(await trader.getAddress(), units[i]);
    await token.approve(await factory.getAddress(), MaxUint256);
  }
  const create = options.isPrivate ? factory.createPrivatePoolAndAddLiquidity : factory.createPoolAndAddLiquidity;
  await create(
    await tokens[0].getAddress(),
    await tokens[1].getAddress(),
    { ...PRECISION_CONFIG, ...options.poolConfig },
    seedAmounts[0],
    seedAmounts[1],
    owner.address
  );
  const pool = await hre.ethers.getContractAt("EquilibraPool", await factory.allPools(0));
  if (options.initialSwap !== false)
    await trader.executeSwap(await pool.getAddress(), owner.address, true, seedAmounts[0] / 10n, 0);
  return { owner, impl, factory, trader, pool, tokens, units };
}

export const LP_REPAIR_CASES = [
  "exact-in",
  "exact-out",
  "zero-output",
  "lp-decrease",
  "exact-out-fraction",
  "exact-out-fee",
  "exact-out-lp-decrease",
] as const;
export type RepairCase = (typeof LP_REPAIR_CASES)[number];

/** Native exact-out fee gross-up, independent of the counterpart solver. */
export function exactOutSettlement(clean: bigint, baseFee = PRECISION_CONFIG.baseFee, protocol = 25) {
  let input = ((clean - 1n) * 10000n) / (10000n - BigInt(baseFee)) + 1n;
  if (input === clean && baseFee !== 0) input += 1n;
  input += 1n;
  const fee = input - clean;
  return { input, fee, cut: (fee * BigInt(protocol)) / 100n };
}

/** Fixed synthetic LP-rounding witnesses, separate from canonical market presets. */
export async function deployLpRepairFixture(kind: RepairCase, zeroForOne: boolean) {
  const records = JSON.parse(
    readFileSync(path.join(__dirname, "../../simulator/tests/fixtures/equilibra-lp-repair.json"), "utf8")
  );
  const row = records[kind];
  const aWad = BigInt(row.aWad),
    lambdaWad = BigInt(row.lambdaWad);
  const reserveIn = BigInt(row.reserveIn),
    reserveOut = BigInt(row.reserveOut);
  const amount = BigInt(row.amount),
    raw = BigInt(row.raw),
    expected = BigInt(row.expected);
  const exactOut: boolean = row.exactOut;
  const error: string | undefined = row.error ?? undefined;
  const f = await deployNativeQuantumFixture({ initialSwap: false, protocol: 25, poolConfig: { aWad, lambdaWad } });
  const reserves = zeroForOne ? [reserveIn, reserveOut] : [reserveOut, reserveIn];
  await setNativeReserves(f, reserves);
  return { ...f, witness: { aWad, lambdaWad, reserveIn, reserveOut, amount, raw, expected, exactOut, error } };
}

/** Construct a synthetic state without desynchronizing ERC20 balances or total supply. */
export async function setNativeReserves(f: Awaited<ReturnType<typeof deployNativeQuantumFixture>>, reserves: bigint[]) {
  const address = await f.pool.getAddress();
  await setSlot(address, await storageSlot(POOL_CONTRACT, "_reservesPacked"), reserves[0] | (reserves[1] << 128n));
  const balances = await storageSlot(TOKEN_CONTRACT, "_balances");
  for (let i = 0; i < 2; i++) {
    const token = await f.tokens[i].getAddress();
    const delta = reserves[i] - (await f.tokens[i].balanceOf(address));
    const ownerBalance = await f.tokens[i].balanceOf(f.owner.address);
    await setSlot(token, mappingSlot(address, balances), reserves[i]);
    await setSlot(token, mappingSlot(f.owner.address, balances), ownerBalance - delta);
  }
}
