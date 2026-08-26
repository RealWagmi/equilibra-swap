// Direct unit tests for `PoolOracle.updateEma` — the EMA primitive
// behind every auto-repeg decision. The legacy `anchor` argument was
// renamed to `priceScale` (the two-knob cubic kernel uses the
// price scale as the anchor of its symmetric coordinate change), but
// the flash-loan / multi-block protection semantics are unchanged:
//   * symmetric spot cap at `[priceScale / EMA_PRICE_CAP_DIV,
//                            priceScale * EMA_PRICE_CAP_MUL]`,
//   * bootstrap seeds the EMA without applying the cap (no history to
//     anchor against),
//   * same-block re-entry is a no-op,
//   * `priceScale == 0` skips the cap so the oracle stays live in the
//     degenerate state.
import { expect } from "chai";
import hre from "hardhat";

const WAD = 10n ** 18n;
const EMA_PRICE_CAP_MUL = 2n;
const EMA_PRICE_CAP_DIV = 2n;
const EMA_PERIOD: number = 600; // 10 minutes (within MIN_EMA_PERIOD..MAX_EMA_PERIOD)

// Long elapsed (>= ~5 * period) so alpha = exp(-elapsed/period) ≈ 0 and
// the EMA collapses to (almost) the capped spot. This isolates the
// behavior of the spot cap from the continuous-time decay. The
// geometric blend `mulWad(ema, expWad(lnWad(ratio)·(1−α)))` floors at
// each of the three fixed-point steps, so the collapsed value sits a
// few wei BELOW the capped spot instead of exactly on it — the pinned
// expectations below carry that dust (bit-exact with the Rust
// reference `geometric_ema_step`).
const LONG_ELAPSED = 60_000;

describe("PoolOracle.updateEma: flash-loan / multi-block protection", function () {
  let harness: any;

  before(async function () {
    const F = await hre.ethers.getContractFactory("PoolOracleHarness");
    harness = await F.deploy();
    await harness.waitForDeployment();
  });

  // Bootstrap: no prior EMA → seed with raw spot, no cap.
  it("seeds EMA from spot when prior state is empty (no cap applied)", async function () {
    const spot = 7n * WAD; // way above 2x priceScale
    const priceScale = WAD;
    const [newEma, newTs] = await harness.updateEma(0n, 0, spot, priceScale, EMA_PERIOD, LONG_ELAPSED);
    expect(newEma).to.equal(spot);
    expect(newTs).to.equal(BigInt(LONG_ELAPSED));
  });

  // Symmetric cap (UPSIDE): manipulated huge spot is clamped to
  // priceScale * EMA_PRICE_CAP_MUL.
  it("clamps a runaway high spot at priceScale * EMA_PRICE_CAP_MUL", async function () {
    const priceScale = WAD;
    const oldEma = priceScale;
    const lastTs = 1_000;
    const nowTs = lastTs + LONG_ELAPSED;

    const insaneSpot = 1_000n * WAD;
    const [newEma] = await harness.updateEma(oldEma, lastTs, insaneSpot, priceScale, EMA_PERIOD, nowTs);

    // alpha ≈ 0 after long elapsed → blend collapses onto the capped
    // spot (2·ps), minus 1 wei of log-domain round-trip dust.
    expect(newEma).to.equal(priceScale * EMA_PRICE_CAP_MUL - 1n);
    expect(newEma).to.be.lt(insaneSpot / 100n); // nowhere near the raw spot
  });

  // Symmetric cap (DOWNSIDE): manipulated tiny spot is clamped to
  // priceScale / EMA_PRICE_CAP_DIV.
  it("clamps a runaway low spot at priceScale / EMA_PRICE_CAP_DIV", async function () {
    const priceScale = WAD;
    const oldEma = priceScale;
    const lastTs = 1_000;
    const nowTs = lastTs + LONG_ELAPSED;

    const dustSpot = 1n; // 1 wei — would have collapsed the EMA before the cap
    const [newEma] = await harness.updateEma(oldEma, lastTs, dustSpot, priceScale, EMA_PERIOD, nowTs);

    // Collapses onto the capped spot (ps/2) minus 1 wei of log-domain
    // round-trip dust.
    expect(newEma).to.equal(priceScale / EMA_PRICE_CAP_DIV - 1n);
    expect(newEma).to.be.gt(0n);
  });

  // Geometric-blend fixed point: when the spot already equals the EMA,
  // the log-domain op order (`ratio = divWad(spot, ema) == WAD →
  // lnWad == 0 → expWad == WAD → mulWad(ema, WAD) == ema`) returns the
  // EMA bit-exactly — no 1-wei walk on quiet markets, for any elapsed.
  it("spot == ema is an exact fixed point of the geometric blend", async function () {
    const ema = 123456789012345678n;
    const lastTs = 1_000;
    for (const elapsed of [1, 60, LONG_ELAPSED]) {
      const [newEma] = await harness.updateEma(ema, lastTs, ema, ema, EMA_PERIOD, lastTs + elapsed);
      expect(newEma, `elapsed=${elapsed}`).to.equal(ema);
    }
  });

  // Pass-through: legitimate small move stays inside the cap window.
  it("passes through small organic moves without clamping", async function () {
    const priceScale = WAD;
    const oldEma = priceScale;
    const lastTs = 1_000;
    const nowTs = lastTs + 60; // short elapsed → smooth blend

    // Spot 1% above priceScale — well within the 2x cap.
    const spot = (priceScale * 101n) / 100n;
    const [newEma] = await harness.updateEma(oldEma, lastTs, spot, priceScale, EMA_PERIOD, nowTs);

    expect(newEma).to.be.gt(oldEma);
    expect(newEma).to.be.lt(spot); // EMA blends, doesn't jump to spot
    expect(newEma).to.be.lt(priceScale * EMA_PRICE_CAP_MUL);
  });

  // Same-block re-entry is a no-op (preserves prior state).
  it("is a no-op when nowTs <= lastUpdateTs (same-block re-entry)", async function () {
    const ema = 3n * WAD;
    const lastTs = 5_000;
    const [newEma, newTs] = await harness.updateEma(
      ema,
      lastTs,
      9n * WAD, // spot — should be ignored
      WAD,
      EMA_PERIOD,
      lastTs // same timestamp
    );
    expect(newEma).to.equal(ema);
    expect(newTs).to.equal(BigInt(lastTs));
  });

  // L-5: `spotRaw = mulWad(pMarg, priceScale)` floors to 0 for an exotic
  // small-priceScale pool at extreme depletion. `updateEma` must SKIP
  // (return the state unchanged) rather than revert — a revert would
  // brick every subsequent swap, since `_updateEma` runs at the top of
  // `swap()`. This mirrors the Rust quoter's early-return.
  it("is a no-op when spotPriceWad == 0 (does not revert) — L-5", async function () {
    const ema = 7n * WAD;
    const lastTs = 5_000;
    const nowTs = lastTs + LONG_ELAPSED;
    const [newEma, newTs] = await harness.updateEma(
      ema,
      lastTs,
      0n, // spot floored to zero
      WAD,
      EMA_PERIOD,
      nowTs
    );
    // State returned unchanged — neither the EMA nor the timestamp moves.
    expect(newEma).to.equal(ema);
    expect(newTs).to.equal(BigInt(lastTs));
  });

  // priceScale = 0: cap is skipped (no scale to clamp against), EMA
  // blends raw spot. Used to be `anchorWad == 0` in V1.0.
  it("falls back gracefully when priceScaleWad == 0 (cap skipped)", async function () {
    const oldEma = WAD;
    const lastTs = 1_000;
    const nowTs = lastTs + LONG_ELAPSED;
    const spot = 100n * WAD; // raw spot, uncapped

    const [newEma] = await harness.updateEma(
      oldEma,
      lastTs,
      spot,
      0n, // priceScale disabled
      EMA_PERIOD,
      nowTs
    );

    // alpha ≈ 0 → newEma collapses onto the raw spot (no cap to clamp
    // it). The 100× ratio makes the ln/exp round trip lose ~1e-18
    // relative — 103 wei at this magnitude — so the pinned value sits
    // just under the spot.
    expect(newEma).to.equal(99999999999999999897n);
    expect(spot - BigInt(newEma)).to.be.lessThanOrEqual(spot / 10n ** 15n);
  });
});
