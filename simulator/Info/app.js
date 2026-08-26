/*
 * Equilibra V1.5 — interactive liquidity-density visual.
 *
 * The chart plots the **same** liquidity bell the visualizer page at
 * `/visualizer/` shows for the Equilibra series. We POST the
 * current `(a, λ)` to `/api/visualizer/series` (the bit-exact Rust
 * kernel used by the production simulator), pull the one-sided
 * liquidity series Equilibra returns, then mirror it around `d = 0`
 * to form a symmetric bell — identical to the visualizer's
 * "Liquidity depth (tokens / price unit)" chart.
 *
 *     liquidity(d) = (1 − d) / slope(penalty(d))
 *
 * Bell semantics:
 *   • peak at the anchor (`d = 0`) because the penalty slope is
 *     small inside the plateau
 *   • height tracks `a` (deep plateau ⇒ tall peak)
 *   • width tracks `λ` (small `λ` ⇒ wide plateau)
 *   • CP-leaning configurations (low `a`, high `λ`) collapse smoothly
 *     toward the constant-product baseline rather than inverting
 *
 * Axis-placement honesty note: the bell HEIGHTS are kernel-derived
 * (per-depletion liquidity fetched from the API), but their
 * placement along the log-price axis uses the stylised,
 * (a, λ)-independent map `d = (r − 1) / (r + 1)` — see
 * `priceRatioToD` below. That map is NOT the kernel's true
 * price ↔ depletion relation; treat the x-placement as illustrative.
 *
 * Auto-repeg animation — stylised illustration ONLY:
 *   - market_price     ← slider
 *   - EMA marker       ← market slider × EMA_LAG    (fixed demo lag)
 *   - anchor marker    ← market slider × ANCHOR_LAG (fixed demo lag;
 *     derived from the market slider, NOT from the EMA marker)
 *
 * The real on-chain pipeline (`EquilibraPool._tryAutoRepeg` →
 * `PoolOracle.shiftPriceScale`) is a dead-banded, once-per-block,
 * LP-unit-value-gated walk with a damped step
 * `min(repegStepWad, deviation / 5)` that never overshoots the
 * target. None of that is modelled here — the markers only convey
 * the direction of the mechanism (market → EMA → anchor).
 *
 * The bell is recentred on the anchor's current position so the
 * whole shape slides along the price axis as the user drags the
 * market slider. The X-axis stays in price-ratio space (log scale,
 * `0.25× … 4×` relative to the *original* anchor) so the
 * EMA/anchor/market markers project onto the same axis the
 * dashboard uses elsewhere.
 */
(function () {
  "use strict";

  const canvas = document.getElementById("envelopeChart");
  if (!canvas) return;

  const aInput = document.getElementById("aRange");
  const lambdaInput = document.getElementById("lambdaRange");
  const marketInput = document.getElementById("marketRange");

  const aOut = document.getElementById("aValue");
  const lambdaOut = document.getElementById("lambdaValue");
  const marketOut = document.getElementById("marketValue");

  const snapAWad = document.querySelector('[data-snap="aWad"]');
  const snapLambdaWad = document.querySelector('[data-snap="lambdaWad"]');
  const snapPeakDensity = document.querySelector('[data-snap="peakDensity"]');
  const snapAnchorRatio = document.querySelector('[data-snap="anchorRatio"]');
  const snapEmaRatio = document.querySelector('[data-snap="emaRatio"]');
  const snapRatioAtMarket = document.querySelector('[data-snap="ratioAtMarket"]');

  const presetButtons = document.querySelectorAll("[data-preset]");
  const chartStatus = document.getElementById("chartStatus");
  const presetStatus = document.getElementById("presetStatus");

  /** Illustrative demo constant — the EMA marker is drawn ~60% of the
   *  way (in log space) from the original anchor to the market
   *  slider. NOT the on-chain EMA model (`PoolOracle.updateEma`). */
  const EMA_LAG = 0.6;
  /** Illustrative demo constant — the anchor marker is drawn ~30% of
   *  the way from the original anchor to the market slider (derived
   *  from the market slider, NOT from the EMA marker). NOT the
   *  on-chain repeg walk (dead-band, once-per-block cap, damped
   *  `min(repegStepWad, deviation / 5)` step, two LP-unit-value
   *  gates). */
  const ANCHOR_LAG = 0.3;

  /** Minimum Y-axis ceiling so very-low-`a` configs (near-CP, peak
   *  ~0.5 in normalised units) don't collapse into a flat line. */
  const Y_MIN_CEILING = 1.0;

  /** Headroom above the curve's peak when auto-scaling the Y axis. */
  const Y_HEADROOM = 1.1;

  /** X-axis covers two octaves either side of the original anchor. */
  const RMIN = 0.25;
  const RMAX = 4.0;
  const X_LOG_MIN = Math.log(RMIN);
  const X_LOG_MAX = Math.log(RMAX);

  /** Debounce window before re-fetching the bell from the API. The
   *  visualizer uses 16 ms; the Info page is a slower-feedback page
   *  so we can be a bit more relaxed and reduce server churn. */
  const FETCH_DEBOUNCE_MS = 120;

  /** WAD precision used by the on-chain factory. The API expects
   *  decimal-string WAD values for `aWad` and `lambdaWad`. */
  const WAD = 10n ** 18n;

  /** Slider domain × WAD precision: pick the number of decimals high
   *  enough that the 3-decimal slider (`step=0.001`) survives the
   *  Display → WAD conversion without losing the last digit. */
  function toWadString(value) {
    // value is a decimal-display unit like 0.842; convert to WAD
    // (1e18) integer via bigint to dodge float drift.
    const scaled = Math.round(value * 1e15); // ppt resolution
    return (BigInt(scaled) * 10n ** 3n).toString();
  }

  /** Parameters for the request's mandatory YieldBasis reference-AMM
   *  leg (`curve` is the internal API field name). The Info page
   *  never reads the resulting reference series; the request schema
   *  just needs SOMETHING here. Populated at page load from the
   *  same-origin `GET /api/config/default` (canonical defaults from
   *  `simulator/src/app/config.rs`) — no baked-in literals: a
   *  hand-copied tuple here has already been shown to drift from the
   *  single source of truth. Stays `null` until the config loads;
   *  bell fetches are deferred until then. */
  let referenceAmmParams = null;

  /** (a, λ) slider presets.
   *
   *  `weth` / `wbtc` are the production presets. They are populated
   *  at page load from `GET /api/config/default` (single source of
   *  truth: `simulator/src/app/config.rs`) and stay `null` — with
   *  their buttons disabled and a visible "presets unavailable"
   *  notice — if that fetch fails. No silent literal fallback.
   *
   *  `stable` / `volatile` are purely illustrative demo pairs (NOT
   *  production values). Per `Constants.sol`: larger λ narrows the
   *  plateau (peg-ish pools); smaller λ widens it, softening the
   *  cliff (volatile pairs). The demo values exaggerate that
   *  contrast so the sliders visibly move. */
  const PRESETS = {
    weth: null,
    wbtc: null,
    stable: { a: 0.95, lambda: 0.5 },
    volatile: { a: 0.3, lambda: 0.01 },
  };

  /** Visualizer presetKey — controls reserves + decimals on the
   *  backend. WETH is the canonical 18-dec/6-dec layout, which is
   *  what the V1 chart implicitly assumed. */
  const VIZ_PRESET_KEY = "WETH";

  /** Sample count for the API request. 80 points per side is plenty
   *  for a smooth bell on the Info chart (the visualizer ships up to
   *  400; we don't need that resolution here). */
  const VIZ_SAMPLES = 80;

  /** Max depletion bps — mirror the visualizer's default (covers
   *  d ∈ [0, 0.99]; the last few % of the bell are the CP tail and
   *  not informative on the Info page). */
  const VIZ_MAX_DEPLETION_BPS = 9900;

  const COLORS = {
    text: "#c9d1d9",
    muted: "#8b949e",
    grid: "#30363d",
    accent: "#58a6ff",
    mirror: "#8b949e",
    depletion: "#f0883e",
    surplus: "#3fb950",
    anchor: "#d29922",
    bg: "#161b22",
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function readParams() {
    const a = clamp(Number.parseFloat(aInput.value) || 0, 0.1, 0.99);
    const lambda = clamp(Number.parseFloat(lambdaInput.value) || 0, 0.001, 1);
    const market = clamp(Number.parseFloat(marketInput.value) || 1, 0.1, 10);
    return { a, lambda, market };
  }

  function syncOutputs(p) {
    aOut.textContent = p.a.toFixed(2);
    lambdaOut.textContent = p.lambda.toFixed(3);
    marketOut.textContent = p.market.toFixed(2) + "×";
  }

  // ---------------------------------------------------------------------
  // Visualizer API client
  // ---------------------------------------------------------------------

  let cachedSeries = null; // last successful API response
  let pendingFetch = null; // in-flight fetch, used to cancel-on-rerequest
  let lastRequestKey = null;

  /** Show a visible warning on the chart card (API failure / stale
   *  curve). The stale bell keeps rendering underneath so the page
   *  stays useful, but the mismatch is no longer silent. */
  function showChartStatus(message) {
    if (!chartStatus) return;
    chartStatus.textContent = message;
    chartStatus.hidden = false;
  }

  function clearChartStatus() {
    if (!chartStatus) return;
    chartStatus.textContent = "";
    chartStatus.hidden = true;
  }

  /** Enable / disable the production (WETH / WBTC) preset buttons and
   *  surface a visible status while the canonical config is loading
   *  or unavailable. The demo buttons are unaffected. */
  function setProductionPresetState(state, detail) {
    presetButtons.forEach((btn) => {
      const key = btn.getAttribute("data-preset");
      if (key !== "weth" && key !== "wbtc") return;
      btn.disabled = state !== "ready";
    });
    if (!presetStatus) return;
    if (state === "ready") {
      presetStatus.textContent = "";
      presetStatus.hidden = true;
    } else if (state === "loading") {
      presetStatus.textContent =
        "loading production presets from /api/config/default…";
      presetStatus.hidden = false;
    } else {
      presetStatus.textContent =
        "production presets unavailable — " +
        (detail || "/api/config/default failed") +
        ". Reload the page to retry.";
      presetStatus.hidden = false;
    }
  }

  /** Strict decimal-string WAD → display number (e.g.
   *  "843000000000000000" → 0.843). The BigInt path keeps the parse
   *  exact down to 1e-6 display resolution — far finer than the
   *  3-decimal sliders need. */
  function wadStringToDisplay(value, fieldName) {
    const text = String(value ?? "").trim();
    if (!/^[0-9]+$/.test(text)) {
      throw new Error(`invalid ${fieldName}: expected uint decimal string`);
    }
    return Number(BigInt(text) / (WAD / 1_000_000n)) / 1e6;
  }

  /**
   * Fetch the canonical benchmark defaults (`build_default_config` in
   * `simulator/src/app/config.rs`) from the dashboard binary that
   * serves this page. Returns the production (a, λ) presets in
   * display units plus the reference-AMM tuple the series request
   * requires. Throws on any missing / malformed field — the caller
   * renders a visible unavailable state instead of falling back to
   * hardcoded values.
   */
  async function loadDefaultConfig() {
    const res = await fetch("/api/config/default");
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new Error((json && json.error) || text || `HTTP ${res.status}`);
    }
    const cfg = json && typeof json === "object" ? json.config : null;
    const eqPresets = cfg?.amms?.equilibra?.presets;
    if (!eqPresets || typeof eqPresets !== "object") {
      throw new Error("missing amms.equilibra.presets in default config");
    }

    const productionPresets = {};
    for (const [uiKey, cfgKey] of [
      ["weth", "WETH"],
      ["wbtc", "WBTC"],
    ]) {
      const preset = eqPresets[cfgKey];
      if (!preset || typeof preset !== "object") {
        throw new Error(`missing amms.equilibra.presets.${cfgKey}`);
      }
      productionPresets[uiKey] = {
        a: wadStringToDisplay(preset.aWad, `equilibra.${cfgKey}.aWad`),
        lambda: wadStringToDisplay(
          preset.lambdaWad,
          `equilibra.${cfgKey}.lambdaWad`
        ),
      };
    }

    // Reference-AMM tuple for the request's mandatory leg — take the
    // exact triple the benchmark itself runs (mode + preset), so the
    // pair is guaranteed valid together. `curve` / `A` / `gamma` are
    // internal API field names.
    const refCfg = cfg?.amms?.curve;
    const refPreset =
      refCfg?.presets && typeof refCfg.presets === "object"
        ? refCfg.presets[VIZ_PRESET_KEY]
        : null;
    if (!refPreset || typeof refPreset !== "object") {
      throw new Error(`missing amms.curve.presets.${VIZ_PRESET_KEY}`);
    }
    const mathMode = refCfg.mathMode;
    if (mathMode !== "crypto" && mathMode !== "stableswap") {
      throw new Error("invalid amms.curve.mathMode in default config");
    }
    const refA = Number(refPreset.A);
    if (!Number.isFinite(refA) || refA <= 0) {
      throw new Error(`invalid amms.curve.presets.${VIZ_PRESET_KEY}.A`);
    }
    const refGamma = String(refPreset.gamma ?? "").trim();
    if (!/^[0-9]+$/.test(refGamma)) {
      throw new Error(`invalid amms.curve.presets.${VIZ_PRESET_KEY}.gamma`);
    }

    return {
      presets: productionPresets,
      reference: { mathMode, A: Math.trunc(refA), gamma: refGamma },
    };
  }

  /**
   * Fetch the Equilibra liquidity series from the visualizer API.
   * Returns an array `[{d, liquidity, penalty}, …]` ordered by
   * ascending `d` ∈ [0, 1). One-sided — the chart mirrors it across
   * `d = 0` before plotting.
   */
  async function fetchBellSeries(a, lambda) {
    if (!referenceAmmParams) {
      throw new Error(
        "default config not loaded — reference-AMM parameters unavailable"
      );
    }
    const payload = {
      presetKey: VIZ_PRESET_KEY,
      samples: VIZ_SAMPLES,
      maxDepletionBps: VIZ_MAX_DEPLETION_BPS,
      equilibra: {
        aWad: toWadString(a),
        lambdaWad: toWadString(lambda),
      },
      curve: referenceAmmParams, // internal API field name
    };
    const res = await fetch("/api/visualizer/series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`visualizer API ${res.status}: ${text}`);
    }
    const json = await res.json();
    const series = json?.slippage?.equilibra;
    if (!Array.isArray(series)) {
      throw new Error("visualizer API: missing slippage.equilibra series");
    }
    // Coerce the (d, penalty, liquidity) tuples into the shape the
    // chart consumes. The API ships `d` in [0, 1] (fraction of base
    // reserve sold) and `liquidity` ≥ 0.
    return series
      .map((pt) => ({
        d: Number(pt.d),
        liquidity: Math.max(0, Number(pt.liquidity) || 0),
        penalty: Number.isFinite(Number(pt?.penalty))
          ? Math.max(0, Number(pt.penalty))
          : 0,
      }))
      .filter((p) => Number.isFinite(p.d) && p.d >= 0);
  }

  /**
   * Look up liquidity at a depletion fraction `dAbs ∈ [0, 1]` via
   * linear interpolation over the one-sided series. Returns `0`
   * outside the sampled range.
   */
  function liquidityAt(dAbs, series) {
    if (!series || series.length === 0) return 0;
    if (dAbs <= series[0].d) return series[0].liquidity;
    if (dAbs >= series[series.length - 1].d) return 0;
    // Binary search for the interval.
    let lo = 0;
    let hi = series.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (series[mid].d <= dAbs) lo = mid;
      else hi = mid;
    }
    const s0 = series[lo];
    const s1 = series[hi];
    const t = (dAbs - s0.d) / Math.max(1e-18, s1.d - s0.d);
    return s0.liquidity + t * (s1.liquidity - s0.liquidity);
  }

  // ---------------------------------------------------------------------
  // Drawing primitives (unchanged from prior revision)
  // ---------------------------------------------------------------------

  /** Cache of the last-applied backing-buffer dimensions so we
   *  don't rewrite the attributes when nothing actually changed.
   *  Writing the same value to `canvas.width / canvas.height` would
   *  still trigger a layout reflow on every Market-price drag and
   *  let DPR/Math.floor rounding compound into visible drift. */
  let lastBufferW = 0;
  let lastBufferH = 0;

  function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || canvas.width;
    const cssH = rect.height || canvas.height;
    const targetW = Math.floor(cssW * dpr);
    const targetH = Math.floor(cssH * dpr);
    if (targetW !== lastBufferW) {
      canvas.width = targetW;
      lastBufferW = targetW;
    }
    if (targetH !== lastBufferH) {
      canvas.height = targetH;
      lastBufferH = targetH;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  function drawAxes(ctx, plot, opts) {
    const { x0, y0, x1, y1 } = plot;
    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px 'Segoe UI', sans-serif";

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    if (opts.yTicks) {
      opts.yTicks.forEach((t) => {
        const y =
          y1 - ((t.v - opts.yMin) / (opts.yMax - opts.yMin)) * (y1 - y0);
        ctx.strokeStyle = COLORS.grid;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(t.label, x0 - 42, y + 3);
      });
    }

    if (opts.xTicks) {
      opts.xTicks.forEach((t) => {
        const x =
          x0 + ((t.v - opts.xMin) / (opts.xMax - opts.xMin)) * (x1 - x0);
        ctx.strokeStyle = COLORS.grid;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.muted;
        const labelW = ctx.measureText(t.label).width;
        ctx.fillText(t.label, x - labelW / 2, y1 + 16);
      });
    }

    if (opts.xLabel) {
      ctx.fillStyle = COLORS.text;
      const w = ctx.measureText(opts.xLabel).width;
      ctx.fillText(opts.xLabel, (x0 + x1) / 2 - w / 2, y1 + 32);
    }
    if (opts.yLabel) {
      ctx.save();
      ctx.translate(x0 - 50, (y0 + y1) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = COLORS.text;
      const w = ctx.measureText(opts.yLabel).width;
      ctx.fillText(opts.yLabel, -w / 2, 0);
      ctx.restore();
    }

    ctx.restore();
  }

  function plotPolyline(ctx, plot, points, color, opts) {
    const { x0, y0, x1, y1 } = plot;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.lineWidth || 2;
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
    let started = false;
    points.forEach(([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        started = false;
        return;
      }
      const px =
        x0 + ((x - opts.xMin) / (opts.xMax - opts.xMin)) * (x1 - x0);
      const py =
        y1 - ((y - opts.yMin) / (opts.yMax - opts.yMin)) * (y1 - y0);
      if (px < x0 - 4 || px > x1 + 4) {
        started = false;
        return;
      }
      const pyClamped = Math.max(y0, Math.min(y1, py));
      if (!started) {
        ctx.moveTo(px, pyClamped);
        started = true;
      } else {
        ctx.lineTo(px, pyClamped);
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  function fillUnderLine(ctx, plot, points, fillColor, opts) {
    const { x0, y0, x1, y1 } = plot;
    ctx.save();
    ctx.fillStyle = fillColor;
    ctx.globalAlpha = opts.alpha || 0.18;
    ctx.beginPath();
    let started = false;
    let lastPx = x0;
    points.forEach(([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const px =
        x0 + ((x - opts.xMin) / (opts.xMax - opts.xMin)) * (x1 - x0);
      const py =
        y1 - ((y - opts.yMin) / (opts.yMax - opts.yMin)) * (y1 - y0);
      const pyClamped = Math.max(y0, Math.min(y1, py));
      if (!started) {
        ctx.moveTo(px, y1);
        ctx.lineTo(px, pyClamped);
        started = true;
      } else {
        ctx.lineTo(px, pyClamped);
      }
      lastPx = px;
    });
    if (started) {
      ctx.lineTo(lastPx, y1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawVerticalMarker(ctx, plot, xVal, opts) {
    const { x0, x1, y0, y1 } = plot;
    const px =
      x0 + ((xVal - opts.xMin) / (opts.xMax - opts.xMin)) * (x1 - x0);
    if (px < x0 - 1 || px > x1 + 1) return;

    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = opts.lineWidth || 1.5;
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
    ctx.moveTo(px, y0);
    ctx.lineTo(px, y1);
    ctx.stroke();
    ctx.setLineDash([]);

    if (opts.label) {
      ctx.fillStyle = opts.color;
      ctx.font = "12px 'Segoe UI', sans-serif";
      const w = ctx.measureText(opts.label).width;
      const labelX = Math.min(x1 - w - 4, Math.max(x0 + 4, px - w / 2));
      ctx.fillText(opts.label, labelX, y0 + (opts.labelOffset || 14));
    }
    if (opts.dotAtY !== undefined) {
      const py =
        y1 -
        ((opts.dotAtY - opts.yMin) / (opts.yMax - opts.yMin)) * (y1 - y0);
      ctx.fillStyle = opts.color;
      ctx.beginPath();
      ctx.arc(px, py, opts.dotRadius || 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------
  // Y-axis nice-ceiling picker (auto-scaling per-frame)
  // ---------------------------------------------------------------------

  function niceCeiling(peak) {
    const raw = Math.max(Y_MIN_CEILING, peak * Y_HEADROOM);
    const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / pow10;
    let snap;
    if (norm <= 1) snap = 1;
    else if (norm <= 2) snap = 2;
    else if (norm <= 2.5) snap = 2.5;
    else if (norm <= 5) snap = 5;
    else snap = 10;
    return snap * pow10;
  }

  // ---------------------------------------------------------------------
  // Main draw
  // ---------------------------------------------------------------------

  /**
   * Map a chart x-axis price ratio `r` (relative to the current
   * anchor) into a signed depletion fraction for the liquidity
   * lookup: `r = 1 ⇒ d = 0`, `r → 0 ⇒ d → −1`, `r → ∞ ⇒ d → +1`.
   *
   * Stylised placement ONLY. The bell heights are kernel-derived
   * (per-`d` liquidity from `/api/visualizer/series`), but this
   * constant-product-style map
   *
   *     d = (r − 1) / (r + 1)
   *
   * is (a, λ)-independent and is NOT the kernel's true
   * price ↔ depletion relation (the backend expresses that relation
   * as `price(d) = anchor · (1 + penalty(d))`). It merely spreads
   * the one-sided series along the log-price axis so the bell and
   * the markers can share an axis — treat the x-placement as an
   * illustrative approximation.
   */
  function priceRatioToD(r) {
    return (r - 1) / (r + 1);
  }

  function draw({ market }) {
    const { ctx, w, h } = setupCanvas();
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const plot = { x0: 70, y0: 26, x1: w - 24, y1: h - 50 };

    const lrMarket = Math.log(market);
    const lrEma = lrMarket * EMA_LAG;
    const lrAnchor = lrMarket * ANCHOR_LAG;

    const xMin = X_LOG_MIN;
    const xMax = X_LOG_MAX;
    const yMin = 0;

    const series = cachedSeries;

    // Peak is at d=0 (the anchor) by construction; auto-scale Y.
    const peakDensity = series && series.length > 0 ? series[0].liquidity : 0;
    const yMax = niceCeiling(peakDensity);

    const yLabelFmt = (v) =>
      yMax >= 10 ? v.toFixed(0) : yMax >= 1 ? v.toFixed(1) : v.toFixed(2);
    drawAxes(ctx, plot, {
      xMin,
      xMax,
      yMin,
      yMax,
      xLabel: "price relative to original anchor (log)",
      yLabel: "liquidity depth (tokens / Δprice)",
      xTicks: [
        { v: Math.log(0.25), label: "0.25×" },
        { v: Math.log(0.5), label: "0.5×" },
        { v: 0, label: "1× (start)" },
        { v: Math.log(2), label: "2×" },
        { v: Math.log(4), label: "4×" },
      ],
      yTicks: [
        { v: 0, label: "0" },
        { v: yMax * 0.25, label: yLabelFmt(yMax * 0.25) },
        { v: yMax * 0.5, label: yLabelFmt(yMax * 0.5) },
        { v: yMax * 0.75, label: yLabelFmt(yMax * 0.75) },
        { v: yMax, label: yLabelFmt(yMax) },
      ],
    });

    // Sample the symmetric bell along the chart's log-price axis.
    // For each chart X the math-space price (relative to the
    // current anchor) is `r = exp(lr − lrAnchor)`; translate via
    // `priceRatioToD` and look the liquidity up in the one-sided
    // series (`|d|` because the bell is symmetric around the
    // anchor).
    const STEPS = 480;
    const points = [];
    for (let i = 0; i <= STEPS; i += 1) {
      const lr = xMin + ((xMax - xMin) * i) / STEPS;
      const r = Math.exp(lr - lrAnchor);
      const d = priceRatioToD(r);
      const liq = liquidityAt(Math.abs(d), series);
      points.push([lr, Math.min(yMax, liq)]);
    }

    if (series) {
      fillUnderLine(ctx, plot, points, COLORS.accent, {
        xMin,
        xMax,
        yMin,
        yMax,
        alpha: 0.16,
      });
      plotPolyline(ctx, plot, points, COLORS.accent, {
        xMin,
        xMax,
        yMin,
        yMax,
        lineWidth: 2.4,
      });
    } else {
      // First-frame fallback: a thin baseline placeholder while the
      // initial fetch is in flight.
      plotPolyline(
        ctx,
        plot,
        [
          [xMin, 0],
          [xMax, 0],
        ],
        COLORS.mirror,
        { xMin, xMax, yMin, yMax, lineWidth: 1, dash: [2, 4] }
      );
    }

    // Anchor / EMA / market markers — same axis convention as before.
    const aAtAnchor = Math.min(yMax, peakDensity);
    drawVerticalMarker(ctx, plot, lrAnchor, {
      xMin,
      xMax,
      yMin,
      yMax,
      color: COLORS.anchor,
      lineWidth: 2,
      label: "anchor " + Math.exp(lrAnchor).toFixed(2) + "×",
      labelOffset: 14,
      dotAtY: aAtAnchor,
    });

    const rEmaToAnchor = Math.exp(lrEma - lrAnchor);
    const dEma = priceRatioToD(rEmaToAnchor);
    const aAtEma = Math.min(yMax, liquidityAt(Math.abs(dEma), series));
    drawVerticalMarker(ctx, plot, lrEma, {
      xMin,
      xMax,
      yMin,
      yMax,
      color: COLORS.depletion,
      lineWidth: 1.5,
      dash: [4, 4],
      label: "EMA " + Math.exp(lrEma).toFixed(2) + "×",
      labelOffset: 30,
      dotAtY: aAtEma,
    });

    const rMarketToAnchor = Math.exp(lrMarket - lrAnchor);
    const dMarket = priceRatioToD(rMarketToAnchor);
    const aAtMarket = Math.min(yMax, liquidityAt(Math.abs(dMarket), series));
    drawVerticalMarker(ctx, plot, lrMarket, {
      xMin,
      xMax,
      yMin,
      yMax,
      color: COLORS.surplus,
      lineWidth: 2,
      label: "market " + market.toFixed(2) + "×",
      labelOffset: 46,
      dotAtY: aAtMarket,
    });

    // Snapshot card readouts.
    if (snapAnchorRatio)
      snapAnchorRatio.textContent = Math.exp(lrAnchor).toFixed(3) + "×";
    if (snapEmaRatio)
      snapEmaRatio.textContent = Math.exp(lrEma).toFixed(3) + "×";
    if (snapPeakDensity)
      snapPeakDensity.textContent =
        peakDensity >= 10
          ? peakDensity.toFixed(1)
          : peakDensity >= 1
            ? peakDensity.toFixed(2)
            : peakDensity.toFixed(3);
    const ratio = aAtAnchor > 0 ? aAtMarket / aAtAnchor : 0;
    if (snapRatioAtMarket)
      snapRatioAtMarket.textContent = (ratio * 100).toFixed(1) + "%";
  }

  // ---------------------------------------------------------------------
  // Driver — slider changes trigger debounced re-fetches; market
  // slider drags only re-draw the existing cache (no new fetch).
  // ---------------------------------------------------------------------

  function syncSnapKnobs(a, lambda) {
    if (snapAWad) snapAWad.textContent = a.toFixed(3);
    if (snapLambdaWad) snapLambdaWad.textContent = lambda.toFixed(4);
  }

  function refreshDraw() {
    const p = readParams();
    syncOutputs(p);
    syncSnapKnobs(p.a, p.lambda);
    draw(p);
  }

  let fetchTimer = null;
  function scheduleFetch() {
    const p = readParams();
    syncOutputs(p);
    syncSnapKnobs(p.a, p.lambda);
    refreshDraw(); // immediate re-render with stale cache so the
                   // market/anchor markers track the slider crisply

    // No fetch until `GET /api/config/default` has supplied the
    // mandatory reference-AMM leg of the request. The init path
    // re-invokes scheduleFetch once the config arrives (or surfaces
    // a visible unavailable state if it never does).
    if (!referenceAmmParams) return;

    const key = `${p.a}|${p.lambda}`;
    if (key === lastRequestKey) return;
    lastRequestKey = key;

    if (fetchTimer) clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
      const myToken = {};
      pendingFetch = myToken;
      try {
        const series = await fetchBellSeries(p.a, p.lambda);
        if (pendingFetch !== myToken) return; // superseded
        cachedSeries = series;
        clearChartStatus();
        refreshDraw();
      } catch (e) {
        if (pendingFetch !== myToken) return; // superseded
        // Visible failure: the cached bell (if any) no longer matches
        // the sliders. Reset the request key so the next slider input
        // or preset click retries instead of being short-circuited by
        // the same-key check above.
        lastRequestKey = null;
        showChartStatus(
          cachedSeries
            ? "visualizer API unavailable — the plotted curve is the last " +
                "successful result and does NOT reflect the current sliders. " +
                "Move a slider to retry."
            : "visualizer API unavailable — no curve data yet. Move a " +
                "slider to retry."
        );
        console.warn("Info chart: visualizer API failed:", e);
      }
    }, FETCH_DEBOUNCE_MS);
  }

  [aInput, lambdaInput].forEach((el) => {
    if (el) el.addEventListener("input", scheduleFetch);
  });
  if (marketInput) {
    marketInput.addEventListener("input", refreshDraw);
  }

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-preset");
      const preset = PRESETS[key];
      if (!preset) return;
      aInput.value = String(preset.a);
      lambdaInput.value = String(preset.lambda);
      scheduleFetch();
    });
  });

  let resizeRaf = null;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(refreshDraw);
  });

  // First paint (axes, markers and the dashed placeholder baseline),
  // then load the canonical defaults and kick off the first bell
  // fetch. There is deliberately NO hardcoded preset fallback: if the
  // config cannot be loaded, the affected widgets show a visible
  // unavailable state instead of silently rendering stale literals.
  refreshDraw();
  setProductionPresetState("loading");
  (async () => {
    try {
      const cfg = await loadDefaultConfig();
      PRESETS.weth = cfg.presets.weth;
      PRESETS.wbtc = cfg.presets.wbtc;
      referenceAmmParams = cfg.reference;
      setProductionPresetState("ready");
      scheduleFetch();
    } catch (e) {
      setProductionPresetState("unavailable", String((e && e.message) || e));
      showChartStatus(
        "simulator config unavailable (GET /api/config/default failed) — " +
          "the liquidity curve cannot be fetched and the production " +
          "presets are disabled. Reload the page to retry."
      );
      console.warn("Info page: default-config fetch failed:", e);
    }
  })();
})();
