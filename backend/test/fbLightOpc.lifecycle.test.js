import test from "node:test";
import assert from "node:assert/strict";
import verified from "../../deploy/fixtures/garden_light_opcua_snapshot.verified.json" with { type: "json" };
import {
  SIEMENS_IFACE_URI,
  DEFAULT_OPC,
  prepareOpcSession,
  createStrictNamespaceSession,
  resetOpcDriverFactory,
  injectOpcDriver,
  createMockOpcDriver,
  LightOpcPoller,
} from "../src/fbLightOpcUa.js";

const NS = [
  "http://opcfoundation.org/UA/",
  SIEMENS_IFACE_URI,
  "http://Controls",
  "http://Sensors",
];

test("prepareOpcSession: getNamespaceIndex fails before readNamespaceArray (node-opcua contract)", async () => {
  const s = createStrictNamespaceSession(NS);
  assert.throws(() => s.getNamespaceIndex(SIEMENS_IFACE_URI), /readNamespaceArray/);
  await prepareOpcSession(s, { controls_ns_uri: DEFAULT_OPC.controls_ns_uri });
  assert.ok(s.nsLoaded());
  assert.equal(s.getNamespaceIndex(SIEMENS_IFACE_URI), 1);
  assert.equal(s.getNamespaceIndex("http://Controls"), 2);
});

test("prepareOpcSession: fail closed when Controls URI missing from server array", async () => {
  const s = createStrictNamespaceSession([NS[0], NS[1]]);
  await assert.rejects(
    () => prepareOpcSession(s, { controls_ns_uri: "http://Controls" }),
    /namespace URI puuttuu/,
  );
});

test("LightOpcPoller: connect loads namespace before first readGroup", async () => {
  const order = [];
  const namespaceCalls = [];
  const inner = createMockOpcDriver({ values: { ...verified.expected_ui_disabled_healthy } });
  let namespaceReady = false;

  const driver = {
    writes: inner.writes,
    async connect(_endpoint, cfg) {
      order.push("connect");
      const s = createStrictNamespaceSession(NS);
      await prepareOpcSession(s, cfg);
      namespaceCalls.push("readNamespaceArray");
      namespaceReady = true;
      await inner.connect();
    },
    async disconnect() {
      order.push("disconnect");
      namespaceReady = false;
      await inner.disconnect();
    },
    async readGroup(cfg) {
      order.push("readGroup");
      if (!namespaceReady) {
        return { values: {}, error: "please make sure that readNamespaceArray has been called" };
      }
      return inner.readGroup(cfg);
    },
    async writeFields(cfg, fields) {
      return inner.writeFields(cfg, fields);
    },
  };

  resetOpcDriverFactory();
  injectOpcDriver(driver);
  process.env.FB_LIGHT_OPC_CONNECT = "1";

  const poller = new LightOpcPoller();
  await poller.start({ opc: {}, poll_s: 3600 });
  assert.deepEqual(order.slice(0, 2), ["connect", "readGroup"]);
  assert.deepEqual(namespaceCalls, ["readNamespaceArray"]);
  assert.equal(poller.resolved, true);
  assert.equal(driver.writes.length, 0);

  await poller.stop();
  process.env.FB_LIGHT_OPC_CONNECT = "0";
  resetOpcDriverFactory();
});

test("LightOpcPoller: one reconnect re-reads namespace array after session fault", async () => {
  const inner = createMockOpcDriver({ values: { ...verified.expected_ui_disabled_healthy } });
  let connectCount = 0;
  let readCount = 0;

  const driver = {
    writes: inner.writes,
    async connect(_endpoint, cfg) {
      connectCount++;
      await prepareOpcSession(createStrictNamespaceSession(NS), cfg);
      await inner.connect();
    },
    async disconnect() {
      await inner.disconnect();
    },
    async readGroup(cfg) {
      readCount++;
      if (readCount === 1) {
        return { values: {}, error: "please make sure that readNamespaceArray has been called" };
      }
      return inner.readGroup(cfg);
    },
    async writeFields(cfg, fields) {
      return inner.writeFields(cfg, fields);
    },
  };

  resetOpcDriverFactory();
  injectOpcDriver(driver);
  process.env.FB_LIGHT_OPC_CONNECT = "1";

  const poller = new LightOpcPoller();
  await poller.start({ opc: {}, poll_s: 3600 });
  assert.equal(connectCount, 2);
  assert.equal(poller.resolved, true);
  assert.equal(driver.writes.length, 0);

  await poller.stop();
  process.env.FB_LIGHT_OPC_CONNECT = "0";
  resetOpcDriverFactory();
});
