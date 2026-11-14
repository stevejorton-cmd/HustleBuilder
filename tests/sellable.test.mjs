// Regression tests for the November 10, 2026 product-readiness pass:
// a working way to pay and renew, fair season dates, plan switching,
// time zones, link-name rules, legal pages, operator tools and abuse limits.
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "crypto";
import { fileStore, setStore } from "../host/lib/store.mjs";
import { handleRequest, seasonOffer, SEASON_MIN_DAYS, RENEW_WINDOW_DAYS, MAX_PAGES_PER_ACCOUNT, CONSENT_VERSION } from "../host/lib/router.mjs";
import { jobInstant, jobsToIcs, gcalTemplate, validTz } from "../host/lib/calendar.mjs";
import { checkSlug } from "../host/lib/moderate.mjs";
import { decoratePage } from "../host/lib/preview.mjs";
import { flushMail, queueMail } from "../host/lib/mail.mjs";

let dir;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hb-sell-"));
  setStore(fileStore(dir));
  process.env.PUBLISH_TEST_MODE = "1";
  process.env.PAYWALL_MODE = "test";
  process.env.ADMIN_SECRET = "test-admin-secret";
  process.env.PUBLIC_ORIGIN = "http://sites.test";
});
test.afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "BOOKING_FROM"]) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  await rm(dir, { recursive: true, force: true });
});

const sha = (v) => createHash("sha256").update(String(v)).digest("hex");
function call(method, p, { body, token, headers, raw } = {}) {
  return handleRequest({
    method, path: p,
    headers: { origin: "http://sites.test", authorization: token ? "Bearer " + token : "", ...(headers || {}) },
    body: raw != null ? raw : (body ? JSON.stringify(body) : ""),
    origin: "http://sites.test",
    query: new URL("http://sites.test" + p).searchParams
  });
}
const json = async (res) => ({ status: res.status, body: JSON.parse(res.body || "{}") });
const page = (name) => `<!DOCTYPE html><html><head><title>${name}</title></head><body><!-- hb-public --><h1>${name}</h1></body></html>`;
async function parent(email = "parent@example.com") {
  const start = await json(await call("POST", "/api/auth/start", { body: { email } }));
  const verify = await json(await call("POST", "/api/auth/verify", { body: { email, code: start.body.devCode } }));
  await call("POST", "/api/consent", { token: verify.body.token, body: { consent: true } });
  const id = (await readFile(path.join(dir, "email", sha(email)), "utf8")).trim();
  return { email, token: verify.body.token, id };
}
const accountFile = (id) => path.join(dir, "accounts", id + ".json");
const readAccount = async (id) => JSON.parse(await readFile(accountFile(id), "utf8"));
async function patchAccount(id, fn) { const a = await readAccount(id); fn(a); await writeFile(accountFile(id), JSON.stringify(a)); }
const outbox = async (email) => (await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)))).body.messages;

/* ---------------- paying and renewing ---------------- */

test("a season is never sold with only days left: the offer rolls to the next season", () => {
  assert.match(seasonOffer(new Date("2026-06-15T12:00:00Z")).end, /^2026-08-31/);
  assert.match(seasonOffer(new Date("2026-08-01T12:00:00Z")).end, /^2026-08-31/, "exactly 30+ days left still sells this season");
  const lateSummer = seasonOffer(new Date("2026-08-20T12:00:00Z"));
  assert.equal(lateSummer.id, "winter");
  assert.match(lateSummer.end, /^2027-03-31/);
  const lastDay = seasonOffer(new Date("2026-08-31T20:00:00Z"));
  assert.match(lastDay.end, /^2027-03-31/, "the last day of summer no longer costs $9.99 for a few hours");
  const lateWinter = seasonOffer(new Date("2027-03-20T12:00:00Z"));
  assert.equal(lateWinter.id, "summer");
  assert.match(lateWinter.end, /^2027-08-31/);
  assert.match(seasonOffer(new Date("2026-11-10T12:00:00Z")).end, /^2027-03-31/);
  for (let day = 0; day < 366; day++) {
    const now = new Date(Date.UTC(2026, 0, 1 + day, 12));
    const left = (Date.parse(seasonOffer(now).end) - now.getTime()) / 864e5;
    assert.ok(left >= SEASON_MIN_DAYS, now.toISOString() + " sells only " + left.toFixed(1) + " days");
  }
});

test("a family whose trial ended can pay from the account, and the page comes back", async () => {
  const p = await parent("lapsed@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  await patchAccount(p.id, (a) => { a.trialEndsAt = new Date(Date.now() - 864e5).toISOString(); });
  assert.match((await call("GET", "/api/site/sam-yard")).body, /Taking a break/);
  const me = await json(await call("GET", "/api/me", { token: p.token }));
  assert.equal(me.body.trialOver, true);
  assert.equal(me.body.renewable, true);
  const acct = await json(await call("GET", "/api/account", { token: p.token }));
  assert.equal(acct.body.sites[0].renewable, true);
  // The emailed link no longer dead-ends: it opens the account with the plan picked.
  const link = await call("GET", new URL(acct.body.sites[0].renew.year).pathname + "?plan=year");
  assert.equal(link.status, 302);
  assert.equal(link.headers.location, "http://sites.test/?account=1&plan=year");
  const paid = await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } }));
  assert.equal(paid.body.ok, true);
  assert.ok(paid.body.paidUntil);
  const back = await call("GET", "/api/site/sam-yard");
  assert.match(back.body, /<h1>Sam<\/h1>/);
  assert.equal((await json(await call("GET", "/api/me", { token: p.token }))).body.renewable, false);
});

test("renewing early adds on to the end date; a plan with time left has nothing to buy", async () => {
  const p = await parent("early@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  const blocked = await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } }));
  assert.equal(blocked.body.alreadyPaid, true, "a fresh year plan cannot be bought twice");
  const end = new Date(Date.now() + 10 * 864e5).toISOString();
  await patchAccount(p.id, (a) => { a.paidUntil = end; });
  assert.equal((await json(await call("GET", "/api/me", { token: p.token }))).body.renewable, true);
  const renewed = await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } }));
  assert.equal(renewed.body.ok, true);
  assert.notEqual(renewed.body.alreadyPaid, true);
  assert.equal(Date.parse(renewed.body.paidUntil), Date.parse(end) + 365 * 864e5, "the ten days already paid for are kept");
  assert.equal((await readAccount(p.id)).receipts.length, 2);
  assert.ok(RENEW_WINDOW_DAYS >= 14, "the window covers the first reminder email");
});

test("a comped family is never offered a plan", async () => {
  const p = await parent("comp@example.com");
  await patchAccount(p.id, (a) => { a.comp = true; });
  assert.equal((await json(await call("GET", "/api/me", { token: p.token }))).body.renewable, false);
  assert.equal((await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } }))).body.alreadyPaid, true);
});

function stripeMock(state) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), method = opts.method || "GET";
    state.calls.push(method + " " + u.replace("https://api.stripe.com/v1/", ""));
    if (method === "POST" && u.endsWith("/checkout/sessions")) {
      const params = new URLSearchParams(String(opts.body));
      const id = "cs_test_" + (state.calls.length);
      state.sessions[id] = { id, url: "https://checkout.invalid/" + id, status: "open", payment_status: "unpaid", currency: "usd", amount_total: Number(params.get("line_items[0][price_data][unit_amount]")), metadata: { accountId: params.get("metadata[accountId]"), plan: params.get("metadata[plan]"), attempt: params.get("metadata[attempt]") }, name: params.get("line_items[0][price_data][product_data][name]"), key: opts.headers["Idempotency-Key"] };
      return new Response(JSON.stringify(state.sessions[id]), { status: 200 });
    }
    const expire = u.match(/checkout\/sessions\/([^/]+)\/expire$/);
    if (method === "POST" && expire) {
      const sess = state.sessions[expire[1]];
      if (sess.status !== "open") return new Response("{}", { status: 400 });
      sess.status = "expired";
      return new Response(JSON.stringify(sess), { status: 200 });
    }
    const get = u.match(/checkout\/sessions\/([^/]+)$/);
    if (method === "GET" && get) return new Response(JSON.stringify(state.sessions[get[1]]), { status: 200 });
    throw new Error("unexpected provider call " + method + " " + u);
  };
}

test("picking the other plan closes the open checkout instead of reusing the old price", async () => {
  const p = await parent("switch@example.com");
  process.env.PAYWALL_MODE = "stripe"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const state = { calls: [], sessions: {} };
  stripeMock(state);
  const season = await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "season" } }));
  const seasonId = Object.keys(state.sessions)[0];
  assert.equal(state.sessions[seasonId].amount_total, 999);
  assert.match(state.sessions[seasonId].name, /through March 31, 2027|through August 31, 20\d\d/, "the end date shows on the payment page");
  const same = await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "season" } }));
  assert.equal(same.body.url, season.body.url, "the same plan reuses its open session");
  assert.equal(same.body.reused, true);
  const year = await json(await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } }));
  assert.equal(state.sessions[seasonId].status, "expired", "the season session can no longer be paid");
  assert.notEqual(year.body.url, season.body.url);
  const yearId = Object.keys(state.sessions).find((id) => id !== seasonId);
  assert.equal(state.sessions[yearId].amount_total, 1999);
  assert.notEqual(state.sessions[yearId].key, state.sessions[seasonId].key, "a new attempt gets its own idempotency key");
  const acct = await readAccount(p.id);
  assert.equal(acct.checkoutSessionId, yearId);
  assert.equal(acct.checkoutPlan, "year");
});

test("the parent's return from Stripe applies the payment even if the webhook is late, exactly once", async () => {
  const p = await parent("return@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  process.env.PAYWALL_MODE = "stripe"; process.env.STRIPE_SECRET_KEY = "placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "placeholder";
  const state = { calls: [], sessions: {} };
  stripeMock(state);
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  const id = Object.keys(state.sessions)[0];
  const early = await json(await call("POST", "/api/checkout/confirm", { token: p.token, body: {} }));
  assert.equal(early.body.state, "open");
  assert.equal(early.body.paid, false);
  Object.assign(state.sessions[id], { status: "complete", payment_status: "paid" });
  const done = await json(await call("POST", "/api/checkout/confirm", { token: p.token, body: {} }));
  assert.equal(done.body.state, "paid");
  assert.equal(done.body.paid, true);
  const first = await readAccount(p.id);
  assert.equal(first.receipts.length, 1);
  assert.equal(first.checkoutSessionId, "");
  // The webhook for the same session arrives afterwards and changes nothing.
  const event = { id: "evt_late", type: "checkout.session.completed", data: { object: state.sessions[id] } };
  const raw = JSON.stringify(event), t = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", "placeholder").update(t + "." + raw).digest("hex");
  const hook = await json(await call("POST", "/api/stripe/webhook", { raw, headers: { "stripe-signature": "t=" + t + ",v1=" + sig } }));
  assert.equal(hook.body.duplicate, true);
  const after = await readAccount(p.id);
  assert.equal(after.paidUntil, first.paidUntil);
  assert.equal(after.receipts.length, 1);
  const receipts = (await outbox(p.email)).filter((m) => /receipt/i.test(m.subject));
  assert.equal(receipts.length, 1);
  assert.equal((await json(await call("POST", "/api/checkout/confirm", { body: {} }))).status, 401);
});

test("an unpaid or mismatched session is never applied on return", async () => {
  const p = await parent("unpaid@example.com");
  process.env.PAYWALL_MODE = "stripe"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const state = { calls: [], sessions: {} };
  stripeMock(state);
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  const id = Object.keys(state.sessions)[0];
  Object.assign(state.sessions[id], { status: "complete", payment_status: "unpaid" });
  assert.equal((await json(await call("POST", "/api/checkout/confirm", { token: p.token, body: {} }))).body.paid, false);
  Object.assign(state.sessions[id], { payment_status: "paid", amount_total: 1 });
  assert.equal((await json(await call("POST", "/api/checkout/confirm", { token: p.token, body: {} }))).body.paid, false);
  assert.equal((await readAccount(p.id)).paidUntil, null);
});

test("renewal reminders survive a missed cron day and say tomorrow, not 'in 1 days'", async () => {
  const p = await parent("cron@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  const inDays = (n) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + n, 12)).toISOString();
  const secret = { authorization: "Bearer test-admin-secret" };
  // Day 14 was missed; the run on day 13 still sends the first reminder.
  await patchAccount(p.id, (a) => { a.paidUntil = inDays(13); });
  const first = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
  assert.deepEqual(first.body.due.map((d) => [d.kind, d.days]), [["14", 13]]);
  assert.equal((await json(await call("GET", "/api/cron/renewals", { headers: secret }))).body.due.length, 0);
  await patchAccount(p.id, (a) => { const sent = a.sentReminders; a.paidUntil = inDays(1); a.sentReminders = Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.split(":")[0] + ":" + inDays(1).slice(0, 10), v])); });
  const second = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
  assert.deepEqual(second.body.due.map((d) => [d.kind, d.days]), [["3", 1]]);
  const subjects = (await outbox(p.email)).map((m) => m.subject);
  assert.ok(subjects.includes("Your Hustle Builder plan ends in 13 days"));
  assert.ok(subjects.includes("Your Hustle Builder plan ends tomorrow"));
});

/* ---------------- time zones ---------------- */

test("a family outside Central time gets calendar events at the hour the neighbor picked", async () => {
  assert.equal(new Date(jobInstant("2026-12-02T16:00", "America/New_York")).toISOString(), "2026-12-02T21:00:00.000Z");
  assert.equal(new Date(jobInstant("2026-07-02T16:00", "America/Los_Angeles")).toISOString(), "2026-07-02T23:00:00.000Z");
  assert.equal(new Date(jobInstant("2026-12-02T16:00")).toISOString(), "2026-12-02T22:00:00.000Z", "no zone still means Central");
  assert.equal(validTz("America/Denver"), "America/Denver");
  assert.equal(validTz("Mars/Olympus"), "");
  assert.equal(validTz("<script>"), "");
  const p = await parent("east@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam"), tz: "America/New_York" } });
  assert.equal((await readAccount(p.id)).tz, "America/New_York");
  const booked = await json(await call("POST", "/api/book", { body: { slug: "sam-yard", name: "Pat Jones", contact: "pat@example.com", service: "Mow", when: "Wednesday at 4:00 PM", address: "12 Elm St", start: "2026-12-02T16:00", t: 3000 }, headers: { "x-forwarded-for": "203.0.113.5" } }));
  assert.equal(booked.body.ok, true);
  const me = await json(await call("GET", "/api/me", { token: p.token }));
  const feed = await call("GET", new URL(me.body.calUrl).pathname);
  assert.match(feed.body, /DTSTART:20261202T210000Z/);
  assert.match(feed.body, /DTEND:20261202T220000Z/);
  assert.equal(feed.body.includes("TZID=America/Chicago"), false);
  const mail = (await outbox(p.email)).find((m) => /Booking request/.test(m.subject));
  assert.match(mail.text, /dates=20261202T210000Z\/20261202T220000Z/);
  assert.equal(mail.text.includes("ctz="), false);
  assert.match(mail.ics, /DTSTART:20261202T210000Z/);
  // A junk zone from the browser is ignored, not stored.
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam"), tz: "Not/AZone" } });
  assert.equal((await readAccount(p.id)).tz, "America/New_York");
  // Central families keep the exact feed they had.
  const central = jobsToIcs([{ id: "b12345678", start: "2026-12-02T16:00", service: "Mow", customer: "Pat" }], Date.parse("2026-11-10"));
  assert.match(central, /DTSTART;TZID=America\/Chicago:20261202T160000/);
  assert.match(central, /BEGIN:VTIMEZONE/);
  assert.equal(gcalTemplate({ id: "b1", start: "2026-12-02T16:00" }).includes("ctz="), false);
});

/* ---------------- link names and page text ---------------- */

test("ordinary business words are allowed in link names; impersonation words are not", () => {
  for (const ok of ["maya-yard-help", "sam-dog-walker", "mia-book-club", "josie-josies-pet-care", "leo-test-drive", "sam-page-turners"]) assert.equal(checkSlug(ok), "", ok);
  for (const bad of ["help", "book", "terms", "privacy", "admin", "hustle-support", "admin-login", "official-hustle", "sam-billing"]) assert.match(checkSlug(bad), /reserved/i, bad);
  assert.match(checkSlug("sam-smith"), /last name/i);
  assert.match(checkSlug("sam-walker"), /last name/i);
});

test("a title with $ signs is stored as typed", () => {
  const out = decoratePage(page("x"), { title: "Lawns from $$ and $& up $'", description: "Earn $$$ $`", image: "", url: "http://sites.test/sam-yard", indexable: false });
  assert.match(out, /og:title" content="Lawns from \$\$ and \$&amp; up \$'"/);
  assert.match(out, /name="description" content="Earn \$\$\$ \$`"/);
  assert.equal(out.match(/<\/head>/g).length, 1);
});

/* ---------------- legal pages and system pages ---------------- */

test("privacy and terms are real pages with no internal notes", async () => {
  const privacy = await call("GET", "/api/site/privacy");
  const terms = await call("GET", "/api/site/terms");
  for (const res of [privacy, terms]) {
    assert.equal(res.status, 200);
    assert.equal(/lawyer|TRIAL_DAYS|REPLY_TO|TODO|setting\b/.test(res.body), false);
    assert.match(res.body, /support@hustlebuilder\.org/);
    assert.match(res.body, /Last updated/);
  }
  assert.match(terms.body, /\$9\.99/);
  assert.match(terms.body, /\$19\.99/);
  assert.match(terms.body, /do not renew on their own/);
  assert.match(terms.body, /Payments for jobs go directly between neighbors and the family/);
  assert.match(privacy.body, /Stripe/);
  assert.match(privacy.body, /about 30 days/);
  assert.match(privacy.body, /50¢/);
  assert.match(privacy.body, /do not store the card number/i);
  assert.match(terms.body, /Parent check/);
  assert.match(terms.body, /refund the 50¢ in full/i);
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(src.includes("will be added before this app is sold"), false);
  assert.equal(src.includes("Nothing is sent to a server"), false);
  assert.equal(src.includes("does not process payments"), false);
  assert.match(src, /id="pubTerms"/);
});

test("host-made pages cannot be framed and do not leak private links", async () => {
  const p = await parent("frames@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  await call("POST", "/api/book", { body: { slug: "sam-yard", name: "Pat \"Q\" Jones", contact: "pat@example.com", service: "Mow", when: "Wednesday", address: "12 Elm St", start: "2026-12-02T16:00", t: 3000 }, headers: { "x-forwarded-for": "203.0.113.6" } });
  const mail = (await outbox(p.email)).find((m) => /Booking request/.test(m.subject));
  const jobPath = mail.text.match(/\/api\/job\/[a-f0-9]+/)[0];
  const job = await call("GET", jobPath);
  assert.equal(job.status, 200);
  assert.equal(job.headers["x-frame-options"], "DENY");
  assert.equal(job.headers["referrer-policy"], "no-referrer");
  assert.match(job.body, /id="no"/, "a parent can mark a request cancelled");
  assert.equal(mail.html.includes('Pat "Q" Jones'), false, "quotes are escaped in mail markup");
  assert.match(mail.html, /Pat &quot;Q&quot; Jones/);
  const gone = await call("GET", "/api/job/" + "a".repeat(24));
  assert.equal(gone.status, 404);
  assert.match(gone.body, /Hustle Builder/);
});

/* ---------------- operator tools ---------------- */

test("the admin dashboard can take a page down and put it back without the command line", async () => {
  const p = await parent("ops@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  const login = await call("POST", "/admin/login", { raw: "secret=test-admin-secret", headers: { "x-forwarded-for": "198.51.100.9" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.match(dash.body, /action="\/admin\/takedown"/);
  assert.match(dash.body, /Consent: card check, refunded/);
  const anon = await call("POST", "/admin/takedown", { raw: "slug=sam-yard" });
  assert.equal(anon.status, 302);
  assert.match((await call("GET", "/api/site/sam-yard")).body, /<h1>Sam<\/h1>/, "no session, no change");
  const down = await call("POST", "/admin/takedown", { raw: "slug=sam-yard", headers: { cookie } });
  assert.equal(down.status, 302);
  assert.match((await call("GET", "/api/site/sam-yard")).body, /taken down/);
  assert.equal((await json(await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } }))).body.error, "down");
  assert.match((await call("GET", "/admin", { headers: { cookie } })).body, /Put back/);
  const back = await call("POST", "/admin/restore", { raw: "slug=sam-yard", headers: { cookie } });
  assert.equal(back.status, 302);
  assert.match((await call("GET", "/api/site/sam-yard")).body, /<h1>Sam<\/h1>/);
  // The scripted form still works, and still needs the secret.
  assert.equal((await json(await call("POST", "/api/admin/takedown", { body: { slug: "sam-yard" } }))).status, 401);
  assert.equal((await json(await call("POST", "/api/admin/takedown", { body: { slug: "sam-yard" }, headers: { "x-admin-secret": "test-admin-secret" } }))).body.ok, true);
  assert.equal((await json(await call("POST", "/api/admin/restore", { body: { slug: "../x" }, headers: { "x-admin-secret": "test-admin-secret" } }))).status, 404);
});

/* ---------------- abuse limits and housekeeping ---------------- */

test("draft and job codes cannot be guessed without limit", async () => {
  const headers = { "x-forwarded-for": "198.51.100.77" };
  let last;
  for (let i = 0; i < 61; i++) last = await json(await call("GET", "/api/draft/" + ("aaaaaaa" + "abcdefghjk"[i % 10]), { headers }));
  assert.equal(last.status, 429);
  assert.equal((await json(await call("GET", "/api/my-jobs?code=zzzzzzzz", { headers }))).status, 429);
  assert.equal((await json(await call("GET", "/api/draft/aaaaaaaa", { headers: { "x-forwarded-for": "198.51.100.78" } }))).status, 404, "other visitors are unaffected");
  const blocked = await json(await call("POST", "/api/draft", { body: { draft: { first: "Sam", phone: "4025550199" } }, headers }));
  assert.equal(blocked.status, 403);
  const p = await parent("draftlimit@example.com");
  const made = await json(await call("POST", "/api/draft", { token: p.token, body: { draft: { first: "Sam" } }, headers }));
  assert.equal(made.body.ok, true);
  assert.equal((await json(await call("GET", "/api/draft/" + made.body.code, { headers }))).body.ok, true, "a real code still opens for a limited address");
});

test("one account cannot hold an unlimited number of pages", async () => {
  const p = await parent("many@example.com");
  await patchAccount(p.id, (a) => { a.slugs = Array.from({ length: MAX_PAGES_PER_ACCOUNT }, (_, i) => "kid-" + i); a.slug = "kid-0"; });
  const more = await json(await call("POST", "/api/publish", { token: p.token, body: { slug: "one-too-many", html: page("X") } }));
  assert.equal(more.status, 400);
  assert.equal(more.body.error, "pages");
});

test("the daily sweep clears old abuse counters and keeps today's", async () => {
  const store = fileStore(dir);
  await store.put("counters/2020-01-01/book-old", "3");
  await store.put("iplimit/legacy", "3");
  await store.put("adminsessions/" + "b".repeat(64) + ".json", JSON.stringify({ exp: Date.now() - 1000, version: 2 }));
  await call("POST", "/api/auth/start", { body: { email: "sweep@example.com" }, headers: { "x-forwarded-for": "198.51.100.80" } });
  const before = await store.list("counters/");
  assert.ok(before.length >= 3);
  const cron = await call("GET", "/api/cron/renewals", { headers: { authorization: "Bearer test-admin-secret" } });
  assert.equal(cron.status, 200);
  const after = await store.list("counters/");
  assert.equal(after.includes("counters/2020-01-01/book-old"), false);
  assert.equal(after.length, before.length - 1);
  assert.deepEqual(await store.list("iplimit/"), []);
  assert.deepEqual(await store.list("adminsessions/"), []);
});

test("mail the provider rejects outright is dropped after three tries; outages keep retrying", async () => {
  process.env.PUBLISH_TEST_MODE = "0"; process.env.RESEND_API_KEY = "placeholder"; process.env.BOOKING_FROM = "placeholder@example.com";
  const store = fileStore(dir);
  const quiet = console.error; console.error = () => {};
  try {
    let status = 422;
    globalThis.fetch = async () => new Response("{}", { status });
    await queueMail({ to: "bad address", subject: "s", text: "t" });
    const [key] = await store.list("mailqueue/");
    for (let i = 0; i < 3; i++) {
      const m = JSON.parse(await store.get(key) || "null");
      if (m) { m.nextAttemptAt = 0; await store.put(key, JSON.stringify(m)); }
      await flushMail();
    }
    assert.deepEqual(await store.list("mailqueue/"), [], "a rejected message does not retry for 30 days");
    status = 500;
    await queueMail({ to: "ok@example.com", subject: "s", text: "t" });
    const [key2] = await store.list("mailqueue/");
    for (let i = 0; i < 5; i++) {
      const m = JSON.parse(await store.get(key2)); m.nextAttemptAt = 0; await store.put(key2, JSON.stringify(m));
      await flushMail();
    }
    assert.equal(JSON.parse(await store.get(key2)).attempts, 5, "a provider outage is retried");
  } finally { console.error = quiet; process.env.PUBLISH_TEST_MODE = "1"; }
});

function signStripe(raw, secret = "placeholder") {
  const t = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secret).update(t + "." + raw).digest("hex");
  return { raw, headers: { "stripe-signature": "t=" + t + ",v1=" + sig } };
}
async function verifiedOnly(email) {
  const start = await json(await call("POST", "/api/auth/start", { body: { email } }));
  const verify = await json(await call("POST", "/api/auth/verify", { body: { email, code: start.body.devCode } }));
  const id = (await readFile(path.join(dir, "email", sha(email)), "utf8")).trim();
  return { email, token: verify.body.token, id };
}
function cardMock(state) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), method = opts.method || "GET";
    state.calls.push(method + " " + u.replace("https://api.stripe.com/v1/", ""));
    if (method === "POST" && u.endsWith("/checkout/sessions")) {
      const params = new URLSearchParams(String(opts.body));
      const id = "cs_test_verify_" + state.calls.length;
      state.sessions[id] = {
        id, url: "https://checkout.invalid/" + id, status: "open", payment_status: "unpaid", currency: "usd",
        amount_total: Number(params.get("line_items[0][price_data][unit_amount]")),
        customer_email: params.get("customer_email"),
        receipt_email: params.get("payment_intent_data[receipt_email]"),
        metadata: { accountId: params.get("metadata[accountId]"), purpose: params.get("metadata[purpose]"), notice: params.get("metadata[notice]") },
        payment_intent: "",
        name: params.get("line_items[0][price_data][product_data][name]")
      };
      return new Response(JSON.stringify(state.sessions[id]), { status: 200 });
    }
    if (method === "POST" && u.endsWith("/refunds")) {
      const params = new URLSearchParams(String(opts.body));
      state.refunds.push({ payment_intent: params.get("payment_intent"), purpose: params.get("metadata[purpose]"), key: opts.headers["Idempotency-Key"] });
      return new Response(JSON.stringify({ id: "re_test_" + state.refunds.length }), { status: 200 });
    }
    if (method === "GET" && u.includes("/checkout/sessions?")) {
      const q = new URL(u).searchParams.get("payment_intent");
      const found = Object.values(state.sessions).find((s) => s.payment_intent === q);
      return new Response(JSON.stringify({ data: found ? [found] : [] }), { status: 200 });
    }
    const get = u.match(/checkout\/sessions\/([^/?]+)$/);
    if (method === "GET" && get) {
      const sess = state.sessions[get[1]];
      return new Response(JSON.stringify(sess || {}), { status: sess ? 200 : 404 });
    }
    throw new Error("unexpected provider call " + method + " " + u);
  };
}

test("an unfinished 50 cent card check does not publish the page", async () => {
  process.env.PAYWALL_MODE = "stripe"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const state = { calls: [], sessions: {}, refunds: [] };
  cardMock(state);
  const p = await verifiedOnly("left-checkout@example.com");
  const started = await json(await call("POST", "/api/consent", { token: p.token, body: { consent: true } }));
  assert.equal(started.body.needsCard, true);
  assert.match(started.body.url, /^https:\/\/checkout\.invalid\//);
  const sess = Object.values(state.sessions)[0];
  assert.equal(sess.amount_total, 50);
  assert.equal(sess.metadata.purpose, "parent_verification");
  assert.equal(sess.customer_email, p.email);
  assert.equal(sess.receipt_email, p.email, "Stripe emails the receipt to the parent");
  assert.equal(sess.metadata.purpose === "parent_verification" && !sess.name.includes("hosting"), true);
  const pub = await json(await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } }));
  assert.equal(pub.status, 403);
  assert.equal(pub.body.error, "consent");
  const acct = await readAccount(p.id);
  assert.equal(acct.consentAt || null, null);
  assert.equal(state.refunds.length, 0);
  assert.equal((await call("GET", "/api/site/sam-yard")).status, 404);
});

test("a finished 50 cent check refunds, stores consent, and then publish is allowed", async () => {
  process.env.PAYWALL_MODE = "stripe"; process.env.STRIPE_SECRET_KEY = "placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "placeholder";
  const state = { calls: [], sessions: {}, refunds: [] };
  cardMock(state);
  const p = await verifiedOnly("card-ok@example.com");
  await call("POST", "/api/consent", { token: p.token, body: { consent: true } });
  const id = Object.keys(state.sessions)[0];
  Object.assign(state.sessions[id], { status: "complete", payment_status: "paid", payment_intent: "pi_verify_ok_1" });
  const event = { id: "evt_verify_ok", type: "checkout.session.completed", data: { object: state.sessions[id] } };
  const hook = await json(await call("POST", "/api/stripe/webhook", signStripe(JSON.stringify(event))));
  assert.equal(hook.status, 200);
  assert.equal(hook.body.verification, true);
  assert.equal(state.refunds.length, 1);
  assert.equal(state.refunds[0].payment_intent, "pi_verify_ok_1");
  assert.equal(state.refunds[0].purpose, "parent_verification");
  assert.match(state.refunds[0].key, /^hb-verify-refund-/);
  const again = await json(await call("POST", "/api/stripe/webhook", signStripe(JSON.stringify(event))));
  assert.equal(again.status, 200);
  assert.equal(state.refunds.length, 1, "the same check is refunded once");
  const acct = await readAccount(p.id);
  assert.equal(acct.consentMethod, "card_charge");
  assert.equal(acct.consentPaymentIntent, "pi_verify_ok_1");
  assert.equal(acct.consentVersion, CONSENT_VERSION);
  assert.ok(acct.consentAt);
  assert.ok(acct.consentRefundedAt);
  assert.equal(acct.card, undefined);
  assert.equal(JSON.stringify(acct).includes("last4"), false);
  const pub = await json(await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } }));
  assert.equal(pub.status, 200);
  const sibling = await json(await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-pets", html: page("Sam Pets") } }));
  assert.equal(sibling.status, 200);
  assert.equal(state.refunds.length, 1, "a second page does not charge the card again");
  const me = await json(await call("GET", "/api/me", { token: p.token }));
  assert.equal(me.body.consent, true);
  assert.equal(me.body.consentMethod, "card_charge");
});

test("coming back from the card check applies it on the server", async () => {
  process.env.PAYWALL_MODE = "stripe"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const state = { calls: [], sessions: {}, refunds: [] };
  cardMock(state);
  const p = await verifiedOnly("card-return@example.com");
  await call("POST", "/api/consent", { token: p.token, body: { consent: true } });
  const early = await json(await call("POST", "/api/consent/confirm", { token: p.token, body: {} }));
  assert.equal(early.body.consent, false);
  assert.equal(early.body.state, "open");
  const id = Object.keys(state.sessions)[0];
  Object.assign(state.sessions[id], { status: "complete", payment_status: "paid", payment_intent: "pi_verify_back_1" });
  const done = await json(await call("POST", "/api/consent/confirm", { token: p.token, body: {} }));
  assert.equal(done.body.consent, true);
  assert.equal(state.refunds.length, 1);
  const pub = await json(await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } }));
  assert.equal(pub.status, 200);
});

test("refunding the 50 cent parent check does not take the page or the plan down", async () => {
  const p = await parent("verify-refund@example.com");
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  const before = await readAccount(p.id);
  assert.equal(before.consentMethod, "card_charge");
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder";
  const event = { id: "evt_verify_refund", type: "charge.refunded", data: { object: { payment_intent: before.consentPaymentIntent, refunded: true, amount: 50, amount_refunded: 50 } } };
  const hook = await json(await call("POST", "/api/stripe/webhook", signStripe(JSON.stringify(event))));
  assert.equal(hook.body.verification, true);
  const after = await readAccount(p.id);
  assert.equal(after.paidUntil, before.paidUntil);
  assert.equal(after.plan, "year");
  assert.equal(after.receipts.filter((r) => r.refundedAt).length, 0);
  assert.equal((await call("GET", "/api/site/sam-yard")).status, 200);
});

/* ---------------- deployment files ---------------- */

test("server source and internal notes are not served to the public", async () => {
  const cfg = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const hidden = (p) => cfg.redirects.some((r) => new RegExp("^" + r.source + "$").test(p));
  for (const p of ["/host/lib/router.mjs", "/tests/host.test.mjs", "/stress/results.json", "/scripts/backup.mjs", "/package.json", "/package-lock.json", "/SETUP.md", "/REPAIR-HANDOFF.md", "/assets/pets/README.md", "/booking-inbox-script-template.gs.txt"]) assert.equal(hidden(p), true, p);
  for (const p of ["/", "/sam-yard", "/privacy", "/terms", "/admin", "/api/book", "/sw.js", "/icons/icon-192.png", "/assets/pets/pet-dog.webp", "/assets/heic2any.js", "/manifest.webmanifest"]) assert.equal(hidden(p), false, p);
  assert.deepEqual(cfg.crons.map((c) => c.path), ["/api/cron/renewals", "/api/cron/mail"]);
  assert.equal(cfg.rewrites.length, 5);
  assert.ok(cfg.rewrites.some((r) => r.source === "/parents" && r.destination === "/index.html"));
  const ignore = await readFile(new URL("../.vercelignore", import.meta.url), "utf8");
  for (const line of ["/tests", "/stress", "/scripts", "*.md"]) assert.ok(ignore.split("\n").includes(line), line);
  assert.equal(/^\/?(host|api|assets|icons|index\.html|package\.json|sw\.js)\b/m.test(ignore.replace(/^#.*$/gm, "")), false, "nothing the site needs is ignored");
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /res\.ok/);
  assert.match(sw, /cache\.put\(key, copy\)/);
});
