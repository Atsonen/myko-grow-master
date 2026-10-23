// Ledger assistant (Finnish chat): DeepSeek tool calling against the Myko traceability API.
// Read tools run directly; WRITE tools only create a PROPOSAL validated with dryRun (exact same statements, rolled back).
// Nothing is written until the user clicks "Vahvista" (POST /api/assistant/confirm). Writes use source=assistant
// (audit_log actor) and every step is logged in assistant_log.
// Images: DeepSeek has no vision input -> server extracts EXIF (exiftool), QR/1D codes (zbarimg; QR first, then barcodes),
// OCR fallback (tesseract fin+eng) and passes the text to the model.
// Labels: /api/labels (PNG / ZIP / PDF, 203 dpi NIIMBOT sizes) and /api/labels.csv|.xlsx-compatible CSV for the NIIMBOT app batch import.
import { processContext } from "./processDoc.js";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { deepseekChat } from "./deepseek.js";

const BASE = `http://127.0.0.1:${Number(process.env.PORT || 3010)}`;
const UP_DIR = "/var/lib/myko/assistant-uploads";
const LABEL_PY = "/opt/myko/deploy/labels/make_labels.py";
const LABEL_SIZES = ["30x12", "40x12", "22x12", "30x15", "50x30"];
const run = (cmd, args, opt = {}) => new Promise((res) => execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 << 20, ...opt }, (e, out, err) => res({ ok: !e, out: String(out ?? ""), err: String(err ?? "") })));
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j;
};
const helDate = (d = new Date()) => new Intl.DateTimeFormat("fi-FI", { timeZone: "Europe/Helsinki", dateStyle: "short", timeStyle: "short" }).format(d);
const yymmdd = (d = new Date()) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "2-digit", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value])); return `${p.year}${p.month}${p.day}`; };

const TOOLS = [
  { name: "get_reference", description: "Kirjanpidon viitetiedot: sijainnit, tyypit, substraatit, tilat, tapahtumafunktiot, kannat (strains) ja tunnusmuoto. Kutsu ennen ehdotuksia.", parameters: { type: "object", properties: {} } },
  { name: "find_units", description: "Hae yksiköitä (purkit, laatikot, LC, PD...). Palauttaa enintään 60.", parameters: { type: "object", properties: {
    codes: { type: "array", items: { type: "string" } }, codePrefix: { type: "string", description: "esim. 261023-FCR-" }, location: { type: "string" }, status: { type: "string" }, type: { type: "string" }, includeArchived: { type: "boolean" } } } },
  { name: "propose_create_units", description: "EHDOTA uusien yksiköiden luontia (ei kirjoita). Tunnukset generoidaan automaattisesti: <base>-<juokseva nro>. Käytä vasta kun kaikki pakolliset tiedot on kysytty käyttäjältä.", parameters: { type: "object", required: ["base", "count"], properties: {
    base: { type: "string", description: "YYMMDD-TOKEN, TOKEN = BOX|JAR|PD|LC|BAG|OTHER tai purkin substraatti FCR|OAT|BR|GS|RIS (esim. 261023-FCR = FCR-purkki)" },
    count: { type: "integer", minimum: 1, maximum: 200 }, type: { type: "string" }, substrate: { type: "string" }, strainCode: { type: "string" }, location: { type: "string" },
    status: { type: "string" }, batchTime: { type: "string", description: "ISO-aika, oletus päivämäärän klo 12 Suomen aikaa" },
    origins: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["UNIT", "SPORES", "PURCHASED", "STRAIN_LIBRARY", "OTHER", "UNKNOWN"] }, parentUnitCode: { type: "string" }, note: { type: "string" } }, required: ["type"] } },
    description: { type: "string" }, notes: { type: "string" } } } },
  { name: "propose_move_units", description: "EHDOTA yksiköiden siirtoa sijaintiin (ei kirjoita).", parameters: { type: "object", required: ["unitCodes", "location"], properties: {
    unitCodes: { type: "array", items: { type: "string" } }, location: { type: "string" }, movedAt: { type: "string", description: "ISO-aika, esim. kuvan EXIF-aika" }, note: { type: "string" } } } },
  { name: "propose_event", description: "EHDOTA tapahtuman kirjausta yksiköille (ei kirjoita). Ympätessä anna sourceUnitCode (kirjaa myös siirron ja alkuperän).", parameters: { type: "object", required: ["unitCodes", "functionCode", "title"], properties: {
    unitCodes: { type: "array", items: { type: "string" } }, functionCode: { type: "string" }, title: { type: "string" }, eventTime: { type: "string" }, note: { type: "string" },
    statusChange: { type: "string" }, sourceUnitCode: { type: "string" }, method: { type: "string" }, amount: { type: "string" } } } },
].map((f) => ({ type: "function", function: f }));

const SYSTEM = () => `Olet Myko-kasvamon kirjanpitoassistentti. Puhut suomea, lyhyesti ja täsmällisesti. Nyt on ${helDate()} (Suomen aika, tänään ${yymmdd()}).
Kirjanpito: yksiköt (units) tunnuksella YYMMDD-TOKEN-N, esim. 261023-FCR-14 (TOKEN = tyyppi BOX/JAR/PD/LC/BAG/OTHER tai purkin substraatti FCR/OAT/BR/GS/RIS, jolloin tyyppi JAR ja substraatti FCR/OAT/BR/GRAIN/RICE; N juokseva, järjestelmä laskee). Päivämäärä = valmistus-/erä-päivä. Olemassa oleva data käyttää purkeille AINA TOKENia JAR (esim. 261013-JAR-13) ja substraatti on erillinen kenttä (FCR, OAT, BR, GRAIN, RICE) – käytä samaa käytäntöä: base YYMMDD-JAR + substrate. Laatikot YYMMDD-BOX (substraatti BULK), liemiviljelmät YYMMDD-LC, maljat YYMMDD-PD.
Säännöt:
1. Et koskaan kirjoita suoraan. Kirjoittavat työkalut (propose_*) tekevät vain ehdotuksen, jonka käyttäjä vahvistaa napilla. Älä väitä mitään tallennetuksi ennen vahvistusta.
2. Ennen uusien luontia varmista KAIKKI: määrä, tyyppi/substraatti, päivämäärä (tunnuksen YYMMDD), kanta (strain, #koodi) TAI alkuperä (emäyksikkö / itiöt / ostettu), sijainti, tila (oletus ACTIVE). Kysy puuttuvat yhdellä viestillä numeroituna listana; ehdota oletuksia ("tänään 261023?"). Tarkista sijainnit, kannat ja substraatit get_reference-työkalulla – älä keksi arvoja.
3. Siirroissa tunnista yksiköt tunnuksista (QR/viivakoodi/OCR) ja varmista find_units-työkalulla, että ne ovat olemassa. Jos kuvan tekstistä ei saa varmaa tunnusta, kysy käyttäjältä. Käytä kuvan EXIF-aikaa siirtoaikana, jos käyttäjä ei muuta sano.
4. Kuvia et näe; saat niistä vain EXIF-, QR-, viivakoodi- ja OCR-tekstin.
5. Kun ehdotus on tehty, kerro lyhyesti mitä vahvistuskortissa on ja pyydä vahvistamaan kortista.
Prosessikuvaus alla on taustatietoa kasvamon olosuhteista (lämpötilat, laitteet); käytä sitä vain, jos kysytään olosuhteista.` + processContext("summary");

export function registerAssistant(app, { query, asyncRoute }) {
  mkdirSync(UP_DIR, { recursive: true });
  const sessions = new Map(); // id -> { messages, at }
  const proposals = new Map(); // id -> { sessionId, action, path, body, preview, status }
  const uploads = new Map(); // id -> analysis
  const log = (sessionId, kind, action, payload, result, op, usage) => query(
    "INSERT INTO assistant_log (at, session_id, kind, action, payload_json, result_json, operation_id, prompt_tokens, completion_tokens) VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?)",
    [sessionId, kind, action ?? null, payload ? JSON.stringify(payload) : null, result ? JSON.stringify(result) : null, op ?? null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null]).catch((e) => console.error("[assistant] log", e.message));
  setInterval(() => { const old = Date.now() - 6 * 3600_000; for (const [k, s] of sessions) if (s.at < old) sessions.delete(k); }, 600_000).unref();

  async function reference() {
    const tax = await query("SELECT category, value FROM taxonomy_terms ORDER BY category, value");
    const g = {}; for (const t of tax) (g[t.category] ??= []).push(t.value);
    const strains = await query("SELECT code, name, species FROM strains WHERE archived = 0 ORDER BY code");
    return { ...g, strains, idFormat: "YYMMDD-TOKEN-N", tokens: { types: ["BOX", "JAR", "PD", "LC", "BAG", "OTHER"], jarSubstrateTokens: { FCR: "FCR", OAT: "OAT", BR: "BR", GS: "GRAIN", RIS: "RICE" } }, today: yymmdd() };
  }
  async function findUnits(a) {
    const w = [], p = [];
    if (a.codes?.length) { w.push(`code IN (${a.codes.map(() => "?").join(",")})`); p.push(...a.codes.map((c) => String(c).trim().toUpperCase())); }
    if (a.codePrefix) { w.push("code LIKE ?"); p.push(`${String(a.codePrefix).toUpperCase().replace(/[%_]/g, "\\$&")}%`); }
    for (const k of ["location", "status", "type"]) if (a[k]) { w.push(`${k === "location" ? "current_location" : k} = ?`); p.push(String(a[k]).toUpperCase()); }
    if (!a.includeArchived) w.push("status <> 'ARCHIVED' AND hidden = 0");
    const rows = await query(`SELECT code, type, substrate, strain_code, status, current_location, DATE_FORMAT(batch_time, '%Y-%m-%d') batch FROM units ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY batch_time DESC, code LIMIT 60`, p);
    const missing = (a.codes ?? []).map((c) => String(c).trim().toUpperCase()).filter((c) => !rows.some((r) => r.code === c));
    return { count: rows.length, units: rows, missing };
  }
  async function propose(sessionId, action, args) {
    let path, body;
    if (action === "create") { path = "/api/units/bulk"; body = { ...args }; }
    else if (action === "move") { path = "/api/units/bulk-location"; body = { unitCodes: args.unitCodes, location: args.location, movedAt: args.movedAt, note: args.note ?? "Assistentti" }; }
    else { path = "/api/events/bulk"; body = { ...args }; }
    body.source = "assistant";
    const preview = await api("POST", path, { ...body, dryRun: true }); // throws on validation error -> model sees it
    const id = randomUUID().slice(0, 8);
    proposals.set(id, { id, sessionId, action, path, body, preview, status: "pending", at: Date.now() });
    await log(sessionId, "proposal", action, body, preview);
    return { id, action, body, preview };
  }

  async function chat(sessionId, text, uploadIds) {
    const s = sessions.get(sessionId) ?? { messages: [{ role: "system", content: SYSTEM() }], at: Date.now() };
    sessions.set(sessionId, s); s.at = Date.now();
    let content = String(text ?? "").slice(0, 4000);
    for (const u of uploadIds ?? []) {
      const a = uploads.get(u); if (!a) continue;
      content += `\n\n[Liitekuva ${a.name}] EXIF: ${JSON.stringify(a.exif)}; QR-koodit: ${JSON.stringify(a.qr)}; viivakoodit: ${JSON.stringify(a.barcodes)}; OCR: ${JSON.stringify(a.ocr?.slice(0, 1500) ?? "")}; kirjanpidosta löytyvät tunnukset: ${JSON.stringify(a.known)}; tunnistamattomat: ${JSON.stringify(a.unknown)}`;
    }
    s.messages.push({ role: "user", content });
    const cards = []; let usage = { prompt_tokens: 0, completion_tokens: 0 };
    for (let step = 0; step < 6; step++) {
      const b = await deepseekChat({ messages: s.messages, tools: TOOLS, max_tokens: 1200, temperature: 0.1 }, 90_000);
      usage.prompt_tokens += b.usage?.prompt_tokens ?? 0; usage.completion_tokens += b.usage?.completion_tokens ?? 0;
      const m = b.choices?.[0]?.message; if (!m) throw new Error("DeepSeek: tyhjä vastaus");
      s.messages.push({ role: "assistant", content: m.content ?? "", ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) });
      if (!m.tool_calls?.length) { await log(sessionId, "chat", null, { user: content }, { reply: m.content, cards: cards.map((c) => c.id) }, null, usage); return { reply: m.content, cards, usage }; }
      for (const tc of m.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* empty */ }
        let result;
        try {
          const n = tc.function.name;
          if (n === "get_reference") result = await reference();
          else if (n === "find_units") result = await findUnits(args);
          else if (n.startsWith("propose_")) {
            const act = { propose_create_units: "create", propose_move_units: "move", propose_event: "event" }[n];
            const c = await propose(sessionId, act, args); cards.push(c);
            result = { proposalId: c.id, status: "odottaa käyttäjän vahvistusta", preview: c.preview };
          } else result = { error: "tuntematon työkalu" };
        } catch (e) { result = { error: e.message }; }
        s.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 8000) });
      }
    }
    return { reply: "(Assistentti ei saanut vastausta valmiiksi – kokeile tarkentaa pyyntöä.)", cards, usage };
  }

  app.post("/api/assistant/chat", asyncRoute(async (req, res) => {
    const sid = String(req.body?.sessionId || randomUUID()).slice(0, 40);
    const r = await chat(sid, req.body?.text, req.body?.uploadIds);
    res.json({ sessionId: sid, ...r });
  }));
  app.post("/api/assistant/confirm", asyncRoute(async (req, res) => {
    const p = proposals.get(String(req.body?.proposalId));
    if (!p) return res.status(404).json({ error: "ehdotusta ei löydy (vanhentunut?)" });
    if (p.status !== "pending") return res.status(409).json({ error: `ehdotus on jo ${p.status}` });
    p.status = "running";
    try {
      const r = await api("POST", p.path, { ...p.body, dryRun: false });
      p.status = "done"; p.result = r;
      await log(p.sessionId, "confirm", p.action, p.body, r, r.operationId);
      const s = sessions.get(p.sessionId);
      if (s) s.messages.push({ role: "user", content: `[Järjestelmä] Käyttäjä vahvisti ehdotuksen ${p.id}; tallennettu (operaatio ${r.operationId}${r.codes ? `, tunnukset ${r.codes.join(", ")}` : ""}).` });
      res.json({ ok: true, result: r, labels: p.action === "create" ? r.codes : undefined });
    } catch (e) { p.status = "pending"; await log(p.sessionId, "confirm_failed", p.action, p.body, { error: e.message }); res.status(400).json({ error: e.message }); }
  }));
  app.post("/api/assistant/reject", asyncRoute(async (req, res) => {
    const p = proposals.get(String(req.body?.proposalId));
    if (!p) return res.status(404).json({ error: "ehdotusta ei löydy" });
    p.status = "rejected"; await log(p.sessionId, "reject", p.action, p.body, null);
    const s = sessions.get(p.sessionId); if (s) s.messages.push({ role: "user", content: `[Järjestelmä] Käyttäjä hylkäsi ehdotuksen ${p.id}.` });
    res.json({ ok: true });
  }));

  // Image upload: { name, dataBase64 }. Returns EXIF + codes (QR first, 1D barcodes second) + OCR fallback.
  app.post("/api/assistant/upload", asyncRoute(async (req, res) => {
    const b64 = String(req.body?.dataBase64 || "").replace(/^data:[^,]+,/, "");
    if (!b64) return res.status(400).json({ error: "kuva puuttuu" });
    const buf = Buffer.from(b64, "base64"); if (buf.length > 25 << 20) return res.status(413).json({ error: "kuva liian suuri" });
    const id = randomUUID().slice(0, 12); const file = `${UP_DIR}/${id}.img`; writeFileSync(file, buf);
    const name = String(req.body?.name || "kuva").slice(0, 80); const sid = String(req.body?.sessionId || "-").slice(0, 40);
    const ex = await run("exiftool", ["-json", "-n", "-DateTimeOriginal", "-CreateDate", "-OffsetTimeOriginal", "-GPSLatitude", "-GPSLongitude", "-Make", "-Model", "-ImageWidth", "-ImageHeight", file]);
    let exif = {}; try { const e = JSON.parse(ex.out)[0] ?? {}; delete e.SourceFile; exif = e; } catch { /* none */ }
    const z = await run("zbarimg", ["-q", "--nodbus", file]);
    const codes = z.out.split("\n").filter(Boolean).map((l) => { const i = l.indexOf(":"); return { symbology: l.slice(0, i), data: l.slice(i + 1).trim() }; });
    const qr = codes.filter((c) => c.symbology === "QR-Code").map((c) => c.data);
    const barcodes = codes.filter((c) => c.symbology !== "QR-Code").map((c) => `${c.symbology}:${c.data}`);
    let ocr = null;
    if (!qr.length && !barcodes.length) { const t = await run("tesseract", [file, "stdout", "-l", "fin+eng", "--psm", "11"], { timeout: 90_000 }); ocr = t.ok ? t.out.trim() : null; }
    const cand = new Set([...qr, ...codes.map((c) => c.data), ...(ocr?.toUpperCase().match(/\b\d{6}-[A-Z]+(?:-[A-Z0-9]+)*-\d+\b/g) ?? [])].map((c) => c.trim().toUpperCase()));
    const known = cand.size ? (await query(`SELECT code, current_location, status FROM units WHERE code IN (${[...cand].map(() => "?").join(",")})`, [...cand])) : [];
    const a = { id, name, exif, qr, barcodes, ocr, known, unknown: [...cand].filter((c) => !known.some((k) => k.code === c)), method: qr.length ? "qr" : barcodes.length ? "barcode" : ocr ? "ocr" : "none" };
    uploads.set(id, a); setTimeout(() => { uploads.delete(id); rmSync(file, { force: true }); }, 6 * 3600_000).unref();
    await log(sid, "upload", a.method, { name, bytes: buf.length }, { ...a, ocr: a.ocr?.slice(0, 500) });
    res.json(a);
  }));

  // ---- labels ----
  async function labelRows(codes) {
    const rows = await query(`SELECT code, type, substrate, strain_code, current_location, batch_time FROM units WHERE code IN (${codes.map(() => "?").join(",")})`, codes);
    const by = new Map(rows.map((r) => [r.code, r]));
    return codes.filter((c) => by.has(c)).map((c) => {
      const r = by.get(c); const d = new Date(r.batch_time);
      const date = new Intl.DateTimeFormat("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", year: "2-digit" }).format(d);
      return { code: c, strain: r.strain_code ?? "", substrate: r.substrate ?? r.type, location: r.current_location ?? "", date,
        lines: [[r.strain_code ? `#${r.strain_code}` : null, r.substrate ?? r.type, date].filter(Boolean).join(" · "), r.current_location ?? ""] };
    });
  }
  const codesQ = (req) => String(req.query.codes || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean).slice(0, 500);
  app.get("/api/labels", asyncRoute(async (req, res) => {
    const codes = codesQ(req); if (!codes.length) return res.status(400).json({ error: "codes puuttuu" });
    const size = LABEL_SIZES.includes(String(req.query.size)) ? String(req.query.size) : "30x12";
    const fmt = ["png", "zip", "pdf", "xlsx"].includes(String(req.query.format)) ? String(req.query.format) : codes.length > 1 ? "zip" : "png";
    const labels = await labelRows(codes); if (!labels.length) return res.status(404).json({ error: "yksiköitä ei löydy" });
    const out = `/tmp/myko-labels-${randomUUID().slice(0, 8)}.${fmt}`;
    const r = await new Promise((resolve) => { const c = execFile("python3", [LABEL_PY], { timeout: 60_000 }, (e, o, er) => resolve({ ok: !e, err: String(er) })); c.stdin.end(JSON.stringify({ labels, size, format: fmt, out })); });
    if (!r.ok) return res.status(500).json({ error: `tarrojen luonti epäonnistui: ${r.err.slice(0, 200)}` });
    const name = fmt === "xlsx" ? `myko-tarralista-${labels.length}kpl.xlsx` : labels.length === 1 ? `${labels[0].code}_${size}mm.${fmt}` : `myko-tarrat-${labels.length}kpl-${size}mm.${fmt}`;
    res.setHeader("Content-Type", { png: "image/png", zip: "application/zip", pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }[fmt]);
    res.setHeader("Content-Disposition", `${req.query.inline ? "inline" : "attachment"}; filename="${name}"`);
    res.send(readFileSync(out)); rmSync(out, { force: true });
  }));
  // NIIMBOT app batch import (Excel/CSV): one row per label; QR column = ID. UTF-8 with BOM so Excel opens ä/ö correctly.
  app.get("/api/labels.csv", asyncRoute(async (req, res) => {
    const codes = codesQ(req); if (!codes.length) return res.status(400).json({ error: "codes puuttuu" });
    const labels = await labelRows(codes);
    const esc = (v) => (/[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = ["ID,QR,Kanta,Substraatti,Pvm,Sijainti,Rivi2", ...labels.map((l) => [l.code, l.code, l.strain, l.substrate, l.date, l.location, l.lines[0]].map(esc).join(","))].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="myko-tarralista-${labels.length}kpl.csv"`);
    res.send("\ufeff" + csv + "\r\n");
  }));
}
