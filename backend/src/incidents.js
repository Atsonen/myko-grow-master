// Automatic kunnossapito incidents from Myko alarms (state-based, every 15 s):
//  alarm_points.last_active is the truth. A tracked alarm that is active with no open auto-incident -> open one
//  (or re-open the same one if it cleared < FLAP_MS ago = same episode). An open auto-incident whose alarm is no longer
//  active -> close it (ts_end, duration, context_close, resolved_by cleared | manual_action | auto_recovery).
//  Each incident gets a rich JSON context snapshot (PID values, 30 min trend, restart/connectivity, last command,
//  outdoor temp, other active alarms) and a normalized conditions signature for matching known fixes.
//  Read-only towards the PLC: nothing here sends commands.
import { kq, helNow } from "./kunnossapito.js";

export const TRACKED_ALARMS = new Set(["PID_VIKA", "PID_LAHTO_JUMISSA", "ERRORBITS", "SENSOR_VIKA", "INPUT_STALE", "FREEZE", "SATUROITUNUT",
  "ANTURIVIKA_ALASAJO", "EI_AUTO", "OPCUA", "LAHTO_NAN"]);
const FLAP_MS = 2 * 60_000, TICK_MS = 15_000, MANUAL_WINDOW_S = 30 * 60, POST_RESTART_MS = 30 * 60_000;
const r2 = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100) / 100);
const parse = (x, d = null) => { if (x == null) return d; if (typeof x === "object") return x; try { return JSON.parse(x); } catch { return d; } };
const utcToHel = (s) => helNow(new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z")));

function trendSummary(samples, minutes, now) {
  const a = samples.filter((s) => s.t >= now - minutes * 60_000);
  if (!a.length) return { minutes, n: 0 };
  const f = (key) => {
    const v = a.map((s) => Number(s[key])).filter(Number.isFinite);
    if (!v.length) return null;
    const dtMin = (a[a.length - 1].t - a[0].t) / 60_000;
    return { first: r2(v[0]), last: r2(v[v.length - 1]), min: r2(Math.min(...v)), max: r2(Math.max(...v)),
      slope_per_min: dtMin > 0 ? r2((v[v.length - 1] - v[0]) / dtMin) : null, constant: Math.min(...v) === Math.max(...v) };
  };
  return { minutes, n: a.length, pv: f("pv"), sp: f("sp"), out: f("out") };
}

export function registerIncidents({ query, PID_POINTS, PID_BY_POINT, pidState, pidActive, pidRestartAt, pidPvAt, pidTrend, pidIntent, mqttConnected, autoRecoveryMode }) {
  const startedAt = Date.now();
  const pidKeyOf = (pointId) => /^(\w+)_PID$/.exec(pointId)?.[1] ?? PID_BY_POINT[pointId] ?? null;

  async function snapshot(pointId, alarm, pts) {
    const now = Date.now();
    pts ??= await query("SELECT id, name, last_active, last_payload, last_message_at FROM alarm_points");
    const pt = pts.find((p) => p.id === pointId);
    const k = pidKeyOf(pointId);
    const ctx = { at: helNow(), point: { id: pointId, name: pt?.name ?? null, alarm,
      last_message_age_s: pt?.last_message_at ? Math.round((now - Date.parse(String(pt.last_message_at).replace(" ", "T") + "Z")) / 1000) : null,
      last_payload: parse(pt?.last_payload) } };
    if (k) {
      const s = pidState(k), v = s?.values ?? {}, rs = pidRestartAt(k) || 0, it = pidIntent?.(k) ?? null, tr = pidTrend?.(k) ?? [];
      ctx.pid = { key: k, data_age_s: s ? Math.round((now - s.at) / 1000) : null, values: v,
        active_alarms: pidActive(k),
        trend_30min: trendSummary(tr, 30, now), trend_6h: trendSummary(tr, 360, now),
        last_restart_detected: rs ? helNow(new Date(rs)) : null, restart_age_s: rs ? Math.round((now - rs) / 1000) : null,
        post_restart: Boolean(rs && now - rs < POST_RESTART_MS),
        pv_age_s: pidPvAt(k) ? Math.round((now - pidPvAt(k)) / 1000) : null,
        last_command_age_s: it?.cmdAt ? Math.round((now - it.cmdAt) / 1000) : null, intent: it };
    }
    ctx.connectivity = { mqtt_connected: mqttConnected?.() ?? null,
      pids: Object.fromEntries(Object.keys(PID_POINTS).map((kk) => { const s = pidState(kk); return [kk, { data_age_s: s ? Math.round((now - s.at) / 1000) : null, opcua_alarm: pidActive(kk).includes("OPCUA"), state: s?.values?.State ?? null, errbits: s?.values?.ErrBits ?? null }]; })) };
    ctx.backend_uptime_s = Math.round((now - startedAt) / 1000);
    ctx.autorecovery_mode = autoRecoveryMode?.() ?? null;
    try {
      const [o] = await query("SELECT obs_time, t2m, rh, ws FROM fmi_weather_obs WHERE t2m IS NOT NULL ORDER BY obs_time DESC LIMIT 1");
      if (o) ctx.outdoor = { obs_time_utc: o.obs_time, t2m: r2(o.t2m), rh: r2(o.rh), ws: r2(o.ws) };
    } catch { /* optional */ }
    ctx.other_active_alarms = pts.flatMap((p) => (parse(p.last_active, []) ?? []).map((a) => `${p.id}:${a}`)).filter((x) => x !== `${pointId}:${alarm}`);
    return ctx;
  }
  function signature(alarm, ctx) {
    const p = ctx.pid;
    if (!p) return `${alarm}|point=${ctx.point.id}`.slice(0, 255);
    const v = p.values ?? {};
    return [alarm, `pid=${p.key}`, `errbits=${v.ErrBits ?? "-"}`, `err=${v.Err === true ? 1 : 0}`, `state=${v.State ?? "-"}`, `mode=${v.Mode ?? "-"}`,
      `man=${v.ManEn === true ? 1 : 0}`, `post_restart=${p.post_restart ? 1 : 0}`, `stale=${(p.data_age_s ?? 999) > 60 ? 1 : 0}`,
      `out_const=${p.trend_30min?.out?.constant ? 1 : 0}`].join("|").slice(0, 255);
  }

  async function tick() {
    const pts = await query("SELECT id, name, last_active, last_payload, last_message_at FROM alarm_points");
    const active = new Map();
    for (const p of pts) for (const a of parse(p.last_active, []) ?? []) if (TRACKED_ALARMS.has(a)) active.set(`${p.id}|${a}`, { pointId: p.id, alarm: a });
    const open = new Map((await kq("SELECT id, point_id, alarm, status FROM incidents WHERE source = 'myko-auto' AND ts_end IS NULL")).map((r) => [`${r.point_id}|${r.alarm}`, r]));
    for (const [key, { pointId, alarm }] of active) {
      if (open.has(key)) continue;
      const [ev] = await query("SELECT id, DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') at FROM alarm_events WHERE point_id = ? AND alarm = ? AND event = 'start' ORDER BY id DESC LIMIT 1", [pointId, alarm]);
      const ctx = await snapshot(pointId, alarm, pts);
      const sig = signature(alarm, ctx);
      const [recent] = await kq("SELECT id FROM incidents WHERE source = 'myko-auto' AND point_id = ? AND alarm = ? AND ts_end >= ? ORDER BY id DESC LIMIT 1",
        [pointId, alarm, helNow(new Date(Date.now() - FLAP_MS))]);
      if (recent) {
        await kq("UPDATE incidents SET ts_end = NULL, duration_s = NULL, status = 'open', resolved_by = NULL, resolving_action_id = NULL, episodes = episodes + 1 WHERE id = ?", [recent.id]);
        console.log(`[incidents] re-opened #${recent.id} ${key} (flap)`);
        continue;
      }
      const k = pidKeyOf(pointId);
      const v = ctx.pid?.values ?? {};
      const symptom = `${alarm} @ ${ctx.point.name ?? pointId}` + (ctx.pid ? `: PV ${v.PV}, SP ${v.CSP ?? v.SP}, OutSum ${v.OutSum}, ErrBits ${v.ErrBits}, Warn ${v.Warn}, State ${v.State}, Mode ${v.Mode}${ctx.pid.post_restart ? ", post-restart" : ""}` : "");
      const conditions = [alarm, ...(ctx.pid?.post_restart ? ["PLC restart/download"] : []), ...(Number(v.ErrBits ?? 0) ? ["ErrBits!=0"] : [])];
      const r = await kq(`INSERT INTO incidents (ts_start, \`system\`, device, symptom, conditions, status, source, point_id, alarm, alarm_event_id, signature, context_open)
        VALUES (?, ?, ?, ?, ?, 'open', 'myko-auto', ?, ?, ?, ?, ?)`,
        [ev?.at ? utcToHel(ev.at) : helNow(), k ? "PLC_2" : "Myko", k ?? pointId, symptom.slice(0, 4000), JSON.stringify(conditions), pointId, alarm, ev?.id ?? null, sig, JSON.stringify(ctx)]);
      console.log(`[incidents] opened #${r.insertId} ${key} sig=${sig}`);
    }
    for (const [key, inc] of open) {
      if (active.has(key)) continue;
      const [clr] = await query("SELECT DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') at FROM alarm_events WHERE point_id = ? AND alarm = ? AND event = 'clear' ORDER BY id DESC LIMIT 1", [inc.point_id, inc.alarm]);
      const end = clr?.at ? utcToHel(clr.at) : helNow();
      const ctx = await snapshot(inc.point_id, inc.alarm, pts);
      let resolvedBy = inc.status === "resolved" ? "auto_recovery" : "cleared", actionId = null;
      if (resolvedBy === "cleared") {
        const [a] = await kq(`SELECT id, worked FROM actions WHERE incident_id = ? AND actor <> 'myko-autorecovery' AND (worked IS NULL OR worked = 1)
          AND ts <= ? AND ts >= ? - INTERVAL ? SECOND ORDER BY ts DESC LIMIT 1`, [inc.id, end, end, MANUAL_WINDOW_S]);
        if (a) { resolvedBy = "manual_action"; actionId = Number(a.id); if (a.worked == null) await kq("UPDATE actions SET worked = 1 WHERE id = ?", [a.id]); }
      }
      await kq(`UPDATE incidents SET ts_end = ?, duration_s = GREATEST(0, TIMESTAMPDIFF(SECOND, ts_start, ?)), context_close = ?, status = 'resolved',
          resolved_by = COALESCE(resolved_by, ?), resolving_action_id = COALESCE(resolving_action_id, ?),
          resolution = COALESCE(resolution, ?) WHERE id = ?`,
        [end, end, JSON.stringify(ctx), resolvedBy, actionId, resolvedBy === "cleared" ? "resolved (cleared) – alarm cleared without logged action" : resolvedBy === "manual_action" ? `resolved by action #${actionId}` : null, inc.id]);
      console.log(`[incidents] closed #${inc.id} ${key} (${resolvedBy})`);
    }
  }
  let running = false;
  const run = () => { if (running) return; running = true; tick().catch((e) => console.error("[incidents]", e.message)).finally(() => { running = false; }); };
  setTimeout(() => { run(); setInterval(run, TICK_MS).unref(); }, 20_000).unref();
  return { tick, snapshot, signature };
}
