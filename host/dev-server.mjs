import { createServer } from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileStore, setStore } from "./lib/store.mjs";
import { handleRequest } from "./lib/router.mjs";

const dir = process.env.HB_STORE_DIR || ".hb-data";
setStore(fileStore(dir));
process.env.PUBLISH_TEST_MODE = process.env.PUBLISH_TEST_MODE || "1";
process.env.PAYWALL_MODE = process.env.PAYWALL_MODE || "test";
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || "dev-admin-secret";

const indexUrl = new URL("../index.html", import.meta.url);
const rootDir = new URL("..", import.meta.url);
const port = Number(process.env.PORT || 8787);
const assetTypes = { ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let reqPath = url.pathname;
  if (req.method === "GET" && /^\/[a-z0-9][a-z0-9-]{1,40}$/.test(reqPath)) reqPath = "/api/site" + reqPath;
  const result = await handleRequest({
    method: req.method,
    path: reqPath,
    query: url.searchParams,
    headers: req.headers,
    body: Buffer.concat(chunks).toString("utf8"),
    origin: "http://127.0.0.1:" + port
  });
  res.writeHead(result.status, result.headers || {});
  res.end(result.body || "");
});

server.listen(port, "127.0.0.1", () => {
  console.log("Hustle Builder host listening on http://127.0.0.1:" + port);
});
