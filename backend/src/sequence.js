// Kiertovesisekvenssi – Pumput_DB.Static.Sequence + CircPump_L/R (ks. plc/CIRCPUMP_SEQ.md). 1.11.2026.
// LUKU: opcua-bridge pollaa -> MQTT Sensors/PLC_2/Sequence.
// KIRJOITUS: EI KÄYTÖSSÄ (CircPump Enable whitelist tyhjä bridgessä). Asetukset vain myko_settings k='plc_sequence'.
import mqtt from "mqtt";
import { query } from "./db.js";

const TOPIC = "Sensors/PLC_2/Sequence";
const PLC_WRITE_ALLOWED = false; // kovakoodattu esto – muutos vaatii koodimuutoksen ja hyväksynnän
// Poikkeus (käyttäjän hyväksymä 27.10.2026): VAIN kiertopumppujen Enable (FB_CircPump_Left/Right.Enable, Bool)
// -> Myko/Cmd/CircPump {L_Enable|R_Enable: bool}. Bridge whitelistaa samat kaksi solmua.
const PUMP_ENABLE_WRITE_ALLOWED = true; // hyväksytty 1.11.2026 15:46 CircPump_L/R.Enable
const CMD_TOPIC = "Myko/Cmd/CircPump";
let MQ = null; const PENDING = new Map();
const DEF = { enable: false, t_circ_s: 30, t_settle_s: 600, t_fill_s: 5, plc_write: false, hb_enabled: false };
const LIM = { t_circ_s: [1, 3600], t_settle_s: [1, 86400], t_fill_s: [1, 3600] };
const STEPS = { 0: "Seis", 1: "Kierrätys", 2: "Tasaantuminen", 3: "Pinnan tallennus", 4: "Täyttö" };
const S = { plc: { present: false }, at: 0 };

async function cfg() {
  const [r] = await query("SELECT v FROM myko_settings WHERE k = 'plc_sequence'");
  let c = {}; try { c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {}; } catch { /* default */ }
  return { ...DEF, ...c, plc_write: false, hb_enabled: false };
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
}

export function registerSequenceRoutes(app) {
  app.get("/api/sequence", async (_req, res) => {
    try {
      const c = await cfg();
      const stale = !S.at || Date.now() - S.at > 30_000;
      res.json({ settings: c, plc: S.plc, plc_at: S.at ? new Date(S.at).toISOString() : null, stale,
        present: !!S.plc?.present && !stale, steps: STEPS, write_allowed: PLC_WRITE_ALLOWED, pump_write_allowed: PUMP_ENABLE_WRITE_ALLOWED,
        write_note: "CircPump Enable hyväksytty; Sequence-asetukset (T_*/Enable/HB) edelleen vain Mykoon", write_nodes_pending: [] });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
  app.post("/api/sequence/pump", async (req, res) => {
    const side = req.body?.side, en = req.body?.enable;
    if (!PUMP_ENABLE_WRITE_ALLOWED) return res.status(403).json({ error: "Pumppukirjoitus ei käytössä" });
    if (!["L", "R"].includes(side) || typeof en !== "boolean") return res.status(400).json({ error: "side L|R, enable bool" });
    if (!MQ?.connected) return res.status(503).json({ error: "MQTT ei yhteydessä" });
    const id = `cp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; const key = `${side}_Enable`;
    const ack = await new Promise((ok) => {
      const to = setTimeout(() => { PENDING.delete(id); ok(null); }, 5000);
      PENDING.set(id, (j) => { clearTimeout(to); ok(j); });
      MQ.publish(CMD_TOPIC, JSON.stringify({ id, by: "myko-ui", [key]: en }), { qos: 1 });
    });
    if (!ack) return res.status(504).json({ error: "Ei kuittausta bridgeltä (Myko/Cmd/CircPump/ack)" });
    const r = ack.results?.[key];
    if (r?.result !== "ok") return res.status(502).json({ error: String(r ?? "tuntematon"), ack });
    res.json({ ok: true, key, value: en, read: r.read });
  });
  app.put("/api/sequence", async (req, res) => {
    try {
      const b = req.body ?? {}; const c = await cfg(); const next = { ...c };
      for (const [k, [lo, hi]] of Object.entries(LIM)) if (b[k] !== undefined) {
        const n = Number(b[k]); if (!Number.isFinite(n) || n < lo || n > hi) return res.status(400).json({ error: `${k}: ${lo}–${hi} s` });
        next[k] = Math.round(n);
      }
      if (b.enable !== undefined) next.enable = !!b.enable;
      next.plc_write = false; next.hb_enabled = false; // ei hyväksytty
      await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('plc_sequence', ?, 'ui') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [JSON.stringify(next)]);
      res.json({ settings: next, written_to_plc: false });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
  });
}
