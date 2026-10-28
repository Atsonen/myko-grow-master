// Lannoiteannostelu – Valvomon päätöslogiikka + ohjaus (PLC: FB_FertDose / FertDose_DB, ks. plc/FERTDOSE.md).
// Käyttäjä hyväksyi live-ohjauksen 27.10.2026 11:20 (fyysinen lähtö forsattu 0 PLC:ssä testivaiheessa).
// Kirjoitukset vain bridgen kautta: MQTT Myko/Cmd/FertDose (whitelist Enable, DoseReq_ms, DoseTrig pulse, Heartbeat).
// Asetukset: myko_settings k='fert_dose'. Loki: fert_dose_log. Hälytykset/varoitukset: fert_events.
// Lannoite A/B = sama pumppu, letku siirretään käsin: fert on vain Myko-asetus, kirjataan jokaiselle annokselle.
// EC-hälytys/-varoitus = ± poikkeama TDS_SP:stä. EC_ALARM_HI -> Telegram + LUKITUS (Enable=false).
// EC_ALARM_LO -> Telegram, EI lukitusta (annostelua tarvitaan). Kuittaus Valvomossa vapauttaa HI-lukituksen.
// VAROITUS -> vain UI/hälytyslista. HI/LO palautuvat kukin oman rajansa perusteella (eivät jumita toisiaan).
import mqtt from "mqtt";
import { query } from "./db.js";
import { tg, allowedChats } from "./telegram.js";
import { disableMinutes, untilTxt, logToggle, DIS_DEFAULT_MIN } from "./alarmDisable.js";

const DEF = {
  live: true, hb_enabled: true, plc_enable: false, auto: true, fert: "A", dose_s: 1,
  ec_key: "dl23", sp_source: "plc", sp_manual: 4800, ec_sp: 4800,
  below_min: 10, pause_min: 20, stale_s: 120, min_uptime_min: 10,
  range: [100, 9000], spike_ppm: 400, n_samples: 6, poll_s: 10,
  ec_alarm: { enabled: true, lo_off: -1500, hi_off: 1500, warn_lo_off: -700, warn_hi_off: 700, hyst: 100, delay_min: 5, clear_min: 3 },
};
const STATUS_TXT = { 0: "valmis", 1: "annostelee", 2: "annos valmis", 3: "annos valmis (rajattu 5 s)", 10: "hylätty: Enable pois", 11: "heartbeat puuttuu", 13: "hylätty: virheellinen pyyntö", 14: "katkaistu: Enable pudotettu", 15: "katkaistu: turvakatkaisu" };

// Käyttäjän hyväksymä (28.10.2026): VAIN FB_FertDose_DB.Input.Enable (Bool) prosessinäkymän Käyttö-kytkimestä.
const PUMP_ENABLE_WRITE_ALLOWED = true;
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
  await query("ALTER TABLE fert_events ADD COLUMN IF NOT EXISTS acked_ts DATETIME NULL, ADD COLUMN IF NOT EXISTS acked_by VARCHAR(80) NULL");
  // Varoitukset rakennetaan uudelleen; aktiiviset EC-HÄLYTYKSET säilyvät uudelleenkäynnistyksen yli (fail-safe: lukitus pysyy).
  await query("UPDATE fert_events SET cleared_ts = UTC_TIMESTAMP() WHERE cleared_ts IS NULL AND NOT (level = 'alarm' AND code LIKE 'ec_alarm_%')");
  for (const r of await query("SELECT id, code, level, text, ts, acked_ts FROM fert_events WHERE cleared_ts IS NULL AND level = 'alarm' AND code LIKE 'ec_alarm_%' ORDER BY id")) {
    S.ev[r.code] = { level: "alarm", active: true, text: r.text, since: new Date(r.ts).toISOString(), id: Number(r.id), acked: !!r.acked_ts };
    console.log(`[fertdose] palautettu aktiivinen hälytys ${r.code} (#${r.id})${r.code === 'ec_alarm_hi' && !r.acked_ts ? ' – lukitus voimassa' : ''}`);
  }
  const [last] = await query("SELECT TIMESTAMPDIFF(SECOND, ts, UTC_TIMESTAMP()) age_s FROM fert_dose_log WHERE mode IN ('live','dry-run') AND requested_ms > 0 ORDER BY id DESC LIMIT 1");
  if (last) S.lastDoseAt = Date.now() - Number(last.age_s) * 1000;
}
const logRow = (fert, ms, ec, sp, reason, mode) => query("INSERT INTO fert_dose_log (ts, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode) VALUES (UTC_TIMESTAMP(), ?, ?, NULL, ?, ?, ?, ?)", [fert, ms, ec ?? null, sp ?? null, String(reason).slice(0, 200), mode]);
async function notify(text) {
  for (let i = 0; i < 4; i++) {
    try { for (const chat_id of await allowedChats()) await tg("sendMessage", { chat_id, text }); return; }
    catch (e) { console.warn(`[fertdose] telegram (yritys ${i + 1}/4)`, e.message); await new Promise((r) => setTimeout(r, 5000 * (i + 1))); }
  }
}

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
// Lukitus VAIN EC_ALARM_HI (liian väkevä). LO = annostelua tarvitaan -> ei koskaan lukitse. Käyttäjän kuittaus vapauttaa lukituksen.
function alarmActive() { const e = S.ev.ec_alarm_hi; return Boolean(e?.active && e.level === "alarm" && !e.acked); }
async function setEvent(code, level, active, text, c) {
  const e = S.ev[code];
  if (active) {
    S.evSince[code] ??= Date.now();
    if (e?.active) { e.text = text; return; }
    const delay = level === "alarm" ? (Number(c.ec_alarm.delay_min) || 0) * 60_000 : 0;
    if (Date.now() - S.evSince[code] < delay) return;
    const r = await query("INSERT INTO fert_events (ts, level, code, text) VALUES (UTC_TIMESTAMP(), ?, ?, ?)", [level, code, text.slice(0, 250)]);
    S.ev[code] = { level, active: true, text, since: new Date().toISOString(), id: Number(r.insertId), acked: level !== "alarm" };
    console.log(`[fertdose] ${level.toUpperCase()} ${code}: ${text}`);
    if (level === "alarm") await notify(`🚨 ${text}${code === "ec_alarm_hi" ? " – annostelu LUKITTU" : " – annostelu sallittu"} (ilmoitetaan kerran, palautumisesta erikseen)`);
  } else {
    delete S.evSince[code];
    if (!e?.active) return;
    e.active = false; await query("UPDATE fert_events SET cleared_ts = UTC_TIMESTAMP() WHERE id = ?", [e.id]);
    console.log(`[fertdose] clear ${code}`);
    if (level === "alarm" && c?.recoveryText) await notify(c.recoveryText);
    delete S.ev[code];
  }
}
// EC-hälytyksen kuittautuminen (fail-safe): vain kun LUOTETTAVA EC on ollut rajojen sisällä hystereesin verran
// vähintään clear_min minuuttia. Epäluotettava/vanha mittaus ei koskaan poista hälytystä eikä lukitusta.
async function evalEcAlarm(code, c, ec, reliable, raise, inside, lo, hi) {
  const e = S.ev[code];
  if (!e?.active) { delete S.clrSince?.[code]; if (raise) await setEvent(code, "alarm", true, raise, c); else delete S.evSince[code]; return; }
  S.clrSince ??= {};
  if (raise) { e.text = raise; delete S.clrSince[code]; return; }
  if (!reliable || ec == null || !inside) { delete S.clrSince[code]; return; } // pidä hälytys + lukitus
  S.clrSince[code] ??= Date.now();
  const need = Math.max(1, Number(c.ec_alarm.clear_min) || 3) * 60_000;
  if (Date.now() - S.clrSince[code] < need) return;
  delete S.clrSince[code];
  await setEvent(code, "alarm", false, "", { ...c, recoveryText: `✅ Palautui: EC ${ec} ppm, takaisin rajoissa (${lo}–${hi}) – ${code === "ec_alarm_hi" ? "annostelulukitus poistui" : "alaraja OK"}` });
}
async function ecDisableCheck(c) {
  const A = c.ec_alarm; if (A.enabled) return;
  if (!A.disabled_until) { // vanha pysyvä poiskytkentä -> aikaraja oletuksella
    A.disabled_until = new Date(Date.now() + DIS_DEFAULT_MIN * 60_000).toISOString(); await saveCfg({ ...c, ec_alarm: A });
    await logToggle("ec", "disable", A.disabled_until, "auto-aikaraja");
    await notify(`🔕 Hälytys EC (lannoite) pois päältä ${untilTxt(A.disabled_until)} asti`);
  } else if (Date.now() >= Date.parse(A.disabled_until)) {
    A.enabled = true; delete A.disabled_until; await saveCfg({ ...c, ec_alarm: A });
    await logToggle("ec", "auto-enable", null, "ajastin");
    await notify("🔔 Hälytys EC (lannoite) kytketty takaisin päälle");
  }
}
async function clearEcAlarmsDisabled() {
  for (const code of ["ec_alarm_lo", "ec_alarm_hi"]) if (S.ev[code]?.active) {
    await setEvent(code, "alarm", false, "", {}); delete S.evSince[code]; delete S.clrSince?.[code];
    await logRow(CFG.fert, 0, S.samples.at(-1)?.v, S.sp, `${code} kuitattu: hälytys kytketty pois käyttäjän toimesta (aikaraja) – lukitus vapautettu`, "live");
  }
}
async function evalAlarms(c, ec, sp, reliable) {
  await ecDisableCheck(c);
  const A = c.ec_alarm;
  if (!A.enabled) await clearEcAlarmsDisabled();
  const on = A.enabled && reliable && ec != null && sp != null;
  const h = (code) => (S.ev[code]?.active ? Number(A.hyst) || 0 : 0);
  const hA = Math.min(50, Math.max(20, Number(A.hyst) || 0)); // hälytyksen kuittaushystereesi 20–50 ppm
  const lim = { alo: sp + A.lo_off, ahi: sp + A.hi_off, wlo: sp + A.warn_lo_off, whi: sp + A.warn_hi_off };
  const t = (lvl, side, l) => `Lannoite EC ${ec} ppm ${side === "lo" ? "alle" : "yli"} ${lvl}rajan ${l} (SP ${sp} ${side === "lo" ? A[lvl === "hälytys" ? "lo_off" : "warn_lo_off"] : "+" + A[lvl === "hälytys" ? "hi_off" : "warn_hi_off"]})`;
  const okLo = on && ec >= lim.alo + hA, okHi = on && ec <= lim.ahi - hA;
  await evalEcAlarm("ec_alarm_lo", c, ec, on, on && ec < lim.alo ? t("hälytys", "lo", lim.alo) : null, okLo, lim.alo, lim.ahi);
  // Kumpikin puoli palautuu OMAN rajansa perusteella (ennen vaadittiin okLo && okHi -> HI jumittui, kun EC laski alle LO-rajan).
  await evalEcAlarm("ec_alarm_hi", c, ec, on, on && ec > lim.ahi ? t("hälytys", "hi", lim.ahi) : null, okHi, lim.alo, lim.ahi);
  await setEvent("ec_warn_lo", "warning", on && ec < lim.wlo + h("ec_warn_lo") && ec < sp && !(ec < lim.alo), t("varoitus", "lo", lim.wlo), c);
  await setEvent("ec_warn_hi", "warning", on && ec > lim.whi - h("ec_warn_hi") && ec > sp && !(ec > lim.ahi), t("varoitus", "hi", lim.whi), c);
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
      if (!S.samples.length || S.samples[S.samples.length - 1].t !== t) { S.samples.push({ t, v }); S.samples = S.samples.slice(-120);
        const m = Math.floor(t / 60000) * 60000; const tr = S.trend ??= []; if (!tr.length || tr[tr.length - 1].t !== m) { tr.push({ t: m, v }); S.trend = tr.slice(-360); } else tr[tr.length - 1].v = v; }
    }
    // SP on Myko-asetus (fert_dose.ec_sp). PLC:n Pumput_DB.TDS_SP vain vertailuksi (ei kirjoiteta).
    try { const pu = await get("/api/pumput"); const v = Number(pu?.values?.TDS_SP); S.spPlc = !pu?.stale && Number.isFinite(v) ? v : null; } catch { S.spPlc = null; }
    const sp = Number(c.ec_sp ?? c.sp_manual);
    S.sp = Number.isFinite(sp) ? sp : null;
    const lastS = S.samples[S.samples.length - 1];
    const basicOk = lastS && now - lastS.t <= c.stale_s * 1000 && lastS.v >= c.range[0] && lastS.v <= c.range[1];
    if (!basicOk) S.validSince = null; else if (!S.validSince) S.validSince = now;
    const [ok, why] = reliability(c, now); S.relWhy = why; S.relOk = ok;
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

// Rivit Myko-hälytyslistaan (/api/alarms/summary), lähde "Kasvamo".
export function fertDisabledRows() {
  const A = CFG.ec_alarm; return !A.enabled && A.disabled_until ? [{ key: "ec", name: "EC (lannoite)", until: A.disabled_until }] : [];
}
export async function fertAlarmRows(hours) {
  const ev = await query("SELECT id, DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%sZ') ts, DATE_FORMAT(cleared_ts, '%Y-%m-%dT%H:%i:%sZ') cl, level, code, text, acked_ts FROM fert_events WHERE ts > UTC_TIMESTAMP() - INTERVAL ? HOUR OR cleared_ts IS NULL ORDER BY id DESC LIMIT 300", [hours]);
  return ev.map((e) => ({ id: -(2_000_000_000 + Number(e.id)), pointId: "Kasvamo_EC", pointName: "Kasvamo · EC / lannoitus", unit: "ppm", alarm: String(e.code).toUpperCase(),
    bit: null, priority: e.level === "alarm" ? 1 : 2, start: e.ts, end: e.cl, active: !e.cl && Boolean(S.ev[e.code]?.active), value: null, endValue: null,
    source: "Kasvamo", desc: e.text, acked: e.level !== "alarm" || e.acked_ts != null, ackedAt: null, ackedBy: null })).map((r) => (r.active || r.end ? r : { ...r, end: r.start }));
}
// Kuittaus (vain hälytykset; varoitukset eivät vaadi kuittausta). ids = fert_events.id
export async function fertAck(ids, by) {
  const n = ids.map(Number).filter((x) => Number.isInteger(x) && x > 0); if (!n.length) return 0;
  const r = await query(`UPDATE fert_events SET acked_ts = UTC_TIMESTAMP(), acked_by = ? WHERE level = 'alarm' AND acked_ts IS NULL AND id IN (${n.map(() => "?").join(",")})`, [String(by ?? "dashboard").slice(0, 80), ...n]);
  for (const e of Object.values(S.ev)) if (n.includes(e.id)) e.acked = true;
  console.log(`[fertdose] ack ${n.join(",")} by ${by}`);
  return Number(r.affectedRows ?? 0);
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
  // Heartbeat 5 s välein (vain kun live + hb_enabled + DB olemassa).
  // Älä pinoudu: jos edellinen vielä auki, jätä tämä kerta väliin. Timeout 8 s (sillan pollauskuorma).
  let hbBusy = false;
  setInterval(async () => {
    if (!CFG.live || !CFG.hb_enabled || !S.plc.present || hbBusy) return;
    hbBusy = true;
    try {
      S.hb = (S.hb + 1) % 65536; const a = await cmd({ Heartbeat: S.hb }, 8000);
      S.hbErr = okRes(a, "Heartbeat") ? null : errTxt(a); if (!S.hbErr) S.hbAt = Date.now();
    } finally { hbBusy = false; }
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
      const recent = await query("SELECT DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%sZ') ts, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode FROM fert_dose_log ORDER BY id DESC LIMIT 200");
      const events = await query("SELECT id, DATE_FORMAT(ts, '%Y-%m-%dT%H:%i:%sZ') ts, DATE_FORMAT(cleared_ts, '%Y-%m-%dT%H:%i:%sZ') cleared_ts, level, code, text, DATE_FORMAT(acked_ts, '%Y-%m-%dT%H:%i:%sZ') acked_ts, acked_by FROM fert_events ORDER BY id DESC LIMIT 200");
      const lastS = S.samples[S.samples.length - 1];
      res.json({ config: c, mode: c.live ? "live" : "dry-run", heartbeat: !c.hb_enabled ? "off" : !S.plc.present ? "odottaa DB:tä" : S.hbErr ? `virhe: ${S.hbErr}` : "ok",
        hbValue: S.hb, pump_write_allowed: PUMP_ENABLE_WRITE_ALLOWED,
        plc: { ...S.plc, fresh: plcFresh(), statusText: STATUS_TXT[S.plc.Status] ?? (S.plc.Status != null ? `koodi ${S.plc.Status}` : null) },
        interlock: alarmActive(), ec: lastS ? { value: lastS.v, at: new Date(lastS.t).toISOString() } : null, sp: S.sp,
        belowSince: S.belowSince ? new Date(S.belowSince).toISOString() : null, lastDoseAt: S.lastDoseAt ? new Date(S.lastDoseAt).toISOString() : null,
        nextAllowedAt: S.lastDoseAt ? new Date(S.lastDoseAt + c.pause_min * 60_000).toISOString() : null,
        reason: S.reason, active: Object.entries(S.ev).filter(([, e]) => e.active).map(([code, e]) => ({ code, ...e })), events: events.map((e) => ({ ...e, id: Number(e.id) })),
        reliable: { ok: Boolean(S.relOk), why: S.relWhy ?? null }, validSince: S.validSince ? new Date(S.validSince).toISOString() : null, spPlc: S.spPlc ?? null, trend: (S.trend ?? []).map((p) => [p.t, p.v]), spNow: S.sp,
        cumulative: cum.map((r) => ({ ...r, n: Number(r.n), req_ms: Number(r.req_ms), act_ms: Number(r.act_ms) })), recent });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Käsiannos: vaatii confirm=true. Ohittaa auto-tauon (pause_min), mutta HI-lukitus + PLC-turvaehdot
  // estävät edelleen. Onnistunut käsiannos käynnistää tauon alusta (dose() asettaa lastDoseAt).
  app.post("/api/fertdose/dose", async (req, res) => {
    try {
      const c = await cfg();
      if (req.body?.confirm !== true) return res.status(400).json({ error: "vahvistus puuttuu" });
      const r = await dose(c, "käsiannos (Annostele nyt)", "manual");
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Prosessinäkymä: lannoitepumpun Käyttö (Enable). Kaksi fyysistä pumppua saman lähdön takana → yksi symboli.
  // Kirjoitus: FB_FertDose_DB/Input/Enable (hyväksytty). Päivittää myös fert_dose.plc_enable ettei tick ylikirjoita.
  app.post("/api/fertdose/pump", async (req, res) => {
    try {
      const en = req.body?.enable;
      if (!PUMP_ENABLE_WRITE_ALLOWED) return res.status(403).json({ error: "Pumppukirjoitus ei käytössä" });
      if (typeof en !== "boolean") return res.status(400).json({ error: "enable bool" });
      if (!mq?.connected) return res.status(503).json({ error: "MQTT ei yhteydessä" });
      const c = await cfg();
      const next = { ...c, plc_enable: en };
      await saveCfg(next);
      const locked = alarmActive();
      const want = en && !locked;
      const a = await cmd({ Enable: want });
      await logRow(c.fert, 0, null, S.sp, `pump Enable=${want} plc_enable=${en}${locked ? " (EC-hälytyslukitus)" : ""} by=${String(req.body?.by ?? "myko-ui")}`, "live");
      if (!okRes(a, "Enable")) return res.status(502).json({ error: errTxt(a) || "Enable-kirjoitus epäonnistui", ack: a });
      res.json({ ok: true, enable: en, written: want, read: a.results?.Enable?.value ?? a.results?.Enable, interlock: locked, pump_write_allowed: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put("/api/fertdose/settings", async (req, res) => {
    try {
      const b = req.body ?? {}; const cur = await cfg(); const next = { ...cur, ec_alarm: { ...cur.ec_alarm } };
      if (b.fert !== undefined) { if (!["A", "B"].includes(b.fert)) return res.status(400).json({ error: "fert A/B" }); next.fert = b.fert; }
      if (b.dose_s !== undefined) { const d = Number(b.dose_s); if (!(d > 0 && d <= 5)) return res.status(400).json({ error: "annos 0–5 s" }); next.dose_s = d; }
      for (const k of ["live", "hb_enabled", "plc_enable", "auto"]) if (b[k] !== undefined) { if (typeof b[k] !== "boolean") return res.status(400).json({ error: `${k} bool` }); next[k] = b[k]; }
      for (const [k, lo, hi] of [["below_min", 1, 120], ["pause_min", 5, 240], ["spike_ppm", 10, 5000], ["min_uptime_min", 0, 120], ["stale_s", 20, 900], ["sp_manual", 100, 9000], ["ec_sp", 100, 9000]]) {
        if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `${k} ${lo}–${hi}` }); next[k] = v; }
      }
      if (b.sp_source !== undefined) { if (!["plc", "manual"].includes(b.sp_source)) return res.status(400).json({ error: "sp_source plc/manual" }); next.sp_source = b.sp_source; }
      if (b.ec_alarm && typeof b.ec_alarm === "object") {
        const A = { ...next.ec_alarm };
        if (b.ec_alarm.enabled === false && (cur.ec_alarm.enabled || b.ec_alarm.disable_min !== undefined)) {
          let m; try { m = disableMinutes(b.ec_alarm.disable_min); } catch (e) { return res.status(400).json({ error: e.message }); }
          A.enabled = false; A.disabled_until = new Date(Date.now() + m * 60_000).toISOString(); A._dis = true;
        } else if (b.ec_alarm.enabled === true && !cur.ec_alarm.enabled) { A.enabled = true; delete A.disabled_until; A._en = true; }
        for (const k of ["lo_off", "warn_lo_off"]) if (b.ec_alarm[k] !== undefined) { const v = Number(b.ec_alarm[k]); if (!(v <= 0 && v >= -5000)) return res.status(400).json({ error: `${k}: -5000…0` }); A[k] = v; }
        for (const k of ["hi_off", "warn_hi_off"]) if (b.ec_alarm[k] !== undefined) { const v = Number(b.ec_alarm[k]); if (!(v >= 0 && v <= 5000)) return res.status(400).json({ error: `${k}: 0…5000` }); A[k] = v; }
        for (const [k, lo, hi] of [["hyst", 0, 1000], ["delay_min", 0, 120]]) if (b.ec_alarm[k] !== undefined) { const v = Number(b.ec_alarm[k]); if (!(v >= lo && v <= hi)) return res.status(400).json({ error: `${k} ${lo}–${hi}` }); A[k] = v; }
        if (A.lo_off > A.warn_lo_off || A.hi_off < A.warn_hi_off) return res.status(400).json({ error: "hälytysraja oltava varoitusrajaa kauempana SP:stä" });
        const dis = A._dis, en = A._en; delete A._dis; delete A._en;
        next.ec_alarm = A; next._toggle = dis ? "dis" : en ? "en" : null;
      }
      const tg = next._toggle; delete next._toggle;
      await saveCfg(next);
      const by = String(req.body?.by ?? "ui");
      if (tg === "dis") { await logToggle("ec", "disable", next.ec_alarm.disabled_until, by); await clearEcAlarmsDisabled(); await notify(`🔕 Hälytys EC (lannoite) pois päältä ${untilTxt(next.ec_alarm.disabled_until)} asti`); }
      if (tg === "en") { await logToggle("ec", "enable", null, by); await notify("🔔 Hälytys EC (lannoite) kytketty takaisin päälle"); }
      res.json({ config: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
export const __test = { S, evalAlarms, alarmActive, DEF };
