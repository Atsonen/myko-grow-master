// Lannoiteannostelu – Valvomon päätöslogiikka + ohjaus (PLC: FB_FertDose / FertDose_DB, ks. plc/FERTDOSE.md).
// Käyttäjä hyväksyi live-ohjauksen 27.10.2026 11:20 (fyysinen lähtö forsattu 0 PLC:ssä testivaiheessa).
// Kirjoitukset vain bridgen kautta: MQTT Myko/Cmd/FertDose (whitelist Enable, DoseReq_ms, DoseTrig pulse, Heartbeat).
// Asetukset: myko_settings k='fert_dose'. Loki: fert_dose_log. Hälytykset/varoitukset: fert_events.
// Lannoite A/B = sama pumppu, letku siirretään käsin: fert on vain Myko-asetus, kirjataan jokaiselle annokselle.
// EC-hälytys/-varoitus = ± poikkeama TDS_SP:stä. HÄLYTYS -> Telegram (Valvomo-botti, alku + palautuminen) + LUKITUS
// (ei annospyyntöjä, Enable=false PLC:lle). VAROITUS -> vain UI/hälytyslista.
import mqtt from "mqtt";
import { query } from "./db.js";
import { tg, allowedChats } from "./telegram.js";

const DEF = {
  live: true, hb_enabled: true, plc_enable: false, auto: true, fert: "A", dose_s: 1,
  ec_key: "dl23", sp_source: "plc", sp_manual: 4800,
  below_min: 10, pause_min: 20, stale_s: 120, min_uptime_min: 10,
  range: [100, 9000], spike_ppm: 400, n_samples: 6, poll_s: 10,
  ec_alarm: { enabled: true, lo_off: -1500, hi_off: 1500, warn_lo_off: -700, warn_hi_off: 700, hyst: 100, delay_min: 5 },
};
const STATUS_TXT = { 0: "valmis", 1: "annostelee", 2: "annos valmis", 3: "annos valmis (rajattu 5 s)", 10: "hylätty: Enable pois", 11: "heartbeat puuttuu", 13: "hylätty: virheellinen pyyntö", 14: "katkaistu: Enable pudotettu", 15: "katkaistu: turvakatkaisu" };
const S = { samples: [], validSince: null, belowSince: null, lastDoseAt: null, reason: "init", sp: null,
  plc: { present: false }, plcAt: 0, hb: 0, hbErr: null, lastAck: null, pending: new Map(),
  ev: {}, evSince: {}, lastDoseCount: null };
let mq = null; let CFG = DEF;

async function cfg() {
  const [r] = await query("SELECT v FROM myko_settings WHERE k = 'fert_dose'");
  let c = {}; try { c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {}; } catch { /* default */ }
  CFG = { ...DEF, ...c, ec_alarm: { ...DEF.ec_alarm, ...(c.ec_alarm ?? {}) } }; return CFG;
}
async function saveCfg(next) {
  await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('fert_dose', ?, 'ui') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [JSON.stringify(next)]);
  CFG = next;
}
async function ensureTables() {
  await query(`CREATE TABLE IF NOT EXISTS fert_dose_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ts DATETIME NOT NULL, fert CHAR(1) NOT NULL,
    requested_ms INT NOT NULL, actual_ms INT NULL, ec_before DECIMAL(8,1) NULL, ec_sp DECIMAL(8,1) NULL,
    reason VARCHAR(200) NULL, mode VARCHAR(16) NOT NULL, INDEX idx_fert_dose_ts (ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await query(`CREATE TABLE IF NOT EXISTS fert_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ts DATETIME NOT NULL, cleared_ts DATETIME NULL,
    level VARCHAR(8) NOT NULL, code VARCHAR(32) NOT NULL, text VARCHAR(250) NOT NULL, INDEX idx_fert_events_ts (ts)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await query("UPDATE fert_events SET cleared_ts = UTC_TIMESTAMP() WHERE cleared_ts IS NULL"); // tila rakennetaan uudelleen käynnistyksessä
  const [last] = await query("SELECT TIMESTAMPDIFF(SECOND, ts, UTC_TIMESTAMP()) age_s FROM fert_dose_log WHERE mode IN ('live','dry-run') AND requested_ms > 0 ORDER BY id DESC LIMIT 1");
  if (last) S.lastDoseAt = Date.now() - Number(last.age_s) * 1000;
}
const logRow = (fert, ms, ec, sp, reason, mode) => query("INSERT INTO fert_dose_log (ts, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode) VALUES (UTC_TIMESTAMP(), ?, ?, NULL, ?, ?, ?, ?)", [fert, ms, ec ?? null, sp ?? null, String(reason).slice(0, 200), mode]);
async function notify(text) { try { for (const chat_id of await allowedChats()) await tg("sendMessage", { chat_id, text }); } catch (e) { console.warn("[fertdose] telegram", e.message); } }

// ---------- MQTT / bridge ----------
function cmd(body, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!mq?.connected) return resolve({ error: "MQTT ei yhteyttä" });
    const id = `fd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const t = setTimeout(() => { S.pending.delete(id); resolve({ error: "bridge ei kuitannut (timeout)" }); }, timeoutMs);
    S.pending.set(id, (a) => { clearTimeout(t); resolve(a); });
    mq.publish("Myko/Cmd/FertDose", JSON.stringify({ id, by: "myko-fertdose", ...body }), { qos: 1 });
  });
}
const okRes = (a, k) => a?.results?.[k] && typeof a.results[k] === "object" && String(a.results[k].result).startsWith("ok");
const errTxt = (a) => a?.error ?? Object.entries(a?.results ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}: ${v}`).join(", ");
const plcFresh = () => S.plc.present && Date.now() - S.plcAt < 15_000;

// ---------- Hälytykset / varoitukset ----------
function alarmActive() { return Object.entries(S.ev).some(([k, e]) => e.level === "alarm" && e.active && k.startsWith("ec_")); }
async function setEvent(code, level, active, text, c) {
  const e = S.ev[code];
  if (active) {
    S.evSince[code] ??= Date.now();
    if (e?.active) { e.text = text; return; }
    const delay = level === "alarm" ? (Number(c.ec_alarm.delay_min) || 0) * 60_000 : 0;
    if (Date.now() - S.evSince[code] < delay) return;
    const r = await query("INSERT INTO fert_events (ts, level, code, text) VALUES (UTC_TIMESTAMP(), ?, ?, ?)", [level, code, text.slice(0, 250)]);
    S.ev[code] = { level, active: true, text, since: new Date().toISOString(), id: Number(r.insertId) };
    console.log(`[fertdose] ${level.toUpperCase()} ${code}: ${text}`);
    if (level === "alarm") await notify(`🚨 ${text} – annostelu LUKITTU (ilmoitetaan kerran, palautumisesta erikseen)`);
  } else {
    delete S.evSince[code];
    if (!e?.active) return;
    e.active = false; await query("UPDATE fert_events SET cleared_ts = UTC_TIMESTAMP() WHERE id = ?", [e.id]);
    console.log(`[fertdose] clear ${code}`);
    if (level === "alarm") await notify(`✅ Palautui: ${e.text} – annostelulukitus poistui`);
    delete S.ev[code];
  }
}
async function evalAlarms(c, ec, sp, reliable) {
  const A = c.ec_alarm;
  const on = A.enabled && reliable && ec != null && sp != null;
  const h = (code) => (S.ev[code]?.active ? Number(A.hyst) || 0 : 0);
  const lim = { alo: sp + A.lo_off, ahi: sp + A.hi_off, wlo: sp + A.warn_lo_off, whi: sp + A.warn_hi_off };
  const t = (lvl, side, l) => `Lannoite EC ${ec} ppm ${side === "lo" ? "alle" : "yli"} ${lvl}rajan ${l} (SP ${sp} ${side === "lo" ? A[lvl === "hälytys" ? "lo_off" : "warn_lo_off"] : "+" + A[lvl === "hälytys" ? "hi_off" : "warn_hi_off"]})`;
  await setEvent("ec_alarm_lo", "alarm", on && ec < lim.alo + h("ec_alarm_lo"), t("hälytys", "lo", lim.alo), c);
  await setEvent("ec_alarm_hi", "alarm", on && ec > lim.ahi - h("ec_alarm_hi"), t("hälytys", "hi", lim.ahi), c);
  await setEvent("ec_warn_lo", "warning", on && ec < lim.wlo + h("ec_warn_lo") && !(ec < lim.alo), t("varoitus", "lo", lim.wlo), c);
  await setEvent("ec_warn_hi", "warning", on && ec > lim.whi - h("ec_warn_hi") && !(ec > lim.ahi), t("varoitus", "hi", lim.whi), c);
  // järjestelmävaroitukset (vain UI)
  await setEvent("plc_db", "warning", c.live && !S.plc.present, "FertDose_DB puuttuu OPC UA:sta (ei ladattu PLC:lle?) – ohjaus ei käytössä", c);
  await setEvent("plc_hb", "warning", c.live && c.hb_enabled && plcFresh() && S.plc.HB_OK === false, "PLC: heartbeat ei kunnossa (HB_OK = FALSE)", c);
  await setEvent("ec_unrel", "warning", !reliable, `EC-mittaus epäluotettava: ${S.relWhy ?? ""}`, c);
}

// ---------- Luotettavuus ----------
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

// ---------- Annos ----------
async function dose(c, why, by) {
  const lastS = S.samples[S.samples.length - 1]; const ec = lastS?.v ?? null;
  const ms = Math.round(Math.min(Math.max(Number(c.dose_s) || 0, 0), 5) * 1000); const fert = c.fert === "B" ? "B" : "A";
  if (ms <= 0) return { ok: false, error: "annoskoko 0" };
  if (alarmActive()) { await logRow(fert, 0, ec, S.sp, `ESTETTY (EC-hälytys): ${why}`, "blocked"); return { ok: false, error: "EC-hälytys aktiivinen – annostelu lukittu" }; }
  if (!c.live) { await logRow(fert, ms, ec, S.sp, `WOULD DOSE: ${why}`, "dry-run"); S.lastDoseAt = Date.now(); return { ok: true, mode: "dry-run" }; }
  const pre = !S.plc.present ? "FertDose_DB puuttuu" : !plcFresh() ? "PLC-tila vanha" : S.plc.HB_OK !== true ? "PLC HB_OK = FALSE" : S.plc.Enable !== true ? "PLC Enable = FALSE" : S.plc.DoseActive ? "annos jo käynnissä" : null;
  if (pre) { await logRow(fert, ms, ec, S.sp, `EI LÄHETETTY (${pre}): ${why}`, "live-fail"); return { ok: false, error: pre }; }
  const a = await cmd({ DoseReq_ms: ms, DoseTrig: "pulse" });
  const ok = okRes(a, "DoseReq_ms") && okRes(a, "DoseTrig");
  await logRow(fert, ms, ec, S.sp, `${ok ? "LÄHETETTY" : "KIRJOITUS EPÄONNISTUI: " + errTxt(a)} (${by}): ${why}`, ok ? "live" : "live-fail");
  if (ok) S.lastDoseAt = Date.now();
  console.log(`[fertdose] dose ${fert} ${ms} ms by=${by} -> ${ok ? "ok" : errTxt(a)}`);
  return ok ? { ok: true, mode: "live" } : { ok: false, error: errTxt(a) };
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
    const [ok, why] = reliability(c, now); S.relWhy = why;
    await evalAlarms(c, lastS?.v ?? null, S.sp, ok);

    // Enable-synkronointi (lukitus pakottaa FALSE)
    if (c.live && plcFresh()) {
      const want = !!c.plc_enable && !alarmActive();
      if (S.plc.Enable !== want && !S.enablePending) {
        S.enablePending = true; const a = await cmd({ Enable: want }); S.enablePending = false;
        await logRow(c.fert, 0, lastS?.v, S.sp, `Enable=${want}${alarmActive() ? " (EC-hälytyslukitus)" : ""} -> ${okRes(a, "Enable") ? "ok" : errTxt(a)}`, "live");
      }
    }
    // PLC:n toteutunut annos -> loki
    if (plcFresh() && Number.isFinite(S.plc.DoseCount)) {
      if (S.lastDoseCount != null && S.plc.DoseCount > S.lastDoseCount)
        await query("UPDATE fert_dose_log SET actual_ms = ? WHERE mode = 'live' AND requested_ms > 0 AND actual_ms IS NULL ORDER BY id DESC LIMIT 1", [S.plc.LastDose_ms ?? null]);
      S.lastDoseCount = S.plc.DoseCount;
    }

    if (!ok || S.sp == null) { S.belowSince = null; S.reason = S.sp == null ? "TDS_SP ei saatavilla" : `epäluotettava: ${why}`; return; }
    if (alarmActive()) { S.belowSince = null; S.reason = "EC-hälytys – annostelu lukittu"; return; }
    if (lastS.v >= S.sp) { S.belowSince = null; S.reason = `EC ${lastS.v} ≥ SP ${S.sp}`; return; }
    if (!S.belowSince) S.belowSince = now;
    const belowMin = (now - S.belowSince) / 60000; const sinceDose = S.lastDoseAt ? (now - S.lastDoseAt) / 60000 : Infinity;
    if (belowMin < c.below_min) { S.reason = `EC alle SP ${belowMin.toFixed(1)}/${c.below_min} min`; return; }
    if (sinceDose < c.pause_min) { S.reason = `tauko ${sinceDose.toFixed(1)}/${c.pause_min} min`; return; }
    if (!c.auto) { S.reason = "annos olisi ajankohtainen – automaatti pois"; return; }
    const r = await dose(c, `EC ${lastS.v} < SP ${S.sp} ${belowMin.toFixed(1)} min`, "auto");
    S.reason = r.ok ? `annos lähetetty (${r.mode})` : `annos ei onnistunut: ${r.error}`;
    if (r.ok) S.belowSince = null;
  } catch (e) { S.reason = `virhe: ${e.message}`; }
}

export function fertDoseActive() { return Object.values(S.ev).filter((e) => e.active && e.level === "alarm").map((e) => e.text); }

export function startFertDose({ port, mqttUrl }) {
  mq = mqtt.connect(mqttUrl, { clientId: `myko-backend-fertdose-${process.pid}`, reconnectPeriod: 5000 });
  mq.on("connect", () => mq.subscribe(["Sensors/PLC_2/FertDose", "Myko/Cmd/FertDose/ack"], { qos: 1 }));
  mq.on("error", (e) => console.error("[fertdose mqtt]", e.message));
  mq.on("message", (topic, buf) => {
    let d; try { d = JSON.parse(buf.toString()); } catch { return; }
    if (topic === "Sensors/PLC_2/FertDose") { S.plc = d; S.plcAt = Date.now(); }
    else { S.lastAck = d; const f = S.pending.get(d.id); if (f) { S.pending.delete(d.id); f(d); } }
  });
  // Heartbeat 5 s välein (vain kun live + hb_enabled + DB olemassa)
  setInterval(async () => {
    if (!CFG.live || !CFG.hb_enabled || !S.plc.present) return;
    S.hb = (S.hb + 1) % 65536; const a = await cmd({ Heartbeat: S.hb }, 4000);
    S.hbErr = okRes(a, "Heartbeat") ? null : errTxt(a); if (!S.hbErr) S.hbAt = Date.now();
  }, 5000);
  ensureTables().catch((e) => console.warn("[fertdose] table", e.message)).finally(async () => {
    const c = await cfg().catch(() => DEF);
    console.log(`[fertdose] käynnissä, mode=${c.live ? "LIVE" : "dry-run"}, heartbeat=${c.hb_enabled ? "päällä" : "pois"}`);
    const loop = async () => { await tick(port); setTimeout(loop, (Number(CFG.poll_s) || 10) * 1000); };
    loop();
  });
}

export function registerFertDoseRoutes(app) {
  app.get("/api/fertdose", async (_req, res) => {
    try {
      const c = await cfg();
      const cum = await query("SELECT fert, mode, COUNT(*) n, SUM(requested_ms) req_ms, SUM(COALESCE(actual_ms,0)) act_ms FROM fert_dose_log WHERE requested_ms > 0 GROUP BY fert, mode");
      const recent = await query("SELECT DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%sZ') ts, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode FROM fert_dose_log ORDER BY id DESC LIMIT 10");
      const events = await query("SELECT id, DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%sZ') ts, DATE_FORMAT(cleared_ts, '%Y-%m-%dT%H:%i:%sZ') cleared_ts, level, code, text FROM fert_events ORDER BY id DESC LIMIT 30");
      const lastS = S.samples[S.samples.length - 1];
      res.json({ config: c, mode: c.live ? "live" : "dry-run", heartbeat: !c.hb_enabled ? "off" : !S.plc.present ? "odottaa DB:tä" : S.hbErr ? `virhe: ${S.hbErr}` : "ok",
        hbValue: S.hb, plc: { ...S.plc, fresh: plcFresh(), statusText: STATUS_TXT[S.plc.Status] ?? (S.plc.Status != null ? `koodi ${S.plc.Status}` : null) },
        interlock: alarmActive(), ec: lastS ? { value: lastS.v, at: new Date(lastS.t).toISOString() } : null, sp: S.sp,
        belowSince: S.belowSince ? new Date(S.belowSince).toISOString() : null, lastDoseAt: S.lastDoseAt ? new Date(S.lastDoseAt).toISOString() : null,
        nextAllowedAt: S.lastDoseAt ? new Date(S.lastDoseAt + c.pause_min * 60_000).toISOString() : null,
        reason: S.reason, active: Object.entries(S.ev).filter(([, e]) => e.active).map(([code, e]) => ({ code, ...e })), events: events.map((e) => ({ ...e, id: Number(e.id) })),
        cumulative: cum.map((r) => ({ ...r, n: Number(r.n), req_ms: Number(r.req_ms), act_ms: Number(r.act_ms) })), recent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Käsiannos: vaatii confirm=true (UI-vahvistus), noudattaa taukoa, max 5 s ja EC-hälytyslukitusta.
  app.post("/api/fertdose/dose", async (req, res) => {
    try {
      const c = await cfg();
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu" });
      const since = S.lastDoseAt ? (Date.now() - S.lastDoseAt) / 60000 : Infinity;
      if (since < c.pause_min) return res.status(409).json({ error: `tauko kesken (${since.toFixed(1)}/${c.pause_min} min)` });
      const r = await dose(c, "käsiannos (Annostele nyt)", "manual");
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put("/api/fertdose/settings", async (req, res) => {
    try {
      const b = req.body ?? {}; const cur = await cfg(); const next = { ...cur, ec_alarm: { ...cur.ec_alarm } };
      if (b.fert !== undefined) { if (!["A", "B"].includes(b.fert)) return res.status(400).json({ error: "fert A/B" }); next.fert = b.fert; }
      if (b.dose_s !== undefined) { const d = Number(b.dose_s); if (!(d > 0 && d <= 5)) return res.status(400).json({ error: "annos 0–5 s" }); next.dose_s = d; }
      for (const k of ["live", "hb_enabled", "plc_enable", "auto"]) if (b[k] !== undefined) { if (typeof b[k] !== "boolean") return res.status(400).json({ error: `${k} bool` }); next[k] = b[k]; }
      for (const [k, lo, hi] of [["below_min", 1, 120], ["pause_min", 5, 240], ["spike_ppm", 10, 5000], ["min_uptime_min", 0, 120], ["stale_s", 20, 900], ["sp_manual", 100, 9000]]) {
        if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `${k} ${lo}–${hi}` }); next[k] = v; }
      }
      if (b.sp_source !== undefined) { if (!["plc", "manual"].includes(b.sp_source)) return res.status(400).json({ error: "sp_source plc/manual" }); next.sp_source = b.sp_source; }
      if (b.ec_alarm && typeof b.ec_alarm === "object") {
        const A = { ...next.ec_alarm };
        if (b.ec_alarm.enabled !== undefined) A.enabled = !!b.ec_alarm.enabled;
        for (const k of ["lo_off", "warn_lo_off"]) if (b.ec_alarm[k] !== undefined) { const v = Number(b.ec_alarm[k]); if (!(v <= 0 && v >= -5000)) return res.status(400).json({ error: `${k}: -5000…0` }); A[k] = v; }
        for (const k of ["hi_off", "warn_hi_off"]) if (b.ec_alarm[k] !== undefined) { const v = Number(b.ec_alarm[k]); if (!(v >= 0 && v <= 5000)) return res.status(400).json({ error: `${k}: 0…5000` }); A[k] = v; }
        for (const [k, lo, hi] of [["hyst", 0, 1000], ["delay_min", 0, 120]]) if (b.ec_alarm[k] !== undefined) { const v = Number(b.ec_alarm[k]); if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `${k} ${lo}–${hi}` }); A[k] = v; }
        if (A.lo_off > A.warn_lo_off || A.hi_off < A.warn_hi_off) return res.status(400).json({ error: "hälytysraja oltava varoitusrajaa kauempana SP:stä" });
        next.ec_alarm = A;
      }
      await saveCfg(next);
      res.json({ config: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
