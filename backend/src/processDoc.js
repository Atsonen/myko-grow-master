// AI process description ("AI: prosessikuvaus"): editable Finnish markdown injected into every DeepSeek prompt.
// Versioned in ai_process_doc (one row per save). Seeded from backend/ai/process.md when the table is empty.
// GET  /api/ai/process            -> {content, at, by, version, versions:[{id, at, by, chars}]}
// GET  /api/ai/process/:id        -> one stored version
// PUT  /api/ai/process {content}  -> new version
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ai", "process.md");
const FULL_MAX = 8000; // chars; longer docs go to prompts as the "## Tiivistelmä" section only
const MAX_LEN = 60000;
let cur = { content: "", at: null };

function summary(md) {
  const part = md.split(/^## /m).find((x) => x.startsWith("Tiivistelmä"));
  return (part ? part.replace(/^Tiivistelmä\s*/, "").trim() : md.slice(0, 1500)) + "\n(Tiivistelmä; koko prosessikuvaus Mykon asetuksissa.)";
}
/** Process context for a system prompt. mode "full": full doc unless too long; "summary": always the summary. */
export function processContext(mode = "full") {
  const md = cur.content.trim();
  if (!md) return "";
  const body = mode === "summary" || md.length > FULL_MAX ? summary(md) : md;
  return `\n\n--- PROSESSIKUVAUS (päivitetty ${cur.at ?? "?"} UTC) ---\n${body}\n--- /PROSESSIKUVAUS ---\n`;
}

export async function registerProcessDoc(app, { query, asyncRoute }) {
  const load = async () => {
    const [r] = await query("SELECT content, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') at FROM ai_process_doc ORDER BY id DESC LIMIT 1");
    if (r) cur = { content: r.content, at: r.at };
    return r;
  };
  try {
    if (!(await load())) {
      const seed = readFileSync(SEED, "utf8");
      await query("INSERT INTO ai_process_doc (at, by_user, content) VALUES (UTC_TIMESTAMP(), 'seed', ?)", [seed]);
      await load();
    }
  } catch (e) { console.error("[process-doc]", e.message); }

  app.get("/api/ai/process", asyncRoute(async (_req, res) => {
    const versions = await query("SELECT CAST(id AS DOUBLE) id, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') at, by_user AS `by`, CAST(CHAR_LENGTH(content) AS DOUBLE) chars FROM ai_process_doc ORDER BY id DESC LIMIT 50");
    res.json({ content: cur.content, at: cur.at, version: versions[0]?.id ?? null, versions, promptMode: cur.content.length > FULL_MAX ? "summary" : "full" });
  }));
  app.get("/api/ai/process/:id", asyncRoute(async (req, res) => {
    const [r] = await query("SELECT CAST(id AS DOUBLE) id, DATE_FORMAT(at, '%Y-%m-%dT%H:%i:%sZ') at, by_user AS `by`, content FROM ai_process_doc WHERE id = ?", [Number(req.params.id)]);
    if (!r) return res.status(404).json({ error: "not found" });
    res.json(r);
  }));
  app.put("/api/ai/process", asyncRoute(async (req, res) => {
    const c = req.body?.content;
    if (typeof c !== "string" || !c.trim()) return res.status(400).json({ error: "content required" });
    if (c.length > MAX_LEN) return res.status(400).json({ error: `max ${MAX_LEN} merkkiä` });
    if (c === cur.content) return res.json({ unchanged: true, at: cur.at });
    await query("INSERT INTO ai_process_doc (at, by_user, content) VALUES (UTC_TIMESTAMP(), 'dashboard', ?)", [c]);
    await load();
    res.json({ ok: true, at: cur.at });
  }));
}
