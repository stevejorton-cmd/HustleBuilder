import { handleRequest } from "../host/lib/router.mjs";

function pathnameFrom(req) {
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const url = new URL(req.url || "/", proto + "://" + host);
  if (url.pathname.startsWith("/api/")) return { pathname: url.pathname, query: url.searchParams, origin: process.env.PUBLIC_ORIGIN || (proto + "://" + host) };
  const parts = [].concat(req.query && req.query.path || []).flat().filter(Boolean);
  return { pathname: "/api/" + parts.join("/"), query: url.searchParams, origin: process.env.PUBLIC_ORIGIN || (proto + "://" + host) };
}

export default async function handler(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const { pathname, query, origin } = pathnameFrom(req);
  const result = await handleRequest({
    method: req.method,
    path: pathname,
    query,
    headers: req.headers,
    body,
    origin
  });
  res.statusCode = result.status;
  for (const [key, value] of Object.entries(result.headers || {})) {
    if (value != null && value !== "") res.setHeader(key, value);
  }
  res.end(result.body || "");
}
