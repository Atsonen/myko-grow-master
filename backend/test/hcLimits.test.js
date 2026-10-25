import test from "node:test";
import assert from "node:assert/strict";
import { hcWantFor, hcMatches } from "../src/hcLimits.js";
const on = { heatOn: 100, coolOn: -100 };
test("off is exactly 0 (no epsilon: a tiny span would mean 100 % output)", () => {
  assert.deepEqual(hcWantFor(on, false, false), { HeatUpperLimit: 0, CoolLowerLimit: 0 });
});
test("on restores full limits", () => assert.deepEqual(hcWantFor(on, true, true), { HeatUpperLimit: 100, CoolLowerLimit: -100 }));
test("bad stored ON value (0) falls back to defaults", () => assert.deepEqual(hcWantFor({ heatOn: 0, coolOn: 0 }, true, true), { HeatUpperLimit: 100, CoolLowerLimit: -100 }));
test("readback: stale 0 does not match ON, null/NaN fail", () => {
  const w = hcWantFor(on, true, false);
  assert.equal(hcMatches(w, { HeatUpperLimit: 0, CoolLowerLimit: 0 }), false);
  assert.equal(hcMatches(w, { HeatUpperLimit: null, CoolLowerLimit: 0 }), false);
  assert.equal(hcMatches(w, { HeatUpperLimit: 100, CoolLowerLimit: 0 }), true);
});
