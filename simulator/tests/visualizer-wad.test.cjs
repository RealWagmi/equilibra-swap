const fs = require("fs");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(
  path.join(process.cwd(), "simulator/visualizer/index.html"),
  "utf8",
);
function fn(name) {
  const start = source.indexOf("      function " + name + "(");
  assert.ok(start >= 0, name);
  const next = source.indexOf("\n      function ", start + 1);
  return source.slice(start, next);
}
const fields = new Map();
function field(value) {
  return {
    value,
    error: "",
    setCustomValidity(e) {
      this.error = e;
    },
    setAttribute() {},
    reportValidity() {},
  };
}
let lastPayload;
const context = {
  document: {
    getElementById: (id) => {
      if (!fields.has(id)) fields.set(id, field("1"));
      return fields.get(id);
    },
    activeElement: null,
  },
  getParams: () => ({ x1: 1, y1: 1, x2: 1, y2: 1 }),
  toSolidityUint: String,
  updatePwSolidity() {
    lastPayload = context.getPwLegacySolidityParams();
  },
  saveVisualizerAlphaBetaSnapshot() {},
  saveVisualizerCurveSnapshot() {},
  saveVisualizerUiState() {},
  clearTimeout() {},
  setTimeout: () => 1,
};
vm.createContext(context);
const start = source.indexOf("      const PW_WAD =");
const end = source.indexOf("      // YieldBasis reference-AMM", start);
vm.runInContext(
  source.slice(start, end) +
    "\nconst PW_NONLINEAR_K = 3; let updateTimer = null; const UPDATE_DEBOUNCE_MS = 1;\n" +
    [
      "pwWadToDecimal",
      "pwReadKnobWad",
      "pwSliderWad",
      "getPwLegacySolidityParams",
      "_pwClamp",
      "pwAlphaValueToT",
      "pwLambdaValueToT",
      "setLegacySliderFromScaled",
      "parsePwParamsString",
      "onPwFineInputCommit",
      "onPwFineInputType",
      "onPwAlphaSliderInput",
      "onSliderChange",
    ]
      .map(fn)
      .join("\n"),
  context,
);
fields.set("pwAlphaFine", field("0.999999999999999999"));
fields.set("pwLambdaFine", field("0.001"));
fields.set("pwAlpha", field("1"));
fields.set("pwLambda", field("0"));
const max = 999999999999999999n;
assert.equal(context.getPwLegacySolidityParams().aWad, max);
context.onPwFineInputCommit("pwAlphaFine", "pwAlpha");
assert.equal(fields.get("pwAlphaFine").value, "0.999999999999999999");
assert.equal(
  lastPayload.aWad,
  max,
  "actual redraw must not rewrite fine input through Number",
);
fields.get("pwAlphaFine").value = "0.999999999999999998";
assert.equal(context.getPwLegacySolidityParams().aWad, max - 1n);
fields.get("pwAlphaFine").value = "1";
assert.throws(() => context.getPwLegacySolidityParams());
assert.ok(fields.get("pwAlphaFine").error.includes("0.999999999999999999"));
fields.get("pwAlphaFine").value = "0.9999999999999999999";
assert.throws(() => context.getPwLegacySolidityParams());
context.setLegacySliderFromScaled("pwAlpha", max, 5);
assert.equal(fields.get("pwAlphaFine").value, "0.999999999999999999");
assert.equal(context.getPwLegacySolidityParams().aWad, max);
context.onPwAlphaSliderInput();
assert.equal(fields.get("pwAlphaFine").value, "0.999999999999999999");
assert.equal(
  context.parsePwParamsString(
    "aWad:999999999999999999, lambdaWad:1000000000000000",
  ).ok,
  true,
);
assert.equal(
  context.parsePwParamsString(
    "aWad:1000000000000000000, lambdaWad:1000000000000000",
  ).ok,
  false,
);
fields.get("pwLambdaFine").value = "0.000001";
assert.equal(context.getPwLegacySolidityParams().lambdaWad, 1000000000000n);
context.setLegacySliderFromScaled("pwLambda", 1000000000000n, 5);
assert.equal(fields.get("pwLambdaFine").value, "0.000001");
assert.equal(context.pwSliderWad(0, 1000000000000n, 1000000000000000000n, false), 1000000000000n);
fields.get("pwLambdaFine").value = "0.000000999999999999";
assert.throws(() => context.getPwLegacySolidityParams());
assert.equal(context.parsePwParamsString("aWad:999999999999999999, lambdaWad:999999999999").ok, false);
let previous = 100000000000000000n;
for (let step = 0; step <= 10000; step++) {
  const next = context.pwSliderWad(
    step / 10000,
    100000000000000000n,
    max,
    true,
  );
  assert.ok(next >= previous && next <= max);
  previous = next;
}
assert.equal(previous, max);
console.log(
  "PASS: exact WAD entry, commit, restore, paste, API payload, endpoints and 10001 slider stops",
);
