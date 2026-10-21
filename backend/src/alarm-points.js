// Alarm points: an external checker publishes retained <topic_prefix>/json
// {status, active[], bits{}, temp, last_reading, checked, since{KEY: iso}}. We keep the latest state on
// alarm_points and append start/clear transitions to alarm_events (compared with the stored active set,
// so retained re-deliveries after a reconnect do not duplicate events).
import { query } from "./db.js";

let points = [];

export async function loadAlarmPoints() {
  points = (await query("SELECT id, topic_prefix, bits_json, last_active FROM alarm_points WHERE enabled = 1")).map((r) => ({
    id: r.id,
    topic: `${r.topic_prefix}/json`,
    bits: parseJson(r.bits_json, []),
    lastActive: parseJson(r.last_active, null),
  }));
  return points.map((p) => p.topic);
}

export function alarmPointForTopic(topic) {
  return points.find((p) => p.topic === topic) ?? null;
}

const toSql = (d) => d.toISOString().slice(0, 23).replace("T", " ");

export async function handleAlarmMessage(point, payload, receivedAt) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const active = Array.isArray(payload.active) ? payload.active.map(String) : [];
  const status = Number.isFinite(Number(payload.status)) ? Number(payload.status) : null;
  const value = Number.isFinite(Number(payload.temp)) ? Number(payload.temp) : null;
  const checked = validDate(payload.checked) ?? receivedAt;
  const bitOf = (k) => point.bits.find((b) => b.key === k)?.bit ?? payload.bits?.[k] ?? null;
  const prev = point.lastActive ?? [];
  const started = active.filter((k) => !prev.includes(k));
  const cleared = prev.filter((k) => !active.includes(k));
  for (const k of started) {
    const at = validDate(payload.since?.[k]) ?? checked;
    await query(
      "INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, ?, 'start', ?, ?, ?)",
      [point.id, k, bitOf(k), toSql(at), value, status],
    );
  }
  for (const k of cleared) {
    await query(
      "INSERT INTO alarm_events (point_id, alarm, bit, event, at, value, status_word) VALUES (?, ?, ?, 'clear', ?, ?, ?)",
      [point.id, k, bitOf(k), toSql(checked), value, status],
    );
  }
  await query(
    "UPDATE alarm_points SET last_status = ?, last_active = ?, last_payload = ?, last_message_at = ? WHERE id = ?",
    [status, JSON.stringify(active), JSON.stringify(payload), toSql(receivedAt), point.id],
  );
  point.lastActive = active;
  if (started.length || cleared.length)
    console.log(`[alarm] ${point.id} start=[${started}] clear=[${cleared}] status=${status}`);
  return started.length + cleared.length;
}

function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
