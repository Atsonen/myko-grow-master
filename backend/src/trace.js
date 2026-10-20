// Traceability API: origins (multi-parent / non-unit sources), computed strain inheritance,
// bulk create / bulk events / bulk location / hide, genealogy, timeline and export.
// Every write runs in a transaction with @myko_actor/@myko_op set; DB triggers write audit_log.
import { query, withConnection } from "./db.js";

export const ORIGIN_TYPES = ["UNIT", "SPORES", "PURCHASED", "STRAIN_LIBRARY", "OTHER", "UNKNOWN"];
const JAR_SUBSTRATE = { FCR: "FCR", OAT: "OAT", BR: "BR", GS: "GRAIN", RIS: "RICE" };
const TYPES = ["BOX", "JAR", "PD", "LC", "BAG", "OTHER"];

const dt = (d) => new Date(d).toISOString().slice(0, 23).replace("T", " ");
const iso = (d) => (d ? new Date(d).toISOString() : null);
const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const newOp = (kind) => `op-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function noonHelsinki(yymmdd) {
  const y = 2000 + +yymmdd.slice(0, 2), m = +yymmdd.slice(2, 4), d = +yymmdd.slice(4, 6);
  const last = (mo) => { const t = new Date(Date.UTC(y, mo, 0)); return t.getUTCDate() - t.getUTCDay(); };
  const dst = (m > 3 && m < 10) || (m === 3 && d >= last(3)) || (m === 10 && d < last(10));
  return new Date(Date.UTC(y, m - 1, d, dst ? 9 : 10));
}

// All-or-nothing. dryRun executes the identical statements and rolls back, so the preview is exact.
async function tx(actor, op, fn, dryRun = false) {
  return withConnection(async (conn) => {
    await conn.query("SET @myko_actor = ?, @myko_op = ?", [actor, op]);
    await conn.beginTransaction();
    try { const r = await fn(conn); if (dryRun) await conn.rollback(); else await conn.commit(); return r; }
    catch (e) { await conn.rollback(); throw e; }
    finally { await conn.query("SET @myko_actor = NULL, @myko_op = NULL"); }
  });
}

// ---------- graph ----------
async function loadGraph(conn = null) {
  const q = conn ? (s, p) => conn.query(s, p) : query;
  const [units, origins] = await Promise.all([q("SELECT * FROM units"), q("SELECT * FROM unit_origins ORDER BY id")]);
  const byCode = new Map(units.map((u) => [u.code, u]));
  const parents = new Map(); const children = new Map(); const originsBy = new Map();
  for (const o of origins) {
    if (!originsBy.has(o.unit_code)) originsBy.set(o.unit_code, []);
    originsBy.get(o.unit_code).push(o);
    if (o.origin_type === "UNIT" && o.parent_unit_code) {
      if (!parents.has(o.unit_code)) parents.set(o.unit_code, []);
      parents.get(o.unit_code).push(o.parent_unit_code);
      if (!children.has(o.parent_unit_code)) children.set(o.parent_unit_code, []);
      children.get(o.parent_unit_code).push(o.unit_code);
    }
  }
  // legacy single parent column (kept in sync as "primary parent")
  for (const u of units) if (u.parent_unit_code && !(parents.get(u.code) || []).includes(u.parent_unit_code)) {
    if (!parents.has(u.code)) parents.set(u.code, []); parents.get(u.code).push(u.parent_unit_code);
    if (!children.has(u.parent_unit_code)) children.set(u.parent_unit_code, []); children.get(u.parent_unit_code).push(u.code);
  }
  const memo = new Map();
  // Strain inheritance is COMPUTED (not copied): own strain, else the FIRST parent's effective strain.
  // "First" = earliest unit_origins row (lowest id); never "mixed", no fallback to other parents.
  const effective = (code, seen = new Set()) => {
    if (memo.has(code)) return memo.get(code);
    const u = byCode.get(code); if (!u || seen.has(code)) return { strain: null, from: null };
    seen.add(code);
    let r = { strain: u.strain_code || null, from: u.strain_code ? code : null };
    const first = (parents.get(code) || [])[0];
    if (!r.strain && first) { const e = effective(first, seen); if (e.strain) r = e; }
    memo.set(code, r); return r;
  };
  return { units, byCode, parents, children, originsBy, effective };
}

const mapOrigin = (o) => ({ id: Number(o.id), type: o.origin_type, parentUnitCode: o.parent_unit_code ?? undefined, note: o.note ?? undefined, createdAt: iso(o.created_at) });

export function enrichUnit(g, row, mapUnit) {
  const e = g.effective(row.code);
  return { ...mapUnit(row), hidden: Boolean(row.hidden), hiddenAt: iso(row.hidden_at) ?? undefined,
    origins: (g.originsBy.get(row.code) || []).map(mapOrigin),
    parentUnitCodes: g.parents.get(row.code) || [],
    effectiveStrainCode: e.strain, strainInheritedFrom: e.strain && e.from !== row.code ? e.from : undefined };
}

function walk(g, start, dir) {
  const next = dir === "up" ? g.parents : g.children;
  const out = []; const seen = new Set([start]); let frontier = [start]; let depth = 0;
  const edges = [];
  while (frontier.length && depth < 50) {
    depth++; const nf = [];
    for (const c of frontier) for (const n of next.get(c) || []) {
      edges.push(dir === "up" ? { parent: n, child: c } : { parent: c, child: n });
      if (seen.has(n)) continue; seen.add(n); nf.push(n); out.push({ code: n, depth, via: c });
    }
    frontier = nf;
  }
  return { nodes: out, edges };
}

export function normalizeOrigins(list) {
  if (!Array.isArray(list)) return [];
  return list.map((o) => {
    const type = String(o?.type || "").toUpperCase();
    if (!ORIGIN_TYPES.includes(type)) throw new Error(`origin.type must be one of ${ORIGIN_TYPES.join(", ")}`);
    const parent = type === "UNIT" ? str(o.parentUnitCode) : null;
    if (type === "UNIT" && !parent) throw new Error("origin.parentUnitCode is required for UNIT origins");
    return { type, parent, note: str(o.note) };
  });
}

export async function writeOrigins(conn, code, origins, { replace }) {
  for (const o of origins) {
    if (o.parent === code) throw new Error(`Unit ${code} cannot be its own parent`);
    if (o.parent && !(await conn.query("SELECT 1 FROM units WHERE code = ?", [o.parent])).length) throw new Error(`Unknown parent unit ${o.parent}`);
  }
  if (replace) await conn.query("DELETE FROM unit_origins WHERE unit_code = ?", [code]);
  for (const o of origins)
    await conn.query("INSERT IGNORE INTO unit_origins (unit_code, origin_type, parent_unit_code, note) VALUES (?, ?, ?, ?)", [code, o.type, o.parent, o.note]);
  // keep the legacy column = first parent unit (or NULL)
  const [first] = await conn.query("SELECT parent_unit_code FROM unit_origins WHERE unit_code = ? AND origin_type = 'UNIT' ORDER BY id LIMIT 1", [code]);
  await conn.query("UPDATE units SET parent_unit_code = ? WHERE code = ?", [first?.parent_unit_code ?? null, code]);
  if (origins.some((o) => o.parent)) {
    const g = await loadGraph(conn);
    if (walk(g, code, "up").nodes.some((n) => n.code === code)) throw new Error("Origin would create a cycle");
  }
}

async function addMove(conn, code, location, at, note) {
  const [latest] = await conn.query("SELECT location FROM unit_locations WHERE unit_code = ? AND archived = 0 ORDER BY moved_at DESC, id DESC LIMIT 1", [code]);
  if (latest && latest.location === location) return false;
  await conn.query("INSERT INTO unit_locations (unit_code, location, moved_at, note) VALUES (?, ?, ?, ?)", [code, location, dt(at), note]);
  const [cur] = await conn.query("SELECT location FROM unit_locations WHERE unit_code = ? AND archived = 0 ORDER BY moved_at DESC, id DESC LIMIT 1", [code]);
  await conn.query("UPDATE units SET current_location = ?, updated_at = updated_at WHERE code = ?", [cur.location, code]);
  return true;
}

async function insertEvents(conn, { unitCodes, functionCode, eventTime, title, note, description, statusChange, temperatureC, humidityRh, op }) {
  const ids = [];
  for (const [i, code] of unitCodes.entries()) {
    const id = `evt-${op}-${i + 1}`;
    await conn.query(`INSERT INTO events (id, function_code, unit_code, event_time, title, description, note, temperature_c, humidity_rh, status_change, operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, functionCode, code, dt(eventTime), title, description, note, temperatureC, humidityRh, statusChange, op]);
    if (statusChange) await conn.query("UPDATE units SET status = ? WHERE code = ?", [statusChange, code]);
    ids.push(id);
  }
  return ids;
}

async function assertUnits(conn, codes) {
  if (!codes.length) throw new Error("unitCodes must contain at least one unit");
  const rows = await conn.query(`SELECT code FROM units WHERE code IN (${codes.map(() => "?").join(",")})`, codes);
  const have = new Set(rows.map((r) => r.code)); const missing = codes.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`Unknown units: ${missing.join(", ")}`);
}
const SOURCES = ["ui", "chat", "api", "script"];
// audit actor = source of the request (ui | chat | api | script)
const actorOf = (b) => { const s = String(b?.source || "api").toLowerCase(); if (!SOURCES.includes(s)) throw new Error(`source must be one of ${SOURCES.join(", ")}`); return s; };
const isDry = (req) => req.body?.dryRun === true || req.query.dryRun === "true" || req.query.dryRun === "1";

// Selection: explicit unitCodes OR filter { status, location, type, substrate, codePrefix, batchFrom, batchTo, includeHidden, order, limit }.
async function resolveSelection(conn, b) {
  const explicit = codesOf(b);
  const f = b?.filter;
  if (explicit.length && f) throw new Error("Use either unitCodes or filter, not both");
  if (explicit.length) { await assertUnits(conn, explicit); return explicit; }
  if (!f || typeof f !== "object") throw new Error("unitCodes or filter is required");
  const w = []; const p = [];
  const list = (v) => (Array.isArray(v) ? v : [v]).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  const inList = (col, v) => { const l = list(v); if (l.length) { w.push(`${col} IN (${l.map(() => "?").join(",")})`); p.push(...l); } };
  if (f.status) inList("status", f.status);
  if (f.type) inList("type", f.type);
  if (f.substrate) inList("substrate", f.substrate);
  if (f.location !== undefined) {
    if (f.location === null || f.location === "" || String(f.location).toUpperCase() === "NONE") w.push("current_location IS NULL");
    else inList("current_location", f.location);
  }
  if (f.codePrefix) { w.push("code LIKE ?"); p.push(`${String(f.codePrefix).toUpperCase().replace(/[%_]/g, "\\$&")}%`); }
  if (f.batchFrom) { w.push("batch_time >= ?"); p.push(dt(f.batchFrom)); }
  if (f.batchTo) { w.push("batch_time < ?"); p.push(dt(f.batchTo)); }
  if (!f.includeHidden) w.push("hidden = 0");
  if (!w.length || (w.length === 1 && w[0] === "hidden = 0")) throw new Error("filter must contain at least one criterion");
  const order = String(f.order || "batch_asc");
  const orderSql = { batch_asc: "batch_time ASC, code ASC", batch_desc: "batch_time DESC, code DESC", code_asc: "code ASC", code_desc: "code DESC" }[order];
  if (!orderSql) throw new Error("filter.order must be batch_asc | batch_desc | code_asc | code_desc");
  const limit = f.limit === undefined ? null : Number(f.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new Error("filter.limit must be 1..1000");
  const rows = await conn.query(`SELECT code FROM units WHERE ${w.join(" AND ")} ORDER BY ${orderSql}${limit ? ` LIMIT ${limit}` : ""} FOR UPDATE`, p);
  if (!rows.length) throw new Error("filter matched no units");
  if (f.expectCount !== undefined && rows.length !== Number(f.expectCount)) throw new Error(`filter matched ${rows.length} units, expected ${f.expectCount}`);
  return rows.map((r) => r.code);
}
const snapshot = async (conn, codes) => {
  const rows = await conn.query(`SELECT code, status, current_location, hidden, strain_code FROM units WHERE code IN (${codes.map(() => "?").join(",")})`, codes);
  return new Map(rows.map((r) => [r.code, { status: r.status, location: r.current_location ?? null, hidden: Boolean(r.hidden) }]));
};
const diff = (before, after, codes) => codes.map((c) => ({ code: c, before: before.get(c), after: after.get(c),
  changed: JSON.stringify(before.get(c)) !== JSON.stringify(after.get(c)) }));

const codesOf = (b) => Array.from(new Set((Array.isArray(b?.unitCodes) ? b.unitCodes : []).map((c) => String(c).trim()).filter(Boolean)));
const num = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------- environment summary over location periods ----------
async function environmentSummary(code) {
  const [u] = await query("SELECT batch_time, status, updated_at, current_location FROM units WHERE code = ?", [code]);
  const start = new Date(u.batch_time);
  let end = new Date();
  if (["ARCHIVED", "DISCARDED", "HARVESTED", "CONTAMINATED"].includes(u.status)) {
    const [ev] = await query("SELECT MAX(event_time) m FROM events WHERE unit_code = ? AND archived = 0", [code]);
    end = new Date(ev?.m || u.updated_at); if (end < start) end = new Date(u.updated_at);
  }
  const hist = await query("SELECT location, moved_at FROM unit_locations WHERE unit_code = ? AND archived = 0 ORDER BY moved_at, id", [code]);
  const periods = [];
  hist.forEach((h, i) => {
    const from = new Date(Math.max(new Date(h.moved_at).getTime(), start.getTime()));
    const to = i + 1 < hist.length ? new Date(hist[i + 1].moved_at) : end;
    if (to > from) periods.push({ location: h.location, from, to });
  });
  const out = [];
  for (const p of periods) {
    const [r] = await query(`SET STATEMENT max_statement_time=5 FOR
      SELECT COUNT(*) n, MIN(CASE WHEN temperature_c > -100 THEN temperature_c END) tmin, AVG(CASE WHEN temperature_c > -100 THEN temperature_c END) tavg,
             MAX(CASE WHEN temperature_c > -100 THEN temperature_c END) tmax, AVG(CASE WHEN humidity_rh BETWEEN 0 AND 100 THEN humidity_rh END) rh
      FROM environment_readings WHERE location = ? AND timestamp >= ? AND timestamp < ? AND archived = 0`, [p.location, dt(p.from), dt(p.to)]);
    const f = (v, d = 2) => (v === null || v === undefined ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
    out.push({ location: p.location, from: iso(p.from), to: iso(p.to), readings: Number(r.n), temperatureMin: f(r.tmin), temperatureAvg: f(r.tavg), temperatureMax: f(r.tmax), humidityAvg: f(r.rh, 1) });
  }
  return { from: iso(start), to: iso(end), periods: out, unlocatedNote: hist.length ? undefined : "No location history recorded" };
}

async function unitRecords(codes) {
  if (!codes.length) return { events: [], transfers: [], moves: [], audit: [] };
  const ph = codes.map(() => "?").join(",");
  const [events, transfers, moves, audit] = await Promise.all([
    query(`SELECT * FROM events WHERE unit_code IN (${ph}) AND archived = 0 ORDER BY event_time, id`, codes),
    query(`SELECT * FROM transfers WHERE (source_unit_code IN (${ph}) OR target_unit_code IN (${ph})) AND archived = 0 ORDER BY transfer_time, id`, [...codes, ...codes]),
    query(`SELECT * FROM unit_locations WHERE unit_code IN (${ph}) ORDER BY moved_at, id`, codes),
    query(`SELECT * FROM audit_log WHERE unit_code IN (${ph}) ORDER BY at, id`, codes),
  ]);
  return { events, transfers, moves, audit };
}

async function buildTrace(code, mappers) {
  const g = await loadGraph();
  const row = g.byCode.get(code); if (!row) return null;
  const up = walk(g, code, "up"); const down = walk(g, code, "down");
  const node = (n) => { const u = g.byCode.get(n.code); return { ...n, type: u?.type, status: u?.status, strainCode: u?.strain_code ?? null,
    effectiveStrainCode: g.effective(n.code).strain, batchTime: iso(u?.batch_time), currentLocation: u?.current_location ?? null, hidden: Boolean(u?.hidden),
    origins: (g.originsBy.get(n.code) || []).map(mapOrigin) }; };
  const own = await unitRecords([code]);
  const timeline = [
    ...own.events.map((e) => ({ at: iso(e.event_time), kind: "event", functionCode: e.function_code, title: e.title, detail: [e.description, e.note].filter(Boolean).join(" — ") || undefined, statusChange: e.status_change ?? undefined, operationId: e.operation_id ?? undefined, id: e.id })),
    ...own.transfers.map((t) => ({ at: iso(t.transfer_time), kind: t.target_unit_code === code ? "transfer-in" : "transfer-out", title: t.target_unit_code === code ? `From ${t.source_unit_code}` : `To ${t.target_unit_code}`, detail: [t.method, t.amount, t.note].filter(Boolean).join(" — ") || undefined, id: t.id })),
    ...own.moves.map((m) => ({ at: iso(m.moved_at), kind: m.archived ? "move-undone" : "move", title: `Location → ${m.location}`, detail: m.note ?? undefined, id: String(m.id) })),
    ...own.audit.map((a) => ({ at: iso(a.at), kind: "audit", title: `${a.entity_type} ${a.action}${a.changed_fields ? ` (${a.changed_fields})` : ""}`, actor: a.actor ?? undefined, operationId: a.operation_id ?? undefined,
      before: a.before_json ? JSON.parse(a.before_json) : undefined, after: a.after_json ? JSON.parse(a.after_json) : undefined, id: String(a.id) })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { generatedAt: new Date().toISOString(), unit: enrichUnit(g, row, mappers.mapUnit), ancestors: up.nodes.map(node), descendants: down.nodes.map(node),
    edges: [...up.edges, ...down.edges], timeline, environment: await environmentSummary(code) };
}

const csvCell = (v) => { const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function registerTraceRoutes(app, { mapUnit, mapEvent, mapTransfer, mapUnitLocation, asyncRoute }) {
  app.get("/api/units", asyncRoute(async (_req, res) => {
    const g = await loadGraph();
    const rows = [...g.units].sort((a, b) => (new Date(b.batch_time) - new Date(a.batch_time)) || (a.code < b.code ? -1 : 1));
    res.json(rows.map((r) => enrichUnit(g, r, mapUnit)));
  }));
  app.get("/api/units/:code", asyncRoute(async (req, res, next) => {
    const g = await loadGraph(); const r = g.byCode.get(String(req.params.code));
    if (!r) return res.status(404).json({ error: `Unit ${req.params.code} not found` });
    res.json(enrichUnit(g, r, mapUnit));
  }));

  app.get("/api/origin-types", (_req, res) => res.json(ORIGIN_TYPES));

  // Replace a unit's origins. Body: { origins: [{type, parentUnitCode?, note?}] }
  app.put("/api/units/:code/origins", asyncRoute(async (req, res) => {
    const code = String(req.params.code); const origins = normalizeOrigins(req.body?.origins);
    await tx("api", newOp("origins"), async (conn) => {
      await assertUnits(conn, [code]); await writeOrigins(conn, code, origins, { replace: true });
    });
    const g = await loadGraph(); res.json(enrichUnit(g, g.byCode.get(code), mapUnit));
  }));

  // Bulk create. Body: { base:"261013-JAR"|"261013-FCR", count, type?, substrate?, strainCode?, status?, batchTime?, location?, origins?, notes?, description? }
  app.post("/api/units/bulk", asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    const m = /^(\d{6})-([A-Z]+)$/.exec(String(b.base || "").trim().toUpperCase());
    if (!m) throw new Error("base must look like YYMMDD-TYPE, e.g. 261013-JAR or 261013-FCR");
    const count = Number(b.count); if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error("count must be 1..200");
    let token = m[2]; let substrate = str(b.substrate)?.toUpperCase() ?? null;
    if (JAR_SUBSTRATE[token]) { substrate = substrate || JAR_SUBSTRATE[token]; token = "JAR"; }
    const type = (str(b.type)?.toUpperCase()) || (TYPES.includes(token) ? token : null);
    if (!type || !TYPES.includes(type)) throw new Error(`Unknown type ${token}; use one of ${TYPES.join(", ")} or FCR/OAT/BR/GS/RIS`);
    const prefix = `${m[1]}-${token}-`;
    const batchTime = b.batchTime ? new Date(b.batchTime) : noonHelsinki(m[1]);
    if (Number.isNaN(batchTime.getTime())) throw new Error("batchTime is invalid");
    const strain = str(b.strainCode)?.replace(/^#+/, "").toUpperCase() ?? null;
    const status = (str(b.status) || "ACTIVE").toUpperCase();
    const location = str(b.location)?.toUpperCase() ?? null;
    const origins = normalizeOrigins(b.origins);
    const op = newOp("bulkcreate"); const actor = actorOf(b); const dryRun = isDry(req);
    const created = await tx(actor, op, async (conn) => {
      if (strain && !(await conn.query("SELECT 1 FROM strains WHERE code = ?", [strain])).length) throw new Error(`Unknown strain #${strain}`);
      const rows = await conn.query("SELECT code FROM units WHERE code LIKE ? FOR UPDATE", [`${prefix}%`]);
      let max = 0; for (const r of rows) { const n = new RegExp(`^${prefix}(\\d+)$`).exec(r.code); if (n) max = Math.max(max, +n[1]); }
      const codes = [];
      for (let i = 1; i <= count; i++) {
        const code = `${prefix}${max + i}`; codes.push(code);
        await conn.query(`INSERT INTO units (code, type, strain_code, status, batch_time, substrate, description, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [code, type, strain, status, dt(batchTime), substrate, str(b.description), str(b.notes) ?? `Bulk-created (${op})`]);
        if (origins.length) await writeOrigins(conn, code, origins, { replace: false });
        if (location) await addMove(conn, code, location, batchTime, `Bulk create ${op}`);
      }
      return codes;
    }, dryRun);
    res.status(dryRun ? 200 : 201).json({ ok: true, dryRun, operationId: dryRun ? null : op, source: actor, codes: created,
      unit: { type, substrate, strainCode: strain, status, batchTime: batchTime.toISOString(), location, origins } });
  }));

  // One event to many units; each gets its own row, linked by operation_id.
  // Body: { unitCodes, functionCode, eventTime?, title, note?, statusChange?, temperatureC?, humidityRh?, sourceUnitCode?, method?, amount? }
  // With sourceUnitCode (inoculation): also writes a transfer per unit and adds the source as a UNIT origin.
  app.post(["/api/events/bulk", "/api/events"], asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    const functionCode = String(b.functionCode || "").toUpperCase(); if (!functionCode) throw new Error("functionCode is required");
    const title = str(b.title); if (!title) throw new Error("title is required");
    const eventTime = b.eventTime ? new Date(b.eventTime) : new Date(); if (Number.isNaN(eventTime.getTime())) throw new Error("eventTime is invalid");
    const statusChange = str(b.statusChange)?.toUpperCase() ?? null;
    const source = str(b.sourceUnitCode);
    const actor = actorOf(b); const dryRun = isDry(req);
    const op = newOp(b.unitCode ? "event" : "bulkevent");
    let unitCodes = []; let before;
    const ids = await tx(actor, op, async (conn) => {
      unitCodes = b.unitCode ? [String(b.unitCode).trim()] : await resolveSelection(conn, b);
      await assertUnits(conn, source ? [...unitCodes, source] : unitCodes);
      before = await snapshot(conn, unitCodes);
      const ids = await insertEvents(conn, { unitCodes, functionCode, eventTime, title, note: str(b.note), description: str(b.description), statusChange,
        temperatureC: num(b.temperatureC), humidityRh: num(b.humidityRh), op });
      if (source) for (const [i, code] of unitCodes.entries()) {
        if (code === source) continue;
        await conn.query("INSERT INTO transfers (id, source_unit_code, target_unit_code, transfer_time, method, amount, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [`trf-${op}-${i + 1}`, source, code, dt(eventTime), str(b.method) || title, str(b.amount) || "", `Operation ${op}`]);
        await writeOrigins(conn, code, [{ type: "UNIT", parent: source, note: `Inoculation ${op}` }], { replace: false });
      }
      return { ids, units: diff(before, await snapshot(conn, unitCodes), unitCodes) };
    }, dryRun);
    res.status(dryRun ? 200 : 201).json({ ok: true, dryRun, operationId: dryRun ? null : op, source: actor, count: unitCodes.length,
      eventIds: dryRun ? [] : ids.ids, transfers: source ? unitCodes.filter((c) => c !== source).length : 0, units: ids.units });
  }));

  // Single transfer (optionally creating the target). Body: { sourceUnitCode, targetUnitCode, transferTime?, method, amount, note?, targetUnit?: {type, substrate?, strainCode?} }
  app.post("/api/transfers", asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    const source = str(b.sourceUnitCode), target = str(b.targetUnitCode)?.toUpperCase();
    if (!source || !target) throw new Error("sourceUnitCode and targetUnitCode are required");
    const at = b.transferTime ? new Date(b.transferTime) : new Date();
    const op = newOp("transfer");
    await tx("api", op, async (conn) => {
      await assertUnits(conn, [source]);
      const exists = (await conn.query("SELECT 1 FROM units WHERE code = ?", [target])).length > 0;
      if (!exists) {
        if (!b.targetUnit) throw new Error(`Target unit ${target} does not exist`);
        await conn.query("INSERT INTO units (code, type, strain_code, status, batch_time, substrate, notes) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)",
          [target, String(b.targetUnit.type || "OTHER").toUpperCase(), str(b.targetUnit.strainCode), dt(at), str(b.targetUnit.substrate), str(b.targetUnit.notes) ?? `Created from transfer ${source} → ${target}`]);
      }
      await conn.query("INSERT INTO transfers (id, source_unit_code, target_unit_code, transfer_time, method, amount, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`trf-${op}`, source, target, dt(at), str(b.method) || "Transfer", str(b.amount) || "", str(b.note)]);
      await writeOrigins(conn, target, [{ type: "UNIT", parent: source, note: `Transfer ${op}` }], { replace: false });
      await insertEvents(conn, { unitCodes: [target], functionCode: "TRF", eventTime: at, title: `Inoculated from ${source}`, note: [b.method, b.amount, b.note].filter(Boolean).join(" — ") || null, op });
    });
    res.status(201).json({ ok: true, operationId: op, transferId: `trf-${op}` });
  }));

  // Bulk location. Body: { unitCodes, location, movedAt?, note? }
  app.post("/api/units/bulk-location", asyncRoute(async (req, res) => {
    const location = str(req.body?.location)?.toUpperCase();
    if (!location) throw new Error("location is required");
    const at = req.body?.movedAt ? new Date(req.body.movedAt) : new Date();
    if (Number.isNaN(at.getTime())) throw new Error("movedAt is invalid");
    const actor = actorOf(req.body); const dryRun = isDry(req); const op = newOp("bulkmove");
    const r = await tx(actor, op, async (conn) => {
      const codes = await resolveSelection(conn, req.body); const before = await snapshot(conn, codes); let n = 0;
      for (const c of codes) if (await addMove(conn, c, location, at, str(req.body?.note) ?? `Bulk location ${op} (${actor})`)) n++;
      return { codes, moved: n, units: diff(before, await snapshot(conn, codes), codes) };
    }, dryRun);
    res.json({ ok: true, dryRun, operationId: dryRun ? null : op, source: actor, count: r.codes.length, moved: r.moved, unchanged: r.codes.length - r.moved, units: r.units });
  }));

  // Hide / unhide (visibility only; status and history untouched). Body: { unitCodes, hidden: true|false }
  app.post("/api/units/bulk-hide", asyncRoute(async (req, res) => {
    const hidden = req.body?.hidden !== false;
    const actor = actorOf(req.body); const dryRun = isDry(req); const op = newOp(hidden ? "hide" : "unhide");
    // unhide must be able to select hidden units
    if (!hidden && req.body?.filter) req.body.filter.includeHidden = true;
    const r = await tx(actor, op, async (conn) => {
      const codes = await resolveSelection(conn, req.body); const before = await snapshot(conn, codes);
      await conn.query(`UPDATE units SET hidden = ?, hidden_at = ${hidden ? "UTC_TIMESTAMP(3)" : "NULL"} WHERE code IN (${codes.map(() => "?").join(",")}) AND hidden <> ?`, [hidden ? 1 : 0, ...codes, hidden ? 1 : 0]);
      return { codes, units: diff(before, await snapshot(conn, codes), codes) };
    }, dryRun);
    res.json({ ok: true, dryRun, operationId: dryRun ? null : op, source: actor, count: r.codes.length, changed: r.units.filter((u) => u.changed).length, hidden, units: r.units });
  }));

  // Preview a selection without changing anything. Body: { unitCodes } or { filter }
  app.post("/api/units/select", asyncRoute(async (req, res) => {
    const r = await tx(actorOf(req.body), null, async (conn) => { const codes = await resolveSelection(conn, req.body); return { codes, snap: await snapshot(conn, codes) }; }, true);
    res.json({ ok: true, count: r.codes.length, units: r.codes.map((c) => ({ code: c, ...r.snap.get(c) })) });
  }));

  app.get("/api/units/:code/trace", asyncRoute(async (req, res) => {
    const t = await buildTrace(String(req.params.code), { mapUnit });
    if (!t) return res.status(404).json({ error: "Unit not found" });
    res.json(t);
  }));

  app.get("/api/audit", asyncRoute(async (req, res) => {
    const params = []; let where = "1=1";
    if (req.query.unitCode) { where += " AND unit_code = ?"; params.push(String(req.query.unitCode)); }
    if (req.query.operationId) { where += " AND operation_id = ?"; params.push(String(req.query.operationId)); }
    const limit = Math.min(Number(req.query.limit) || 200, 2000);
    const rows = await query(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ${limit}`, params);
    res.json(rows.map((a) => ({ id: Number(a.id), at: iso(a.at), entityType: a.entity_type, entityId: a.entity_id, unitCode: a.unit_code, action: a.action,
      changedFields: a.changed_fields ?? undefined, before: a.before_json ? JSON.parse(a.before_json) : undefined, after: a.after_json ? JSON.parse(a.after_json) : undefined,
      actor: a.actor, operationId: a.operation_id ?? undefined })));
  }));

  // Traceability export: unit + full ancestry (each ancestor's events, moves, transfers) + descendants + environment summary.
  app.get("/api/units/:code/export", asyncRoute(async (req, res) => {
    const code = String(req.params.code); const format = String(req.query.format || "json").toLowerCase();
    const t = await buildTrace(code, { mapUnit }); if (!t) return res.status(404).json({ error: "Unit not found" });
    const ancCodes = t.ancestors.map((a) => a.code);
    const anc = await unitRecords(ancCodes);
    const ancestorRecords = Object.fromEntries(ancCodes.map((c) => [c, {
      events: anc.events.filter((e) => e.unit_code === c).map(mapEvent),
      moves: anc.moves.filter((m) => m.unit_code === c).map(mapUnitLocation),
      transfersIn: anc.transfers.filter((x) => x.target_unit_code === c).map(mapTransfer) }]));
    const ancestorEnv = {}; for (const c of ancCodes) ancestorEnv[c] = await environmentSummary(c);
    const doc = { ...t, ancestorRecords, ancestorEnvironment: ancestorEnv };
    const fname = `myko-trace-${code}-${new Date().toISOString().slice(0, 10)}`;
    if (format === "csv") {
      const rows = [["unit_code", "relation", "depth", "record_type", "time", "title", "detail", "status_or_location", "operation_id"]];
      const u = t.unit;
      rows.push([u.code, "self", 0, "unit", u.batchTime, `${u.type} ${u.substrate ?? ""}`.trim(), `strain=${u.effectiveStrainCode ?? ""}${u.strainInheritedFrom ? ` (inherited from ${u.strainInheritedFrom})` : ""}; origins=${u.origins.map((o) => o.type + (o.parentUnitCode ? ":" + o.parentUnitCode : "")).join("|")}`, u.status, ""]);
      for (const e of t.timeline) if (e.kind !== "audit") rows.push([code, "self", 0, e.kind, e.at, e.title, e.detail ?? "", e.statusChange ?? "", e.operationId ?? ""]);
      for (const p of t.environment.periods) rows.push([code, "self", 0, "environment", p.from, `${p.location} until ${p.to}`, `n=${p.readings} T min/avg/max=${p.temperatureMin}/${p.temperatureAvg}/${p.temperatureMax} RH avg=${p.humidityAvg}`, p.location, ""]);
      for (const a of t.ancestors) {
        rows.push([a.code, "ancestor", a.depth, "unit", a.batchTime, a.type, `strain=${a.effectiveStrainCode ?? ""}; origins=${a.origins.map((o) => o.type + (o.parentUnitCode ? ":" + o.parentUnitCode : "")).join("|")}`, a.status, ""]);
        for (const e of ancestorRecords[a.code].events) rows.push([a.code, "ancestor", a.depth, "event", e.eventTime, e.title, [e.functionCode, e.note].filter(Boolean).join(" — "), e.statusChange ?? "", ""]);
        for (const m of ancestorRecords[a.code].moves) rows.push([a.code, "ancestor", a.depth, m.archived ? "move-undone" : "move", m.movedAt, m.location, m.note ?? "", m.location, ""]);
        for (const p of ancestorEnv[a.code].periods) rows.push([a.code, "ancestor", a.depth, "environment", p.from, `${p.location} until ${p.to}`, `n=${p.readings} T min/avg/max=${p.temperatureMin}/${p.temperatureAvg}/${p.temperatureMax} RH avg=${p.humidityAvg}`, p.location, ""]);
      }
      for (const d of t.descendants) rows.push([d.code, "descendant", d.depth, "unit", d.batchTime, d.type, `strain=${d.effectiveStrainCode ?? ""}`, d.status, ""]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fname}.csv"`);
      return res.send("\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
    }
    res.setHeader("Content-Disposition", `attachment; filename="${fname}.json"`);
    res.json(doc);
  }));
}
