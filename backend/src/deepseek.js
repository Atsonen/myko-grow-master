// Shared DeepSeek client. Key: env DEEPSEEK_API_KEY or /home/atte/.config/myko/deepseek.env (600). Never logged.
// Model: DeepSeek Pro first (same chain as /home/atte/kysymyspankki), then flash/chat fallbacks.
import { readFileSync } from "node:fs";
const KEY_FILE = process.env.DEEPSEEK_KEY_FILE || "/home/atte/.config/myko/deepseek.env";
const DS_PRIMARY = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DS_FALLBACKS = (process.env.DEEPSEEK_MODEL_FALLBACKS || "deepseek-flash,deepseek-chat")
  .split(",").map((s) => s.trim()).filter(Boolean);
export function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try { return readFileSync(KEY_FILE, "utf8").match(/^DEEPSEEK_API_KEY=(.+)$/m)?.[1].trim() ?? null; } catch { return null; }
}
export function deepseekModels() {
  return [DS_PRIMARY, ...DS_FALLBACKS.filter((m) => m !== DS_PRIMARY)];
}
// body: { messages, tools?, response_format?, max_tokens?, temperature?, model? } -> raw API response (+ _model_used)
export async function deepseekChat(body, timeoutMs = 120_000) {
  const k = apiKey(); if (!k) throw new Error("DEEPSEEK_API_KEY puuttuu");
  const { model: forced, ...rest } = body ?? {};
  const models = forced ? [forced] : deepseekModels();
  let lastErr;
  for (const model of models) {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: 1500, ...rest }),
    });
    const b = await r.json().catch(() => ({}));
    if (r.ok) return { ...b, _model_used: b.model || model };
    lastErr = new Error(`DeepSeek HTTP ${r.status} (${model}): ${JSON.stringify(b?.error ?? b).slice(0, 200)}`);
    // Retry next model on 4xx model errors / overload; abort on auth (401/403)
    if (r.status === 401 || r.status === 403) throw lastErr;
  }
  throw lastErr || new Error("DeepSeek-kutsu epäonnistui");
}
