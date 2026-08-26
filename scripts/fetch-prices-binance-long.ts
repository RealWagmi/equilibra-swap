/**
 * Binance long-range price fetcher for the simulator oracle dataset.
 *
 * Fetches ETHUSDT and BTCUSDT 1m close prices and writes them as the JSON
 * shape the Rust simulator consumes ({ startTimestamp, endTimestamp,
 * dataSource, fetchedAt, totalPoints, gaps, points: [{ t, p }] }) to:
 *
 *   simulator/data/{eth-usd.json, btc-usd.json}
 *
 * Default range:
 *   start: 2022-03-01T00:00:00Z
 *   end:   "now" (script start time) — a plain re-run extends the
 *          dataset to the current moment; override with
 *          BENCHMARK_BINANCE_END_TS for a reproducible fixed end
 *
 * Behaviour:
 *   - If the target file does not exist: download the full range from scratch.
 *   - If it exists: read it, treat its contents as authoritative, and only
 *     fetch candles strictly newer than the last existing point. The merged
 *     output is rewritten atomically (via the temp .jsonl + final write
 *     pipeline). Existing data is never re-fetched and never lost.
 *   - Network-interrupted runs leave a `<file>.tmp.jsonl` + `<file>.state.json`
 *     pair next to the target; the next invocation transparently resumes
 *     from where it stopped.
 *   - A per-asset `<file>.lock` guards the temp/state pair against
 *     concurrent invocations; a stale lock left by a crashed run must be
 *     removed manually (the error message names the exact file).
 *
 * Usage:
 *   npx ts-node scripts/fetch-prices-binance-long.ts
 *
 * Optional env:
 *   BENCHMARK_BINANCE_FORCE=1   delete existing output + temp/state and
 *                               re-download the full range from scratch
 *   BENCHMARK_BINANCE_END_TS    unix-seconds end timestamp (inclusive);
 *                               pins a reproducible fixed end instead of
 *                               the default "now"
 *   BENCHMARK_BINANCE_DELAY_MS  inter-request delay (default 120ms)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const START_TIMESTAMP = 1646092800; // 2022-03-01T00:00:00Z
// Default end = "now": a plain re-run always extends the dataset to the
// current moment (Binance returns an empty page past the newest candle,
// so a fresh tail simply stops at the latest available minute). Override
// with BENCHMARK_BINANCE_END_TS for a reproducible fixed-end dataset.
const DEFAULT_END_TIMESTAMP = Math.floor(Date.now() / 1000);

function parseEndTimestamp(): number {
  const raw = process.env.BENCHMARK_BINANCE_END_TS;
  if (raw === undefined || raw === "") return DEFAULT_END_TIMESTAMP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= START_TIMESTAMP) {
    throw new Error(`BENCHMARK_BINANCE_END_TS must be an integer > ${START_TIMESTAMP} (got ${raw})`);
  }
  return parsed;
}

const END_TIMESTAMP = parseEndTimestamp();
const START_MS = START_TIMESTAMP * 1000;
const END_MS = END_TIMESTAMP * 1000;

const INTERVAL_MS = 60_000; // 1m candles
const BINANCE_LIMIT = 1000; // Binance max per request
const BINANCE_URL = "https://api.binance.com/api/v3/klines";

const REQUEST_DELAY_MS = Math.max(0, Number.parseInt(process.env.BENCHMARK_BINANCE_DELAY_MS ?? "120", 10) || 120);
const RETRY_INITIAL_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 30_000;

const FORCE_REDOWNLOAD = process.env.BENCHMARK_BINANCE_FORCE === "1";
const OUTPUT_DIR = path.join(__dirname, "..", "simulator", "data");

const ASSETS = [
  {
    symbol: "ETH",
    pair: "ETHUSDT",
    outputFile: "eth-usd.json",
  },
  {
    symbol: "BTC",
    pair: "BTCUSDT",
    outputFile: "btc-usd.json",
  },
] as const;

type AssetConfig = (typeof ASSETS)[number];

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface PricePoint {
  t: number; // unix seconds
  p: number; // USD price
}

interface Gap {
  start: number;
  end: number;
  durationSec: number;
}

interface PriceData {
  startTimestamp: number;
  endTimestamp: number;
  dataSource: string;
  fetchedAt: string;
  totalPoints: number;
  gaps: Gap[];
  points: PricePoint[];
}

interface ResumeState {
  nextStartMs: number;
  chunksCompleted: number;
  rawPointsFetched: number;
  startedAt: string;
  updatedAt: string;
}

interface AnalyzeResult {
  totalPoints: number;
  gaps: Gap[];
  firstTs: number;
  lastTs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Logging helpers
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function clearLine(): void {
  process.stdout.write("\r\x1b[K");
}

function printInfo(message: string): void {
  console.log(`[INFO] ${message}`);
}

function printWarn(message: string): void {
  console.warn(`[WARN] ${message}`);
}

function printError(message: string): void {
  console.error(`[ERROR] ${message}`);
}

function printProgress(
  symbol: string,
  nextStartMs: number,
  rawPointsFetched: number,
  chunksCompleted: number,
  startedAtMs: number
): void {
  const totalRange = END_MS - START_MS;
  const coveredRange = Math.max(0, Math.min(totalRange, nextStartMs - START_MS));
  const percent = totalRange > 0 ? (coveredRange / totalRange) * 100 : 100;

  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  const rate = elapsedSec > 0 ? coveredRange / elapsedSec : 0;
  const remaining = Math.max(0, END_MS - nextStartMs);
  const etaSec = rate > 0 ? remaining / rate : 0;

  clearLine();
  process.stdout.write(
    `[${symbol}] ${percent.toFixed(1)}% | ` +
      `${formatNumber(rawPointsFetched)} rows | ` +
      `chunks ${chunksCompleted} | ` +
      `ETA ${formatTime(etaSec)}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// File helpers
// ═══════════════════════════════════════════════════════════════════════════════

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function getOutputPath(asset: AssetConfig): string {
  return path.join(OUTPUT_DIR, asset.outputFile);
}

function getTempPath(asset: AssetConfig): string {
  return path.join(OUTPUT_DIR, `${asset.outputFile}.tmp.jsonl`);
}

function getStatePath(asset: AssetConfig): string {
  return path.join(OUTPUT_DIR, `${asset.outputFile}.state.json`);
}

function getLockPath(asset: AssetConfig): string {
  return path.join(OUTPUT_DIR, `${asset.outputFile}.lock`);
}

function getStateTmpPath(statePath: string): string {
  // Staging sibling used by the atomic state save; the cleanup sites
  // delete it so an interrupted save cannot strand it forever.
  return `${statePath}.tmp`;
}

function deleteFileIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function writeAllSync(fd: number, data: Buffer): void {
  // POSIX permits a short write without raising an error, so a single
  // writeSync can leave interior torn data; loop until every byte is on
  // the fd.
  let offset = 0;
  while (offset < data.length) {
    offset += fs.writeSync(fd, data, offset, data.length - offset);
  }
}

// Error kinds raised by platforms that do not support fsync on a
// directory handle (e.g. Windows); every other fsync failure is a real
// durability signal.
const DIR_FSYNC_UNSUPPORTED_CODES = new Set(["EISDIR", "EPERM", "EBADF", "ENOTSUP", "EINVAL"]);

// Directories already warned about unsupported directory fsync: the
// warning fires once per directory per process, so a long fetch (one
// state save per chunk) does not repeat the identical message.
const dirFsyncWarnedDirs = new Set<string>();

function fsyncDirAfterPublish(dirPath: string): void {
  // Makes a just-published rename durable across power loss by fsyncing
  // the parent directory (the rename lives in the directory entry, not
  // in the file). Unsupported-platform errors degrade to a warning; any
  // other failure (EIO, ENOSPC, ...) is a genuine durability loss and is
  // rethrown.
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && DIR_FSYNC_UNSUPPORTED_CODES.has(code)) {
      if (!dirFsyncWarnedDirs.has(dirPath)) {
        dirFsyncWarnedDirs.add(dirPath);
        printWarn(`directory fsync unsupported for ${dirPath} (${code}); continuing without it`);
      }
      return;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreateLockFile(lockPath: string): boolean {
  // The full lock payload is staged in a pid-unique sibling temp and the
  // lock is claimed with a hard link: linkSync fails with EEXIST while a
  // lock exists, and the published lock file is never observable in an
  // empty or partially written state.
  const claimTempPath = `${lockPath}.${process.pid}.tmp`;
  const fd = fs.openSync(claimTempPath, "w");
  try {
    writeAllSync(fd, Buffer.from(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8"));
  } finally {
    fs.closeSync(fd);
  }
  let claimed: boolean;
  try {
    fs.linkSync(claimTempPath, lockPath);
    claimed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    claimed = false;
  } finally {
    // Claim-temp cleanup never throws: once the link exists the claim
    // has succeeded, and a failing temp unlink must not surface as a
    // failed acquisition (which would strand the fresh lock in the
    // fail-closed protocol). A leftover temp is collected by a later
    // litter sweep once its owner pid dies or it ages out.
    try {
      deleteFileIfExists(claimTempPath);
    } catch (cleanupError) {
      const errMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      printWarn(`claim temp cleanup failed for ${claimTempPath}: ${errMsg}`);
    }
  }
  return claimed;
}

function readLockOwnerPid(lockPath: string): number | null {
  // Returns the recorded owner pid, -1 for malformed content, or null
  // when the lock file does not exist.
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    // Malformed JSON falls through to the -1 return below.
  }
  return -1;
}

function extractLitterOwnerPid(name: string, lockBase: string, outputBase: string): number | null {
  // Parses the owner pid embedded in a recognised litter file name:
  // claim temps `<lock>.<pid>.tmp` and final-write staging files
  // `<output>.writing-<pid>-<uuid>`. Returns null for any other name.
  const claimPrefix = `${lockBase}.`;
  if (name.startsWith(claimPrefix) && name.endsWith(".tmp")) {
    const pidStr = name.slice(claimPrefix.length, -".tmp".length);
    return /^\d+$/.test(pidStr) ? Number.parseInt(pidStr, 10) : null;
  }
  const writingPrefix = `${outputBase}.writing-`;
  if (name.startsWith(writingPrefix)) {
    const pidStr = name.slice(writingPrefix.length).split("-", 1)[0];
    return /^\d+$/.test(pidStr) ? Number.parseInt(pidStr, 10) : null;
  }
  return null;
}

// Litter age threshold for the pid-reuse fallback: an active fetch keeps
// its staging files' mtime fresh (a chunk lands every request-delay
// interval and the final write streams continuously), so a candidate
// untouched for a full day is litter even when its embedded pid is alive
// again under a recycled identity.
const LITTER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function isLitterExpired(litterPath: string): boolean {
  // Age fallback for pid reuse: a live embedded pid does not prove an
  // active owner (pids are recycled, notably pid 1 in containers). A
  // failing stat reports not-expired so the file is left alone.
  try {
    return Date.now() - fs.statSync(litterPath).mtimeMs > LITTER_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function sweepDeadLockLitter(lockPath: string, outputPath: string): void {
  // Best-effort housekeeping under the freshly held lock: a hard-crashed
  // run (SIGKILL skips every finally) can strand its pid-named claim temp
  // or a large `.writing-*` staging file. Litter is deleted when its
  // owner pid is dead, or — pid-reuse fallback — when the file's mtime is
  // older than LITTER_MAX_AGE_MS; fresh files of live pids stay
  // untouched, as does the lock file itself. There is no own-pid
  // exemption: in a container the fetcher is often pid 1 on every start,
  // so an own-pid match can be ancient litter from a previous instance.
  // The liveness/age rule alone protects everything live — including this
  // process's own claim temp when its cleanup warn-path left it behind
  // (own pid is alive and the file is seconds old at sweep time). The
  // sweep never throws — a sweep failure right after a successful claim
  // must not surface as a failed acquisition.
  const dir = path.dirname(lockPath);
  const lockBase = path.basename(lockPath);
  const outputBase = path.basename(outputPath);

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    printWarn(`lock litter sweep skipped for ${dir}: ${errMsg}`);
    return;
  }

  for (const name of names) {
    const pid = extractLitterOwnerPid(name, lockBase, outputBase);
    if (pid === null || pid <= 0) continue;
    const litterPath = path.join(dir, name);
    if (isProcessAlive(pid) && !isLitterExpired(litterPath)) continue;
    try {
      deleteFileIfExists(litterPath);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      printWarn(`failed to delete dead litter ${name}: ${errMsg}`);
    }
  }
}

function acquireAssetLock(symbol: string, lockPath: string): void {
  // Single atomic claim, fail-closed: a stale lock is never reclaimed
  // automatically, because any check-then-remove takeover lets two
  // racing processes both end up owning the lock. The stale case always
  // throws and asks for manual removal.
  if (tryCreateLockFile(lockPath)) return;

  const ownerPid = readLockOwnerPid(lockPath);
  if (ownerPid === null) {
    throw new Error(
      `${symbol} lock ${lockPath} disappeared while being inspected (a concurrent run just released it); re-run to claim it`
    );
  }
  if (ownerPid > 0 && isProcessAlive(ownerPid)) {
    throw new Error(
      `${symbol} fetch is locked by running process ${ownerPid} (lock file: ${lockPath}); wait for it to finish or remove the lock file if it is stale`
    );
  }
  throw new Error(
    `${symbol} found a stale lock from a crashed run` +
      (ownerPid > 0 ? ` (owner pid ${ownerPid} is not alive)` : " (owner pid is unreadable)") +
      `; remove ${lockPath} manually and re-run`
  );
}

function releaseAssetLock(symbol: string, lockPath: string): void {
  // The lock file is deleted only when it still records this process as
  // the owner: if the lock is manually removed and re-claimed by another
  // run mid-flight, the current file belongs to that run and stays in
  // place. Release never throws — it runs on the error path too.
  let ownerPid: number | null;
  try {
    ownerPid = readLockOwnerPid(lockPath);
  } catch {
    ownerPid = -1;
  }
  if (ownerPid === null) return;
  if (ownerPid !== process.pid) {
    printWarn(
      `${symbol} lock ${lockPath} is not owned by this process` +
        (ownerPid > 0 ? ` (owner pid ${ownerPid})` : "") +
        `; leaving it in place`
    );
    return;
  }
  try {
    deleteFileIfExists(lockPath);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    printWarn(`${symbol} failed to delete lock ${lockPath}: ${errMsg}`);
  }
}

function appendPointsToTempFile(points: PricePoint[], tempPath: string): void {
  if (points.length === 0) return;
  const chunk = Buffer.from(points.map((point) => JSON.stringify(point)).join("\n") + "\n", "utf-8");
  // The chunk is fsynced before the cursor save that acknowledges it, so
  // the resume state never runs ahead of the durable temp tail.
  const fd = fs.openSync(tempPath, "a");
  try {
    writeAllSync(fd, chunk);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function loadResumeState(statePath: string): ResumeState | null {
  if (!fs.existsSync(statePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Partial<ResumeState>;
    if (
      typeof parsed.nextStartMs !== "number" ||
      typeof parsed.chunksCompleted !== "number" ||
      typeof parsed.rawPointsFetched !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      nextStartMs: parsed.nextStartMs,
      chunksCompleted: parsed.chunksCompleted,
      rawPointsFetched: parsed.rawPointsFetched,
      startedAt: parsed.startedAt,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveResumeState(statePath: string, state: ResumeState): void {
  // Write-tmp + fsync + rename: the cursor file is replaced atomically and
  // durably, so a crash never leaves a torn or stale state JSON behind.
  const stateTmpPath = getStateTmpPath(statePath);
  const fd = fs.openSync(stateTmpPath, "w");
  try {
    writeAllSync(fd, Buffer.from(JSON.stringify(state, null, 2), "utf-8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(stateTmpPath, statePath);
  fsyncDirAfterPublish(path.dirname(statePath));
}

function normalizeResumeState(state: ResumeState): ResumeState {
  const clampedStart = Math.max(START_MS, Math.min(END_MS + INTERVAL_MS, state.nextStartMs));
  return {
    ...state,
    nextStartMs: clampedStart,
  };
}

function parseJsonLine(line: string): PricePoint {
  const parsed = JSON.parse(line) as Partial<PricePoint>;
  if (
    typeof parsed.t !== "number" ||
    !Number.isFinite(parsed.t) ||
    typeof parsed.p !== "number" ||
    !Number.isFinite(parsed.p) ||
    parsed.p <= 0
  ) {
    throw new TypeError("Invalid temp point line schema");
  }
  return { t: Math.trunc(parsed.t), p: parsed.p };
}

function tryParsePointLine(rawLine: string): PricePoint | null {
  let line = rawLine.trim();
  if (!line) return null;
  if (line.endsWith(",")) line = line.slice(0, -1);
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line) as Partial<PricePoint>;
    if (
      typeof parsed.t !== "number" ||
      !Number.isFinite(parsed.t) ||
      typeof parsed.p !== "number" ||
      !Number.isFinite(parsed.p) ||
      parsed.p <= 0
    ) {
      return null;
    }
    return { t: Math.trunc(parsed.t), p: parsed.p };
  } catch {
    return null;
  }
}

function makeFreshState(): ResumeState {
  const nowIso = new Date().toISOString();
  return {
    nextStartMs: START_MS,
    chunksCompleted: 0,
    rawPointsFetched: 0,
    startedAt: nowIso,
    updatedAt: nowIso,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Network helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUnknownPayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

async function fetchBinanceKlinesWithRetry(pair: string, startMs: number): Promise<unknown[]> {
  const params = new URLSearchParams({
    symbol: pair,
    interval: "1m",
    limit: String(BINANCE_LIMIT),
    startTime: String(startMs),
    endTime: String(END_MS),
  });
  const url = `${BINANCE_URL}?${params.toString()}`;

  let attempt = 0;
  let delayMs = RETRY_INITIAL_DELAY_MS;

  while (true) {
    attempt++;
    try {
      const response = await fetch(url);
      const body = (await response.json()) as unknown;

      if (!response.ok) {
        const details = formatUnknownPayload(body);
        throw new Error(`HTTP ${response.status}: ${details}`);
      }

      if (!Array.isArray(body)) {
        throw new TypeError(`Unexpected Binance payload type: ${typeof body}`);
      }

      return body;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      printWarn(
        `${pair} request failed at start=${startMs} (attempt ${attempt}): ${errMsg}; retry in ${delayMs / 1000}s`
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, RETRY_MAX_DELAY_MS);
    }
  }
}

function parseBinanceRows(rows: unknown[]): PricePoint[] {
  const points: PricePoint[] = [];

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;

    const openTimeMs = Number(row[0]);
    const closePrice = Number(row[4]);

    if (!Number.isFinite(openTimeMs) || !Number.isFinite(closePrice)) continue;
    // Prices must be strictly positive; a zero/negative close would
    // break downstream ratio/log pricing.
    if (closePrice <= 0) continue;
    if (openTimeMs < START_MS || openTimeMs > END_MS) continue;

    points.push({
      t: Math.trunc(openTimeMs / 1000),
      p: closePrice,
    });
  }

  return points;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Temp analysis + final serialization
// ═══════════════════════════════════════════════════════════════════════════════

// One append chunk is ~30 KB, so a 1 MiB tail window comfortably contains
// the last complete line ahead of any torn final append.
const TAIL_REPAIR_WINDOW_BYTES = 1024 * 1024;

function repairTornTempTail(symbol: string, tempPath: string): void {
  if (!fs.existsSync(tempPath)) return;
  const size = fs.statSync(tempPath).size;
  if (size === 0) return;

  const fd = fs.openSync(tempPath, "r+");
  try {
    const lastByte = Buffer.alloc(1);
    fs.readSync(fd, lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a) return; // clean trailing newline: nothing to repair

    // A crash mid-append leaves a torn final line without a trailing
    // newline; truncate back to the last complete line so subsequent
    // appends and the resume peek see only line-aligned data.
    const windowSize = Math.min(size, TAIL_REPAIR_WINDOW_BYTES);
    const window = Buffer.alloc(windowSize);
    fs.readSync(fd, window, 0, windowSize, size - windowSize);
    const lastNewline = window.lastIndexOf(0x0a);

    if (lastNewline < 0 && size > windowSize) {
      throw new Error(
        `${symbol} temp file ${tempPath} has no newline in its final ${windowSize} bytes (corruption beyond a torn tail). Remove temp/state files or run with BENCHMARK_BINANCE_FORCE=1`
      );
    }

    // A window with no newline means the whole file is one torn line:
    // truncate to zero and restart the temp from scratch.
    const keepBytes = lastNewline < 0 ? 0 : size - windowSize + lastNewline + 1;
    fs.ftruncateSync(fd, keepBytes);
    fs.fsyncSync(fd);
    printWarn(`${symbol} repaired torn temp tail: truncated ${size - keepBytes} byte(s) from ${tempPath}`);
  } finally {
    fs.closeSync(fd);
  }
}

interface LineReader {
  rl: readline.Interface;
  throwIfFailed: () => void;
  close: () => void;
}

function openLineReader(filePath: string): LineReader {
  // A file read error (a failed lazy open, EIO, ...) fires as an 'error'
  // event on the stream; without a listener Node crashes the whole
  // process, outside any promise or finally — stranding the asset lock.
  // The listener is attached at creation time, before any await starts
  // consuming lines, so the event always has a handler: the first
  // failure is captured, the interface is closed so a for-await loop
  // terminates, and throwIfFailed() rethrows the failure on the
  // caller's normal path (callers check it right after the loop, before
  // interpreting a possibly truncated read).
  const input = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let failure: unknown;
  input.on("error", (error: unknown) => {
    if (failure === undefined) failure = error;
    rl.close();
  });
  return {
    rl,
    throwIfFailed: (): void => {
      if (failure !== undefined) throw failure;
    },
    close: (): void => {
      rl.close();
      input.destroy();
    },
  };
}

function parsePeekedTempLine(rawLine: string, lastTs: number, tempPath: string): number | null {
  // Returns the line's timestamp, or null for a blank line. Any
  // unparseable non-empty line and any backward timestamp jump is
  // interior corruption: fail here, before the fetch stage, with the
  // same strictness analyzeTempFile applies after it. Duplicate
  // timestamps are fine (analyzeTempFile deduplicates them keep-last).
  if (!rawLine.trim()) return null;
  const point = tryParsePointLine(rawLine);
  if (point === null) {
    throw new Error(
      `Unparseable line in temp file ${tempPath}. Remove temp/state files or run with BENCHMARK_BINANCE_FORCE=1`
    );
  }
  if (lastTs >= 0 && point.t < lastTs) {
    throw new Error(
      `Out-of-order timestamp in temp file ${tempPath}. Remove temp/state files or run with BENCHMARK_BINANCE_FORCE=1`
    );
  }
  return point.t;
}

async function peekLastTimestampFromTemp(tempPath: string): Promise<number> {
  if (!fs.existsSync(tempPath)) return -1;
  const reader = openLineReader(tempPath);
  let lastTs = -1;
  try {
    for await (const rawLine of reader.rl) {
      const ts = parsePeekedTempLine(rawLine, lastTs, tempPath);
      if (ts !== null) lastTs = ts;
    }
    reader.throwIfFailed();
  } finally {
    reader.close();
  }
  return lastTs;
}

async function peekLastTimestampFromOutput(outputPath: string): Promise<number> {
  const reader = openLineReader(outputPath);
  let lastTs = -1;
  try {
    for await (const rawLine of reader.rl) {
      const point = tryParsePointLine(rawLine);
      if (point !== null) lastTs = point.t;
    }
    reader.throwIfFailed();
  } finally {
    reader.close();
  }
  if (lastTs < 0) {
    throw new Error(`No points found in existing output: ${outputPath}`);
  }
  return lastTs;
}

async function seedTempFromExistingOutput(
  symbol: string,
  outputPath: string,
  tempPath: string
): Promise<{ count: number; lastTs: number }> {
  deleteFileIfExists(tempPath);

  const reader = openLineReader(outputPath);
  const tempStream = fs.createWriteStream(tempPath, {
    encoding: "utf-8",
    flags: "w",
  });
  // The completion promise is created up front with a pre-attached
  // catch, so a write error (e.g. ENOSPC) that fires between awaits
  // always has a listener — it can never crash the process as an
  // unhandled 'error' event — and is rethrown below on the normal await
  // path, which lets the caller's finally release the asset lock.
  let tempFailure: unknown;
  const tempFinished = finished(tempStream).catch((error: unknown) => {
    tempFailure = error;
  });

  let count = 0;
  let lastTs = -1;
  let seeded = false;

  try {
    for await (const rawLine of reader.rl) {
      const point = tryParsePointLine(rawLine);
      if (point === null) continue;
      if (lastTs >= 0 && point.t <= lastTs) {
        throw new Error(`Existing output ${outputPath} is not strictly increasing at t=${point.t}`);
      }
      await writeToStream(tempStream, JSON.stringify(point) + "\n");
      lastTs = point.t;
      count++;
    }
    reader.throwIfFailed();

    tempStream.end();
    await tempFinished;
    if (tempFailure !== undefined) throw tempFailure;

    if (count === 0 || lastTs < 0) {
      throw new Error(`No points found in existing output: ${outputPath}`);
    }
    seeded = true;
  } finally {
    reader.close();
    if (!tempStream.destroyed) tempStream.destroy();
    await tempFinished;
    if (!seeded) {
      // A failed seed deletes the partial temp instead of leaving it to
      // the torn-tail repair: no cursor acknowledges it yet, and the
      // next run re-seeds from the intact output. Cleanup never throws,
      // so the original error keeps propagating.
      try {
        deleteFileIfExists(tempPath);
      } catch (cleanupError) {
        const errMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        printWarn(`failed to delete partial seed ${tempPath}: ${errMsg}`);
      }
    }
  }

  // The seeded temp is made durable before returning: the caller next
  // publishes a durable cursor that acknowledges this seed, and that
  // cursor must never point past a temp a power loss can empty (an empty
  // temp resets the cursor to the range start and re-downloads the whole
  // range). Open read-write: on Windows fsync (FlushFileBuffers)
  // requires a writable handle and rejects a read-only fd.
  const fd = fs.openSync(tempPath, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirAfterPublish(path.dirname(tempPath));

  printInfo(
    `${symbol} seeded ${formatNumber(count)} existing point(s) (last=${new Date(lastTs * 1000).toISOString()})`
  );

  return { count, lastTs };
}

async function analyzeTempFile(tempPath: string): Promise<AnalyzeResult> {
  const reader = openLineReader(tempPath);

  const gaps: Gap[] = [];
  let pending: PricePoint | null = null;
  let totalPoints = 0;
  let firstTs = -1;
  let lastTs = -1;

  const commitPoint = (point: PricePoint): void => {
    if (firstTs < 0) {
      firstTs = point.t;
      lastTs = point.t;
      totalPoints = 1;
      return;
    }

    if (point.t <= lastTs) {
      throw new Error("Temp data is not strictly increasing after dedupe");
    }

    const gap = point.t - lastTs;
    if (gap > 3600) {
      gaps.push({ start: lastTs, end: point.t, durationSec: gap });
    }

    lastTs = point.t;
    totalPoints++;
  };

  try {
    for await (const rawLine of reader.rl) {
      const line = rawLine.trim();
      if (!line) continue;

      const point = parseJsonLine(line);
      if (pending === null) {
        pending = point;
        continue;
      }

      if (point.t < pending.t) {
        throw new Error("Temp data is unsorted by timestamp");
      }

      if (point.t === pending.t) {
        pending = point; // keep last value for duplicate timestamp
        continue;
      }

      commitPoint(pending);
      pending = point;
    }
    reader.throwIfFailed();
  } finally {
    reader.close();
  }

  if (pending !== null) {
    commitPoint(pending);
  }

  if (totalPoints === 0 || firstTs < 0 || lastTs < 0) {
    throw new Error("No valid points found in temp file");
  }

  return { totalPoints, gaps, firstTs, lastTs };
}

function streamFailure(stream: fs.WriteStream): Error | null {
  // `errored` carries the failure that destroyed the stream; a stream
  // destroyed without a recorded error still cannot accept writes.
  if (stream.errored) return stream.errored;
  if (stream.destroyed) return new Error("Stream destroyed before the write completed");
  return null;
}

async function writeToStream(stream: fs.WriteStream, chunk: string): Promise<void> {
  // A buffered flush can fail (e.g. ENOSPC) while no write is in
  // flight; that 'error' event is consumed by the stream's pre-attached
  // completion listener and is never re-emitted, so the stream state —
  // not a future event — is the reliable failure signal. It is
  // consulted before and after the buffered-write check, and the drain
  // wait also watches 'close', so no interleaving can leave this
  // promise unsettled. Every caller routes the rejection through its
  // normal failure path, which releases the asset lock.
  const preFailure = streamFailure(stream);
  if (preFailure !== null) throw preFailure;
  if (stream.write(chunk)) return;
  const postFailure = streamFailure(stream);
  if (postFailure !== null) throw postFailure;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(streamFailure(stream) ?? new Error("Stream closed before draining"));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function writeFinalDataFile(tempPath: string, outputPath: string, analysis: AnalyzeResult): Promise<void> {
  // Serialize to a sibling temp file and atomically rename over the
  // target, so a concurrent reader never observes a partial JSON and an
  // interrupted run leaves the authoritative feed untouched.
  const finalTmpPath = `${outputPath}.writing-${process.pid}-${randomUUID()}`;
  const dataMeta: Omit<PriceData, "points"> = {
    startTimestamp: analysis.firstTs,
    endTimestamp: analysis.lastTs,
    dataSource: "binance",
    fetchedAt: new Date().toISOString(),
    totalPoints: analysis.totalPoints,
    gaps: analysis.gaps,
  };

  const output = fs.createWriteStream(finalTmpPath, {
    encoding: "utf-8",
    flags: "wx",
    mode: 0o600,
  });
  let outputFailure: unknown;
  const outputFinished = finished(output).catch((error: unknown) => {
    outputFailure = error;
  });
  const gapsJson = JSON.stringify(dataMeta.gaps, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");

  let reader: LineReader | null = null;
  let published = false;
  try {
    await writeToStream(output, "{\n");
    await writeToStream(output, `  "startTimestamp": ${dataMeta.startTimestamp},\n`);
    await writeToStream(output, `  "endTimestamp": ${dataMeta.endTimestamp},\n`);
    await writeToStream(output, `  "dataSource": "${dataMeta.dataSource}",\n`);
    await writeToStream(output, `  "fetchedAt": "${dataMeta.fetchedAt}",\n`);
    await writeToStream(output, `  "totalPoints": ${dataMeta.totalPoints},\n`);
    await writeToStream(output, `  "gaps": ${gapsJson},\n`);
    await writeToStream(output, '  "points": [\n');

    let pending: PricePoint | null = null;
    let isFirst = true;
    let writtenCount = 0;

    const writeCommittedPoint = async (point: PricePoint): Promise<void> => {
      const line = `    { "t": ${point.t}, "p": ${JSON.stringify(point.p)} }`;
      if (!isFirst) await writeToStream(output, ",\n");
      await writeToStream(output, line);
      isFirst = false;
      writtenCount++;
    };

    // The reader opens immediately before the loop, with no await in
    // between: an input error closes the interface, and a for-await
    // entered only after that close never terminates. Iteration
    // therefore starts in the same tick the reader is created.
    reader = openLineReader(tempPath);

    for await (const rawLine of reader.rl) {
      const line = rawLine.trim();
      if (!line) continue;

      const point = parseJsonLine(line);
      if (pending === null) {
        pending = point;
        continue;
      }
      if (point.t < pending.t) throw new Error("Temp data is unsorted during final write");
      if (point.t === pending.t) {
        pending = point;
        continue;
      }
      await writeCommittedPoint(pending);
      pending = point;
    }
    reader.throwIfFailed();

    if (pending !== null) await writeCommittedPoint(pending);
    await writeToStream(output, "\n  ]\n}\n");
    output.end();
    await outputFinished;
    if (outputFailure !== undefined) throw outputFailure;

    if (writtenCount !== analysis.totalPoints) {
      throw new Error(`Written points mismatch: expected ${analysis.totalPoints}, got ${writtenCount}`);
    }

    // Flush file contents before the atomic directory-entry replacement.
    // Open read-write: on Windows fsync (FlushFileBuffers) requires a
    // writable handle and rejects a read-only fd.
    const fd = fs.openSync(finalTmpPath, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Atomic publish (same filesystem: rename is atomic on POSIX/NTFS).
    fs.renameSync(finalTmpPath, outputPath);
    published = true;
    fsyncDirAfterPublish(path.dirname(outputPath));
  } finally {
    if (reader !== null) reader.close();
    if (!output.destroyed) output.destroy();
    await outputFinished;
    if (!published) {
      // Staging cleanup never throws: a failing unlink here must not
      // replace the original error propagating out of the write pipeline.
      try {
        deleteFileIfExists(finalTmpPath);
      } catch (cleanupError) {
        const errMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        printWarn(`failed to delete staging file ${finalTmpPath}: ${errMsg}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Asset pipeline
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchAsset(asset: AssetConfig): Promise<void> {
  const lockPath = getLockPath(asset);
  // Exclusive per-asset lock: concurrent runs would interleave temp
  // appends and clobber each other's cursor. Acquired before any cleanup
  // (including FORCE), released once this asset's pipeline finishes.
  acquireAssetLock(asset.symbol, lockPath);
  try {
    // Housekeeping under the freshly held lock: collect pid-named litter
    // stranded by hard-crashed runs (claim temps, `.writing-*` staging).
    sweepDeadLockLitter(lockPath, getOutputPath(asset));
    await fetchAssetLocked(asset);
  } finally {
    releaseAssetLock(asset.symbol, lockPath);
  }
}

async function fetchAssetLocked(asset: AssetConfig): Promise<void> {
  const outputPath = getOutputPath(asset);
  const tempPath = getTempPath(asset);
  const statePath = getStatePath(asset);

  if (FORCE_REDOWNLOAD) {
    deleteFileIfExists(outputPath);
    deleteFileIfExists(tempPath);
    deleteFileIfExists(statePath);
    deleteFileIfExists(getStateTmpPath(statePath));
  }

  let state: ResumeState;
  const tempExists = fs.existsSync(tempPath);
  const stateExists = fs.existsSync(statePath);
  const outputExists = fs.existsSync(outputPath);

  if (tempExists && stateExists) {
    const loaded = loadResumeState(statePath);
    if (!loaded) {
      throw new Error(
        `${asset.symbol} resume state is invalid. Remove temp/state files or run with BENCHMARK_BINANCE_FORCE=1`
      );
    }
    state = normalizeResumeState(loaded);
    repairTornTempTail(asset.symbol, tempPath);
    // The temp file is the source of truth for what is durably appended,
    // so the cursor snaps to the temp tail in both directions: forward
    // when it lags the tail (re-appending candles below the tail would
    // make analyzeTempFile fail on a non-monotonic timestamp), and
    // backward when it runs ahead of the tail (fetching past candles the
    // temp never received would leave a permanent gap in the feed;
    // re-fetching is safe because analyzeTempFile deduplicates duplicate
    // timestamps keep-last). A temp with no valid point restarts the
    // cursor from the initial range start.
    const lastTempTs = await peekLastTimestampFromTemp(tempPath);
    if (lastTempTs >= 0) {
      const tailNextMs = (lastTempTs + 60) * 1000;
      if (tailNextMs !== state.nextStartMs) {
        state.nextStartMs = tailNextMs;
      }
    } else {
      state.nextStartMs = START_MS;
    }
    printInfo(
      `${asset.symbol} resume: next=${new Date(state.nextStartMs).toISOString()}, chunks=${state.chunksCompleted}, rawRows=${formatNumber(state.rawPointsFetched)}`
    );
  } else {
    if (tempExists || stateExists) {
      printWarn(`${asset.symbol} found partial temp artifacts without matching state; discarding and reseeding`);
      deleteFileIfExists(tempPath);
      deleteFileIfExists(statePath);
    }

    if (outputExists) {
      const lastTs = await peekLastTimestampFromOutput(outputPath);
      const nextStartMs = (lastTs + 60) * 1000;
      if (nextStartMs > END_MS) {
        printInfo(
          `${asset.symbol} already up to date (last=${new Date(lastTs * 1000).toISOString()}, end=${new Date(END_MS).toISOString()}); leaving ${outputPath} unchanged`
        );
        return;
      }
      printInfo(`${asset.symbol} extending existing dataset; will resume from ${new Date(nextStartMs).toISOString()}`);
      const seeded = await seedTempFromExistingOutput(asset.symbol, outputPath, tempPath);
      const nowIso = new Date().toISOString();
      state = {
        nextStartMs: (seeded.lastTs + 60) * 1000,
        chunksCompleted: 0,
        rawPointsFetched: seeded.count,
        startedAt: nowIso,
        updatedAt: nowIso,
      };
      saveResumeState(statePath, state);
    } else {
      state = makeFreshState();
    }
  }

  const startedAtMs = Date.now();
  printInfo(
    `Fetching ${asset.symbol} (${asset.pair}) from ${new Date(START_MS).toISOString()} to ${new Date(END_MS).toISOString()}`
  );

  while (state.nextStartMs <= END_MS) {
    const rows = await fetchBinanceKlinesWithRetry(asset.pair, state.nextStartMs);
    state.chunksCompleted++;

    if (rows.length === 0) {
      printWarn(
        `${asset.symbol} received empty chunk at ${new Date(state.nextStartMs).toISOString()}, stopping fetch loop`
      );
      break;
    }

    const points = parseBinanceRows(rows);
    appendPointsToTempFile(points, tempPath);
    state.rawPointsFetched += points.length;

    const lastRow = rows[rows.length - 1];
    if (!Array.isArray(lastRow) || lastRow.length === 0) {
      throw new TypeError(`Invalid Binance row shape for ${asset.symbol}`);
    }
    const lastOpenMs = Number(lastRow[0]);
    if (!Number.isFinite(lastOpenMs)) {
      throw new TypeError(`Invalid last open timestamp for ${asset.symbol}`);
    }

    const nextStartMs = lastOpenMs + INTERVAL_MS;
    if (nextStartMs <= state.nextStartMs) {
      throw new Error(`${asset.symbol} non-progress cursor: ${nextStartMs} <= ${state.nextStartMs}`);
    }

    state.nextStartMs = nextStartMs;
    state.updatedAt = new Date().toISOString();

    // Persist after every chunk: the temp file already holds this chunk's
    // points, so the cursor must advance in lockstep or a mid-window
    // interrupt would re-fetch already-appended candles out of order.
    saveResumeState(statePath, state);

    printProgress(asset.symbol, state.nextStartMs, state.rawPointsFetched, state.chunksCompleted, startedAtMs);

    if (REQUEST_DELAY_MS > 0) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  clearLine();
  process.stdout.write("\n");

  if (!fs.existsSync(tempPath)) {
    throw new Error(`${asset.symbol} temp file not found after fetch stage`);
  }

  printInfo(`${asset.symbol} analyzing temp data...`);
  const analysis = await analyzeTempFile(tempPath);
  const coveragePercent = ((analysis.lastTs - analysis.firstTs) / (END_TIMESTAMP - START_TIMESTAMP)) * 100;
  printInfo(
    `${asset.symbol} points=${formatNumber(analysis.totalPoints)}, gaps=${formatNumber(analysis.gaps.length)}, coverage=${coveragePercent.toFixed(2)}%`
  );

  printInfo(`${asset.symbol} writing final output...`);
  await writeFinalDataFile(tempPath, outputPath, analysis);

  deleteFileIfExists(tempPath);
  deleteFileIfExists(statePath);
  deleteFileIfExists(getStateTmpPath(statePath));

  printInfo(`${asset.symbol} done: ${outputPath}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  ensureOutputDir();

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  Binance long-range fetcher → simulator/data");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log();
  printInfo(`Output dir: ${OUTPUT_DIR}`);
  printInfo(`Period: ${new Date(START_MS).toISOString()} .. ${new Date(END_MS).toISOString()}`);
  printInfo(
    `Expected nominal points per asset: ${formatNumber(Math.floor((END_TIMESTAMP - START_TIMESTAMP) / 60) + 1)}`
  );
  printInfo(`Request delay: ${REQUEST_DELAY_MS}ms`);
  if (FORCE_REDOWNLOAD) {
    printWarn("BENCHMARK_BINANCE_FORCE=1 enabled, existing files will be overwritten");
  }
  console.log();

  const startedAt = Date.now();
  for (const asset of ASSETS) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`Asset: ${asset.symbol} (${asset.pair})`);
    console.log(`${"─".repeat(70)}`);
    await fetchAsset(asset);
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Completed in ${formatTime(elapsedSec)}`);
  console.log(`${"═".repeat(70)}`);
  printInfo(`Ready. Files live at ${OUTPUT_DIR} (the default ${"`"}BENCHMARK_ORACLE_DATA_DIR${"`"}).`);
}

main().catch((error) => {
  clearLine();
  printError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
