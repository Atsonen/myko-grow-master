// Myko Telegram bot (primary alarm channel + read-only two-way gateway). Run: node src/telegram.js (myko-telegram.service).
// Long polling (getUpdates), no extra deps. Token: env MYKO_TELEGRAM_BOT_TOKEN or /home/atte/.config/myko/telegram.env (600,
// never logged, not in git). Allowed chats: env MYKO_TELEGRAM_CHAT_IDS (comma list) or myko_settings k='telegram_chat_ids'
// (JSON array). Messages/callbacks from any other chat are ignored; their /start is only recorded to
// myko_settings k='telegram_pending_chats' so the owner can be allow-listed.
// READ-ONLY towards the PLC: no ErrorAck, no SP writes, no pid commands from Telegram (this version).
// Alarm messages themselves are sent by deploy/myko-ml/alarm_points_check.py (tg_alert.py); this process handles:
//   callback 'ack:<pointId>:<type>'  -> Kuittaa: Myko-only ack (alarm_events start rows acked, reminders suppressed
//                                      while the alarm stays active; myko_settings k='telegram_alarm_acks')
//   callback 'mute:<pointId>:<type>' -> Ohita 1 h: no reminders for that alarm for 60 min
//   /status /halytykset /help, free text -> DeepSeek (process description + live status as context, answers only).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { query } from "./db.js";
import { deepseekChat } from "./deepseek.js";

const TOKEN_FILE = process.env.MYKO_TELEGRAM_ENV || "/home/atte/.config/myko/telegram.env";
const API_BASE = process.env.MYKO_API || "http://127.0.0.1:3010";
const MUTE_MIN = 60;
function envFile() {
  try { return Object.fromEntries(readFileSync(TOKEN_FILE, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()])); } catch { return {}; }
}
const token = () => process.env.MYKO_TELEGRAM_BOT_TOKEN || envFile().MYKO_TELEGRAM_BOT_TOKEN;

export async function tg(method, body = {}, timeoutMs = 15_000) {
  const t = token(); if (!t) throw new Error("MYKO_TELEGRAM_BOT_TOKEN puuttuu");
  const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const b = await r.json().catch(() => ({}));
  if (!b.ok) throw new Error(`Telegram ${method}: ${r.status} ${String(b.description ?? "").slice(0, 120)}`); // never includes the token
  return b.result;
}

async function setting(k, def) {
  const [r] = await query("SELECT v FROM myko_settings WHERE k = ?", [k]);
  try { return r ? JSON.parse(r.v) : def; } catch { return def; }
}
async function putSetting(k, v) {
  await query("INSERT INTO myko_settings (k, v, updated_by) VALUES (?, ?, 'telegram') ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)", [k, JSON.stringify(v)]);
}
export async function allowedChats() {
  const env = process.env.MYKO_TELEGRAM_CHAT_IDS || envFile().MYKO_TELEGRAM_CHAT_IDS || "";
  const ids = env.split(",").map((s) => s.trim()).filter(Boolean);
  for (const x of (await setting("telegram_chat_ids", [])) ?? []) ids.push(String(x));
  return new Set(ids);
}

const api = async (p) => (await fetch(API_BASE + p, { signal: AbortSignal.timeout(10_000) })).json();
const n1 = (x) => (x == null || Number.isNaN(Number(x)) ? "?" : Number(x).toFixed(1).replace(".", ","));
const hel = (iso) => new Date(iso).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

export async function activeAlarms() {
  const s = await api("/api/alarms/summary?hours=72");
  return (s.rows ?? []).filter((r) => r.active && r.pointId !== "LLM_Advisor");
}
const NAMES = { F1: "F1 Kylmiö", T1: "T1 Terrario", G_Air: "Kasvamo" };
export async function statusText() {
  const lines = [`📊 Myko ${hel(new Date().toISOString())}`];
  for (const k of ["F1", "T1", "G_Air"]) {
    try {
      const p = await api(`/api/pid/${k}`); const v = p.values ?? {};
      const age = p.at ? Math.round((Date.now() - Date.parse(p.at)) / 60000) : null;
      const ok = !v.Err && !(age > 5) && v.PV != null && v.SP != null && Math.abs(Number(v.PV) - Number(v.SP)) <= 2;
      lines.push(`${ok ? "✅" : "⚠️"} ${NAMES[k]}: ${n1(v.PV)} °C${ok ? "" : age > 5 ? " (ei tuoretta dataa)" : v.Err ? " (säädinvika)" : ` (tavoite ${n1(v.SP)})`}`);
    } catch (e) { lines.push(`${k}: ei saatavilla (${e.message.slice(0, 60)})`); }
  }
  lines.push(await alarmsText());
  return lines.join("\n");
}
export async function alarmsText() {
  let rows; try { rows = await activeAlarms(); } catch (e) { return `Hälytyksiä ei saatu: ${e.message.slice(0, 80)}`; }
  if (!rows.length) return "✅ Ei aktiivisia hälytyksiä";
  const acks = await setting("telegram_alarm_acks", {});
  return `🚨 Aktiiviset (${rows.length}):\n` + rows.map((r) => {
    const a = acks[`${r.pointId}:${r.alarm}`]; const mute = a?.muted_until && Date.parse(a.muted_until) > Date.now();
    return `• ${r.pointName}: ${r.alarm} ${n1(r.value)} ${r.unit ?? ""} (${hel(r.start)})${r.acked || a?.acked_at ? " ✔kuitattu" : ""}${mute ? " 🔕" : ""}`;
  }).join("\n");
}
const HELP = "Myko-botti (vain luku, ei PLC-kirjoituksia)\n/status – lämpötilat ja onko kunnossa\n/halytykset – aktiiviset hälytykset\n/help – tämä ohje\nVapaa teksti → DeepSeek vastaa prosessikuvauksen ja tilan pohjalta.\nHälytysnapit: Kuittaa (Myko-kuittaus, ei muistutuksia) · Ohita 1 h.";

async function askDeepSeek(text) {
  const [doc] = await query("SELECT content FROM ai_process_doc ORDER BY id DESC LIMIT 1").catch(() => []);
  const status = await statusText().catch((e) => `tila ei saatavilla: ${e.message}`);
  const sys = `Olet Myko-sienikasvamon valvomon avustaja Telegramissa. Vastaa suomeksi, lyhyesti (enintään ~6 riviä). ` +
    `Et voi tehdä toimenpiteitä etkä kirjoittaa PLC:lle; anna vain tietoa ja neuvoja. Jos käyttäjä pyytää toimenpidettä, kerro että se tehdään Myko-valvomosta.\n\n` +
    `--- PROSESSIKUVAUS ---\n${String(doc?.content ?? "").slice(0, 8000)}\n--- /PROSESSIKUVAUS ---\n\n--- LIVE-TILA ---\n${status}\n--- /LIVE-TILA ---`;
  const r = await deepseekChat({ messages: [{ role: "system", content: sys }, { role: "user", content: text.slice(0, 2000) }], max_tokens: 500 }, 60_000);
  return r.choices?.[0]?.message?.content?.trim() || "(ei vastausta)";
}

/** Text command handler (exported for local tests). Returns reply text. */
export async function handleText(text) {
  const cmd = text.trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
  if (cmd === "/status") return statusText();
  if (cmd === "/halytykset" || cmd === "/hälytykset" || cmd === "/alarms") return alarmsText();
  if (cmd === "/help" || cmd === "/start") return HELP;
  if (cmd.startsWith("/")) return "Tuntematon komento. /help";
  try { return await askDeepSeek(text); } catch (e) { return `DeepSeek ei vastannut: ${e.message.slice(0, 100)}`; }
}

/** Callback handler: Myko-only ack / 1 h mute. Never touches the PLC. Returns toast text. */
export async function handleCallback(data, who = "telegram") {
  const [act, pointId, type] = String(data).split(":");
  if (act === "test") return "Testikuittaus OK ✅";
  if (!pointId || !type || !["ack", "mute"].includes(act)) return "Tuntematon toiminto";
  const acks = await setting("telegram_alarm_acks", {}); const key = `${pointId}:${type}`; const a = acks[key] ?? {};
  if (act === "ack") {
    a.acked_at = new Date().toISOString(); a.by = who;
    const ids = (await query("SELECT id FROM alarm_events WHERE event='start' AND acked_at IS NULL AND point_id=? AND alarm=? ORDER BY id DESC LIMIT 20", [pointId, type])).map((r) => Number(r.id));
    if (ids.length) await fetch(API_BASE + "/api/alarms/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, by: `telegram (${who})` }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  } else a.muted_until = new Date(Date.now() + MUTE_MIN * 60_000).toISOString();
  acks[key] = a; await putSetting("telegram_alarm_acks", acks);
  return act === "ack" ? `Kuitattu Myko:ssa: ${type} (ei muistutuksia)` : `${type} ohitettu 1 h`;
}

async function onUpdate(u, allow) {
  const cq = u.callback_query; const m = u.message ?? u.edited_message;
  const chatId = String(cq?.message?.chat?.id ?? m?.chat?.id ?? "");
  if (!chatId) return;
  if (!allow.has(chatId)) {
    if (m?.text?.startsWith("/start")) {
      const pend = await setting("telegram_pending_chats", {});
      pend[chatId] = { at: new Date().toISOString(), user: m.from?.username ?? m.from?.first_name ?? null };
      await putSetting("telegram_pending_chats", pend);
      console.log(`[telegram] /start from non-allowed chat ${chatId} recorded (telegram_pending_chats)`);
    }
    return; // ignore everything from non-allowed chats
  }
  if (cq) {
    const who = cq.from?.username ?? String(cq.from?.id ?? "");
    const toast = await handleCallback(cq.data, who).catch((e) => `Virhe: ${e.message.slice(0, 80)}`);
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: toast }).catch(() => undefined);
    if (cq.message) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: `✔ ${toast}`.slice(0, 60), callback_data: "noop" }]] } }).catch(() => undefined);
    return;
  }
  if (!m?.text) return;
  if (!m.text.startsWith("/")) await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  const reply = await handleText(m.text).catch((e) => `Virhe: ${e.message.slice(0, 100)}`);
  await tg("sendMessage", { chat_id: chatId, text: reply.slice(0, 4000) });
}

async function main() {
  const me = await tg("getMe"); console.log(`[telegram] @${me.username} polling`);
  await tg("setMyCommands", { commands: [{ command: "status", description: "Tila: F1, T1, G_Air + hälytykset" }, { command: "halytykset", description: "Aktiiviset hälytykset" }, { command: "help", description: "Ohje" }] }).catch(() => undefined);
  let offset = 0;
  for (;;) {
    try {
      const ups = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 65_000);
      const allow = await allowedChats();
      for (const u of ups) { offset = u.update_id + 1; await onUpdate(u, allow).catch((e) => console.error("[telegram] update", e.message)); }
    } catch (e) { console.error("[telegram] poll", e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
// One-off enrolment after the owner sent /start: node src/telegram.js --allow-pending
// -> pending chat ids (telegram_pending_chats) become allowed (telegram_chat_ids) and get ONE test message with a test Kuittaa button.
async function allowPending() {
  const pend = Object.keys(await setting("telegram_pending_chats", {}));
  if (!pend.length) { console.log("no pending /start chats"); return; }
  const ids = [...new Set([...(await setting("telegram_chat_ids", [])).map(String), ...pend])];
  await putSetting("telegram_chat_ids", ids); await putSetting("telegram_pending_chats", {});
  for (const id of pend) await tg("sendMessage", { chat_id: id, text: "Myko-botti yhdistetty ✅", reply_markup: { inline_keyboard: [[{ text: "Kuittaa", callback_data: "test" }]] } });
  console.log(`allowed + test message sent: ${pend.join(", ")}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) (process.argv.includes("--allow-pending") ? allowPending().then(() => process.exit(0)) : main()).catch((e) => { console.error(e.message); process.exit(1); });
