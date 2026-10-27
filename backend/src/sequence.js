// Kiertovesisekvenssi – FB_Sequence / FB_Sequence_DB (ks. plc/CIRCPUMP_SEQ.md). 27.10.2026.
// LUKU: opcua-bridge pollaa (Read-palvelu, ei subscriptioneita) -> MQTT Sensors/PLC_2/Sequence.
// KIRJOITUS: EI KÄYTÖSSÄ. Asetukset (T_Circ, T_Settle, T_Fill, Enable) tallennetaan vain myko_settings k='plc_sequence'.
// Feature flagit plc_write ja hb_enabled ovat aina false: niitä ei voi kytkeä UI:sta/API:sta päälle ennen
// käyttäjän hyväksyntää + DB:n latausta. Tuleva polku: Myko/Cmd/Sequence -> suoraan FB_Sequence_DB.Input
// (whitelist kuten FertDose), heartbeat kuten fertDose.js (5 s, vain kun live && hb_enabled && present).
import mqtt from "mqtt";
import { query } from "./db.js";

const TOPIC = "Sensors/PLC_2/Sequence";
const PLC_WRITE_ALLOWED = false; // kovakoodattu esto – muutos vaatii koodimuutoksen ja hyväksynnän
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
  mq.on("connect", () => mq.subscribe(TOPIC));
  mq.on("message", (_t, buf) => { try { S.plc = JSON.parse(buf.toString()); S.at = Date.now(); } catch { /* ignore */ } });
  mq.on("error", () => undefined);
}

export function registerSequenceRoutes(app) {
  app.get("/api/sequence", async (_req, res) => {
    try {
      const c = await cfg();
      const stale = !S.at || Date.now() - S.at > 30_000;
      res.json({ settings: c, plc: S.plc, plc_at: S.at ? new Date(S.at).toISOString() : null, stale,
        present: !!S.plc?.present && !stale, steps: STEPS, write_allowed: PLC_WRITE_ALLOWED,
        write_note: "Kirjoitus PLC:hen ei käytössä – odottaa latausta/hyväksyntää" });
    } catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
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
