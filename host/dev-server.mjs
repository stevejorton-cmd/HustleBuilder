import { createServer } from "http";
import { readFile } from "fs/promises";
import { fileStore, setStore } from "./lib/store.mjs";
import { handleRequest } from "./lib/router.mjs";

const dir = process.env.HB_STORE_DIR || ".hb-data";
setStore(fileStore(dir));
process.env.PUBLISH_TEST_MODE = process.env.PUBLISH_TEST_MODE || "1";
process.env.PAYWALL_MODE = process.env.PAYWALL_MODE || "test";
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || "dev-admin-secret";

const indexUrl = new URL("../index.html", import.meta.url);
const port = Number(process.env.PORT || 8787);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const file = await readFile(indexUrl);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(file);
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let path = url.pathname;
  if (req.method === "GET" && /^\/[a-z0-9][a-z0-9-]{1,40}$/.test(path)) path = "/api/site" + path;
  const result = await handleRequest({
    method: req.method,
    path,
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
