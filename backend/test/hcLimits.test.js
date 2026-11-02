import test from "node:test";
import assert from "node:assert/strict";
import { hcWantFor, hcMatches, hcWriteOrder, outputStuck, stuckErrorBand, HEAT_OFF_LIMIT, DEFAULT_DEADBAND, MIN_STUCK_ERR } from "../src/hcLimits.js";
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
  // default deadband 1.0 °C: |e|=1 is inside band (not stuck); |e|=1.1 is stuck
  assert.equal(outputStuck({ state: 3, outSum: 12.95, pv: 22.9, sp: 24 }, lim), true);
  assert.equal(outputStuck({ state: 3, outSum: 12.95, pv: 23, sp: 24 }, lim), false); // |e|=1 <= default 1.0
  assert.equal(outputStuck({ state: 3, outSum: 12.95, pv: 23.97, sp: 24 }, lim), false); // within min 0.0625
  assert.equal(outputStuck({ state: 3, outSum: 0, pv: 25, sp: 24 }, lim), false); // cool off, clamped at 0
  assert.equal(outputStuck({ state: 3, outSum: 100, pv: 20, sp: 24 }, lim), false); // saturated heat
  assert.equal(outputStuck({ state: 0, outSum: 5, pv: 20, sp: 24 }, lim), false);
});
test("stuck skips inside PLC deadband (heat/cool)", () => {
  const lim = { upper: 100, lower: -100 };
  // PV < SP → heating DeadZone (HDZ)
  assert.equal(outputStuck({ state: 3, outSum: 10, pv: 23.2, sp: 24, hdz: 1, cdz: 1 }, lim), false); // |e|=0.8 <= HDZ
  assert.equal(outputStuck({ state: 3, outSum: 10, pv: 22.5, sp: 24, hdz: 1, cdz: 1 }, lim), true);  // |e|=1.5 > HDZ
  // PV > SP → cooling DeadZone (CDZ)
  assert.equal(outputStuck({ state: 3, outSum: -10, pv: 8.63, sp: 8, hdz: 1, cdz: 1 }, lim), false); // F1-like false alarm case
  assert.equal(outputStuck({ state: 3, outSum: -10, pv: 9.5, sp: 8, hdz: 1, cdz: 1 }, lim), true);
  // asymmetric: cool deadband 0.5, heat 2
  assert.equal(outputStuck({ state: 3, outSum: -5, pv: 8.4, sp: 8, hdz: 2, cdz: 0.5 }, lim), false); // |e|=0.4 <= CDZ 0.5
  assert.equal(outputStuck({ state: 3, outSum: -5, pv: 8.6, sp: 8, hdz: 2, cdz: 0.5 }, lim), true);  // |e|=0.6 > CDZ
  assert.equal(outputStuck({ state: 3, outSum: 5, pv: 22.5, sp: 24, hdz: 2, cdz: 0.5 }, lim), false); // |e|=1.5 <= HDZ 2
});
test("stuckErrorBand floor and fallback", () => {
  assert.equal(stuckErrorBand({}), DEFAULT_DEADBAND);
  assert.equal(stuckErrorBand({ deadband: 0.01 }), MIN_STUCK_ERR);
  assert.equal(stuckErrorBand({ pv: 10, sp: 9, hdz: 2, cdz: 0.8 }), 0.8); // PV>SP → CDZ
  assert.equal(stuckErrorBand({ pv: 9, sp: 10, hdz: 2, cdz: 0.8 }), 2);   // PV<SP → HDZ
});
