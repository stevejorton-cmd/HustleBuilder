import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

test("local dev server serves job tile art under /assets/jobs/", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hb-assets-"));
  const port = 8900 + Math.floor(Math.random() * 90);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const child = spawn(process.execPath, ["host/dev-server.mjs"], { cwd: root, env: { ...process.env, PORT: String(port), HB_STORE_DIR: dir, PUBLISH_TEST_MODE: "1", PAYWALL_MODE: "test" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), 8000); child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); res(); } }); });
    for (const n of ["wash", "odd", "help", "tutor", "other", "wash-hero"]) {
      const r = await fetch(`http://127.0.0.1:${port}/assets/jobs/${n}.webp`);
      assert.equal(r.status, 200, n);
      assert.equal(r.headers.get("content-type"), "image/webp");
    }
  } finally { child.kill(); await rm(dir, { recursive: true, force: true }); }
});
