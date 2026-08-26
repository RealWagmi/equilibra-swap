# Deployments

One JSON document per network (`<network>.json`,
`equilibra-deployments/v2`): chain id, deploying commit, core contract
addresses (pool implementation, factory, param timelock, router, WETH9)
and every pool created through `npm run deploy:pools`, appended
incrementally. Written by `scripts/deploy/core.ts` /
`scripts/deploy/create-pool.ts`; consumed by `scripts/deploy/verify.ts`
and any off-chain service that needs the address book.

Real-network documents are git-tracked deliberately — they are the
canonical address registry for the indexer, web interface and keeper.
Local dev chains write `local-<chainId>.json`, which is gitignored.
