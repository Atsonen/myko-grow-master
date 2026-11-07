// Direct OPC UA for Garden_Light_DB — browse-path resolution, no hardcoded NodeIds.
// Real session only when FB_LIGHT_OPC_CONNECT=1 (production). Tests use injectOpcDriver(mock).
import { EventEmitter } from "node:events";

export const SIEMENS_IFACE_URI = "http://www.siemens.com/simatic-s7-opcua";
export const DEFAULT_OPC = {
  endpoint: "opc.tcp://192.168.1.103:4840",
  interfaces_id: "ServerInterfaces",
  interface_name: "Controls",
  controls_ns_uri: "http://Controls",
  db_browse_name: "Garden_Light_DB",
};

/** Read members (relative to DB). Static watchdog/* excluded. */
export const READ_MEMBERS = {
  Init: "Input/Init",
  Enable: "Input/Enable",
  Mode: "Input/Mode",
  OnHour: "Input/OnHour",
  OffHour: "Input/OffHour",
  LocalHour: "Input/LocalHour",
  ClockValid: "Input/ClockValid",
  HB_OK: "Input/HB_OK",
  LightOn: "Output/LightOn",
  ConfigOK: "Output/ConfigOK",
  ClockOK: "Output/ClockOK",
  ScheduleActive: "Output/ScheduleActive",
  Ready: "Output/Ready",
  Armed: "Static/Armed",
};

export const WRITE_MEMBERS = {
  Enable: "Input/Enable",
  Mode: "Input/Mode",
  OnHour: "Input/OnHour",
  OffHour: "Input/OffHour",
};

export function splitPath(rel) {
  return String(rel).split("/").filter(Boolean);
}

/** Pure: join interface + db + member for logs. */
export function memberPath(cfg, rel) {
  return `ServerInterfaces/${cfg.interface_name}/${cfg.db_browse_name}/${rel}`;
}

/**
 * node-opcua requires readNamespaceArray() before getNamespaceIndex() (ClientSessionImpl).
 * @param {import("node-opcua").ClientSession} session
 * @param {{ controls_ns_uri?: string }} [cfg]
 */
export async function prepareOpcSession(session, cfg = {}) {
  const uris = await session.readNamespaceArray();
  if (!Array.isArray(uris) || !uris.length) throw new Error("OPC NamespaceArray tyhjä");
  const required = [
    SIEMENS_IFACE_URI,
    cfg.controls_ns_uri ?? DEFAULT_OPC.controls_ns_uri,
  ];
  for (const u of required) {
    if (!uris.includes(u)) throw new Error(`namespace URI puuttuu palvelimelta: ${u}`);
    const idx = session.getNamespaceIndex(u);
    if (idx < 0) throw new Error(`getNamespaceIndex failed for ${u}`);
  }
  return uris;
}

/** Strict mock matching node-opcua ClientSessionImpl namespace gating (lifecycle tests). */
export function createStrictNamespaceSession(namespaceArray) {
  let loaded = false;
  const uris = [...namespaceArray];
  return {
    uris,
    nsLoaded: () => loaded,
    async readNamespaceArray() {
      loaded = true;
      return [...uris];
    },
    getNamespaceIndex(uri) {
      if (!loaded) throw new Error("please make sure that readNamespaceArray has been called");
      const idx = uris.indexOf(uri);
      if (idx < 0) throw new Error(`URI not in NamespaceArray: ${uri}`);
      return idx;
    },
  };
}

function statusGood(sc) {
  if (sc === undefined || sc === null) return true;
  if (typeof sc === "string") return sc === "Good";
  if (typeof sc === "object") {
    if (typeof sc.isGood === "function") return sc.isGood();
    if (sc.name === "Good" || sc.value === 0) return true;
  }
  return false;
}

export function mapReadValues(keys, values, statusCodes) {
  const out = {};
  let bad = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const sc = statusCodes?.[i];
    if (!statusGood(sc)) { bad++; continue; }
    out[k] = values[i];
  }
  out._quality = bad === keys.length ? "Bad" : bad > 0 ? "Uncertain" : "Good";
  return out;
}

/**
 * @typedef {{ connect(): Promise<void>, disconnect(): Promise<void>, readGroup(cfg: object): Promise<{values:object, error?:string}>, writeFields(cfg: object, fields: object): Promise<{ok:boolean, readback?:object, error?:string}> }} OpcDriver
 */

/** In-memory mock for unit tests — no network. */
export function createMockOpcDriver(opts = {}) {
  const writes = [];
  let values = { ...(opts.values ?? {}) };
  let dbName = opts.db_browse_name ?? DEFAULT_OPC.db_browse_name;
  let connected = false;
  let failResolve = opts.failResolve ?? false;
  return {
    writes,
    setValues(v) { values = { ...v }; },
    setDbName(n) { dbName = n; },
    async connect(_endpoint, _opcCfg) { connected = true; },
    async disconnect() { connected = false; },
    async readGroup(cfg) {
      if (!connected) return { values: {}, error: "not connected" };
      if (failResolve) return { values: {}, error: "resolve failed" };
      if (dbName !== cfg.db_browse_name) return { values: {}, error: `identity mismatch: ${dbName}` };
      return { values: { ...values, present: true } };
    },
    async writeFields(cfg, fields) {
      if (!connected) return { ok: false, error: "not connected" };
      writes.push({ ...fields });
      for (const [k, v] of Object.entries(fields)) {
        if (WRITE_MEMBERS[k]) values[k] = v;
      }
      const readback = {};
      for (const k of Object.keys(fields)) readback[k] = values[k];
      return { ok: true, readback };
    },
  };
}

async function createNodeOpcDriver() {
  const opcua = await import("node-opcua");
  const { OPCUAClient, AttributeIds, makeNodeId } = opcua;

  /** @type {import("node-opcua").ClientSession | null} */
  let session = null;
  let client = null;
  /** groupKey -> { dbNodeId, members: Record<string, NodeId> } */
  const cache = new Map();

  async function browseChild(parent, name) {
    const br = await session.browse(parent);
    const ref = (br.references ?? []).find((r) => r.browseName?.name === name);
    if (!ref) throw new Error(`browse: ${name} not found`);
    return ref.nodeId;
  }

  let sessionCfg = null;

  async function resolveDb(cfg) {
    const key = `${cfg.endpoint}|${cfg.db_browse_name}`;
    if (cache.has(key)) return cache.get(key);
    const siemensNs = session.getNamespaceIndex(SIEMENS_IFACE_URI);
    if (siemensNs < 0) throw new Error(`namespace index not found: ${SIEMENS_IFACE_URI}`);
    const root = makeNodeId(cfg.interfaces_id ?? DEFAULT_OPC.interfaces_id, siemensNs);
    const iface = await browseChild(root, cfg.interface_name ?? DEFAULT_OPC.interface_name);
    const db = await browseChild(iface, cfg.db_browse_name);
    const bn = await session.read({ nodeId: db, attributeId: AttributeIds.BrowseName });
    const name = bn.value?.value?.name ?? bn.value?.name;
    if (name !== cfg.db_browse_name) {
      throw new Error(`BrowseName mismatch: got ${name}`);
    }
    const members = {};
    for (const [field, rel] of Object.entries(READ_MEMBERS)) {
      let node = db;
      for (const seg of splitPath(rel)) node = await browseChild(node, seg);
      members[field] = node;
    }
    const writeNodes = {};
    for (const [field, rel] of Object.entries(WRITE_MEMBERS)) {
      let node = db;
      for (const seg of splitPath(rel)) node = await browseChild(node, seg);
      writeNodes[field] = node;
    }
    const pack = { dbNodeId: db, members, writeNodes };
    cache.set(key, pack);
    return pack;
  }

  return {
    async connect(endpoint, opcCfg = {}) {
      client = OPCUAClient.create({
        endpointMustExist: false,
        securityMode: opcua.MessageSecurityMode.None,
        securityPolicy: opcua.SecurityPolicy.None,
        connectionStrategy: { initialDelay: 1000, maxRetry: 2 },
      });
      await client.connect(endpoint);
      session = await client.createSession();
      sessionCfg = opcCfg;
      await prepareOpcSession(session, opcCfg);
      cache.clear();
    },
    async disconnect() {
      try { if (session) await session.close(); } catch { /* ignore */ }
      try { if (client) await client.disconnect(); } catch { /* ignore */ }
      session = null; client = null; sessionCfg = null; cache.clear();
    },
    async readGroup(cfg) {
      try {
        const { members } = await resolveDb(cfg);
        const keys = Object.keys(members);
        const nodes = keys.map((k) => members[k]);
        const dr = await session.read(nodes.map((nodeId) => ({ nodeId, attributeId: AttributeIds.Value })));
        const values = dr.map((d) => d.value?.value);
        const codes = dr.map((d) => d.statusCode);
        const mapped = mapReadValues(keys, values, codes);
        if (mapped._quality === "Bad") return { values: {}, error: "all Bad quality" };
        mapped.present = true;
        return { values: mapped };
      } catch (e) {
        const msg = String(e.message ?? e);
        if (/readNamespaceArray|NamespaceArray|BadSession|SessionId|not valid/i.test(msg)) {
          cache.clear();
        } else {
          cache.delete(`${cfg.endpoint}|${cfg.db_browse_name}`);
        }
        return { values: {}, error: msg };
      }
    },
    async writeFields(cfg, fields) {
      try {
        const { writeNodes } = await resolveDb(cfg);
        const readback = {};
        for (const [k, v] of Object.entries(fields)) {
          const nodeId = writeNodes[k];
          if (!nodeId) return { ok: false, error: `ei sallittu: ${k}` };
          const variantType = k === "Enable" ? opcua.DataType.Boolean : opcua.DataType.Int16;
          const status = await session.write({
            nodeId,
            attributeId: AttributeIds.Value,
            value: { value: { dataType: variantType, value: v } },
          });
          if (!statusGood(status)) return { ok: false, error: `write ${k} status ${status?.toString?.() ?? status}` };
          const rd = await session.read({ nodeId, attributeId: AttributeIds.Value });
          if (!statusGood(rd.statusCode)) return { ok: false, error: `readback ${k} Bad` };
          readback[k] = rd.value?.value;
        }
        return { ok: true, readback };
      } catch (e) {
        cache.delete(`${cfg.endpoint}|${cfg.db_browse_name}`);
        return { ok: false, error: String(e.message ?? e) };
      }
    },
  };
}

let injectedDriver = null;
let driverPromise = null;

export function injectOpcDriver(driver) {
  injectedDriver = driver;
}

export function resetOpcDriverFactory() {
  injectedDriver = null;
  driverPromise = null;
}

export async function getOpcDriver() {
  if (injectedDriver) return injectedDriver;
  if (!driverPromise) driverPromise = createNodeOpcDriver();
  return driverPromise;
}

export class LightOpcPoller extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.driver = null;
    this.endpoint = null;
    this.running = false;
    this.lastError = null;
    this.resolved = false;
  }

  opcCfg(base) {
    return {
      endpoint: base.endpoint ?? process.env.FB_LIGHT_OPC_ENDPOINT ?? DEFAULT_OPC.endpoint,
      interfaces_id: base.interfaces_id ?? DEFAULT_OPC.interfaces_id,
      interface_name: base.interface_name ?? DEFAULT_OPC.interface_name,
      controls_ns_uri: base.controls_ns_uri ?? DEFAULT_OPC.controls_ns_uri,
      db_browse_name: base.db_browse_name ?? DEFAULT_OPC.db_browse_name,
    };
  }

  async start({ opc, poll_s = 5 }) {
    if (this.running) return;
    const connect = process.env.FB_LIGHT_OPC_CONNECT === "1";
    if (!connect) {
      console.log("[fblight-opc] FB_LIGHT_OPC_CONNECT!=1 — ei OPC-yhteyttä (read vain testeissä/mock)");
      this.driver = await getOpcDriver();
      this.opc = this.opcCfg(opc ?? {});
      this.running = true;
      return;
    }
    this.driver = await getOpcDriver();
    this.opc = this.opcCfg(opc ?? {});
    this.endpoint = this.opc.endpoint;
    await this.driver.connect(this.endpoint, this.opc);
    this.running = true;
    const tick = async () => {
      let r = await this.driver.readGroup(this.opc);
      if (r.error && /readNamespaceArray|BadSession|SessionId|not valid/i.test(r.error) && this.driver.disconnect) {
        try {
          await this.driver.disconnect();
          await this.driver.connect(this.endpoint, this.opc);
          r = await this.driver.readGroup(this.opc);
        } catch (re) {
          r = { values: {}, error: String(re.message ?? re) };
        }
      }
      if (r.error) {
        this.lastError = r.error;
        this.resolved = false;
        this.emit("snapshot", { error: r.error, values: {} });
        return;
      }
      this.lastError = null;
      this.resolved = true;
      this.emit("snapshot", { values: r.values });
    };
    await tick();
    this.timer = setInterval(() => { tick().catch((e) => { this.lastError = String(e.message ?? e); }); }, Math.max(2, poll_s) * 1000);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.driver?.disconnect) await this.driver.disconnect();
    this.running = false;
  }

  async write(fields) {
    if (!this.driver) return { ok: false, error: "OPC ei käynnissä" };
    if (process.env.FB_LIGHT_OPC_CONNECT !== "1") {
      return { ok: false, error: "OPC-kirjoitus estetty (FB_LIGHT_OPC_CONNECT!=1)" };
    }
    if (!this.resolved) return { ok: false, error: "OPC identity/resolve epäonnistui" };
    return this.driver.writeFields(this.opc, fields);
  }

  status() {
    return {
      connect_enabled: process.env.FB_LIGHT_OPC_CONNECT === "1",
      running: this.running,
      resolved: this.resolved,
      last_error: this.lastError,
      endpoint: this.endpoint ?? this.opc?.endpoint ?? null,
    };
  }
}
