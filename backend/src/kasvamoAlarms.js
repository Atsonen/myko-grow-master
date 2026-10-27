// Kasvamo – väliaikaiset raja-arvohälytykset (26.10.2026) Valvomo-botin kautta (telegram.js tg/allowedChats).
// Siirretty koti-telegramista. Lähetetään KERRAN kun tila alkaa (viive) ja kerran kun palautuu (hystereesi).
// Asetukset: myko_settings k='kasvamo_alarms' (JSON, yhdistetään oletuksiin): {enabled, delay_min, stale_min, limits:{id:{lo,hi,hyst}}}
// Tila: /home/atte/.config/myko/kasvamo_alarm_state.json. Vain luku: ei PLC-kirjoituksia.
import fs from "node:fs";
import { query } from "./db.js";
import { tg, allowedChats } from "./telegram.js";
const STATE = "/home/atte/.config/myko/kasvamo_alarm_state.json";
const DEF = { enabled: true, delay_min: 5, stale_min: 20, limits: {
  pinta: { lo: 20, hi: null, hyst: 2, enabled: true }, vesi: { lo: 15, hi: 26, hyst: 0.5, enabled: true }, ec: { lo: 500, hi: 2500, hyst: 100, enabled: true }, ph: { lo: 5.0, hi: 7.0, hyst: 0.2, enabled: true } } };
const RANGE = { pinta: [0, 100], vesi: [0, 40], ec: [0, 10000], ph: [0, 14] }; // sallitut rajat validointiin
const SIG = { pinta: ["dl25", "Ravinnesäiliö pinta", "%"], vesi: ["dl24", "Ravinnevesi", "°C"], ec: ["dl23", "EC", "ppm"], ph: ["dl26", "pH", ""] };
const BITS = { A_Tayttovesi: "Täyttövesi-hälytys (Pumput_DB Tayttovesi.Active)", A_HumHH: "Kosteus HH (Pumput_DB A_HumHH.Active)", EC_Below_Q: "EC alhainen yli viiveen (Pumput_DB EC_Below.Q)" };
let st = { active: {}, since: {}, msg: {} };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE, "utf8")) }; } catch { /* first run */ }
const save = () => { try { fs.writeFileSync(STATE + ".tmp", JSON.stringify(st)); fs.renameSync(STATE + ".tmp", STATE); } catch (e) { console.warn("[kasvamo] state", e.message); } };
async function cfg() {
  const [r] = await query("SELECT v FROM myko_settings WHERE k = 'kasvamo_alarms'");
  let c = {}; try { c = r ? (typeof r.v === "string" ? JSON.parse(r.v) : (r.v ?? {})) : {}; } catch { /* default */ }
  return { ...DEF, ...c, limits: Object.fromEntries(Object.keys(DEF.limits).map((k) => [k, { ...DEF.limits[k], ...(c.limits?.[k] ?? {}) }])) };
}
async function evaluate(c, port) {
  const out = {}; const now = Date.now();
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(10_000) })).json();
  try {
    const rows = Object.fromEntries((await get(`/api/datalogger/latest?keys=${Object.values(SIG).map((s) => s[0]).join(",")}`)).map((r) => [r.variableKey, r]));
    const newest = Math.max(0, ...Object.values(rows).map((r) => Date.parse(r.timestamp) || 0));
    out.stale = [now - newest > c.stale_min * 60_000, `⚠️ Kasvamo: ei uutta dataloggerdataa ${Math.round((now - newest) / 60000)} min`];
    for (const [id, [dl, name, unit]] of Object.entries(SIG)) {
      if (id === "ec") continue; // EC: SP-suhteelliset rajat fertDose.js:ssä (hälytys+lukitus), ei tuplailmoitusta
      const r = rows[dl]; if (!r || r.value == null) continue;
      const v = Number(r.value); const L = c.limits[id];
      for (const side of ["lo", "hi"]) {
        const lim = L[side]; const key = `${id}:${side}`;
        if (lim == null || L.enabled === false) { out[key] = [false, ""]; continue; }
        const h = st.active[key] ? Number(L.hyst) || 0 : 0; // aktiivisena palautuminen vaatii hystereesin
        const bad = side === "lo" ? v < lim + h : v > lim - h;
        out[key] = [bad, `🌱 Kasvamo: ${name} ${v} ${unit} ${side === "lo" ? "alle" : "yli"} rajan ${lim} ${unit}`.replace(/ +/g, " ")];
      }
    }
  } catch (e) { console.warn("[kasvamo] datalogger", e.message); }
  try {
    const p = await get("/api/pumput");
    if (!p.stale) for (const [k, t] of Object.entries(BITS)) if (k in p.values) out[k] = [!!p.values[k], "🌱 Kasvamo: " + t];
  } catch (e) { console.warn("[kasvamo] pumput", e.message); }
  return out;
}
async function notify(text) { for (const chat_id of await allowedChats()) await tg("sendMessage", { chat_id, text }); }
export function kasvamoAlarmRows() {
  return Object.entries(st.active).filter(([, v]) => v).map(([k], i) => ({ id: -(1_900_000_000 + i), pointId: "Kasvamo", pointName: "Kasvamo", unit: "", alarm: k.toUpperCase(),
    bit: null, priority: 1, start: new Date(st.at?.[k] ?? Date.now()).toISOString(), end: null, active: true, value: null, endValue: null,
    source: "Kasvamo", desc: String(st.msg[k] ?? k).replace("🌱 ", ""), acked: true, ackedAt: null, ackedBy: null }));
}
export function kasvamoActive() { return Object.entries(st.active).filter(([, v]) => v).map(([k]) => st.msg[k] ?? k); }
export function startKasvamoAlarms({ port }) {
  const tick = async () => {
    const c = await cfg(); if (!c.enabled) return;
    const now = Date.now(); const delay = c.delay_min * 60_000;
    for (const [key, [bad, msg]] of Object.entries(await evaluate(c, port))) {
      if (bad && !st.active[key]) {
        st.since[key] ??= now;
        if (now - st.since[key] >= delay) {
          st.active[key] = true; st.msg[key] = msg; (st.at ??= {})[key] = now; console.log(`[kasvamo] ALARM ${key}: ${msg}`);
          try { await notify(msg + " (ilmoitetaan kerran, palautumisesta erikseen)"); } catch (e) { console.warn("[kasvamo] telegram", e.message); }
        }
      } else if (!bad) {
        delete st.since[key];
        if (st.active[key]) {
          st.active[key] = false; console.log(`[kasvamo] clear ${key}`);
          try { await notify("✅ Palautui: " + (st.msg[key] ?? key).replace("🌱 ", "")); } catch (e) { console.warn("[kasvamo] telegram", e.message); }
        }
      }
    }
    save();
  };
  setTimeout(() => { tick().catch((e) => console.warn("[kasvamo]", e.message)); setInterval(() => tick().catch((e) => console.warn("[kasvamo]", e.message)), 60_000); }, 30_000);
}

// GET/PUT /api/kasvamo/alarms – rajojen muokkaus prosessinäkymästä (vain Myko-asetus, ei PLC). Moottori lukee asetukset joka minuutti.
export function registerKasvamoAlarmRoutes(app) {
  const view = async () => ({ config: await cfg(), active: { ...st.active }, signals: Object.fromEntries(Object.entries(SIG).map(([k, [dl, name, unit]]) => [k, { dl, name, unit, range: RANGE[k] }])) });
  app.get("/api/kasvamo/alarms", async (_req, res) => { try { res.json(await view()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.put("/api/kasvamo/alarms", async (req, res) => {
    try {
      const b = req.body ?? {}; const cur = await cfg(); const next = { ...cur, limits: { ...cur.limits } };
      const num = (v) => (v === null || v === "" || v === undefined ? null : Number(v));
      if (b.delay_min !== undefined) {
        const d = Number(b.delay_min); if (!Number.isFinite(d) || d < 0 || d > 120) return res.status(400).json({ error: "viive 0–120 min" });
        next.delay_min = d;
      }
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      for (const [k, v] of Object.entries(b.limits ?? {})) {
        if (!SIG[k]) return res.status(400).json({ error: `tuntematon signaali ${k}` });
        const [mn, mx] = RANGE[k]; const L = { ...cur.limits[k] };
        if ("lo" in v) L.lo = num(v.lo);
        if ("hi" in v) L.hi = num(v.hi);
        if ("hyst" in v) L.hyst = num(v.hyst) ?? 0;
        if ("enabled" in v) L.enabled = !!v.enabled;
        for (const x of ["lo", "hi"]) if (L[x] !== null && (!Number.isFinite(L[x]) || L[x] < mn || L[x] > mx)) return res.status(400).json({ error: `${SIG[k][1]}: raja ${mn}–${mx}` });
        if (L.lo !== null && L.hi !== null && L.lo >= L.hi) return res.status(400).json({ error: `${SIG[k][1]}: alaraja < yläraja` });
        if (!Number.isFinite(L.hyst) || L.hyst < 0 || (L.lo !== null && L.hi !== null && L.hyst * 2 >= L.hi - L.lo) || L.hyst > mx - mn) return res.status(400).json({ error: `${SIG[k][1]}: hystereesi ≥ 0 ja pienempi kuin puolet rajojen välistä` });
        next.limits[k] = L;
      }
      await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('kasvamo_alarms', ?, 'ui') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [JSON.stringify(next)]);
      console.log("[kasvamo] asetukset päivitetty", JSON.stringify(b));
      res.json(await view());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
