import test from "node:test";
import assert from "node:assert/strict";
import { planFromSteps, checkPreconditions, buildSymptom, formatProposal, proposalButtons } from "../src/autoRecovery.js";
import { matchFixes } from "../src/kunnossapito.js";
const steps = [
  { n: 1, method: "POST", endpoint: "http://localhost:3010/api/pid/{key}/cmd", body: { ErrorAck: true }, only_if: "ErrBits!=0" },
  { n: 2, wait_s: 2, check: "ErrBits==0" },
  { n: 3, method: "POST", endpoint: "http://localhost:3010/api/pid/{key}/cmd", body: { Mode: 3, ModeActivate: true } }];
const fix = { id: 1, name: "PID restart recovery", times_worked: 2, autonomy_allowed: 1, steps: JSON.stringify(steps), preconditions: "",
  trigger_conditions: JSON.stringify({ system: "PLC_2", devices: ["T1", "G_Air", "F1"], any_of: ["PLC restart/download", "PID output frozen", "ErrBits!=0"], symptoms: ["PID_LAHTO_JUMISSA", "ERRORBITS"] }) };
const now = 1_000_000_000;
test("plan: only whitelisted cmd bodies", () => {
  const p = planFromSteps(steps);
  assert.deepEqual(p.map((s) => s.kind), ["cmd", "wait", "cmd"]); assert.equal(p[0].onlyIfErr, true);
  assert.throws(() => planFromSteps([{ n: 1, method: "POST", endpoint: "http://localhost:3010/api/pid/{key}/cmd", body: { ManualEnable: true } }]));
  assert.throws(() => planFromSteps([{ n: 1, method: "POST", endpoint: "http://localhost:3010/api/controls", body: { ErrorAck: true } }]));
  assert.throws(() => planFromSteps([{ n: 1, method: "POST", endpoint: "http://localhost:3010/api/pid/{key}/cmd", body: { Mode: 0, ModeActivate: true } }]));
});
test("preconditions", () => {
  const v = { PV: 22.9, Mode: 3, State: 3, ManEn: false };
  assert.ok(checkPreconditions(v, { at: now, pvAt: now, restartAt: 0, now }).ok);
  assert.ok(!checkPreconditions({ ...v, PV: 0 }, { at: now, pvAt: now, restartAt: 0, now }).ok);   // tonight 21:54: input 0
  assert.ok(!checkPreconditions({ ...v, PV: 5.1 }, { at: now, pvAt: now, restartAt: 0, now }).ok); // F1 range -> never
  assert.ok(!checkPreconditions({ ...v, ManEn: true }, { at: now, pvAt: now, restartAt: 0, now }).ok);
  assert.ok(!checkPreconditions(v, { at: now, pvAt: now - 120_000, restartAt: now - 90_000, now }).ok); // PV not updated after restart
  assert.ok(!checkPreconditions(v, { at: now, pvAt: now, restartAt: now - 20_000, now }).ok); // settle 60 s
  assert.ok(checkPreconditions(v, { at: now, pvAt: now - 1000, restartAt: now - 90_000, now }).ok);
});
test("symptom + match: tonight's T1 case is eligible", () => {
  const sym = buildSymptom("T1", { ErrBits: 1 }, [], { errSince: now - 60_000, restartAt: now - 25 * 60_000, now });
  assert.deepEqual(sym.conditions, ["PLC restart/download"]);
  const m = matchFixes(sym, [fix]); assert.equal(m.length, 1); assert.equal(m[0].autonomy_eligible, true);
  assert.equal(buildSymptom("T1", { ErrBits: 1 }, [], { errSince: now - 5_000, restartAt: 0, now }), null); // ErrBits < 30 s
  assert.equal(buildSymptom("T1", { ErrBits: 0 }, ["SATUROITUNUT"], { restartAt: now, now }), null);    // restart alone = no action
  assert.equal(matchFixes({ ...sym, device: "LVV" }, [fix]).length, 0);
  assert.equal(matchFixes(sym, [{ ...fix, times_worked: 0 }])[0].autonomy_eligible, false);
  assert.equal(matchFixes(sym, [{ ...fix, autonomy_allowed: 0 }])[0].autonomy_eligible, false);
});
test("telegram message format", () => {
  const sym = { system: "PLC_2", device: "T1", conditions: ["PLC restart/download"], symptoms: ["ERRORBITS", "ErrBits!=0"] };
  const m = matchFixes(sym, [fix])[0];
  const t = formatProposal({ k: "T1", v: { PV: 22.88, CSP: 24, OutSum: 0, ErrBits: 1, Mode: 3, State: 3 }, sym, fix: m, deadline: now, test: true });
  assert.match(t, /TESTI/); assert.match(t, /ErrorAck/); assert.match(t, /ModeActivate/); assert.match(t, /automaattisesti klo/);
  assert.deepEqual(proposalButtons("ab").inline_keyboard[0].map((b) => b.callback_data), ["kp:ab:do", "kp:ab:skip"]);
  console.log("\n" + t);
});
