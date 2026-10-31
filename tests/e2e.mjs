import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME || "/usr/local/bin/google-chrome";
const port = Number(process.env.PORT || 8799);
const dir = await mkdtemp(path.join(tmpdir(), "hb-e2e-"));
const out = process.env.SHOTS || "/tmp/qa-host";
await import("fs/promises").then((fs) => fs.mkdir(out, { recursive: true }));

const child = spawn(process.execPath, ["host/dev-server.mjs"], {
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  env: { ...process.env, PORT: String(port), HB_STORE_DIR: dir, PUBLISH_TEST_MODE: "1", PAYWALL_MODE: "test", ADMIN_SECRET: "dev-admin-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server timeout")), 10000);
  child.stdout.on("data", (d) => {
    if (String(d).includes("listening")) { clearTimeout(t); resolve(); }
  });
});

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const base = "http://127.0.0.1:" + port;
const fails = [];
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " " + detail : ""));
  if (!ok) fails.push(name + " " + detail);
}

try {
  const page = await browser.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(String(e).slice(0, 180)));
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.click("#next");
  await page.type('input[data-k="first"]', "Sam");
  await page.type('input[data-k="town"]', "Elkhorn");
  await page.type("#tagline", "Clean edges.");
  for (let i = 0; i < 2; i++) await page.click("#next");
  await page.evaluate(() => document.querySelectorAll("#days button")[1].click());
  await page.click("#next");
  await page.type('input[data-k="phone"]', "4025550148");
  for (let i = 0; i < 3; i++) await page.click("#next");
  await page.waitForSelector("#pubEmail");
  check("on publish step", (await page.$eval("#plabel", (e) => e.textContent)) === "Step 8 of 8");
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check("desktop overflow", ov.sw <= ov.cw + 2, JSON.stringify(ov));
  await page.evaluate(() => document.getElementById("pubEmail").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.screenshot({ path: path.join(out, "publish_desktop.png") });
  await page.type("#pubEmail", "parent@example.com");
  await page.click("#pubSend");
  await page.waitForFunction(() => /code is \d{6}/.test(document.getElementById("pubCodeMsg").textContent));
  const code = (await page.$eval("#pubCodeMsg", (e) => e.textContent)).match(/(\d{6})/)[1];
  await page.type("#pubCode", code);
  await page.click("#pubVerify");
  await page.waitForSelector("#pubReady:not([hidden])");
  await page.$eval("#pubConsent", (el) => { el.checked = true; });
  await page.click("#pubSlug", { clickCount: 3 });
  await page.type("#pubSlug", "sam-yard");
  await page.click("#pubGo");
  try {
    await page.waitForFunction(() => /Published/.test(document.getElementById("pubOk").textContent), { timeout: 20000 });
  } catch (err) {
    console.log("pubErr", await page.$eval("#pubErr", (e) => e.textContent));
    console.log("pubOk", await page.$eval("#pubOk", (e) => e.textContent));
    console.log("goDisabled", await page.$eval("#pubGo", (e) => e.disabled + " " + e.hidden));
    console.log("pageerrors", logs);
    throw err;
  }
  const url = await page.$eval("#pubUrl", (a) => a.href);
  check("stable url", url === base + "/sam-yard", url);
  await page.screenshot({ path: path.join(out, "published_desktop.png") });

  const site = await browser.newPage();
  await site.setViewport({ width: 390, height: 844 });
  await site.goto(url, { waitUntil: "domcontentloaded" });
  const h1 = await site.$eval("h1", (e) => e.textContent);
  check("live h1", /Sam/.test(h1), h1);
  const phoneOv = await site.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check("phone site overflow", phoneOv.sw <= phoneOv.cw + 2, JSON.stringify(phoneOv));
  await site.evaluate(() => document.getElementById("book").scrollIntoView({ block: "start", behavior: "instant" }));
  await site.screenshot({ path: path.join(out, "live_phone_book.png") });
  const day = await site.evaluate(() => {
    const b = [...document.querySelectorAll(".day")].find((el) => !el.disabled);
    if (!b) return "";
    b.click();
    return b.textContent;
  });
  check("open day", !!day, day);
  await site.type("#nm", "Riley");
  await site.type("#ct", "402-555-0199");
  await site.type("#addr", "999 Secret Lane");
  await site.click("#sendHost");
  await site.waitForFunction(() => /email/.test(document.getElementById("sentBox").textContent));
  const sent = await site.$eval("#sentBox", (e) => e.textContent);
  check("booking sent", /parent got an email/.test(sent), sent.slice(0, 80));
  const stored = await fetch(url).then((r) => r.text());
  check("address not stored on page", !stored.includes("999 Secret Lane"));
  await site.screenshot({ path: path.join(out, "live_phone_sent.png") });

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => document.getElementById("pubBox").scrollIntoView({ block: "start", behavior: "instant" }));
  const pov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, step: document.getElementById("plabel").textContent }));
  check("phone builder overflow", pov.sw <= pov.cw + 2, JSON.stringify(pov));
  await page.screenshot({ path: path.join(out, "publish_phone.png") });

  const again = await page.evaluate(async (liveUrl) => {
    const session = JSON.parse(localStorage.getItem("hb-parent-session"));
    const html = (await fetch(liveUrl).then((r) => r.text())).replace("Clean edges.", "Fresh cut.");
    const res = await fetch(location.origin + "/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
      body: JSON.stringify({ slug: session.slug, html })
    });
    return res.json();
  }, url);
  check("republish same url", again.ok && again.url === url, JSON.stringify(again));
  await site.reload({ waitUntil: "domcontentloaded" });
  const tag = await site.$eval(".tag", (e) => e.textContent);
  check("republish content", /Fresh cut/.test(tag), tag);
  check("console", logs.length === 0, logs.join(" | "));
} finally {
  await browser.close();
  child.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
if (fails.length) {
  console.error(fails.join("\n"));
  process.exit(1);
}
console.log("e2e ok");
