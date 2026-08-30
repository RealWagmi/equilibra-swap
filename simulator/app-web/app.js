(function () {
  const app = document.getElementById("app");
  if (!app) return;

  // All localStorage keys used by the dashboard live under the `equinova.`
  // namespace so this app never collides with the sibling equilibra-swap
  // project on the same origin (localhost).
  //
  // SETUP draft format is a versioned envelope
  // `{configVersion, defaultsHash, overrides}`. `overrides` stores ONLY the
  // whitelist of UI-controlled paths (see EDITABLE_DRAFT_PATHS below).
  // Every other field in
  // BenchmarkRunConfig always comes fresh from simulator/src/app/config.rs
  // via /api/config/default, so non-UI defaults cannot be silently
  // overridden by a stale draft.
  // V1.5 cut: bump the setup-draft key because the editable fields
  // shape changed (single `alpha` ⇒ two-knob `aWad` / `lambdaWad`). The
  // visualizer snapshot key was already bumped to `.v2` during the
  // two-knob rollout; keep both in lockstep so a stale `.v1` draft
  // can never silently feed a malformed `alpha` back into the Setup
  // form.
  const SETUP_DRAFT_KEY = "equinova.benchmark.setup.draft.v2";
  const VIS_ALPHA_BETA_KEY = "equinova.visualizer.alphaBeta.v2";
  const VIS_CURVE_KEY = "equinova.visualizer.curvePreset.v1";
  // Collapsed-state of the per-AMM Setup blocks, persisted across
  // page reloads. Equilibra is always rendered expanded; UniswapV2
  // and the YieldBasis reference AMM default to collapsed so the Run
  // button stays above the fold.
  const SETUP_COLLAPSED_KEY = "equinova.benchmark.setup.collapsed.v1";
  const DEFAULT_COLLAPSED_SECTIONS = { uniswapV2: true, curve: true };

  function loadCollapsedSections() {
    try {
      const raw = localStorage.getItem(SETUP_COLLAPSED_KEY);
      if (!raw) return { ...DEFAULT_COLLAPSED_SECTIONS };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return { ...DEFAULT_COLLAPSED_SECTIONS };
      }
      return {
        uniswapV2: !!parsed.uniswapV2,
        curve: !!parsed.curve,
      };
    } catch {
      return { ...DEFAULT_COLLAPSED_SECTIONS };
    }
  }

  function saveCollapsedSections(value) {
    try {
      localStorage.setItem(SETUP_COLLAPSED_KEY, JSON.stringify(value));
    } catch {
      /* swallow — purely UI persistence, fine to lose on quota errors */
    }
  }

  const state = {
    defaults: null,
    defaultsHash: null,
    config: null,
    // Validation limits fetched once from /api/config/limits (the server
    // derives them from the same constants validate_run_config enforces).
    // `null` until the fetch succeeds; `limitsError` carries the failure
    // reason so the Setup page can render a prominent banner and disable
    // submission instead of silently falling back to hardcoded bounds.
    limits: null,
    limitsError: null,
    cleanup: null,
    collapsedSections: loadCollapsedSections(),
  };
  const MAXIMUM_SPEED_TITLE = "Maximum speed";
  // Licensing: user-facing prose must not name the third-party AMM project
  // the reference implementation derives from. Internal identifiers (config
  // keys under `amms.curve.*`, CSS classes, element ids, localStorage keys)
  // intentionally keep the legacy `curve` naming. "Curve Lab" is this
  // dashboard's own visualizer page name and stays as-is.
  const CUBIC_D_SHORT = "YieldBasis";
  const CUBIC_D_LONG = "YieldBasis reference AMM";
  // Two-letter column label for the Runs table, derived from the same
  // neutral display name (NOT the third-party project's token ticker).
  const CUBIC_D_TABLE_LABEL = "YB";
  const SECTION_DISPLAY_NAME = {
    uniswapV2: "UniswapV2",
    curve: CUBIC_D_SHORT,
  };
  const GLOBAL_REBALANCE_PATHS = [
    "amms.equilibra.presets.WETH.rebalanceEnabled",
    "amms.equilibra.presets.WBTC.rebalanceEnabled",
    "amms.curve.presets.WETH.rebalanceEnabled",
    "amms.curve.presets.WBTC.rebalanceEnabled",
    "amms.uniswapV2.rebalanceEnabled",
  ];
  // Whitelist of run-config paths that the SETUP UI actually owns. Kept in
  // sync with the `data-path="..."` attributes rendered by renderSetup() and
  // with the special-purpose handlers (period dates, global rebalance toggle,
  // Curve-Lab import buttons). Every other field in BenchmarkRunConfig must
  // always come from `build_default_config` in simulator/src/app/config.rs.
  //
  // IMPORTANT: if you add a new editable field to SETUP, add the matching
  // path here as well — otherwise user edits will silently disappear on
  // reload.
  const EDITABLE_DRAFT_PATHS = [
    // Simulation period (date pickers -> applyPeriodToConfig).
    "simulation.startTimestamp",
    "simulation.endTimestamp",
    // Liquidity.
    "liquidity.passiveLpInitialUsd",
    // AMM on/off toggles.
    "amms.equilibra.enabled",
    "amms.uniswapV2.enabled",
    "amms.curve.enabled",
    // Equilibra pair layout, per preset: which slot the base token
    // occupies ("token0" = mainnet address-sort layout). Equilibra
    // only — the Curve baseline always keeps the quote in slot 0.
    "amms.equilibra.presets.WETH.baseTokenPosition",
    "amms.equilibra.presets.WBTC.baseTokenPosition",
    // Global rebalance (single checkbox fans out to these 5 sub-paths).
    ...GLOBAL_REBALANCE_PATHS,
    // Equilibra presets (WETH). V1.5 two-knob kernel: `aWad` is the
    // depth-at-anchor knob, `lambdaWad` is the plateau-width knob —
    // both are independently editable from the Setup form, and both
    // are imported as a pair from Curve Lab.
    "amms.equilibra.presets.WETH.aWad",
    "amms.equilibra.presets.WETH.lambdaWad",
    "amms.equilibra.presets.WETH.feeBps",
    "amms.equilibra.presets.WETH.feeRampBps",
    "amms.equilibra.presets.WETH.feeFloorBps",
    "amms.equilibra.presets.WETH.repegShareBps",
    "amms.equilibra.presets.WETH.emaPeriod",
    "amms.equilibra.presets.WETH.repegStepWad",
    "amms.equilibra.presets.WETH.repegThresholdToken1UpWad",
    "amms.equilibra.presets.WETH.repegThresholdToken1DownWad",
    "amms.equilibra.presets.WETH.protocolFeePercent",
    "amms.equilibra.presets.WETH.donationAprBps",
    "amms.equilibra.presets.WETH.donationIntervalSec",
    // Equilibra presets (WBTC).
    "amms.equilibra.presets.WBTC.aWad",
    "amms.equilibra.presets.WBTC.lambdaWad",
    "amms.equilibra.presets.WBTC.feeBps",
    "amms.equilibra.presets.WBTC.feeRampBps",
    "amms.equilibra.presets.WBTC.feeFloorBps",
    "amms.equilibra.presets.WBTC.repegShareBps",
    "amms.equilibra.presets.WBTC.emaPeriod",
    "amms.equilibra.presets.WBTC.repegStepWad",
    "amms.equilibra.presets.WBTC.repegThresholdToken1UpWad",
    "amms.equilibra.presets.WBTC.repegThresholdToken1DownWad",
    "amms.equilibra.presets.WBTC.protocolFeePercent",
    "amms.equilibra.presets.WBTC.donationAprBps",
    "amms.equilibra.presets.WBTC.donationIntervalSec",
    // UniswapV2.
    "amms.uniswapV2.feeBps",
    // YieldBasis reference-AMM math mode + presets (WETH).
    "amms.curve.mathMode",
    "amms.curve.presets.WETH.A",
    "amms.curve.presets.WETH.gamma",
    "amms.curve.presets.WETH.midFee",
    "amms.curve.presets.WETH.outFee",
    "amms.curve.presets.WETH.feeGamma",
    "amms.curve.presets.WETH.adjustmentStepMin",
    "amms.curve.presets.WETH.adjustmentStepMax",
    "amms.curve.presets.WETH.reservedProfitFraction",
    "amms.curve.presets.WETH.maTime",
    "amms.curve.presets.WETH.donationAprBps",
    "amms.curve.presets.WETH.donationIntervalSec",
    // YieldBasis reference-AMM presets (WBTC).
    "amms.curve.presets.WBTC.A",
    "amms.curve.presets.WBTC.gamma",
    "amms.curve.presets.WBTC.midFee",
    "amms.curve.presets.WBTC.outFee",
    "amms.curve.presets.WBTC.feeGamma",
    "amms.curve.presets.WBTC.adjustmentStepMin",
    "amms.curve.presets.WBTC.adjustmentStepMax",
    "amms.curve.presets.WBTC.reservedProfitFraction",
    "amms.curve.presets.WBTC.maTime",
    "amms.curve.presets.WBTC.donationAprBps",
    "amms.curve.presets.WBTC.donationIntervalSec",
  ];

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function esc(v) {
    return String(v)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function fmtDate(v) {
    if (!v) return "-";
    try {
      return new Date(v).toLocaleString();
    } catch {
      return String(v);
    }
  }

  function tsToDateInput(tsSec) {
    const d = new Date(Number(tsSec) * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function dateInputToStartTs(dateStr) {
    const ms = Date.parse(`${dateStr}T00:00:00Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  }

  function dateInputToEndTs(dateStr) {
    const ms = Date.parse(`${dateStr}T23:59:59Z`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    let parseErr = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      parseErr = e;
    }

    if (!res.ok) {
      const msg = json?.error || text || `HTTP ${res.status}`;
      const err = new Error(msg);
      // Expose the HTTP status so callers can branch on e.g. 404
      // (used by the Run page's stream-loss fallback poll).
      err.status = res.status;
      throw err;
    }
    if (parseErr) {
      // A 2xx response with a corrupt/truncated JSON body must surface
      // as the real error, not as a later unrelated TypeError on null.
      throw new Error(`Malformed JSON from ${url} (HTTP ${res.status}): ${parseErr.message}`);
    }
    return json;
  }

  // Route ALL status-message writes through this helper so the
  // `.msg-error` emphasis class is guaranteed to be cleared again on the
  // next informational write (a one-off classList.add would leave the
  // error styling stale once e.g. "Starting run..." follows a failure).
  function setMsg(el, text, isError = false) {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("msg-error", !!isError);
  }

  // Per-field validation feedback: red border on the input plus a small
  // red message rendered directly under it.
  function setFieldError(input, message) {
    input.classList.add("input-invalid");
    let msgNode = input.nextElementSibling;
    if (!msgNode || !msgNode.classList?.contains("field-error-msg")) {
      msgNode = document.createElement("div");
      msgNode.className = "field-error-msg";
      input.insertAdjacentElement("afterend", msgNode);
    }
    msgNode.textContent = message;
  }

  function clearFieldError(input) {
    input.classList.remove("input-invalid");
    const msgNode = input.nextElementSibling;
    if (msgNode && msgNode.classList?.contains("field-error-msg")) {
      msgNode.remove();
    }
  }

  // Map an editable config path to its key in the /api/config/limits
  // payload. Only Equilibra preset fields have server-published limits;
  // every other field deliberately gets NO client-side bound and fails
  // open to the server-side validate_run_config (never a JS literal).
  function limitKeyForPath(path) {
    if (!/^amms\.equilibra\.presets\.(WETH|WBTC)\./.test(path)) return null;
    const leaf = path.split(".").pop();
    const map = {
      feeBps: "baseFee",
      feeRampBps: "feeRampBps",
      feeFloorBps: "feeFloorBps",
      repegShareBps: "repegShareBps",
      protocolFeePercent: "protocolFeePercent",
      emaPeriod: "emaPeriod",
      aWad: "aWad",
      lambdaWad: "lambdaWad",
      repegStepWad: "repegStepWad",
      // Both direction dead-bands share one absolute range (the step's
      // [1, 1e18]); the per-side stall guard vs the fee scale is
      // enforced server-side by validate_run_config.
      repegThresholdToken1UpWad: "repegThresholdWad",
      repegThresholdToken1DownWad: "repegThresholdWad",
    };
    return Object.hasOwn(map, leaf) ? map[leaf] : null;
  }

  // Strict field parser. Invalid or EMPTY numeric input produces a
  // per-field validation error instead of silently coercing to 0
  // (`Number("") === 0` is finite, so a cleared field must be rejected
  // explicitly). Returns `{ ok: true, value }` or `{ ok: false, message }`.
  function validateFieldInput(input) {
    const t = input.dataset.type || input.type;
    if (t === "bool" || input.type === "checkbox") {
      return { ok: true, value: !!input.checked };
    }
    const raw = String(input.value ?? "");
    const path = input.dataset.path || "";
    const limitKey = path ? limitKeyForPath(path) : null;
    const lim = limitKey && state.limits && typeof state.limits[limitKey] === "object" ? state.limits[limitKey] : null;

    if (t === "int" || t === "float") {
      if (raw.trim() === "") {
        return { ok: false, message: "required — enter a number" };
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { ok: false, message: "not a number" };
      }
      const value = t === "int" ? Math.trunc(n) : n;
      if (lim) {
        const min = Number(lim.min);
        const max = Number(lim.max);
        if (Number.isFinite(min) && value < min) {
          return { ok: false, message: `must be ≥ ${lim.min}` };
        }
        if (Number.isFinite(max) && value > max) {
          return { ok: false, message: `must be ≤ ${lim.max}` };
        }
      }
      return { ok: true, value };
    }

    if (lim) {
      // WAD-valued field: a base-10 integer string compared as BigInt
      // against the server-published (decimal string) bounds.
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) {
        return { ok: false, message: "must be a base-10 integer (WAD)" };
      }
      try {
        const value = BigInt(trimmed);
        if (lim.min !== undefined && value < BigInt(String(lim.min))) {
          return { ok: false, message: `must be ≥ ${lim.min}` };
        }
        if (lim.max !== undefined && value > BigInt(String(lim.max))) {
          return { ok: false, message: `must be ≤ ${lim.max}` };
        }
      } catch {
        return { ok: false, message: "invalid WAD value" };
      }
      return { ok: true, value: trimmed };
    }

    return { ok: true, value: input.value };
  }

  function parseRoute(pathname) {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    if (path === "/" || path === "/setup") return { page: "setup" };
    if (path === "/visualizer") return { page: "visualizer" };
    if (path === "/runs") return { page: "runs" };
    if (path === "/info") return { page: "info" };

    const runMatch = path.match(/^\/run\/([^/]+)$/);
    if (runMatch) return { page: "run", runId: runMatch[1] };

    const resultsMatch = path.match(/^\/results\/([^/]+)$/);
    if (resultsMatch) return { page: "results", runId: resultsMatch[1] };

    return { page: "setup" };
  }

  function nav(path) {
    history.pushState({}, "", path);
    render();
  }

  function setNavActive() {
    const links = document.querySelectorAll("a[data-nav]");
    const rawPath = location.pathname;
    const path = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    for (const el of links) {
      const href = el.getAttribute("href") || "";
      if (href === "/setup" && (path === "/" || path === "/setup")) {
        el.classList.add("active");
      } else if (href === "/visualizer" && path === "/visualizer") {
        el.classList.add("active");
      } else if (
        href === "/runs" &&
        (path.startsWith("/runs") || path.startsWith("/run/") || path.startsWith("/results/"))
      ) {
        el.classList.add("active");
      } else if (href === "/info" && path.startsWith("/info")) {
        el.classList.add("active");
      } else {
        el.classList.remove("active");
      }
    }
  }

  function renderTopbarAux(route) {
    const aux = document.getElementById("topbarAux");
    if (!aux) return;
    if (route.page === "results") {
      aux.innerHTML = `<a href="/runs" data-nav class="run-history-link">Run history >></a>`;
      return;
    }
    aux.innerHTML = "";
  }

  function getPath(obj, path) {
    return path.split(".").reduce((acc, p) => (acc == null ? undefined : acc[p]), obj);
  }

  function setPath(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (typeof cur[k] !== "object" || cur[k] == null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // Build a minimal partial config containing only values at the given
  // paths. Used by saveSetupDraft / ensureDefaults so the draft never
  // overrides non-editable defaults.
  function pickByPaths(source, paths) {
    const out = {};
    for (const path of paths) {
      const value = getPath(source, path);
      if (value === undefined) continue;
      setPath(out, path, clone(value));
    }
    return out;
  }

  // Shared formatter — given a non-negative BigInt `numerator` and a
  // BigInt `denominator`, return a percentage string for
  // `numerator * 100 / denominator` truncated at 4 decimal places,
  // with trailing zeros (and the trailing decimal point itself) stripped:
  //   • `50` → `"50"`
  //   • `2.2000` → `"2.2"`
  //   • `0.5000` → `"0.5"`
  //   • `0` → `"0"`
  // Returns "n/a" / "invalid" on missing or out-of-range input.
  function _formatPercentNum(numerator, denominator) {
    try {
      if (numerator < 0n) return "invalid";
      const PCT_SCALE = 10_000n; // 4 decimal places of internal precision
      const scaled = (numerator * 100n * PCT_SCALE) / denominator;
      const intPart = (scaled / PCT_SCALE).toString();
      const fracPartRaw = String(scaled % PCT_SCALE).padStart(4, "0");
      const fracPartTrimmed = fracPartRaw.replace(/0+$/, "");
      return fracPartTrimmed ? `${intPart}.${fracPartTrimmed}` : intPart;
    } catch {
      return "invalid";
    }
  }

  // Format a BPS value as a percentage string (no `%` suffix), four
  // decimal places. e.g. `220` → `"2.2000"`, `5000` → `"50.0000"`.
  function bpsToPercentLabel(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "n/a";
    try {
      return _formatPercentNum(BigInt(raw), 10_000n);
    } catch {
      return "invalid";
    }
  }

  // Format a WAD value (1e18 == 100%) as a percentage string. e.g.
  // `5_000_000_000_000_000` (5e15 WAD) → `"0.5000"`.
  function wadToPercentLabel(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "n/a";
    try {
      return _formatPercentNum(BigInt(raw), 1_000_000_000_000_000_000n);
    } catch {
      return "invalid";
    }
  }

  // Format a YieldBasis reference-AMM fee value (1e10 denominator) as a
  // percentage string. e.g. `60_000_000` → `"0.6000"`,
  // `220_000_000` → `"2.2000"`.
  function curveFeeToPercentLabel(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "n/a";
    try {
      return _formatPercentNum(BigInt(raw), 10_000_000_000n);
    } catch {
      return "invalid";
    }
  }

  // Resolve a percent-formatter by short name. Used both at render
  // time (to seed the inline span) and at input-event time (to
  // recompute the span's text live as the user types).
  function _percentFormatterByName(name) {
    if (name === "wad") return wadToPercentLabel;
    if (name === "curveFee") return curveFeeToPercentLabel;
    return bpsToPercentLabel;
  }

  // Render a `<span>` that carries a live percent readout for the
  // given config `path`. The span is bound to its source input via
  // the matching `data-pct-for` attribute; the input event handler
  // (see `renderSetup` below) re-runs the formatter on every
  // keystroke so the user sees the percent update without losing
  // focus to a full re-render.
  function pctSpan(path, fmtName, value) {
    const fn = _percentFormatterByName(fmtName);
    return `<span data-pct-for="${esc(path)}" data-pct-fmt="${esc(fmtName)}">${esc(fn(value))}</span>`;
  }

  function readVisualizerAlphaBetaMap() {
    try {
      const raw = localStorage.getItem(VIS_ALPHA_BETA_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function readVisualizerCurveMap() {
    try {
      const raw = localStorage.getItem(VIS_CURVE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function deepMerge(base, patch) {
    if (Array.isArray(base) || Array.isArray(patch)) {
      return clone(patch ?? base);
    }
    if (typeof base !== "object" || base == null || typeof patch !== "object" || patch == null) {
      return patch === undefined ? clone(base) : clone(patch);
    }
    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(patch)]);
    for (const k of keys) {
      out[k] = deepMerge(base[k], patch[k]);
    }
    return out;
  }

  function sanitizePresetMap(presets) {
    if (!presets || typeof presets !== "object" || Array.isArray(presets)) {
      return {};
    }
    const out = {};
    if (Object.hasOwn(presets, "WETH")) {
      out.WETH = presets.WETH;
    }
    if (Object.hasOwn(presets, "WBTC")) {
      out.WBTC = presets.WBTC;
    }
    return out;
  }

  function sanitizeSetupConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return cfg;
    if (cfg?.amms?.equilibra && typeof cfg.amms.equilibra === "object") {
      cfg.amms.equilibra.presets = sanitizePresetMap(cfg.amms.equilibra.presets);
    }
    if (cfg?.amms?.curve && typeof cfg.amms.curve === "object") {
      cfg.amms.curve.presets = sanitizePresetMap(cfg.amms.curve.presets);
    }
    normalizeGlobalRebalanceConfig(cfg);
    return cfg;
  }

  function readGlobalRebalanceEnabled(cfg) {
    if (!cfg || typeof cfg !== "object") return true;
    for (const path of GLOBAL_REBALANCE_PATHS) {
      if (getPath(cfg, path) === false) {
        return false;
      }
    }
    return true;
  }

  function setGlobalRebalanceEnabled(cfg, enabled) {
    if (!cfg || typeof cfg !== "object") return;
    const value = !!enabled;
    for (const path of GLOBAL_REBALANCE_PATHS) {
      setPath(cfg, path, value);
    }
  }

  function normalizeGlobalRebalanceConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return cfg;
    setGlobalRebalanceEnabled(cfg, readGlobalRebalanceEnabled(cfg));
    return cfg;
  }

  function saveSetupDraft() {
    try {
      if (!state.config) return;
      sanitizeSetupConfig(state.config);
      // Persist ONLY the whitelisted UI-editable paths. Anything else must
      // come from the backend default config (simulator/src/app/config.rs)
      // on every reload, so a stale draft can never override it.
      if (!state.defaultsHash || !state.defaults?.version) return;
      const overrides = pickByPaths(state.config, EDITABLE_DRAFT_PATHS);
      localStorage.setItem(
        SETUP_DRAFT_KEY,
        JSON.stringify({
          configVersion: state.defaults.version,
          defaultsHash: state.defaultsHash,
          overrides,
        })
      );
    } catch {
      // ignore storage failures
    }
  }

  function computeEnabledAmmCount(config) {
    let n = 0;
    if (config?.amms?.equilibra?.enabled) n += 1;
    if (config?.amms?.uniswapV2?.enabled) n += 1;
    if (config?.amms?.curve?.enabled) n += 1;
    return n;
  }

  function computeWorkersForMaximumSpeed(enabledAmmCount) {
    const amms = Math.max(0, Number(enabledAmmCount) || 0);
    // The worker cap is the backend default (ParallelCfg.max_workers in
    // simulator/src/app/config.rs) served by /api/config/default — never
    // a UI literal. Fail loudly on API contract breakage.
    const cap = Number(state.defaults?.parallel?.maxWorkers);
    if (!Number.isFinite(cap) || cap < 1) {
      throw new Error("defaults.parallel.maxWorkers missing from /api/config/default");
    }
    return Math.max(1, Math.min(cap, amms * 2));
  }

  async function ensureDefaults() {
    if (!state.defaults || !state.config) {
      const payload = await fetchJson("/api/config/default");
      if (
        !payload?.config ||
        typeof payload.config.version !== "string" ||
        typeof payload.defaultsHash !== "string" ||
        !payload.defaultsHash
      ) {
        throw new Error("/api/config/default is missing config version or defaultsHash");
      }
      state.defaults = payload.config;
      state.defaultsHash = payload.defaultsHash;
      let cfg = clone(payload.config);
      try {
        const raw = localStorage.getItem(SETUP_DRAFT_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (
            saved?.configVersion === payload.config.version &&
            saved?.defaultsHash === payload.defaultsHash &&
            saved?.overrides &&
            typeof saved.overrides === "object"
          ) {
            // Only merge whitelisted UI paths from a draft tied to this
            // exact schema/default snapshot. Raw legacy drafts and drafts
            // from a changed preset library are invalidated, not migrated
            // by guessing which old values remain meaningful.
            const overlay = pickByPaths(saved.overrides, EDITABLE_DRAFT_PATHS);
            cfg = deepMerge(cfg, overlay);
          } else {
            localStorage.removeItem(SETUP_DRAFT_KEY);
          }
        }
      } catch {
        // ignore malformed persisted draft
      }
      sanitizeSetupConfig(cfg);
      state.config = cfg;
      saveSetupDraft();
    }
    if (!state.limits) {
      // Input bounds come from the server (single source of truth in
      // simulator/src/app/config.rs). On failure the Setup page renders a
      // prominent banner and disables run submission — it never falls
      // back to hardcoded client-side bounds. Retried on every render
      // until it succeeds.
      try {
        const payload = await fetchJson("/api/config/limits");
        const limits = payload?.limits;
        if (!limits || typeof limits !== "object") {
          throw new Error("response has no `limits` object");
        }
        state.limits = limits;
        state.limitsError = null;
      } catch (e) {
        state.limits = null;
        state.limitsError = String(e?.message || e);
      }
    }
  }

  // ── Equilibra parameter explainers ─────────────────────────────
  // One "i" badge per Equilibra field (both preset columns share a key).
  // A single fixed-position panel serves all badges: it lives on
  // document.body so renderSetup() re-renders cannot orphan it, and it is
  // closed on re-render, outside click, Escape, scroll and resize.
  // Content mirrors the factory bounds and the CLAUDE.md parameter table —
  // when a bound changes there, update the matching entry here.
  const EQ_PARAM_INFO = {
    baseTokenPosition: {
      t: "Base token slot",
      b: "Which pair slot holds the base token. <code>token0</code> matches the mainnet address sort (WETH and WBTC sort before USDT); <code>token1</code> keeps the quote in slot 0. Equilibra only — the Curve baseline always models its quote as token0. Flipping it mirrors the internal token1 direction, so the two repeg dead-bands swap roles (see their notes).",
    },
    aWad: {
      t: "a — depth at anchor (WAD)",
      b: "At the anchor the amplification equals <code>a</code>: larger values deepen the central plateau, concentrating depth near the anchor price. Range <code>[1e17, 99e16]</code> (0.1–0.99 of WAD). Fully decoupled from λ — moving <code>a</code> never shifts the cliff position. <code>a = 1e18</code> is forbidden: the depth solve degenerates at pure constant-sum.",
    },
    lambdaWad: {
      t: "λ — plateau width (WAD)",
      b: "At <code>λ·D = WAD</code> the amplification halves. Larger λ narrows the plateau (earlier hand-off to the constant-product tail); smaller widens it. Range <code>[1e15, 1e18]</code>. Subtlety: with <code>a</code> near its ceiling, the bottom decade of λ makes the swap solver miss on trades larger than the output-side reserve — check the solver lamp in Curve Lab for the live safe price range, and prefer <code>λ ≥ 1e16</code> at high <code>a</code>.",
    },
    feeBps: {
      t: "Fee ceiling (bps)",
      b: "Ceiling of the dynamic swap fee, in bps of the input. Range <code>[5, 2000]</code>. With the ramp off this is simply the flat fee; with a live ramp the per-swap fee climbs from the floor toward this value as the post-swap state distance grows.",
    },
    feeRampBps: {
      t: "Fee ramp width (bps)",
      b: "Smoothstep warm-up width, in bps of one full state-distance unit. <code>0</code> disables the ramp — every swap pays the flat ceiling. Counter-intuitive: <code>10000</code> is the WIDEST ramp, so most swaps pay near the floor; to bias fees high pick a SMALL ramp (≤ 100). A live ramp must clear the monotonicity guard <code>ramp·(10000−ceiling)² ≥ 12·10000·(ceiling−floor)²</code>, and floor == ceiling with a live ramp is rejected outright.",
    },
    feeFloorBps: {
      t: "Fee floor (bps)",
      b: "Lower bound of the dynamic fee; tiny mean-reverting flow near the anchor pays this. Range <code>[0, ceiling]</code>; equality with the ceiling is allowed only when the ramp is off. With auto-repeg live the floor also sets the stall-guard scale: each repeg dead-band must stay ≤ <code>floor·1e14</code> (flat ceiling when the ramp is off), so a floor of 0 with a live ramp is undeployable while auto-repeg is on.",
    },
    repegShareBps: {
      t: "Repeg budget share (bps)",
      b: "Share of accumulated LP unit-value growth the auto-repeg gate may spend on anchor moves. <code>0</code> disables auto-repeg entirely; <code>5000</code> is the conservative 50/50 reference. Bounded by <code>share + protocolFee·100 ≤ 10000</code>. Calibration from the benchmark runs: ~7000 without a donation stream, ~5000–5500 alongside a 3–4 %/yr stream.",
    },
    emaPeriod: {
      t: "EMA period (s)",
      b: "Half-life of the geometric price EMA the anchor follows, in seconds. Range <code>[60, 419731]</code> (≈ 4.86 days). Longer periods are harder to manipulate through the oracle but track repricings more slowly. Immutable after pool creation on chain — treat it as a launch decision, not a tuning knob.",
    },
    donationAprBps: {
      t: "Donation stream (bps of TVL per year; 0 = off)",
      b: "Exogenous donation stream: at every tick the donor makes a proportional deposit and parks the minted LP shares on the pool itself. That parked buffer funds the donation parachute — the mechanism that keeps the anchor tracking after the fee-growth budget is exhausted. <code>0</code> disables the stream.",
    },
    donationIntervalSec: {
      t: "Donation interval (s)",
      b: "Seconds between donation ticks; the first tick lands at t = 0 and each tranche funds exactly the elapsed gap. Capped at one year. With the APR at 0 the interval is canonicalized to 0 — the pair is validated together.",
    },
    repegStepWad: {
      t: "Repeg step cap (WAD)",
      b: "Per-repeg cap on the log-domain anchor step, committed as <code>priceScale·exp(±applied)</code> with <code>applied = min(cap, deviation/5)</code> — at most once per block and never more than once per second. Bounds the anchor's slew rate and therefore its manipulability through the EMA. Sizing note: a cap far below expected daily move ÷ swaps per day leaves the anchor bandwidth-limited in fast repricings.",
    },
    repegThresholdUp: {
      t: "Dead-band, token1 up (WAD)",
      b: "Auto-repeg activation dead-band while <code>ema &gt; priceScale</code> — token1 priced ABOVE the anchor. Geometric deviation, so ±2× reads 1.0 either way. Layout subtlety: with the base in slot 0 a RISING base market is an internal token1-DOWN move, so bull-market catch-up is tuned by the Down knob; this one damps drawdown tracking. Stall guard: with auto-repeg live each band must stay ≤ <code>feeScale·1e14</code> or the first permitted move is already unaffordable and the anchor stalls.",
    },
    repegThresholdDown: {
      t: "Dead-band, token1 down (WAD)",
      b: "Same dead-band for <code>ema &lt; priceScale</code> — with the base in slot 0 this is the base asset RISING. Setting Down &lt; Up chases base rallies more eagerly than drawdowns (momentum asymmetry; the bundled presets ship 2.5e15 / 1.5e15). Pegged pools prefer tiny symmetric bands (1e14) instead — the split is a volatile-pair tool. Same stall-guard rule as the Up band.",
    },
    protocolFeePercent: {
      t: "Protocol fee (%)",
      b: "Protocol slice of every swap fee, in PERCENT — not bps. Range <code>[0, 25]</code>. Funded from the LPs' residual, not from the repeg budget: two pools differing only in this value fire repegs after the same total volume.",
    },
  };

  function eqInfo(key) {
    return `<button type="button" class="eq-info-btn" data-eq-info="${key}" aria-expanded="false" aria-label="About this parameter">i</button>`;
  }

  let eqInfoPopEl = null;
  function ensureEqInfoPop() {
    if (!eqInfoPopEl) {
      eqInfoPopEl = document.createElement("div");
      eqInfoPopEl.className = "eq-info-pop";
      eqInfoPopEl.hidden = true;
      document.body.appendChild(eqInfoPopEl);
    }
    return eqInfoPopEl;
  }
  function closeEqInfo() {
    if (eqInfoPopEl) eqInfoPopEl.hidden = true;
    document
      .querySelectorAll('.eq-info-btn[aria-expanded="true"]')
      .forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
  function openEqInfo(btn, key) {
    const info = EQ_PARAM_INFO[key];
    if (!info) return;
    const pop = ensureEqInfoPop();
    pop.innerHTML = `<h4></h4><p></p>`;
    pop.querySelector("h4").textContent = info.t;
    pop.querySelector("p").innerHTML = info.b;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))}px`;
    let top = r.bottom + 8;
    const h = pop.offsetHeight;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 8);
    pop.style.top = `${top}px`;
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".eq-info-btn");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = btn.getAttribute("aria-expanded") === "true";
      closeEqInfo();
      if (!wasOpen) openEqInfo(btn, btn.dataset.eqInfo);
      return;
    }
    if (eqInfoPopEl && !eqInfoPopEl.hidden && !eqInfoPopEl.contains(e.target)) closeEqInfo();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeEqInfo();
  });
  window.addEventListener("resize", closeEqInfo);
  window.addEventListener("scroll", closeEqInfo, true);

  function renderSetup() {
    closeEqInfo();
    const c = state.config;
    const d = state.defaults;
    const v = (p, f = "") => {
      const x = getPath(c, p);
      return x == null ? f : x;
    };

    const minTs = d.simulation.startTimestamp;
    const maxTs = d.simulation.endTimestamp;
    const minDate = tsToDateInput(minTs);
    const maxDate = tsToDateInput(maxTs);
    const startDate = tsToDateInput(v("simulation.startTimestamp", minTs));
    const endDate = tsToDateInput(v("simulation.endTimestamp", maxTs));
    const eqEnabled = !!v("amms.equilibra.enabled");
    const uniEnabled = !!v("amms.uniswapV2.enabled");
    const curveEnabled = !!v("amms.curve.enabled");
    const globalRebalanceEnabled = readGlobalRebalanceEnabled(c);
    const eqDisabled = eqEnabled ? "" : "disabled";
    const uniDisabled = uniEnabled ? "" : "disabled";
    const curveDisabled = curveEnabled ? "" : "disabled";
    const effectiveOverrides = EDITABLE_DRAFT_PATHS.filter(
      (path) => JSON.stringify(getPath(c, path)) !== JSON.stringify(getPath(d, path))
    );
    const effectiveOverridesHtml = effectiveOverrides.length
      ? effectiveOverrides
          .map((path) => `<li><code>${esc(path)}</code>: <code>${esc(JSON.stringify(getPath(c, path)))}</code></li>`)
          .join("")
      : "<li>No overrides — canonical backend defaults will be used.</li>";
    // Collapsed-state of UniswapV2 / Curve sections. Equilibra is
    // never collapsed (the contract under test always wants its
    // params visible). The state is persisted via
    // `saveCollapsedSections` whenever the user clicks the toggle.
    const uniCollapsed = !!state.collapsedSections.uniswapV2;
    const curveCollapsed = !!state.collapsedSections.curve;
    const uniCollapsedClass = uniCollapsed ? " is-collapsed" : "";
    const curveCollapsedClass = curveCollapsed ? " is-collapsed" : "";
    const uniToggleSym = uniCollapsed ? "+" : "−";
    const curveToggleSym = curveCollapsed ? "+" : "−";
    // Input bounds are interpolated from the server-published limits
    // (/api/config/limits). When the fetch failed there are NO bounds to
    // interpolate and submission is disabled via the banner below —
    // hardcoded fallbacks are forbidden. A limit key that is absent from
    // the payload simply omits the attribute (fails open to server-side
    // validation). The donation-stream pair is the one exception:
    // /api/config/limits does not publish donation bounds, so those two
    // inputs carry literal attributes mirroring `validate_run_config`
    // in config.rs — donationAprBps in [0, 10000]; donationIntervalSec
    // in [60, 31536000] when donations are enabled, with 0 = disabled
    // (the enabled-only lower bound of 60 stays server-side).
    const limitsReady = !!state.limits;
    const limitsBanner = limitsReady
      ? ""
      : `<div class="banner-error">Failed to load input limits from /api/config/limits: ${esc(state.limitsError || "unknown error")}. Field bounds cannot be validated, so run submission is disabled. Fix the backend and reload this page.</div>`;
    const limAttr = (limitKey) => {
      const lim = state.limits && typeof state.limits[limitKey] === "object" ? state.limits[limitKey] : null;
      if (!lim) return "";
      const parts = [];
      if (lim.min !== undefined && lim.min !== null) {
        parts.push(`min="${esc(lim.min)}"`);
      }
      if (lim.max !== undefined && lim.max !== null) {
        parts.push(`max="${esc(lim.max)}"`);
      }
      return parts.join(" ");
    };
    app.innerHTML = `
      <div class="stack">
        ${limitsBanner}
        <section class="card">
          <div class="setup-top-layout">
            <div class="setup-period-col">
              <h3>Simulation Period</h3>
              <div class="period-controls">
                <div class="period-date-grid">
                  <div class="field">
                    <label>Start date (UTC)</label>
                    <input class="period-date-input" id="periodStart" type="date" min="${esc(minDate)}" max="${esc(maxDate)}" value="${esc(startDate)}" />
                  </div>
                  <div class="field">
                    <label>End date (UTC)</label>
                    <input class="period-date-input" id="periodEnd" type="date" min="${esc(minDate)}" max="${esc(maxDate)}" value="${esc(endDate)}" />
                  </div>
                </div>
                <div class="period-preset-actions period-preset-actions-right">
                  <button type="button" class="period-preset-btn" id="periodPresetFull">Full period</button>
                  <button type="button" class="period-preset-btn" id="periodPresetWeek">Week</button>
                  <button type="button" class="period-preset-btn" id="periodPresetMonth">Month</button>
                  <button type="button" class="period-preset-btn" id="periodPreset3Month">3 Month</button>
                </div>
              </div>
              <div class="muted">Available data range: ${esc(minDate)} .. ${esc(maxDate)}.</div>
            </div>

            <div class="setup-runtime-col">
              <div class="runtime-controls-row">
                <div class="field field-compact">
                  <label>Initial liquidity USD (split 50/50)</label>
                  <input data-path="liquidity.passiveLpInitialUsd" data-type="float" type="number" step="1" value="${esc(v("liquidity.passiveLpInitialUsd"))}" />
                </div>
                <div class="field field-compact field-check-inline">
                  <label class="check check-compact" title="Enable or disable recentering/rebalancing for the ${CUBIC_D_LONG} and Equilibra across all presets">
                    <span>Rebalance</span>
                    <input id="globalRebalanceEnabled" type="checkbox" ${globalRebalanceEnabled ? "checked" : ""}/>
                  </label>
                </div>
              </div>
              <div class="muted" id="modeCoresInfo"></div>
            </div>
          </div>

          <section class="preset-zone preset-zone-equilibra ${eqEnabled ? "" : "amm-disabled"}">
            <div class="section-head">
              <h3 class="amm-title amm-title-equilibra">Equilibra</h3>
              <label class="check"><input data-path="amms.equilibra.enabled" data-type="bool" type="checkbox" ${eqEnabled ? "checked" : ""}/></label>
            </div>
            <div class="preset-pair-grid">
              <div class="token-preset-col">
                <div class="token-label-row">
                  <div class="token-label">WETH</div>
                </div>
                <div class="fields-stack">
                  <div class="field">
                    <label>base token slot ${eqInfo("baseTokenPosition")}</label>
                    <select ${eqDisabled} data-path="amms.equilibra.presets.WETH.baseTokenPosition" data-type="string">
                      <option value="token0" ${v("amms.equilibra.presets.WETH.baseTokenPosition") === "token0" ? "selected" : ""}>token0</option>
                      <option value="token1" ${v("amms.equilibra.presets.WETH.baseTokenPosition") === "token1" ? "selected" : ""}>token1</option>
                    </select>
                  </div>
                  <div class="alpha-beta-import-grid">
                    <div class="field">
                      <label>a (WAD) ${eqInfo("aWad")}</label>
                      <input ${eqDisabled} data-path="amms.equilibra.presets.WETH.aWad" data-type="string" value="${esc(v("amms.equilibra.presets.WETH.aWad"))}"/>
                    </div>
                    <div class="field">
                      <label>λ (WAD) ${eqInfo("lambdaWad")}</label>
                      <input ${eqDisabled} data-path="amms.equilibra.presets.WETH.lambdaWad" data-type="string" value="${esc(v("amms.equilibra.presets.WETH.lambdaWad"))}"/>
                    </div>
                    <button ${eqDisabled} class="import-btn" type="button" id="eqImportApplyWETH">Import from Curve Lab</button>
                  </div>
                  <div class="field-row">
                  <div class="field"><label>fee bps (ceiling) : ${pctSpan("amms.equilibra.presets.WETH.feeBps", "bps", v("amms.equilibra.presets.WETH.feeBps"))} % ${eqInfo("feeBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.feeBps" data-type="int" type="number" ${limAttr("baseFee")} step="1" value="${esc(v("amms.equilibra.presets.WETH.feeBps"))}"/></div>
                  <div class="field"><label>fee ramp bps (0 = off) : ${pctSpan("amms.equilibra.presets.WETH.feeRampBps", "bps", v("amms.equilibra.presets.WETH.feeRampBps"))} % ${eqInfo("feeRampBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.feeRampBps" data-type="int" type="number" ${limAttr("feeRampBps")} step="1" value="${esc(v("amms.equilibra.presets.WETH.feeRampBps"))}"/></div>
                  <div class="field"><label>fee floor bps : ${pctSpan("amms.equilibra.presets.WETH.feeFloorBps", "bps", v("amms.equilibra.presets.WETH.feeFloorBps"))} % ${eqInfo("feeFloorBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.feeFloorBps" data-type="int" type="number" ${limAttr("feeFloorBps")} step="1" value="${esc(v("amms.equilibra.presets.WETH.feeFloorBps"))}"/></div>
                  </div>
                  <div class="field"><label>repeg share bps : ${pctSpan("amms.equilibra.presets.WETH.repegShareBps", "bps", v("amms.equilibra.presets.WETH.repegShareBps"))} % ${eqInfo("repegShareBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.repegShareBps" data-type="int" type="number" ${limAttr("repegShareBps")} step="1" value="${esc(v("amms.equilibra.presets.WETH.repegShareBps"))}"/></div>
                  <div class="field"><label>EMA period ${eqInfo("emaPeriod")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.emaPeriod" data-type="int" type="number" ${limAttr("emaPeriod")} step="1" value="${esc(v("amms.equilibra.presets.WETH.emaPeriod"))}"/></div>
                  <div class="field-row">
                  <div class="field"><label>donationAprBps : ${pctSpan("amms.equilibra.presets.WETH.donationAprBps", "bps", v("amms.equilibra.presets.WETH.donationAprBps"))} % ${eqInfo("donationAprBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.donationAprBps" data-type="int" type="number" min="0" max="10000" step="1" value="${esc(v("amms.equilibra.presets.WETH.donationAprBps"))}"/></div>
                  <div class="field"><label>donationIntervalSec ${eqInfo("donationIntervalSec")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.donationIntervalSec" data-type="int" type="number" min="0" max="31536000" step="1" value="${esc(v("amms.equilibra.presets.WETH.donationIntervalSec"))}"/></div>
                  </div>
                  <div class="field-row">
                  <div class="field">
                    <label>repeg step wad : ${pctSpan("amms.equilibra.presets.WETH.repegStepWad", "wad", v("amms.equilibra.presets.WETH.repegStepWad"))} % ${eqInfo("repegStepWad")}</label>
                    <input ${eqDisabled} data-path="amms.equilibra.presets.WETH.repegStepWad" data-type="string" value="${esc(v("amms.equilibra.presets.WETH.repegStepWad"))}"/>
                  </div>
                  <div class="field">
                    <label>repeg threshold token1 up : ${pctSpan("amms.equilibra.presets.WETH.repegThresholdToken1UpWad", "wad", v("amms.equilibra.presets.WETH.repegThresholdToken1UpWad"))} % ${eqInfo("repegThresholdUp")}</label>
                    <input ${eqDisabled} data-path="amms.equilibra.presets.WETH.repegThresholdToken1UpWad" data-type="string" value="${esc(v("amms.equilibra.presets.WETH.repegThresholdToken1UpWad"))}"/>
                  </div>
                  <div class="field">
                    <label>repeg threshold token1 down : ${pctSpan("amms.equilibra.presets.WETH.repegThresholdToken1DownWad", "wad", v("amms.equilibra.presets.WETH.repegThresholdToken1DownWad"))} % ${eqInfo("repegThresholdDown")}</label>
                    <input ${eqDisabled} data-path="amms.equilibra.presets.WETH.repegThresholdToken1DownWad" data-type="string" value="${esc(v("amms.equilibra.presets.WETH.repegThresholdToken1DownWad"))}"/>
                  </div>
                  </div>
                  <div class="field"><label>protocol fee % ${eqInfo("protocolFeePercent")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WETH.protocolFeePercent" data-type="int" type="number" ${limAttr("protocolFeePercent")} step="1" value="${esc(v("amms.equilibra.presets.WETH.protocolFeePercent"))}"/></div>
                </div>
              </div>
              <div class="token-preset-col">
                <div class="token-label-row">
                  <div class="token-label">WBTC</div>
                </div>
                <div class="fields-stack">
                  <div class="field">
                    <label>base token slot ${eqInfo("baseTokenPosition")}</label>
                    <select ${eqDisabled} data-path="amms.equilibra.presets.WBTC.baseTokenPosition" data-type="string">
                      <option value="token0" ${v("amms.equilibra.presets.WBTC.baseTokenPosition") === "token0" ? "selected" : ""}>token0</option>
                      <option value="token1" ${v("amms.equilibra.presets.WBTC.baseTokenPosition") === "token1" ? "selected" : ""}>token1</option>
                    </select>
                  </div>
                  <div class="alpha-beta-import-grid">
                    <div class="field">
                      <label>a (WAD) ${eqInfo("aWad")}</label>
                      <input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.aWad" data-type="string" value="${esc(v("amms.equilibra.presets.WBTC.aWad"))}"/>
                    </div>
                    <div class="field">
                      <label>λ (WAD) ${eqInfo("lambdaWad")}</label>
                      <input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.lambdaWad" data-type="string" value="${esc(v("amms.equilibra.presets.WBTC.lambdaWad"))}"/>
                    </div>
                    <button ${eqDisabled} class="import-btn" type="button" id="eqImportApplyWBTC">Import from Curve Lab</button>
                  </div>
                  <div class="field-row">
                  <div class="field"><label>fee bps (ceiling) : ${pctSpan("amms.equilibra.presets.WBTC.feeBps", "bps", v("amms.equilibra.presets.WBTC.feeBps"))} % ${eqInfo("feeBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.feeBps" data-type="int" type="number" ${limAttr("baseFee")} step="1" value="${esc(v("amms.equilibra.presets.WBTC.feeBps"))}"/></div>
                  <div class="field"><label>fee ramp bps (0 = off) : ${pctSpan("amms.equilibra.presets.WBTC.feeRampBps", "bps", v("amms.equilibra.presets.WBTC.feeRampBps"))} % ${eqInfo("feeRampBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.feeRampBps" data-type="int" type="number" ${limAttr("feeRampBps")} step="1" value="${esc(v("amms.equilibra.presets.WBTC.feeRampBps"))}"/></div>
                  <div class="field"><label>fee floor bps : ${pctSpan("amms.equilibra.presets.WBTC.feeFloorBps", "bps", v("amms.equilibra.presets.WBTC.feeFloorBps"))} % ${eqInfo("feeFloorBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.feeFloorBps" data-type="int" type="number" ${limAttr("feeFloorBps")} step="1" value="${esc(v("amms.equilibra.presets.WBTC.feeFloorBps"))}"/></div>
                  </div>
                  <div class="field"><label>repeg share bps : ${pctSpan("amms.equilibra.presets.WBTC.repegShareBps", "bps", v("amms.equilibra.presets.WBTC.repegShareBps"))} % ${eqInfo("repegShareBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.repegShareBps" data-type="int" type="number" ${limAttr("repegShareBps")} step="1" value="${esc(v("amms.equilibra.presets.WBTC.repegShareBps"))}"/></div>
                  <div class="field"><label>EMA period ${eqInfo("emaPeriod")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.emaPeriod" data-type="int" type="number" ${limAttr("emaPeriod")} step="1" value="${esc(v("amms.equilibra.presets.WBTC.emaPeriod"))}"/></div>
                  <div class="field-row">
                  <div class="field"><label>donationAprBps : ${pctSpan("amms.equilibra.presets.WBTC.donationAprBps", "bps", v("amms.equilibra.presets.WBTC.donationAprBps"))} % ${eqInfo("donationAprBps")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.donationAprBps" data-type="int" type="number" min="0" max="10000" step="1" value="${esc(v("amms.equilibra.presets.WBTC.donationAprBps"))}"/></div>
                  <div class="field"><label>donationIntervalSec ${eqInfo("donationIntervalSec")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.donationIntervalSec" data-type="int" type="number" min="0" max="31536000" step="1" value="${esc(v("amms.equilibra.presets.WBTC.donationIntervalSec"))}"/></div>
                  </div>
                  <div class="field-row">
                  <div class="field">
                    <label>repeg step wad : ${pctSpan("amms.equilibra.presets.WBTC.repegStepWad", "wad", v("amms.equilibra.presets.WBTC.repegStepWad"))} % ${eqInfo("repegStepWad")}</label>
                    <input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.repegStepWad" data-type="string" value="${esc(v("amms.equilibra.presets.WBTC.repegStepWad"))}"/>
                  </div>
                  <div class="field">
                    <label>repeg threshold token1 up : ${pctSpan("amms.equilibra.presets.WBTC.repegThresholdToken1UpWad", "wad", v("amms.equilibra.presets.WBTC.repegThresholdToken1UpWad"))} % ${eqInfo("repegThresholdUp")}</label>
                    <input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.repegThresholdToken1UpWad" data-type="string" value="${esc(v("amms.equilibra.presets.WBTC.repegThresholdToken1UpWad"))}"/>
                  </div>
                  <div class="field">
                    <label>repeg threshold token1 down : ${pctSpan("amms.equilibra.presets.WBTC.repegThresholdToken1DownWad", "wad", v("amms.equilibra.presets.WBTC.repegThresholdToken1DownWad"))} % ${eqInfo("repegThresholdDown")}</label>
                    <input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.repegThresholdToken1DownWad" data-type="string" value="${esc(v("amms.equilibra.presets.WBTC.repegThresholdToken1DownWad"))}"/>
                  </div>
                  </div>
                  <div class="field"><label>protocol fee % ${eqInfo("protocolFeePercent")}</label><input ${eqDisabled} data-path="amms.equilibra.presets.WBTC.protocolFeePercent" data-type="int" type="number" ${limAttr("protocolFeePercent")} step="1" value="${esc(v("amms.equilibra.presets.WBTC.protocolFeePercent"))}"/></div>
                </div>
              </div>
            </div>
          </section>

          <section class="preset-zone${uniCollapsedClass} ${uniEnabled ? "" : "amm-disabled"}">
            <div class="section-head">
              <button type="button" class="section-toggle" data-section-toggle="uniswapV2" aria-label="${uniCollapsed ? "Expand" : "Collapse"} UniswapV2">${uniToggleSym}</button>
              <h3 class="amm-title amm-title-uniswap">UniswapV2</h3>
              <label class="check"><input data-path="amms.uniswapV2.enabled" data-type="bool" type="checkbox" ${uniEnabled ? "checked" : ""}/></label>
            </div>
            <div class="section-grid">
              <div class="field"><label>fee bps</label><input ${uniDisabled} data-path="amms.uniswapV2.feeBps" data-type="int" type="number" step="1" value="${esc(v("amms.uniswapV2.feeBps"))}" /></div>
            </div>
          </section>

          <section class="preset-zone preset-zone-curve${curveCollapsedClass} ${curveEnabled ? "" : "amm-disabled"}">
            <div class="section-head">
              <button type="button" class="section-toggle" data-section-toggle="curve" aria-label="${curveCollapsed ? "Expand" : "Collapse"} ${CUBIC_D_SHORT}">${curveToggleSym}</button>
              <h3 class="amm-title amm-title-curve">${CUBIC_D_SHORT}</h3>
              <label class="check"><input data-path="amms.curve.enabled" data-type="bool" type="checkbox" ${curveEnabled ? "checked" : ""}/></label>
            </div>
            <div class="section-grid">
              <div class="field">
                <label>${CUBIC_D_SHORT} math mode</label>
                <select ${curveDisabled} data-path="amms.curve.mathMode" data-type="string">
                  <option value="crypto" ${v("amms.curve.mathMode") === "crypto" ? "selected" : ""}>crypto</option>
                  <option value="stableswap" ${v("amms.curve.mathMode") === "stableswap" ? "selected" : ""}>stableswap</option>
                </select>
              </div>
            </div>
            <div class="preset-pair-grid">
              <div class="token-preset-col">
                <div class="token-label-row">
                  <div class="token-label">WETH</div>
                </div>
                <div class="fields-stack">
                  <div class="alpha-beta-import-grid">
                    <div class="field"><label>A</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.A" data-type="int" type="number" value="${esc(v("amms.curve.presets.WETH.A"))}"/></div>
                    <button ${curveDisabled} class="import-btn" type="button" id="curveImportApplyWETH">Import from Curve Lab</button>
                    <div class="field"><label>gamma</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.gamma" data-type="string" value="${esc(v("amms.curve.presets.WETH.gamma"))}"/></div>
                  </div>
                  <div class="field"><label>midFee : ${pctSpan("amms.curve.presets.WETH.midFee", "curveFee", v("amms.curve.presets.WETH.midFee"))} %</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.midFee" data-type="string" value="${esc(v("amms.curve.presets.WETH.midFee"))}"/></div>
                  <div class="field"><label>outFee : ${pctSpan("amms.curve.presets.WETH.outFee", "curveFee", v("amms.curve.presets.WETH.outFee"))} %</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.outFee" data-type="string" value="${esc(v("amms.curve.presets.WETH.outFee"))}"/></div>
                  <div class="field"><label>feeGamma</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.feeGamma" data-type="string" value="${esc(v("amms.curve.presets.WETH.feeGamma"))}"/></div>
                  <div class="field"><label>adjustmentStepMin</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.adjustmentStepMin" data-type="string" value="${esc(v("amms.curve.presets.WETH.adjustmentStepMin"))}"/></div>
                  <div class="field"><label>adjustmentStepMax</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.adjustmentStepMax" data-type="string" value="${esc(v("amms.curve.presets.WETH.adjustmentStepMax"))}"/></div>
                  <div class="field"><label>reservedProfitFraction</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.reservedProfitFraction" data-type="string" value="${esc(v("amms.curve.presets.WETH.reservedProfitFraction"))}"/></div>
                  <div class="field"><label>maTime</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.maTime" data-type="int" type="number" value="${esc(v("amms.curve.presets.WETH.maTime"))}"/></div>
                  <div class="field-row">
                  <div class="field"><label>donationAprBps : ${pctSpan("amms.curve.presets.WETH.donationAprBps", "bps", v("amms.curve.presets.WETH.donationAprBps"))} % of TVL/yr (0 = off)</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.donationAprBps" data-type="int" type="number" min="0" max="10000" step="1" value="${esc(v("amms.curve.presets.WETH.donationAprBps"))}"/></div>
                  <div class="field"><label>donationIntervalSec</label><input ${curveDisabled} data-path="amms.curve.presets.WETH.donationIntervalSec" data-type="int" type="number" min="0" max="31536000" step="1" value="${esc(v("amms.curve.presets.WETH.donationIntervalSec"))}"/></div>
                  </div>
                </div>
              </div>
              <div class="token-preset-col">
                <div class="token-label-row">
                  <div class="token-label">WBTC</div>
                </div>
                <div class="fields-stack">
                  <div class="alpha-beta-import-grid">
                    <div class="field"><label>A</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.A" data-type="int" type="number" value="${esc(v("amms.curve.presets.WBTC.A"))}"/></div>
                    <button ${curveDisabled} class="import-btn" type="button" id="curveImportApplyWBTC">Import from Curve Lab</button>
                    <div class="field"><label>gamma</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.gamma" data-type="string" value="${esc(v("amms.curve.presets.WBTC.gamma"))}"/></div>
                  </div>
                  <div class="field"><label>midFee : ${pctSpan("amms.curve.presets.WBTC.midFee", "curveFee", v("amms.curve.presets.WBTC.midFee"))} %</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.midFee" data-type="string" value="${esc(v("amms.curve.presets.WBTC.midFee"))}"/></div>
                  <div class="field"><label>outFee : ${pctSpan("amms.curve.presets.WBTC.outFee", "curveFee", v("amms.curve.presets.WBTC.outFee"))} %</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.outFee" data-type="string" value="${esc(v("amms.curve.presets.WBTC.outFee"))}"/></div>
                  <div class="field"><label>feeGamma</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.feeGamma" data-type="string" value="${esc(v("amms.curve.presets.WBTC.feeGamma"))}"/></div>
                  <div class="field"><label>adjustmentStepMin</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.adjustmentStepMin" data-type="string" value="${esc(v("amms.curve.presets.WBTC.adjustmentStepMin"))}"/></div>
                  <div class="field"><label>adjustmentStepMax</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.adjustmentStepMax" data-type="string" value="${esc(v("amms.curve.presets.WBTC.adjustmentStepMax"))}"/></div>
                  <div class="field"><label>reservedProfitFraction</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.reservedProfitFraction" data-type="string" value="${esc(v("amms.curve.presets.WBTC.reservedProfitFraction"))}"/></div>
                  <div class="field"><label>maTime</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.maTime" data-type="int" type="number" value="${esc(v("amms.curve.presets.WBTC.maTime"))}"/></div>
                  <div class="field-row">
                  <div class="field"><label>donationAprBps : ${pctSpan("amms.curve.presets.WBTC.donationAprBps", "bps", v("amms.curve.presets.WBTC.donationAprBps"))} % of TVL/yr (0 = off)</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.donationAprBps" data-type="int" type="number" min="0" max="10000" step="1" value="${esc(v("amms.curve.presets.WBTC.donationAprBps"))}"/></div>
                  <div class="field"><label>donationIntervalSec</label><input ${curveDisabled} data-path="amms.curve.presets.WBTC.donationIntervalSec" data-type="int" type="number" min="0" max="31536000" step="1" value="${esc(v("amms.curve.presets.WBTC.donationIntervalSec"))}"/></div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <details class="effective-config-preview">
            <summary>Effective config changes vs defaults (<span id="effectiveOverrideCount">${effectiveOverrides.length}</span>)</summary>
            <ul id="effectiveOverrideList">${effectiveOverridesHtml}</ul>
          </details>
          <div class="actions">
            <button class="primary" id="runBtn" ${limitsReady ? "" : "disabled"}>Run</button>
            <button id="resetBtn">Reset to defaults</button>
          </div>
          <div class="muted" id="setupMsg"></div>
        </section>
      </div>
    `;

    const msgEl = document.getElementById("setupMsg");
    const periodStartEl = document.getElementById("periodStart");
    const periodEndEl = document.getElementById("periodEnd");
    const modeInfoEl = document.getElementById("modeCoresInfo");
    const globalRebalanceEl = document.getElementById("globalRebalanceEnabled");
    const refreshEffectiveOverrides = () => {
      const paths = EDITABLE_DRAFT_PATHS.filter(
        (path) => JSON.stringify(getPath(state.config, path)) !== JSON.stringify(getPath(state.defaults, path))
      );
      const countEl = document.getElementById("effectiveOverrideCount");
      const listEl = document.getElementById("effectiveOverrideList");
      if (countEl) countEl.textContent = String(paths.length);
      if (listEl) {
        listEl.innerHTML = paths.length
          ? paths
              .map(
                (path) =>
                  `<li><code>${esc(path)}</code>: <code>${esc(JSON.stringify(getPath(state.config, path)))}</code></li>`
              )
              .join("")
          : "<li>No overrides — canonical backend defaults will be used.</li>";
      }
    };

    const setPeriodDates = (startTs, endTs) => {
      const clampedStart = Math.max(minTs, Math.min(maxTs, Math.trunc(startTs)));
      const clampedEnd = Math.max(minTs, Math.min(maxTs, Math.trunc(endTs)));
      if (!periodStartEl || !periodEndEl) return;
      periodStartEl.value = tsToDateInput(clampedStart);
      periodEndEl.value = tsToDateInput(Math.max(clampedStart, clampedEnd));
      setMsg(msgEl, "");
    };

    const utcDateShiftDays = (dateStr, deltaDays) => {
      const ms = Date.parse(`${dateStr}T00:00:00Z`);
      if (!Number.isFinite(ms)) return dateStr;
      return new Date(ms + deltaDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    };

    const setPeriodDatesByDays = (days) => {
      if (!periodStartEl || !periodEndEl) return;
      const endDateRaw = String(periodEndEl.value || maxDate);
      const endDateClamped = endDateRaw < minDate ? minDate : endDateRaw > maxDate ? maxDate : endDateRaw;
      const desiredStart = utcDateShiftDays(endDateClamped, -(days - 1));
      const startDateClamped = desiredStart < minDate ? minDate : desiredStart;
      periodStartEl.value = startDateClamped;
      periodEndEl.value = endDateClamped;
      if (applyPeriodToConfig()) saveSetupDraft();
    };

    // Validate every bound field and write the parsed values into
    // state.config. Returns false (and flags the offending inputs) when
    // any field fails validation — invalid input NEVER reaches the
    // config, and the Run handler refuses to POST until it is fixed.
    const syncFieldsToConfig = () => {
      let allValid = true;
      app.querySelectorAll("[data-path]").forEach((el) => {
        const path = el.dataset.path;
        if (!path) return;
        const res = validateFieldInput(el);
        if (!res.ok) {
          setFieldError(el, res.message);
          allValid = false;
          return;
        }
        clearFieldError(el);
        setPath(state.config, path, res.value);
      });
      return allValid;
    };

    const enforceHiddenConfig = () => {
      const defaults = state.defaults;
      const passiveLp = state.config?.liquidity?.passiveLpInitialUsd;
      const enabledAmmCount = computeEnabledAmmCount(state.config);
      state.config.parallel.maxWorkers = computeWorkersForMaximumSpeed(enabledAmmCount);
      state.config.simulation.seed = defaults.simulation.seed;
      state.config.simulation.progressIntervalSec = defaults.simulation.progressIntervalSec;
      state.config.liquidity = clone(defaults.liquidity);
      if (Number.isFinite(Number(passiveLp))) {
        state.config.liquidity.passiveLpInitialUsd = Number(passiveLp);
      }
      state.config.actors = clone(defaults.actors);
      // Single source of truth for simulationEngine is
      // simulator/src/app/config.rs; mirror the backend default here instead
      // of hardcoding "rust" in the UI layer.
      state.config.simulationEngine = defaults.simulationEngine;
    };

    const refreshModeInfo = () => {
      if (!modeInfoEl) return;
      const ammCount = computeEnabledAmmCount(state.config);
      const workers = computeWorkersForMaximumSpeed(ammCount);
      modeInfoEl.textContent = `${MAXIMUM_SPEED_TITLE}: parallel by AMM × context. Estimated cores used now: ${workers} (Rust process sharding).`;
    };

    const applyPeriodToConfig = () => {
      const startDateRaw = String(periodStartEl?.value || "");
      const endDateRaw = String(periodEndEl?.value || "");
      if (!startDateRaw || !endDateRaw) {
        setMsg(msgEl, "Select both start and end dates", true);
        return false;
      }

      const startTsRaw = dateInputToStartTs(startDateRaw);
      const endTsRaw = dateInputToEndTs(endDateRaw);
      if (!Number.isFinite(startTsRaw) || !Number.isFinite(endTsRaw)) {
        setMsg(msgEl, "Invalid date range", true);
        return false;
      }

      const startTs = Math.max(startTsRaw, minTs);
      const endTs = Math.min(endTsRaw, maxTs);
      if (endTs <= startTs) {
        setMsg(msgEl, "End date must be after start date", true);
        return false;
      }

      state.config.simulation.startTimestamp = startTs;
      state.config.simulation.endTimestamp = endTs;
      refreshEffectiveOverrides();
      return true;
    };

    app.querySelectorAll("[data-path]").forEach((el) => {
      const onUpdate = () => {
        const path = el.dataset.path;
        if (!path) return;
        // Live-refresh any inline percent readout bound to this
        // config path. The span markup is emitted by `pctSpan(...)`
        // in the label; here we recompute its text from the raw
        // input value so the percent updates as the user types,
        // without re-rendering the form (which would steal focus).
        // Runs before validation so the readout tracks even
        // not-yet-valid input (the formatter renders "invalid").
        const span = app.querySelector(`[data-pct-for="${CSS.escape(path)}"]`);
        if (span) {
          const fn = _percentFormatterByName(span.dataset.pctFmt);
          span.textContent = fn(el.value);
        }
        const res = validateFieldInput(el);
        if (!res.ok) {
          // Invalid input never reaches state.config (no silent 0
          // coercion) — flag the field; the Run button refuses to
          // submit while any field is flagged.
          setFieldError(el, res.message);
          return;
        }
        clearFieldError(el);
        setPath(state.config, path, res.value);
        saveSetupDraft();
        refreshEffectiveOverrides();
        if (path.endsWith(".enabled")) {
          // `.enabled` toggles drive a full re-render so every other
          // input in that AMM block can pick up the disabled
          // attribute / `amm-disabled` class.
          renderSetup();
        }
      };
      el.addEventListener("input", onUpdate);
      el.addEventListener("change", onUpdate);
    });

    globalRebalanceEl?.addEventListener("change", () => {
      setGlobalRebalanceEnabled(state.config, !!globalRebalanceEl.checked);
      saveSetupDraft();
      refreshEffectiveOverrides();
    });

    // Per-AMM section collapse / expand. We mutate the DOM in place
    // (toggle a CSS class + flip the `+`/`−` button label) instead of
    // re-rendering the whole form — that way fields the user is
    // currently editing don't lose their value or focus.
    app.querySelectorAll("[data-section-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.sectionToggle;
        if (!key) return;
        const sectionEl = btn.closest(".preset-zone");
        if (!sectionEl) return;
        const willCollapse = !sectionEl.classList.contains("is-collapsed");
        sectionEl.classList.toggle("is-collapsed", willCollapse);
        btn.textContent = willCollapse ? "+" : "−";
        btn.setAttribute("aria-label", `${willCollapse ? "Expand" : "Collapse"} ${SECTION_DISPLAY_NAME[key] || key}`);
        state.collapsedSections[key] = willCollapse;
        saveCollapsedSections(state.collapsedSections);
      });
    });

    document.getElementById("periodPresetFull")?.addEventListener("click", () => {
      setPeriodDates(minTs, maxTs);
      if (applyPeriodToConfig()) saveSetupDraft();
    });
    document.getElementById("periodPresetWeek")?.addEventListener("click", () => {
      setPeriodDatesByDays(7);
    });
    document.getElementById("periodPresetMonth")?.addEventListener("click", () => {
      setPeriodDatesByDays(30);
    });
    document.getElementById("periodPreset3Month")?.addEventListener("click", () => {
      setPeriodDatesByDays(90);
    });

    const bindPeriodDraft = (el) => {
      if (!el) return;
      el.addEventListener("change", () => {
        if (applyPeriodToConfig()) saveSetupDraft();
      });
    };
    bindPeriodDraft(periodStartEl);
    bindPeriodDraft(periodEndEl);

    const bindEqImport = (token) => {
      const btn = document.getElementById(`eqImportApply${token}`);
      if (!btn) return;
      btn.addEventListener("click", () => {
        const visMap = readVisualizerAlphaBetaMap();
        const snap = visMap?.[token];
        // V1.5: the snapshot ships **both** knobs (`aWad`, `lambdaWad`).
        // Import is all-or-nothing — a malformed snapshot with only one
        // of the two would silently produce a mismatched curve, so we
        // refuse it instead of partially applying.
        const aWad = typeof snap?.aWad === "string" ? snap.aWad : null;
        const lambdaWad = typeof snap?.lambdaWad === "string" ? snap.lambdaWad : null;
        if (!aWad || !lambdaWad) {
          setMsg(
            msgEl,
            `No ${token} snapshot in Curve Lab yet. Open Curve Lab, select ${token}, adjust (a, λ) once, then import.`,
            true
          );
          return;
        }
        setPath(state.config, `amms.equilibra.presets.${token}.aWad`, aWad);
        setPath(state.config, `amms.equilibra.presets.${token}.lambdaWad`, lambdaWad);
        // Only `(aWad, lambdaWad)` are consumed; any extra fields in
        // the snapshot are silently ignored.
        saveSetupDraft();
        const ts = typeof snap?.updatedAt === "string" ? ` (${snap.updatedAt})` : "";
        setMsg(msgEl, `${token} (a, λ) imported from Curve Lab${ts}`);
        renderSetup();
      });
    };
    bindEqImport("WETH");
    bindEqImport("WBTC");

    const bindCurveImport = (token) => {
      const btn = document.getElementById(`curveImportApply${token}`);
      if (!btn) return;
      btn.addEventListener("click", () => {
        const visMap = readVisualizerCurveMap();
        const snap = visMap?.[token];
        const aRaw = snap?.A;
        const gammaRaw = snap?.gamma;
        const hasA = aRaw !== undefined && aRaw !== null && String(aRaw).trim() !== "";
        const hasGamma = gammaRaw !== undefined && gammaRaw !== null && String(gammaRaw).trim() !== "";
        if (!hasA || !hasGamma) {
          setMsg(
            msgEl,
            `No reference-AMM ${token} snapshot in Curve Lab yet. Open Curve Lab, select ${token}, set A/gamma, then import.`,
            true
          );
          return;
        }
        setPath(state.config, `amms.curve.presets.${token}.A`, Number.parseInt(String(aRaw), 10) || 0);
        setPath(state.config, `amms.curve.presets.${token}.gamma`, String(gammaRaw));
        saveSetupDraft();
        const ts = typeof snap?.updatedAt === "string" ? ` (${snap.updatedAt})` : "";
        setMsg(msgEl, `${token} A/gamma imported from Curve Lab${ts}`);
        renderSetup();
      });
    };
    bindCurveImport("WETH");
    bindCurveImport("WBTC");

    document.getElementById("resetBtn")?.addEventListener("click", () => {
      // Full reset: drop the persisted draft, then rebuild from backend
      // defaults exactly as ensureDefaults would on a fresh session.
      try {
        localStorage.removeItem(SETUP_DRAFT_KEY);
      } catch {
        // ignore storage failures
      }
      state.config = clone(state.defaults);
      saveSetupDraft();
      setMsg(msgEl, "Reset to benchmark defaults");
      renderSetup();
    });

    document.getElementById("runBtn")?.addEventListener("click", async () => {
      // Defense in depth: the button is rendered disabled while the
      // limits fetch has not succeeded, but refuse here too so a stale
      // DOM state can never POST an unvalidated config.
      if (!state.limits) {
        setMsg(
          msgEl,
          "Cannot start: input limits failed to load from /api/config/limits. Fix the backend and reload this page.",
          true
        );
        return;
      }
      if (!syncFieldsToConfig()) {
        setMsg(msgEl, "Fix the highlighted invalid fields before starting the run", true);
        return;
      }
      if (globalRebalanceEl) {
        setGlobalRebalanceEnabled(state.config, !!globalRebalanceEl.checked);
      }
      if (!applyPeriodToConfig()) return;
      enforceHiddenConfig();
      sanitizeSetupConfig(state.config);
      saveSetupDraft();

      setMsg(msgEl, "Starting run...");
      try {
        const created = await fetchJson("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.config),
        });
        setMsg(msgEl, `Run created: ${created.runId}`);
        nav(`/run/${created.runId}`);
      } catch (e) {
        setMsg(msgEl, `Start failed: ${e.message || e}`, true);
      }
    });

    refreshModeInfo();
  }

  function renderRuns() {
    app.innerHTML = `
      <h1 class="page-title">Runs</h1>
      <section class="card">
        <div class="actions" style="margin-top:0">
          <button id="clearFinishedBtn">Clear finished history</button>
        </div>
        <div class="muted">Auto-refresh every 5 seconds.</div>
        <div id="runsQuickOpen" style="margin-top:8px"></div>
        <div id="runsTableWrap" class="muted" style="margin-top:10px">Loading...</div>
      </section>
    `;

    const clearBtn = document.getElementById("clearFinishedBtn");
    const runDeltaCache = new Map();
    // Guards the 5s poller against overlapping ticks when a response
    // is slower than the polling interval; manual refreshes after
    // delete/clear actions go through the same gate.
    let loadInFlight = false;
    const AMM_ORDER = ["equilibra", "curve", "uniswapV2"];
    const AMM_SHORT_LABEL = {
      equilibra: "EQ",
      curve: CUBIC_D_TABLE_LABEL,
      uniswapV2: "UNI",
    };

    const formatDeltaCell = (value) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return `<span class="muted">n/a</span>`;
      const sign = v >= 0 ? "+" : "";
      const cls = v > 0 ? "run-delta-pos" : v < 0 ? "run-delta-neg" : "run-delta-zero";
      return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
    };

    const summarizePoolDelta = (metrics, poolKey) => {
      const list = Array.isArray(metrics?.summaries) ? metrics.summaries : [];
      if (list.length === 0) return `<span class="muted">n/a</span>`;
      const byAmm = new Map();
      for (const item of list) {
        const pool = String(item?.poolKey || "").toUpperCase();
        if (pool !== poolKey) continue;
        const amm = String(item?.ammName || "");
        const delta = Number(item?.lp1DeltaVsHoldPercent);
        if (!Number.isFinite(delta)) continue;
        byAmm.set(amm, delta);
      }
      if (byAmm.size === 0) return `<span class="muted">n/a</span>`;
      return AMM_ORDER.filter((amm) => byAmm.has(amm))
        .map((amm) => `<span class="run-delta-amm">${AMM_SHORT_LABEL[amm]}</span> ${formatDeltaCell(byAmm.get(amm))}`)
        .join(`<span class="run-delta-sep"> | </span>`);
    };

    const loadRunDeltaFromMetrics = async (run) => {
      if (run.status !== "completed") {
        return {
          weth: `<span class="muted">—</span>`,
          wbtc: `<span class="muted">—</span>`,
          finishedAt: String(run.finishedAt || ""),
        };
      }
      const runId = String(run.runId || "");
      const finishedAt = String(run.finishedAt || "");
      const cached = runDeltaCache.get(runId);
      if (cached && cached.finishedAt === finishedAt) {
        return cached;
      }
      try {
        const metrics = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/results/metrics`);
        const computed = {
          finishedAt,
          weth: summarizePoolDelta(metrics, "WETH"),
          wbtc: summarizePoolDelta(metrics, "WBTC"),
        };
        runDeltaCache.set(runId, computed);
        return computed;
      } catch {
        // Report may be unavailable for some completed runs (e.g.
        // metrics.json was never generated). Cache the negative lookup
        // under the same finishedAt key as a success, so the 5s poller
        // does not re-issue the request forever; a re-finished run
        // naturally invalidates the entry via the finishedAt mismatch.
        const missing = {
          weth: `<span class="muted">n/a</span>`,
          wbtc: `<span class="muted">n/a</span>`,
          finishedAt,
        };
        runDeltaCache.set(runId, missing);
        return missing;
      }
    };

    clearBtn?.addEventListener("click", async () => {
      const ok = confirm("Delete all completed/failed/canceled runs from history and disk?");
      if (!ok) return;
      clearBtn.disabled = true;
      const prev = clearBtn.textContent;
      clearBtn.textContent = "Clearing...";
      try {
        const result = await fetchJson("/api/runs/clear-finished", {
          method: "POST",
        });
        const removed = Array.isArray(result?.removedRunIds) ? result.removedRunIds.length : 0;
        const orphan = Array.isArray(result?.removedOrphanDirs) ? result.removedOrphanDirs.length : 0;
        const retained = Array.isArray(result?.retainedRunIds) ? result.retainedRunIds.length : 0;
        clearBtn.textContent =
          retained > 0 ? `Cleared ${removed + orphan}, ${retained} kept` : `Cleared (${removed + orphan})`;
        if (retained > 0) {
          alert(
            `${retained} run(s) could not be removed from disk and stay listed: ` + result.retainedRunIds.join(", ")
          );
        }
      } catch (e) {
        clearBtn.textContent = `Clear failed`;
      } finally {
        setTimeout(() => {
          clearBtn.disabled = false;
          clearBtn.textContent = "Clear finished history";
        }, 1200);
        load();
      }
    });

    async function load() {
      if (loadInFlight) return;
      loadInFlight = true;
      const wrap = document.getElementById("runsTableWrap");
      const quickEl = document.getElementById("runsQuickOpen");
      try {
        const data = await fetchJson("/api/runs");
        const runs = (data.runs || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const liveRunIds = new Set(runs.map((r) => String(r.runId || "")));
        for (const key of runDeltaCache.keys()) {
          if (!liveRunIds.has(key)) {
            runDeltaCache.delete(key);
          }
        }
        const deltaByRun = new Map();
        await Promise.all(
          runs.map(async (r) => {
            const delta = await loadRunDeltaFromMetrics(r);
            deltaByRun.set(String(r.runId || ""), delta);
          })
        );

        const active = runs.find((r) => r.status === "running" || r.status === "queued");
        if (quickEl) {
          if (active) {
            quickEl.innerHTML = `
              <span class="actions-inline">
                <span class="status-pill ${esc(active.status)}">${esc(active.status)}</span>
                <span>Active run:</span>
                <a href="/run/${encodeURIComponent(active.runId)}" data-link>open live progress</a>
              </span>
            `;
          } else {
            quickEl.innerHTML = `<span class="muted">No active runs.</span>`;
          }
        }

        if (runs.length === 0) {
          wrap.innerHTML = `<div class="muted">No runs yet.</div>`;
          return;
        }

        wrap.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Status</th>
                <th>Started</th>
                <th>Finished</th>
                <th>WETH Δ vs Hold</th>
                <th>WBTC Δ vs Hold</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${runs
                .map((r) => {
                  const delta = deltaByRun.get(String(r.runId || "")) || {
                    weth: `<span class="muted">n/a</span>`,
                    wbtc: `<span class="muted">n/a</span>`,
                  };
                  const isTerminal = r.status === "completed" || r.status === "failed" || r.status === "canceled";
                  return `
                <tr>
                  <td>${esc(r.runId)}</td>
                  <td><span class="status-pill ${esc(r.status)}">${esc(r.status)}</span></td>
                  <td>${esc(fmtDate(r.startedAt))}</td>
                  <td>${r.finishedAt ? esc(fmtDate(r.finishedAt)) : '<span class="muted">in progress</span>'}</td>
                  <td class="run-delta-cell">${delta.weth}</td>
                  <td class="run-delta-cell">${delta.wbtc}</td>
                  <td>
                    <span class="actions-inline">
                      ${isTerminal ? "" : `<a href="/run/${encodeURIComponent(r.runId)}" data-link>live</a>`}
                      ${
                        // Only completed runs have a report bundle to
                        // open (the orchestrator flips to `completed`
                        // strictly after report generation). Same
                        // predicate as the Run page's canOpenResults —
                        // failed/canceled runs have no report either.
                        r.status === "completed"
                          ? `<button class="inline-btn" data-open-results="${esc(r.runId)}">results</button>`
                          : ""
                      }
                      ${
                        isTerminal
                          ? `<button class="inline-btn danger" data-delete-run="${esc(r.runId)}">delete</button>`
                          : ""
                      }
                    </span>
                  </td>
                </tr>
              `;
                })
                .join("")}
            </tbody>
          </table>
        `;

        wrap.querySelectorAll("a[data-link]").forEach((a) => {
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            nav(a.getAttribute("href"));
          });
        });
        wrap.querySelectorAll("button[data-delete-run]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const targetRun = btn.getAttribute("data-delete-run");
            if (!targetRun) return;
            const ok = confirm(`Delete run ${targetRun} from history and disk?`);
            if (!ok) return;
            btn.disabled = true;
            try {
              const result = await fetchJson(`/api/runs/${encodeURIComponent(targetRun)}`, { method: "DELETE" });
              if (result && result.removed === false) {
                alert(`Run ${targetRun} could not be removed from disk; ` + `it stays listed — retry the delete.`);
              }
            } catch (e) {
              alert(`Delete failed: ${e.message || e}`);
            } finally {
              load();
            }
          });
        });
        wrap.querySelectorAll("button[data-open-results]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const targetRun = btn.getAttribute("data-open-results");
            if (!targetRun) return;
            nav(`/results/${encodeURIComponent(targetRun)}`);
          });
        });
        quickEl?.querySelectorAll("a[data-link]").forEach((a) => {
          a.addEventListener("click", (ev) => {
            ev.preventDefault();
            nav(a.getAttribute("href"));
          });
        });
      } catch (e) {
        wrap.innerHTML = `<div class="muted msg-error">Failed to load runs: ${esc(e.message || e)}</div>`;
      } finally {
        loadInFlight = false;
      }
    }

    load();
    const timer = setInterval(load, 5000);
    state.cleanup = () => clearInterval(timer);
  }

  function renderRun(runId) {
    // Run-detail console (the long log tail at the bottom of the
    // Run Top card) defaults to COLLAPSED so the page fits without
    // scrolling. Choice persists across runs / page reloads.
    const RUN_CONSOLE_COLLAPSED_KEY = "equinova.run.console.collapsed.v1";
    const readRunConsoleCollapsed = () => {
      try {
        const raw = localStorage.getItem(RUN_CONSOLE_COLLAPSED_KEY);
        return raw === null ? true : raw === "true";
      } catch (_) {
        return true;
      }
    };
    const runConsoleStartCollapsed = readRunConsoleCollapsed();
    window.__toggleRunConsole = () => {
      const section = document.getElementById("runConsoleSection");
      const sym = document.querySelector("#runConsoleToggleBtn .run-console-sym");
      if (!section) return;
      const willCollapse = !section.classList.contains("is-collapsed");
      section.classList.toggle("is-collapsed", willCollapse);
      if (sym) sym.textContent = willCollapse ? "+" : "−";
      try {
        localStorage.setItem(RUN_CONSOLE_COLLAPSED_KEY, String(willCollapse));
      } catch (_) {
        /* purely UI persistence — fine to lose on quota errors */
      }
    };

    app.innerHTML = `
      <h1 class="page-title">Run ${esc(runId)}</h1>
      <section class="card run-top-card">
        <div class="run-top-grid">
          <div class="run-top-main">
            <div class="kv" id="runKv">
              <div>Status</div><div id="runStatus">-</div>
              <div>Progress</div><div id="runProgressText">-</div>
              <div>Execution</div><div id="runExecutionFingerprint" class="mono">pending</div>
              <div>Oracle</div><div id="runOracleDigest" class="mono">pending</div>
            </div>
            <div class="progress-wrap"><div id="runProgress" class="progress"></div></div>
            <div class="actions run-actions-inline">
              <button id="cancelRunBtn" class="danger">Cancel/Delete</button>
              <button id="openResultsBtn">Open Results</button>
            </div>
            <div class="muted run-msg-inline" id="runMsg"></div>
          </div>
          <div class="run-top-shard">
            <pre class="log log-shard-compact" id="shardProgress">{}</pre>
          </div>
        </div>

        <div class="run-console${runConsoleStartCollapsed ? " is-collapsed" : ""}" id="runConsoleSection">
          <button
            type="button"
            class="run-console-toggle"
            id="runConsoleToggleBtn"
            onclick="window.__toggleRunConsole && window.__toggleRunConsole()"
            aria-label="Toggle run console"
          ><span class="run-console-sym">${runConsoleStartCollapsed ? "+" : "−"}</span> console</button>
          <pre class="log log-tail-wide" id="runLogs"></pre>
        </div>
      </section>
      <div class="grid-2 live-lp-grid">
        <section class="card">
          <h3>Live Δ vs Hold · WETH (%)</h3>
          <canvas id="runLpChartWETH" class="lp-live-chart lp-live-chart-large"></canvas>
          <div id="runLpLegendWETH" class="lp-live-legend muted">Waiting for first WETH snapshot...</div>
          <div class="price-live-block">
            <h4 class="price-live-title">Live Price · WETH (USD)</h4>
            <canvas id="runPriceChartWETH" class="lp-live-chart price-live-chart"></canvas>
            <div id="runPriceLegendWETH" class="price-live-legend muted">Waiting for first WETH price...</div>
          </div>
        </section>
        <section class="card">
          <h3>Live Δ vs Hold · WBTC (%)</h3>
          <canvas id="runLpChartWBTC" class="lp-live-chart lp-live-chart-large"></canvas>
          <div id="runLpLegendWBTC" class="lp-live-legend muted">Waiting for first WBTC snapshot...</div>
          <div class="price-live-block">
            <h4 class="price-live-title">Live Price · WBTC (USD)</h4>
            <canvas id="runPriceChartWBTC" class="lp-live-chart price-live-chart"></canvas>
            <div id="runPriceLegendWBTC" class="price-live-legend muted">Waiting for first WBTC price...</div>
          </div>
        </section>
      </div>
    `;

    const statusEl = document.getElementById("runStatus");
    const progressTextEl = document.getElementById("runProgressText");
    const executionFingerprintEl = document.getElementById("runExecutionFingerprint");
    const oracleDigestEl = document.getElementById("runOracleDigest");
    const progressEl = document.getElementById("runProgress");
    const logsEl = document.getElementById("runLogs");
    const msgEl = document.getElementById("runMsg");
    const shardEl = document.getElementById("shardProgress");
    const lpChartWethEl = document.getElementById("runLpChartWETH");
    const lpLegendWethEl = document.getElementById("runLpLegendWETH");
    const lpChartWbtcEl = document.getElementById("runLpChartWBTC");
    const lpLegendWbtcEl = document.getElementById("runLpLegendWBTC");
    const priceChartWethEl = document.getElementById("runPriceChartWETH");
    const priceLegendWethEl = document.getElementById("runPriceLegendWETH");
    const priceChartWbtcEl = document.getElementById("runPriceChartWBTC");
    const priceLegendWbtcEl = document.getElementById("runPriceLegendWBTC");
    const cancelBtn = document.getElementById("cancelRunBtn");
    const openResultsBtn = document.getElementById("openResultsBtn");

    const logLines = [];
    let lastPct = null;
    let lastPctTs = null;
    let lastEta = null;
    let currentStatus = "queued";
    let reportGenerationInProgress = false;
    let shardProgressLines = [];
    const lastLoggedRevertsByShard = new Map();
    const supportedLpBases = ["WETH", "WBTC"];
    const liveLpSeriesByBase = new Map(supportedLpBases.map((base) => [base, new Map()]));
    const livePriceSeriesByBase = new Map(supportedLpBases.map((base) => [base, []]));
    const liveLpBaselineByContext = new Map();
    const liveLpSeriesModeByContext = new Map(); // context -> "legacyUsd" | "vsHoldPercent"
    const MAX_LIVE_POINTS_PER_SERIES = 4096;
    const pendingLiveChartBases = new Set();
    let liveChartAnimationFrame = null;
    let finalLiveLpSyncInFlight = false;
    let finalLiveLpSyncDone = false;

    const setProvenance = (payload) => {
      const fingerprint = String(payload?.executionFingerprint || "");
      const oracleDigest = String(payload?.oracleDigest || "");
      if (fingerprint) {
        executionFingerprintEl.textContent = fingerprint.slice(0, 16);
        executionFingerprintEl.title = fingerprint;
      }
      if (oracleDigest) {
        oracleDigestEl.textContent = oracleDigest.slice(0, 16);
        oracleDigestEl.title = oracleDigest;
      }
    };

    const liveLpColor = (key) => {
      const amm = String(key).split(":")[0];
      if (amm === "equilibra") return "#2dcc70"; // green
      if (amm === "uniswapV2") return "#48b3ff"; // blue
      if (amm === "curve") return "#ff7f50"; // coral
      return "#9f8cff";
    };

    const shouldSkipLogLine = (line) => {
      if (!line) return true;
      return (
        line.includes("[BENCHMARK_EVENT]") ||
        line.includes("[Simulation] Progress:") ||
        line.includes("Saving checkpoint at t=") ||
        line.includes("Checkpoint saved to ") ||
        line.includes("Action log: ")
      );
    };

    const fmtEta = (etaSec) => {
      if (!Number.isFinite(etaSec) || etaSec < 0) return "-";
      const s = Math.trunc(etaSec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${ss}s`;
      return `${ss}s`;
    };

    const updateProgressText = (pct, payload = null) => {
      const parts = [`${pct.toFixed(2)}%`];
      if (
        payload &&
        typeof payload.currentTick === "number" &&
        typeof payload.totalTicks === "number" &&
        payload.totalTicks > 0
      ) {
        parts.push(`tick ${payload.currentTick}/${payload.totalTicks}`);
      }
      if (payload && Number.isFinite(Number(payload.etaSec))) {
        lastEta = Number(payload.etaSec);
      }
      if (Number.isFinite(lastEta)) {
        parts.push(`ETA ${fmtEta(lastEta)}`);
      }

      const now = Date.now();
      if (lastPct !== null && lastPctTs !== null && now > lastPctTs && pct >= lastPct) {
        const perSec = (pct - lastPct) / ((now - lastPctTs) / 1000);
        if (Number.isFinite(perSec) && perSec > 0) {
          parts.push(`${(perSec * 60).toFixed(2)}%/min`);
        }
      }
      lastPct = pct;
      lastPctTs = now;
      progressTextEl.textContent = parts.join(" · ");
    };

    const renderShardProgressWithNotice = () => {
      const baseText = shardProgressLines.length > 0 ? shardProgressLines.join("\n") : "{}";
      if (reportGenerationInProgress) {
        shardEl.innerHTML =
          `${esc(baseText)}\n` +
          `<span class="shard-report-generation-notice">` +
          `Please wait,\n` +
          `report generation is in progress...\n` +
          `This may take some time.` +
          `</span>`;
      } else {
        shardEl.textContent = baseText;
      }
    };

    const setReportGenerationState = (isActive) => {
      if (reportGenerationInProgress === isActive) return;
      reportGenerationInProgress = isActive;
      renderShardProgressWithNotice();
    };

    const renderShardProgress = (payload) => {
      const shards = payload?.shards;
      if (!shards || typeof shards !== "object") {
        renderShardProgressWithNotice();
        return;
      }
      const lines = Object.entries(shards)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => {
          const n = Number(v);
          const pct = Number.isFinite(n) ? `${n.toFixed(2)}%` : "-";
          return `${k.padEnd(10)} ${pct}`;
        });
      if (typeof payload.completedShards === "number" && typeof payload.totalShards === "number") {
        lines.unshift(`completed   ${payload.completedShards}/${payload.totalShards}`);
      }
      shardProgressLines = lines;
      renderShardProgressWithNotice();
    };

    const appendLog = (line) => {
      if (shouldSkipLogLine(line)) return;
      logLines.push(line);
      if (logLines.length > 1000) logLines.shift();
      logsEl.textContent = logLines.join("\n");
      logsEl.scrollTop = logsEl.scrollHeight;
    };

    const getLpCanvas = (base) => {
      if (base === "WETH") return lpChartWethEl;
      if (base === "WBTC") return lpChartWbtcEl;
      return null;
    };

    const getLpLegend = (base) => {
      if (base === "WETH") return lpLegendWethEl;
      if (base === "WBTC") return lpLegendWbtcEl;
      return null;
    };

    const getPriceCanvas = (base) => {
      if (base === "WETH") return priceChartWethEl;
      if (base === "WBTC") return priceChartWbtcEl;
      return null;
    };

    const getPriceLegend = (base) => {
      if (base === "WETH") return priceLegendWethEl;
      if (base === "WBTC") return priceLegendWbtcEl;
      return null;
    };

    const contextToBase = (contextKey) => {
      if (typeof contextKey !== "string") return null;
      const idx = contextKey.lastIndexOf(":");
      if (idx < 0) return null;
      const base = contextKey.slice(idx + 1).toUpperCase();
      return supportedLpBases.includes(base) ? base : null;
    };

    const shortContextLabel = (contextKey, base) => {
      const suffix = `:${base}`;
      return contextKey.endsWith(suffix) ? contextKey.slice(0, contextKey.length - suffix.length) : contextKey;
    };

    const pct2Formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const usd2Formatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const priceUsdFormatter = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    const formatSignedPct = (v) => {
      if (!Number.isFinite(v)) return "-";
      const sign = v > 0 ? "+" : v < 0 ? "-" : "";
      return `${sign}${pct2Formatter.format(Math.abs(v))}%`;
    };

    const formatSignedUsd = (v) => {
      if (!Number.isFinite(v)) return "-";
      const sign = v > 0 ? "+" : v < 0 ? "-" : "";
      return `${sign}$${usd2Formatter.format(Math.abs(v))}`;
    };

    const toPnlPct = (currentValue, baselineValue) => {
      if (!Number.isFinite(currentValue) || !Number.isFinite(baselineValue)) return 0;
      const denom = Math.abs(baselineValue) > 1e-12 ? baselineValue : 1;
      return ((currentValue - baselineValue) / denom) * 100;
    };

    const formatPriceUsd = (v) => {
      if (!Number.isFinite(v)) return "-";
      return `$${priceUsdFormatter.format(v)}`;
    };

    const normalizeTimestampSec = (rawTs) => {
      const num = Number(rawTs);
      if (!Number.isFinite(num)) return null;
      // Accept both seconds and milliseconds timestamps.
      if (num > 1_000_000_000_000) {
        return Math.floor(num / 1000);
      }
      return Math.floor(num);
    };

    const formatDateLabel = (tsSec) => {
      const d = new Date(Math.floor(tsSec) * 1000);
      if (Number.isNaN(d.getTime())) return "-";
      const yyyy = String(d.getUTCFullYear());
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    };

    const renderLiveLpLegend = (base) => {
      const legendEl = getLpLegend(base);
      const seriesMap = liveLpSeriesByBase.get(base);
      if (!legendEl || !seriesMap) return;

      const keys = Array.from(seriesMap.keys()).sort((a, b) => a.localeCompare(b));
      if (keys.length === 0) {
        legendEl.textContent = `Waiting for first ${base} snapshot...`;
        return;
      }
      legendEl.innerHTML = keys
        .map((k) => {
          const points = seriesMap.get(k) || [];
          const latest = points.length > 0 ? points[points.length - 1].y : NaN;
          const mode = liveLpSeriesModeByContext.get(k) || "legacyUsd";
          const baseline = liveLpBaselineByContext.get(k) ?? (points.length > 0 ? points[0].y : 0);
          const value = Number.isFinite(latest)
            ? mode === "vsHoldPercent"
              ? formatSignedPct(latest)
              : formatSignedUsd(latest - baseline)
            : "-";
          const label = shortContextLabel(k, base);
          return `<span class="lp-live-item"><span class="lp-live-swatch" style="background:${liveLpColor(k)}"></span><span>${esc(label)}: ${esc(value)}</span></span>`;
        })
        .join("");
    };

    const renderLiveLpChart = (base) => {
      const canvasEl = getLpCanvas(base);
      const seriesMap = liveLpSeriesByBase.get(base);
      if (!(canvasEl instanceof HTMLCanvasElement) || !seriesMap) return;

      const seriesEntries = Array.from(seriesMap.entries()).filter(([, points]) => points.length > 0);
      const dpr = window.devicePixelRatio || 1;
      const rect = canvasEl.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width || canvasEl.clientWidth || 320));
      const height = Math.max(520, Math.floor(rect.height || canvasEl.clientHeight || 520));

      canvasEl.width = Math.floor(width * dpr);
      canvasEl.height = Math.floor(height * dpr);

      const ctx = canvasEl.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = "#0f141b";
      ctx.fillRect(0, 0, width, height);

      if (seriesEntries.length === 0) {
        ctx.fillStyle = "#8ea0b6";
        ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.fillText(`Waiting for first ${base} snapshot...`, 12, 24);
        return;
      }

      const normalizedEntries = seriesEntries.map(([key, points]) => {
        const mode = liveLpSeriesModeByContext.get(key) || "legacyUsd";
        if (mode === "vsHoldPercent") {
          return [
            key,
            points.map((p) => ({
              x: p.x,
              y: p.y,
            })),
          ];
        }
        const baseline = liveLpBaselineByContext.get(key) ?? (points.length > 0 ? points[0].y : 0);
        return [
          key,
          points.map((p) => ({
            x: p.x,
            y: toPnlPct(p.y, baseline),
          })),
        ];
      });

      const allPoints = normalizedEntries.flatMap(([, points]) => points);
      const xMin = Math.min(...allPoints.map((p) => p.x));
      const xMaxRaw = Math.max(...allPoints.map((p) => p.x));
      const yMinRaw = Math.min(0, ...allPoints.map((p) => p.y));
      const yMaxRaw = Math.max(0, ...allPoints.map((p) => p.y));
      const xMax = xMaxRaw === xMin ? xMin + 1 : xMaxRaw;
      const ySpanRaw = yMaxRaw - yMinRaw;
      const yPad = ySpanRaw > 0 ? ySpanRaw * 0.08 : 0.05;
      const yMin = yMinRaw - yPad;
      const yMax = yMaxRaw + yPad;
      const ySpan = yMax - yMin || 1;

      const left = 58;
      const right = width - 12;
      const top = 20;
      const bottom = height - 46;
      const plotW = Math.max(1, right - left);
      const plotH = Math.max(1, bottom - top);

      const xScale = (x) => left + ((x - xMin) / (xMax - xMin)) * plotW;
      const yScale = (y) => top + ((yMax - y) / ySpan) * plotH;

      const yTicks = 5;
      const xTicks = 4;

      ctx.strokeStyle = "#1f2a36";
      ctx.lineWidth = 1;
      for (let i = 0; i <= yTicks; i++) {
        const y = top + (plotH * i) / yTicks;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }

      for (let i = 0; i <= xTicks; i++) {
        const x = left + (plotW * i) / xTicks;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }

      ctx.strokeStyle = "#314055";
      ctx.lineWidth = 1.25;
      ctx.strokeRect(left, top, plotW, plotH);

      ctx.fillStyle = "#8ea0b6";
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= yTicks; i++) {
        const y = top + (plotH * i) / yTicks;
        const yVal = yMax - (ySpan * i) / yTicks;
        ctx.fillText(formatSignedPct(yVal), left - 8, y);
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i <= xTicks; i++) {
        const x = left + (plotW * i) / xTicks;
        const ts = Math.round(xMin + ((xMax - xMin) * i) / xTicks);
        ctx.fillText(formatDateLabel(ts), x, bottom + 8);
      }

      const yZero = yScale(0);
      if (yZero >= top && yZero <= bottom) {
        ctx.strokeStyle = "#4b5d74";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(left, yZero);
        ctx.lineTo(right, yZero);
        ctx.stroke();
      }

      for (const [key, points] of normalizedEntries) {
        if (points.length < 2) continue;
        ctx.strokeStyle = liveLpColor(key);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
          const px = xScale(points[i].x);
          const py = yScale(points[i].y);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();

        const last = points[points.length - 1];
        const lx = xScale(last.x);
        const ly = yScale(last.y);
        ctx.fillStyle = liveLpColor(key);
        ctx.beginPath();
        ctx.arc(lx, ly, 7.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const livePriceColor = (base) => (base === "WETH" ? "#f5c242" : "#9fb8ff");

    const renderLivePriceLegend = (base) => {
      const legendEl = getPriceLegend(base);
      const points = livePriceSeriesByBase.get(base) || [];
      if (!legendEl) return;
      if (points.length === 0) {
        legendEl.textContent = `Waiting for first ${base} price...`;
        return;
      }
      const latest = points[points.length - 1].y;
      legendEl.textContent = `${base}: ${formatPriceUsd(latest)}`;
    };

    const renderLivePriceChart = (base) => {
      const canvasEl = getPriceCanvas(base);
      const points = livePriceSeriesByBase.get(base);
      if (!(canvasEl instanceof HTMLCanvasElement) || !points) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvasEl.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width || canvasEl.clientWidth || 320));
      const height = Math.max(220, Math.floor(rect.height || canvasEl.clientHeight || 220));

      canvasEl.width = Math.floor(width * dpr);
      canvasEl.height = Math.floor(height * dpr);

      const ctx = canvasEl.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = "#0f141b";
      ctx.fillRect(0, 0, width, height);

      if (points.length === 0) {
        ctx.fillStyle = "#8ea0b6";
        ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        ctx.fillText(`Waiting for first ${base} price...`, 12, 24);
        return;
      }

      const xMin = Math.min(...points.map((p) => p.x));
      const xMaxRaw = Math.max(...points.map((p) => p.x));
      const yMinRaw = Math.min(...points.map((p) => p.y));
      const yMaxRaw = Math.max(...points.map((p) => p.y));
      const xMax = xMaxRaw === xMin ? xMin + 1 : xMaxRaw;
      const ySpanRaw = yMaxRaw - yMinRaw;
      const yPad = ySpanRaw > 0 ? ySpanRaw * 0.08 : Math.max(yMaxRaw * 0.02, 1);
      const yMin = Math.max(0, yMinRaw - yPad);
      const yMax = yMaxRaw + yPad;
      const ySpan = Math.max(1e-9, yMax - yMin);

      const left = 58;
      const right = width - 12;
      const top = 14;
      const bottom = height - 26;
      const plotW = Math.max(1, right - left);
      const plotH = Math.max(1, bottom - top);

      const xScale = (x) => left + ((x - xMin) / (xMax - xMin)) * plotW;
      const yScale = (y) => top + ((yMax - y) / ySpan) * plotH;

      const yTicks = 4;
      const xTicks = 4;

      ctx.strokeStyle = "#1f2a36";
      ctx.lineWidth = 1;
      for (let i = 0; i <= yTicks; i++) {
        const y = top + (plotH * i) / yTicks;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
      for (let i = 0; i <= xTicks; i++) {
        const x = left + (plotW * i) / xTicks;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }

      ctx.strokeStyle = "#314055";
      ctx.lineWidth = 1.25;
      ctx.strokeRect(left, top, plotW, plotH);

      ctx.fillStyle = "#8ea0b6";
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let i = 0; i <= yTicks; i++) {
        const y = top + (plotH * i) / yTicks;
        const yVal = yMax - (ySpan * i) / yTicks;
        ctx.fillText(formatPriceUsd(yVal), left - 8, y);
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = 0; i <= xTicks; i++) {
        const x = left + (plotW * i) / xTicks;
        const ts = Math.round(xMin + ((xMax - xMin) * i) / xTicks);
        ctx.fillText(formatDateLabel(ts), x, bottom + 6);
      }

      ctx.strokeStyle = livePriceColor(base);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const px = xScale(points[i].x);
        const py = yScale(points[i].y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      const last = points[points.length - 1];
      const lx = xScale(last.x);
      const ly = yScale(last.y);
      ctx.fillStyle = livePriceColor(base);
      ctx.beginPath();
      ctx.arc(lx, ly, 4.5, 0, Math.PI * 2);
      ctx.fill();
    };

    // Multiple shard events commonly arrive in one browser frame. Mutate the
    // series immediately, but resize/redraw each pair of canvases at most
    // once per animation frame instead of once per SSE event.
    const scheduleLiveChartRender = (base) => {
      pendingLiveChartBases.add(base);
      if (liveChartAnimationFrame !== null) return;
      liveChartAnimationFrame = window.requestAnimationFrame(() => {
        liveChartAnimationFrame = null;
        const bases = Array.from(pendingLiveChartBases);
        pendingLiveChartBases.clear();
        for (const pendingBase of bases) {
          renderLiveLpChart(pendingBase);
          renderLiveLpLegend(pendingBase);
          renderLivePriceChart(pendingBase);
          renderLivePriceLegend(pendingBase);
        }
      });
    };

    const trimLiveSeries = (points) => {
      if (points.length > MAX_LIVE_POINTS_PER_SERIES) {
        points.splice(0, points.length - MAX_LIVE_POINTS_PER_SERIES);
      }
    };

    const updateLiveLpFromPayload = (payload) => {
      const rawVsHold = payload?.lpDeltaVsHoldPercent;
      const rawUsd = payload?.lpValuesUsd;
      const hasVsHold = rawVsHold && typeof rawVsHold === "object";
      const raw =
        hasVsHold && rawVsHold && typeof rawVsHold === "object"
          ? rawVsHold
          : rawUsd && typeof rawUsd === "object"
            ? rawUsd
            : null;
      if (!raw) return;
      const mode = hasVsHold ? "vsHoldPercent" : "legacyUsd";
      const normalizedTs = normalizeTimestampSec(payload?.currentTimestamp);
      const x = normalizedTs !== null ? normalizedTs : Math.floor(Date.now() / 1000);
      const changedBases = new Set();

      for (const [key, value] of Object.entries(raw)) {
        const base = contextToBase(key);
        if (!base) continue;
        const y = Number(value);
        if (!Number.isFinite(y)) continue;
        const seriesMap = liveLpSeriesByBase.get(base);
        if (!seriesMap) continue;

        if (mode === "legacyUsd" && !liveLpBaselineByContext.has(key)) {
          liveLpBaselineByContext.set(key, y);
        }
        liveLpSeriesModeByContext.set(key, mode);

        let series = seriesMap.get(key);
        if (!series) {
          series = [];
          seriesMap.set(key, series);
        }
        const last = series.length > 0 ? series[series.length - 1] : null;
        if (last && x < last.x) {
          // Ignore stale progress events for this context.
          continue;
        }
        if (last && last.x === x) {
          if (last.y !== y) {
            last.y = y;
            changedBases.add(base);
          }
        } else {
          series.push({ x, y });
          trimLiveSeries(series);
          changedBases.add(base);
        }
      }

      for (const base of changedBases) {
        scheduleLiveChartRender(base);
      }
    };

    const syncLiveLpFromFinalReport = async () => {
      if (finalLiveLpSyncDone || finalLiveLpSyncInFlight) return;
      finalLiveLpSyncInFlight = true;
      try {
        const loadedByBase = await Promise.all(
          supportedLpBases.map(async (base) => {
            const compact = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/report/data/series-${base}.json`);
            const byAmm = compact?.charts?.liveLpDeltaVsHold?.percentByAmm;
            if (!byAmm || typeof byAmm !== "object") {
              return [base, null];
            }
            const rebuilt = new Map();
            for (const [ammName, rawPoints] of Object.entries(byAmm)) {
              if (!Array.isArray(rawPoints) || rawPoints.length === 0) continue;
              const key = `${ammName}:${base}`;
              const normalizedPoints = [];
              for (const p of rawPoints) {
                const x = normalizeTimestampSec(p?.x);
                const y = Number(p?.y);
                if (x === null || !Number.isFinite(y)) continue;
                const last = normalizedPoints.length > 0 ? normalizedPoints[normalizedPoints.length - 1] : null;
                if (last && x < last.x) continue;
                if (last && x === last.x) {
                  last.y = y;
                } else {
                  normalizedPoints.push({ x, y });
                }
              }
              if (normalizedPoints.length > 0) {
                rebuilt.set(key, normalizedPoints);
              }
            }
            return [base, rebuilt];
          })
        );

        let syncedAny = false;
        for (const [base, rebuilt] of loadedByBase) {
          if (!(rebuilt instanceof Map) || rebuilt.size === 0) continue;
          const target = liveLpSeriesByBase.get(base);
          if (!target) continue;
          target.clear();
          for (const [key, points] of rebuilt.entries()) {
            target.set(key, points);
            liveLpSeriesModeByContext.set(key, "vsHoldPercent");
          }
          scheduleLiveChartRender(base);
          syncedAny = true;
        }

        if (syncedAny) {
          finalLiveLpSyncDone = true;
        }
      } catch {
        // Report assets may be briefly unavailable during transition to completed.
      } finally {
        finalLiveLpSyncInFlight = false;
      }
    };

    const normalizePriceBase = (rawBase) => {
      const base = String(rawBase || "")
        .trim()
        .toUpperCase();
      if (base === "ETH") return "WETH";
      if (base === "BTC") return "WBTC";
      return base;
    };

    const updateLivePriceFromPayload = (payload) => {
      const raw = payload?.oracleBasePricesUsd;
      if (!raw || typeof raw !== "object") return;

      const normalizedTs = normalizeTimestampSec(payload?.currentTimestamp);
      const x = normalizedTs !== null ? normalizedTs : Math.floor(Date.now() / 1000);
      const changedBases = new Set();

      for (const [rawBase, rawPrice] of Object.entries(raw)) {
        const base = normalizePriceBase(rawBase);
        if (!supportedLpBases.includes(base)) continue;
        const y = Number(rawPrice);
        if (!Number.isFinite(y) || y <= 0) continue;

        const points = livePriceSeriesByBase.get(base);
        if (!points) continue;

        const last = points.length > 0 ? points[points.length - 1] : null;
        if (last && last.x === x) {
          if (last.y !== y) {
            last.y = y;
            changedBases.add(base);
          }
        } else if (last && x <= last.x) {
          // Ignore stale timestamps to keep a single forward-moving line.
          continue;
        } else {
          points.push({ x, y });
          trimLiveSeries(points);
          changedBases.add(base);
        }
      }

      for (const base of changedBases) {
        scheduleLiveChartRender(base);
      }
    };

    const setProgress = (percent) => {
      const p = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
      progressEl.style.width = `${p}%`;
    };

    const updateActionButtons = () => {
      if (cancelBtn) cancelBtn.disabled = false;
      if (openResultsBtn) {
        const canOpenResults = currentStatus === "completed";
        openResultsBtn.hidden = !canOpenResults;
        openResultsBtn.disabled = !canOpenResults;
      }
    };

    const setStatus = (status) => {
      const next = status || "queued";
      // Terminal statuses are absorbing: a stale in-flight REST response
      // (loadRun / the 5s fallback poll dispatched moments before the
      // run finished) must not regress the pill back to "running" and
      // hide the report button after the terminal SSE event landed —
      // by then the stream is closed and the poll stopped, so nothing
      // would ever correct it.
      if (isTerminalStatus(currentStatus) && !isTerminalStatus(next)) return;
      currentStatus = next;
      statusEl.innerHTML = `<span class="status-pill ${esc(next)}">${esc(status || "-")}</span>`;
      updateActionButtons();
    };
    updateActionButtons();
    for (const base of supportedLpBases) {
      renderLiveLpChart(base);
      renderLiveLpLegend(base);
      renderLivePriceChart(base);
      renderLivePriceLegend(base);
    }

    const isTerminalStatus = (s) => s === "completed" || s === "failed" || s === "canceled";

    const handleShardProgressPayload = (payload) => {
      updateLiveLpFromPayload(payload);
      updateLivePriceFromPayload(payload);

      if (typeof payload?.currentTick === "number" && typeof payload?.totalTicks === "number") {
        const shard = typeof payload?.shard === "string" ? payload.shard : "unknown";
        const reverts = Number(payload?.reverts ?? 0);
        if (Number.isFinite(reverts) && reverts > 0) {
          const prev = lastLoggedRevertsByShard.get(shard) ?? 0;
          if (reverts !== prev) {
            const day = Number(payload?.day);
            const dayText = Number.isFinite(day) ? day : "-";
            appendLog(
              `[${shard}] WARNING: reverts=${reverts} at day=${dayText}, tick ${payload.currentTick}/${payload.totalTicks}`
            );
            lastLoggedRevertsByShard.set(shard, reverts);
          }
        }
      }
    };

    const applyTelemetrySnapshot = (snapshot) => {
      const runProgress = snapshot?.runProgress;
      if (runProgress && typeof runProgress === "object") {
        const pct = Number(runProgress.percent);
        if (Number.isFinite(pct)) {
          setProgress(pct);
          updateProgressText(pct, runProgress);
        }
        renderShardProgress(runProgress);
      }

      const shardHistory = snapshot?.shardHistory;
      if (shardHistory && typeof shardHistory === "object") {
        for (const history of Object.values(shardHistory)) {
          if (!Array.isArray(history)) continue;
          for (const payload of history) {
            if (payload && typeof payload === "object") {
              handleShardProgressPayload(payload);
            }
          }
        }
      }

      const shardProgress = snapshot?.shardProgress;
      if (shardProgress && typeof shardProgress === "object") {
        for (const payload of Object.values(shardProgress)) {
          if (payload && typeof payload === "object") {
            handleShardProgressPayload(payload);
          }
        }
      }
    };

    // Fallback poll used when the event stream is permanently lost
    // (e.g. the run was canceled/deleted from another tab and the SSE
    // reconnect 404s). Stopped on any terminal status or a 404.
    let statusPollTimer = null;
    const stopStatusPoll = () => {
      if (statusPollTimer !== null) {
        clearInterval(statusPollTimer);
        statusPollTimer = null;
      }
    };
    // The orchestrator emits a terminal status only after the full
    // workflow (including report generation) has finished, so once we
    // see one there is nothing left to stream — close the source and
    // stop any fallback poll.
    const onTerminalStatus = () => {
      stopStatusPoll();
      es.close();
    };

    const loadRun = async () => {
      try {
        const r = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
        setProvenance(r);
        setStatus(r.status);
        if (r.status === "failed") {
          // Surface the stored failure reason from the manifest so a
          // user reopening the page after the fact sees WHY it failed,
          // not just the red pill. Message only — the live SSE "error"
          // handler already appends the same text to the console.
          const em = r.error?.message;
          setMsg(msgEl, em ? `Error: ${em}` : "Run failed", true);
        }
        if (r.status === "completed") {
          void syncLiveLpFromFinalReport();
        }
        if (isTerminalStatus(r.status)) {
          onTerminalStatus();
        }
        if (typeof r.progress?.percent === "number") {
          setProgress(r.progress.percent);
          updateProgressText(r.progress.percent, r.progress || null);
        }
      } catch (e) {
        if (e?.status === 404) {
          setMsg(msgEl, "Run no longer exists", true);
          onTerminalStatus();
          return;
        }
        setMsg(msgEl, `Load failed: ${e.message || e}`, true);
      }
    };

    const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    const onEvt = (name, handler) => {
      es.addEventListener(name, (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          handler(parsed);
        } catch {
          // ignore
        }
      });
    };

    const STREAM_RETRY_MSG = "Event stream connection lost — retrying...";
    es.addEventListener("open", () => {
      // Clear a transient reconnect notice once the stream is back.
      if (msgEl.textContent === STREAM_RETRY_MSG) setMsg(msgEl, "");
    });
    es.onerror = () => {
      if (isTerminalStatus(currentStatus)) {
        // Expected: the server drops the stream after a terminal
        // status. Make sure the browser does not keep reconnecting.
        onTerminalStatus();
        return;
      }
      if (es.readyState === EventSource.CLOSED) {
        // Permanent failure (e.g. reconnect got a 404 after the run
        // was canceled/deleted elsewhere). Fall back to polling the
        // manifest until a terminal status or a 404 answers the
        // question.
        setMsg(msgEl, "Event stream closed — run may have been deleted; checking status...", true);
        if (statusPollTimer === null) {
          statusPollTimer = setInterval(loadRun, 5000);
        }
      } else {
        // Browser auto-retry (CONNECTING) — transient notice only.
        setMsg(msgEl, STREAM_RETRY_MSG, true);
      }
    };

    loadRun();

    onEvt("status", (e) => {
      if (e.payload?.status) setStatus(e.payload.status);
      if (e.payload?.status === "completed") {
        setMsg(msgEl, "Run completed");
        void syncLiveLpFromFinalReport();
      }
      if (isTerminalStatus(e.payload?.status)) {
        setReportGenerationState(false);
        onTerminalStatus();
      }
      if (typeof e.payload?.progress?.percent === "number") {
        setProgress(e.payload.progress.percent);
        updateProgressText(Number(e.payload.progress.percent), e.payload.progress);
      }
      const progressPayload = e.payload?.progress || null;
      renderShardProgress(progressPayload);
    });

    onEvt("provenance", (e) => setProvenance(e.payload));

    const handlePhaseEvent = (e) => {
      const phase = String(e.payload?.phase || "");
      if (phase === "report" || phase.includes(":report")) {
        setReportGenerationState(true);
      }
      if (e.payload?.shard) {
        appendLog(`[${e.payload.shard}] phase: ${e.payload.phase}`);
      }
    };
    onEvt("phase", handlePhaseEvent);
    onEvt("shard-phase", handlePhaseEvent);

    onEvt("progress", (e) => {
      const pct = Number(e.payload?.percent);
      if (Number.isFinite(pct)) {
        setProgress(pct);
        updateProgressText(pct, e.payload);
      }

      renderShardProgress(e.payload);
    });

    onEvt("shard-progress", (e) => {
      handleShardProgressPayload(e.payload);
    });

    onEvt("telemetry-snapshot", (e) => {
      applyTelemetrySnapshot(e.payload);
    });

    onEvt("resync-required", (e) => {
      const skipped = Number(e.payload?.skippedEvents);
      appendLog(
        `WARNING: live event stream lagged${Number.isFinite(skipped) ? ` by ${skipped} events` : ""}; reconnecting for an atomic telemetry snapshot`
      );
      // The server ends this response after the marker. EventSource then
      // reconnects and receives an atomic snapshot before fresh events. A
      // parallel REST fetch could arrive later and regress run progress.
    });

    onEvt("log", (e) => {
      if (e.payload?.line) {
        const line = String(e.payload.line);
        if (line.includes("[Report] Generation started")) {
          setReportGenerationState(true);
        } else if (line.includes("[Report] Generation completed") || line.includes("[Report] Generation failed")) {
          setReportGenerationState(false);
        }
        appendLog(line);
      }
    });

    onEvt("error", (e) => {
      const msg = String(e.payload?.message || "unknown error");
      setMsg(msgEl, `Error: ${msg}`, true);
      appendLog(`ERROR: ${msg}`);
      setReportGenerationState(false);
      loadRun();
    });

    onEvt("done", (e) => {
      // The orchestrator emits a `done` event for EVERY successful
      // shard process (payload carries `shard: "<id>"`) in addition to
      // the single run-level done (whose payload has no shard key).
      // Only the run-level signal may flip the page to completed.
      const shard = e?.payload?.shard;
      if (typeof shard === "string" && shard) {
        appendLog(`[${shard}] shard completed`);
        return;
      }
      setMsg(msgEl, "Workflow finished; finalizing run status...");
      setReportGenerationState(false);
      // Deliberately do NOT close the stream here: the orchestrator
      // emits the run-level done BEFORE it persists the terminal
      // manifest status, so the immediate loadRun() below may still
      // read `running`. The stream stays open until the follow-up
      // terminal `status` event (or a terminal manifest fetch) closes
      // it via onTerminalStatus.
      loadRun();
    });

    const onResize = () => {
      for (const base of supportedLpBases) {
        scheduleLiveChartRender(base);
      }
    };
    window.addEventListener("resize", onResize);

    document.getElementById("cancelRunBtn")?.addEventListener("click", async () => {
      const ok = confirm(`Cancel and delete run ${runId} with all its files?`);
      if (!ok) return;
      setMsg(msgEl, "Canceling...");
      try {
        const result = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
        if (result && result.removed === false) {
          alert(
            `Run ${runId} was canceled but its files could not be ` +
              `removed; it stays listed — retry the delete from the list.`
          );
        }
        nav("/runs");
      } catch (e) {
        setMsg(msgEl, `Cancel failed: ${e.message || e}`, true);
      }
    });

    openResultsBtn?.addEventListener("click", () => {
      nav(`/results/${runId}`);
    });

    state.cleanup = () => {
      stopStatusPoll();
      es.close();
      window.removeEventListener("resize", onResize);
    };
  }

  function renderResults(runId) {
    app.innerHTML = `
      <section class="results-fullpage">
        <iframe class="viewer results-standalone" src="/api/runs/${encodeURIComponent(runId)}/report/index.html"></iframe>
      </section>
    `;
  }

  function renderVisualizer() {
    const v = Date.now();
    app.innerHTML = `
      <section class="visualizer-fullpage">
        <iframe class="viewer standalone" src="/visualizer/index.html?v=${v}"></iframe>
      </section>
    `;
  }

  function renderInfo() {
    const v = Date.now();
    app.innerHTML = `
      <h1 class="page-title">Info</h1>
      <section class="card info-card">
        <iframe class="viewer info-embedded" src="/info-assets/index.html?v=${v}"></iframe>
      </section>
    `;
  }

  async function render() {
    if (typeof state.cleanup === "function") {
      state.cleanup();
      state.cleanup = null;
    }

    const route = parseRoute(location.pathname);
    renderTopbarAux(route);
    setNavActive();
    app.classList.toggle("visualizer-mode", route.page === "visualizer");
    app.classList.toggle("results-mode", route.page === "results");
    app.classList.toggle("info-mode", route.page === "info");

    if (route.page === "setup") {
      app.innerHTML = `<div class="muted">Loading config...</div>`;
      try {
        await ensureDefaults();
        renderSetup();
      } catch (e) {
        app.innerHTML = `<div class="card"><div class="muted">Failed to load defaults: ${esc(e.message || e)}</div></div>`;
      }
      return;
    }

    if (route.page === "runs") {
      renderRuns();
      return;
    }

    if (route.page === "visualizer") {
      renderVisualizer();
      return;
    }

    if (route.page === "info") {
      renderInfo();
      return;
    }

    if (route.page === "run") {
      renderRun(route.runId);
      return;
    }

    if (route.page === "results") {
      renderResults(route.runId);
      return;
    }
  }

  document.body.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-nav]");
    if (!a) return;
    ev.preventDefault();
    nav(a.getAttribute("href") || "/setup");
  });

  window.addEventListener("popstate", render);
  render();
})();
