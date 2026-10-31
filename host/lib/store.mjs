import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

/** @typedef {{ get(key: string): Promise<string|null>, put(key: string, text: string): Promise<void>, del(key: string): Promise<void> }} Store */

/** @type {Store|null} */
let override = null;

export function fileStore(root) {
  const file = (key) => path.join(root, ...key.split("/").filter(Boolean));
  return {
    async get(key) {
      try { return await readFile(file(key), "utf8"); }
      catch { return null; }
    },
    async put(key, text) {
      const p = file(key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, text);
    },
    async del(key) {
      await rm(file(key), { force: true });
    }
  };
}

async function blobStore() {
  const { put, list, del } = await import("@vercel/blob");
  async function find(key) {
    const { blobs } = await list({ prefix: key, limit: 10 });
    return blobs.find((b) => b.pathname === key) || null;
  }
  return {
    async get(key) {
      const hit = await find(key);
      if (!hit) return null;
      const res = await fetch(hit.url, { headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` } });
      if (!res.ok) return null;
      return await res.text();
    },
    async put(key, text) {
      await put(key, text, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType: key.endsWith(".html") ? "text/html; charset=utf-8" : "application/json"
      });
    },
    async del(key) {
      const hit = await find(key);
      if (hit) await del(hit.url);
    }
  };
}

export function setStore(store) { override = store; }

let cached = null;
export async function store() {
  if (override) return override;
  if (!cached) {
    cached = process.env.BLOB_READ_WRITE_TOKEN ? await blobStore() : fileStore(process.env.HB_STORE_DIR || ".hb-data");
  }
  return cached;
}
