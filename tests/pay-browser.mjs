// Browser check for the path that earns money: a parent whose free trial has
// ended follows the emailed link, pays from the account screen, and the page
// comes back — without republishing from whatever draft is on their device.
import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME || "/usr/local/bin/google-chrome";
const port = 18979;
const dir = await mkdtemp(path.join(tmpdir(), "hb-pay-"));
const base = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, ["host/dev-server.mjs"], {
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  env: { ...process.env, PORT: String(port), HB_STORE_DIR: dir, PUBLISH_TEST_MODE: "1", PAYWALL_MODE: "test", ADMIN_SECRET: "dev-admin-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server timeout")), 10000);
  child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
});
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, ...(detail ? { detail } : {}) }); };
const api = async (p, opt = {}) => {
  const res = await fetch(base + p, { method: opt.method || "POST", headers: { "content-type": "application/json", origin: base, ...(opt.token ? { authorization: "Bearer " + opt.token } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined, redirect: "manual" });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const sitePage = `<!DOCTYPE html><html><head><title>Sam</title></head><body><!-- hb-public --><h1>Sam's Yard Crew</h1></body></html>`;
let browser;
try {
  const email = "pay-browser@example.com";
  const start = JSON.parse((await api("/api/auth/start", { body: { email } })).text);
  const verify = JSON.parse((await api("/api/auth/verify", { body: { email, code: start.devCode } })).text);
  const token = verify.token;
  await api("/api/consent", { token, body: { consent: true } });
  await api("/api/publish", { token, body: { slug: "sam-yard", html: sitePage } });
  const [file] = await readdir(path.join(dir, "accounts"));
  const acctPath = path.join(dir, "accounts", file);
  const account = JSON.parse(await readFile(acctPath, "utf8"));
  account.trialEndsAt = new Date(Date.now() - 864e5).toISOString();
  await writeFile(acctPath, JSON.stringify(account));
  check("public page is on a break once the trial ends", /Taking a break/.test((await api("/sam-yard", { method: "GET" })).text));
  const acct = JSON.parse((await api("/api/account", { method: "GET", token })).text);
  const renewUrl = acct.sites[0].renew.year;

  browser = await puppeteer.launch({ executablePath: chrome, headless: "new", protocolTimeout: 120000, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { try { localStorage.setItem("hb_intro_seen", "1"); } catch (e) {} });
  // Sign in the way a parent does: the code comes back on screen in test mode.
  const signedIn = await page.evaluate(async (email) => {
    const s = await (await fetch("/api/auth/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) })).json();
    const v = await (await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: s.devCode }) })).json();
    return v.ok;
  }, email);
  check("parent signs in", signedIn);

  // The link from the "trial ended" email.
  await page.goto(renewUrl, { waitUntil: "domcontentloaded" });
  check("the emailed pay link opens the account with the plan picked", page.url() === base + "/?account=1&plan=year", page.url());
  await page.waitForSelector('#accountSites [data-pay="year"]', { timeout: 15000 });
  const before = await page.evaluate(() => ({
    year: document.querySelector('[data-pay="year"]').textContent,
    season: document.querySelector('[data-pay="season"]').textContent,
    yearPrimary: !document.querySelector('[data-pay="year"]').classList.contains("outline"),
    seasonPrimary: !document.querySelector('[data-pay="season"]').classList.contains("outline"),
    isButton: document.querySelector('[data-pay="year"]').tagName,
    status: document.querySelector("#accountSites .acct p").textContent
  }));
  check("account shows real pay buttons, not links back to the same page", before.isButton === "BUTTON" && before.year === "Pay, $19.99 year" && before.season === "Pay, $9.99 season", JSON.stringify(before));
  check("the plan from the email is the highlighted one", before.yearPrimary && !before.seasonPrimary);
  check("account says the trial is over", /trial is over/i.test(before.status), before.status);
  await page.waitForFunction(() => { const b = document.getElementById("pubPay"); return b && !b.hidden; }, { timeout: 15000 });
  check("the hosting panel offers to pay too", (await page.$eval("#pubPay", (b) => b.textContent)) === "Pay and bring the page back");
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check("no sideways scroll on a phone", overflow.sw <= overflow.cw + 2, JSON.stringify(overflow));

  await page.click('#accountSites [data-pay="year"]');
  await page.waitForFunction(() => /^Paid\./.test((document.getElementById("accountMsg") || {}).textContent || ""), { timeout: 15000 });
  const after = await page.evaluate(() => ({ msg: document.getElementById("accountMsg").textContent, buttons: document.querySelectorAll("#accountSites [data-pay]").length, status: document.querySelector("#accountSites .acct p").textContent, receipts: document.querySelectorAll("#accountSites .acct a.link").length }));
  check("paying confirms the plan and its end date", /Paid\. Full year runs through .+\d{4}\. The page is on\./.test(after.msg), after.msg);
  check("nothing more to buy right after paying", after.buttons === 0, String(after.buttons));
  check("account status shows the paid plan", /Full year through/.test(after.status), after.status);
  const live = (await api("/sam-yard", { method: "GET" })).text;
  check("the public page is back, unchanged", /Sam's Yard Crew/.test(live) && !/Taking a break/.test(live));

  // Coming back from the payment provider to the account must not republish
  // from this device's (empty) builder draft.
  const stored = await readFile(path.join(dir, "pages", "sam-yard.html"), "utf8");
  await page.evaluate(() => localStorage.setItem("hb-pay-return", "account"));
  await page.goto(base + "/?hosting=paid", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /Payment received\./.test((document.getElementById("accountMsg") || {}).textContent || ""), { timeout: 30000 });
  const ret = await page.evaluate(() => ({ msg: document.getElementById("accountMsg").textContent, err: document.getElementById("pubErr").textContent, url: location.pathname + location.search }));
  check("return from payment lands on the account with a clear message", /runs through .+\. The page is on\./.test(ret.msg) && ret.err === "" && ret.url === "/", JSON.stringify(ret));
  check("return from payment did not republish the page", (await readFile(path.join(dir, "pages", "sam-yard.html"), "utf8")) === stored);

  // A plan in its last weeks can be renewed early, and the time adds on.
  const paidAcct = JSON.parse(await readFile(acctPath, "utf8"));
  const soon = new Date(Date.now() + 9 * 864e5).toISOString();
  paidAcct.paidUntil = soon;
  await writeFile(acctPath, JSON.stringify(paidAcct));
  await page.goto(base + "/?account=1", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#accountSites [data-pay="season"]', { timeout: 15000 });
  check("a plan near its end offers Renew", (await page.$eval('[data-pay="year"]', (b) => b.textContent)) === "Renew, $19.99 year");
  await page.click('#accountSites [data-pay="year"]');
  await page.waitForFunction(() => /^Paid\./.test((document.getElementById("accountMsg") || {}).textContent || ""), { timeout: 15000 });
  const renewed = JSON.parse(await readFile(acctPath, "utf8"));
  check("early renewal adds a full year to the existing end date", Date.parse(renewed.paidUntil) === Date.parse(soon) + 365 * 864e5, renewed.paidUntil);

  // Legal pages render inside the shared shell.
  for (const name of ["privacy", "terms"]) {
    await page.goto(base + "/" + name, { waitUntil: "domcontentloaded" });
    const info = await page.evaluate(() => ({ h1: document.querySelector("h1").textContent, wide: document.documentElement.scrollWidth - document.documentElement.clientWidth, text: document.body.innerText }));
    check(name + " page renders on a phone", info.wide <= 2 && info.text.length > 800 && !/lawyer/i.test(info.text), info.h1);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, name + ".png"), fullPage: true });
  }
  if (process.env.SHOTS) {
    await page.goto(base + "/?account=1", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#accountSites .acct");
    await page.evaluate(() => document.getElementById("accountScreen").scrollIntoView({ block: "start", behavior: "instant" }));
    await page.screenshot({ path: path.join(process.env.SHOTS, "account.png") });
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (error) {
  check("pay flow ran to the end", false, String(error && error.stack || error).slice(0, 600));
} finally {
  if (browser) await browser.close();
  child.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => !r.pass)) process.exit(1);
