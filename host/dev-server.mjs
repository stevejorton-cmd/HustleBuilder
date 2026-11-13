import {readBody,unavailable} from "./lib/http.mjs";
import { createServer } from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileStore, setStore } from "./lib/store.mjs";
import { handleRequest } from "./lib/router.mjs";

const dir = process.env.HB_STORE_DIR || ".hb-data";
if(!process.env.DATABASE_URL||process.env.HB_STORE_DIR)setStore(fileStore(dir));
process.env.PUBLISH_TEST_MODE = process.env.PUBLISH_TEST_MODE || "1";
process.env.PAYWALL_MODE = process.env.PAYWALL_MODE || "test";
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || "dev-admin-secret";

const indexUrl = new URL("../index.html", import.meta.url);
const rootDir = new URL("..", import.meta.url);
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.PORT || 8787);
process.env.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://127.0.0.1:" + port;
const assetTypes = { ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

const server = createServer(async (req, res) => {
  try {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  // A fixed CSS viewport for manual phone QA. This route is dev-server only;
  // it is not part of the Vercel handler or the published app.
  if (req.method === "GET" && url.pathname === "/__qa/phone") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Hustle Builder · 390px QA</title><style>body{margin:0;background:#e8e9e4;font:14px system-ui;display:grid;justify-content:center}p{text-align:center;margin:12px}iframe{border:1px solid #aaa;width:390px;height:844px;background:white}</style><p>Phone check · 390 × 844 CSS pixels · local test mode</p><iframe title="Phone preview" src="/"></iframe></html>');
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const file = await readFile(indexUrl);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(file);
    return;
  }
  if (req.method === "GET" && (url.pathname === "/manifest.webmanifest" || url.pathname === "/sw.js" || url.pathname.startsWith("/icons/"))) {
    const rel = url.pathname.replace(/^\/+/, "");
    const fileUrl = new URL(rel, rootDir);
    if (!fileUrl.pathname.startsWith(rootDir.pathname)) {
      res.writeHead(404); res.end(); return;
    }
    try {
      const file = await readFile(fileUrl);
      const type = url.pathname.endsWith(".webmanifest") ? "application/manifest+json" : url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "image/png";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(file);
      return;
    } catch {
      res.writeHead(404); res.end(); return;
    }
  }
  if (req.method === "GET" && url.pathname === "/assets/heic2any.js") {
    try {
      const file = await readFile(new URL("assets/heic2any.js", rootDir));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" });
      res.end(file);
      return;
    } catch { /* fall through */ }
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/pets/")) {
    const name = path.basename(url.pathname);
    const type = assetTypes[path.extname(name).toLowerCase()];
    if (type && /^pet-[a-z0-9.-]+$/.test(name)) {
      try {
        const file = await readFile(new URL("assets/pets/" + name, rootDir));
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
        res.end(file);
        return;
      } catch { /* fall through */ }
    }
  }
  if (req.method === "GET" && (url.pathname === "/assets/intro.mp4" || url.pathname === "/assets/intro.vtt")) {
    const name = path.basename(url.pathname);
    try {
      const file = await readFile(new URL("assets/" + name, rootDir));
      const type = name.endsWith(".vtt") ? "text/vtt; charset=utf-8" : "video/mp4";
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
      res.end(file);
      return;
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("missing");
      return;
    }
  }
  if (req.method === "GET" && url.pathname.startsWith("/assets/jobs/")) {
    const name = path.basename(url.pathname);
    const type = assetTypes[path.extname(name).toLowerCase()];
    if (type && /^[a-z0-9]+(?:-hero)?\.webp$/.test(name)) {
      try {
        const file = await readFile(new URL("assets/jobs/" + name, rootDir));
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
        res.end(file);
        return;
      } catch { /* fall through */ }
    }
  }
  const body=await readBody(req);
  let reqPath = url.pathname;
  if (req.method === "GET" && /^\/[a-z0-9][a-z0-9-]{1,40}$/.test(reqPath) && reqPath !== "/admin") reqPath = "/api/site" + reqPath;
  const result = await handleRequest({
    method: req.method,
    path: reqPath,
    query: url.searchParams,
    headers: req.headers,
    body,
    origin: "http://127.0.0.1:" + port
  });
  res.writeHead(result.status, result.headers || {});
  res.end(result.body || "");
  }catch(error){unavailable(res,error.status||503);}
});

server.listen(port, "127.0.0.1", () => {
  console.log("Hustle Builder host listening on http://127.0.0.1:" + port);
});
