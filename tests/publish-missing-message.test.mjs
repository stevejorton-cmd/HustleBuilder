import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";

test("publish tells the kid why when required items are missing", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /if\(missing\(\)\.length\)\{updateLaunch\(\); pubErr\(/);
});
