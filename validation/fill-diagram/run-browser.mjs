// Drives the real ProcessDiagramWidget against the synthetic API.
// Chrome may resolve only 127.0.0.1. No production backend is started.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { requests, startMock } from "./mock-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = "/opt/cursor/artifacts";
const shots = [];
const browserRequests = [];
const blocked = [];

function fail(msg) {
  const err = new Error(msg);
  err.validation = true;
  throw err;
}

async function setScenario(name) {
  const res = await fetch("http://127.0.0.1:5197/__scenario", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario: name }),
  });
  if (!res.ok) fail(`scenario ${name} ${res.status}`);
}

async function shot(page, name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(file);
}

async function waitText(page, text) {
  await page.waitForFunction((t) => document.body.innerText.toLocaleLowerCase("fi").includes(t.toLocaleLowerCase("fi")), { timeout: 12000 }, text);
}

async function label(page, text) {
  await page.evaluate((t) => {
    const el = document.getElementById("syn-banner");
    if (el) el.textContent = t;
  }, text);
}

const pageErrors = [];
const mock = await startMock();
const vite = spawn("npx", ["vite", "--config", "validation/vite.harness.config.ts", "--host", "127.0.0.1", "--port", "5198", "--strictPort"], {
  cwd: repo,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, BROWSER: "none" },
});
let viteLog = "";
vite.stdout.on("data", (b) => { viteLog += b; });
vite.stderr.on("data", (b) => { viteLog += b; });

function stop() {
  vite.kill("SIGTERM");
  mock.close();
}

try {
  const ready = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`vite timeout\n${viteLog}`)), 40000);
    const look = () => {
      if (/Local:/.test(viteLog) || /ready in/i.test(viteLog)) { clearTimeout(t); resolve(); }
    };
    vite.stdout.on("data", look);
    vite.stderr.on("data", look);
    vite.on("exit", (code) => { clearTimeout(t); reject(new Error(`vite exit ${code}\n${viteLog}`)); });
  });
  void ready;

  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    env: { ...process.env, TZ: "Europe/Helsinki" },
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      "--disable-features=Translate,DialMediaRouteProvider",
      `--user-data-dir=/tmp/chrome-fill-react-${process.pid}`,
      "--window-size=1240,900",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 860, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => { if (msg.type() === "error") pageErrors.push(msg.text()); });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    let host = "";
    try { host = new URL(req.url()).hostname; } catch { host = "invalid"; }
    const row = { url: req.url(), method: req.method(), host };
    browserRequests.push(row);
    if (host !== "127.0.0.1" && host !== "localhost") {
      blocked.push(row);
      req.abort("blockedbyclient");
      return;
    }
    req.continue();
  });
  page.on("dialog", (d) => { void d.accept(); });

  await setScenario("fault");
  await page.goto("http://127.0.0.1:5198/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (zone !== "Europe/Helsinki") fail(`browser zone ${zone}`);
  await waitText(page, "Ei arviota");
  await waitText(page, "10.25.00");
  await page.waitForSelector('[data-testid="fill-alarm-bell"]');
  await page.waitForSelector('[data-testid="fill-suction"]');
  await label(page, "SYNTEETTINEN DATA · vika, ei ankkuria · 8.11.2026 10.25.00 Helsinki · ei tuotantoa");
  await shot(page, "fill-diagram-fault.png");

  const beforeModal = requests.length;
  await page.click('[data-testid="fill-alarm-bell"]');
  await page.waitForSelector('[data-testid="fp-modal"]');
  await waitText(page, "Täyttöpumppu");
  await waitText(page, "Asetukset");
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("h3")].find((h) => /asetukset/i.test(h.textContent || ""));
    el?.scrollIntoView({ block: "center" });
  });
  await waitText(page, "10.25.00");
  const modalPosts = requests.slice(beforeModal).filter((r) => r.method === "POST");
  if (modalPosts.length) fail(`modal open posted ${JSON.stringify(modalPosts)}`);
  await label(page, "SYNTEETTINEN DATA · kello avasi nykyisen Täyttöpumppu-ikkunan · ei kuittausta · 10.25.00 Helsinki");
  await shot(page, "fill-diagram-modal.png");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="fp-modal"]', { hidden: true });

  await page.click('[data-testid="fill-output-label"]');
  await page.waitForSelector('[data-testid="fp-modal"]');
  const statusPosts = requests.filter((r) => r.method === "POST" && r.path.startsWith("/api"));
  if (statusPosts.length) fail(`status click posted ${JSON.stringify(statusPosts)}`);
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="fp-modal"]', { hidden: true });

  await setScenario("run50");
  await waitText(page, "50 %");
  await waitText(page, "Lähtö päällä");
  await waitText(page, "Täyttö sallittu");
  await label(page, "SYNTEETTINEN DATA · ankkuroitu kirjattu lähtö 660 s / 1320 s ≈ 50 % · 10.25.00 Helsinki");
  await shot(page, "fill-diagram-run50.png");

  await page.click('[data-testid="fill-source-tank"]');
  await page.waitForSelector('[data-testid="fill-source-dialog"]');
  await waitText(page, "660 s / viite 1320 s");
  await waitText(page, "8.11.2026 klo 10.25.00 Helsinki");
  const rawUtc = await page.evaluate(() => document.body.innerText.includes("2026-11-08T"));
  if (rawUtc) fail("raw UTC timestamp visible");
  await label(page, "SYNTEETTINEN DATA · lähdesäiliön ikkuna · 660 s / 1320 s · 10.25.00 Helsinki");
  await shot(page, "fill-diagram-source.png");

  await page.$eval('[data-testid="fill-source-ref"]', (el) => {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    proto?.set?.call(el, "2640");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const beforeRef = requests.length;
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const btn = buttons.find((b) => b.textContent?.includes("Tallenna viite"));
    btn?.click();
  });
  await waitText(page, "660 s / viite 2640 s");
  await waitText(page, "80 %");
  const refPosts = requests.slice(beforeRef).filter((r) => r.method === "POST");
  if (refPosts.length !== 1 || refPosts[0].path !== "/api/fillpump/source/reference") {
    fail(`reference posts ${JSON.stringify(refPosts)}`);
  }
  if (refPosts[0].body?.referenceS !== 2640 || JSON.stringify(refPosts[0].body).match(/Cmd_Ack|Run|Cfg_/)) {
    fail(`reference body ${JSON.stringify(refPosts[0].body)}`);
  }
  await label(page, "SYNTEETTINEN DATA · viite 1320 → 2640 s, kertymä yhä 660 s · 10.25.00 Helsinki");
  await shot(page, "fill-diagram-reference.png");

  const beforeFill = requests.length;
  await page.click('[data-testid="fill-source-refill"]');
  await waitText(page, "0 s / viite 2640 s");
  await waitText(page, "100 %");
  const fillPosts = requests.slice(beforeFill).filter((r) => r.method === "POST");
  if (fillPosts.length !== 1 || fillPosts[0].path !== "/api/fillpump/source/refill") {
    fail(`refill posts ${JSON.stringify(fillPosts)}`);
  }
  const fillKeys = Object.keys(fillPosts[0].body || {});
  if (fillKeys.some((k) => !["confirm", "by", "idempotencyKey"].includes(k))) fail(`refill keys ${fillKeys}`);
  await label(page, "SYNTEETTINEN DATA · Säiliö täytetty, paikallinen mock · 100 % · 10.25.00 Helsinki");
  await shot(page, "fill-diagram-refilled.png");

  const rejected = requests.filter((r) => r.rejected);
  const posts = requests.filter((r) => r.method === "POST" && r.path.startsWith("/api"));
  const postPaths = [...new Set(posts.map((r) => r.path))];
  if (rejected.length) fail(`rejected requests ${JSON.stringify(rejected)}`);
  if (blocked.length) fail(`browser blocked outbound ${JSON.stringify(blocked)}`);
  if (postPaths.some((p) => p !== "/api/fillpump/source/reference" && p !== "/api/fillpump/source/refill")) {
    fail(`unexpected posts ${postPaths}`);
  }
  const hosts = [...new Set(browserRequests.map((r) => r.host))];
  if (hosts.some((h) => h !== "127.0.0.1" && h !== "localhost")) fail(`hosts ${hosts}`);

  await mkdir(outDir, { recursive: true });
  const proof = {
    browserTimeZone: zone,
    hosts,
    blocked,
    postPaths,
    requestCount: requests.length,
    browserRequestCount: browserRequests.length,
    methods: requests.reduce((m, r) => { m[r.method] = (m[r.method] || 0) + 1; return m; }, {}),
    paths: [...new Set(requests.map((r) => `${r.method} ${r.path}`))].sort(),
    referenceBody: refPosts[0].body,
    refillBody: fillPosts[0].body,
    shots,
  };
  await writeFile(path.join(outDir, "fill-diagram-network.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ ok: true, zone, hosts, postPaths, shots, requestCount: requests.length }, null, 2));
  await browser.close();
  stop();
  process.exit(0);
} catch (e) {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "fill-diagram-network.json"), JSON.stringify({
    error: String(e?.stack || e),
    viteLog,
    requests,
    browserRequests,
    blocked,
    shots,
    pageErrors,
  }, null, 2));
  console.error(e);
  stop();
  process.exit(1);
}
