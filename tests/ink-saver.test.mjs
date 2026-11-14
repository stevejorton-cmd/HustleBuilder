import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
function part(start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, start);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b > a, end);
  return src.slice(a, b);
}

test("ink saver is the default flyer and poster look for every job", () => {
  const theme = vm.createContext({});
  vm.runInContext(part("function flyerTheme(", "function drawHeadline("), theme);
  for (const type of ["lawn", "snow", "both", "pet", "odd", "wash", "help", "tutor", "other"]) {
    const ink = theme.flyerTheme({ type, style: "ink", accent: "#FF5B14" });
    assert.equal(ink.bg, "#FFFFFF", type);
    assert.equal(ink.ink, "#111111", type);
    assert.equal(ink.pcol, "#111111", type);
    assert.equal(ink.acc, "#111111", type);
    assert.equal(JSON.stringify(ink).includes("#FF5B14"), false, type);
    assert.equal(JSON.stringify(ink).includes("#0F6E6A"), false, type);
    assert.equal(JSON.stringify(ink).includes("#0E1012"), false, type);
    const bold = theme.flyerTheme({ type, style: "bold", accent: "#FF5B14" });
    assert.equal(bold.bg, "#0E1012", type);
    assert.equal(bold.bold, true, type);
  }
  const posters = vm.createContext({});
  vm.runInContext(part("function pTheme(", "function pFlakes("), posters);
  const inkPoster = posters.pTheme({ bg: "ink", accent: "#FF5B14" });
  assert.equal(inkPoster.bg, "#FFFFFF");
  assert.equal(inkPoster.ink, "#111111");
  assert.equal(inkPoster.inkSaver, true);
  assert.equal(JSON.stringify(inkPoster).includes("#FF5B14"), false);
  const colorPoster = posters.pTheme({ bg: "accent", accent: "#FF5B14" });
  assert.equal(colorPoster.bg, "#FF5B14");
  assert.equal(colorPoster.inkSaver, undefined);
  assert.match(src, /flyerStyle:"ink"/);
  assert.match(src, /bg:"ink"/);
  assert.match(src, /\["ink","Ink saver"\]/);
  assert.match(src, /S\.flyerStyle="ink";if\(S\.studio\)S\.studio\.bg="ink"/);
  assert.match(src, /style:"ink"/);
  assert.match(src, /--accent:#FF5B14/);
});
