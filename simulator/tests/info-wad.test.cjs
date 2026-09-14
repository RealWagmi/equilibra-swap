const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = readFileSync(path.join(__dirname, "../Info/app.js"), "utf8");
function actualFunction(name, async = false) {
  const start = source.indexOf(`  ${async ? "async " : ""}function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n  }", start) + 4;
  return source.slice(start, end);
}

test("Info slider endpoint, preset strings and actual API payload keep exact WAD values", async () => {
  const requests = [];
  const context = {
    WAD: 10n ** 18n,
    scheduleFetch() {},
    aInput: { value: "0.9999999999999999", max: "0.9999999999999999" },
    lambdaInput: { value: "0.001", max: "1" },
    marketInput: { value: "1" },
    aOut: {}, lambdaOut: {}, marketOut: {}, snapAWad: {}, snapLambdaWad: {},
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    referenceAmmParams: { mathMode: "crypto", A: 400000, gamma: "145000000000000" },
    VIZ_PRESET_KEY: "WBTC", VIZ_SAMPLES: 80, VIZ_MAX_DEPLETION_BPS: 9900,
    fetch: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ slippage: { equilibra: [
        { d: 0, liquidity: 100, penalty: 0 },
        { d: 0.5, liquidity: 0, penalty: null },
        { d: 0.9, liquidity: 10, penalty: 1 },
      ] } }) };
    },
  };
  vm.createContext(context);
  vm.runInContext("const exactKnobValues = new WeakMap();\n" + [
    "toWadString", "setWadKnob", "onKnobInput", "applyPreset", "readWadKnob", "readParams", "wadStringToDisplay",
    "syncOutputs", "syncSnapKnobs", "liquidityAt",
  ].map(name => actualFunction(name)).join("\n") + "\n" + actualFunction("fetchBellSeries", true), context);

  const max = "999999999999999999";
  assert.equal(context.toWadString("0.999999999999999999"), max);
  assert.equal(context.toWadString("0.999999999999999998"), "999999999999999998");
  assert.equal(context.wadStringToDisplay(max, "a"), "0.999999999999999999");
  for (const raw of ["843002221199887766", "999750060000000000", max]) {
    assert.equal(context.toWadString(context.wadStringToDisplay(raw, "a")), raw);
  }
  const params = context.readParams();
  assert.equal(params.aWad, max);
  assert.equal(params.lambdaWad, "1000000000000000");
  assert.ok(params.a < 1, "canvas number stays below one, separate from request precision");
  context.syncOutputs(params);
  context.syncSnapKnobs(params.aWad, params.lambdaWad);
  assert.equal(context.aOut.textContent, "0.999999999999999999");
  assert.equal(context.snapAWad.textContent, "0.999999999999999999");
  const series = await context.fetchBellSeries(params.aWad, params.lambdaWad);
  assert.equal(requests[0].url, "/api/visualizer/series");
  assert.equal(requests[0].payload.equilibra.aWad, max);
  assert.equal(series[1].penalty, null, "unavailable is not a zero-penalty point");
  assert.ok(Number.isNaN(context.liquidityAt(0.5, series)), "do not bridge unavailable samples");
  context.aInput.value = "0.99975006";
  assert.equal(context.readParams().aWad, "999750060000000000");
  assert.throws(() => context.toWadString("0.9999999999999999999"));
  context.applyPreset({ a: "0.909610000000000030", lambda: "0.01678" });
  const exactPreset = context.readParams();
  assert.equal(exactPreset.aWad, "909610000000000030");
  assert.equal(exactPreset.lambdaWad, "16780000000000000");
  context.syncOutputs(exactPreset);
  assert.equal(context.lambdaOut.textContent, "0.01678");
  await context.fetchBellSeries(exactPreset.aWad, exactPreset.lambdaWad);
  assert.equal(requests.at(-1).payload.equilibra.lambdaWad, "16780000000000000");
  context.lambdaInput.value = "0.000001";
  context.onKnobInput(context.lambdaInput);
  assert.equal(context.readParams().lambdaWad, "1000000000000");
  await context.fetchBellSeries(context.readParams().aWad, context.readParams().lambdaWad);
  assert.equal(requests.at(-1).payload.equilibra.lambdaWad, "1000000000000");
  context.lambdaInput.value = "0.000000999999999999";
  assert.equal(context.readParams().lambdaWad, "1000000000000", "Info clamps below-minimum input");
  context.aInput.value = "0.8";
  context.onKnobInput(context.aInput);
  assert.equal(context.readParams().aWad, "800000000000000000");
});

test("Curve Lab health renders rejected trials as unavailable, not zero-error OK", () => {
  const html = readFileSync(path.join(__dirname, "../visualizer/index.html"), "utf8");
  const start = html.indexOf("      function renderSolverHealth(");
  const end = html.indexOf("\n      function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const fields = Object.fromEntries(["solverHealth", "solverHealthText", "solverHealthRange", "solverInfoLive"]
    .map(name => [name, { dataset: {}, textContent: "", innerHTML: "" }]));
  const context = { document: { getElementById: name => fields[name] } };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.renderSolverHealth({ status: "bad", rejectedSamples: 41, samples: 0, worstErrorPct: 0,
    monotonicityBreaks: 0, safePriceLow: null, firstBadPrice: null });
  assert.equal(fields.solverHealth.dataset.status, "bad");
  assert.match(fields.solverHealthText.textContent, /41 unavailable samples/);
  assert.match(fields.solverInfoLive.innerHTML, /not zero-error samples/);
  assert.doesNotMatch(fields.solverInfoLive.innerHTML, /0\.0000% less|no failing sample/);
});

// The real HTML must allow the preset, not silently snap it to 0.017.
test("Info ranges do not quantize exact preset values to a coarser step", () => {
  const html = readFileSync(path.join(__dirname, "../Info/index.html"), "utf8");
  for (const id of ["aRange", "lambdaRange"]) {
    const input = html.match(new RegExp('<input\\s+id="' + id + '"[^>]*>', 's'))?.[0];
    assert.ok(input, id);
    assert.match(input, /step="any"/);
    if (id === "lambdaRange") assert.match(input, /min="0.000001"/);
  }
});
