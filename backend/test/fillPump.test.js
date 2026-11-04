import test from "node:test";
import assert from "node:assert/strict";
import { HIST_GAP_MS, backfillHistGaps, bucketDlMinutes } from "../src/fillPump.js";

const align = (t) => Math.floor(t / 60_000) * 60_000;

test("HIST_GAP_MS is ~2.5 minutes", () => {
  assert.equal(HIST_GAP_MS, 150_000);
});

test("bucketDlMinutes floors to minute and keeps last value in bucket", () => {
  const t0 = align(1_793_773_800_000);
  const rows = [
    { t: t0 + 355, v: 73.91 },
    { t: t0 + 30_000, v: 73.5 },
    { t: t0 + 60_000 + 100, v: 70.2 },
  ];
  assert.deepEqual(bucketDlMinutes(rows), [
    { t: t0, v: 73.5 },
    { t: t0 + 60_000, v: 70.2 },
  ]);
});

test("backfillHistGaps fills interior gap from dl buckets and marks bf", () => {
  const t0 = align(1_000_000_000_000);
  const hist = [
    { t: t0, v: 70 },
    { t: t0 + 60_000, v: 71 },
    { t: t0 + 138 * 60_000, v: 50 },
  ];
  const dl = [];
  for (let i = 0; i <= 138; i++) dl.push({ t: t0 + i * 60_000, v: 60 + i * 0.01 });
  const now = t0 + 138 * 60_000;
  const { hist: out, added, gaps } = backfillHistGaps(hist, dl, {
    now, cut: t0, keepMs: 24 * 3600_000, gapMs: HIST_GAP_MS,
  });
  assert.equal(gaps, 1);
  assert.ok(added >= 100, `expected many added, got ${added}`);
  const mid = out.find((p) => p.t === t0 + 30 * 60_000);
  assert.ok(mid, "midpoint present");
  assert.equal(mid.bf, true);
  assert.equal(mid.v, 60 + 30 * 0.01);
  assert.equal(out.find((p) => p.t === t0).bf, undefined);
  assert.equal(out.find((p) => p.t === t0 + 138 * 60_000).bf, undefined);
});

test("backfillHistGaps fills empty hist from dl", () => {
  const t0 = align(2_000_000_000_000);
  const dl = [
    { t: t0, v: 1 },
    { t: t0 + 60_000, v: 2 },
    { t: t0 + 120_000, v: 3 },
  ];
  const now = t0 + 120_000;
  const { hist: out, added } = backfillHistGaps([], dl, { now, cut: t0, gapMs: HIST_GAP_MS });
  assert.equal(added, 3);
  assert.equal(out.length, 3);
  assert.ok(out.every((p) => p.bf));
});

test("backfillHistGaps does not overwrite existing points", () => {
  const t0 = align(3_000_000_000_000);
  const hist = [{ t: t0, v: 99 }, { t: t0 + 60_000, v: 98 }];
  const dl = [{ t: t0, v: 1 }, { t: t0 + 60_000, v: 2 }];
  const { hist: out, added } = backfillHistGaps(hist, dl, {
    now: t0 + 60_000, cut: t0, gapMs: HIST_GAP_MS,
  });
  assert.equal(added, 0);
  assert.equal(out.find((p) => p.t === t0).v, 99);
});

test("backfillHistGaps skips gaps at or below threshold", () => {
  const t0 = align(4_000_000_000_000);
  const hist = [{ t: t0, v: 1 }, { t: t0 + 120_000, v: 2 }];
  const dl = [{ t: t0 + 60_000, v: 9 }];
  const { added, gaps } = backfillHistGaps(hist, dl, {
    now: t0 + 120_000, cut: t0, gapMs: HIST_GAP_MS,
  });
  assert.equal(gaps, 0);
  assert.equal(added, 0);
});

test("backfillHistGaps fills trailing gap to now", () => {
  const t0 = align(5_000_000_000_000);
  const hist = [{ t: t0, v: 10 }];
  const dl = [
    { t: t0 + 60_000, v: 11 },
    { t: t0 + 120_000, v: 12 },
    { t: t0 + 180_000, v: 13 },
  ];
  const now = t0 + 180_000;
  const { hist: out, added, gaps } = backfillHistGaps(hist, dl, { now, cut: t0, gapMs: HIST_GAP_MS });
  assert.equal(gaps, 1);
  assert.equal(added, 3);
  assert.ok(out.find((p) => p.t === t0 + 180_000)?.bf);
});
