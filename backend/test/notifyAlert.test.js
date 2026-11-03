import test from "node:test";
import assert from "node:assert/strict";
import { notifyAlert, TG_TIMEOUT_MS } from "../src/notifyAlert.js";

test("TG_TIMEOUT_MS is ~10s", () => {
  assert.equal(TG_TIMEOUT_MS, 10_000);
});

test("telegram ok -> no whatsapp", async () => {
  const calls = { tg: 0, wa: 0 };
  const r = await notifyAlert("TESTI tg ok", {
    tgSend: async () => { calls.tg++; return true; },
    waSend: async () => { calls.wa++; throw new Error("WA must not run"); },
    log: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "telegram");
  assert.deepEqual(calls, { tg: 1, wa: 0 });
});

test("telegram false -> whatsapp fallback (mocked, no real WA)", async () => {
  const calls = { tg: 0, wa: 0 };
  const r = await notifyAlert("TESTI tg false", {
    tgSend: async () => { calls.tg++; return false; },
    waSend: async () => { calls.wa++; return true; },
    log: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "whatsapp");
  assert.equal(r.telegramOk, false);
  assert.deepEqual(calls, { tg: 1, wa: 1 });
});

test("telegram timeout/exception -> whatsapp fallback", async () => {
  const calls = { tg: 0, wa: 0 };
  const r = await notifyAlert("TESTI tg timeout", {
    tgSend: async () => { calls.tg++; throw new Error("TimeoutError"); },
    waSend: async () => { calls.wa++; return true; },
    log: () => {},
  });
  assert.equal(r.channel, "whatsapp");
  assert.match(r.error || "", /TimeoutError/);
  assert.equal(calls.wa, 1);
});

test("simulate invalid Telegram URL failure -> whatsapp chosen, no real send", async () => {
  const calls = { tg: 0, wa: 0 };
  const r = await notifyAlert("TESTI bad url", {
    tgSend: async () => { calls.tg++; throw new Error("fetch failed: invalid URL"); },
    waSend: async () => { calls.wa++; return true; },
    log: () => {},
  });
  assert.equal(r.channel, "whatsapp");
  assert.equal(calls.tg, 1);
  assert.equal(calls.wa, 1);
});

test("both fail -> none", async () => {
  const r = await notifyAlert("TESTI both fail", {
    tgSend: async () => false,
    waSend: async () => false,
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.channel, "none");
});
