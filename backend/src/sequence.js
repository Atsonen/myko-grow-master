// Kiertovesisekvenssi – Pumput_DB.Static.Sequence + CircPump_L/R (ks. plc/CIRCPUMP_SEQ.md). 1.11.2026.
// LUKU: opcua-bridge pollaa -> MQTT Sensors/PLC_2/Sequence.
// KIRJOITUS (hyväksytty):
//   - CircPump_L/R.Enable (15:46) Myko/Cmd/CircPump {L_Enable|R_Enable}
//   - Sequence/Enable (17:06) Myko/Cmd/CircPump {Enable} — VAIN käyttäjän Käynnistä/Pysäytä.
// EI startup-/tick-synkkaa settings.enable → PLC (FertDose plc_enable -opetus).
// Asetukset T_* vain myko_settings k='plc_sequence' (ei PLC:hen).
import mqtt from "mqtt";
import { query } from "./db.js";

const TOPIC = "Sensors/PLC_2/Sequence";
const PLC_WRITE_ALLOWED = false; // T_*/HB/muut Sequence-inputit edelleen estetty
const PUMP_ENABLE_WRITE_ALLOWED = true; // hyväksytty 1.11.2026 15:46 CircPump_L/R.Enable
const SEQ_ENABLE_WRITE_ALLOWED = true; // hyväksytty 1.11.2026 17:06 Sequence/Enable Bool
const CMD_TOPIC = "Myko/Cmd/CircPump";
let MQ = null; const PENDING = new Map();
const DEF = { enable: false, t_circ_s: 30, t_settle_s: 600, t_fill_s: 5, plc_write: false, hb_enabled: false };
const LIM = { t_circ_s: [1, 3600], t_settle_s: [1, 86400], t_fill_s: [1, 3600] };
const STEPS = { 0: "Seis", 1: "Kierrätys", 2: "Tasaantuminen", 3: "Pinnan tallennus", 4: "Täyttö" };
const S = { plc: { present: false }, at: 0 };

async function cfg() {
  const [r] = await query("SELECT v FROM myko_settings WHERE k = 'plc_sequence'");
  let c = {}; try { c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {}; } catch { /* default */ }
  // plc_write/hb_enabled aina false – ei synkata Enableä PLC:hen taustalla
  return { ...DEF, ...c, plc_write: false, hb_enabled: false };
}

function cmd(body, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!MQ?.connected) return resolve(null);
    const id = `sq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const to = setTimeout(() => { PENDING.delete(id); resolve(null); }, timeoutMs);
    PENDING.set(id, (j) => { clearTimeout(to); resolve(j); });
    MQ.publish(CMD_TOPIC, JSON.stringify({ id, by: "myko-ui", ...body }), { qos: 1 });
  });
}

export function startSequence({ mqttUrl }) {
  const mq = mqtt.connect(mqttUrl, { clientId: `myko-backend-seq-${process.pid}`, reconnectPeriod: 5000 });
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
  // EI setInterval/tick Enable-synkkaa – Enable kirjoitetaan vain POST /api/sequence/enable
}

export function registerSequenceRoutes(app) {
  app.get("/api/sequence", async (_req, res) => {
    try {
      const c = await cfg();
      const stale = !S.at || Date.now() - S.at > 30_000;
      res.json({
        settings: c, plc: S.plc, plc_at: S.at ? new Date(S.at).toISOString() : null, stale,
        present: !!S.plc?.present && !stale, steps: STEPS,
        write_allowed: PLC_WRITE_ALLOWED,
        pump_write_allowed: PUMP_ENABLE_WRITE_ALLOWED,
        seq_enable_write_allowed: SEQ_ENABLE_WRITE_ALLOWED,
        write_note: "CircPump Enable + Sequence Enable (Käynnistä/Pysäytä) hyväksytty; T_*/HB vain Mykoon. Ei Enable-synkkaa käynnistyksessä.",
        write_nodes_pending: [],
      });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });

  app.post("/api/sequence/pump", async (req, res) => {
    const side = req.body?.side, en = req.body?.enable;
    if (!PUMP_ENABLE_WRITE_ALLOWED) return res.status(403).json({ error: "Pumppukirjoitus ei käytössä" });
    if (!["L", "R"].includes(side) || typeof en !== "boolean") return res.status(400).json({ error: "side L|R, enable bool" });
    const ack = await cmd({ [`${side}_Enable`]: en });
    if (!ack) return res.status(504).json({ error: "Ei kuittausta bridgeltä (Myko/Cmd/CircPump/ack)" });
    const key = `${side}_Enable`;
    const r = ack.results?.[key];
    if (r?.result !== "ok") return res.status(502).json({ error: String(r ?? "tuntematon"), ack });
    res.json({ ok: true, key, value: en, read: r.read });
  });

  // Käynnistä/Pysäytä → Sequence/Enable. Vain tämä endpoint kirjoittaa Enable; ei taustasynkkaa.
  app.post("/api/sequence/enable", async (req, res) => {
    try {
      if (!SEQ_ENABLE_WRITE_ALLOWED) return res.status(403).json({ error: "Sequence Enable -kirjoitus ei käytössä" });
      const en = req.body?.enable;
      if (typeof en !== "boolean") return res.status(400).json({ error: "enable bool" });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu (confirm: true)" });
      const ack = await cmd({ Enable: en });
      if (!ack) return res.status(504).json({ error: "Ei kuittausta bridgeltä (Myko/Cmd/CircPump/ack)" });
      const r = ack.results?.Enable;
      if (r?.result !== "ok") return res.status(502).json({ error: String(r ?? "tuntematon"), ack });
      res.json({
        ok: true, enable: en, read: r.read,
        by: String(req.body?.by ?? "myko-ui"),
        note: "kirjoitettu Sequence/Enable – ei settings-synkkaa",
      });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });

  app.put("/api/sequence", async (req, res) => {
    try {
      const b = req.body ?? {}; const c = await cfg(); const next = { ...c };
      for (const [k, [lo, hi]] of Object.entries(LIM)) if (b[k] !== undefined) {
        const n = Number(b[k]); if (!Number.isFinite(n) || n < lo || n > hi) return res.status(400).json({ error: `${k}: ${lo}–${hi} s` });
        next[k] = Math.round(n);
      }
      // settings.enable vain Myko-muistiin – EI kirjoiteta PLC:hen tästä
      if (b.enable !== undefined) next.enable = !!b.enable;
      next.plc_write = false; next.hb_enabled = false;
      await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('plc_sequence', ?, 'ui') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [JSON.stringify(next)]);
      res.json({ settings: next, written_to_plc: false });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
}
