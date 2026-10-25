import test from "node:test";
import assert from "node:assert/strict";
import { hcWantFor, hcMatches, hcWriteOrder, outputStuck, HEAT_OFF_LIMIT } from "../src/hcLimits.js";
const on = { heatOn: 100, coolOn: -100 };
const full = { HeatUpperLimit: 100, HeatUpperScaling: 100, HeatPwmUpperScaling: 100, HeatPerUpperScaling: 27648, CoolLowerLimit: -100, ActivateCooling: true };
test("both on = full config", () => assert.deepEqual(hcWantFor(on, true, true), full));
test("both off = full config (PID made Inactive separately)", () => assert.deepEqual(hcWantFor(on, false, false), full));
test("cool off: ActivateCooling false, limits stay valid (no zero span)", () => {
  const w = hcWantFor(on, true, false);
  assert.equal(w.ActivateCooling, false); assert.equal(w.CoolLowerLimit, -100); assert.equal(w.HeatUpperLimit, 100);
});
test("heat off: non-zero span AND all heat scalings 0 (no tiny-span full output)", () => {
  const w = hcWantFor(on, false, true);
  assert.equal(w.HeatUpperLimit, HEAT_OFF_LIMIT); assert.ok(w.HeatUpperLimit > 0);
  assert.equal(w.HeatUpperScaling + w.HeatPwmUpperScaling + w.HeatPerUpperScaling, 0);
  assert.equal(w.ActivateCooling, true);
});
test("no config ever has a zero-width or tiny limit span with normal scaling", () => {
  for (const h of [true, false]) for (const c of [true, false]) {
    const w = hcWantFor(on, h, c);
    assert.ok(w.HeatUpperLimit >= 1 && w.CoolLowerLimit <= -1);
    if (w.HeatUpperLimit < 50) assert.equal(w.HeatPwmUpperScaling, 0);
  }
});
test("write order: heat off scalings before limit; heat on limit before scalings", () => {
  const off = hcWriteOrder(hcWantFor(on, false, true));
  assert.ok(off.indexOf("HeatPwmUpperScaling") < off.indexOf("HeatUpperLimit"));
  const onO = hcWriteOrder(hcWantFor(on, true, true));
  assert.ok(onO.indexOf("HeatUpperLimit") < onO.indexOf("HeatPwmUpperScaling"));
});
test("readback matching incl. booleans, null fails", () => {
  const w = hcWantFor(on, true, false);
  assert.equal(hcMatches(w, { ...w }), true);
  assert.equal(hcMatches(w, { ...w, ActivateCooling: true }), false);
  assert.equal(hcMatches(w, { ...w, HeatUpperLimit: null }), false);
});
test("stuck output detection", () => {
  const lim = { upper: 100, lower: 0 };
  assert.equal(outputStuck({ state: 3, outSum: 12.95, pv: 23, sp: 24 }, lim), true);
  assert.equal(outputStuck({ state: 3, outSum: 12.95, pv: 23.97, sp: 24 }, lim), false); // within 0.0625
  assert.equal(outputStuck({ state: 3, outSum: 0, pv: 25, sp: 24 }, lim), false); // cool off, clamped at 0
  assert.equal(outputStuck({ state: 3, outSum: 100, pv: 20, sp: 24 }, lim), false); // saturated heat
  assert.equal(outputStuck({ state: 0, outSum: 5, pv: 20, sp: 24 }, lim), false);
});
