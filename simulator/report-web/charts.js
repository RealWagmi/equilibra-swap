/**
 * AMM Benchmark Dashboard Charts
 *
 * Based on BENCHMARK_SPEC.md Section 7.2
 *
 * Charts:
 * 1. Price History (oracle + pool prices with EMA smoothing)
 * 2. LP Value Chart (LP value over time)
 * 3. LP Composition Chart (token balances over time)
 * 4. Slippage Distribution (histogram: trade size % vs avg slippage)
 *
 * Tables:
 * 1. LP Position Table (initial/final values and positions)
 * 2. Trading Metrics (volume, fees, slippage, arb stats)
 */

// Skip execution when loaded in Node.js test environments
if (typeof document !== "undefined") {
  // ═══════════════════════════════════════════════════════════════════════════
  // Constants & Colors
  // ═══════════════════════════════════════════════════════════════════════════

  // Single authority for AMM colors on this page. At load time these values
  // are pushed into the CSS custom properties (--equilibra-color, …) that
  // styles.css consumes, so the stylesheet's :root values are only a pre-JS
  // fallback and cannot drift independently.
  const AMM_COLORS = {
    equilibra: "#3fb950",
    uniswapV2: "#ff007a",
    curve: "#4aa8ff",
  };

  // Human-facing display names for the internal AMM keys carried by the
  // report data. Data keys (metadata.ammList entries, series map keys,
  // dataset routing) stay untouched — this map is applied ONLY at render
  // time. Unknown AMM keys fall through verbatim.
  const AMM_DISPLAY_NAMES = {
    equilibra: "equilibra",
    uniswapV2: "uniswapV2",
    curve: "YieldBasis",
  };

  function displayName(amm) {
    return Object.prototype.hasOwnProperty.call(AMM_DISPLAY_NAMES, amm) ? AMM_DISPLAY_NAMES[amm] : amm;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // Loud fallback for AMM names without a color entry: bright magenta plus a
  // dashed line pattern (see lineStyleFor) so an unknown AMM is visually
  // impossible to mistake for a configured one — never a silent gray.
  const UNKNOWN_AMM_COLOR = "#ff00ff";

  const RECENTER_MARKER_COLOR = "#ff4444";
  const ORACLE_COLOR = "#ffffff";

  // Rendered wherever a required numeric/string field is absent from the
  // report data — a loud placeholder instead of a silently invented 0.
  const MISSING_PLACEHOLDER = "—";

  // ═══════════════════════════════════════════════════════════════════════════
  // Global State
  // ═══════════════════════════════════════════════════════════════════════════

  let metricsData = null;
  let seriesData = {};
  // All selection state below is populated from the loaded report data
  // (metadata.poolList / metadata.ammList / series metadata.emaPeriods) —
  // never hardcoded, so a run without a particular pool or AMM can neither
  // crash the page nor silently mislabel a series.
  let currentPool = null;
  let activeAMMs = new Set();
  let emaPeriodsList = null;
  let emaPeriod = null;
  let compositionTokenFilter = "quote"; // "quote" or "base"
  const recenteringMarkersVisible = {
    equilibra: true,
    curve: true,
  };
  let anchorDeviationVisible = true;
  const CHART_IDS = ["deviationChart", "ilChart", "lpCompositionChart", "slippageChart"];

  // Chart instances
  const charts = {};

  // Monotonic token guarding overlapping async chart renders: a render pass
  // aborts as soon as a newer pass has started, so two passes can never both
  // try to mount a Chart on the same canvas.
  let renderGen = 0;

  const warnedMessages = new Set();
  const shownBanners = new Set();

  // ═══════════════════════════════════════════════════════════════════════════
  // Small Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  function warnOnce(message) {
    if (warnedMessages.has(message)) return;
    warnedMessages.add(message);
    console.warn(message);
  }

  function isKnownAmm(amm) {
    return Object.prototype.hasOwnProperty.call(AMM_COLORS, amm);
  }

  function colorFor(amm) {
    if (isKnownAmm(amm)) return AMM_COLORS[amm];
    warnOnce(
      `Unknown AMM "${amm}" has no color entry in AMM_COLORS; rendering it in the loud fallback color ${UNKNOWN_AMM_COLOR}.`
    );
    return UNKNOWN_AMM_COLOR;
  }

  /** Dashed pattern for unknown AMMs so they stand apart from every configured series. */
  function lineStyleFor(amm) {
    return isKnownAmm(amm) ? {} : { borderDash: [6, 4] };
  }

  function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /** Replace the metadata banner with a single fatal error message. */
  function showFatalBanner(message) {
    const metadataEl = document.getElementById("metadata");
    if (!metadataEl) return;
    metadataEl.innerHTML = "";
    const span = document.createElement("span");
    span.className = "meta-item";
    span.style.color = "var(--accent-red)";
    // textContent: the message may embed run-supplied strings.
    span.textContent = message;
    metadataEl.appendChild(span);
  }

  /** Append an error message to the metadata banner (deduplicated). */
  function appendErrorBanner(message) {
    if (shownBanners.has(message)) return;
    shownBanners.add(message);
    const metadataEl = document.getElementById("metadata");
    if (!metadataEl) return;
    const span = document.createElement("span");
    span.className = "meta-item";
    span.style.color = "var(--accent-red)";
    span.textContent = message;
    metadataEl.appendChild(span);
  }

  /** Surface a failed async render: clear spinners, log, show the message. */
  function reportRenderFailure(error) {
    console.error("Chart rendering failed:", error);
    for (const id of CHART_IDS) {
      setChartLoading(id, false);
    }
    appendErrorBanner(error instanceof Error ? error.message : String(error));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Data Loading
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadData() {
    metricsData = await fetchJson("data/metrics.json");

    const meta = metricsData?.metadata;
    if (!meta || typeof meta !== "object") {
      throw new Error("metrics.json is missing its metadata block");
    }
    const pools = meta.poolList;
    if (!Array.isArray(pools) || pools.length === 0) {
      throw new Error("metrics.json metadata.poolList is empty or missing");
    }
    if (!Array.isArray(meta.ammList) || meta.ammList.length === 0) {
      throw new Error("metrics.json metadata.ammList is empty or missing");
    }
    if (!Array.isArray(meta.quoteSymbols) || meta.quoteSymbols.length === 0) {
      throw new Error(
        "metrics.json metadata.quoteSymbols is missing or empty — stale report bundle, regenerate the report"
      );
    }
    if (
      typeof meta.resultFormatVersion !== "string" ||
      typeof meta.actorAlgorithmVersion !== "string" ||
      typeof meta.executionFingerprint !== "string" ||
      typeof meta.oracleDigest !== "string" ||
      typeof meta.reportFingerprint !== "string" ||
      typeof meta.reportGeneratorSha256 !== "string" ||
      typeof meta.reportAlgorithmVersion !== "string" ||
      typeof meta.resultDigest !== "string" ||
      !meta.slippageSweep
    ) {
      throw new Error("metrics.json is missing required result/actor/slippage schema metadata — regenerate the report");
    }

    for (const pool of pools) {
      const series = await fetchJson(`data/series-${pool}.json`);
      if (!isCompactSeries(series)) {
        throw new Error(`Unsupported series format for pool ${pool}. Expected dashboard-compact-v2.`);
      }
      if (
        series.metadata?.resultFormatVersion !== meta.resultFormatVersion ||
        series.metadata?.actorAlgorithmVersion !== meta.actorAlgorithmVersion ||
        series.metadata?.executionFingerprint !== meta.executionFingerprint ||
        series.metadata?.oracleDigest !== meta.oracleDigest ||
        JSON.stringify(series.metadata?.slippageSweep) !== JSON.stringify(meta.slippageSweep)
      ) {
        throw new Error(`series-${pool}.json schema metadata does not match metrics.json`);
      }
      const periods = series.metadata?.emaPeriods;
      if (!Array.isArray(periods) || periods.length === 0) {
        throw new Error(
          `series-${pool}.json metadata.emaPeriods is missing or empty — stale report bundle, regenerate the report`
        );
      }
      if (emaPeriodsList === null) {
        emaPeriodsList = periods;
      } else if (JSON.stringify(emaPeriodsList) !== JSON.stringify(periods)) {
        throw new Error(`metadata.emaPeriods differs between pools ([${emaPeriodsList}] vs [${periods}] for ${pool})`);
      }
      seriesData[pool] = series;
    }

    // Initial selections come strictly from the loaded report data.
    currentPool = pools[0];
    activeAMMs = new Set(meta.ammList);
    // Prefer EMA 30 when this run emits it; otherwise the first smoothed set,
    // otherwise whatever the run has. The selector below is built from the
    // same list, so the UI always names exactly the series it renders — a
    // preferred period this run did not emit is simply not offered.
    emaPeriod = emaPeriodsList.includes(30) ? 30 : (emaPeriodsList.find((p) => p !== 0) ?? emaPeriodsList[0]);
  }

  async function fetchJson(path) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${path}`);
    }
    return await res.json();
  }

  function isCompactSeries(series) {
    return series && typeof series === "object" && series.format === "dashboard-compact-v2" && series.charts;
  }

  /**
   * Resolve the quote/base token symbols for a pool from report metadata.
   * Quote classification comes from metadata.quoteSymbols (emitted by
   * report.rs from its canonical QUOTE_SYMBOLS list) — never from a JS-side
   * symbol list, so the server-side quote/base series split and these labels
   * cannot diverge. Returns null (with a loud warning) when the bundle lacks
   * the data; callers render the "—" placeholder.
   */
  function quoteBaseSymbolsFor(pool) {
    const meta = metricsData.metadata;
    const tokens = meta.poolTokens?.[pool];
    if (!tokens || typeof tokens !== "object") {
      warnOnce(`metadata.poolTokens has no entry for pool ${pool} — token labels unavailable`);
      return null;
    }
    const t0 = tokens.token0Symbol;
    const t1 = tokens.token1Symbol;
    if (typeof t0 !== "string" || typeof t1 !== "string") {
      warnOnce(`metadata.poolTokens[${pool}] is missing token symbols`);
      return null;
    }
    const t0IsQuote = meta.quoteSymbols.includes(t0);
    const t1IsQuote = meta.quoteSymbols.includes(t1);
    if (t0IsQuote === t1IsQuote) {
      warnOnce(
        `Pool ${pool}: cannot classify quote/base — metadata.quoteSymbols matches ${
          t0IsQuote ? "both" : "neither"
        } of ${t0}/${t1}`
      );
      return null;
    }
    return t0IsQuote ? { quote: t0, base: t1 } : { quote: t1, base: t0 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  function initializeUI() {
    // Update metadata
    updateMetadata();

    // Initialize pool selector
    initializePoolSelector();

    // Initialize AMM toggles
    initializeAMMToggles();

    // Initialize EMA selector
    initializeEmaSelector();

    // Initialize recenter/rebalance marker toggles
    initializeRecenteringMarkerToggles();

    // Initialize composition token selector
    initializeCompositionTokenSelector();
  }

  function updateMetadata() {
    const meta = metricsData.metadata;
    const metadataEl = document.getElementById("metadata");

    // Format dates in UTC
    const startDate = new Date(meta.startTimestamp * 1000).toISOString().split("T")[0];
    const endDate = new Date(meta.endTimestamp * 1000).toISOString().split("T")[0];
    const fingerprint = String(meta.executionFingerprint);
    const oracleDigest = String(meta.oracleDigest);
    const reportFingerprint = String(meta.reportFingerprint);
    const resultDigest = String(meta.resultDigest);

    metadataEl.innerHTML = `
    <span class="meta-item"><strong>Duration:</strong> ${meta.durationDays} days</span>
    <span class="meta-item"><strong>Period:</strong> ${startDate} - ${endDate} (UTC)</span>
    <span class="meta-item"><strong>Initial Liquidity:</strong> $${formatNumber(meta.initialLiquidityUsd)}</span>
    <span class="meta-item" title="${escapeHtml(fingerprint)}"><strong>Execution:</strong> ${escapeHtml(fingerprint.slice(0, 12))}</span>
    <span class="meta-item" title="${escapeHtml(oracleDigest)}"><strong>Oracle:</strong> ${escapeHtml(oracleDigest.slice(0, 12))}</span>
    <span class="meta-item" title="${escapeHtml(reportFingerprint)}"><strong>Report:</strong> ${escapeHtml(reportFingerprint.slice(0, 12))}</span>
    <span class="meta-item" title="${escapeHtml(resultDigest)}"><strong>Result:</strong> ${escapeHtml(resultDigest.slice(0, 12))}</span>
  `;
  }

  function initializePoolSelector() {
    const selector = document.getElementById("poolSelector");
    selector.innerHTML = "";

    for (const pool of metricsData.metadata.poolList) {
      const option = document.createElement("option");
      option.value = pool;
      const qb = quoteBaseSymbolsFor(pool);
      option.textContent = qb ? `${qb.quote}/${qb.base}` : pool;
      selector.appendChild(option);
    }

    selector.value = currentPool;
    selector.addEventListener("change", (e) => {
      currentPool = e.target.value;
      updateCompositionSelectorLabels();
      updateAllCharts();
      updateAllTables();
    });
  }

  function initializeAMMToggles() {
    const container = document.getElementById("ammToggles");
    container.innerHTML = "";

    for (const amm of metricsData.metadata.ammList) {
      const toggle = document.createElement("label");
      toggle.className = `amm-toggle ${activeAMMs.has(amm) ? "active" : "inactive"}`;
      toggle.dataset.amm = amm;

      // Explicit node construction: `amm` is a run-supplied string and must
      // never be interpolated into innerHTML.
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = activeAMMs.has(amm);
      const indicator = document.createElement("span");
      indicator.className = "indicator";
      if (!isKnownAmm(amm)) {
        // Known AMMs are colored via the styles.css [data-amm] rules; an
        // unknown one gets the loud inline fallback color.
        indicator.style.backgroundColor = colorFor(amm);
      }
      const name = document.createElement("span");
      name.textContent = displayName(amm);
      toggle.append(checkbox, indicator, name);

      toggle.addEventListener("click", () => {
        const cb = toggle.querySelector("input");
        cb.checked = !cb.checked;

        if (cb.checked) {
          activeAMMs.add(amm);
          toggle.classList.add("active");
          toggle.classList.remove("inactive");
        } else {
          activeAMMs.delete(amm);
          toggle.classList.remove("active");
          toggle.classList.add("inactive");
        }

        updateAllCharts();
        updateAllTables();
      });

      container.appendChild(toggle);
    }
  }

  function initializeEmaSelector() {
    const selector = document.getElementById("emaPeriod");
    if (!selector) return;

    // Options come exclusively from the run's emitted metadata.emaPeriods —
    // the single source of truth for which EMA sets exist in this report.
    selector.innerHTML = "";
    for (const period of emaPeriodsList) {
      const option = document.createElement("option");
      option.value = String(period);
      option.textContent = period === 0 ? "Raw" : `EMA ${period}`;
      selector.appendChild(option);
    }

    selector.value = String(emaPeriod);
    selector.addEventListener("change", (e) => {
      const next = Number(e.target.value);
      if (emaPeriodsList.includes(next)) {
        emaPeriod = next;
        updateAllCharts();
      }
    });
  }

  function initializeRecenteringMarkerToggles() {
    const eqToggle = document.getElementById("showEquilibraRecentering");
    const curveToggle = document.getElementById("showCurveRecentering");

    if (eqToggle) {
      eqToggle.checked = recenteringMarkersVisible.equilibra;
      eqToggle.addEventListener("change", (e) => {
        recenteringMarkersVisible.equilibra = e.target.checked;
        updateAllCharts();
      });
    }

    if (curveToggle) {
      curveToggle.checked = recenteringMarkersVisible.curve;
      curveToggle.addEventListener("change", (e) => {
        recenteringMarkersVisible.curve = e.target.checked;
        updateAllCharts();
      });
    }

    const anchorToggle = document.getElementById("showAnchorDeviation");
    if (anchorToggle) {
      anchorToggle.checked = anchorDeviationVisible;
      anchorToggle.addEventListener("change", (e) => {
        anchorDeviationVisible = e.target.checked;
        createAnchorDevChart();
      });
    }
  }

  function initializeCompositionTokenSelector() {
    const selector = document.getElementById("compositionTokenSelector");
    if (!selector) return;

    selector.value = compositionTokenFilter;
    selector.addEventListener("change", async (e) => {
      compositionTokenFilter = e.target.value;
      // Recreate the LP Composition chart with the new filter; mountChart
      // destroys the previous instance before creating the replacement.
      try {
        await createLPCompositionChart();
      } catch (error) {
        reportRenderFailure(error);
      }
    });

    // Set initial labels for the current pool
    updateCompositionSelectorLabels();
  }

  /**
   * Update the LP Composition selector labels to show the actual token
   * symbols of the current pool (e.g. "Quote (USDT)" / "Base (WETH)"),
   * derived from metadata.quoteSymbols + metadata.poolTokens.
   */
  function updateCompositionSelectorLabels() {
    const selector = document.getElementById("compositionTokenSelector");
    if (!selector) return;

    const qb = quoteBaseSymbolsFor(currentPool);
    const quoteOption = selector.querySelector('option[value="quote"]');
    if (quoteOption) {
      quoteOption.textContent = `Quote (${qb ? qb.quote : MISSING_PLACEHOLDER})`;
    }
    const baseOption = selector.querySelector('option[value="base"]');
    if (baseOption) {
      baseOption.textContent = `Base (${qb ? qb.base : MISSING_PLACEHOLDER})`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Chart Creation
  // ═══════════════════════════════════════════════════════════════════════════

  // Charts are created via renderChartsAsync() which handles loading states

  function ensureSpinners() {
    for (const id of CHART_IDS) {
      const canvas = document.getElementById(id);
      const container = canvas ? canvas.closest(".chart-container") : null;
      if (!container) continue;
      if (!container.querySelector(".chart-spinner")) {
        const spinner = document.createElement("div");
        spinner.className = "chart-spinner";
        spinner.innerHTML = `<div class="spinner"></div><div>Loading…</div>`;
        container.appendChild(spinner);
      }
    }
  }

  function setChartLoading(id, loading) {
    const canvas = document.getElementById(id);
    const container = canvas ? canvas.closest(".chart-container") : null;
    if (!container) return;
    const spinner = container.querySelector(".chart-spinner");
    if (!spinner) return;
    spinner.classList.toggle("hidden", !loading);
  }

  function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Destroy any Chart instance currently mounted under `key` before creating
   * the replacement, so overlapping re-renders can never hit Chart.js'
   * "Canvas is already in use" error.
   */
  function mountChart(key, ctx, config) {
    if (charts[key]) {
      charts[key].destroy();
    }
    charts[key] = new Chart(ctx, config);
  }

  async function renderChartsAsync() {
    const gen = ++renderGen;
    for (const id of CHART_IDS) {
      setChartLoading(id, true);
    }

    await yieldToMain();
    if (gen !== renderGen) return;
    await createDeviationChart();
    if (gen !== renderGen) return;
    createAnchorDevChart();
    setChartLoading("deviationChart", false);

    await yieldToMain();
    if (gen !== renderGen) return;
    await createILChart();
    if (gen !== renderGen) return;
    setChartLoading("ilChart", false);

    await yieldToMain();
    if (gen !== renderGen) return;
    await createLPCompositionChart();
    if (gen !== renderGen) return;
    setChartLoading("lpCompositionChart", false);

    await yieldToMain();
    if (gen !== renderGen) return;
    createSlippageChart();
    setChartLoading("slippageChart", false);
  }

  async function createDeviationChart() {
    const ctx = document.getElementById("deviationChart").getContext("2d");
    const series = seriesData[currentPool];

    const datasets = [];
    const useRaw = emaPeriod === 0;
    const smoothingLabel = useRaw ? "" : ` (EMA${emaPeriod})`;

    // Strict lookup: the selector is built from metadata.emaPeriods, so a
    // missing set here is genuine data drift. Never silently substitute
    // another series under this label.
    const emaSet = series.charts?.deviation?.ema?.[String(emaPeriod)];
    if (!emaSet) {
      throw new Error(`EMA set ${emaPeriod} is not in this run's report for pool ${currentPool}`);
    }

    datasets.push({
      label: `oracle${smoothingLabel}`,
      data: emaSet.oracle || [],
      borderColor: ORACLE_COLOR,
      backgroundColor: "transparent",
      borderWidth: 2.5,
      pointRadius: 0,
      tension: 0.05,
      order: 10,
    });

    for (const amm of activeAMMs) {
      const chartData = emaSet.pools?.[amm];
      if (!chartData) {
        warnOnce(`Pool ${currentPool}: no deviation series for AMM "${amm}" (EMA ${emaPeriod})`);
        continue;
      }
      datasets.push({
        label: `${displayName(amm)}${smoothingLabel}`,
        data: chartData,
        borderColor: colorFor(amm),
        backgroundColor: "transparent",
        borderWidth: 1.6,
        pointRadius: 0,
        fill: false,
        tension: 0.1,
        order: 1,
        ...lineStyleFor(amm),
      });
    }

    if (activeAMMs.has("equilibra") && recenteringMarkersVisible.equilibra) {
      const recenterPoints = series.charts?.deviation?.recenteringMarkers?.equilibra || [];
      if (recenterPoints.length > 0) {
        datasets.push({
          label: "equilibra recenter",
          data: recenterPoints,
          type: "scatter",
          borderColor: RECENTER_MARKER_COLOR,
          backgroundColor: RECENTER_MARKER_COLOR,
          pointRadius: 3,
          pointStyle: "circle",
          showLine: false,
          order: 0,
        });
      }
    }

    if (activeAMMs.has("curve") && recenteringMarkersVisible.curve) {
      const rebalancePoints = series.charts?.deviation?.recenteringMarkers?.curve || [];
      if (rebalancePoints.length > 0) {
        datasets.push({
          label: "YieldBasis rebalance",
          data: rebalancePoints,
          type: "scatter",
          borderColor: colorFor("curve"),
          backgroundColor: colorFor("curve"),
          pointRadius: 3,
          pointStyle: "triangle",
          showLine: false,
          order: 0,
        });
      }
    }

    mountChart("deviation", ctx, {
      type: "line",
      data: { datasets },
      options: getTimeSeriesOptions("Price ($)"),
    });

    // Render recentering stats mini-table under the chart
    updateRecenterStats();
  }

  // Reference line on the LP-oracle-error strip: the price headroom to
  // the leverage-curve domain boundary at rho_max = 0.52
  // (1 − (16/9)·rho ≈ 7.6%). Collateral mispricing beyond this line
  // consumes the wrapper's entire discriminant margin.
  const BOOST_HEADROOM_PERCENT = 7.6;

  const anchorGateLinePlugin = {
    id: "anchorGateLine",
    afterDraw: (chart) => {
      const yScale = chart.scales.y;
      if (!yScale) return;
      if (BOOST_HEADROOM_PERCENT > yScale.max) return;
      const y = yScale.getPixelForValue(BOOST_HEADROOM_PERCENT);
      const { left, right, top, bottom } = chart.chartArea;
      if (y < top || y > bottom) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = "#ff9500";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.restore();
    },
  };

  /**
   * Anchor-deviation strip: |priceScale/oracle − 1| in percent, one
   * area series per anchor-bearing AMM, sharing the Price History
   * x-range. Hidden when the report predates the series or the toggle
   * is off.
   */
  function createAnchorDevChart() {
    const canvas = document.getElementById("anchorDevChart");
    if (!canvas) return;
    const series = seriesData[currentPool];
    const anchorSeries = series?.charts?.deviation?.lpOracleErr || {};
    const available = Object.keys(anchorSeries).filter(
      (amm) => activeAMMs.has(amm) && (anchorSeries[amm] || []).length > 0
    );

    if (!anchorDeviationVisible || available.length === 0) {
      if (charts.anchorDev) {
        charts.anchorDev.destroy();
        delete charts.anchorDev;
      }
      canvas.style.display = "none";
      return;
    }
    canvas.style.display = "";

    const datasets = available.map((amm) => ({
      label: `${displayName(amm)} LP-oracle err`,
      // Report emits bps; the strip renders percent.
      data: (anchorSeries[amm] || []).map((p) => ({ x: p.x, y: p.y / 100 })),
      borderColor: colorFor(amm),
      backgroundColor: hexToRgba(colorFor(amm), 0.22),
      borderWidth: 1,
      pointRadius: 0,
      fill: "origin",
      tension: 0,
      order: 1,
    }));

    const base = getTimeSeriesOptions("", true);
    base.plugins.legend = { display: false };
    base.scales.x.ticks = { display: false };
    // The strip is ~120px tall — no readable room for an axis ladder.
    // The scale is carried by per-AMM avg/max reference lines (drawn by
    // the plugin below) plus the labelled boost-gate line; exact values
    // live in the tooltip and the stats table. The axis itself stays
    // (invisible) so its fixed width keeps the strip's plot area
    // pixel-aligned with Price History above.
    base.scales.y.title = { display: false };
    base.scales.y.ticks = { display: false };
    base.scales.y.grid = { display: false };
    // Headroom so the top-most max line and its label stay inside.
    base.scales.y.grace = "15%";
    base.plugins.tooltip.callbacks.label = (context) => `${context.dataset.label}: ${context.parsed.y.toFixed(2)}%`;

    // Per-AMM avg (dotted) and max (dashed) reference lines with value
    // labels — these ARE the strip's scale.
    const statsMap = series?.charts?.deviation?.recenteringStats || {};
    const refLines = [];
    for (const amm of available) {
      const st = statsMap[amm];
      if (!st) continue;
      const color = colorFor(amm);
      if (typeof st.avgLpOracleErrBps === "number") {
        refLines.push({ y: st.avgLpOracleErrBps / 100, color, dash: [2, 3] });
      }
      if (typeof st.maxLpOracleErrBps === "number") {
        refLines.push({ y: st.maxLpOracleErrBps / 100, color, dash: [7, 4] });
      }
    }
    const anchorStatLinesPlugin = {
      id: "anchorStatLines",
      afterDraw: (chart) => {
        const yScale = chart.scales.y;
        if (!yScale) return;
        const { left, right, top, bottom } = chart.chartArea;
        const ctx2 = chart.ctx;
        ctx2.save();
        for (const line of refLines) {
          const y = yScale.getPixelForValue(line.y);
          if (y < top || y > bottom) continue;
          ctx2.strokeStyle = line.color;
          ctx2.lineWidth = 1;
          ctx2.setLineDash(line.dash);
          ctx2.beginPath();
          ctx2.moveTo(left, y);
          ctx2.lineTo(right, y);
          ctx2.stroke();
        }
        ctx2.restore();
      },
    };

    const ctx = canvas.getContext("2d");
    if (charts.anchorDev) {
      charts.anchorDev.destroy();
    }
    charts.anchorDev = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: base,
      plugins: [anchorGateLinePlugin, anchorStatLinesPlugin],
    });
  }

  function updateRecenterStats() {
    const container = document.getElementById("recenterStats");
    if (!container) return;

    const series = seriesData[currentPool];
    if (!series) {
      container.innerHTML = "";
      return;
    }

    const rows = [];
    const trackedAmms = [
      { amm: "equilibra", label: displayName("equilibra"), dotClass: "dot-equilibra" },
      { amm: "uniswapV2", label: displayName("uniswapV2"), dotClass: "dot-uniswap" },
      { amm: "curve", label: displayName("curve"), dotClass: "dot-curve" },
    ];

    for (const tracked of trackedAmms) {
      const stats = series.charts?.deviation?.recenteringStats?.[tracked.amm];
      if (!stats) continue;

      rows.push({
        ...tracked,
        count: numberOrNull(stats.count),
        avgAbsDeviationBps: numberOrNull(stats.avgAbsDeviationBps),
        avgLpOracleErrBps: numberOrNull(stats.avgLpOracleErrBps),
        maxLpOracleErrBps: numberOrNull(stats.maxLpOracleErrBps),
      });
    }

    if (rows.length === 0) {
      container.innerHTML = "";
      return;
    }

    // Safe to build via template strings: labels/dotClass come from the
    // hardcoded trackedAmms list above and the values are numbers or the
    // placeholder constant.
    const rowsHtml = rows
      .map((row) => {
        const avgDevCell = row.avgAbsDeviationBps === null ? MISSING_PLACEHOLDER : row.avgAbsDeviationBps.toFixed(1);
        // Anchor deviation is displayed in PERCENT (bps / 100): stall
        // depths run into tens of percent where bps stop being readable.
        const anchorDevCell =
          row.avgLpOracleErrBps === null
            ? MISSING_PLACEHOLDER
            : `${(row.avgLpOracleErrBps / 100).toFixed(2)}%` +
              (row.maxLpOracleErrBps === null ? "" : ` / ${(row.maxLpOracleErrBps / 100).toFixed(2)}%`);
        const countCell = row.count === null ? MISSING_PLACEHOLDER : row.count;
        return `
      <tr>
        <td style="color:${colorFor(row.amm)};font-weight:600">
          <span class="label-dot ${row.dotClass}"></span>${row.label}
        </td>
        <td>${anchorDevCell}</td>
        <td>${avgDevCell}</td>
        <td>${countCell}</td>
      </tr>
    `;
      })
      .join("");

    container.innerHTML = `
    <table>
      <tr>
        <th>AMM</th>
        <th>LP-oracle err avg / max (%)</th>
        <th>Avg Δ last trade vs spot (bps)</th>
        <th>Repeg events</th>
      </tr>
      ${rowsHtml}
    </table>
  `;
  }

  async function createILChart() {
    const ctx = document.getElementById("ilChart").getContext("2d");
    const series = seriesData[currentPool];

    const datasets = [];

    for (const amm of activeAMMs) {
      const lpValueData = series.charts?.lpValue?.passiveUsdByAmm?.[amm];
      if (!lpValueData) {
        warnOnce(`Pool ${currentPool}: no LP value series for AMM "${amm}"`);
        continue;
      }
      datasets.push({
        label: `${displayName(amm)} Passive`,
        data: lpValueData,
        borderColor: colorFor(amm),
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        ...lineStyleFor(amm),
      });
    }

    mountChart("il", ctx, {
      type: "line",
      data: { datasets },
      options: getTimeSeriesOptions("LP Value (USD)"),
    });
  }

  async function createLPCompositionChart() {
    const ctx = document.getElementById("lpCompositionChart").getContext("2d");
    const series = seriesData[currentPool];

    const datasets = [];

    // Quote/base classification and labels come from report metadata
    // (metadata.quoteSymbols + metadata.poolTokens). The server already
    // splits the composition series into quoteByAmm/baseByAmm with the same
    // canonical list, so labels and data cannot disagree.
    const qb = quoteBaseSymbolsFor(currentPool);
    const labelSymbol = qb ? (compositionTokenFilter === "quote" ? qb.quote : qb.base) : MISSING_PLACEHOLDER;
    const yAxisTitle =
      compositionTokenFilter === "quote" ? `Quote Token (${labelSymbol})` : `Base Token (${labelSymbol})`;

    for (const amm of activeAMMs) {
      const seriesByFilter =
        compositionTokenFilter === "quote"
          ? series.charts?.lpComposition?.quoteByAmm
          : series.charts?.lpComposition?.baseByAmm;
      const points = seriesByFilter?.[amm];
      if (!points) {
        warnOnce(`Pool ${currentPool}: no LP composition series for AMM "${amm}"`);
        continue;
      }
      datasets.push({
        label: `${displayName(amm)} ${labelSymbol}`,
        data: points,
        borderColor: colorFor(amm),
        backgroundColor: "transparent",
        borderWidth: 1.8,
        pointRadius: 0,
        tension: 0.1,
        ...lineStyleFor(amm),
      });
    }

    mountChart("lpComposition", ctx, {
      type: "line",
      data: { datasets },
      options: getTimeSeriesOptions(yAxisTitle),
    });
  }

  /**
   * Slippage chart - histogram showing slippage vs trade size
   * (% of initial one-side liquidity used by the simulator sampling model).
   * X-axis: Trade size buckets (0.01% .. 30% of initial one-side liquidity)
   * Y-axis: Average slippage (%) on linear scale.
   */

  // Non-linear scale constants for slippage chart
  const SLIPPAGE_NORMAL_LIMIT = 10; // ±SLIPPAGE_NORMAL_LIMIT% is the "normal" zone
  // The scale is fully linear; the limit is kept only for the dashed
  // reference guides at ±SLIPPAGE_NORMAL_LIMIT%.
  const SLIPPAGE_NORMAL_RATIO = 1.0;
  const SLIPPAGE_EXTREME_COLOR = "#ff9500"; // Orange for extreme values

  /**
   * Real → visual identity (the chart is fully linear).
   */
  function slippageToVisual(realValue) {
    // Fully linear scale: bars show their true height; the dashed
    // ±SLIPPAGE_NORMAL_LIMIT% lines remain as reference guides only.
    return realValue;
  }

  /**
   * Transform visual scale value back to real slippage value.
   */
  function visualToSlippage(visualValue) {
    // Inverse of the identity mapping above.
    return visualValue;
  }

  function createSlippageChart() {
    const ctx = document.getElementById("slippageChart").getContext("2d");
    const series = seriesData[currentPool];

    // Buckets are precomputed in integer BPS of initial one-side liquidity.
    const bucketEdgesBps = series?.charts?.slippage?.bucketEdgesBps;
    if (
      !Array.isArray(bucketEdgesBps) ||
      bucketEdgesBps.length < 2 ||
      bucketEdgesBps.some(
        (edge, index) => !Number.isInteger(edge) || edge < 1 || (index > 0 && edge <= bucketEdgesBps[index - 1])
      )
    ) {
      throw new Error(`Missing compact slippage bucket edges for pool ${currentPool}`);
    }
    // Results carry the canonical integer-BPS contract. Percent labels are a
    // presentation-only projection, not a second independently maintained
    // source of bucket boundaries.
    const bucketEdges = bucketEdgesBps.map((edge) => edge / 100);
    const NUM_BUCKETS = bucketEdges.length - 1;

    // Build bucket labels (2 decimal places for values < 1, integer for >= 1)
    const bucketLabels = [];
    for (let i = 0; i < NUM_BUCKETS; i++) {
      const min = bucketEdges[i];
      const max = bucketEdges[i + 1];
      const minStr = min < 1 ? min.toFixed(2) : min.toString();
      const maxStr = max < 1 ? max.toFixed(2) : max.toString();
      bucketLabels.push(`${minStr}-${maxStr}%`);
    }

    const datasets = [];

    for (const amm of activeAMMs) {
      let avgSlippagePercent = null;
      let ammMin = null;
      let ammMax = null;
      const compactAmm = series?.charts?.slippage?.byAmm?.[amm];
      if (compactAmm) {
        avgSlippagePercent = compactAmm.avgSlippagePercent || null;
        ammMin = typeof compactAmm.ammMin === "number" ? compactAmm.ammMin : null;
        ammMax = typeof compactAmm.ammMax === "number" ? compactAmm.ammMax : null;
      } else {
        warnOnce(`Pool ${currentPool}: no slippage aggregate for AMM "${amm}"`);
      }

      if (!Array.isArray(avgSlippagePercent)) {
        // Per-bucket nulls are legitimate (report emits Option<f64> per
        // bucket); an entirely missing AMM renders as an empty series and
        // is warned about above.
        avgSlippagePercent = new Array(NUM_BUCKETS).fill(null);
      }
      const visualData = avgSlippagePercent.map(slippageToVisual);

      // Keep bars in original AMM colors (don't paint extreme values orange)
      datasets.push({
        label: displayName(amm),
        data: visualData,
        originalData: avgSlippagePercent, // Store original for tooltips
        ammMin, // Store for Y-axis ticks
        ammMax, // Store for Y-axis ticks
        backgroundColor: hexToRgba(colorFor(amm), 0.7),
        borderColor: colorFor(amm),
        borderWidth: 1,
      });
    }

    // Calculate Y-axis range based on data
    let minVisual = 0,
      maxVisual = 0;
    for (const ds of datasets) {
      for (const val of ds.data) {
        if (val !== null) {
          minVisual = Math.min(minVisual, val);
          maxVisual = Math.max(maxVisual, val);
        }
      }
    }

    // Ensure we show at least the normal zone with some padding
    const normalVisualLimit = SLIPPAGE_NORMAL_LIMIT * SLIPPAGE_NORMAL_RATIO;
    minVisual = Math.min(minVisual, -normalVisualLimit * 0.5);
    maxVisual = Math.max(maxVisual, normalVisualLimit * 0.5);

    // Add padding
    const padding = (maxVisual - minVisual) * 0.1;
    minVisual -= padding;
    maxVisual += padding;

    // Custom plugin drawing horizontal orange lines at the
    // ±SLIPPAGE_NORMAL_LIMIT% boundaries
    const boundaryLinesPlugin = {
      id: "slippageBoundaryLines",
      afterDraw: function (chart) {
        const yScale = chart.scales.y;
        const ctx = chart.ctx;

        // Visual positions for the ±SLIPPAGE_NORMAL_LIMIT% boundaries
        const upperBoundaryVisual = slippageToVisual(SLIPPAGE_NORMAL_LIMIT);
        const lowerBoundaryVisual = slippageToVisual(-SLIPPAGE_NORMAL_LIMIT);

        // Get pixel positions
        const upperY = yScale.getPixelForValue(upperBoundaryVisual);
        const lowerY = yScale.getPixelForValue(lowerBoundaryVisual);

        const left = chart.chartArea.left;
        const right = chart.chartArea.right;

        ctx.save();
        ctx.strokeStyle = SLIPPAGE_EXTREME_COLOR;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]); // Dashed line

        // Draw upper boundary (+SLIPPAGE_NORMAL_LIMIT%)
        if (upperY >= chart.chartArea.top && upperY <= chart.chartArea.bottom) {
          ctx.beginPath();
          ctx.moveTo(left, upperY);
          ctx.lineTo(right, upperY);
          ctx.stroke();

          // Label (derived from the constant so it can never drift)
          ctx.fillStyle = SLIPPAGE_EXTREME_COLOR;
          ctx.font = "11px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(`+${SLIPPAGE_NORMAL_LIMIT}%`, right + 4, upperY + 3);
        }

        // Draw lower boundary (-SLIPPAGE_NORMAL_LIMIT%)
        if (lowerY >= chart.chartArea.top && lowerY <= chart.chartArea.bottom) {
          ctx.beginPath();
          ctx.moveTo(left, lowerY);
          ctx.lineTo(right, lowerY);
          ctx.stroke();

          // Label (derived from the constant so it can never drift)
          ctx.fillStyle = SLIPPAGE_EXTREME_COLOR;
          ctx.font = "11px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(`-${SLIPPAGE_NORMAL_LIMIT}%`, right + 4, lowerY + 3);
        }

        ctx.restore();
      },
    };

    mountChart("slippage", ctx, {
      type: "bar",
      data: {
        labels: bucketLabels,
        datasets,
      },
      plugins: [boundaryLinesPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: {
          padding: { right: 40 }, // Space for boundary labels
        },
        plugins: {
          legend: {
            position: "top",
            labels: { color: "#c9d1d9" },
          },
          tooltip: {
            callbacks: {
              title: function (context) {
                const idx = context[0].dataIndex;
                return `Trade size: ${bucketEdges[idx]}% - ${bucketEdges[idx + 1]}% of initial one-side liquidity`;
              },
              label: function (context) {
                const amm = context.dataset.label;
                // Use original (non-transformed) data for tooltip
                const originalData = context.dataset.originalData;
                const slippage = originalData ? originalData[context.dataIndex] : null;
                if (slippage === null) return `${amm}: no data`;
                const sign = slippage >= 0 ? "+" : "";
                const extreme = Math.abs(slippage) > SLIPPAGE_NORMAL_LIMIT ? " ⚠️ EXTREME" : "";
                return `${amm}: ${sign}${slippage.toFixed(2)}%${extreme}`;
              },
            },
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: "Trade Size (% of Initial One-Side Liquidity)",
              color: "#8b949e",
            },
            ticks: {
              color: "#8b949e",
              maxRotation: 45,
              minRotation: 45,
            },
            grid: { color: "#30363d" },
          },
          y: {
            min: minVisual,
            max: maxVisual,
            title: {
              display: true,
              text: "Avg Slippage (%)",
              color: "#8b949e",
            },
            afterBuildTicks: function (axis) {
              // Standard ticks only within the ±SLIPPAGE_NORMAL_LIMIT%
              // normal zone (the boundary itself is drawn by the plugin)
              const standardTicks = [-5, 0, 5];

              // Get actual min/max from chart scale
              const realMin = visualToSlippage(axis.min);
              const realMax = visualToSlippage(axis.max);

              // Collect extreme values (beyond ±SLIPPAGE_NORMAL_LIMIT%)
              // from each AMM
              const extremeValues = new Set();
              const chart = axis.chart;
              if (chart && chart.data && chart.data.datasets) {
                for (const ds of chart.data.datasets) {
                  // Add AMM-specific min if beyond -SLIPPAGE_NORMAL_LIMIT%
                  if (ds.ammMin !== null && ds.ammMin < -SLIPPAGE_NORMAL_LIMIT) {
                    extremeValues.add(Math.round(ds.ammMin));
                  }
                  // Add AMM-specific max if beyond +SLIPPAGE_NORMAL_LIMIT%
                  if (ds.ammMax !== null && ds.ammMax > SLIPPAGE_NORMAL_LIMIT) {
                    extremeValues.add(Math.round(ds.ammMax));
                  }
                }
              }

              // Combine: standard ticks within the ±SLIPPAGE_NORMAL_LIMIT%
              // zone + specific AMM extremes
              let realTickValues = [...standardTicks, ...extremeValues];

              // Sort and deduplicate
              realTickValues = [...new Set(realTickValues)].sort((a, b) => a - b);

              // Filter to visible range and convert to visual
              const visualTicks = realTickValues
                .filter((v) => v >= realMin && v <= realMax)
                .map((v) => slippageToVisual(v));

              axis.ticks = visualTicks.map((v) => ({ value: v }));
            },
            ticks: {
              color: "#8b949e",
              callback: function (value) {
                // Convert visual value back to real slippage for display
                const realValue = visualToSlippage(value);
                if (realValue === null) return "";
                const sign = realValue >= 0 ? "+" : "";
                return sign + realValue.toFixed(0) + "%";
              },
            },
            grid: { color: "#30363d" },
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Chart Update
  // ═══════════════════════════════════════════════════════════════════════════

  function updateAllCharts() {
    // Each chart is destroyed by mountChart just before its replacement is
    // created; the render-generation token in renderChartsAsync aborts any
    // older in-flight pass, so overlapping updates cannot double-mount.
    ensureSpinners();
    renderChartsAsync().catch(reportRenderFailure);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tables
  // ═══════════════════════════════════════════════════════════════════════════

  function updateAllTables() {
    updateTradingTable();
    updateLPPositionTable();
  }

  /**
   * Trading Metrics Table - transposed view with AMM names as rows
   * Columns: AMM | Total Volume | Pool Fees | Slippage (Avg/Min/Max) | Arbitrage (Trades / Profit)
   */
  function updateTradingTable() {
    const table = document.getElementById("tradingTable");
    if (!table) return;

    const thead = table.querySelector("thead tr");
    const tbody = table.querySelector("tbody");

    // Get summaries for current pool
    const summaries = metricsData.summaries.filter((s) => s.poolKey === currentPool && activeAMMs.has(s.ammName));

    if (summaries.length === 0) {
      thead.innerHTML = "<th>No data</th>";
      tbody.innerHTML = "";
      return;
    }

    // Build header
    thead.innerHTML = `
    <th>AMM</th>
    <th>Total Volume</th>
    <th>Pool Fees</th>
    <th>Slippage (Avg/Min/Max)</th>
    <th>Arbitrage (Trades / Profit)</th>
  `;

    tbody.innerHTML = "";

    // Collect values for "best" highlighting. Missing fields are excluded
    // (rendered as a placeholder below) instead of silently counting as 0,
    // which could otherwise win a "best" highlight with a fake value.
    const finiteValues = (getter) => summaries.map(getter).filter((v) => v !== null);
    const feesValues = finiteValues((s) => numberOrNull(s.totalFeesUsd));
    const avgSlippageValues = finiteValues((s) => numberOrNull(s.avgSlippageBps));
    const minSlippageValues = finiteValues((s) => numberOrNull(s.minSlippageBps));
    const maxSlippageValues = finiteValues((s) => numberOrNull(s.maxSlippageBps));

    const bestFees = feesValues.length > 0 ? Math.max(...feesValues) : null;
    const bestAvgSlippage = avgSlippageValues.length > 0 ? Math.min(...avgSlippageValues) : null;
    // Higher (less negative) is better
    const bestMinSlippage = minSlippageValues.length > 0 ? Math.max(...minSlippageValues) : null;
    const bestMaxSlippage = maxSlippageValues.length > 0 ? Math.min(...maxSlippageValues) : null;

    // Build rows - one per AMM
    for (const summary of summaries) {
      const row = document.createElement("tr");

      // AMM name cell with color (textContent: run-supplied string)
      const ammCell = document.createElement("td");
      ammCell.dataset.amm = summary.ammName;
      ammCell.textContent = displayName(summary.ammName);
      ammCell.style.color = colorFor(summary.ammName);
      ammCell.style.fontWeight = "600";
      row.appendChild(ammCell);

      // Total Volume
      const totalVolume = numberOrNull(summary.totalVolumeUsd);
      row.innerHTML += `<td>${totalVolume === null ? MISSING_PLACEHOLDER : `$${formatNumber(totalVolume)}`}</td>`;

      // Pool Fees
      const totalFees = numberOrNull(summary.totalFeesUsd);
      const feesClass = totalFees !== null && totalFees === bestFees ? "value-best" : "";
      row.innerHTML += `<td class="${feesClass}">${totalFees === null ? MISSING_PLACEHOLDER : `$${formatNumber(totalFees)}`}</td>`;

      // Slippage Avg/Min/Max in one cell (bps -> %); each segment keeps
      // its own "best" highlight.
      const avgSlippage = numberOrNull(summary.avgSlippageBps);
      const minSlippage = numberOrNull(summary.minSlippageBps);
      const maxSlippage = numberOrNull(summary.maxSlippageBps);
      const slippageSegment = (value, best) => {
        if (value === null) return MISSING_PLACEHOLDER;
        const percent = value / 100;
        const display = Object.is(percent, -0) ? 0 : percent;
        const cls = value === best ? ` class="value-best"` : "";
        return `<span${cls}>${display.toFixed(2)}%</span>`;
      };
      row.innerHTML += `<td>${slippageSegment(avgSlippage, bestAvgSlippage)} / ${slippageSegment(minSlippage, bestMinSlippage)} / ${slippageSegment(maxSlippage, bestMaxSlippage)}</td>`;

      // Arbitrage trades and profit in one cell.
      const arbTradeCount = numberOrNull(summary.arbTradeCount);
      const arbProfit = numberOrNull(summary.arbTotalProfitUsd);
      const arbTradesText = arbTradeCount === null ? MISSING_PLACEHOLDER : formatNumber(arbTradeCount);
      const arbProfitText = arbProfit === null ? MISSING_PLACEHOLDER : `$${formatNumber(arbProfit)}`;
      row.innerHTML += `<td>${arbTradesText} / ${arbProfitText}</td>`;

      tbody.appendChild(row);
    }
  }

  /**
   * LP Position Table - combined positions and performance metrics (transposed view)
   * Rows: AMM names
   * Columns: AMM | Initial Value | Final Value | Token balances | Δ vs Hold | Net PnL | Donation | Actions
   */
  function updateLPPositionTable() {
    const table = document.getElementById("lpPositionTable");
    if (!table) return;

    const thead = table.querySelector("thead tr");
    const tbody = table.querySelector("tbody");

    // Get summaries for current pool
    const summaries = metricsData.summaries.filter((s) => s.poolKey === currentPool && activeAMMs.has(s.ammName));

    // Check if we have LP position data
    const hasPositionData = summaries.some((s) => s.lpPositions);

    if (!hasPositionData || summaries.length === 0) {
      thead.innerHTML = "<th>No data</th>";
      tbody.innerHTML = "";
      return;
    }

    // Canonical token symbols from metadata.poolTokens (not from the first
    // summary) so the column order is stable regardless of AMM filtering.
    // A missing entry surfaces as a placeholder + console warning, never as
    // silently invented "Token0"/"Token1" names.
    const poolTokens = metricsData.metadata.poolTokens?.[currentPool];
    if (!poolTokens) {
      warnOnce(`metadata.poolTokens has no entry for pool ${currentPool} — column labels unavailable`);
    }
    const token0Symbol = poolTokens?.token0Symbol ?? MISSING_PLACEHOLDER;
    const token1Symbol = poolTokens?.token1Symbol ?? MISSING_PLACEHOLDER;

    const prefix = "lp1";

    // Build header via DOM nodes: token symbols are run-supplied strings and
    // must never be interpolated into innerHTML.
    thead.innerHTML = "";
    const headerLabels = [
      "AMM",
      "Initial Value",
      "Final Value",
      `Initial ${token0Symbol}`,
      `Final ${token0Symbol}`,
      `Initial ${token1Symbol}`,
      `Final ${token1Symbol}`,
      "Δ vs Hold",
      "Net PnL",
      "Donation",
    ];
    for (const label of headerLabels) {
      const th = document.createElement("th");
      th.textContent = label;
      thead.appendChild(th);
    }

    tbody.innerHTML = "";

    // Collect values for "best" highlighting (missing values excluded)
    const deltaValues = summaries.map((s) => numberOrNull(s[`${prefix}DeltaVsHoldPercent`])).filter((v) => v !== null);
    const pnlValues = summaries.map((s) => numberOrNull(s[`${prefix}NetPnlPercent`])).filter((v) => v !== null);

    const bestDelta = deltaValues.length > 0 ? Math.max(...deltaValues) : null;
    const bestPnl = pnlValues.length > 0 ? Math.max(...pnlValues) : null;

    // Build rows - one per AMM
    for (const summary of summaries) {
      const positions = summary.lpPositions;
      if (!positions) {
        warnOnce(`Summary ${summary.ammName}:${summary.poolKey} has no lpPositions block`);
      }
      const row = document.createElement("tr");

      // AMM name cell with color (textContent: run-supplied string)
      const ammCell = document.createElement("td");
      ammCell.dataset.amm = summary.ammName;
      ammCell.textContent = displayName(summary.ammName);
      ammCell.style.color = colorFor(summary.ammName);
      ammCell.style.fontWeight = "600";
      row.appendChild(ammCell);

      // Initial Value
      const initialValue = numberOrNull(positions?.[`${prefix}InitialUsd`]);
      row.innerHTML += `<td>${initialValue === null ? MISSING_PLACEHOLDER : `$${formatNumber(initialValue)}`}</td>`;

      // Final Value - colored based on profit/loss
      const finalValue = numberOrNull(positions?.[`${prefix}FinalUsd`]);
      const finalValueClass =
        finalValue !== null && initialValue !== null
          ? finalValue >= initialValue
            ? "value-positive"
            : "value-negative"
          : "";
      row.innerHTML += `<td class="${finalValueClass}">${finalValue === null ? MISSING_PLACEHOLDER : `$${formatNumber(finalValue)}`}</td>`;

      // Check if this AMM has reversed token order compared to reference
      const needsSwap = summary.token0Symbol !== token0Symbol;

      const tokenCell = (slot) => {
        const value = numberOrNull(positions?.[`${prefix}${slot}`]);
        return value === null ? MISSING_PLACEHOLDER : formatTokenAmount(value);
      };

      // Initial/Final Token0 and Token1 (swapped if needed)
      row.innerHTML += `<td>${tokenCell(`Initial${needsSwap ? "Token1" : "Token0"}`)}</td>`;
      row.innerHTML += `<td>${tokenCell(`Final${needsSwap ? "Token1" : "Token0"}`)}</td>`;
      row.innerHTML += `<td>${tokenCell(`Initial${needsSwap ? "Token0" : "Token1"}`)}</td>`;
      row.innerHTML += `<td>${tokenCell(`Final${needsSwap ? "Token0" : "Token1"}`)}</td>`;

      // Δ vs Hold
      const deltaValue = numberOrNull(summary[`${prefix}DeltaVsHoldPercent`]);
      const deltaClass =
        deltaValue === null ? "" : deltaValue === bestDelta ? "value-best" : getValueClass(deltaValue, "Delta");
      row.innerHTML += `<td class="${deltaClass}">${deltaValue === null ? MISSING_PLACEHOLDER : formatPercent(deltaValue)}</td>`;

      // Net PnL
      const pnlValue = numberOrNull(summary[`${prefix}NetPnlPercent`]);
      const pnlClass = pnlValue === null ? "" : pnlValue === bestPnl ? "value-best" : getValueClass(pnlValue, "Pnl");
      row.innerHTML += `<td class="${pnlClass}">${pnlValue === null ? MISSING_PLACEHOLDER : formatPercent(pnlValue)}</td>`;

      // Donation: share of the final position that came from the
      // exogenous donation stream (already subtracted from Δ vs Hold
      // and Net PnL). Always rendered with an explicit "+" so the
      // subsidy reads as an addition on top of the net numbers; "—"
      // when the run had no donations for this AMM.
      const donationPct = numberOrNull(summary.donationsPercentOfFinal);
      const donationCell =
        donationPct === null || donationPct === 0
          ? MISSING_PLACEHOLDER
          : `+${donationPct.toFixed(2)}%`;
      row.innerHTML += `<td>${donationCell}</td>`;

      tbody.appendChild(row);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Utility Functions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Time series options with UTC timezone
   */
  function resolveTimeAxisSettings() {
    const startTs = Number(metricsData?.metadata?.startTimestamp ?? 0);
    const endTs = Number(metricsData?.metadata?.endTimestamp ?? 0);
    const spanSec = Number.isFinite(startTs) && Number.isFinite(endTs) && endTs > startTs ? endTs - startTs : 0;
    const spanDays = spanSec / 86400;

    if (spanDays >= 540) {
      return {
        unit: "month",
        displayFormats: {
          month: "MMM yyyy",
          day: "MMM d, yyyy",
        },
        tickFormatter: (date) => date.toISOString().slice(0, 7), // YYYY-MM
      };
    }

    if (spanDays >= 90) {
      return {
        unit: "week",
        displayFormats: {
          week: "MMM d, yyyy",
          day: "MMM d, yyyy",
        },
        tickFormatter: (date) => date.toISOString().slice(0, 10), // YYYY-MM-DD
      };
    }

    return {
      unit: "day",
      displayFormats: {
        day: "MMM d",
      },
      tickFormatter: (date) => date.toISOString().slice(5, 10), // MM-DD
    };
  }

  function getTimeSeriesOptions(yAxisLabel, beginAtZero = false) {
    const timeAxis = resolveTimeAxisSettings();

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      // Every line series is LTTB-decimated independently server-side, so
      // their x-grids do not line up. Chart.js "index" mode pairs points by
      // array index and would show values from different timestamps in one
      // tooltip. "nearest" along x with intersect:false is the honest
      // alternative: hover shows the single closest real sample.
      interaction: {
        mode: "nearest",
        axis: "x",
        intersect: false,
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: "#c9d1d9",
            usePointStyle: true,
            pointStyle: "line",
          },
        },
        tooltip: {
          mode: "nearest",
          axis: "x",
          intersect: false,
          callbacks: {
            // Format tooltip time in UTC
            title: function (context) {
              const timestamp = context[0].parsed.x;
              return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19) + " UTC";
            },
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            unit: timeAxis.unit,
            displayFormats: timeAxis.displayFormats,
            // Note: for full UTC support, use chartjs-adapter-luxon
            // with timezone: 'UTC'. Current implementation shows UTC in tooltips.
          },
          ticks: {
            color: "#8b949e",
            callback: function (value) {
              const date = new Date(value);
              return timeAxis.tickFormatter(date);
            },
          },
          grid: { color: "#30363d" },
        },
        y: {
          title: {
            display: true,
            text: yAxisLabel,
            color: "#8b949e",
          },
          ticks: { color: "#8b949e" },
          grid: { color: "#30363d" },
          beginAtZero,
          // Fixed axis width keeps every time-series chart's plot area
          // pixel-aligned — required for the anchor-deviation strip to
          // line up with Price History above it.
          afterFit: (scale) => {
            scale.width = 64;
          },
        },
      },
    };
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function formatNumber(num) {
    if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(1) + "M";
    }
    if (num >= 1_000) {
      return (num / 1_000).toFixed(1) + "K";
    }
    return num.toFixed(0);
  }

  function formatTokenAmount(num) {
    if (num >= 1_000_000) {
      return (num / 1_000_000).toFixed(2) + "M";
    }
    if (num >= 1_000) {
      return (num / 1_000).toFixed(2) + "K";
    }
    if (num >= 1) {
      return num.toFixed(4);
    }
    return num.toFixed(6);
  }

  function formatPercent(value) {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  function getValueClass(value, key) {
    if (key.includes("Il") || key.includes("IL")) {
      return value < 0 ? "value-negative" : "value-positive";
    }
    if (key.includes("Pnl") || key.includes("Fees") || key.includes("Delta")) {
      return value >= 0 ? "value-positive" : "value-negative";
    }
    return "value-neutral";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Push the authoritative JS color map into the CSS custom properties
   * consumed by styles.css (AMM dots, marker-toggle accents), so exactly one
   * definition of each color exists at runtime.
   */
  function applyCssColorVars() {
    const style = document.documentElement.style;
    style.setProperty("--equilibra-color", AMM_COLORS.equilibra);
    style.setProperty("--uniswap-color", AMM_COLORS.uniswapV2);
    style.setProperty("--curve-color", AMM_COLORS.curve);
    style.setProperty("--recenter-marker-color", RECENTER_MARKER_COLOR);
  }

  async function init() {
    // Fail-loud backstop: with vendored assets this only fires if the
    // report bundle is incomplete, and it must not leave spinners stuck.
    if (typeof Chart === "undefined") {
      showFatalBanner("Chart.js failed to load — report assets are incomplete (vendor/chart.umd.min.js missing?).");
      return;
    }

    applyCssColorVars();

    try {
      await loadData();
    } catch (error) {
      console.error("Failed to load data:", error);
      showFatalBanner(`Failed to load report data: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    initializeUI();
    ensureSpinners();
    renderChartsAsync().catch(reportRenderFailure);
    updateAllTables();
  }

  // Start when DOM is ready
  document.addEventListener("DOMContentLoaded", init);
}
