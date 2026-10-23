// DeepSeek anomaly monitor: every 15 min, READ-ONLY. Summarises PID + sensor data, stores findings (llm_findings),
// logs them as events (alarm_events point LLM_Advisor), severity high -> WhatsApp via the normal wa_alert.send path.
// It may RECOMMEND a sensor 5 V reset (recommend_reset) but never executes one.
import { processContext } from "./processDoc.js";
import { execFile } from "node:child_process";
import { deepseekChat } from "./deepseek.js";

const EVERY_MIN = 15, DEDUPE_H = 6, FROZEN_MIN = 60, STALE_MIN = 10;
const WA_PY = "/usr/bin/python3", WA_DIR = "/home/atte/myko-ml";
const SEV = ["info", "low", "medium", "high"];
// "high" (-> WhatsApp) only for control-relevant points: the PIDs and their PV sensors. Other sensors are capped at medium.
const CRITICAL = new Set(["F1", "T1", "G_Air", "SYSTEM", "dl00", "dl02", "dl31"]);

function sendWhatsApp(text) {
  return new Promise((resolve) => execFile(WA_PY, ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from wa_alert import send; r = send(sys.argv[2], tag='llm'); print('OK' if r[0] else 'FAIL', r[1])", WA_DIR, text],
    { timeout: 60_000, cwd: WA_DIR }, (err, out) => resolve(!err && String(out).startsWith("OK"))));
}

export function registerAnomaly(app, { query, asyncRoute, pidState, PID_POINTS }) {
  let running = false, lastRun = 0;
  async function gather() {
    const pids = {};
    for (const key of Object.keys(PID_POINTS)) {
      const [r] = await query(`SELECT COUNT(*) n, ROUND(AVG(sp),2) sp, ROUND(MIN(pv),2) pvmin, ROUND(AVG(pv),2) pvavg, ROUND(MAX(pv),2) pvmax, ROUND(STDDEV(pv),3) pvstd,
        ROUND(AVG(out_heat),1) heat, ROUND(MAX(out_heat),1) heatmax, ROUND(AVG(out_cool),1) cool, ROUND(MAX(out_cool),1) coolmax, MIN(state) stmin, MAX(state) stmax, MAX(err_bits) err
        FROM pid_training_log WHERE pid_key = ? AND at > UTC_TIMESTAMP() - INTERVAL 60 MINUTE`, [key]);
      const v = pidState(key)?.values ?? {};
      pids[key] = { last60min: Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x === null ? null : Number(x)])), now: { SP: v.SP, PV: v.PV, State: v.State, ErrBits: v.ErrBits, OutHeat: v.OutHeat, OutCool: v.OutCool } };
    }
    const vars = await query("SELECT source_id, variable_key, COALESCE(display_name, name) n, unit FROM datalogger_variables WHERE archived = 0 AND visible = 1 AND var_type = 'analog' AND unit IS NOT NULL");
    const sensors = [];
    for (const x of vars) {
      const [s] = await query(`SET STATEMENT max_statement_time=5 FOR SELECT COUNT(*) n, MIN(numeric_value) mn, MAX(numeric_value) mx, ROUND(AVG(numeric_value),3) av, ROUND(STDDEV(numeric_value),4) sd,
        TIMESTAMPDIFF(SECOND, MAX(timestamp), UTC_TIMESTAMP()) age FROM datalogger_values WHERE source_id = ? AND variable_key = ? AND timestamp > UTC_TIMESTAMP() - INTERVAL ${FROZEN_MIN} MINUTE`, [x.source_id, x.variable_key]);
      const n = Number(s.n);
      sensors.push({ key: x.variable_key, name: x.n, unit: x.unit, n, min: s.mn === null ? null : Number(s.mn), max: s.mx === null ? null : Number(s.mx), avg: s.av === null ? null : Number(s.av), std: s.sd === null ? null : Number(s.sd),
        ageS: s.age === null ? null : Number(s.age), frozen: n >= 10 && Number(s.mx) === Number(s.mn), stale: n === 0 || Number(s.age) > STALE_MIN * 60 });
    }
    const alarms = (await query("SELECT id, last_active FROM alarm_points WHERE enabled = 1")).map((a) => ({ id: a.id, active: a.last_active })).filter((a) => a.active && a.active !== "[]");
    const [w] = await query("SELECT air_temperature t, relative_humidity rh FROM weather_metno ORDER BY id DESC LIMIT 1");
    return { pids, sensors, alarms, outdoor: w ? { t: Number(w.t), rh: Number(w.rh) } : null };
  }

  async function run(trigger) {
    if (running) throw new Error("valvonta on jo käynnissä"); running = true; lastRun = Date.now();
    try {
      const data = await gather();
      const sys = `Olet sienikasvamon automaation valvoja (Siemens PID_Temp + anturit). Etsi poikkeamat datasta: jäätyneet anturit (frozen=true; PID-säädön PV-anturit: F1=dl02, T1=dl00, G_Air=dl31 DS4 – näiden jäätyminen on high: sama arvo koko tunnin, esim. DS4 jumissa 8.89), vanhentunut data (stale), saturoitunut lähtö (100 % pitkään), SP:n ja PV:n pysyvä ero, epätavallinen lähtö ulkolämpötilaan nähden, anturien ristiriidat. Älä raportoi normaalia toimintaa. Tiedossa: Warning 16#0020 jatkuvasti päällä (ei raportoida).
Vastaa VAIN JSON: {"findings":[{"severity":"info|low|medium|high","point":"F1|T1|G_Air|<anturin key>|SYSTEM","category":"frozen_sensor|stale_data|saturation|sp_deviation|output|sensor_conflict|other","finding":"lyhyesti suomeksi","suggestion":"toimenpide suomeksi","recommend_reset":false}]}
high vain, jos säätö on vaarassa tai tuote vaarassa (esim. PID:n PV jäätynyt -> säätö sokea). recommend_reset=true vain jäätyneelle/puuttuvalle anturille (5 V reset katkaisee SensorBlock 1+2 syötön n. 8 s; et suorita sitä itse).`;
      const b = await deepseekChat({ messages: [{ role: "system", content: sys + processContext("full") }, { role: "user", content: `Aika UTC ${new Date().toISOString()}\n${JSON.stringify(data)}` }], response_format: { type: "json_object" }, max_tokens: 1200 }, 90_000);
      let resp; try { resp = JSON.parse(b.choices?.[0]?.message?.content ?? ""); } catch { throw new Error("DeepSeek: vastaus ei ollut JSONia"); }
      const u = b.usage ?? {}; const runId = `an-${Date.now().toString(36)}`;
      const out = [];
      const [ig] = await query("SELECT v FROM myko_settings WHERE k = 'anomaly_ignore'");
      const ignore = ig ? (typeof ig.v === "string" ? JSON.parse(ig.v) : ig.v) : [];
      for (const f of (Array.isArray(resp.findings) ? resp.findings : []).slice(0, 20)) {
        const point = String(f.point ?? "SYSTEM").slice(0, 40);
        let sev = SEV.includes(f.severity) ? f.severity : "info";
        if (sev === "high" && !CRITICAL.has(point)) sev = "medium";
        // PID saturation/output findings are only "high" when the loop is really off target (|PV avg - SP| >= 2 °C over 60 min)
        const pl = data.pids[point]?.last60min;
        if (sev === "high" && pl && !/frozen|stale|sensor|comm|err/i.test(String(f.category ?? "")) && !(Math.abs((pl.pvavg ?? 0) - (pl.sp ?? 0)) >= 2)) sev = "medium";
        if (ignore.includes(point)) continue;
        const cat = String(f.category ?? "other").slice(0, 40);
        const [dup] = await query("SELECT id FROM llm_findings WHERE point = ? AND category = ? AND severity = ? AND at > UTC_TIMESTAMP() - INTERVAL ? HOUR LIMIT 1", [point, cat, sev, DEDUPE_H]);
        let wa = null;
        if (!dup) {
          await query("INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES ('LLM_Advisor', ?, NULL, 'llm', UTC_TIMESTAMP(3), NULL, NULL)",
            [`[${sev}] ${point}: ${f.finding}${f.recommend_reset ? " (suositus: anturireset)" : ""}`.slice(0, 255)]).catch((e) => console.error("[anomaly] event", e.message));
          if (sev === "high") wa = await sendWhatsApp(`Myko-valvoja (DeepSeek): ${point} – ${f.finding}. ${f.suggestion ?? ""}`.slice(0, 600));
        }
        await query(`INSERT INTO llm_findings (at, run_id, \`trigger\`, severity, point, category, finding, suggestion, recommend_reset, duplicate, whatsapp, prompt_tokens, completion_tokens)
          VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [runId, trigger, sev, point, cat, String(f.finding ?? "").slice(0, 1000), String(f.suggestion ?? "").slice(0, 1000), f.recommend_reset ? 1 : 0, dup ? 1 : 0, wa === null ? null : wa ? 1 : 0, u.prompt_tokens ?? null, u.completion_tokens ?? null]);
        out.push({ severity: sev, point, category: cat, finding: f.finding, suggestion: f.suggestion, recommendReset: Boolean(f.recommend_reset), duplicate: Boolean(dup), whatsapp: wa });
      }
      await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('anomaly_last', ?, 'anomaly') ON DUPLICATE KEY UPDATE v = VALUES(v)",
        [JSON.stringify({ at: new Date().toISOString(), runId, trigger, findings: out.length, tokens: u, frozen: data.sensors.filter((s) => s.frozen).map((s) => s.key), stale: data.sensors.filter((s) => s.stale).map((s) => s.key) })]);
      console.log(`[anomaly] ${trigger}: ${out.length} findings, tokens ${u.prompt_tokens}/${u.completion_tokens}`);
      return { runId, findings: out, tokens: u, frozen: data.sensors.filter((s) => s.frozen).map((s) => `${s.key} ${s.name} = ${s.min}`), stale: data.sensors.filter((s) => s.stale).map((s) => s.key) };
    } finally { running = false; }
  }

  const tick = () => { if (process.env.ANOMALY_DISABLED === "1") return; run("auto").catch((e) => console.error("[anomaly]", e.message)); };
  // first run after start only if the last stored run is older than the interval (restarts don't trigger extra runs)
  setTimeout(async () => {
    try { const [l] = await query("SELECT TIMESTAMPDIFF(SECOND, MAX(at), UTC_TIMESTAMP()) age FROM llm_findings"); if (l?.age != null && Number(l.age) < EVERY_MIN * 60) return; } catch { /* run anyway */ }
    tick();
  }, 90_000).unref(); setInterval(tick, EVERY_MIN * 60_000).unref();

  app.get("/api/myko/anomaly", asyncRoute(async (_req, res) => {
    const rows = await query("SELECT CAST(id AS INT) id, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') at, run_id, `trigger`, severity, point, category, finding, suggestion, recommend_reset, duplicate, whatsapp FROM llm_findings ORDER BY id DESC LIMIT 50");
    const [last] = await query("SELECT v FROM myko_settings WHERE k = 'anomaly_last'");
    const [ig] = await query("SELECT v FROM myko_settings WHERE k = 'anomaly_ignore'");
    res.json({ everyMin: EVERY_MIN, ignore: ig ? (typeof ig.v === "string" ? JSON.parse(ig.v) : ig.v) : [], last: last ? (typeof last.v === "string" ? JSON.parse(last.v) : last.v) : null, findings: rows.map((r) => ({ ...r, id: Number(r.id), recommend_reset: Boolean(r.recommend_reset), duplicate: Boolean(r.duplicate) })) });
  }));
  app.put("/api/myko/anomaly/ignore", asyncRoute(async (req, res) => {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map((k) => String(k).slice(0, 40)).slice(0, 50) : [];
    await query("INSERT INTO myko_settings (k, v, updated_by) VALUES ('anomaly_ignore', ?, 'dashboard') ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(keys)]);
    res.json({ ok: true, keys });
  }));
  app.post("/api/myko/anomaly/run", asyncRoute(async (_req, res) => {
    if (Date.now() - lastRun < 5 * 60_000) return res.status(429).json({ error: "enintään kerran 5 min välein" });
    res.json(await run("manual"));
  }));
}
