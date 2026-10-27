// Lannoiteannostelu – Valvomon päätöslogiikka (PLC: FB_FertDose / FertDose_DB, ks. plc/FERTDOSE.md).
// TURVA: oletuksena DRY-RUN. Tämä moduuli EI kirjoita OPC UA:han / PLC:lle mitään:
//   - live=true ei vielä tee kirjoitusta (writer puuttuu tarkoituksella) -> lokiin "live-blocked".
//   - heartbeat-kirjoitin ei ole toteutettu kirjoittamaan; hb_enabled näkyy vain tilana.
// Asetukset: myko_settings k='fert_dose'. Loki: fert_dose_log.
// Lannoite A/B = sama pumppu, letku siirretään käsin: fert on vain Myko-asetus, kirjataan jokaiselle annokselle; kumulatiivinen per lannoite lasketaan lokista.
import { query } from "./db.js";

const DEF = {
  live: false, hb_enabled: false, fert: "A", dose_s: 1,       // 1 s = 1 ml, PLC leikkaa max 5 s
  ec_key: "dl23", sp_source: "plc", sp_manual: 4800,          // TDS_SP Pumput_DB:stä tai käsin
  below_min: 10, pause_min: 20, stale_s: 120, min_uptime_min: 10,
  range: [100, 9000], spike_ppm: 400, n_samples: 6, poll_s: 10,
};
const S = { samples: [], validSince: null, belowSince: null, lastDoseAt: null, last: null, reason: "init", sp: null };

async function cfg() {
  const [r] = await query("SELECT v FROM myko_settings WHERE k = 'fert_dose'");
  let c = {}; try { c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {}; } catch { /* default */ }
  return { ...DEF, ...c };
}
async function ensureTable() {
  await query(`CREATE TABLE IF NOT EXISTS fert_dose_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ts DATETIME NOT NULL, fert CHAR(1) NOT NULL,
    requested_ms INT NOT NULL, actual_ms INT NULL, ec_before DECIMAL(8,1) NULL, ec_sp DECIMAL(8,1) NULL,
    reason VARCHAR(200) NULL, mode VARCHAR(16) NOT NULL, INDEX idx_fert_dose_ts (ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const [last] = await query("SELECT TIMESTAMPDIFF(SECOND, ts, UTC_TIMESTAMP()) age_s FROM fert_dose_log ORDER BY id DESC LIMIT 1");
  if (last) S.lastDoseAt = Date.now() - Number(last.age_s) * 1000;
}

// Luotettavuus: tuore, sallitulla alueella, ei piikkejä N viime näytteessä, yhtäjaksoisesti validi > min_uptime
function reliability(c, now) {
  const s = S.samples; const lastS = s[s.length - 1];
  if (!lastS) return [false, "ei näytteitä"];
  if (now - lastS.t > c.stale_s * 1000) return [false, `vanha arvo (${Math.round((now - lastS.t) / 1000)} s)`];
  if (lastS.v < c.range[0] || lastS.v > c.range[1]) return [false, `arvo ${lastS.v} alueen ${c.range[0]}–${c.range[1]} ulkopuolella`];
  const win = s.slice(-c.n_samples);
  if (win.length < c.n_samples) return [false, `liian vähän näytteitä (${win.length}/${c.n_samples})`];
  const span = Math.max(...win.map((x) => x.v)) - Math.min(...win.map((x) => x.v));
  if (span > c.spike_ppm) return [false, `epävakaa: vaihtelu ${span} ppm > ${c.spike_ppm}`];
  if (!S.validSince || now - S.validSince < c.min_uptime_min * 60_000) return [false, `anturi validi vasta ${S.validSince ? Math.round((now - S.validSince) / 60000) : 0}/${c.min_uptime_min} min`];
  return [true, "ok"];
}

async function tick(port) {
  const c = await cfg(); const now = Date.now();
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(8000) })).json();
  try {
    const [row] = await get(`/api/datalogger/latest?keys=${c.ec_key}`);
    if (row && row.value != null) {
      const t = Date.parse(row.timestamp); const v = Number(row.value);
      if (!S.samples.length || S.samples[S.samples.length - 1].t !== t) { S.samples.push({ t, v }); S.samples = S.samples.slice(-120); }
    }
    let sp = Number(c.sp_manual);
    if (c.sp_source === "plc") { const pu = await get("/api/pumput"); sp = pu?.stale ? NaN : Number(pu?.values?.TDS_SP); }
    S.sp = Number.isFinite(sp) ? sp : null;
    const lastS = S.samples[S.samples.length - 1];
    const basicOk = lastS && now - lastS.t <= c.stale_s * 1000 && lastS.v >= c.range[0] && lastS.v <= c.range[1];
    if (!basicOk) S.validSince = null; else if (!S.validSince) S.validSince = now;
    const [ok, why] = reliability(c, now);
    if (!ok || S.sp == null) { S.belowSince = null; S.reason = S.sp == null ? "TDS_SP ei saatavilla" : `epäluotettava: ${why}`; return; }
    if (lastS.v >= S.sp) { S.belowSince = null; S.reason = `EC ${lastS.v} ≥ SP ${S.sp}`; return; }
    if (!S.belowSince) S.belowSince = now;
    const belowMin = (now - S.belowSince) / 60000; const sinceDose = S.lastDoseAt ? (now - S.lastDoseAt) / 60000 : Infinity;
    if (belowMin < c.below_min) { S.reason = `EC alle SP ${belowMin.toFixed(1)}/${c.below_min} min`; return; }
    if (sinceDose < c.pause_min) { S.reason = `tauko ${sinceDose.toFixed(1)}/${c.pause_min} min`; return; }
    const ms = Math.round(Math.min(Math.max(Number(c.dose_s) || 0, 0), 5) * 1000); const fert = c.fert === "B" ? "B" : "A";
    if (ms <= 0) { S.reason = "annoskoko 0"; return; }
    const mode = c.live ? "live-blocked" : "dry-run";
    const reason = `${c.live ? "LIVE pyydetty, mutta kirjoitin ei käytössä (odottaa hyväksyntää)" : "WOULD DOSE"}: EC ${lastS.v} < SP ${S.sp} ${belowMin.toFixed(1)} min, tauko ${Number.isFinite(sinceDose) ? sinceDose.toFixed(1) : "–"} min`;
    await query("INSERT INTO fert_dose_log (ts, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode) VALUES (UTC_TIMESTAMP(), ?, ?, NULL, ?, ?, ?, ?)", [fert, ms, lastS.v, S.sp, reason, mode]);
    console.log(`[fertdose] ${mode} ${fert} ${ms} ms – ${reason}`);
    S.lastDoseAt = now; S.belowSince = null; S.last = { at: new Date(now).toISOString(), fert, ms, mode, ec: lastS.v, sp: S.sp }; S.reason = reason;
  } catch (e) { S.reason = `virhe: ${e.message}`; }
}

export function startFertDose({ port }) {
  ensureTable().catch((e) => console.warn("[fertdose] table", e.message)).finally(async () => {
    const c = await cfg().catch(() => DEF);
    console.log(`[fertdose] käynnissä, mode=${c.live ? "live(blocked)" : "dry-run"}, heartbeat=${c.hb_enabled ? "pyydetty (ei toteutettu)" : "pois"}`);
    const loop = async () => { await tick(port); setTimeout(loop, (Number(c.poll_s) || 10) * 1000); };
    loop();
  });
}

export function registerFertDoseRoutes(app) {
  app.get("/api/fertdose", async (_req, res) => {
    try {
      const c = await cfg();
      const cum = await query("SELECT fert, mode, COUNT(*) n, SUM(requested_ms) req_ms, SUM(COALESCE(actual_ms,0)) act_ms FROM fert_dose_log GROUP BY fert, mode");
      const recent = await query("SELECT DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%sZ') ts, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode FROM fert_dose_log ORDER BY id DESC LIMIT 10");
      const lastS = S.samples[S.samples.length - 1];
      res.json({ config: c, mode: c.live ? "live-blocked" : "dry-run", heartbeat: c.hb_enabled ? "requested-not-implemented" : "off",
        ec: lastS ? { value: lastS.v, at: new Date(lastS.t).toISOString() } : null, sp: S.sp,
        belowSince: S.belowSince ? new Date(S.belowSince).toISOString() : null, lastDoseAt: S.lastDoseAt ? new Date(S.lastDoseAt).toISOString() : null,
        reason: S.reason, cumulative: cum.map((r) => ({ ...r, n: Number(r.n), req_ms: Number(r.req_ms), act_ms: Number(r.act_ms) })), recent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Asetukset: vain Myko-asetus. live/hb_enabled hyväksytään tallentaa, mutta kirjoitin on tässä versiossa estetty.
  app.put("/api/fertdose/settings", async (req, res) => {
    try {
      const b = req.body ?? {}; const cur = await cfg(); const next = { ...cur };
      if (b.fert !== undefined) { if (!["A", "B"].includes(b.fert)) return res.status(400).json({ error: "fert A/B" }); next.fert = b.fert; }
      if (b.dose_s !== undefined) { const d = Number(b.dose_s); if (!(d > 0 && d <= 5)) return res.status(400).json({ error: "annos 0–5 s" }); next.dose_s = d; }
      for (const [k, lo, hi] of [["below_min", 1, 120], ["pause_min", 5, 240], ["spike_ppm", 10, 5000], ["min_uptime_min", 0, 120], ["stale_s", 20, 900], ["sp_manual", 100, 9000]]) {
        if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `${k} ${lo}–${hi}` }); next[k] = v; }
      }
      if (b.sp_source !== undefined) { if (!["plc", "manual"].includes(b.sp_source)) return res.status(400).json({ error: "sp_source plc/manual" }); next.sp_source = b.sp_source; }
      await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('fert_dose', ?, 'ui') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [JSON.stringify(next)]);
      res.json({ config: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
