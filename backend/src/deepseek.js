// Shared DeepSeek client. Key: env DEEPSEEK_API_KEY or /home/atte/.config/myko/deepseek.env (600). Never logged.
import { readFileSync } from "node:fs";
const KEY_FILE = process.env.DEEPSEEK_KEY_FILE || "/home/atte/.config/myko/deepseek.env";
export function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return readFileSync(KEY_FILE, "utf8").match(/^DEEPSEEK_API_KEY=(.+)$/m)?.[1].trim() ?? null; } catch { return null; }
}
// body: { messages, tools?, response_format?, max_tokens?, temperature? } -> raw API response
export async function deepseekChat(body, timeoutMs = 120_000) {
  const k = apiKey(); if (!k) throw new Error("DEEPSEEK_API_KEY puuttuu");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", temperature: 0.2, max_tokens: 1500, ...body }),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}: ${JSON.stringify(b?.error ?? b).slice(0, 200)}`);
  return b;
}
