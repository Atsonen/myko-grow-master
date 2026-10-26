// Auto-recovery watcher (kunnossapito policy). Every 10 s per PID:
//  symptoms = ErrBits≠0 (>30 s) or PID_LAHTO_JUMISSA active; condition tag 'PLC restart/download' if a restart was seen < 30 min ago.
//  -> kunnossapito match; ONLY a known_fix with autonomy_eligible (times_worked>=1, autonomy_allowed) and preconditions OK
//     (PV 10..35 and updated after the restart, Mode 3, State 3, not manual, data fresh) is proposed.
//  -> Telegram message (Tee / Älä buttons, handled in telegram.js -> POST /api/autorecovery/decision).
//     Tee = execute, Älä = skip + log, no reply in 10 min = execute autonomously. Result always notified.
//  Steps are restricted to Myko's own POST /api/pid/{key}/cmd with {ErrorAck:true} or {Mode:3,ModeActivate:true}; anything else
//  in a known_fix is refused. Max one attempt per PID per 30 min; a failed attempt is not retried until the symptoms clear.
//  AUTORECOVERY_MODE=live|dryrun|off (default live). dryrun: everything except the PID commands (logged as DRY-RUN).
import { randomUUID } from "node:crypto";
import { kpMatch, kpLogIncident, kpUpdateIncident, kpLogAction, kpFixWorked, kpFixFailed, kpOpenIncidentFor, helNow } from "./kunnossapito.js";

export const ASK_MS = 10 * 60_000, DEBOUNCE_MS = 30 * 60_000, VERIFY_MS = 10 * 60_000, RESTART_WINDOW_MS = 30 * 60_000;
export const ERRBITS_HOLD_MS = 30_000, SETTLE_MS = 60_000, PV_MIN = 10, PV_MAX = 35;
const NAMES = { F1: "F1 Kylmiö", T1: "T1 Terrario", G_Air: "G_Air Kasvamo" };
const ALLOWED_BODIES = [JSON.stringify({ ErrorAck: true }), JSON.stringify({ Mode: 3, ModeActivate: true })];
const EP = /^https?:\/\/(localhost|127\.0\.0\.1):3010\/api\/pid\/\{key\}\/cmd$/;
const canon = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** Validate known_fix steps: only Myko PID cmd POSTs with whitelisted bodies (+ wait/check pseudo steps). Returns normalized plan or throws. */
export function planFromSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("known_fix has no steps");
  const plan = [];
  for (const s of steps) {
    if (s.method) {
      if (s.method !== "POST" || !EP.test(String(s.endpoint ?? ""))) throw new Error(`step ${s.n}: endpoint not allowed`);
      const body = canon(s.body);
      const norm = ALLOWED_BODIES.find((b) => canon(JSON.parse(b)) === body);
      if (!norm) throw new Error(`step ${s.n}: body not allowed`);
      plan.push({ kind: "cmd", body: JSON.parse(norm), onlyIfErr: /errbits\s*!=\s*0/i.test(String(s.only_if ?? "")) });
    } else if (s.wait_s != null || s.check) plan.push({ kind: "wait", ms: Math.min(Number(s.wait_s ?? 2), 30) * 1000, check: s.check ?? null });
    else throw new Error(`step ${s.n}: unknown step type`);
  }
  return plan;
}
/** Preconditions for acting on PID k. v = live values, at = last message ms, pvAt = ms of last PV update, restartAt = ms or 0. */
export function checkPreconditions(v, { at, pvAt, restartAt, now = Date.now() }) {
  const r = [];
  if (!v || !at || now - at > 60_000) r.push("ei tuoretta PID-dataa");
  const pv = Number(v?.PV);
  if (!(Number.isFinite(pv) && pv >= PV_MIN && pv <= PV_MAX)) r.push(`PV ${v?.PV} ei välillä ${PV_MIN}–${PV_MAX}`);
  if (Number(v?.Mode) !== 3) r.push(`Mode ${v?.Mode} ≠ 3`);
  if (v?.State !== undefined && Number(v.State) !== 3) r.push(`State ${v.State} ≠ 3`);
  if (v?.ManEn === true) r.push("käsiajo päällä");
  if (restartAt) {
    if (now - restartAt < SETTLE_MS) r.push("PLC-uudelleenkäynnistyksestä < 60 s");
    if (!(pvAt > restartAt)) r.push("PV ei päivittynyt uudelleenkäynnistyksen jälkeen");
  }
  return { ok: !r.length, reasons: r };
}
/** Symptom object for kunnossapito match, or null if nothing wrong. */
export function buildSymptom(k, v, active, { errSince, restartAt, now = Date.now() }) {
  const symptoms = [];
  if (Number(v?.ErrBits ?? 0) !== 0 && errSince && now - errSince >= ERRBITS_HOLD_MS) symptoms.push("ERRORBITS", "ErrBits!=0");
  if (active?.includes?.("PID_LAHTO_JUMISSA")) symptoms.push("PID_LAHTO_JUMISSA", "PID output frozen");
  if (!symptoms.length) return null;
  const conditions = restartAt && now - restartAt < RESTART_WINDOW_MS ? ["PLC restart/download"] : [];
  return { system: "PLC_2", device: k, conditions, symptoms };
}
const n1 = (x) => (x == null || !Number.isFinite(Number(x)) ? "?" : Number(x).toFixed(2));
const hhmm = (ms) => new Date(ms).toLocaleTimeString("fi-FI", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit" });
export function formatProposal({ k, v, sym, fix, deadline, test = false, dry = false }) {
  const steps = planFromSteps(fix.steps).filter((s) => s.kind === "cmd").map((s, i) => `${i + 1}. POST /api/pid/${k}/cmd ${JSON.stringify(s.body)}${s.onlyIfErr ? " (vain jos ErrBits≠0)" : ""}`);
  return `${test ? "🧪 TESTI – ei oikea toimenpide, ei PLC-kirjoituksia\n" : ""}${dry ? "[DRY-RUN] " : ""}🔧 Automaattinen korjausehdotus: ${NAMES[k] ?? k}\n` +
    `Oire: ${sym.symptoms.filter((s) => /^[A-Z_]+$/.test(s)).join(", ")}${sym.conditions.length ? ` · ${sym.conditions.join(", ")}` : ""}\n` +
    `Nyt: PV ${n1(v.PV)} °C, SP ${n1(v.CSP ?? v.SP)}, lähtö ${n1(v.OutSum)} %, ErrBits ${v.ErrBits ?? "?"}, Mode ${v.Mode}, State ${v.State}\n` +
    `Tunnettu korjaus #${fix.fix_id ?? fix.id} "${fix.name}" (toiminut ${fix.times_worked}×):\n${steps.join("\n")}\n` +
    `Tarkistus: ErrBits 0 ja lähtö liikkuu 10 min kuluessa.\n` +
    `Tee = suorita nyt · Älä = ohita. Jos et vastaa, suoritan automaattisesti klo ${hhmm(deadline)}.`;
}
export const proposalButtons = (id) => ({ inline_keyboard: [[{ text: "✅ Tee", callback_data: `kp:${id}:do` }, { text: "⛔ Älä", callback_data: `kp:${id}:skip` }]] });

export function registerAutoRecovery(app, { pidState, pidActive, pidRestartAt, pidPvAt, PID_POINTS, asyncRoute, notify, port = 3010 }) {
  const mode = () => (process.env.AUTORECOVERY_MODE || "live").toLowerCase();
  const errSince = {}, lastAttempt = {}, failedLock = {}, pending = new Map(); // id -> proposal
  const busy = {};
  const noAct = {}; // k -> last logged "did nothing" reason (logged once per change per symptom episode)
  const pidPoints = (k) => [`${k}_PID`, PID_POINTS[k]];
  const logNoAction = async (k, reason, detail) => {
    const key = reason.replace(/-?\d+(\.\d+)?/g, "#"); if (noAct[k] === key) return; noAct[k] = key;
    const incident_id = await kpOpenIncidentFor(pidPoints(k)).catch(() => null);
    await kpLogAction({ incident_id, actor: "myko-autorecovery", action: `No action: ${reason}`, result: detail ? String(detail).slice(0, 1500) : null, worked: null }).catch(() => undefined);
  };
  const sendCmd = async (k, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/pid/${k}/cmd`, { method: "POST", headers: { "Content-Type": "application/json", "x-myko-actor": "myko-autorecovery" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const b = await r.json().catch(() => ({})); return { ok: r.ok && !b.error, body: b };
  };
  const say = (text, markup) => notify(text, markup).catch((e) => { console.error("[autorecovery] telegram", e.message); return []; });

  async function tick() {
    if (mode() === "off") return;
    const now = Date.now();
    for (const k of Object.keys(PID_POINTS)) {
      const s = pidState(k); const v = s?.values ?? {};
      if (Number(v.ErrBits ?? 0) !== 0) errSince[k] ??= now; else delete errSince[k];
      const restartAt = pidRestartAt(k) ?? 0;
      const sym = s ? buildSymptom(k, v, pidActive(k), { errSince: errSince[k], restartAt, now }) : null;
      if (!sym) { delete failedLock[k]; delete noAct[k]; continue; }
      if (failedLock[k] && !busy[k]) { await logNoAction(k, "failed attempt lock (previous fix failed, no retry until symptoms clear)", sym.symptoms.join(", ")); continue; }
      if (busy[k] || failedLock[k] || [...pending.values()].some((p) => p.k === k) || now - (lastAttempt[k] ?? 0) < DEBOUNCE_MS) continue;
      const pre = checkPreconditions(v, { at: s.at, pvAt: pidPvAt(k), restartAt: restartAt && now - restartAt < RESTART_WINDOW_MS ? restartAt : 0, now });
      if (!pre.ok) { await logNoAction(k, `preconditions not met: ${pre.reasons.join("; ")}`, JSON.stringify({ sym, PV: v.PV, Mode: v.Mode, State: v.State, ManEn: v.ManEn })); continue; } // e.g. PV still invalid right after a restart: wait
      const matches = await kpMatch(sym).catch((e) => { console.error("[autorecovery] match", e.message); return []; });
      const fix = matches.find((f) => f.autonomy_eligible);
      if (!fix) { await logNoAction(k, matches.length ? "no autonomy-eligible known fix (matches need approval / times_worked<1)" : "no matching known fix",
        JSON.stringify({ sym, matches: matches.map((m) => ({ fix_id: m.fix_id, name: m.name, times_worked: m.times_worked, eligible: m.autonomy_eligible })) })); continue; } // policy: never act without an eligible known fix
      try { planFromSteps(fix.steps); } catch (e) { console.error(`[autorecovery] fix #${fix.fix_id} refused: ${e.message}`); lastAttempt[k] = now; continue; }
      lastAttempt[k] = now;
      const id = randomUUID().slice(0, 8), deadline = now + ASK_MS, dry = mode() === "dryrun";
      const autoInc = await kpOpenIncidentFor(pidPoints(k)).catch(() => null);
      const inc = autoInc ? { id: autoInc } : await kpLogIncident({ system: "PLC_2", device: k, symptom: `Auto-detected: ${sym.symptoms.join(", ")}; PV ${v.PV}, SP ${v.CSP ?? v.SP}, OutSum ${v.OutSum}, ErrBits ${v.ErrBits}`,
        conditions: [...sym.conditions, ...sym.symptoms], status: "open" }).catch(() => ({ id: null }));
      const p = { id, k, fix, sym, incidentId: inc.id, ownIncident: !autoInc, createdAt: now, deadline, dry, status: "asked" };
      pending.set(id, p);
      await kpLogAction({ incident_id: inc.id, actor: "myko-autorecovery", action: `Proposed known_fix #${fix.fix_id} via Telegram (deadline ${hhmm(deadline)})`, known_fix_id: fix.fix_id, params: sym }).catch(() => undefined);
      await say(formatProposal({ k, v, sym, fix, deadline, dry }), proposalButtons(id));
      console.log(`[autorecovery] ${k} proposal ${id} fix #${fix.fix_id} (${mode()})`);
    }
    for (const p of pending.values()) if (p.status === "asked" && now >= p.deadline) { p.status = "running";
      kpLogAction({ incident_id: p.incidentId, actor: "myko-autorecovery", action: `No Telegram reply within ${ASK_MS / 60_000} min -> executing known_fix #${p.fix.fix_id} autonomously`, approved_by: "autonomous (timeout)", known_fix_id: p.fix.fix_id }).catch(() => undefined); execute(p, "autonomous (no reply 10 min)").catch((e) => console.error("[autorecovery] exec", e.message)); }
  }

  async function execute(p, approvedBy) {
    const { k, fix } = p; busy[k] = true;
    try {
      const s = pidState(k); const v = s?.values ?? {};
      const rs = pidRestartAt(k) ?? 0;
      const pre = checkPreconditions(v, { at: s?.at, pvAt: pidPvAt(k), restartAt: rs && Date.now() - rs < RESTART_WINDOW_MS ? rs : 0 });
      if (!pre.ok) {
        await kpLogAction({ incident_id: p.incidentId, actor: "myko-autorecovery", action: "Aborted: preconditions not met", result: pre.reasons.join("; "), worked: 0, known_fix_id: fix.fix_id, approved_by: approvedBy });
        failedLock[k] = true; await say(`⚠️ ${NAMES[k]}: korjausta EI tehty – esiehdot eivät täyty (${pre.reasons.join("; ")}). Ei uusintayritystä.`); return;
      }
      const out0 = v.OutSum;
      for (const st of planFromSteps(fix.steps)) {
        if (st.kind === "wait") { await new Promise((r) => setTimeout(r, p.dry ? 10 : st.ms)); continue; }
        if (st.onlyIfErr && Number(pidState(k)?.values?.ErrBits ?? 0) === 0) continue;
        const r = p.dry ? { ok: true, body: { dryRun: true } } : await sendCmd(k, st.body);
        await kpLogAction({ incident_id: p.incidentId, actor: "myko-autorecovery", action: `${p.dry ? "DRY-RUN " : ""}POST /api/pid/${k}/cmd`, nodes: `/api/pid/${k}/cmd`, params: st.body,
          approved_by: approvedBy, result: JSON.stringify(r.body).slice(0, 500), worked: null, known_fix_id: fix.fix_id });
        if (!r.ok) { failedLock[k] = true; await kpFixFailed(fix.fix_id).catch(() => undefined); await say(`❌ ${NAMES[k]}: komento ${JSON.stringify(st.body)} epäonnistui: ${JSON.stringify(r.body).slice(0, 150)}. Ei uusintayritystä.`); await kpUpdateIncident(p.incidentId, { resolution: "auto-recovery command failed" }); return; }
      }
      if (p.dry) { await say(`[DRY-RUN] ${NAMES[k]}: korjaus #${fix.fix_id} simuloitu (${approvedBy}); PID-komentoja ei lähetetty.`); return; }
      await say(`▶️ ${NAMES[k]}: korjaus #${fix.fix_id} suoritettu (${approvedBy}). Tarkistan 10 min ajan…`);
      const t0 = Date.now(); let ok = false, last = {};
      while (Date.now() - t0 < VERIFY_MS) {
        await new Promise((r) => setTimeout(r, 15_000));
        last = pidState(k)?.values ?? {};
        if (Number(last.ErrBits ?? 0) === 0 && Number.isFinite(Number(last.OutSum)) && !Object.is(last.OutSum, out0) && !pidActive(k).includes("PID_LAHTO_JUMISSA")) { ok = true; break; }
      }
      const res = `ErrBits ${last.ErrBits}, OutSum ${out0}→${last.OutSum}, PV ${last.PV} after ${Math.round((Date.now() - t0) / 1000)} s`;
      await kpLogAction({ incident_id: p.incidentId, actor: "myko-autorecovery", action: `Verification of known_fix #${fix.fix_id}`, approved_by: approvedBy, result: res, worked: ok, known_fix_id: fix.fix_id });
      if (ok) { await kpFixWorked(fix.fix_id); await kpUpdateIncident(p.incidentId, { ...(p.ownIncident ? { ts_end: helNow() } : {}), status: "resolved", resolved_by: "auto_recovery", resolution: `Auto-recovery known_fix #${fix.fix_id} (${approvedBy}): ${res}` }); }
      else { failedLock[k] = true; await kpFixFailed(fix.fix_id).catch(() => undefined); await kpUpdateIncident(p.incidentId, { resolution: `Auto-recovery known_fix #${fix.fix_id} did NOT verify: ${res}` }); }
      await say(ok ? `✅ ${NAMES[k]} palautui: ${res}.` : `❌ ${NAMES[k]}: korjaus ei auttanut 10 min kuluessa (${res}). Ei uusintayritystä – tarkista käsin.`);
    } finally { busy[k] = false; p.status = "done"; pending.delete(p.id); lastAttempt[k] = Date.now(); }
  }

  app.post("/api/autorecovery/decision", asyncRoute(async (req, res) => {
    const ip = req.socket.remoteAddress ?? ""; if (!/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(ip)) return res.status(403).json({ error: "local only" });
    const { id, decision, by } = req.body ?? {};
    if (String(id).startsWith("TEST")) return res.json({ ok: true, text: `TESTI: '${decision}' vastaanotettu – ei toimenpiteitä` });
    const p = pending.get(String(id));
    if (!p || p.status !== "asked") return res.status(404).json({ error: "ehdotus ei ole enää voimassa" });
    if (decision === "skip") {
      p.status = "done"; pending.delete(p.id);
      await kpLogAction({ incident_id: p.incidentId, actor: "myko-autorecovery", action: `User declined known_fix #${p.fix.fix_id}`, approved_by: by ?? "telegram", result: "skipped", worked: null, known_fix_id: p.fix.fix_id }).catch(() => undefined);
      return res.json({ ok: true, text: "Ohitettu – ei toimenpiteitä" });
    }
    if (decision !== "do") return res.status(400).json({ error: "decision do|skip" });
    await kpLogAction({ incident_id: p.incidentId, actor: "myko-autorecovery", action: `User approved known_fix #${p.fix.fix_id} via Telegram`, approved_by: by ?? "telegram", known_fix_id: p.fix.fix_id }).catch(() => undefined);
    p.status = "running"; execute(p, `telegram (${by ?? "?"})`).catch((e) => console.error("[autorecovery] exec", e.message));
    res.json({ ok: true, text: "Suoritetaan…" });
  }));
  app.get("/api/autorecovery", (req, res) => res.json({ mode: mode(), pending: [...pending.values()].map(({ id, k, status, deadline, fix }) => ({ id, k, status, deadline: new Date(deadline).toISOString(), fix: fix.fix_id })),
    lastAttempt: Object.fromEntries(Object.entries(lastAttempt).map(([k, t]) => [k, new Date(t).toISOString()])), failedLock }));
  setTimeout(() => setInterval(() => tick().catch((e) => console.error("[autorecovery]", e.message)), 10_000).unref(), 30_000).unref();
  return { tick, pending, mode };
}
