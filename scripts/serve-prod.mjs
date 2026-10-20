// Production server for the built TanStack Start app (dist/).
// dist/server/index.js is a fetch-style (Cloudflare worker) handler; it runs fine on Node.
// Static assets from dist/client are served directly; everything else goes to SSR.
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";

const ROOT = resolve(import.meta.dirname, "..");
const CLIENT_DIR = join(ROOT, "dist", "client");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5199);

const MIME = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const { default: worker } = await import(join(ROOT, "dist", "server", "index.js"));
const ctx = { waitUntil() {}, passThroughOnException() {} };

function tryStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  const file = normalize(join(CLIENT_DIR, decoded));
  if (!file.startsWith(CLIENT_DIR + "/")) return false;
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const headers = {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "content-length": st.size,
  };
  if (decoded.startsWith("/assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end(), true;
  createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (tryStatic(req, res, url.pathname)) return;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method, headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const response = await worker.fetch(request, process.env, ctx);
    const out = {};
    response.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    if (!response.body || req.method === "HEAD") return res.end();
    Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    console.error("[web] request failed", req.method, req.url, error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal Server Error");
  }
});

server.listen(PORT, HOST, () => console.log(`Myko web (production) listening on http://${HOST}:${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
