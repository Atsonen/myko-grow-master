// Myko Telegram bot (primary alarm channel + two-way gateway with whitelisted writes for Atte).
// Run: node src/telegram.js (myko-telegram.service). Long polling (getUpdates), no extra deps.
// Token: env MYKO_TELEGRAM_BOT_TOKEN or /home/atte/.config/myko/telegram.env (600, never logged, not in git).
// Allowed chats: env MYKO_TELEGRAM_CHAT_IDS (comma list) or myko_settings k='telegram_chat_ids'.
// Messages/callbacks from any other chat are ignored; their /start is only recorded to telegram_pending_chats.
// WRITE ACTIONS (PID ModeActivate/ErrorAck/mode, controls/SP, alarm ack): ONLY from Atte's configured chat
// (MYKO_TELEGRAM_CHAT_IDS / telegram_chat_ids). LLM tool-calling whitelist in tgActions.js. Before each write
// the bot announces what it will do, then executes and reports PLC readback. Logged to tg_writes.log + kunnossapito.
// SensorBlock / ESP commands are NOT available here.
// Alarm messages are sent by deploy/myko-ml/alarm_points_check.py (tg_alert.py); this process handles:
//   callback 'ack:<pointId>:<type>'  -> Kuittaa (Myko-only ack)
//   callback 'mute:<pointId>:<type>' -> Ohita 1 h
//   callback 'kp:<id>:do|skip'       -> auto-recovery proposal
//   /status /halytykset /help, free text -> DeepSeek Pro (tools: DB read + whitelist writes + auto kunnossapito log).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { query } from "./db.js";
import { deepseekChat, deepseekModels } from "./deepseek.js";
import { TOOLS, callTool, SCHEMA_HINT, isWriteTool, describeWrite } from "./tgTools.js";
import { kpLogIncident, kpLogAction } from "./kunnossapito.js";

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
/** Chats allowed to issue PLC/backend write actions (Atte's alarm chat ids). */
export async function actionChats() {
  return allowedChats();
}

const api = async (p) => (await fetch(API_BASE + p, { signal: AbortSignal.timeout(10_000) })).json();
const n1 = (x) => (x == null || Number.isNaN(Number(x)) ? "?" : Number(x).toFixed(1).replace(".", ","));
const hel = (iso) => new Date(iso).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

export async function activeAlarms() {
  const s = await api("/api/alarms/summary?hours=72");
  return (s.rows ?? []).filter((r) => r.active && r.pointId !== "LLM_Advisor" && r.source !== "Kasvamo");
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
  try {
    const k = JSON.parse((await import("node:fs")).readFileSync("/home/atte/.config/myko/kasvamo_alarm_state.json", "utf8"));
    const a = Object.entries(k.active ?? {}).filter(([, v]) => v).map(([x]) => (k.msg?.[x] ?? x).replace("🌱 Kasvamo: ", ""));
    lines.push(`🌱 Kasvamo-rajat: ${a.length ? a.join("; ") : "ei aktiivisia"}`);
  } catch { /* ei tilaa vielä */ }
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
const HELP = "Myko-botti (Atten chat: lukee + tekee whitelist-toimenpiteitä)\n/status – lämpötilat ja onko kunnossa\n/halytykset – aktiiviset hälytykset\n/help – tämä ohje\nVapaa teksti → DeepSeek Pro: neuvot + toimenpiteet (PID ModeActivate/ErrorAck/tila, setpoint/on/heat/cool, kuittaukset).\nHavainto ja kunnossapitopyyntö kirjataan aina automaattisesti.\nHälytysnapit: Kuittaa (Myko-kuittaus) · Ohita 1 h.";

async function autoLogObservation(text, reply, who, chatId) {
  try {
    const inc = await kpLogIncident({
      system: "Myko", device: null,
      symptom: `Telegram-havainto (${who || chatId}): ${String(text).slice(0, 1500)}`,
      conditions: ["telegram-auto", chatId ? `chat:${chatId}` : null].filter(Boolean),
      resolution: String(reply || "").slice(0, 2000),
      status: "info",
    });
    await kpLogAction({
      incident_id: inc.id, actor: "telegram-atte",
      action: "Kunnossapitopyyntö (auto): Telegram-keskustelu kirjattu",
      nodes: "telegram", params: { chatId, q: String(text).slice(0, 500) },
      approved_by: `telegram:${who || chatId}`, result: "kirjattu automaattisesti",
    });
    return inc.id;
  } catch (e) {
    console.warn("[telegram] auto-log", e.message);
    return null;
  }
}

async function askDeepSeek(text, opts = {}) {
  const who = opts.who || "telegram";
  const chatId = opts.chatId ? String(opts.chatId) : null;
  const allowWrites = Boolean(opts.allowWrites);
  const announce = typeof opts.announce === "function" ? opts.announce : null;
  const [doc] = await query("SELECT content FROM ai_process_doc ORDER BY id DESC LIMIT 1").catch(() => []);
  const status = await statusText().catch((e) => `tila ei saatavilla: ${e.message}`);
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Helsinki" }).slice(0, 16);
  const models = deepseekModels().join(" → ");
  const writeHint = allowWrites
    ? `Voit SUORITTAA toimenpiteitä työkaluilla pid_cmd, set_controls, ack_alarms (ja lukea get_pid). Käyttäjän viestit ovat toimintaohjeita. ` +
      `Ennen kirjoitusta järjestelmä ilmoittaa käyttäjälle mitä tehdään. ErrorAck ja Mode+ModeActivate erikseen; Mode vain 0/3/4. ` +
      `Älä käytä SensorBlock/ESP-komentoja (niitä ei ole). dry_run=true vain kun käyttäjä pyytää kuiva-ajoa.`
    : `Tässä chatissa et voi kirjoittaa PLC:lle; anna neuvoja.`;
  const sys = `Olet Myko-sienikasvamon valvomon avustaja Telegramissa. Vastaa suomeksi, tiiviisti (Telegram, mieluiten alle ~12 riviä, ei markdown-taulukoita). ` +
    `${writeHint}\n` +
    `Sinulla on Myko-tietokannan lukutyökalut (get_measurements, get_alarm_history, list_tables, describe_table, run_sql) ja kunnossapito (kp_search, kp_show_incident, kp_match, kp_list_fixes, kp_policy, kp_recent_incidents, kp_candidates, kp_stats, kp_log_incident, kp_log_action). ` +
    `ÄLÄ KOSKAAN kysy "Haluatko että kirjaan havainnon..." – havainto ja kunnossapitopyyntö kirjataan AINA automaattisesti (log_observation ja/tai kp_log_incident). Kerro lyhyesti että kirjattiin.\n` +
    `Hae data työkaluilla äläkä arvaa lukuja. Nyt on ${now} (Europe/Helsinki). Malli: ${models}.\n\n` +
    `${SCHEMA_HINT}\n\n--- PROSESSIKUVAUS ---\n${String(doc?.content ?? "").slice(0, 8000)}\n--- /PROSESSIKUVAUS ---\n\n--- LIVE-TILA ---\n${status}\n--- /LIVE-TILA ---`;
  const messages = [{ role: "system", content: sys }, { role: "user", content: text.slice(0, 2000) }];
  const ctx = { who, q: text.slice(0, 200), chatId, allowWrites };
  let usedModel = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const r = await deepseekChat({ messages, tools: TOOLS, max_tokens: 900 }, 90_000);
    usedModel = r._model_used || usedModel;
    const m = r.choices?.[0]?.message; if (!m) break;
    if (!m.tool_calls?.length) {
      let out = clip(m.content?.trim() || "(ei vastausta)");
      out = out.replace(/Haluatko\s+että\s+kirjaan[\s\S]*?\?/gi, "Kirjasin havainnon ja kunnossapitopyynnön.").trim();
      return { text: out, model: usedModel };
    }
    messages.push({ role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls });
    for (const tc of m.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      const name = tc.function.name;
      if (isWriteTool(name) && name !== "get_pid" && name !== "log_observation" && announce) {
        await announce(`⚙️ Suoritan: ${describeWrite(name, args)}`).catch(() => undefined);
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: await callTool(name, args, { ...ctx, round }) });
    }
  }
  const r = await deepseekChat({ messages: [...messages, { role: "user", content: "Vastaa nyt jo haetun datan perusteella. Älä kysy kirjaamisesta." }], max_tokens: 900 }, 90_000);
  usedModel = r._model_used || usedModel;
  let out = clip(r.choices?.[0]?.message?.content?.trim() || "(ei vastausta)");
  out = out.replace(/Haluatko\s+että\s+kirjaan[\s\S]*?\?/gi, "Kirjasin havainnon ja kunnossapitopyynnön.").trim();
  return { text: out, model: usedModel };
}
const MAX_TOOL_ROUNDS = 8;
const clip = (s) => (s.length > 4000 ? s.slice(0, 3990) + "…" : s);

/** Text command handler (exported for local tests). Returns reply text. opts: { who, chatId, allowWrites, announce } */
export async function handleText(text, opts = {}) {
  const cmd = text.trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
  if (cmd === "/status") return statusText();
  if (cmd === "/halytykset" || cmd === "/hälytykset" || cmd === "/alarms") return alarmsText();
  if (cmd === "/help" || cmd === "/start") return HELP;
  if (cmd.startsWith("/")) return "Tuntematon komento. /help";
  try {
    const { text: reply, model } = await askDeepSeek(text, opts);
    const logId = await autoLogObservation(text, reply, opts.who, opts.chatId);
    const tail = logId ? `\n📋 Kirjattu kunnossapitoon (#${logId}).` : "";
    const m = model ? `\n🤖 ${model}` : "";
    return clip((reply + tail + m).trim());
  } catch (e) { return `DeepSeek ei vastannut: ${e.message.slice(0, 100)}`; }
}

/** Callback handler: Myko-only ack / 1 h mute. Returns toast text. */
export async function handleCallback(data, who = "telegram") {
  const [act, pointId, type] = String(data).split(":");
  if (act === "test") return "Testikuittaus OK ✅";
  if (act === "kp") {
    const r = await fetch(API_BASE + "/api/autorecovery/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: pointId, decision: type, by: who }), signal: AbortSignal.timeout(10_000) });
    const b = await r.json().catch(() => ({})); return String(b.text ?? b.error ?? `HTTP ${r.status}`).slice(0, 180);
  }
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

async function onUpdate(u, allow, actionAllow) {
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
  const who = m.from?.username ?? String(m.from?.id ?? "");
  const allowWrites = actionAllow.has(chatId);
  const announce = async (t) => { await tg("sendMessage", { chat_id: chatId, text: String(t).slice(0, 500) }); };
  const reply = await handleText(m.text, { who, chatId, allowWrites, announce }).catch((e) => `Virhe: ${e.message.slice(0, 100)}`);
  await tg("sendMessage", { chat_id: chatId, text: reply.slice(0, 4000) });
}

async function main() {
  const me = await tg("getMe");
  console.log(`[telegram] @${me.username} polling models=${deepseekModels().join(",")}`);
  await tg("setMyCommands", { commands: [{ command: "status", description: "Tila: F1, T1, G_Air + hälytykset" }, { command: "halytykset", description: "Aktiiviset hälytykset" }, { command: "help", description: "Ohje" }] }).catch(() => undefined);
  let offset = 0;
  for (;;) {
    try {
      const ups = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 65_000);
      const allow = await allowedChats();
      const actionAllow = await actionChats();
      for (const u of ups) { offset = u.update_id + 1; await onUpdate(u, allow, actionAllow).catch((e) => console.error("[telegram] update", e.message)); }
    } catch (e) { console.error("[telegram] poll", e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
async function allowPending() {
  const pend = Object.keys(await setting("telegram_pending_chats", {}));
  if (!pend.length) { console.log("no pending /start chats"); return; }
  const ids = [...new Set([...(await setting("telegram_chat_ids", [])).map(String), ...pend])];
  await putSetting("telegram_chat_ids", ids); await putSetting("telegram_pending_chats", {});
  for (const id of pend) await tg("sendMessage", { chat_id: id, text: "Myko-botti yhdistetty ✅", reply_markup: { inline_keyboard: [[{ text: "Kuittaa", callback_data: "test" }]] } });
  console.log(`allowed + test message sent: ${pend.join(", ")}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) (process.argv.includes("--allow-pending") ? allowPending().then(() => process.exit(0)) : main()).catch((e) => { console.error(e.message); process.exit(1); });
