import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLightWrite,
  validateMqttContract,
  scheduleHint,
  normalizePlcPayload,
  outputIndication,
  lightAlarmConditions,
  fbLightAlarmRows,
  fbLightAck,
  __test,
} from "../src/fbLight.js";
import verified from "../../deploy/fixtures/garden_light_opcua_snapshot.verified.json" with { type: "json" };

const { lightId, resetState, forceAlarm } = __test;

test("validateLightWrite allowlist", () => {
  assert.deepEqual(validateLightWrite({ Enable: true, Mode: 1, OnHour: 6, OffHour: 22 }).ok, {
    Enable: true, Mode: 1, OnHour: 6, OffHour: 22,
  });
  assert.match(validateLightWrite({ Init: true }).error, /kielletty/);
  assert.match(validateLightWrite({ HB_OK: true }).error, /kielletty/);
  assert.match(validateLightWrite({ OnHour: 24 }).error, /OnHour/);
  assert.match(validateLightWrite({ Mode: 3 }).error, /sallitut/);
});

test("scheduleHint overnight on inclusive off exclusive", () => {
  assert.deepEqual(scheduleHint(5, 8, 8), { text: "Pois (On=Off)", inWindow: false });
  assert.equal(scheduleHint(7, 6, 18).inWindow, true);
  assert.equal(scheduleHint(20, 6, 18).inWindow, false);
  assert.equal(scheduleHint(23, 22, 6).inWindow, true);
  assert.equal(scheduleHint(5, 22, 6).inWindow, true);
  assert.equal(scheduleHint(6, 22, 6).inWindow, false);
});

test("outputIndication prefers feedback when present", () => {
  const a = outputIndication(normalizePlcPayload({ LightOn: true, LightFb: false }));
  assert.equal(a.kind, "fb");
  assert.equal(a.text, "Palaute OFF");
  const b = outputIndication(normalizePlcPayload({ LightOn: true }));
  assert.equal(b.kind, "cmd");
  assert.equal(b.text, "Käsky ON");
});

test("verified OPC disabled healthy snapshot – no alarms", () => {
  const snap = { ...verified.expected_ui_disabled_healthy, present: true };
  assert.equal(validateMqttContract(snap).ok, true);
  const plc = normalizePlcPayload(snap);
  const cond = lightAlarmConditions(plc, { stale: false, mappingOk: true });
  assert.equal(cond.hb?.[0] ?? false, false);
  assert.equal(cond.config?.[0] ?? false, false);
  assert.equal(cond.clock?.[0] ?? false, false);
});

test("validateMqttContract fail closed on wrong types", () => {
  assert.equal(validateMqttContract({ Enable: "true" }).ok, false);
  assert.equal(validateMqttContract({ Mode: 1.5 }).ok, false);
});

test("lightAlarmConditions: stale mapped topic may raise offline", () => {
  const plc = normalizePlcPayload({ present: false });
  const cond = lightAlarmConditions(plc, { stale: true, mappingOk: true });
  assert.equal(cond.offline?.[0], false);
});

test("lightAlarmConditions: hb and clock in auto", () => {
  const hb = normalizePlcPayload({ present: true, Enable: true, HB_OK: false, Mode: 1, ConfigOK: true, ClockOK: true, ClockValid: true });
  assert.equal(lightAlarmConditions(hb, { stale: false, mappingOk: true }).hb[0], true);
  const clk = normalizePlcPayload({ present: true, Enable: true, HB_OK: true, Mode: 1, ConfigOK: true, ClockOK: false, ClockValid: false });
  assert.equal(lightAlarmConditions(clk, { stale: false, mappingOk: true }).clock[0], true);
});

test("mapping unconfigured: no hb alarm from conditions alone", () => {
  const plc = normalizePlcPayload({ present: false });
  const cond = lightAlarmConditions(plc, { stale: true, mappingOk: false });
  assert.equal(cond.offline?.[0] ?? false, false);
  assert.equal(cond.hb?.[0] ?? false, false);
});

test("alarm rows + ack id range", () => {
  resetState();
  forceAlarm("kasvamo", "hb");
  const rows = fbLightAlarmRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pointId, "Kasvamo_Light_kasvamo");
  const id = lightId("kasvamo", "hb");
  assert.equal(rows[0].id, id);
  assert.ok(id <= -1_840_000_000 && id > -1_849_000_000);
  assert.equal(fbLightAck([id], "tester"), 1);
  const after = fbLightAlarmRows();
  assert.equal(after[0].acked, true);
});
