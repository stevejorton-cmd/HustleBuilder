import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import vm from "node:vm";
import { fileStore, setStore, store } from "../host/lib/store.mjs";
import { handleRequest } from "../host/lib/router.mjs";
import { venmoPayUrl } from "../host/lib/venmo.mjs";
import { withParentInquiry, familyVenmo } from "../host/lib/preview.mjs";
import { extractBuilderParts, demoCfg } from "./site-fixture.mjs";

const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const swSource = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const vercelConfig = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

function part(startMarker, endMarker) {
  const s = indexSource.indexOf(startMarker);
  const e = indexSource.indexOf(endMarker, s + startMarker.length);
  assert.ok(s >= 0 && e > s, `missing slice ${startMarker} .. ${endMarker}`);
  return indexSource.slice(s, e);
}

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hb-seamless-"));
  setStore(fileStore(dir));
  process.env.PUBLISH_TEST_MODE = "1";
  process.env.PAYWALL_MODE = "test";
  process.env.PUBLIC_ORIGIN = "http://sites.test";
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function call(method, urlPath, { body, token, headers, raw } = {}) {
  return handleRequest({
    method,
    path: urlPath,
    headers: { origin: "http://sites.test", authorization: token ? "Bearer " + token : "", ...(headers || {}) },
    body: raw != null ? raw : (body ? JSON.stringify(body) : ""),
    origin: "http://sites.test",
    query: new URL("http://sites.test" + urlPath).searchParams
  });
}
async function json(res) {
  return { status: res.status, body: JSON.parse(res.body || "{}") };
}
function samplePage(title, first = "Taylor") {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body><!-- hb-public --><h1>${title}</h1><p>Kid-owned. Parent-backed.</p><script>window.SITE_FIRST="${first}";</script></body></html>`;
}
async function makeParent(email) {
  const s = await json(await call("POST", "/api/auth/start", { body: { email } }));
  assert.equal(s.body.ok, true);
  const v = await json(await call("POST", "/api/auth/verify", { body: { email, code: s.body.devCode } }));
  assert.equal(v.body.ok, true);
  await call("POST", "/api/consent", { token: v.body.token, body: { consent: true } });
  return { email, token: v.body.token };
}

test("GET /api/book?busy=<slug> returns anonymized confirmed intervals only, follows redirects, and leaks zero PII", async () => {
  const parent = await makeParent("busy-parent@example.com");
  const pubA = await json(await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "sam-mows", html: samplePage("Sam Mows", "Sam"), consent: true, meta: { biz: "Sam Mows", first: "Sam" } }
  }));
  assert.equal(pubA.status, 200);
  const pubB = await json(await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "maya-pets", html: samplePage("Maya Pets", "Maya"), consent: true, meta: { biz: "Maya Pets", first: "Maya" } }
  }));
  assert.equal(pubB.status, 200);

  const future1 = "2028-06-15T10:00";
  const future2 = "2028-06-16T14:00";
  const futureB = "2028-06-17T09:00";

  // Booking 1 on sam-mows -> will be confirmed
  const b1 = await json(await call("POST", "/api/book", {
    headers: { origin: "null" },
    body: { slug: "sam-mows", name: "Secret Neighbor One", contact: "n1@example.com", service: "Full mow", price: "25", when: "Thursday, June 15 at 10:00 am", start: future1, address: "123 Secret Oak St", t: 5000 }
  }));
  assert.equal(b1.status, 200);

  // Booking 2 on sam-mows -> stays unconfirmed ("new")
  const b2 = await json(await call("POST", "/api/book", {
    headers: { origin: "null" },
    body: { slug: "sam-mows", name: "Unconfirmed Neighbor", contact: "n2@example.com", service: "Trim", price: "10", when: "Friday, June 16 at 2:00 pm", start: future2, address: "456 Maple Ave", t: 5000 }
  }));
  assert.equal(b2.status, 200);

  // Booking 3 on sibling maya-pets -> confirmed, must NOT leak into sam-mows busy list
  const b3 = await json(await call("POST", "/api/book", {
    headers: { origin: "null" },
    body: { slug: "maya-pets", name: "Sibling Customer", contact: "n3@example.com", service: "Dog walk", price: "12", when: "Saturday, June 17 at 9:00 am", start: futureB, address: "789 Pine Rd", t: 5000 }
  }));
  assert.equal(b3.status, 200);

  // Confirm b1 and b3 via /api/my-jobs action tokens
  const myJobs = await json(await call("GET", "/api/my-jobs", { token: parent.token }));
  const row1 = myJobs.body.jobs.find((j) => j.service === "Full mow");
  const row3 = myJobs.body.jobs.find((j) => j.service === "Dog walk");
  assert.ok(row1 && row1.action && row1.start === future1, "kidJob should include non-PII start timestamp");
  await call("POST", "/api/job/" + row1.action, { body: { status: "confirmed", json: true } });
  await call("POST", "/api/job/" + row3.action, { body: { status: "confirmed", json: true } });

  const busyRes = await call("GET", "/api/book?busy=sam-mows", { headers: { origin: "null" } });
  assert.equal(busyRes.status, 200);
  assert.equal(busyRes.headers["access-control-allow-origin"], "null");
  const busyJson = JSON.parse(busyRes.body);
  assert.equal(busyJson.ok, true);
  assert.equal(busyJson.busy.length, 1);
  assert.equal(busyJson.busy[0][0], future1);
  assert.equal(busyJson.busy[0][1], "2028-06-15T11:00");
  // Zero PII in raw response
  assert.doesNotMatch(busyRes.body, /Secret|Neighbor|example\.com|Oak|Maple|Pine/i);

  // Rename sam-mows -> sam-yards and verify old slug redirect works for busy endpoint too
  const ren = await json(await call("POST", "/api/slug", { token: parent.token, body: { from: "sam-mows", slug: "sam-yards" } }));
  assert.equal(ren.status, 200);
  const busyRedirect = await json(await call("GET", "/api/book?busy=sam-mows", { headers: { origin: "null" } }));
  assert.equal(busyRedirect.status, 200);
  assert.equal(busyRedirect.body.busy.length, 1);
  assert.equal(busyRedirect.body.busy[0][0], future1);
});

test("Phone-only confirmed booking calendar download returns 200 text/calendar instead of 404", async () => {
  const parent = await makeParent("phone-cal@example.com");
  await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "leo-snow", html: samplePage("Leo Snow", "Leo"), consent: true, meta: { biz: "Leo Snow", first: "Leo" } }
  });
  const booked = await json(await call("POST", "/api/book", {
    headers: { origin: "null" },
    body: { slug: "leo-snow", name: "Pat", contact: "402-555-0144", service: "Driveway", price: "20", when: "Monday, December 14 at 8:00 am", start: "2028-12-14T08:00", address: "10 Snow Ln", t: 5000 }
  }));
  assert.equal(booked.status, 200);
  assert.ok(booked.body.manageUrl);
  const token = booked.body.manageUrl.split("/booking/")[1];
  const jobs = await json(await call("GET", "/api/my-jobs", { token: parent.token }));
  await call("POST", "/api/job/" + jobs.body.jobs[0].action, { body: { status: "confirmed", json: true } });

  const ics = await call("GET", "/api/booking/" + token + "/calendar.ics");
  assert.equal(ics.status, 200);
  assert.match(ics.headers["content-type"], /text\/calendar/);
  assert.match(ics.body, /BEGIN:VCALENDAR/);
  assert.match(ics.body, /BEGIN:VEVENT/);
  assert.match(ics.body, /DTSTART[^:]*:20281214T080000/);
});

test("GET /api/event/:token.ics rejects expired tokens with 404 and serves unexpired tokens", async () => {
  const s = await store();
  const validTok = "a".repeat(32);
  const expiredTok = "b".repeat(32);
  await s.put(`events/${validTok}.json`, JSON.stringify({
    id: "event_001", service: "Mow", summary: "Sam: Mow", start: "2028-07-01T10:00",
    expiresAt: Date.now() + 864e5
  }));
  await s.put(`events/${expiredTok}.json`, JSON.stringify({
    id: "event_002", service: "Mow", summary: "Sam: Mow", start: "2028-07-01T10:00",
    expiresAt: Date.now() - 1000
  }));

  const okRes = await call("GET", `/api/event/${validTok}.ics`);
  assert.equal(okRes.status, 200);
  assert.match(okRes.headers["content-type"], /text\/calendar/);

  const expRes = await call("GET", `/api/event/${expiredTok}.ics`);
  assert.equal(expRes.status, 404);
});

test("POST /api/job/:token browser form POST errors return styled HTML and place status at top", async () => {
  const parent = await makeParent("form-err@example.com");
  await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "kai-wash", html: samplePage("Kai Wash", "Kai"), consent: true, meta: { biz: "Kai Wash", first: "Kai" } }
  });
  await call("POST", "/api/book", {
    headers: { origin: "null" },
    body: { slug: "kai-wash", name: "Robin", contact: "robin@example.com", service: "Car wash", price: "15", when: "Saturday, May 20 at 10:00 am", start: "2028-05-20T10:00", address: "55 Elm", t: 5000 }
  });
  const jobs = await json(await call("GET", "/api/my-jobs", { token: parent.token }));
  const act = jobs.body.jobs[0].action;

  // Browser form POST with invalid status returns styled HTML (not raw JSON)
  const badForm = await call("POST", "/api/job/" + act, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    raw: "status=bogus_status"
  });
  assert.equal(badForm.status, 400);
  assert.match(badForm.headers["content-type"], /text\/html/);
  assert.match(badForm.body, /role="alert"/);
  assert.match(badForm.body, /Choose a valid booking action/);

  // Valid browser form POST places role="status" above the booking details
  const goodForm = await call("POST", "/api/job/" + act, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    raw: "status=confirmed"
  });
  assert.equal(goodForm.status, 200);
  const h1Idx = goodForm.body.indexOf("<h1>");
  const statusIdx = goodForm.body.indexOf('role="status"');
  const detailsIdx = goodForm.body.indexOf("Status: <b>");
  assert.ok(h1Idx >= 0 && statusIdx > h1Idx && statusIdx < detailsIdx, "status confirmation should appear right below h1");
});

test("GET /api/views returns bySlug for all sibling pages and POST /api/slug preserves view counts", async () => {
  const parent = await makeParent("views-family@example.com");
  await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "kid-one", html: samplePage("Kid One", "One"), consent: true, meta: { biz: "Kid One", first: "One" } }
  });
  await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "kid-two", html: samplePage("Kid Two", "Two"), consent: true, meta: { biz: "Kid Two", first: "Two" } }
  });

  // Record views on both public pages
  const ua = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" };
  await call("GET", "/api/site/kid-one", { headers: ua });
  await call("GET", "/api/site/kid-one", { headers: ua });
  await call("GET", "/api/site/kid-two", { headers: ua });

  const views = await json(await call("GET", "/api/views", { token: parent.token }));
  assert.equal(views.status, 200);
  assert.equal(views.body.ok, true);
  assert.equal(views.body.bySlug["kid-one"].total, 2);
  assert.equal(views.body.bySlug["kid-two"].total, 1);

  // Rename kid-one -> kid-one-new and confirm view count carries over
  const ren = await json(await call("POST", "/api/slug", { token: parent.token, body: { from: "kid-one", slug: "kid-one-new" } }));
  assert.equal(ren.status, 200);
  const viewsAfter = await json(await call("GET", "/api/views", { token: parent.token }));
  assert.equal(viewsAfter.body.bySlug["kid-one-new"].total, 2);
});

test("Range prices ($5-$8) never concatenate into $58 across Venmo, preview, and builder helpers", () => {
  assert.equal(venmoPayUrl("parent-pay", { amount: "$5-$8", note: "Walk" }), "https://venmo.com/parent-pay?txn=pay&amount=5&note=Walk");
  assert.equal(venmoPayUrl("parent-pay", { amount: "$12.50 - $20", note: "Mow" }), "https://venmo.com/parent-pay?txn=pay&amount=12.5&note=Mow");

  const sampleHtml = `<html><body><script>var C={"first":"Sam","services":[{"n":"Walk","p":"$5-$8"}]};</script><section id="book"></section></body></html>`;
  const withVenmo = familyVenmo(sampleHtml, "parent-pay", "Sam");
  assert.match(withVenmo, /amount=5/);
  assert.doesNotMatch(withVenmo, /amount=58/);

  const ctx = vm.createContext({});
  vm.runInContext(
    part("function priceNum(", "const RIGS=") + "\n" +
    part("function venmoPayHref(", "function doneMsg("),
    ctx
  );
  assert.equal(ctx.venmoPayHref("parent-pay", "$5-$8", "Walk"), "https://venmo.com/parent-pay?txn=pay&amount=5&note=Walk");
  assert.equal(ctx.priceNum("$1,000"), 1000);
  assert.equal(ctx.priceTooHigh(ctx.priceNum("$1,000")), true);
  assert.equal(ctx.priceNeedsConfirm(ctx.priceNum("$250")), true);
  assert.equal(ctx.priceNum("$5-$8"), null);
});

test("Parent inquiry banner uses theme CSS variables, sw.js caches /parents + 5xx fallback, and vercel.json secures /parents", () => {
  const html = withParentInquiry("<html><body><section id=\"book\"></section></body></html>", "sam-mows");
  assert.match(html, /var\(--card/);
  assert.match(html, /var\(--accent/);
  assert.match(html, /var\(--line/);

  assert.match(swSource, /const CACHE = "hustle-shell-5"/);
  assert.match(swSource, /\/assets\/barlow\.css/);
  assert.match(swSource, /\/assets\/print-libs\.js/);
  assert.match(swSource, /\/assets\/gear-studio\.mjs/);
  assert.match(swSource, /url\.pathname === "\/parents"/);
  assert.match(swSource, /res\.ok && res\.type === "basic"/);
  assert.match(swSource, /cache\.match\(key\)/);

  const parentsHeaders = vercelConfig.headers.find((h) => h.source === "/parents");
  assert.ok(parentsHeaders, "vercel.json should configure headers for /parents");
  const keys = new Set(parentsHeaders.headers.map((h) => h.key));
  assert.ok(keys.has("X-Frame-Options"));
  assert.ok(keys.has("X-Content-Type-Options"));
  assert.ok(keys.has("Referrer-Policy"));
});

test("Poster Studio HEADS covers all 10 types, pFlakes only snows on snow/both, and flyerFull/drawFlyerStyled polish holds", () => {
  const ctx = vm.createContext({ PW: 850, PH: 1100 });
  const { HEADS, pFlakes } = vm.runInContext(
    part("const HEADS={", "const BADGES=") + "\n" +
    part("function pFlakes(", "function pGrit(") + "\n({ HEADS, pFlakes });",
    ctx
  );
  for (const t of ["lawn", "snow", "both", "prep", "pet", "wash", "odd", "help", "tutor", "other"]) {
    assert.ok(Array.isArray(HEADS[t]) && HEADS[t].length >= 4, `HEADS missing ${t}`);
  }
  const countArcs = (type) => {
    let arcs = 0;
    const mockCtx = { fillStyle: "", beginPath() {}, arc() { arcs++; }, fill() {} };
    pFlakes(mockCtx, { bg: "dark", type }, { dark: true });
    return arcs;
  };
  assert.equal(countArcs("snow"), 70);
  assert.equal(countArcs("both"), 34);
  for (const t of ["lawn", "prep", "pet", "wash", "odd", "help", "tutor", "other"]) {
    assert.equal(countArcs(t), 0, `pFlakes must not draw snow on ${t}`);
  }

  const flyerFullSrc = part("function flyerFull(", "function hangerOne(");
  assert.match(flyerFullSrc, /KEEP YOU INFORMED\./);
  const drawFlyerStyledSrc = part("function drawFlyerStyled(", "function flyerCfg(");
  assert.doesNotMatch(drawFlyerStyledSrc, /paintPetRow/, "drawFlyerStyled should not stomp cards/tabs/hanger/sign with an overlay pet strip");
});

test("Kid features: custom story keeps parent confirmation, Money Jars & Goal Jobs math, Prep Checklists, Playbook scripts, and CSV safety", () => {
  const helpers = extractBuilderParts(indexSource);
  const siteHtml = helpers.genSite(demoCfg({
    type: "pet", look: "day", theme: "neighbor", sky: "sunny", art: "cine-sunny",
    pets: ["dog"], publicUrl: "https://hustlebuilder.org/maya",
    promise: "If something is not right, tell us within 2 days.", venmo: "parent-pay",
    parentName: "Jordan", phoneDigits: "", showPhone: false, email: "",
    first: "Maya", town: "Elkhorn", biz: "Maya's Pet Care", tagline: "Happy pets.",
    about: "I'm saving for a new bike! Jordan, my parent, confirms every booking.",
    services: [{ n: "Dog walk, 15 minutes", p: "8" }, { n: "Pet feeding drop-in", p: "10" }],
    palette: "forest", publish: { slug: "maya", book: "https://hustlebuilder.org/api/book" }
  }));
  assert.match(siteHtml, /data-svc="Dog walk, 15 minutes"/, "rates items should be tappable with data-svc");
  assert.match(siteHtml, /id="bookSummary"/, "booking form should include live summary strip");
  assert.match(siteHtml, /Open booking status & questions/, "post-booking confirmation should surface manageUrl button");

  // Boss helpers: calcJars, goalJobsHTML, prepChecklistHTML, csvEsc
  const ctx = vm.createContext({
    esc: (s) => String(s ?? ""),
    priceNum: (p) => { const n = Number(String(p || "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; },
    num: (v) => parseFloat(String(v || "").replace(/[^0-9.]/g, "")) || 0,
    r2: (n) => Math.round((Number(n) || 0) * 100) / 100,
    money: (n) => "$" + (Math.round(n * 100) / 100)
  });
  vm.runInContext(
    part("const PREP_ITEMS={", "let lastProfit=0") + "\n" +
    part("function csvEsc(", "async function exportCSV("),
    ctx
  );

  // Money Jars sum exactly to profit
  const split = ctx.calcJars(123.45, "balanced");
  const sum = Math.round(split.jars.reduce((a, j) => a + j.amt, 0) * 100) / 100;
  assert.equal(sum, 123.45);
  const zeroSplit = ctx.calcJars(-20, "grow");
  assert.equal(zeroSplit.base, 0);
  assert.equal(zeroSplit.jars.reduce((a, j) => a + j.amt, 0), 0);

  // Goal jobs remaining
  const goalMsg = ctx.goalJobsHTML(50, 250, 20, [{ n: "Full mow", p: "25", on: true }]);
  assert.match(goalMsg, /8 more Full mow/);
  const reachedMsg = ctx.goalJobsHTML(300, 250, 20, [{ n: "Full mow", p: "25", on: true }]);
  assert.match(reachedMsg, /Goal reached/);

  // Prep checklists exist for all types and remind kids to tell a parent
  for (const t of ["lawn", "snow", "both", "prep", "pet", "wash", "odd", "help", "tutor", "other"]) {
    const html = ctx.prepChecklistHTML(t);
    assert.match(html, /Before you head out/);
    assert.match(html, /parent/i);
  }

  // CSV formula neutralization
  assert.equal(ctx.csvEsc("=CMD()"), "'=CMD()");
  assert.equal(ctx.csvEsc("+1234"), "'+1234");
  assert.equal(ctx.csvEsc("-2+3"), "'-2+3");
  assert.equal(ctx.csvEsc("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(ctx.csvEsc("Sarah"), "Sarah");

  // Playbook scripts personalized & safe
  const pbCtx = vm.createContext({
    S: { type: "pet", customJob: "" },
    resolve: () => ({ first: "Maya", town: "Elkhorn", biz: "Maya's Pet Care", venmo: "parent-pay", services: [{ n: "Dog walk", p: "8" }] }),
    linkOrPlaceholder: () => "https://hustlebuilder.org/maya",
    typeInfo: () => ({ label: "Pet care" }),
    fmtPrice: (p) => "$" + p
  });
  vm.runInContext(part("function playbookScripts(){", "function openPlaybook(){"), pbCtx);
  const scripts = pbCtx.playbookScripts();
  assert.equal(scripts.length, 4);
  assert.match(scripts[0].script, /Maya/);
  assert.match(scripts[0].tip, /Safety rule/i);
  assert.match(scripts[1].script, /https:\/\/hustlebuilder\.org\/maya/);
  assert.match(scripts[3].script, /@parent-pay/);

  // Custom story in resolve() always appends parent confirmation
  const resSrc = part("function resolve(preview, opt){", "/* ============ Builder UI");
  assert.match(resSrc, /customAbout/);
  assert.match(resSrc, /parentLine/);

  // Brotli size stays well under 300 KB
  assert.ok(brotliCompressSync(indexSource).length < 300000);
});
