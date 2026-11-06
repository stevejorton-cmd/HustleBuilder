import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import path from "path";
import puppeteer from "puppeteer-core";

test("intro points at one local video and keeps a text fallback", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("const INTRO_VIDEO");
  const end = src.indexOf("initPublish();", start);
  const block = src.slice(start, end);
  assert.match(block, /const INTRO_VIDEO="\/assets\/intro\.mp4"/);
  assert.match(block, /const INTRO_CAPTIONS="\/assets\/intro\.vtt"/);
  assert.match(block, /const INTRO_KEY="hb_intro_seen"/);
  assert.match(block, /if\(!introSeen\(\)\)openIntro\(\)/);
  assert.match(block, /introSkip\.onclick=closeIntro/);
  assert.match(src, /<video id="introVideo" playsinline controls preload="metadata"><\/video>/);
  assert.doesNotMatch(src, /<video id="introVideo"[^>]*autoplay/);
  assert.match(src, /<b>Build<\/b>/);
  assert.match(src, /<b>Print<\/b>/);
  assert.match(src, /<b>Publish<\/b>/);
  assert.match(src, /data-intro>Watch intro/);
  assert.doesNotMatch(block, /youtube|vimeo|googletagmanager|google-analytics/i);
});

test("first visit shows the intro, skip is remembered, and Watch intro replays it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hb-intro-"));
  const port = 9100 + Math.floor(Math.random() * 80);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const child = spawn(process.execPath, ["host/dev-server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HB_STORE_DIR: dir, PUBLISH_TEST_MODE: "1", PAYWALL_MODE: "test" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let browser;
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 8000);
      child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); res(); } });
    });
    const missing = await fetch(`http://127.0.0.1:${port}/assets/intro.mp4`);
    assert.equal(missing.status, 404);
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME || "/usr/local/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#intro:not([hidden])");
    await page.waitForSelector("#introSteps:not([hidden])");
    const first = await page.evaluate(() => {
      const video = document.getElementById("introVideo");
      return {
        steps: document.getElementById("introSteps").textContent,
        autoplay: video.autoplay,
        muted: video.muted,
        playsInline: video.playsInline,
        controls: video.controls,
        tiles: !!document.getElementById("tiles"),
        videoHidden: video.hidden
      };
    });
    assert.match(first.steps, /Build/);
    assert.match(first.steps, /Print/);
    assert.match(first.steps, /Publish/);
    assert.equal(first.autoplay, false);
    assert.equal(first.muted, false);
    assert.equal(first.playsInline, true);
    assert.equal(first.controls, true);
    assert.equal(first.tiles, true);
    assert.equal(first.videoHidden, true);
    await page.click("#introSkip");
    await page.waitForSelector("#intro[hidden]");
    assert.equal(await page.evaluate(() => localStorage.getItem("hb_intro_seen")), "1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#intro[hidden]");
    assert.equal(await page.$eval("#intro", (el) => el.hidden), true);
    await page.click("#watchIntro");
    await page.waitForSelector("#intro:not([hidden])");
    await page.click("#introStart");
    await page.waitForSelector("#intro[hidden]");
    assert.equal(await page.evaluate(() => localStorage.getItem("hb_intro_seen")), "1");
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await page.$eval("#intro", (el) => el.hidden), true);
  } finally {
    if (browser) await browser.close();
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
