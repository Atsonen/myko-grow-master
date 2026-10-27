import test, { mock } from "node:test";
import assert from "node:assert/strict";
let id = 0; const sent = [];
mock.module("../src/db.js", { namedExports: { query: async (q) => (q.startsWith("INSERT") ? { insertId: ++id } : []) } });
mock.module("../src/telegram.js", { namedExports: { tg: async (_m, b) => sent.push(b.text), allowedChats: async () => [1] } });
const { __test: T } = await import("../src/fertDose.js");
const c = { ...T.DEF, ec_sp: 4800, ec_alarm: { ...T.DEF.ec_alarm, lo_off: -150, hi_off: 150, warn_lo_off: -100, warn_hi_off: 100, delay_min: 0, clear_min: 3 } };
const realNow = Date.now; let now = realNow(); Date.now = () => now;
const step = async (ec, min = 1) => { for (let i = 0; i < min; i++) { await T.evalAlarms(c, ec, 4800, true); now += 60_000; } };
test("HI palautuu, kun EC laskee alle LO-rajan; LO ei lukitse", async () => {
  await step(5024); assert.ok(T.S.ev.ec_alarm_hi?.active); assert.equal(T.alarmActive(), true);
  await step(4013, 5);
  assert.equal(T.S.ev.ec_alarm_hi, undefined, "HI kuittautui");
  assert.ok(T.S.ev.ec_alarm_lo?.active, "LO aktiivinen");
  assert.equal(T.alarmActive(), false, "LO ei lukitse");
  assert.ok(sent.some((t) => t.includes("Palautui") && t.includes("lukitus poistui")));
  assert.ok(!(T.S.ev.ec_warn_hi?.active && T.S.ev.ec_warn_lo?.active));
});
test("kuittaus vapauttaa HI-lukituksen", async () => {
  await step(5024, 4); assert.equal(T.alarmActive(), true);
  T.S.ev.ec_alarm_hi.acked = true; assert.equal(T.alarmActive(), false);
  assert.equal(T.S.ev.ec_alarm_lo, undefined);
});
