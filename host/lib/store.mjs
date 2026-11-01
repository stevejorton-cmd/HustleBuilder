import { mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

/** @typedef {{ get(key: string): Promise<string|null>, put(key: string, text: string): Promise<void>, del(key: string): Promise<void>, list(prefix: string): Promise<string[]> }} Store */

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
    },
    async list(prefix) {
      const out = [];
      const walk = async (rel) => {
        let entries;
        try { entries = await readdir(file(prefix + rel), { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
          if (entry.isDirectory()) await walk(rel + entry.name + "/");
          else if (entry.isFile()) out.push(prefix + rel + entry.name);
        }
      };
      await walk("");
      return out;
    }
  };
}

async function blobStore() {
  const { put, list: listBlobs, del, get } = await import("@vercel/blob");
  async function find(key) {
    const { blobs } = await listBlobs({ prefix: key, limit: 10 });
    return blobs.find((b) => b.pathname === key) || null;
  }
  return {
    async get(key) {
      // Accounts and page records are overwritten in place. The CDN copy can be up to
      // a minute old, so read from origin storage to see the latest write.
      const hit = await get(key, { access: "private", useCache: false });
      if (!hit || hit.statusCode !== 200 || !hit.stream) return null;
      return await new Response(hit.stream).text();
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
    },
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        const res = await listBlobs({ prefix, limit: 1000, cursor });
        for (const blob of res.blobs) out.push(blob.pathname);
        cursor = res.hasMore ? res.cursor : undefined;
      } while (cursor);
      return out;
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
