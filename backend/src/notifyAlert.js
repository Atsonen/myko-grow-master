// Shared Myko alarm notifier: Telegram (@Valvomo_bot via telegram.js) first, WhatsApp (wa_alert.py) only on failure.
// Failure = HTTP error / non-2xx, Telegram ok:false (tg() throws), timeout (~10 s), or exception.
// Inject tgSend / waSend for unit tests. Never logs tokens.
import { execFile } from "node:child_process";
import { tg, allowedChats } from "./telegram.js";

const WA_PY = "/usr/bin/python3";
const WA_DIR = "/home/atte/myko-ml";
export const TG_TIMEOUT_MS = 10_000;

/** WhatsApp via existing wa_alert.send (Whatabot). Returns boolean. */
export function sendWhatsApp(text, { tag = "ALARM ", execFileFn = execFile } = {}) {
  return new Promise((resolve) => {
    execFileFn(
      WA_PY,
      ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from wa_alert import send; r = send(sys.argv[2], bypass_rate=True, tag=sys.argv[3]); print('OK' if r[0] else 'FAIL', r[1])", WA_DIR, text, tag],
      { timeout: 60_000, cwd: WA_DIR },
      (err, out) => resolve(!err && String(out).startsWith("OK")),
    );
  });
}

/**
 * @param {string} text
 * @param {{ reply_markup?: object, tag?: string, tgSend?: Function, waSend?: Function, log?: Function }} [opts]
 * @returns {Promise<{ok:boolean, channel:'telegram'|'whatsapp'|'none', telegramOk:boolean|null, whatsappOk:boolean|null, error?:string}>}
 */
export async function notifyAlert(text, opts = {}) {
  const {
    reply_markup,
    tag = "ALARM ",
    tgSend,
    waSend,
    log = (s) => console.log(s),
  } = opts;
  const out = { ok: false, channel: "none", telegramOk: null, whatsappOk: null, error: undefined };

  let tgOk = false;
  try {
    if (tgSend) {
      tgOk = Boolean(await tgSend(text, reply_markup));
    } else {
      const ids = [...await allowedChats()];
      if (!ids.length) throw new Error("no telegram chats");
      for (const chat_id of ids) {
        await tg("sendMessage", { chat_id, text, ...(reply_markup ? { reply_markup } : {}) }, TG_TIMEOUT_MS);
      }
      tgOk = true;
    }
  } catch (e) {
    out.error = e?.message ? String(e.message).slice(0, 160) : typeName(e);
    tgOk = false;
  }
  out.telegramOk = tgOk;
  if (tgOk) {
    out.ok = true;
    out.channel = "telegram";
    log(`[notify] telegram ok tag=${tag} msg=${JSON.stringify(String(text)).slice(0, 200)}`);
    return out;
  }
  log(`[notify] telegram FAIL (${out.error || "false"}) -> whatsapp fallback tag=${tag}`);

  let waOk = false;
  try {
    waOk = Boolean(waSend ? await waSend(text, { tag }) : await sendWhatsApp(text, { tag }));
  } catch (e) {
    out.error = `wa:${e?.message ? String(e.message).slice(0, 120) : typeName(e)}`;
    waOk = false;
  }
  out.whatsappOk = waOk;
  out.ok = waOk;
  out.channel = waOk ? "whatsapp" : "none";
  log(`[notify] whatsapp ok=${waOk} tag=${tag} msg=${JSON.stringify(String(text)).slice(0, 200)}`);
  return out;
}

function typeName(e) {
  return e?.name || (e && e.constructor && e.constructor.name) || "Error";
}
