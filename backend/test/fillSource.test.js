import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ESTIMATE_LABEL, DEFAULT_REFERENCE_S, buildEstimate, coarseRemainingPct, fillSourcePathConfigured,
  foldFillSource, parsePumpRunsDocument, readFillSourceEstimate, refillFillSource, registerFillSourceRoutes,
  resetFillSourceCache, setFillSourceReference, useFillSourceFiles,
} from "../src/fillSource.js";
import {
  ESTIMATE_LABEL as UI_LABEL, FILL_DISCHARGE_PATH, buildFillPresentation, fillActionEffect,
  formatHelsinki, renderExampleHtml, renderFillPumpInner, sourceDialogModel,
} from "../../src/lib/fillPumpScene.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "034c51f946b2001e650046624ebc8bb666da08f0";
const dirs = [];

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fillsrc-"));
  dirs.push(dir);
  const stateFile = path.join(dir, "fillpump_source.json");
  const runsFile = path.join(dir, "pump_runs.json");
  const published = [];
  useFillSourceFiles({
    stateFile,
    runsFile,
    now: extra.now ?? (() => 5_000_000),
    newId: extra.newId ?? (() => "id-fixed"),
    getFreshness: extra.getFreshness ?? (() => ({ lastFreshMs: 5_000_000, outputOn: false })),
    publish: (x) => published.push(x),
    io: extra.io,
  });
  return { dir, stateFile, runsFile, published };
}

function writeRuns(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc));
}

function mockRoutes() {
  const routes = {};
  const app = {
    get(p, h) { routes[`GET ${p}`] = h; },
    post(p, h) { routes[`POST ${p}`] = h; },
  };
  registerFillSourceRoutes(app);
  return routes;
}

async function call(handler, body) {
  let status = 200;
  let payload;
  const res = {
    status(c) { status = c; return this; },
    json(o) { payload = o; return this; },
  };
  await handler({ body: body ?? {} }, res);
  return { status, payload };
}

test("fill source", { concurrency: false }, async (t) => {
  await t.test("import does not configure the home path or read history", () => {
    assert.equal(fillSourcePathConfigured(), false);
  });

  await t.test("default 1320, 660 s is 50%, clamp, and no anchor is not 100%", () => {
    assert.equal(DEFAULT_REFERENCE_S, 1320);
    assert.equal(coarseRemainingPct(0, 1320), 100);
    assert.equal(coarseRemainingPct(660, 1320), 50);
    assert.equal(coarseRemainingPct(700, 1320), 50);
    assert.equal(coarseRemainingPct(800, 1320), 40);
    assert.equal(coarseRemainingPct(1320, 1320), 0);
    assert.equal(coarseRemainingPct(2000, 1320), 0);
    const anchor = { id: "a", atMs: 0, by: "t" };
    const full = buildEstimate({ ...emptyState(), anchor, covered: [[0, 660_000]] }, [], { now: 700_000, lastFreshMs: 700_000, outputOn: false });
    assert.equal(full.accumulatedS, 660);
    assert.equal(full.remainingCoarsePct, 50);
    assert.equal(full.label, "Suuntaa-antava arvio · ei mittaus");
    const zero = buildEstimate({ ...emptyState(), anchor, covered: [[0, 2_000_000]] }, [], { now: 3_000_000, lastFreshMs: 3_000_000, outputOn: false });
    assert.equal(zero.remainingCoarsePct, 0);
    assert.equal(zero.zeroIsNotMeasuredEmpty, true);
    const none = buildEstimate(emptyState(), [{ pump: "fill", startMs: 0, endMs: 660_000 }], { now: 700_000, lastFreshMs: 700_000, outputOn: true });
    assert.equal(none.available, false);
    assert.equal(none.remainingCoarsePct, null);
    assert.equal(none.accumulatedS, 0);
  });

  await t.test("overlap union, anchor boundary, open/stale/gap, fresh off ignores inflated open", () => {
    const anchor = { id: "a", atMs: 100_000, by: "t" };
    const state = { ...emptyState(), anchor, covered: [] };
    const overlap = buildEstimate(state, [
      { pump: "fill", startMs: 100_000, endMs: 200_000 },
      { pump: "fill", startMs: 150_000, endMs: 250_000 },
      { pump: "circ_l", startMs: 100_000, endMs: 9_000_000 },
      { pump: "fert", startMs: 100_000, endMs: 9_000_000 },
    ], { now: 300_000, lastFreshMs: 300_000, outputOn: false });
    assert.equal(overlap.accumulatedS, 150);
    const boundary = buildEstimate(state, [
      { pump: "fill", startMs: 50_000, endMs: 180_000 },
    ], { now: 300_000, lastFreshMs: 300_000, outputOn: false });
    assert.equal(boundary.accumulatedS, 80);
    const gap = buildEstimate(state, [
      { pump: "fill", startMs: 100_000, endMs: 105_000 },
      { pump: "fill", startMs: 120_000, endMs: 125_000 },
    ], { now: 200_000, lastFreshMs: 200_000, outputOn: false });
    assert.equal(gap.accumulatedS, 10);
    assert.equal(gap.quality, "ok");
    assert.doesNotMatch(gap.qualityNote, /aukko|katko|epävarm/i);
    const stale = buildEstimate(state, [
      { pump: "fill", startMs: 100_000, open: true },
    ], { now: 200_000, lastFreshMs: 110_000, outputOn: true });
    assert.equal(stale.quality, "stale");
    assert.equal(stale.accumulatedS, 10);
    const freshOpen = buildEstimate(state, [
      { pump: "fill", startMs: 100_000, open: true },
    ], { now: 112_000, lastFreshMs: 111_000, outputOn: true });
    assert.equal(freshOpen.quality, "ok");
    assert.equal(freshOpen.accumulatedS, 12);
    const ignored = buildEstimate(state, [
      { pump: "fill", startMs: 100_000, endMs: 106_000 },
      { pump: "fill", startMs: 100_000, open: true, endMs: 9_999_999, duration_s: 9999 },
    ], { now: 500_000, lastFreshMs: 500_000, outputOn: false });
    assert.equal(ignored.accumulatedS, 6);
    assert.equal(ignored.openIgnored, true);
    const unknown = buildEstimate(state, [
      { pump: "fill", startMs: 100_000, endMs: 104_000 },
      { pump: "fill", startMs: 100_000, open: true },
    ], { now: 900_000, lastFreshMs: null, outputOn: null });
    assert.equal(unknown.quality, "unknown");
    assert.equal(unknown.accumulatedS, 4);
    const fault = buildEstimate(state, [{ pump: "fill", startMs: 100_000, endMs: 110_000 }], { now: 200_000, lastFreshMs: 200_000, outputOn: false, fault: true, stError: true });
    assert.equal(fault.accumulatedS, 10);
    assert.equal(fault.anchor.id, "a");
  });

  await t.test("restart, prune, reference change, duplicate and concurrent refill, write failure", async () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const ctx = setup({ now: () => 2_000_000, newId: ids, getFreshness: () => ({ lastFreshMs: 2_000_000, outputOn: false }) });
    const first = await refillFillSource({ confirm: true, idempotencyKey: "refill-key-1", by: "tester", now: 1_000_000 });
    assert.equal(first.duplicate, false);
    assert.equal(first.anchorId, "id-1");
    writeRuns(ctx.runsFile, {
      savedAt: new Date(2_000_000).toISOString(),
      open: { circ_l: 1_000_000 },
      closed: [
        { pump: "circ_r", start: 1_000_000, end: 1_900_000 },
        { pump: "fill", start: 1_000_000, end: 1_660_000 },
        { pump: "fert", start: 1_000_000, end: 1_100_000 },
      ],
    });
    await foldFillSource({ now: 2_000_000, lastFreshMs: 2_000_000, outputOn: false, safetyMs: 0 });
    let est = readFillSourceEstimate({ now: 2_000_000, lastFreshMs: 2_000_000, outputOn: false });
    assert.equal(est.accumulatedS, 660);
    assert.equal(est.remainingCoarsePct, 50);
    writeRuns(ctx.runsFile, { open: {}, closed: [], savedAt: new Date(2_000_000).toISOString() });
    resetFillSourceCache();
    est = readFillSourceEstimate({ now: 2_000_000, lastFreshMs: 2_000_000, outputOn: false });
    assert.equal(est.accumulatedS, 660);
    const ref = await setFillSourceReference({ confirm: true, idempotencyKey: "ref-key-0001", referenceS: 2640, by: "tester", now: 2_100_000 });
    assert.equal(ref.referenceS, 2640);
    assert.equal(ref.accumulatedMs, 660_000);
    est = readFillSourceEstimate({ now: 2_100_000, lastFreshMs: 2_100_000, outputOn: false });
    assert.equal(est.accumulatedS, 660);
    assert.equal(est.remainingCoarsePct, 80);
    assert.equal(est.refLog.at(-1).oldS, 1320);
    assert.equal(est.refLog.at(-1).newS, 2640);
    assert.equal(est.refLog.at(-1).atMs, 2_100_000);
    const replay = await setFillSourceReference({ confirm: true, idempotencyKey: "ref-key-0001", referenceS: 3000, now: 2_200_000 });
    assert.equal(replay.duplicate, true);
    assert.equal(readFillSourceEstimate({ now: 2_200_000, lastFreshMs: 2_200_000, outputOn: false }).referenceS, 2640);
    const again = await refillFillSource({ confirm: true, idempotencyKey: "refill-key-1", now: 3_000_000 });
    assert.equal(again.duplicate, true);
    assert.equal(again.anchorId, "id-1");
    assert.equal(readFillSourceEstimate({ now: 3_000_000, lastFreshMs: 3_000_000, outputOn: false }).accumulatedS, 660);
    const pair = await Promise.all([
      refillFillSource({ confirm: true, idempotencyKey: "dup-key-aaaa", now: 4_000_000 }),
      refillFillSource({ confirm: true, idempotencyKey: "dup-key-aaaa", now: 4_000_100 }),
    ]);
    assert.equal(pair.filter((r) => r.duplicate).length, 1);
    assert.equal(readFillSourceEstimate({ now: 4_000_100, lastFreshMs: 4_000_100, outputOn: false }).accumulatedS, 0);
    assert.equal(readFillSourceEstimate({ now: 4_000_100, lastFreshMs: 4_000_100, outputOn: false }).anchor.id, "id-2");
    let inside = 0;
    let maxInside = 0;
    const stateFile = ctx.stateFile;
    const runsFile = ctx.runsFile;
    useFillSourceFiles({
      stateFile,
      runsFile,
      now: () => 5_000_000,
      newId: () => `id-${++n}`,
      io: {
        readFileSync: fs.readFileSync,
        mkdirSync: fs.mkdirSync,
        renameSync: fs.renameSync,
        writeFileSync(...args) {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          try { return fs.writeFileSync(...args); } finally { inside -= 1; }
        },
      },
    });
    await Promise.all([
      refillFillSource({ confirm: true, idempotencyKey: "key-left-001", now: 5_000_000 }),
      refillFillSource({ confirm: true, idempotencyKey: "key-right-02", now: 5_100_000 }),
    ]);
    assert.equal(maxInside, 1);
    const afterConc = readFillSourceEstimate({ now: 5_100_000, lastFreshMs: 5_100_000, outputOn: false });
    assert.equal(afterConc.anchor.id, "id-4");
    assert.equal(afterConc.accumulatedS, 0);
    const beforeFail = fs.readFileSync(stateFile);
    useFillSourceFiles({
      stateFile,
      runsFile,
      io: {
        readFileSync: fs.readFileSync,
        mkdirSync: fs.mkdirSync,
        renameSync: fs.renameSync,
        writeFileSync() { throw new Error("disk full"); },
      },
    });
    await assert.rejects(() => setFillSourceReference({ confirm: true, idempotencyKey: "ref-fail-0001", referenceS: 1500, now: 6_000_000 }));
    assert.equal(fs.readFileSync(stateFile).equals(beforeFail), true);
    resetFillSourceCache();
    assert.equal(readFillSourceEstimate({ now: 6_000_000, lastFreshMs: 6_000_000, outputOn: false }).referenceS, 2640);
    assert.equal(ctx.published.length, 0);
  });

  await t.test("routes: pure GET, reject PLC keys, invalid reference, corrupt file is not rewritten", async () => {
    const ctx = setup();
    const routes = mockRoutes();
    let writes = 0;
    const io = {
      readFileSync(file, enc) {
        if (!fs.existsSync(file)) {
          const err = new Error("missing");
          err.code = "ENOENT";
          throw err;
        }
        return fs.readFileSync(file, enc);
      },
      mkdirSync: fs.mkdirSync,
      renameSync: fs.renameSync,
      writeFileSync(...args) { writes += 1; return fs.writeFileSync(...args); },
    };
    useFillSourceFiles({ stateFile: ctx.stateFile, runsFile: ctx.runsFile, io, getFreshness: () => ({ lastFreshMs: null, outputOn: null }) });
    const got = await call(routes["GET /api/fillpump/source"]);
    assert.equal(got.status, 200);
    assert.equal(got.payload.referenceS, 1320);
    assert.equal(got.payload.available, false);
    assert.equal(got.payload.remainingCoarsePct, null);
    assert.equal(got.payload.plcWrite, false);
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(ctx.stateFile), false);
    const denied = await call(routes["POST /api/fillpump/source/refill"], { confirm: true, idempotencyKey: "no-plc-key-1", Cmd_Ack: true, Run: true });
    assert.equal(denied.status, 400);
    assert.equal(fs.existsSync(ctx.stateFile), false);
    const badRef = await call(routes["POST /api/fillpump/source/reference"], { confirm: true, idempotencyKey: "bad-ref-key1", referenceS: 12.5, Cfg_Enable: false });
    assert.equal(badRef.status, 400);
    const ok = await call(routes["POST /api/fillpump/source/refill"], { confirm: true, idempotencyKey: "route-refill1", by: "ui" });
    assert.equal(ok.status, 200);
    assert.equal(ok.payload.duplicate, false);
    fs.writeFileSync(ctx.stateFile, "{");
    resetFillSourceCache();
    const broken = await call(routes["GET /api/fillpump/source"]);
    assert.equal(broken.status, 500);
    assert.equal(broken.payload.quality, "invalid");
    assert.equal(fs.readFileSync(ctx.stateFile, "utf8"), "{");
    const parsed = parsePumpRunsDocument({
      open: { fill: 10, circ_l: 10 },
      closed: [{ pump: "fill", start: 1, end: 2 }, { pump: "fert", start: 1, end: 2 }],
    });
    assert.deepEqual(parsed.intervals.map((iv) => iv.pump), ["fill", "fill"]);
  });

  await t.test("view distinguishes output, enable, alarm and estimate; shared pumps and modal stay", () => {
    assert.equal(UI_LABEL, ESTIMATE_LABEL);
    const fault = buildFillPresentation(
      { present: false, stale: true, write_allowed: true, plc: { Pump: true, St_Running: false, Run: true, St_Error: true, Cfg_Enable: true }, alarms: { active: { err_1: true } } },
      { ok: true, available: false, referenceS: 1320, quality: "unknown" },
    );
    const faultSvg = renderFillPumpInner(fault, { clipId: "t-fault" });
    assert.equal(fault.pipeAnimate, false);
    assert.match(faultSvg, /data-testid="fill-alarm-bell"/);
    assert.match(faultSvg, /data-pipe-animate="false"/);
    assert.match(faultSvg, /Ei arviota/);
    assert.match(faultSvg, /Vanha tieto/);
    assert.doesNotMatch(faultSvg, /data-pct=/);
    assert.doesNotMatch(faultSvg, /65/);
    assert.equal(fillActionEffect("bell", fault).type, "open-modal");
    assert.equal(fillActionEffect("bell", fault).ack, false);
    assert.equal(fillActionEffect("status", fault).plcWrite, false);
    const onlyRun = buildFillPresentation(
      { present: true, stale: false, write_allowed: true, plc: { Pump: false, St_Running: false, Run: true, Cfg_Enable: true, St_Error: false } },
      null,
    );
    assert.equal(onlyRun.outputKind, "off");
    assert.equal(onlyRun.pipeAnimate, false);
    assert.equal(onlyRun.enableLabel, "Täyttö sallittu");
    const running = buildFillPresentation(
      { present: true, stale: false, write_allowed: true, plc: { Pump: true, St_Running: true, Cfg_Enable: false, St_Error: false } },
      { ok: true, available: true, remainingCoarsePct: 50, quality: "ok", referenceS: 1320, accumulatedS: 660 },
    );
    const runSvg = renderFillPumpInner(running, { clipId: "t-run" });
    assert.equal(running.pipeAnimate, true);
    assert.match(runSvg, /data-pct="50"/);
    assert.match(runSvg, /data-pipe-animate="true"/);
    assert.match(runSvg, /y1="57" x2="64" y2="112"/);
    assert.match(runSvg, /Tuore kirjaus/);
    assert.match(runSvg, /fill-output-label" x="64" y="236"/);
    assert.match(runSvg, /Täyttö estetty/);
    assert.match(runSvg, /Lähtö päällä/);
    assert.match(runSvg, /Suuntaa-antava arvio/);
    assert.doesNotMatch(runSvg, /fill-alarm-bell/);
    const enable = fillActionEffect("enable", running);
    assert.equal(enable.type, "confirm-enable");
    assert.equal(enable.next, true);
    assert.equal(enable.plcWrite, "Cfg_Enable");
    assert.match(enable.confirmText, /Ei käynnistä pumppua/);
    const refill = fillActionEffect("refill", running);
    assert.equal(refill.plcWrite, false);
    assert.equal(refill.ack, false);
    assert.match(refill.confirmText, /täysi säiliö/i);
    const dialog = sourceDialogModel({ available: true, remainingCoarsePct: 0, referenceS: 1320, accumulatedS: 1320, qualityNote: "x", refLog: [] });
    assert.equal(dialog.zeroNote, "0 % ei ole mitattu tyhjä.");
    assert.match(dialog.fullRefillHelp, /Ei osittaistäyttöä/);
    const html = renderExampleHtml();
    assert.match(html, /ESIMERKKI · ei tuotantodataa/);
    assert.match(html, /Ei arviota/);
    assert.match(html, /data-pct="50"/);
    assert.equal(formatHelsinki("2026-11-08T08:25:00.000Z"), "8.11.2026 klo 10.25.00");
    assert.match(html, /8\.11\.2026 klo 10\.25\.00 Helsinki/);
    assert.doesNotMatch(html, /2026-11-08T08:25:00\.000Z/);
    assert.equal(FILL_DISCHARGE_PATH, "M 360 320 V 230 H 892");
    const same = (rel) => {
      const cur = fs.readFileSync(path.join(ROOT, rel));
      const base = execFileSync("git", ["-C", ROOT, "show", `${BASE}:${rel}`]);
      assert.deepEqual(cur, base, rel);
    };
    same("src/components/FillPumpModal.tsx");
    same("src/components/SequencePanel.tsx");
    same("backend/src/pumpRuns.js");
    const widget = fs.readFileSync(path.join(ROOT, "src/components/dashboard/ProcessDiagramWidget.tsx"), "utf8");
    assert.match(widget, /label="pH\+"/);
    assert.match(widget, /label="pH−"/);
    assert.match(widget, /FILL_DISCHARGE_PATH/);
    assert.match(widget, /active=\{cL\.run && !cL\.err\}/);
    assert.match(widget, /active=\{cR\.run && !cR\.err\}/);
    assert.match(widget, /active=\{fertLive && fp\?\.Pump === true\}/);
    assert.doesNotMatch(widget, /pu\.b\("Filling"\)/);
    const graphic = fs.readFileSync(path.join(ROOT, "src/components/dashboard/FillPumpGraphic.tsx"), "utf8");
    assert.match(graphic, /setFillPump\(\{ Cfg_Enable: effect\.next \}\)/);
    assert.doesNotMatch(graphic, /Cmd_Ack|["']Run["']/);
    const backend = fs.readFileSync(path.join(ROOT, "backend/src/fillSource.js"), "utf8");
    assert.doesNotMatch(backend, /from ["']mqtt["']/);
    assert.doesNotMatch(backend, /cfg\.publish\(/);
    const diff = execFileSync("git", ["-C", ROOT, "diff", "--no-color", BASE, "--", "backend/src/fillPump.js"], { encoding: "utf8" });
    assert.match(diff, /fillPumpObserved/);
    assert.doesNotMatch(diff, /sampleLevel/);
  });
});

function emptyState() {
  return { version: 1, anchor: null, referenceS: 1320, covered: [], refLog: [], refills: [], idempotency: [] };
}

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
