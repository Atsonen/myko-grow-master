// FB_FillPump – Pumput_DB.Static.FillPump (1.11.2026).
// LUKU: opcua-bridge -> MQTT Sensors/PLC_2/FillPump.
// KIRJOITUS (hyväksytty 1.11.2026, vain UI): Cfg_Enable, Cfg_LvlSP (0–100), Cfg_Hyst (0–20),
//   Cfg_MaxRun_s (10–3600), Cfg_LvlMin/Cfg_LvlMax (0–100), Cmd_Ack (TRUE; PLC nollaa).
// EI startup-/tick-synkkaa – mitään ei kirjoiteta käynnistyksessä.
import mqtt from "mqtt";

const TOPIC = "Sensors/PLC_2/FillPump";
const CMD_TOPIC = "Myko/Cmd/FillPump";
const WRITE_ALLOWED = true; // hyväksytty 1.11.2026
const ERR = { 0: "ok", 1: "Maksimitäyttöaika ylittyi", 2: "Pinta-anturivika" };
const ALLOWED = {
  Cfg_Enable: { type: "bool" },
  Cfg_LvlSP: { type: "float", min: 0, max: 100 },
  Cfg_Hyst: { type: "float", min: 0, max: 20 },
  Cfg_MaxRun_s: { type: "int", min: 10, max: 3600 },
  Cfg_LvlMin: { type: "float", min: 0, max: 100 },
  Cfg_LvlMax: { type: "float", min: 0, max: 100 },
  Cmd_Ack: { type: "ack" }, // vain TRUE / pulse
};

let MQ = null;
const PENDING = new Map();
const S = { plc: { present: false }, at: 0 };

function cmd(body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!MQ?.connected) return resolve(null);
    const id = `fp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const to = setTimeout(() => { PENDING.delete(id); resolve(null); }, timeoutMs);
    PENDING.set(id, (j) => { clearTimeout(to); resolve(j); });
    MQ.publish(CMD_TOPIC, JSON.stringify({ id, by: "myko-ui", ...body }), { qos: 1 });
  });
}

function validate(body) {
  const out = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (["confirm", "by"].includes(k)) continue;
    const a = ALLOWED[k];
    if (!a) return { error: `ei sallittu: ${k}` };
    if (a.type === "bool") {
      if (typeof v !== "boolean") return { error: `${k}: bool` };
      out[k] = v;
    } else if (a.type === "ack") {
      if (v !== true && v !== "pulse") return { error: `${k}: odottaa true/pulse` };
      out[k] = true;
    } else if (a.type === "float") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < a.min || n > a.max) return { error: `${k}: ${a.min}–${a.max}` };
      out[k] = n;
    } else if (a.type === "int") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < a.min || n > a.max) return { error: `${k}: ${a.min}–${a.max} (kokonaisluku)` };
      out[k] = n;
    }
  }
  if (!Object.keys(out).length) return { error: "ei kirjoitettavia kenttiä" };
  return { ok: out };
}

export function startFillPump({ mqttUrl }) {
  const mq = mqtt.connect(mqttUrl, { clientId: `myko-backend-fillpump-${process.pid}`, reconnectPeriod: 5000 });
  MQ = mq;
  mq.on("connect", () => { mq.subscribe(TOPIC); mq.subscribe(CMD_TOPIC + "/ack"); });
  mq.on("message", (t, buf) => {
    try {
      const j = JSON.parse(buf.toString());
      if (t === TOPIC) { S.plc = j; S.at = Date.now(); }
      else if (j?.id && PENDING.has(j.id)) { PENDING.get(j.id)(j); PENDING.delete(j.id); }
    } catch { /* ignore */ }
  });
  mq.on("error", () => undefined);
  // EI setInterval / Enable-synkkaa
}

export function registerFillPumpRoutes(app) {
  app.get("/api/fillpump", (_req, res) => {
    const stale = !S.at || Date.now() - S.at > 30_000;
    const p = S.plc || {};
    res.json({
      plc: p,
      plc_at: S.at ? new Date(S.at).toISOString() : null,
      stale,
      present: !!p.present && !stale,
      write_allowed: WRITE_ALLOWED,
      write_note: "FillPump Cfg_*/Cmd_Ack hyväksytty; ei startup-synkkaa. Kirjoitus vain UI:sta confirm: true.",
      err_codes: ERR,
      allowed_writes: Object.keys(ALLOWED),
    });
  });

  app.post("/api/fillpump", async (req, res) => {
    try {
      if (!WRITE_ALLOWED) return res.status(403).json({ error: "FillPump-kirjoitus ei käytössä" });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu (confirm: true)" });
      const v = validate(req.body);
      if (v.error) return res.status(400).json({ error: v.error });
      const ack = await cmd(v.ok);
      if (!ack) return res.status(504).json({ error: "Ei kuittausta bridgeltä (Myko/Cmd/FillPump/ack)" });
      const results = ack.results || {};
      const bad = Object.entries(results).find(([, r]) => !r || r.result === undefined || !String(r.result).startsWith("ok"));
      if (bad) return res.status(502).json({ error: String(bad[1] ?? "tuntematon"), ack });
      res.json({ ok: true, results, by: String(req.body?.by ?? "myko-ui") });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
}
