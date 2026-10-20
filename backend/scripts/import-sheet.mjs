#!/usr/bin/env node
// Replace Myko cultivation data (units, events, transfers, unit_locations) with the contents of
// the cultivation spreadsheet CSV export. Sensor/environment tables are never touched.
//
//   node scripts/import-sheet.mjs --file sheet.csv            # dry run (default): report only
//   node scripts/import-sheet.mjs --file sheet.csv --report r.json
//   node scripts/import-sheet.mjs --file sheet.csv --apply    # single transaction replace
//
// Sheet layout: row 1 = headers (col 1 date d.m.yyyy, col 2 "General", rest = unit labels).
// Each non-empty cell = one event for that column's unit on that row's date (12:00 Helsinki).
import fs from "node:fs";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const FILE = opt("--file");
const APPLY = args.includes("--apply");
const REPORT = opt("--report");
const EXPECT_FIELDS = Number(opt("--expect-fields") || 0);
if (!FILE) { console.error("usage: --file <csv> [--apply] [--report out.json] [--expect-fields N]"); process.exit(2); }

const LOCATION_ALIASES = { T1: "TERRARIO-1", F1: "KYLMASAILYTYSTILA-1" }; // from environment_channel_map
const anomalies = [];
const flag = (kind, detail) => anomalies.push({ kind, ...detail });

// ---------- CSV (RFC 4180: quotes, "" escapes, newlines inside quotes) ----------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = []; let f = ""; let q = false; let line = 1; let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else { if (c === "\n") line++; f += c; }
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); rows.push({ line: rowLine, cells: row }); row = []; f = ""; line++; rowLine = line;
    } else f += c;
  }
  if (q) flag("csv_unterminated_quote", { line: rowLine });
  if (f !== "" || row.length) { row.push(f); rows.push({ line: rowLine, cells: row }); }
  return rows;
}

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, "0");
const yymmdd = (d) => `${String(d.y).slice(2)}${pad(d.m)}${pad(d.d)}`;
function parseDate(s) {
  const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(s || "");
  if (!m) return null;
  const d = { d: +m[1], m: +m[2], y: +m[3] };
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d));
  return t.getUTCDate() === d.d && t.getUTCMonth() === d.m - 1 ? d : null;
}
const dayNum = (d) => Date.UTC(d.y, d.m - 1, d.d) / 864e5;
const fromDayNum = (n) => { const t = new Date(n * 864e5); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
function lastSunday(y, month) { const t = new Date(Date.UTC(y, month, 0)); return t.getUTCDate() - t.getUTCDay(); }
// 12:00 Europe/Helsinki as UTC (EET +2, EEST +3 between last Sun of Mar and last Sun of Oct)
function noonHelsinkiUtc(d, offsetMinutes = 0) {
  const dst = (d.m > 3 && d.m < 10) || (d.m === 3 && d.d >= lastSunday(d.y, 3)) || (d.m === 10 && d.d < lastSunday(d.y, 10));
  return new Date(Date.UTC(d.y, d.m - 1, d.d, 12 - (dst ? 3 : 2), offsetMinutes));
}

// ---------- unit labels -> codes ----------
const JAR_SUB = { FCR: "FCR", OAT: "OAT", BR: "BR", GS: "GRAIN", RIS: "RICE" };
function classify(label, firstDate) {
  const L = label.trim().replace(/\s+/g, " ");
  const fd = firstDate ? yymmdd(firstDate) : null;
  let m;
  const sub = (s) => { for (const k of Object.keys(JAR_SUB)) if (s.split("-").includes(k)) return k; return null; };
  if ((m = /^(\d{6})-([A-Z]+)-(\d+)$/.exec(L))) {
    const k = JAR_SUB[m[2]] ? "JAR" : ["LC", "BOX", "PD", "JAR", "BAG"].includes(m[2]) ? m[2] : m[2] === "BS" ? "BOX" : null;
    if (k) return { base: `${m[1]}-${k}-${m[3]}`, type: k, substrate: JAR_SUB[m[2]] || (m[2] === "BS" ? "BULK" : null) };
  }
  if ((m = /^(\d{1,2})-(\d{1,2})-(\d{2})(?:-([A-Z-]*?))?(?:-?(\d+))?$/.exec(L))) {
    const date = `${m[3]}${pad(m[1])}${pad(m[2])}`; const s = m[4] ? sub(m[4]) : null;
    if (s) return { base: `${date}-JAR-${m[5] || 1}`, type: "JAR", substrate: JAR_SUB[s], substrateNote: m[4] };
    return { base: `${date}-OTHER-${m[5] || 1}`, type: "OTHER", substrate: null, warn: "no substrate in label" };
  }
  if ((m = /^(\d{1,2})-(\d{2})-(GS|FCR|OAT|BR)-(\d+)$/.exec(L)) && fd)
    return { base: `${fd}-JAR-${m[4]}`, type: "JAR", substrate: JAR_SUB[m[3]], warn: `month-only label (${m[1]}/${m[2]}); date from first entry` };
  if ((m = /^(GS|BS)-?(\d{6})(?:-(\d+(?:-\d+)*))?$/.exec(L)))
    return m[1] === "GS" ? { base: `${m[2]}-JAR-${m[3] || 1}`, type: "JAR", substrate: "GRAIN" } : { base: `${m[2]}-BOX-${m[3] || 1}`, type: "BOX", substrate: "BULK" };
  if ((m = /^BS-(\d{2})-(\d{2}|\?\?)-(\d{2})(?:-(\d+))?$/.exec(L))) {
    if (m[2] === "??") return fd ? { base: `${fd}-BOX-${m[4] || 1}`, type: "BOX", substrate: "BULK", warn: "unknown day in label; date from first entry" } : null;
    return { base: `${m[3]}${m[1]}${m[2]}-BOX-${m[4] || 1}`, type: "BOX", substrate: "BULK" };
  }
  if ((m = /^LC-(\d{6})-(\d+)$/.exec(L))) return { base: `${m[1]}-LC-${m[2]}`, type: "LC", substrate: null };
  if (!fd) return null;
  if ((m = /^LC-?(\d+(?:-S\d+)*(?:-\d+)?)$/i.exec(L)) || (m = /^LC(\d+-S\d+(?:-\d+)?)$/i.exec(L)))
    return { base: `${fd}-LC-${m[1].toUpperCase()}`, type: "LC", substrate: null };
  if ((m = /^PD[ -]?([\d ,\-]+)$/i.exec(L))) return { base: `${fd}-PD-${m[1].replace(/[ ,]+/g, "-").replace(/-+/g, "-")}`, type: "PD", substrate: null };
  if ((m = /^P(\d+)(?:-P(\d+))?$/.exec(L))) return { base: `${fd}-BOX-${m[2] ? `${m[1]}-${m[2]}` : m[1]}`, type: "BOX", substrate: null };
  if ((m = /^BS-(\w+?)-?(T\d+)?$/.exec(L))) return { base: `${fd}-BOX-${L.slice(3)}`, type: "BOX", substrate: "BULK", warn: "non-standard BS label" };
  if ((m = /^(NL|DWC)-?(\d+)$/i.exec(L))) return { base: `${fd}-OTHER-${m[1].toUpperCase()}-${m[2]}`, type: "OTHER", substrate: null };
  return { base: `${fd}-OTHER-${L.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase()}`, type: "OTHER", substrate: null, warn: "unrecognised label pattern" };
}

// ---------- cell text rules ----------
const RX = {
  contam: /\b(home|homeessa|homeinen|kontaminoitunut|kontam|pilalla|bakteeri|trich)/i,
  discard: /\b(pois|käytetty|heitetty|roskiin)\b/i,
  ino: /\b(ino|inokuloitu|tippa|siirto|siirretty)\b/i,
  prep: /\b(steril|keitetty|keitto|pastöroit|painekatt|pc\b)/i,
  harvest: /\b(sato|flesh|korjattu|harvest|kuivattu)\b|\d+\s*g\b/i,
  fruit: /\b(pinnat|pins|primordi|fruit|hedelm)/i,
  growth: /(\d+\s*%|kasvu|kasvaa|kolonis|myseeli|valkoinen|col\b)/i,
};
function eventFunction(text) {
  if (RX.contam.test(text)) return { fn: "QC", status: "CONTAMINATED" };
  if (RX.discard.test(text)) return { fn: "OBS", status: "DISCARDED" };
  if (RX.harvest.test(text)) return { fn: "HAR", status: null };
  if (RX.ino.test(text) || /-->/.test(text)) return { fn: "TRF", status: null };
  if (RX.prep.test(text)) return { fn: "PREP", status: null };
  if (RX.fruit.test(text)) return { fn: "FRU", status: null };
  if (RX.growth.test(text)) return { fn: "COL", status: null };
  return { fn: "OBS", status: null };
}
function locationsIn(text) {
  const out = [];
  const rx = /(?:-->|@|\bmultaan\b|^)\s*(T\d|F\d|G\d)\b/gim;
  let m; while ((m = rx.exec(text))) out.push(m[1].toUpperCase());
  if (/^\s*(T\d|F\d|G\d)\s*$/i.test(text) && !out.length) out.push(text.trim().toUpperCase());
  return [...new Set(out)];
}
function strainIn(text) {
  if (/\barg\b|argentin/i.test(text)) return "ARG";
  if (/mckenna|\bmck\b/i.test(text)) return "MCK";
  if (/auto ?bonkers|\bcab\b/i.test(text)) return "CAB";
  if (/golden ?teacher|\bgt\b/i.test(text)) return "GT";
  return null;
}

// ---------- main ----------
const raw = fs.readFileSync(FILE);
const text = raw.toString("utf8");
const rows = parseCsv(text).filter((r) => r.cells.some((c) => c.trim() !== ""));
const header = rows.shift().cells;
const width = EXPECT_FIELDS || header.length;
for (const r of rows) if (r.cells.length !== width) flag("row_field_count", { line: r.line, fields: r.cells.length, expected: width });

// dates: parse, fill blanks/garbage from previous row, flag out-of-order values
let prev = null; const rowDates = [];
rows.forEach((r, i) => {
  let d = parseDate(r.cells[0]);
  if (!d) { flag("date_unparsed", { line: r.line, value: r.cells[0], used: prev && yymmdd(prev) }); d = prev; }
  else if (prev && (dayNum(d) < dayNum(prev) - 1 || dayNum(d) > dayNum(prev) + 120)) {
    const next = rows.slice(i + 1).map((x) => parseDate(x.cells[0])).find(Boolean);
    const fits = next && dayNum(d) <= dayNum(next) && dayNum(d) >= dayNum(prev);
    if (!fits) {
      // try year/month typo fix that lands between prev and next
      const cands = [{ ...d, y: prev.y }, { ...d, y: next?.y ?? prev.y }, { ...d, m: prev.m, y: prev.y }].filter((c) => parseDate(`${c.d}.${c.m}.${c.y}`));
      const ok = cands.find((c) => dayNum(c) >= dayNum(prev) && (!next || dayNum(c) <= dayNum(next)));
      flag("date_out_of_order", { line: r.line, value: r.cells[0], used: ok ? yymmdd(ok) : yymmdd(prev) });
      d = ok || prev;
    }
  }
  rowDates.push(d); if (d) prev = d;
});

// columns -> units
const general = [];
const cols = [];
const seenHeader = new Map();
for (let c = 2; c < header.length; c++) {
  let label = header[c].trim();
  const cells = rows.map((r, i) => ({ line: r.line, date: rowDates[i], text: (r.cells[c] || "").trim() })).filter((x) => x.text && x.date);
  if (!label) { if (cells.length) { label = `COL${c + 1}`; flag("empty_header_with_data", { column: c + 1, cells: cells.length }); } else continue; }
  if (seenHeader.has(label)) {
    if (!cells.length) { flag("duplicate_header_empty_ignored", { label, column: c + 1 }); continue; }
    flag("duplicate_header", { label, column: c + 1, first_column: seenHeader.get(label) });
  }
  seenHeader.set(label, c + 1);
  if (!cells.length) flag("unit_without_entries", { label, column: c + 1 });
  cols.push({ c, label, cells });
}
rows.forEach((r, i) => { const t = (r.cells[1] || "").trim(); if (t) general.push({ line: r.line, date: rowDates[i] && yymmdd(rowDates[i]), text: t }); });

const units = new Map(); const aliases = new Map();
for (const col of cols) {
  const first = col.cells[0]?.date || null;
  const k = classify(col.label, first);
  if (!k) { flag("unit_unmappable", { label: col.label, column: col.c + 1 }); continue; }
  if (k.warn) flag("label_heuristic", { label: col.label, code: k.base, note: k.warn });
  let code = k.base;
  while (units.has(code)) code = /-(\d+)$/.test(code) ? code.replace(/-(\d+)$/, (_, x) => `-${+x + 1}`) : `${code}-2`;
  if (code !== k.base) flag("code_collision_renumbered", { label: col.label, wanted: k.base, code });
  const batchDate = /^(\d{2})(\d{2})(\d{2})-/.exec(code); 
  const bd = batchDate ? { y: 2000 + +batchDate[1], m: +batchDate[2], d: +batchDate[3] } : first;
  units.set(code, { code, label: col.label, column: col.c + 1, type: k.type, substrate: k.substrate, batch: bd, cells: col.cells,
    strain: null, parent: null, status: "ACTIVE", location: null, events: [], moves: [] });
  for (const a of [col.label, code, col.label.replace(/[\s-]/g, "").toUpperCase()]) if (!aliases.has(a)) aliases.set(a, code);
}
const resolve = (ref) => {
  const r = ref.trim().replace(/[.,;:]$/, "");
  return aliases.get(r) || aliases.get(r.replace(/[\s-]/g, "").toUpperCase()) ||
    (/^(\d{6})-?([A-Z]+)-?(\d+)$/.test(r) ? aliases.get(r.replace(/^(\d{6})-?([A-Z]+)-?(\d+)$/, "$1-$2-$3")) : null) || null;
};

// events, transfers, locations, strain hints
const transfers = []; let evtSeq = 0;
for (const u of units.values()) {
  u.cells.forEach((cell, idx) => {
    const { fn, status } = eventFunction(cell.text);
    const time = noonHelsinkiUtc(cell.date);
    const lines = cell.text.split(/\r?\n/);
    const title = lines[0].slice(0, 255);
    const ev = { id: `evt-sheet-${++evtSeq}`, fn, unit: u.code, time, title, description: lines.length > 1 || lines[0].length > 255 ? cell.text : null,
      note: `Sheet line ${cell.line}, column ${u.column} (${u.label})`, status };
    // inoculation source: "INO <ref>", "<- ref", or a cell that is exactly another unit's label
    const refs = [];
    const m1 = cell.text.match(/\b(?:ino|tippa|siirto|from|<-)\s*:?\s*([A-Za-z0-9][A-Za-z0-9 \-]{1,30})/i);
    if (m1) refs.push(m1[1].split(/\s+(?=\d+(?:[.,]\d+)?\s*ml)|\s{2,}/)[0]);
    if (resolve(cell.text) && resolve(cell.text) !== u.code) refs.push(cell.text);
    for (const ref of refs) {
      let src = resolve(ref);
      if (!src) { const tok = ref.split(/\s+/); for (let k = tok.length; k > 0 && !src; k--) src = resolve(tok.slice(0, k).join(" ")); }
      if (src && src !== u.code) {
        const amount = (cell.text.match(/(\d+(?:[.,]\d+)?)\s*ml/i) || [])[0] || "";
        transfers.push({ id: `trf-sheet-${transfers.length + 1}`, source: src, target: u.code, time, amount, note: `Sheet line ${cell.line}: ${title}` });
        if (!u.parent) u.parent = src; ev.fn = "TRF";
      } else if (/\bino\b/i.test(cell.text)) flag("ino_reference_unresolved", { unit: u.code, line: cell.line, text: title });
      break;
    }
    for (const loc of locationsIn(cell.text)) u.moves.push({ location: LOCATION_ALIASES[loc] || loc, raw: loc, time, line: cell.line });
    const s = strainIn(cell.text); if (s && !u.strain) u.strain = s;
    if (status) u.status = status;
    u.events.push(ev);
  });
  if (u.moves.length) u.location = u.moves[u.moves.length - 1].location;
}
// strain inheritance through parents; default GT
const strainOf = (u, seen = new Set()) => u.strain || (u.parent && !seen.has(u.parent) && units.get(u.parent) ? strainOf(units.get(u.parent), seen.add(u.code)) : null);
let defaulted = 0;
for (const u of units.values()) { u.strainResolved = strainOf(u) || (defaulted++, "GT"); }
const rawLocs = new Set(); for (const u of units.values()) for (const m of u.moves) if (!LOCATION_ALIASES[m.raw]) rawLocs.add(m.raw);
if (rawLocs.size) flag("unmapped_location_codes", { codes: [...rawLocs] });

const events = [...units.values()].flatMap((u) => u.events);
const summary = {
  file: FILE, bytes: raw.length, md5: crypto.createHash("md5").update(raw).digest("hex"),
  header_fields: header.length, data_rows: rows.length,
  date_range: [rowDates.find(Boolean), [...rowDates].reverse().find(Boolean)].map((d) => d && yymmdd(d)),
  units: units.size, events: events.length, transfers: transfers.length,
  location_moves: [...units.values()].reduce((a, u) => a + u.moves.length, 0),
  by_type: Object.fromEntries([...units.values()].reduce((m, u) => m.set(u.type, (m.get(u.type) || 0) + 1), new Map())),
  by_status: Object.fromEntries([...units.values()].reduce((m, u) => m.set(u.status, (m.get(u.status) || 0) + 1), new Map())),
  by_strain: Object.fromEntries([...units.values()].reduce((m, u) => m.set(u.strainResolved, (m.get(u.strainResolved) || 0) + 1), new Map())),
  by_function: Object.fromEntries(events.reduce((m, e) => m.set(e.fn, (m.get(e.fn) || 0) + 1), new Map())),
  strain_defaulted_to_GT: defaulted, general_column_entries_skipped: general.length,
};
const sample = [...units.values()].slice(0, 5).map((u) => ({ label: u.label, code: u.code, type: u.type, substrate: u.substrate, strain: u.strainResolved,
  parent: u.parent, status: u.status, location: u.location, events: u.events.slice(0, 3).map((e) => ({ fn: e.fn, time: e.time.toISOString(), title: e.title })) }));
const anomalyCounts = Object.fromEntries(anomalies.reduce((m, a) => m.set(a.kind, (m.get(a.kind) || 0) + 1), new Map()));
console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "DRY RUN", summary, anomalyCounts, sample }, null, 2));
if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ summary, anomalies, general, units: [...units.values()].map(({ cells, events, ...u }) => ({ ...u, events: events.length })), transfers }, null, 2));
if (anomalyCounts.row_field_count && APPLY) { console.error("Refusing to apply: rows with wrong field count (file is not a faithful export)."); process.exit(1); }
if (!APPLY) process.exit(0);

// ---------- apply (single transaction) ----------
const { pool } = await import("../src/db.js");
const conn = await pool.getConnection();
const SENSOR = ["environment_readings", "datalogger_values", "datalogger_samples", "datalogger_variables", "environment_channel_map", "environment_sources", "trend_presets", "dashboard_layouts"];
const count = async (t) => Number((await conn.query(`SELECT COUNT(*) n FROM \`${t}\``))[0].n);
try {
  const before = {}; for (const t of SENSOR) before[t] = await count(t);
  await conn.beginTransaction();
  for (const s of new Set([...units.values()].map((u) => u.strainResolved)))
    await conn.query("INSERT IGNORE INTO strains (code, name, species) VALUES (?, ?, ?)", [s, s, "Psilocybe cubensis"]);
  await conn.query("DELETE FROM transfers"); await conn.query("DELETE FROM events"); await conn.query("DELETE FROM unit_locations");
  await conn.query("UPDATE units SET parent_unit_code = NULL"); await conn.query("DELETE FROM units");
  for (const u of units.values())
    await conn.query("INSERT INTO units (code,type,strain_code,status,batch_time,parent_unit_code,substrate,current_location,description,notes) VALUES (?,?,?,?,?,NULL,?,?,?,?)",
      [u.code, u.type, u.strainResolved, u.status, noonHelsinkiUtc(u.batch), u.substrate, u.location, `Imported from sheet column ${u.column}`, `Original unit label: ${u.label}`]);
  for (const u of units.values()) if (u.parent) await conn.query("UPDATE units SET parent_unit_code=? WHERE code=?", [u.parent, u.code]);
  for (const e of events)
    await conn.query("INSERT INTO events (id,function_code,unit_code,event_time,title,description,note,status_change) VALUES (?,?,?,?,?,?,?,?)",
      [e.id, e.fn, e.unit, e.time, e.title, e.description, e.note, e.status]);
  for (const t of transfers)
    await conn.query("INSERT INTO transfers (id,source_unit_code,target_unit_code,transfer_time,method,amount,note) VALUES (?,?,?,?,?,?,?)",
      [t.id, t.source, t.target, t.time, "Sheet import: inoculation", t.amount, t.note]);
  for (const u of units.values()) for (const m of u.moves)
    await conn.query("INSERT INTO unit_locations (unit_code,location,moved_at,note) VALUES (?,?,?,?)", [u.code, m.location, m.time, `Sheet line ${m.line} (${m.raw})`]);
  for (const t of SENSOR) if ((await count(t)) !== before[t]) throw new Error(`sensor table ${t} changed`);
  await conn.commit();
  console.log("APPLIED", { units: await count("units"), events: await count("events"), transfers: await count("transfers"), unit_locations: await count("unit_locations"), sensor_counts: before });
} catch (err) { await conn.rollback(); console.error("ROLLED BACK:", err.message); process.exitCode = 1; }
finally { conn.release(); await pool.end(); }
