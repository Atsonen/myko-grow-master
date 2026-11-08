// Täyttöveden lähdesäiliön suuntaa-antava käyntiosuus.
// Oma atominen JSON (tmp + rename), sama tyyli kuin fillpump_*.json.
// Ei MQTT-, PLC- eikä tietokantaliikennettä. Polkuja ei lueta moduulin importissa.
// myko_settings jätettiin käyttämättä: se vaatisi MariaDB-yhteyden, eikä tähän saa uutta taulua.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ESTIMATE_LABEL = "Suuntaa-antava arvio · ei mittaus";
export const DEFAULT_REFERENCE_S = 1320;
export const STALE_MS = 30_000;
export const REF_MIN_S = 60;
export const REF_MAX_S = 86_400;
export const SAFETY_MS = 120_000;
export const DEFAULT_STATE_PATH = "/home/atte/.config/myko/fillpump_source.json";
export const DEFAULT_RUNS_PATH = "/home/atte/.config/myko/pump_runs.json";

const PLC_KEYS = new Set([
  "Run", "Cmd_Ack", "Cfg_Enable", "Cfg_LvlSP", "Cfg_Hyst", "Cfg_MaxRun_s", "Cfg_LvlMin", "Cfg_LvlMax", "Pump",
]);

let cfg = {
  paths: null,
  io: fs,
  mem: undefined,
  now: () => Date.now(),
  newId: () => randomUUID(),
  getFreshness: () => ({ lastFreshMs: null, outputOn: null }),
  publish: null,
};
let queue = Promise.resolve();

export function fillSourcePathConfigured() {
  return cfg.paths != null;
}

/** Test / embed: set files and IO. Does not read them. */
export function useFillSourceFiles({ stateFile, runsFile, io, now, newId, getFreshness, publish } = {}) {
  cfg = {
    paths: stateFile && runsFile ? { stateFile, runsFile } : null,
    io: io ?? fs,
    mem: undefined,
    now: now ?? (() => Date.now()),
    newId: newId ?? (() => randomUUID()),
    getFreshness: getFreshness ?? (() => ({ lastFreshMs: null, outputOn: null })),
    publish: publish ?? null,
  };
  queue = Promise.resolve();
}

export function useDefaultFillSourcePaths() {
  useFillSourceFiles({ stateFile: DEFAULT_STATE_PATH, runsFile: DEFAULT_RUNS_PATH });
}

export function resetFillSourceCache() {
  cfg.mem = undefined;
}

function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function paths() {
  if (!cfg.paths) {
    const err = new Error("fillSource-polkuja ei ole asetettu");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  return cfg.paths;
}

export function defaultSourceState() {
  return {
    version: 1,
    anchor: null,
    referenceS: DEFAULT_REFERENCE_S,
    covered: [],
    refLog: [],
    refills: [],
    idempotency: [],
  };
}

function assertState(s) {
  if (!s || s.version !== 1 || !Array.isArray(s.covered) || !Array.isArray(s.refLog) || !Array.isArray(s.idempotency)) {
    const err = new Error("fillpump_source.json on virheellinen");
    err.code = "INVALID_STATE";
    throw err;
  }
  if (!Number.isInteger(s.referenceS) || s.referenceS < REF_MIN_S || s.referenceS > REF_MAX_S) {
    const err = new Error("fillpump_source.json viiteaika on virheellinen");
    err.code = "INVALID_STATE";
    throw err;
  }
  for (const seg of s.covered) {
    if (!Array.isArray(seg) || seg.length !== 2 || !Number.isFinite(seg[0]) || !Number.isFinite(seg[1]) || seg[1] < seg[0]) {
      const err = new Error("fillpump_source.json käyntiyhdiste on virheellinen");
      err.code = "INVALID_STATE";
      throw err;
    }
  }
  if (s.anchor != null && (!s.anchor.id || !Number.isFinite(s.anchor.atMs))) {
    const err = new Error("fillpump_source.json ankkuri on virheellinen");
    err.code = "INVALID_STATE";
    throw err;
  }
  return s;
}

function readStateDisk() {
  const file = paths().stateFile;
  let txt;
  try {
    txt = cfg.io.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    const err = new Error("fillpump_source.json ei ole luettavissa");
    err.code = "INVALID_STATE";
    throw err;
  }
  try {
    return assertState(JSON.parse(txt));
  } catch (e) {
    if (e?.code === "INVALID_STATE") throw e;
    const err = new Error("fillpump_source.json ei ole luettavissa");
    err.code = "INVALID_STATE";
    throw err;
  }
}

function loadState() {
  if (cfg.mem !== undefined) return cfg.mem;
  const disk = readStateDisk();
  cfg.mem = disk;
  return disk;
}

function writeState(next) {
  const file = paths().stateFile;
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.tmp`;
  cfg.io.mkdirSync(dir, { recursive: true });
  cfg.io.writeFileSync(tmp, JSON.stringify(next));
  cfg.io.renameSync(tmp, file);
  cfg.mem = next;
}

export function parsePumpRunsDocument(json) {
  const out = [];
  const savedAtMs = json?.savedAt ? Date.parse(json.savedAt) : null;
  if (json && Array.isArray(json.closed)) {
    for (const r of json.closed) {
      if (!r || r.pump !== "fill") continue;
      const startMs = Number(r.start);
      const endMs = Number(r.end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) continue;
      out.push({ pump: "fill", startMs, endMs, open: false });
    }
  }
  const openFill = Number(json?.open?.fill);
  if (Number.isFinite(openFill) && openFill > 0) out.push({ pump: "fill", startMs: openFill, open: true });
  return { intervals: out, savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : null };
}

function readRuns() {
  const file = paths().runsFile;
  let txt;
  try {
    txt = cfg.io.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { intervals: [], savedAtMs: null, readable: true };
    const err = new Error("pump_runs.json ei ole luettavissa");
    err.code = "INVALID_RUNS";
    throw err;
  }
  try {
    return { ...parsePumpRunsDocument(JSON.parse(txt)), readable: true };
  } catch {
    const err = new Error("pump_runs.json ei ole luettavissa");
    err.code = "INVALID_RUNS";
    throw err;
  }
}

export function mergeSegments(list) {
  const src = [];
  for (const seg of list ?? []) {
    if (!seg || !Number.isFinite(seg[0]) || !Number.isFinite(seg[1]) || !(seg[1] > seg[0])) continue;
    src.push([seg[0], seg[1]]);
  }
  src.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [a, b] of src) {
    const last = out[out.length - 1];
    if (!last || a > last[1]) out.push([a, b]);
    else last[1] = Math.max(last[1], b);
  }
  return out;
}

export function sumSegmentsMs(list) {
  return mergeSegments(list).reduce((n, [a, b]) => n + (b - a), 0);
}

function clipSeg(startMs, endMs, anchorMs, toMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) return null;
  const s = Math.max(startMs, anchorMs);
  const e = toMs == null ? endMs : Math.min(endMs, toMs);
  if (!(e > s)) return null;
  return [s, e];
}

export function resolveCutoff({ now, lastFreshMs, staleAfterMs = STALE_MS }) {
  if (lastFreshMs == null || !Number.isFinite(lastFreshMs)) return { toMs: null, quality: "unknown", fresh: false };
  if (now - lastFreshMs > staleAfterMs) return { toMs: lastFreshMs, quality: "stale", fresh: false };
  return { toMs: now, quality: "ok", fresh: true };
}

function liveSegments(state, intervals, ctx) {
  if (!state.anchor) return [];
  const anchorMs = state.anchor.atMs;
  const cut = resolveCutoff(ctx);
  const segs = [];
  for (const iv of intervals ?? []) {
    if (iv?.pump && iv.pump !== "fill") continue;
    if (iv?.open) {
      if (cut.toMs == null) continue;
      if (ctx.outputOn !== true) continue;
      const capped = clipSeg(iv.startMs, cut.toMs, anchorMs, cut.toMs);
      if (capped) segs.push(capped);
      continue;
    }
    const closed = clipSeg(iv.startMs, iv.endMs, anchorMs, cut.toMs);
    if (closed) segs.push(closed);
  }
  return segs;
}

export function coarseRemainingPct(accumulatedS, referenceS) {
  if (!Number.isFinite(accumulatedS) || accumulatedS < 0 || !(referenceS > 0)) return null;
  const ratio = Math.min(1, Math.max(0, 1 - accumulatedS / referenceS));
  return Math.round(ratio * 10) * 10;
}

function qualityNote(quality, openIgnored) {
  const ignored = openIgnored ? " Avoin käyntikirja sivuutettiin, koska tuore lähtö ei ole päällä. Katkon aikaa ei lisätty." : "";
  if (quality === "stale") return `MQTT-tila on vanha. Avoin käynti katkaistiin viimeiseen tuoreeseen hetkeen. Katkon aikaa ei lisätty.${ignored}`;
  if (quality === "unknown") return `Tuoretta MQTT-hetkeä ei ole. Avoimen käynnin kestoa ei jatkettu. Laatu ei ole tiedossa.${ignored}`;
  return `Tuore MQTT-tila. Summa on kirjattujen täyttökäyntien yhdiste ankkurin jälkeen.${ignored}`;
}

export function buildEstimate(state, intervals, ctx = {}) {
  const base = state ?? defaultSourceState();
  const cut = resolveCutoff({ now: ctx.now ?? 0, lastFreshMs: ctx.lastFreshMs ?? null, staleAfterMs: ctx.staleAfterMs });
  const hasOpen = (intervals ?? []).some((iv) => iv?.open && (!iv.pump || iv.pump === "fill"));
  const openIgnored = hasOpen && ctx.outputOn !== true;
  const covered = base.anchor ? base.covered : [];
  const merged = mergeSegments([...covered, ...liveSegments(base, intervals, { ...ctx, now: ctx.now ?? 0 })]);
  const accumulatedMs = base.anchor ? sumSegmentsMs(merged) : 0;
  const accumulatedS = accumulatedMs / 1000;
  const available = !!base.anchor;
  const remainingRatio = available ? Math.min(1, Math.max(0, 1 - accumulatedS / base.referenceS)) : null;
  const remainingCoarsePct = available ? coarseRemainingPct(accumulatedS, base.referenceS) : null;
  return {
    ok: true,
    plcWrite: false,
    partialRefill: false,
    fullRefillOnly: true,
    label: ESTIMATE_LABEL,
    available,
    persisted: ctx.persisted !== false && state != null,
    referenceS: base.referenceS,
    accumulatedS,
    accumulatedMs,
    remainingRatio,
    remainingCoarsePct,
    zeroIsNotMeasuredEmpty: remainingCoarsePct === 0,
    quality: cut.quality,
    qualityNote: qualityNote(cut.quality, openIgnored),
    openIgnored,
    anchor: base.anchor ? { id: base.anchor.id, atMs: base.anchor.atMs, at: new Date(base.anchor.atMs).toISOString(), by: base.anchor.by } : null,
    refLog: base.refLog.map((r) => ({ ...r, at: new Date(r.atMs).toISOString() })),
    refills: (base.refills ?? []).map((r) => ({ ...r, at: new Date(r.atMs).toISOString() })),
    cutOffAt: cut.toMs == null ? null : new Date(cut.toMs).toISOString(),
    meaning: "accumulated-pump-output-seconds",
  };
}

function workingCopy() {
  const disk = loadState();
  return structuredClone(disk ?? defaultSourceState());
}

function remember(state, kind, key, extra) {
  state.idempotency = [{ key: `${kind}:${key}`, kind, ...extra }, ...state.idempotency.filter((x) => x.key !== `${kind}:${key}`)].slice(0, 40);
}

function seen(state, kind, key) {
  return state.idempotency.find((x) => x.key === `${kind}:${key}`) ?? null;
}

function rejectBody(body, allowed) {
  for (const k of Object.keys(body ?? {})) {
    if (!allowed.has(k) || PLC_KEYS.has(k)) return `ei sallittu: ${k}`;
  }
  if (body?.confirm !== true) return "vahvistus puuttuu (confirm: true)";
  const key = body?.idempotencyKey;
  if (typeof key !== "string" || key.length < 8 || key.length > 80) return "idempotencyKey puuttuu";
  return null;
}

function byOf(v) {
  const s = String(v ?? "myko-ui").replace(/[\r\n]/g, " ").slice(0, 80);
  return s || "myko-ui";
}

export function planFold(state, intervals, ctx, safetyMs = SAFETY_MS) {
  if (!state?.anchor) return { covered: state?.covered ?? [], changed: false, skipped: "no-anchor" };
  const cut = resolveCutoff(ctx);
  if (cut.toMs == null) return { covered: state.covered, changed: false, skipped: "unknown-freshness" };
  const horizon = cut.toMs - safetyMs;
  const next = [];
  for (const iv of intervals ?? []) {
    if (iv?.pump && iv.pump !== "fill") continue;
    if (iv?.open) continue;
    if (!(iv.endMs <= horizon)) continue;
    const seg = clipSeg(iv.startMs, iv.endMs, state.anchor.atMs, horizon);
    if (seg) next.push(seg);
  }
  const covered = mergeSegments([...(state.covered ?? []), ...next]);
  const changed = JSON.stringify(covered) !== JSON.stringify(state.covered ?? []);
  return { covered, changed, skipped: null };
}

export async function foldFillSource(ctx = {}) {
  return exclusive(async () => {
    const state = workingCopy();
    if (!state.anchor) return { ok: true, changed: false };
    const { intervals } = readRuns();
    const now = ctx.now ?? cfg.now();
    const fresh = ctx.freshness ?? cfg.getFreshness() ?? {};
    const plan = planFold(state, intervals, {
      now,
      lastFreshMs: ctx.lastFreshMs ?? fresh.lastFreshMs ?? null,
      outputOn: ctx.outputOn ?? fresh.outputOn ?? null,
      staleAfterMs: ctx.staleAfterMs,
    }, ctx.safetyMs ?? SAFETY_MS);
    if (!plan.changed) return { ok: true, changed: false };
    state.covered = plan.covered;
    writeState(state);
    return { ok: true, changed: true };
  });
}

export async function refillFillSource({ confirm, idempotencyKey, by, now } = {}) {
  const err = rejectBody({ confirm, idempotencyKey, by }, new Set(["confirm", "idempotencyKey", "by"]));
  if (err) {
    const e = new Error(err);
    e.status = 400;
    throw e;
  }
  return exclusive(async () => {
    const state = workingCopy();
    const hit = seen(state, "refill", idempotencyKey);
    if (hit) return { ok: true, duplicate: true, anchorId: hit.anchorId, estimate: buildEstimate(state, [], { now: now ?? cfg.now(), lastFreshMs: null, persisted: true }) };
    const atMs = now ?? cfg.now();
    const id = cfg.newId();
    if (state.anchor) {
      const prev = state.refills.find((r) => r.id === state.anchor.id);
      if (prev) prev.accumulatedMs = sumSegmentsMs(state.covered);
    }
    state.anchor = { id, atMs, by: byOf(by) };
    state.covered = [];
    state.refills = [{ id, atMs, by: state.anchor.by, idempotencyKey, accumulatedMs: 0 }, ...state.refills.filter((r) => r.id !== id)].slice(0, 100);
    remember(state, "refill", idempotencyKey, { anchorId: id, atMs });
    writeState(state);
    return { ok: true, duplicate: false, anchorId: id, estimate: buildEstimate(state, [], { now: atMs, lastFreshMs: atMs, outputOn: false, persisted: true }) };
  });
}

export async function setFillSourceReference({ confirm, idempotencyKey, by, referenceS, now } = {}) {
  const err = rejectBody({ confirm, idempotencyKey, by, referenceS }, new Set(["confirm", "idempotencyKey", "by", "referenceS"]));
  if (err) {
    const e = new Error(err);
    e.status = 400;
    throw e;
  }
  if (!Number.isInteger(referenceS) || referenceS < REF_MIN_S || referenceS > REF_MAX_S) {
    const e = new Error(`viite ${REF_MIN_S}–${REF_MAX_S} s kokonaislukuna`);
    e.status = 400;
    throw e;
  }
  return exclusive(async () => {
    const state = workingCopy();
    const hit = seen(state, "ref", idempotencyKey);
    if (hit) return { ok: true, duplicate: true, referenceS: state.referenceS };
    const atMs = now ?? cfg.now();
    if (referenceS !== state.referenceS) {
      state.refLog = [...state.refLog, { atMs, oldS: state.referenceS, newS: referenceS, by: byOf(by) }].slice(-100);
      state.referenceS = referenceS;
    }
    remember(state, "ref", idempotencyKey, { referenceS, atMs });
    writeState(state);
    return { ok: true, duplicate: false, referenceS: state.referenceS, accumulatedMs: sumSegmentsMs(state.covered) };
  });
}

export function readFillSourceEstimate(ctx = {}) {
  const disk = loadState();
  const runs = readRuns();
  const now = ctx.now ?? cfg.now();
  const fresh = ctx.freshness ?? cfg.getFreshness() ?? {};
  return buildEstimate(disk, runs.intervals, {
    now,
    lastFreshMs: ctx.lastFreshMs ?? fresh.lastFreshMs ?? null,
    outputOn: ctx.outputOn ?? fresh.outputOn ?? null,
    persisted: disk != null,
    staleAfterMs: ctx.staleAfterMs,
  });
}

function sendError(res, e) {
  const status = e?.status ?? (e?.code === "INVALID_STATE" || e?.code === "INVALID_RUNS" ? 500 : 500);
  res.status(status).json({ ok: false, error: String(e?.message ?? e), quality: e?.code === "INVALID_STATE" || e?.code === "INVALID_RUNS" ? "invalid" : undefined });
}

export function registerFillSourceRoutes(app) {
  app.get("/api/fillpump/source", (_req, res) => {
    try {
      res.json(readFillSourceEstimate());
    } catch (e) {
      sendError(res, e);
    }
  });
  app.post("/api/fillpump/source/refill", async (req, res) => {
    try {
      const body = req.body ?? {};
      const bad = foreignKey(body, ["confirm", "idempotencyKey", "by"]);
      if (bad) return res.status(400).json({ error: bad });
      const out = await refillFillSource({
        confirm: body.confirm, idempotencyKey: body.idempotencyKey, by: body.by,
      });
      res.json(out);
    } catch (e) {
      sendError(res, e);
    }
  });
  app.post("/api/fillpump/source/reference", async (req, res) => {
    try {
      const body = req.body ?? {};
      const bad = foreignKey(body, ["confirm", "idempotencyKey", "by", "referenceS"]);
      if (bad) return res.status(400).json({ error: bad });
      const out = await setFillSourceReference({
        confirm: body.confirm,
        idempotencyKey: body.idempotencyKey,
        by: body.by,
        referenceS: body.referenceS,
      });
      res.json(out);
    } catch (e) {
      sendError(res, e);
    }
  });
}

function foreignKey(body, allowed) {
  const ok = new Set(allowed);
  for (const k of Object.keys(body ?? {})) {
    if (!ok.has(k) || PLC_KEYS.has(k)) return "lähdesäiliön pyyntö ei kirjoita PLC:hen";
  }
  return null;
}

export function startFillSourceMaintenance({ getFreshness, intervalMs = 60_000, safetyMs = SAFETY_MS } = {}) {
  if (getFreshness) cfg.getFreshness = getFreshness;
  const tick = () => {
    foldFillSource({ safetyMs }).catch((e) => console.warn("[fillsource] fold", e?.message ?? e));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
