// TEMPORARY cutover tool (added Nov 1, 2026 for the PostgreSQL migration;
// removed in the follow-up cleanup immediately after the cutover).
// Runs the Blob -> PostgreSQL migration from inside the deployment, where
// DATABASE_URL and BLOB_READ_WRITE_TOKEN already exist. Inert unless ALL of:
// POST, HB_MAINTENANCE_MODE=1, and an x-migrate-token header whose SHA-256
// matches the MIGRATE_TOKEN_SHA env var. Apply mode additionally relies on
// migrate()'s own guard: it refuses a non-empty destination.
import { createHash, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { blobStore } from "../host/lib/store.mjs";
import { migrate } from "../scripts/migrate-storage.mjs";
import { SCHEMA } from "../host/lib/postgres-store.mjs";

export const maxDuration = 300;

export default async function handler(req, res) {
  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(obj));
  };
  if (req.method !== "POST") return send(405, { ok: false, error: "method" });
  if (process.env.HB_MAINTENANCE_MODE !== "1") return send(403, { ok: false, error: "maintenance-required" });
  const want = String(process.env.MIGRATE_TOKEN_SHA || "");
  const got = createHash("sha256").update(String(req.headers["x-migrate-token"] || "")).digest("hex");
  if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return send(403, { ok: false, error: "token" });
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let mode = "dry";
  try { mode = JSON.parse(body || "{}").mode || "dry"; } catch { /* keep default */ }
  if (!process.env.DATABASE_URL) return send(500, { ok: false, error: "no-database" });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      if (mode === "counts") {
        await client.query(SCHEMA);
        const rows = await client.query("SELECT count(*)::int AS n FROM hb_kv");
        const pageKeys = await client.query("SELECT count(*)::int AS n FROM hb_kv WHERE key LIKE 'pages/%'");
        const accounts = await client.query("SELECT count(*)::int AS n FROM hb_kv WHERE key LIKE 'accounts/%'");
        return send(200, { ok: true, rows: rows.rows[0].n, pageKeys: pageKeys.rows[0].n, accountKeys: accounts.rows[0].n });
      }
      const source = await blobStore();
      const out = await migrate(source, client, { apply: mode === "apply" });
      return send(200, { ok: true, ...out });
    } finally {
      client.release();
    }
  } catch {
    return send(500, { ok: false, error: "failed" });
  } finally {
    await pool.end();
  }
}
