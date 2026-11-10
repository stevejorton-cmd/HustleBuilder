// Refunds (14-day money back) and the scale rework: the daily job, the admin
// view and account deletion no longer read or lock the whole store.
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "crypto";
import { PGlite } from "@electric-sql/pglite";
import { fileStore, setStore } from "../host/lib/store.mjs";
import { postgresStore, SCHEMA, PREFIX_INDEX } from "../host/lib/postgres-store.mjs";
import { handleRequest, runRenewals, REFUND_DAYS, ADMIN_PAGE_SIZE } from "../host/lib/router.mjs";

let dir;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hb-rs-"));
  setStore(fileStore(dir));
  process.env.PUBLISH_TEST_MODE = "1";
  process.env.PAYWALL_MODE = "test";
  process.env.ADMIN_SECRET = "test-admin-secret";
  process.env.PUBLIC_ORIGIN = "http://sites.test";
});
test.afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
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
const page = (name) => `<!DOCTYPE html><html><head><title>${name}</title></head><body><!-- hb-public --><h1>${name}</h1><script>window.__C={"first":"${name}","biz":"${name} Yard Co","inbox":null};</script></body></html>`;
async function parent(email) {
  const start = await json(await call("POST", "/api/auth/start", { body: { email }, headers: { "x-forwarded-for": "10.0.0." + (1 + Math.floor(Math.random() * 250)) + "." + Math.random() } }));
  const verify = await json(await call("POST", "/api/auth/verify", { body: { email, code: start.body.devCode } }));
  await call("POST", "/api/consent", { token: verify.body.token, body: { consent: true } });
  const id = (await readFile(path.join(dir, "email", sha(email)), "utf8")).trim();
  return { email, token: verify.body.token, id };
}
const accountFile = (id) => path.join(dir, "accounts", id + ".json");
const readAccount = async (id) => JSON.parse(await readFile(accountFile(id), "utf8"));
async function patchAccount(id, fn) { const a = await readAccount(id); fn(a); await writeFile(accountFile(id), JSON.stringify(a)); }
const outbox = async (email) => (await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)))).body.messages;
async function adminCookie() {
  const login = await call("POST", "/admin/login", { raw: "secret=test-admin-secret", headers: { "x-forwarded-for": "198.51.100." + Math.floor(Math.random() * 250) } });
  return login.headers["set-cookie"].split(";")[0];
}
function signed(event) {
  const raw = JSON.stringify(event), t = String(Math.floor(Date.now() / 1000));
  return { raw, headers: { "stripe-signature": "t=" + t + ",v1=" + createHmac("sha256", "placeholder").update(t + "." + raw).digest("hex") } };
}
// A paid Stripe checkout for this account, delivered by webhook.
async function stripePay(p, plan, n) {
  const a = await readAccount(p.id);
  const sessionId = "cs_test_" + n, pi = "pi_test_" + n;
  a.checkoutSessionId = sessionId; a.checkoutPlan = plan;
  await writeFile(accountFile(p.id), JSON.stringify(a));
  const attempt = sha("checkout:" + p.id + ":" + (a.checkoutGeneration || 0));
  const session = { id: sessionId, payment_status: "paid", amount_total: plan === "year" ? 1999 : 999, currency: "usd", payment_intent: pi, metadata: { accountId: p.id, plan, attempt } };
  const res = await call("POST", "/api/stripe/webhook", signed({ id: "evt_pay_" + n, type: "checkout.session.completed", data: { object: session } }));
  assert.equal(res.status, 200);
  return { sessionId, pi, receiptId: "stripe-cs-test-" + n };
}

/* ---------------- refunds ---------------- */

test("the terms and the receipt promise the 14-day refund", async () => {
  assert.equal(REFUND_DAYS, 14);
  const terms = (await call("GET", "/api/site/terms")).body;
  assert.match(terms, /within 14 days of a payment and we will refund it in full/);
  assert.match(terms, /After 14 days, payments are not refunded except where the law requires it/);
  const p = await parent("promise@example.com");
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  const mail = (await outbox(p.email)).find((m) => /receipt/i.test(m.subject));
  assert.match(mail.text, /support@hustlebuilder\.org within 14 days for a full refund/);
});

test("an admin refund ends the plan it paid for and puts the account back as it was", async () => {
  const p = await parent("refund@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  await patchAccount(p.id, (a) => { a.trialEndsAt = new Date(Date.now() - 864e5).toISOString(); });
  await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  assert.match((await call("GET", "/api/site/sam-yard")).body, /<h1>Sam<\/h1>/);
  const receipt = (await readAccount(p.id)).receipts[0];
  assert.deepEqual(receipt.prev, { paidUntil: null, plan: null, planName: null });
  const cookie = await adminCookie();
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.match(dash.body, new RegExp('href="/admin/refund\\?id=' + p.id + '&amp;receipt=' + receipt.id + '"'));
  assert.match(dash.body, /day 0 of 14/);
  // No session: nothing happens.
  assert.equal((await call("POST", "/admin/refund", { raw: "id=" + p.id + "&receipt=" + receipt.id })).headers.location, "/admin");
  assert.ok((await readAccount(p.id)).paidUntil);
  const confirm = await call("GET", "/admin/refund?id=" + p.id + "&receipt=" + receipt.id, { headers: { cookie } });
  assert.match(confirm.body, /Refund \$19\.99\?/);
  assert.match(confirm.body, /Inside the 14-day money-back window/);
  assert.ok((await readAccount(p.id)).paidUntil, "viewing the confirm page changes nothing");
  const done = await call("POST", "/admin/refund", { raw: "id=" + p.id + "&receipt=" + receipt.id, headers: { cookie } });
  assert.equal(done.headers.location, "/admin?note=refund-done");
  const after = await readAccount(p.id);
  assert.equal(after.paidUntil, null);
  assert.equal(after.plan, null);
  assert.ok(after.receipts[0].refundedAt);
  assert.match((await call("GET", "/api/site/sam-yard")).body, /Taking a break/, "the page is back to its pre-payment state");
  assert.match((await call("GET", "/api/receipt/" + receipt.id)).body, /Refunded /);
  const acct = await json(await call("GET", "/api/account", { token: p.token }));
  assert.equal(acct.body.sites[0].receipts[0].refunded, true);
  assert.equal(acct.body.sites[0].renewable, true, "the family can buy again");
  const mail = (await outbox(p.email)).filter((m) => m.subject === "Your Hustle Builder refund");
  assert.equal(mail.length, 1);
  assert.match(mail[0].text, /We refunded \$19\.99/);
  const again = await call("POST", "/admin/refund", { raw: "id=" + p.id + "&receipt=" + receipt.id, headers: { cookie } });
  assert.equal(again.headers.location, "/admin?note=refund-none");
  assert.equal((await outbox(p.email)).filter((m) => m.subject === "Your Hustle Builder refund").length, 1);
  assert.match((await call("GET", "/admin?note=refund-done", { headers: { cookie } })).body, /Refunded\. The plan has ended/);
});

test("an admin form with a stripped origin still takes a page down", async () => {
  const p = await parent("form-origin@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  const cookie = await adminCookie();
  const headers = { cookie, origin: "null", "sec-fetch-site": "same-origin" };
  const down = await call("POST", "/admin/takedown", { raw: "slug=sam-yard", headers });
  assert.equal(down.status, 302);
  assert.equal(JSON.parse(await readFile(path.join(dir, "pages", "sam-yard.json"), "utf8")).status, "down");
  const cross = await call("POST", "/admin/restore", { raw: "slug=sam-yard", headers: { cookie, origin: "null", "sec-fetch-site": "cross-site" } });
  assert.equal(cross.status, 403);
  assert.equal(JSON.parse(await readFile(path.join(dir, "pages", "sam-yard.json"), "utf8")).status, "down");
});

test("a real payment is refunded through Stripe once, and Stripe's own notice afterwards changes nothing", async () => {
  const p = await parent("stripe-refund@example.com");
  await call("POST", "/api/publish", { token: p.token, body: { slug: "sam-yard", html: page("Sam") } });
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const pay = await stripePay(p, "year", 1);
  const paidAcct = await readAccount(p.id);
  assert.equal(paidAcct.receipts[0].paymentIntent, pay.pi);
  const trialEnds = paidAcct.trialEndsAt;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), key: opts.headers && opts.headers["Idempotency-Key"], body: String(opts.body || "") });
    return new Response(JSON.stringify({ id: "re_1", status: "succeeded" }), { status: 200 });
  };
  const cookie = await adminCookie();
  const done = await call("POST", "/admin/refund", { raw: "id=" + p.id + "&receipt=" + pay.receiptId, headers: { cookie } });
  assert.equal(done.headers.location, "/admin?note=refund-done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/refunds");
  assert.equal(calls[0].key, "hb-refund-" + pay.receiptId);
  assert.match(calls[0].body, /payment_intent=pi_test_1/);
  const after = await readAccount(p.id);
  assert.equal(after.paidUntil, null);
  assert.equal(after.trialEndsAt, trialEnds);
  assert.match((await call("GET", "/api/site/sam-yard")).body, /<h1>Sam<\/h1>/, "the free trial still had time, so the page stays up on it");
  const hook = await json(await call("POST", "/api/stripe/webhook", signed({ id: "evt_ref_1", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: pay.pi, amount: 1999, amount_refunded: 1999, refunded: true } } })));
  assert.equal(hook.body.refunded, false);
  assert.equal((await outbox(p.email)).filter((m) => m.subject === "Your Hustle Builder refund").length, 1);
});

test("if Stripe refuses the refund, nothing changes", async () => {
  const p = await parent("refused@example.com");
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const pay = await stripePay(p, "year", 2);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "card_declined" } }), { status: 402 });
  const cookie = await adminCookie();
  const res = await call("POST", "/admin/refund", { raw: "id=" + p.id + "&receipt=" + pay.receiptId, headers: { cookie } });
  assert.equal(res.headers.location, "/admin?note=refund-failed");
  const a = await readAccount(p.id);
  assert.ok(a.paidUntil);
  assert.equal(a.receipts[0].refundedAt, undefined);
});

test("a refund or dispute made in Stripe ends the plan; a partial refund does not", async () => {
  const p = await parent("webhook-refund@example.com");
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder";
  const first = await stripePay(p, "year", 3);
  const afterFirst = (await readAccount(p.id)).paidUntil;
  // Renew early: a second payment stacked on the first.
  await patchAccount(p.id, (a) => { a.paidUntil = new Date(Date.now() + 5 * 864e5).toISOString(); });
  const soon = (await readAccount(p.id)).paidUntil;
  const second = await stripePay(p, "year", 4);
  const stacked = (await readAccount(p.id)).paidUntil;
  assert.equal(Date.parse(stacked), Date.parse(soon) + 365 * 864e5);
  const partial = await json(await call("POST", "/api/stripe/webhook", signed({ id: "evt_part", type: "charge.refunded", data: { object: { payment_intent: second.pi, amount: 1999, amount_refunded: 500, refunded: false } } })));
  assert.equal(partial.body.partial, true);
  assert.equal((await readAccount(p.id)).paidUntil, stacked);
  // Refunding the EARLIER payment removes only the time it added.
  const older = await json(await call("POST", "/api/stripe/webhook", signed({ id: "evt_old", type: "charge.refunded", data: { object: { payment_intent: first.pi, amount: 1999, amount_refunded: 1999, refunded: true } } })));
  assert.equal(older.body.refunded, true);
  const firstAdded = (await readAccount(p.id)).receipts[0].addedMs;
  assert.equal(Date.parse((await readAccount(p.id)).paidUntil), Date.parse(stacked) - firstAdded);
  assert.ok(Date.parse(afterFirst) > Date.now());
  // A dispute on the latest payment restores the state from before it.
  const dispute = await json(await call("POST", "/api/stripe/webhook", signed({ id: "evt_disp", type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: second.pi } } })));
  assert.equal(dispute.body.refunded, true);
  assert.equal((await readAccount(p.id)).paidUntil, soon);
  assert.ok((await outbox(p.email)).some((m) => m.subject === "Your Hustle Builder plan has ended"));
  const unknown = await json(await call("POST", "/api/stripe/webhook", signed({ id: "evt_unk", type: "charge.refunded", data: { object: { payment_intent: "pi_nobody", amount: 1, amount_refunded: 1, refunded: true } } })));
  assert.equal(unknown.body.ignored, true);
});

test("a refund for a payment taken before receipts tracked Stripe ids is matched through Stripe", async () => {
  const p = await parent("legacy-pay@example.com");
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder"; process.env.STRIPE_SECRET_KEY = "placeholder";
  const pay = await stripePay(p, "year", 5);
  // Make it look like an old receipt: no payment id, no pointer, no before-state.
  await patchAccount(p.id, (a) => { delete a.receipts[0].paymentIntent; delete a.receipts[0].prev; delete a.receipts[0].addedMs; delete a.receipts[0].sessionId; });
  await rm(path.join(dir, "payintents"), { recursive: true, force: true });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /checkout\/sessions\?limit=1&payment_intent=pi_test_5/);
    return new Response(JSON.stringify({ data: [{ id: pay.sessionId, metadata: { accountId: p.id } }] }), { status: 200 });
  };
  const event = { id: "evt_legacy", type: "charge.refunded", data: { object: { payment_intent: pay.pi, amount: 1999, amount_refunded: 1999, refunded: true } } };
  const first = await call("POST", "/api/stripe/webhook", signed(event));
  assert.equal(first.status, 503, "Stripe is asked to deliver it again, now that the account is known");
  const second = await json(await call("POST", "/api/stripe/webhook", signed(event)));
  assert.equal(second.body.refunded, true);
  assert.equal((await readAccount(p.id)).paidUntil, null);
});

/* ---------------- scale ---------------- */

test("the daily job picks up where it ran out of time, and each family is handled once", async () => {
  const people = [];
  for (let i = 0; i < 4; i++) {
    const p = await parent("cron" + i + "@example.com");
    await call("POST", "/api/publish", { token: p.token, body: { slug: "kid-" + i + "-yard", html: page("Kid" + i) } });
    await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
    await patchAccount(p.id, (a) => { a.paidUntil = new Date(Date.now() + 2 * 864e5).toISOString(); });
    people.push(p);
  }
  // No time at all: nothing is processed, and the pass is left unfinished.
  const none = await runRenewals({ origin: "http://sites.test", dry: false, budgetMs: 0, resume: false });
  assert.deepEqual([none.done, none.processed, none.due.length], [false, 0, 0]);
  // The five-minute mail cron finishes it.
  const mail = await call("GET", "/api/cron/mail", { headers: { authorization: "Bearer test-admin-secret" } });
  assert.equal(mail.status, 200);
  for (const p of people) assert.equal((await outbox(p.email)).filter((m) => /plan ends in 2 days/.test(m.subject)).length, 1, p.email);
  assert.equal(JSON.parse(await readFile(path.join(dir, "cronstate", "renewals.json"), "utf8")).done, true);
  // Finished for today: the mail cron does not start it over.
  const idle = await runRenewals({ origin: "http://sites.test", dry: false, budgetMs: 5000, resume: true });
  assert.equal(idle.skipped, true);
  // A fresh daily run visits everyone again and sends nothing twice.
  const next = await json(await call("GET", "/api/cron/renewals", { headers: { authorization: "Bearer test-admin-secret" } }));
  assert.equal(next.body.done, true);
  assert.equal(next.body.processed >= 4, true);
  assert.equal(next.body.due.length, 0);
  assert.equal((await call("GET", "/api/cron/mail")).status, 401);
});

// A store wrapper that records what was read.
function spyStore() {
  const base = fileStore(dir), log = { lists: [], gets: [] };
  return { log, store: { ...base, async get(k) { log.gets.push(k); return base.get(k); }, async list(prefix = "") { log.lists.push(prefix); return base.list(prefix); } } };
}

test("deleting an account removes everything of theirs without reading anyone else's data", async () => {
  const gone = await parent("gone@example.com"), stay = await parent("stay@example.com");
  for (const [p, slug] of [[gone, "gone-yard"], [stay, "stay-yard"]]) {
    await call("POST", "/api/publish", { token: p.token, body: { slug, html: page(slug) } });
    await call("POST", "/api/draft", { token: p.token, body: { draft: { first: slug } } });
    await call("POST", "/api/ask", { body: { email: p.email, draft: { first: slug } }, headers: { "x-forwarded-for": "10.9.9." + slug.length + slug[0].charCodeAt(0) } });
    await call("POST", "/api/book", { body: { slug, name: "Pat Jones", contact: "pat@example.com", service: "Mow", when: "Wednesday", address: "12 Elm St", start: "2026-12-02T16:00", t: 3000 }, headers: { "x-forwarded-for": "10.8.8." + slug.length } });
    await call("POST", "/api/checkout", { token: p.token, body: { plan: "year" } });
  }
  const base = fileStore(dir);
  const before = await base.list("");
  const goneKeys = before.filter((k) => k.includes(gone.id) || k.includes(sha(gone.email)) || k.includes("gone-yard"));
  assert.ok(goneKeys.length >= 8);
  assert.equal((await base.list("drafts/")).length, 2);
  assert.equal((await base.list("asks/")).length, 2);
  // Pretend the owner index has been in place for longer than any draft lives.
  await base.put("meta/owner-index.json", JSON.stringify({ since: Date.now() - 100 * 864e5 }));
  const spy = spyStore();
  setStore(spy.store);
  const res = await json(await call("DELETE", "/api/account", { token: gone.token }));
  assert.equal(res.body.ok, true);
  setStore(base);
  assert.equal(spy.log.lists.includes(""), false, "never lists the whole store");
  assert.equal(spy.log.lists.some((p) => p === "drafts/" || p === "asks/" || p === "pages/" || p === "accounts/"), false, "never walks everyone's drafts, asks, pages or accounts");
  assert.equal(spy.log.gets.some((k) => k.includes("stay-yard") || k.includes(stay.id)), false, "never reads the other family's records");
  const after = await base.list("");
  const left = after.filter((k) => k.includes(gone.id) || k.includes("gone-yard") || (k.includes(sha(gone.email)) && !k.startsWith("trials/") && !k.startsWith("counters/")));
  assert.deepEqual(left.filter((k) => !k.startsWith("sentmail/receipt-")), []);
  assert.equal((await base.list("drafts/")).length, 1);
  assert.equal((await base.list("asks/")).length, 1);
  assert.equal((await base.list("receipts/")).length, 1);
  assert.match((await call("GET", "/api/site/stay-yard")).body, /stay-yard/);
  assert.equal((await json(await call("GET", "/api/me", { token: stay.token }))).body.paid, true);
  assert.equal((await call("GET", "/api/site/gone-yard")).status, 404);
});

test("records saved before the owner index existed are still found on delete", async () => {
  const p = await parent("oldstyle@example.com");
  const base = fileStore(dir);
  await base.put("drafts/oldcode1.json", JSON.stringify({ accountId: p.id, draft: {}, updatedAt: new Date().toISOString() }));
  await base.put("asks/" + "c".repeat(48) + ".json", JSON.stringify({ email: p.email, draft: {}, expires: new Date(Date.now() + 864e5).toISOString() }));
  await base.put("drafts/someone1.json", JSON.stringify({ accountId: "ffffffffffffffff", draft: {}, updatedAt: new Date().toISOString() }));
  await call("DELETE", "/api/account", { token: p.token });
  assert.deepEqual(await base.list("drafts/"), ["drafts/someone1.json"]);
  assert.deepEqual(await base.list("asks/"), []);
});

test("the admin view pages through families, searches, and does not open page HTML", async () => {
  const real = await parent("real@example.com");
  await call("POST", "/api/publish", { token: real.token, body: { slug: "real-yard", html: page("Real") } });
  await mkdir(path.join(dir, "accounts"), { recursive: true });
  await mkdir(path.join(dir, "pages"), { recursive: true });
  for (let i = 0; i < 120; i++) {
    const id = sha("bulk" + i).slice(0, 16), slug = "bulk-" + i + "-yard";
    await writeFile(accountFile(id), JSON.stringify({ id, email: "bulk" + i + "@example.com", emailVerifiedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", slug, slugs: [slug], trialEndsAt: new Date(Date.now() + 5 * 864e5).toISOString() }));
    await writeFile(path.join(dir, "pages", slug + ".json"), JSON.stringify({ slug, accountId: id, status: "live", updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), names: { first: "Kid" + i, biz: "Bulk " + i + " Lawns" }, legacyInbox: false }));
    await writeFile(path.join(dir, "pages", slug + ".html"), page("x"));
  }
  const cookie = await adminCookie();
  const spy = spyStore();
  setStore(spy.store);
  const dash = await call("GET", "/admin", { headers: { cookie } });
  setStore(fileStore(dir));
  assert.equal(dash.status, 200);
  assert.match(dash.body, />121<\/div><div>Accounts</);
  assert.match(dash.body, />121<\/div><div>Sites live</);
  assert.match(dash.body, /121 rows · page 1 of 3/);
  assert.equal((dash.body.match(/<tr>\n<td/g) || []).length, ADMIN_PAGE_SIZE);
  assert.match(dash.body, /real-yard/, "newest first");
  assert.equal(spy.log.gets.some((k) => k.endsWith(".html")), false, "no page HTML is read");
  assert.equal(spy.log.gets.filter((k) => k.startsWith("requests/")).length <= ADMIN_PAGE_SIZE, true, "booking details only for the rows shown");
  const last = await call("GET", "/admin?page=3", { headers: { cookie } });
  assert.equal((last.body.match(/<tr>\n<td/g) || []).length, 21);
  assert.match(last.body, /page 3 of 3/);
  const found = await call("GET", "/admin?q=bulk+77+lawns", { headers: { cookie } });
  assert.match(found.body, /1 of 121 rows/);
  assert.match(found.body, /\/bulk-77-yard/);
  assert.equal(found.body.includes("/bulk-78-yard"), false);
  const byEmail = await call("GET", "/admin?q=bulk5%40example.com", { headers: { cookie } });
  assert.match(byEmail.body, /1 of 121 rows/);
  const nothing = await call("GET", "/admin?q=zzzz", { headers: { cookie } });
  assert.match(nothing.body, /Nothing matches that search/);
});

test("PostgreSQL: expired housekeeping is one statement, bulk reads skip page HTML, prefix index exists", async () => {
  const db = new PGlite();
  const log = [];
  const pool = { query: (sql, args) => { log.push(sql); return db.query(sql, args); }, on() {} };
  try {
    await db.exec(SCHEMA);
    const s = postgresStore("unused", pool);
    const old = async (key, value, age) => db.query("INSERT INTO hb_kv(key,value,updated_at) VALUES($1,$2,now() - $3::interval)", [key, value, age]);
    await old("drafts/old.json", "{}", "91 days"); await old("drafts/new.json", "{}", "89 days");
    await old("draftby/a/old", "1", "91 days");
    await old("asks/old.json", "{}", "8 days"); await old("asks/new.json", "{}", "6 days");
    await old("cancels/old.json", "{}", "31 days"); await old("bookingids/a/old", "{}", "31 days"); await old("bookingids/a/new", "{}", "2 days");
    await old("adminsessions/old.json", "{}", "13 hours"); await old("adminsessions/new.json", "{}", "1 hour");
    await old("counters/2020-01-01/book-x", "3", "1 hour"); await old("counters/2999-01-01/book-y", "3", "1 hour");
    await old("iplimit/legacy", "3", "1 hour");
    await old("accounts/a.json", '{"id":"a"}', "400 days"); await old("pages/a.html", "<html>big</html>", "400 days"); await old("pages/a.json", '{"slug":"a"}', "400 days");
    await old("requests/a.json", '[{"id":1},{"id":2}]', "1 day"); await old("requests/b.json", "not json", "1 day");
    log.length = 0;
    const removed = await s.sweep({ keepFrom: "2026-11-09" });
    assert.equal(removed, 8);
    assert.equal(log.filter((sql) => /DELETE/.test(sql)).length, 1);
    assert.deepEqual(await s.list(""), ["accounts/a.json", "adminsessions/new.json", "asks/new.json", "bookingids/a/new", "counters/2999-01-01/book-y", "drafts/new.json", "pages/a.html", "pages/a.json", "requests/a.json", "requests/b.json"]);
    assert.deepEqual(await s.entries("pages/", ".json"), [["pages/a.json", '{"slug":"a"}']]);
    assert.equal(await s.sumArrayLengths("requests/"), 2);
    assert.ok(log.includes(PREFIX_INDEX), "the store creates its prefix index on first use");
    const idx = await db.query("SELECT indexname FROM pg_indexes WHERE tablename='hb_kv'");
    assert.ok(idx.rows.some((r) => r.indexname === "hb_kv_key_prefix"));
  } finally { await db.close(); }
});
