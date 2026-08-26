# Oracle Dataset

This directory hosts the price feeds the Rust simulator consumes
(`BENCHMARK_ORACLE_DATA_DIR`).

Expected files:

- `eth-usd.json`
- `btc-usd.json`

Each file is `{ startTimestamp, endTimestamp, dataSource, fetchedAt,
totalPoints, gaps, points: [{ t, p }] }` covering Binance 1m closes.

Generate or extend with:

```bash
npx ts-node scripts/fetch-prices-binance-long.ts
```

The fetcher only downloads candles strictly newer than the last point
already on disk; existing data is preserved and the merged file is
rewritten atomically. Re-run any time you want to extend the tail
(optionally pin the end via `BENCHMARK_BINANCE_END_TS=<unix-seconds>`).
Pass `BENCHMARK_BINANCE_FORCE=1` for a clean re-download from scratch.
