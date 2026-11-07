import test from "node:test";
import assert from "node:assert/strict";
import {
  createMockOpcDriver,
  injectOpcDriver,
  mapReadValues,
  memberPath,
  READ_MEMBERS,
  WRITE_MEMBERS,
  splitPath,
} from "../src/fbLightOpcUa.js";
import {
  ingestLightSnapshot,
  validateLightWrite,
  validateOpcSnapshot,
  lightAlarmConditions,
  normalizePlcPayload,
  stopFbLightForTests,
  startFbLight,
  __test,
} from "../src/fbLight.js";
import verified from "../../deploy/fixtures/garden_light_opcua_snapshot.verified.json" with { type: "json" };

test("splitPath and memberPath", () => {
  assert.deepEqual(splitPath("Input/Enable"), ["Input", "Enable"]);
  assert.match(memberPath({ interface_name: "Controls", db_browse_name: "Garden_Light_DB" }, "Input/Enable"),
    /Controls\/Garden_Light_DB\/Input\/Enable/);
});

test("mapReadValues marks Bad when all status bad", () => {
  const keys = ["Enable", "Mode"];
  const mapped = mapReadValues(keys, [true, 0], ["Bad", "Bad"]);
  assert.equal(mapped._quality, "Bad");
});

test("mock opc: identity mismatch fail closed", async () => {
  const mock = createMockOpcDriver({ db_browse_name: "Wrong_DB", values: verified.expected_ui_disabled_healthy });
  injectOpcDriver(mock);
  await mock.connect();
  const r = await mock.readGroup({ db_browse_name: "Garden_Light_DB" });
  assert.match(r.error, /mismatch/);
});

test("mock opc: allowlist write + readback, forbidden rejected at API layer", async () => {
  const mock = createMockOpcDriver({ values: { ...verified.expected_ui_disabled_healthy } });
  injectOpcDriver(mock);
  await mock.connect();
  const wr = await mock.writeFields({ db_browse_name: "Garden_Light_DB" }, { Enable: true, Mode: 1 });
  assert.equal(wr.ok, true);
  assert.equal(wr.readback.Enable, true);
  assert.equal(mock.writes.length, 1);
  assert.match(validateLightWrite({ Init: true }).error, /kielletty/);
  assert.equal(Object.keys(WRITE_MEMBERS).length, 4);
  assert.ok(!READ_MEMBERS.Watchdog);
});

test("no startup opc writes", async () => {
  const mock = createMockOpcDriver();
  injectOpcDriver(mock);
  process.env.FB_LIGHT_OPC_CONNECT = "0";
  startFbLight();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.writes.length, 0);
  stopFbLightForTests();
});

test("ingest verified disabled healthy – no alarms", () => {
  __test.resetState();
  ingestLightSnapshot("garden", { ...verified.expected_ui_disabled_healthy, present: true });
  const plc = normalizePlcPayload(verified.expected_ui_disabled_healthy);
  assert.equal(validateOpcSnapshot(verified.expected_ui_disabled_healthy).ok, true);
  const cond = lightAlarmConditions({ ...plc, present: true }, { stale: false, mappingOk: true });
  assert.equal(cond.hb?.[0] ?? false, false);
});
