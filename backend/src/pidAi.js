// DeepSeek PID tuning advisor + user-approved one-click apply of PID_Temp parameters.
// - Key: DEEPSEEK_API_KEY from env or /home/atte/.config/myko/deepseek.env (never from backend/.env, never logged).
// - Params are read/written by deploy/opcua-bridge/read_pid_params.py (one-shot OPC UA session, Read service only;
//   writes go CtrlParamsBackUp + LoadBackUp as Siemens requires in Automatic mode, then read back).
// - Analysis never writes. Writes happen only from POST .../ai-apply or .../ai-restore (user button + confirm).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const KEY_FILE = process.env.DEEPSEEK_KEY_FILE || "/home/atte/.config/myko/deepseek.env";
const PY = "/home/atte/opcua-bridge/venv/bin/python";
const SCRIPT = "/home/atte/opcua-bridge/read_pid_params.py";
const INSTANCE = { F1: "PID_Temp_F1", T1: "Terrarium_1_Temp", G_Air: "G_Air" };
const CONTEXT = {
  F1: "F1 = kylmäsäilytystila 1 (jääkaappi/kylmiö). Lämmitys on pieni vastus, jäähdytys kompressori (vähintään 30 s käynti- ja taukojaksot). SP noin 8 °C.",
  T1: "T1 = terrario 1. Lämmitys lämpölamppu/vastus, jäähdytys kompressori (vähintään 30 s jaksot). SP noin 24 °C.",
  G_Air: "G_Air = kasvamon ilma, ohjataan poistopuhallin PF-1:llä (jäähdytys = puhallin, 10–100 %). Lämmitys ei käytössä käytännössä. SP noin 26–30 °C.",
};
const COMMON = "Siemens S7-1215C, PID_Temp, syklinen OB 100 ms. Warning 16#0020 on päällä jatkuvasti (tiedossa). Ulkolämpötila met.no. Ajat UTC.";
// Members the user may apply (Cycle and ControlZone are excluded on purpose). [min, max]
export const APPLY_LIMITS = { Gain: [0.01, 1000], Ti: [0, 10000], Td: [0, 1000], TdFiltRatio: [0, 1], PWeighting: [0, 1], DWeighting: [0, 1], DeadZone: [0, 5], Cycle: [0.1, 600] };
const MAX_REL = 0.5, RATE_MIN = 10;

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return readFileSync(KEY_FILE, "utf8").match(/^DEEPSEEK_API_KEY=(.+)$/m)?.[1].trim() ?? null; } catch { return null; }
}
function py(args, timeoutMs = 150_000) {
  return new Promise((resolve, reject) => execFile(PY, [SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, out, errOut) => {
    if (err) return reject(new Error((errOut || err.message).split("\n").filter((l) => !/session timeout/.test(l)).join(" ").slice(0, 300)));
    try { resolve(JSON.parse(out)); } catch { reject(new Error("bad script output")); }
  }));
}
// Serialize OPC UA one-shot sessions (S7-1200 session/monitored-item limits).
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const paramCache = {};
async function readParams(key, maxAgeMs = 5 * 60_000) {
  const c = paramCache[key];
  if (c && Date.now() - c.at < maxAgeMs) return c.params;
  const raw = await serial(() => py([INSTANCE[key]]));
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = k.match(/^Retain\/CtrlParams\/(Heat|Cool)\/(\w+)$/);
    if (m) params[`${m[1]}.${m[2]}`] = v;
    else if (/^Config\/Output\/(Heat|Cool)\/(PidUpperLimit|PidLowerLimit|MinimumOnTime|MinimumOffTime|PwmPeriode|Select)$/.test(k) || /^Config\/(ActivateCooling|AdvancedCooling|CoolFactor|InputUpperLimit|InputLowerLimit)$/.test(k))
      params[k.replace(/^Config\//, "Config.").replace(/\//g, ".")] = v;
    else if (k === "Retain/CtrlParams/SetByUser") params["SetByUser"] = v;
  }
  for (const k of Object.keys(params)) if (typeof params[k] === "number" && Math.abs(params[k]) > 1e37) params[k] = params[k] > 0 ? "MAX" : "-MAX";
  paramCache[key] = { at: Date.now(), params };
  return params;
}

export function registerPidAi(app, { query, asyncRoute, pidState, PID_POINTS }) {
  const jobs = new Map(); let jobSeq = 0;
  const startJob = (fn) => {
    const id = `${Date.now().toString(36)}-${++jobSeq}`;
    const job = { id, status: "running", started: new Date().toISOString() };
    jobs.set(id, job);
    fn().then((r) => Object.assign(job, { status: "done", result: r }), (e) => Object.assign(job, { status: "error", error: e.message }));
    setTimeout(() => jobs.delete(id), 3_600_000).unref();
    return job;
  };
  const busy = {};
  const lockPid = async (key, fn) => {
    if (busy[key]) throw new Error("toinen AI-toiminto on käynnissä tälle PID:lle");
    busy[key] = true;
    try { return await fn(); } finally { busy[key] = false; }
  };
  const logEvent = (key, text) => query(
    "INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, NULL, 'control', UTC_TIMESTAMP(3), NULL, NULL)",
    [PID_POINTS[key], text.slice(0, 255)]).catch((e) => console.error("[pid-ai] event", e.message));

  async function analyze(key, trigger, wishes = null) {
    const k = apiKey();
    if (!k) throw new Error("DEEPSEEK_API_KEY puuttuu");
    const params = await readParams(key, 60_000);
    const rows = await query(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(at)/300)*300), '%H:%i') t, ROUND(AVG(sp),2) sp, ROUND(AVG(pv),2) pv,
              ROUND(MIN(pv),2) pvmin, ROUND(MAX(pv),2) pvmax, ROUND(AVG(out_heat),1) h, ROUND(AVG(out_cool),1) c, MAX(state) st, ROUND(AVG(outdoor_temp),1) ou
       FROM pid_training_log WHERE pid_key = ? AND at > UTC_TIMESTAMP() - INTERVAL 24 HOUR GROUP BY FLOOR(UNIX_TIMESTAMP(at)/300) ORDER BY 1`, [key]);
    const s = pidState(key)?.values ?? {};
    const csv = ["t_utc,sp,pv,pv_min,pv_max,heat%,cool%,state,outdoor"].concat(rows.map((r) => [r.t, r.sp, r.pv, r.pvmin, r.pvmax, r.h, r.c, r.st, r.ou].join(","))).join("\n");
    const now = { SP: s.SP, PV: s.PV, State: s.State, Mode: s.Mode, ErrBits: s.ErrBits, Warn: s.Warn, OutHeat: s.OutHeat, OutCool: s.OutCool };
    const sys = `Olet kokenut säätöteknikko (Siemens PID_Temp). Analysoi säätöpiirin toiminta ja ehdota tarvittaessa parempia PID-parametreja. Vastaa VAIN JSON-objektina suomeksi:
{"assessment": "1–3 lausetta", "issues": ["..."], "proposed_params": {"Heat.Gain": 1.2}, "rationale": "...", "risk": "low|medium|high", "confidence": 0.0-1.0}
Säännöt: proposed_params vain jos muutos on perusteltu; muuten {}. Sallitut avaimet: ${Object.keys(APPLY_LIMITS).flatMap((m) => [`Heat.${m}`, `Cool.${m}`]).join(", ")}. Ti ja Td sekunteina. Muutos enintään ±50 % nykyarvosta. Huomioi kompressorin minimijaksot ja että turvallisuus > nopeus.`;
    const user = `${COMMON}\n${CONTEXT[key]}\nNykyiset parametrit (Retain.CtrlParams + Config): ${JSON.stringify(params)}\nNykytila: ${JSON.stringify(now)}\nViimeiset 24 h, 5 min keskiarvot (state 3 = auto, 1/2 = viritys, 4 = käsi):\n${csv}${wishes ? `\n\nKäyttäjän omat toiveet (huomioi, mutta turvallisuus- ja muutosrajat ovat silti voimassa): ${wishes}` : ""}`;
    const t0 = Date.now();
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "system", content: sys }, { role: "user", content: user }], response_format: { type: "json_object" }, max_tokens: 1500, temperature: 0.2 }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}: ${JSON.stringify(b).slice(0, 200)}`);
    let resp; try { resp = JSON.parse(b.choices?.[0]?.message?.content ?? ""); } catch { throw new Error("DeepSeek: vastaus ei ollut JSONia"); }
    // keep only allowed, numeric, in-range proposals; drop the rest with a note
    const prop = {}, dropped = [];
    for (const [n, v] of Object.entries(resp.proposed_params ?? {})) {
      const m = n.match(/^(Heat|Cool)\.(\w+)$/), lim = m && APPLY_LIMITS[m[2]];
      if (lim && typeof v === "number" && v >= lim[0] && v <= lim[1]) prop[n] = v; else dropped.push(n);
    }
    resp.proposed_params = prop; if (dropped.length) resp.dropped_params = dropped;
    const u = b.usage ?? {};
    const res = await query(
      `INSERT INTO pid_ai_analysis (at, pid_key, \`trigger\`, model, params_json, input_summary, response_json, prompt_tokens, completion_tokens, duration_ms, status, user_wishes)
       VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, trigger, b.model ?? "deepseek-chat", JSON.stringify(params), JSON.stringify({ now, rows: rows.length, from: rows[0]?.t, to: rows.at(-1)?.t }),
       JSON.stringify(resp), u.prompt_tokens ?? null, u.completion_tokens ?? null, Date.now() - t0, Object.keys(prop).length ? "new" : "noop", wishes]);
    console.log(`[pid-ai] ${key} ${trigger}: ${Object.keys(prop).length} proposals, tokens ${u.prompt_tokens}/${u.completion_tokens}`);
    return { id: Number(res.insertId) };
  }

  // Validate + snapshot + write (CtrlParamsBackUp/LoadBackUp) + read back. values: {"Heat.Gain": 1.2}
  async function applyParams(key, values, { by, reason, analysisId, confirmLarge, isRestore, manual }) {
    const s = pidState(key);
    const v = s?.values ?? {};
    if (!s || Date.now() - s.at > 60_000) throw new Error("PID-tila ei ole tuore (ei voi tarkistaa State/ErrorBits)");
    if (v.State === 1 || v.State === 2) throw new Error("PID on virityksessä (State 1/2), kirjoitus estetty");
    if (Number(v.ErrBits ?? 0) !== 0) throw new Error(`PID:llä on ErrorBits ${Number(v.ErrBits).toString(16)}, kuittaa ensin`);
    const cur = await readParams(key, 0);
    const req = {}, problems = [];
    for (const [n, val] of Object.entries(values)) {
      const m = n.match(/^(Heat|Cool)\.(\w+)$/), lim = m && APPLY_LIMITS[m[2]];
      if (!lim) { problems.push(`${n}: ei sallittu`); continue; }
      if (typeof val !== "number" || !Number.isFinite(val) || val < lim[0] || val > lim[1]) { problems.push(`${n}: ${val} rajojen ${lim[0]}–${lim[1]} ulkopuolella`); continue; }
      const c = Number(cur[n]);
      const rel = c === 0 ? (val === 0 ? 0 : Infinity) : Math.abs(val - c) / Math.abs(c);
      if (rel > MAX_REL && !confirmLarge && !isRestore) { problems.push(`${n}: muutos ${c}→${val} yli ±50 % (vaatii erillisen vahvistuksen)`); continue; }
      req[`${m[1]}/${m[2]}`] = val;
    }
    if (problems.length) { const e = new Error(problems.join("; ")); e.code = 400; throw e; }
    if (!Object.keys(req).length) throw new Error("ei muutettavia parametreja");
    const snap = Object.fromEntries(Object.entries(cur).filter(([n]) => /^(Heat|Cool)\./.test(n)));
    const ins = await query("INSERT INTO pid_param_history (at, pid_key, kind, by_user, reason, analysis_id, params_json) VALUES (UTC_TIMESTAMP(), ?, 'snapshot', ?, ?, ?, ?)",
      [key, by, reason, analysisId ?? null, JSON.stringify(snap)]);
    const out = await serial(() => py([INSTANCE[key], "--write", JSON.stringify(req)], 90_000));
    delete paramCache[key];
    const results = Object.fromEntries(Object.entries(out.results).map(([k, r]) => [k.replace("/", "."), r]));
    const allOk = Object.values(results).every((r) => r.ok) && out.othersUnchanged;
    await query("INSERT INTO pid_param_history (at, pid_key, kind, by_user, reason, analysis_id, params_json, result_json) VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?)",
      [key, isRestore ? "restore" : "apply", by, reason, analysisId ?? null, JSON.stringify(values), JSON.stringify({ results, loadBackUpCleared: out.loadBackUpCleared, othersUnchanged: out.othersUnchanged })]);
    if (analysisId && !isRestore) await query("UPDATE pid_ai_analysis SET status = ? WHERE id = ? AND pid_key = ?", [allOk ? "applied" : "apply_failed", analysisId, key]);
    const txt = Object.entries(results).map(([n, r]) => `${n} ${r.before}→${r.read}${r.ok ? "" : " VIRHE"}`).join(", ");
    await logEvent(key, `${isRestore ? "PID-param. palautettu" : manual ? "PID-param. muutettu käsin" : "AI-param. otettu käyttöön"} (${by}): ${txt}`);
    return { ok: allOk, results, snapshotId: Number(ins.insertId), loadBackUpCleared: out.loadBackUpCleared, othersUnchanged: out.othersUnchanged };
  }

  const keyOk = (req, res) => { if (!INSTANCE[req.params.key]) { res.status(404).json({ error: "Unknown PID" }); return false; } return true; };
  const lastManual = {};
  app.post("/api/pid/:key/ai-analyze", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    const key = req.params.key;
    const [last] = await query("SELECT TIMESTAMPDIFF(SECOND, at, UTC_TIMESTAMP()) age FROM pid_ai_analysis WHERE pid_key = ? AND `trigger` = 'manual' ORDER BY id DESC LIMIT 1", [key]);
    const age = Math.min(last ? Number(last.age) : Infinity, (Date.now() - (lastManual[key] ?? 0)) / 1000);
    if (age < RATE_MIN * 60) return res.status(429).json({ error: `Analyysi enintään kerran ${RATE_MIN} min välein (seuraava ${Math.ceil((RATE_MIN * 60 - age) / 60)} min kuluttua)` });
    lastManual[key] = Date.now();
    const wishes = String(req.body?.wishes ?? "").trim().slice(0, 1000) || null;
    res.status(202).json(startJob(() => lockPid(key, () => analyze(key, "manual", wishes))));
  }));
  app.get("/api/pid/:key/ai-job/:id", asyncRoute(async (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: "job not found" });
    res.json(j);
  }));
  app.get("/api/pid/:key/ai-analysis", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    const key = req.params.key;
    const rows = await query(
      `SELECT id, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') at, \`trigger\`, model, params_json, response_json, prompt_tokens, completion_tokens, status, user_wishes
       FROM pid_ai_analysis WHERE pid_key = ? ORDER BY id DESC LIMIT 20`, [key]);
    const hist = await query(
      `SELECT CAST(id AS INT) id, DATE_FORMAT(at, "%Y-%m-%dT%H:%i:%sZ") at, kind, by_user, reason, params_json, result_json FROM pid_param_history WHERE pid_key = ? ORDER BY id DESC LIMIT 10`, [key]);
    const parse = (x) => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } };
    const analyses = rows.map((r) => ({ id: Number(r.id), at: r.at, trigger: r.trigger, model: r.model, status: r.status, tokens: { prompt: r.prompt_tokens, completion: r.completion_tokens }, params: parse(r.params_json), response: parse(r.response_json), wishes: r.user_wishes ?? null }));
    const latest = analyses[0];
    res.json({
      key, analyses, history: hist.map((h) => ({ ...h, id: Number(h.id), params: parse(h.params_json), result: parse(h.result_json), params_json: undefined, result_json: undefined })),
      hasNew: Boolean(latest && latest.status === "new" && Date.now() - Date.parse(latest.at) < 48 * 3600_000),
      canRestore: hist.some((h) => h.kind === "snapshot"), limits: APPLY_LIMITS, maxRelChange: MAX_REL, rateMin: RATE_MIN,
    });
  }));
  app.post("/api/pid/:key/ai-seen", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    await query("UPDATE pid_ai_analysis SET status = 'seen' WHERE pid_key = ? AND status = 'new'", [req.params.key]);
    res.json({ ok: true });
  }));
  // body: { analysisId, params: {"Heat.Gain": 1.2}, confirmLarge?: bool, user?: string }
  app.post("/api/pid/:key/ai-apply", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    const key = req.params.key, b = req.body ?? {};
    if (!b.params || typeof b.params !== "object") return res.status(400).json({ error: "params puuttuu" });
    const by = String(b.user || "dashboard").slice(0, 40);
    res.status(202).json(startJob(() => lockPid(key, () => applyParams(key, b.params, { by, reason: `AI-analyysi #${b.analysisId ?? "?"}`, analysisId: b.analysisId, confirmLarge: b.confirmLarge === true }))));
  }));
  // Manual edit from the Parametrit tab: same validated snapshot/write/read-back path. body: { params, confirmLarge?, user? }
  app.post("/api/pid/:key/params-apply", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    const key = req.params.key, b = req.body ?? {};
    if (!b.params || typeof b.params !== "object" || !Object.keys(b.params).length) return res.status(400).json({ error: "params puuttuu" });
    const by = String(b.user || "dashboard").slice(0, 40);
    res.status(202).json(startJob(() => lockPid(key, () => applyParams(key, b.params, { by, reason: "käsin (Parametrit-välilehti)", confirmLarge: b.confirmLarge === true, manual: true }))));
  }));
  app.get("/api/pid/:key/params", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    res.json({ params: await readParams(req.params.key, req.query.fresh ? 0 : 5 * 60_000), limits: APPLY_LIMITS, maxRelChange: MAX_REL });
  }));
  app.post("/api/pid/:key/ai-restore", asyncRoute(async (req, res) => {
    if (!keyOk(req, res)) return;
    const key = req.params.key, by = String(req.body?.user || "dashboard").slice(0, 40);
    const [snap] = await query("SELECT id, params_json FROM pid_param_history WHERE pid_key = ? AND kind = 'snapshot' ORDER BY id DESC LIMIT 1", [key]);
    if (!snap) return res.status(404).json({ error: "ei tallennettua tilannekuvaa" });
    const p = typeof snap.params_json === "string" ? JSON.parse(snap.params_json) : snap.params_json;
    const vals = Object.fromEntries(Object.entries(p).filter(([n, v]) => typeof v === "number" && APPLY_LIMITS[n.split(".")[1]]));
    res.status(202).json(startJob(() => lockPid(key, () => applyParams(key, vals, { by, reason: `palautus tilannekuvasta #${snap.id}`, isRestore: true }))));
  }));

  // Nightly 03:00 Europe/Helsinki: analyse all PIDs (results only stored, never applied).
  let nightlyDone = "";
  setInterval(async () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    const day = `${p.year}-${p.month}-${p.day}`;
    if (p.hour !== "03" || nightlyDone === day) return;
    nightlyDone = day;
    for (const key of Object.keys(INSTANCE)) await lockPid(key, () => analyze(key, "nightly")).catch((e) => console.error("[pid-ai] nightly", key, e.message));
  }, 60_000).unref();
}
