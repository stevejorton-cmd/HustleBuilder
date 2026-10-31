import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { fileStore, setStore } from "../host/lib/store.mjs";
import { chicagoWall, jobsToIcs } from "../host/lib/calendar.mjs";
import { handleRequest, seasonOffer, stripeSignatureOk, trialLengthDays, TRIAL_DAYS } from "../host/lib/router.mjs";
import { checkSlug, wordHits } from "../host/lib/moderate.mjs";
import { cardPng } from "../host/lib/card.mjs";

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hb-"));
  setStore(fileStore(dir));
  process.env.PUBLISH_TEST_MODE = "1";
  process.env.PAYWALL_MODE = "test";
  process.env.ADMIN_SECRET = "test-admin-secret";
  process.env.PUBLIC_ORIGIN = "http://sites.test";
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function call(method, path, { body, token, headers, raw } = {}) {
  return handleRequest({
    method,
    path,
    headers: { origin: "http://127.0.0.1:8787", authorization: token ? "Bearer " + token : "", ...(headers || {}) },
    body: raw != null ? raw : (body ? JSON.stringify(body) : ""),
    origin: "http://sites.test",
    query: new URL("http://sites.test" + path).searchParams
  });
}
async function json(res) { return { status: res.status, body: JSON.parse(res.body || "{}") }; }

function page(name) {
  return `<!DOCTYPE html><html><head><title>${name}</title></head><body><!-- hb-public --><h1>${name}</h1><p>Student-owned. Parent-backed.</p></body></html>`;
}

async function parent(email = "parent@example.com") {
  const start = await json(await call("POST", "/api/auth/start", { body: { email } }));
  assert.equal(start.body.ok, true);
  const verify = await json(await call("POST", "/api/auth/verify", { body: { email, code: start.body.devCode } }));
  assert.equal(verify.body.ok, true);
  return { email, token: verify.body.token, code: start.body.devCode };
}

test("slug rules block last names, reserved words, and bad shapes", () => {
  assert.equal(checkSlug("sam"), "");
  assert.equal(checkSlug("sam-yard"), "");
  assert.equal(checkSlug("taylor"), "");
  assert.equal(checkSlug("carter"), "");
  assert.equal(checkSlug("scott"), "");
  assert.equal(checkSlug("allen"), "");
  assert.equal(checkSlug("lee"), "");
  assert.equal(checkSlug("jackson"), "");
  assert.equal(checkSlug("maya-dogs"), "");
  assert.equal(checkSlug("ellie-pet-care"), "");
  assert.equal(checkSlug("green-lawn"), "");
  assert.match(checkSlug("sam-smith"), /last name/i);
  assert.match(checkSlug("admin"), /reserved/i);
  assert.match(checkSlug("ab"), /3 to 24/);
  assert.match(checkSlug("Sam Yard"), /letters/i);
});

test("consent gate blocks publish until the parent verifies and agrees", async () => {
  const early = await json(await call("POST", "/api/publish", { body: { slug: "sam", html: page("Sam") } }));
  assert.equal(early.status, 401);

  const { token } = await parent();
  const noConsent = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.body.error, "consent");

  const consent = await json(await call("POST", "/api/consent", { token, body: { consent: true } }));
  assert.equal(consent.body.ok, true);
  const noPay = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
  assert.equal(noPay.status, 200);
  assert.equal(noPay.body.ok, true);
  const meFree = await json(await call("GET", "/api/me", { token }));
  assert.equal(meFree.body.paid, false);
  assert.equal(meFree.body.trialLeft, 3);

  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(pay.body.mode, "test");
  assert.equal(pay.body.plan, "season");
});

test("publish and republish keep the same url", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const first = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam Yard") } }));
  assert.equal(first.status, 200);
  assert.equal(first.body.url, "http://sites.test/sam-yard");
  const live = await call("GET", "/api/site/sam-yard");
  assert.equal(live.status, 200);
  assert.match(live.body, /Sam Yard/);

  const again = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam Yard Updated") } }));
  assert.equal(again.body.url, "http://sites.test/sam-yard");
  assert.equal(again.body.updated, true);
  const live2 = await call("GET", "/api/site/sam-yard");
  assert.match(live2.body, /Sam Yard Updated/);

  const locked = await json(await call("POST", "/api/publish", { token, body: { slug: "other-yard", html: page("Other") } }));
  assert.equal(locked.status, 409);

  const other = await parent("other@example.com");
  await call("POST", "/api/consent", { token: other.token, body: { consent: true } });
  await call("POST", "/api/checkout", { token: other.token, body: { plan: "year" } });
  const taken = await json(await call("POST", "/api/publish", { token: other.token, body: { slug: "sam-yard", html: page("Nope") } }));
  assert.equal(taken.status, 409);
  assert.equal(email, "parent@example.com");
});

test("moderation rejects a blocked word and a boss-mode dump", async () => {
  const { token } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const bad = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("shit lawn") } }));
  assert.equal(bad.body.error, "moderation");
  assert.match(bad.body.message, /shit/);
  const last = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-smith", html: page("Sam") } }));
  assert.equal(last.body.error, "slug");
  const yard = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Weed eating, weed whacking, and kill the dandelions") } }));
  assert.equal(yard.body.ok, true);
  const dump = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") + "hustle-boss-v1" } }));
  assert.equal(dump.body.error, "page");
});

test("booking emails the parent, stores a calendar job, and is not on the public page", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Riley", contact: "402-555-0199", service: "Mow", when: "Monday at 4:00 PM",
    address: "999 Secret Lane", note: "Gate, side; door", start: "2026-11-16T16:00", t: 5000
  } }));
  assert.equal(book.body.ok, true);
  const live = await call("GET", "/api/site/sam");
  assert.equal(live.body.includes("999 Secret Lane"), false);
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const msg = box.body.messages.at(-1);
  assert.match(msg.text, /999 Secret Lane/);
  assert.match(msg.text, /Replies to this email aren't read/);
  assert.match(msg.html, /tel:\+14025550199/);
  assert.match(msg.html, /sms:\+14025550199/);
  assert.equal(msg.replyTo, "");
  assert.match(msg.text, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(msg.text, /about 30 days/);
  assert.match(msg.ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(msg.ics, /DTSTART;TZID=America\/Chicago:20261116T160000/);
  assert.match(msg.ics, /Gate\\, side\\; door/);
  const me = await json(await call("GET", "/api/me", { token }));
  assert.match(me.body.calUrl, /^http:\/\/sites\.test\/api\/cal\/[a-f0-9]{32,}\.ics$/);
  assert.equal(me.body.calGoogle, "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(me.body.calWebcal));
  const feed = await call("GET", new URL(me.body.calUrl).pathname);
  assert.equal(feed.status, 200);
  assert.match(feed.headers["content-type"], /text\/calendar/);
  assert.equal(feed.body.replace(/\r\n/g, "").includes("\n"), false);
  assert.match(feed.body, /SUMMARY:Mow - Riley/);
  assert.match(feed.body, /999 Secret Lane/);
  assert.match(feed.body, /UID:b[a-f0-9]+@hustlebuilder\.org/);
  const privacy = await call("GET", "/api/site/privacy");
  assert.match(privacy.body, /family calendar/);
  assert.match(privacy.body, /30 days/);
});

test("admin takedown hides the page and the parent cannot put it back", async () => {
  const { token } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const nope = await json(await call("POST", "/api/admin/takedown", { body: { slug: "sam" }, headers: { "x-admin-secret": "wrong" } }));
  assert.equal(nope.status, 401);
  const down = await json(await call("POST", "/api/admin/takedown", { body: { slug: "sam" }, headers: { "x-admin-secret": "test-admin-secret" } }));
  assert.equal(down.body.ok, true);
  const live = await call("GET", "/api/site/sam");
  assert.equal(live.status, 404);
  assert.match(live.body, /taken down/);
  const back = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam again") } }));
  assert.equal(back.status, 403);
  assert.equal(back.body.error, "down");
});

test("parent can unpublish and delete the account", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "year" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam-mow", html: page("Sam") } });
  const off = await json(await call("POST", "/api/unpublish", { token, body: {} }));
  assert.equal(off.body.ok, true);
  assert.equal((await call("GET", "/api/site/sam-mow")).status, 404);
  const back = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-mow", html: page("Sam returns") } }));
  assert.equal(back.body.ok, true);
  const gone = await json(await call("DELETE", "/api/account", { token }));
  assert.equal(gone.body.ok, true);
  assert.equal((await call("GET", "/api/site/sam-mow")).status, 404);
  assert.equal((await json(await call("GET", "/api/me", { token }))).status, 401);
  const start = await json(await call("POST", "/api/auth/start", { body: { email } }));
  assert.equal(start.body.ok, true);
});

test("stripe webhook marks the account paid only with a valid signature", async () => {
  const { token } = await parent("pay@example.com");
  const me = await json(await call("GET", "/api/me", { token }));
  assert.equal(me.body.paid, false);
  const accountId = (await (async () => {
    const { readFile } = await import("fs/promises");
    const files = await import("fs/promises");
    const names = await files.readdir(dir + "/accounts");
    const raw = await readFile(dir + "/accounts/" + names[0], "utf8");
    return JSON.parse(raw).id;
  })());
  const payload = JSON.stringify({ type: "checkout.session.completed", data: { object: { metadata: { accountId, plan: "season" } } } });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const bad = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers: { "stripe-signature": "t=1,v1=deadbeef" } }));
  assert.equal(bad.status, 400);
  const t = "1700000000";
  const sig = createHmac("sha256", "whsec_test").update(t + "." + payload).digest("hex");
  assert.equal(stripeSignatureOk(payload, "t=" + t + ",v1=" + sig, "whsec_test"), true);
  const ok = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers: { "stripe-signature": "t=" + t + ",v1=" + sig } }));
  assert.equal(ok.body.ok, true);
  const after = await json(await call("GET", "/api/me", { token }));
  assert.equal(after.body.paid, true);
  assert.equal(after.body.plan, "season");
});

test("calendar feed escapes text, keeps a stable uid, and drops a reset token", async () => {
  const ics = jobsToIcs([{
    id: "jobabc1",
    service: "Mow",
    customer: "Sam, Jr",
    address: "12\\ Main",
    start: "2026-11-02T16:00",
    note: "line1\nline2; ok"
  }], Date.parse("2026-10-31T12:00:00Z"));
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /UID:jobabc1@hustlebuilder\.org/);
  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20261102T160000/);
  assert.match(ics, /DTEND;TZID=America\/Chicago:20261102T170000/);
  assert.match(ics, /SUMMARY:Mow - Sam\\, Jr/);
  assert.match(ics, /LOCATION:12\\\\ Main/);
  assert.match(ics, /DESCRIPTION:line1\\nline2\\; ok/);
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false);

  const { token } = await parent("cal@example.com");
  const soon = chicagoWall(Date.now() + 5 * 864e5);
  const recent = chicagoWall(Date.now() - 10 * 864e5);
  const old = chicagoWall(Date.now() - 40 * 864e5);
  const denied = await json(await call("POST", "/api/jobs", { body: { id: "device1", service: "Rake", customer: "Pat", address: "1 Oak St", start: soon, note: "dog" } }));
  assert.equal(denied.status, 401);
  const added = await json(await call("POST", "/api/jobs", { token, body: { id: "device1", service: "Rake", customer: "Pat", address: "1 Oak St", start: soon, note: "dog", amount: "25" } }));
  assert.equal(added.body.ok, true);
  await call("POST", "/api/jobs", { token, body: { id: "device2", service: "Old", customer: "Old", address: "9 Old", start: old, note: "" } });
  await call("POST", "/api/jobs", { token, body: { id: "device3", service: "Recent", customer: "Recent", address: "3 Recent", start: recent, note: "" } });
  const me = await json(await call("GET", "/api/me", { token }));
  const first = await call("GET", new URL(me.body.calUrl).pathname);
  assert.match(first.body, /UID:device1@hustlebuilder\.org/);
  assert.match(first.body, /UID:device3@hustlebuilder\.org/);
  assert.equal(first.body.includes("UID:device2@"), false);
  assert.match(first.body, /Price: 25/);
  const resetDenied = await json(await call("POST", "/api/cal/reset", { body: {} }));
  assert.equal(resetDenied.status, 401);
  const reset = await json(await call("POST", "/api/cal/reset", { token, body: {} }));
  assert.equal(reset.body.ok, true);
  assert.notEqual(reset.body.calUrl, me.body.calUrl);
  assert.equal((await call("GET", new URL(me.body.calUrl).pathname)).status, 404);
  const again = await call("GET", new URL(reset.body.calUrl).pathname);
  assert.equal(again.status, 200);
  assert.match(again.body, /UID:device1@hustlebuilder\.org/);
  const delDenied = await json(await call("DELETE", "/api/jobs", { body: { id: "device1" } }));
  assert.equal(delDenied.status, 401);
  const del = await json(await call("DELETE", "/api/jobs", { token, body: { id: "device1" } }));
  assert.equal(del.body.ok, true);
  const after = await call("GET", new URL(reset.body.calUrl).pathname);
  assert.equal(after.body.includes("UID:device1@"), false);
  assert.match(after.body, /UID:device3@hustlebuilder\.org/);
});

test("deleting the account removes calendar jobs and takedown does not", async () => {
  const { token } = await parent("gone@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Quinn", contact: "402-555-0101", service: "Shovel", when: "Tuesday at 8:00 AM",
    address: "50 Feed St", note: "porch", start: "2026-12-01T08:00", t: 5000
  } }));
  assert.equal(book.body.ok, true);
  const me = await json(await call("GET", "/api/me", { token }));
  const down = await json(await call("POST", "/api/admin/takedown", { body: { slug: "sam" }, headers: { "x-admin-secret": "test-admin-secret" } }));
  assert.equal(down.body.ok, true);
  const still = await call("GET", new URL(me.body.calUrl).pathname);
  assert.equal(still.status, 200);
  assert.match(still.body, /50 Feed St/);
  const gone = await json(await call("DELETE", "/api/account", { token }));
  assert.equal(gone.body.ok, true);
  assert.equal((await call("GET", new URL(me.body.calUrl).pathname)).status, 404);
});

test("stripe checkout sets the statement descriptor suffix", async () => {
  const { token } = await parent("card@example.com");
  process.env.PAYWALL_MODE = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const prev = global.fetch;
  let seen = "";
  global.fetch = async (_url, opt) => {
    seen = String(opt && opt.body);
    return { ok: true, json: async () => ({ url: "https://checkout.stripe.test/c" }) };
  };
  try {
    const res = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.url, "https://checkout.stripe.test/c");
    const params = new URLSearchParams(seen);
    assert.equal(params.get("payment_intent_data[statement_descriptor_suffix]"), "HUSTLE BLDR");
    assert.equal(params.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(params.get("line_items[0][price_data][unit_amount]"), "1999");
    assert.equal(params.get("line_items[0][price]"), null);
    const yearParent = await parent("card-year@example.com");
    const year = await json(await call("POST", "/api/checkout", { token: yearParent.token, body: { plan: "year" } }));
    assert.equal(year.body.ok, true);
    const yearParams = new URLSearchParams(seen);
    assert.equal(yearParams.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(yearParams.get("line_items[0][price_data][unit_amount]"), "2999");
    assert.equal(yearParams.get("line_items[0][price]"), null);
  } finally {
    global.fetch = prev;
    process.env.PAYWALL_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("reply_to uses the customer email, and a name like Dick with yard phrases is delivered", async () => {
  const { token, email } = await parent("reply@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Dick", contact: "neighbor@example.com", service: "Weed eating",
    when: "Monday at 4:00 PM", address: "12 Oak", note: "kill the dandelions", start: "2026-11-20T16:00", t: 4000
  } }));
  assert.equal(book.body.ok, true);
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const msg = box.body.messages.at(-1);
  assert.equal(msg.replyTo, "neighbor@example.com");
  assert.equal(/aren't read/.test(msg.text), false);
  assert.match(msg.html, /mailto:neighbor@example.com/);
  const flagged = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Pat", contact: "402-555-0144", service: "Mow", when: "Tuesday at 9:00 AM",
    address: "4 Pine", note: "please kill it", start: "2026-11-21T09:00", t: 4000
  }, headers: { "x-forwarded-for": "203.0.113.9" } }));
  assert.equal(flagged.body.ok, true);
  const box2 = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.match(box2.body.messages.at(-1).text, /Check this one/);
  assert.match(box2.body.messages.at(-1).text, /kill/);
});

test("honeypot and a too-fast form do not use the booking cap, and one IP is limited", async () => {
  const { token, email } = await parent("spam@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const honey = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Bot", contact: "402-555-0100", service: "Mow", when: "Monday",
    address: "1 Bot", hp: "http://spam.test", t: 100
  }, headers: { "x-forwarded-for": "198.51.100.8" } }));
  assert.equal(honey.body.ok, true);
  const fast = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Bot", contact: "402-555-0100", service: "Mow", when: "Monday",
    address: "1 Bot", t: 200
  }, headers: { "x-forwarded-for": "198.51.100.8" } }));
  assert.equal(fast.status, 400);
  assert.equal(fast.body.error, "fast");
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(box.body.messages.filter((m) => /1 Bot/.test(m.text)).length, 0);
  for (let i = 0; i < 12; i++) {
    const ok = await json(await call("POST", "/api/book", { body: {
      slug: "sam", name: "N" + i, contact: "402-555-0199", service: "Mow", when: "Monday at 4:00 PM",
      address: "9 Lane", note: "", start: "2026-12-02T16:00", t: 3000
    }, headers: { "x-forwarded-for": "198.51.100.20" } }));
    assert.equal(ok.body.ok, true, "book " + i);
  }
  const limited = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "More", contact: "402-555-0199", service: "Mow", when: "Monday at 4:00 PM",
    address: "9 Lane", start: "2026-12-02T16:00", t: 3000
  }, headers: { "x-forwarded-for": "198.51.100.20" } }));
  assert.equal(limited.status, 429);
  const other = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Other", contact: "402-555-0177", service: "Mow", when: "Monday at 5:00 PM",
    address: "8 Lane", start: "2026-12-02T17:00", t: 3000
  }, headers: { "x-forwarded-for": "198.51.100.21" } }));
  assert.equal(other.body.ok, true);
});

test("a paid account cannot open another checkout", async () => {
  const { token } = await parent("paid2@example.com");
  const first = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(first.body.ok, true);
  const second = await json(await call("POST", "/api/checkout", { token, body: { plan: "year" } }));
  assert.equal(second.body.alreadyPaid, true);
  assert.equal(second.body.plan, "season");
  assert.equal(second.body.paidUntil, first.body.paidUntil);
});

test("a pending stripe checkout is not opened twice", async () => {
  const { token } = await parent("pend@example.com");
  process.env.PAYWALL_MODE = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const prev = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ url: "https://checkout.stripe.test/once" }) };
  };
  try {
    const first = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(first.body.url, "https://checkout.stripe.test/once");
    const second = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(second.body.pending, true);
    assert.equal(calls, 1);
  } finally {
    global.fetch = prev;
    process.env.PAYWALL_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("published pages have preview tags, hide the phone unless asked, and offer a free slug", async () => {
  const { token } = await parent("og@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const html = page("Sam") + '<a href="tel:4025550100">Call</a> 402-555-0100';
  const pub = await json(await call("POST", "/api/publish", { token, body: {
    slug: "sam", html, showPhone: false, phone: "402-555-0100", cardTitle: "Sam's Lawn Co.", cardLine: "Lawn care in Elkhorn. Book a day.", accent: "#FF5B14"
  } }));
  assert.equal(pub.body.ok, true);
  const live = await call("GET", "/api/site/sam");
  assert.match(live.body, /property="og:title"/);
  assert.match(live.body, /property="og:image"/);
  assert.match(live.body, /name="twitter:card"/);
  assert.match(live.body, /noindex/);
  assert.equal(live.body.includes("4025550100"), false);
  assert.equal(live.body.includes("tel:"), false);
  const card = await call("GET", "/api/card/sam.png");
  assert.equal(card.status, 200);
  assert.match(card.headers["content-type"], /image\/png/);
  const bytes = Buffer.isBuffer(card.body) ? card.body : Buffer.from(card.body);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const free = await json(await call("GET", "/api/slug?name=taylor"));
  assert.equal(free.body.available, true);
  const taken = await json(await call("GET", "/api/slug?name=sam"));
  assert.equal(taken.body.available, false);
  const shown = await json(await call("POST", "/api/publish", { token, body: {
    slug: "sam", html, showPhone: true, phone: "402-555-0100", indexable: true, cardTitle: "Sam's Lawn Co.", cardLine: "Book a day."
  } }));
  assert.equal(shown.body.ok, true);
  const live2 = await call("GET", "/api/site/sam");
  assert.match(live2.body, /index,follow/);
  assert.match(live2.body, /tel:4025550100/);
});

test("the builder hides the phone unless the parent turns it on", async () => {
  const { readFile } = await import("fs/promises");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /showPhone:false/);
  assert.match(src, /const publicPhone=!!\(c\.showPhone&&c\.phoneDigits\)/);
  assert.equal(src.includes("app.netlify.com"), false);
  assert.equal(src.includes("Manage deployments"), false);
});

test("new work types stay allowed by the slug and word checks", () => {
  for (const slug of ["pet-care", "dog-walk", "car-wash", "reading-buddy", "odd-jobs", "my-helper"]) {
    assert.equal(checkSlug(slug), "", slug);
  }
  const hits = wordHits("dog walking pet sitting car wash reading buddy parent helper odd jobs");
  assert.equal(hits.block, "");
});

test("ask my parent emails a link, opens a session, and shows waiting until live", async () => {
  const draft = { type: "pet", first: "Sam", town: "Elkhorn", bizName: "Sam’s Pet Care", services: [{ n: "Dog walk", p: "8" }] };
  const sent = await json(await call("POST", "/api/ask", { body: { email: "mom@example.com", draft } }));
  assert.equal(sent.body.ok, true);
  assert.match(sent.body.link, /\/\?ask=/);
  const mail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent("mom@example.com")));
  assert.match(mail.body.messages[0].text, /Open this link/);
  assert.match(mail.body.messages[0].text, /ask=/);
  const waiting = await json(await call("GET", "/api/ask/" + sent.body.token));
  assert.equal(waiting.body.status, "waiting");
  assert.equal(waiting.body.draft, undefined);
  const opened = await json(await call("POST", "/api/ask/" + sent.body.token + "/open", { body: {} }));
  assert.equal(opened.body.ok, true);
  assert.equal(opened.body.email, "mom@example.com");
  assert.equal(opened.body.draft.first, "Sam");
  const me = await json(await call("GET", "/api/me", { token: opened.body.token }));
  assert.equal(me.body.email, "mom@example.com");
  const done = await json(await call("POST", "/api/ask/" + sent.body.token + "/done", { body: { url: "https://sites.test/sam-pets" } }));
  assert.equal(done.body.status, "live");
  const live = await json(await call("GET", "/api/ask/" + sent.body.token));
  assert.equal(live.body.status, "live");
  assert.equal(live.body.url, "https://sites.test/sam-pets");
  for (let i = 0; i < 5; i++) await call("POST", "/api/ask", { body: { email: "mom@example.com", draft } });
  const limited = await json(await call("POST", "/api/ask", { body: { email: "mom@example.com", draft } }));
  assert.equal(limited.status, 429);
});

test("a draft saves under a private code and attaches to a parent", async () => {
  const saved = await json(await call("POST", "/api/draft", { body: { draft: { type: "wash", first: "Riley", services: [{ n: "Wash the outside", p: "10" }] } } }));
  assert.equal(saved.body.ok, true);
  assert.match(saved.body.code, /^[a-z0-9]{8}$/);
  assert.match(saved.body.link, /draft=/);
  const loaded = await json(await call("GET", "/api/draft/" + saved.body.code));
  assert.equal(loaded.body.draft.first, "Riley");
  const again = await json(await call("POST", "/api/draft", { body: { code: saved.body.code, draft: { type: "wash", first: "Riley", town: "Millard" } } }));
  assert.equal(again.body.code, saved.body.code);
  const missing = await json(await call("GET", "/api/draft/zzzzzzzz"));
  assert.equal(missing.status, 404);
  const { token } = await parent("draft@example.com");
  const owned = await json(await call("POST", "/api/draft", { token, body: { code: saved.body.code, draft: { type: "tutor", first: "Riley" } } }));
  assert.equal(owned.body.code, saved.body.code);
  const me = await json(await call("GET", "/api/me", { token }));
  assert.equal(me.body.draftCode, saved.body.code);
});

test("a neighbor with an email gets a request note and a cancel link that tells the parent", async () => {
  process.env.REPLY_TO = "support@example.com";
  const { token, email } = await parent("bookparent@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "riley-pets", html: page("Riley") } }));
  assert.equal(pub.body.ok, true);
  const booked = await json(await call("POST", "/api/book", { body: {
    slug: "riley-pets", name: "Neighbor", contact: "neighbor@example.com", service: "Dog walk",
    when: "Saturday at 10:00 AM", address: "4 Pine", start: "2026-11-07T10:00", t: 3000
  } }));
  assert.equal(booked.body.ok, true);
  const note = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent("neighbor@example.com")));
  const msg = note.body.messages[0];
  assert.match(msg.text, /We got your request for Dog walk/);
  assert.match(msg.text, /Nothing is booked yet/);
  assert.match(msg.text, /\/api\/cancel\//);
  assert.equal(msg.text.includes(email), false);
  assert.equal(msg.text.includes("402"), false);
  assert.equal(msg.replyTo, "support@example.com");
  const cancelPath = msg.text.match(/\/api\/cancel\/[a-f0-9]+/)[0];
  const peek = await call("GET", cancelPath);
  assert.equal(peek.status, 200);
  assert.match(peek.body, /Cancel this request/);
  const still = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(still.body.messages.some((m) => /cancelled/i.test(m.subject)), false);
  const cancelled = await call("POST", cancelPath, { raw: "" });
  assert.match(cancelled.body, /Cancelled/);
  const parentMail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.match(parentMail.body.messages.map((m) => m.subject).join(" "), /cancelled/i);
  const phoneOnly = await json(await call("POST", "/api/book", { body: {
    slug: "riley-pets", name: "Pat", contact: "402-555-0199", service: "Dog walk",
    when: "Sunday at 9:00 AM", address: "9 Oak", start: "2026-11-08T09:00", t: 3000
  }, headers: { "x-forwarded-for": "198.51.100.77" } }));
  assert.equal(phoneOnly.body.ok, true);
  const notes = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent("neighbor@example.com")));
  assert.equal(notes.body.messages.length, 1);
  delete process.env.REPLY_TO;
});

async function patchAccount(change) {
  const names = await readdir(path.join(dir, "accounts"));
  const file = path.join(dir, "accounts", names[0]);
  const account = JSON.parse(await readFile(file, "utf8"));
  change(account);
  await writeFile(file, JSON.stringify(account));
  return account;
}

function bookAt(n) {
  return {
    slug: "sam",
    name: "Riley " + n,
    contact: "riley" + n + "@example.com",
    service: "Mow " + n,
    when: "Monday at 4:0" + n + " PM",
    address: n + " Oak Street",
    start: "2026-11-02T16:0" + n,
    t: 4000
  };
}

test("plans offer a named season or a year, and not a month", async () => {
  const plans = await json(await call("GET", "/api/plans"));
  assert.deepEqual(plans.body.plans.map((p) => p.id), ["season", "year"]);
  assert.deepEqual(plans.body.plans.map((p) => p.price), ["$19.99", "$29.99"]);
  assert.deepEqual(plans.body.plans.map((p) => p.amount), [1999, 2999]);
  assert.equal(JSON.stringify(plans.body).includes("$6"), false);
  assert.match(plans.body.free, /first 3 jobs/);
  const summer = seasonOffer(new Date("2026-06-15T12:00:00Z"));
  assert.equal(summer.name, "Summer season, May–Aug");
  assert.match(summer.end, /^2026-08-31/);
  assert.match(summer.includes, /August 31/);
  const winter = seasonOffer(new Date("2026-11-02T12:00:00Z"));
  assert.equal(winter.name, "Winter season, Nov–Mar");
  assert.match(winter.end, /^2027-03-31/);
  const { token } = await parent("plans@example.com");
  const month = await json(await call("POST", "/api/checkout", { token, body: { plan: "month" } }));
  assert.equal(month.body.error, "plan");
  const season = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  const current = seasonOffer();
  assert.equal(season.body.planName, current.name);
  assert.equal(season.body.paidUntil, current.end);
});

test("three free jobs are delivered, then requests are held until the parent pays", async () => {
  const { token, email } = await parent("trial@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const published = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam"), draftCode: "samdraft" } }));
  assert.equal(published.body.jobCode, "samdraft");
  for (let n = 1; n <= 3; n += 1) {
    const res = await json(await call("POST", "/api/book", { body: bookAt(n), headers: { "x-forwarded-for": "203.0.113." + n } }));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.held, undefined);
  }
  const me = await json(await call("GET", "/api/me", { token }));
  assert.equal(me.body.trialLeft, 0);
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(box.body.messages.filter((m) => /used up/.test(m.subject)).length, 1);
  assert.match(box.body.messages.map((m) => m.text).join("\n"), /\$19\.99 season/);
  const held = await json(await call("POST", "/api/book", { body: bookAt(4), headers: { "x-forwarded-for": "203.0.113.40" } }));
  assert.equal(held.body.held, true);
  const after = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const waiting = after.body.messages.find((m) => /waiting/.test(m.subject));
  assert.match(waiting.text, /Pay to unlock it/);
  assert.equal(waiting.text.includes("riley4@example.com"), false);
  assert.equal(waiting.text.includes("4 Oak"), false);
  const kid = await json(await call("GET", "/api/my-jobs?code=samdraft"));
  assert.equal(kid.body.jobs.length, 4);
  assert.equal(JSON.stringify(kid.body).includes("riley"), false);
  assert.equal(JSON.stringify(kid.body).includes("Oak"), false);
  assert.equal(kid.body.jobs[0].place, "In your neighborhood");
  assert.equal(kid.body.jobs[3].status, "held");
  assert.equal(kid.body.fresh, 3);
  const closed = await json(await call("GET", "/api/my-jobs?code=notacode"));
  assert.equal(closed.status, 401);
  await call("POST", "/api/share", { token, body: { on: true } });
  const shared = await json(await call("GET", "/api/my-jobs?code=samdraft"));
  assert.equal(shared.body.jobs[0].place, "Oak Street");
  assert.equal(shared.body.jobs[0].place.includes("4"), false);
  const action = (box.body.messages.find((m) => /Mark it confirmed/.test(m.text)).text.match(/\/api\/job\/[a-f0-9]+/) || [])[0];
  const marked = await call("POST", action, { body: { status: "confirmed" } });
  assert.match(marked.body, /confirmed/);
  const seen = await json(await call("GET", "/api/my-jobs?code=samdraft"));
  assert.equal(seen.body.jobs.some((job) => job.status === "confirmed"), true);
  assert.equal(seen.body.fresh, 2);
  const resting = await call("GET", "/api/site/sam");
  assert.equal(resting.status, 200);
  assert.match(resting.body, /Taking a break/);
  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "year" } }));
  assert.equal(pay.body.plan, "year");
  const restored = await call("GET", "/api/site/sam");
  assert.match(restored.body, /<h1>Sam<\/h1>/);
  const unlocked = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.match(unlocked.body.messages.map((m) => m.text).join("\n"), /4 Oak Street/);
  const open = await json(await call("GET", "/api/my-jobs?code=samdraft"));
  assert.equal(open.body.jobs.find((job) => job.service === "Mow 4").status, "new");
  await call("DELETE", "/api/account", { token });
  const again = await parent("trial@example.com");
  const me2 = await json(await call("GET", "/api/me", { token: again.token }));
  assert.equal(me2.body.trialLeft, 0);
});

test("renewal reminders send once, then the page takes a break after grace", async () => {
  const { token, email } = await parent("renew@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 14, 12)).toISOString();
  await patchAccount((account) => { account.paidUntil = end; });
  const denied = await json(await call("GET", "/api/cron/renewals"));
  assert.equal(denied.status, 401);
  const secret = { authorization: "Bearer test-admin-secret" };
  const dry = await json(await call("GET", "/api/cron/renewals?dry=1", { headers: secret }));
  assert.equal(dry.body.dry, true);
  assert.equal(dry.body.due.length, 1);
  assert.equal(dry.body.due[0].days, 14);
  const quiet = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(quiet.body.messages.some((m) => /ends in 14 days/.test(m.subject)), false);
  const sent = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
  assert.equal(sent.body.due.length, 1);
  const mail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const note = mail.body.messages.find((m) => /ends in 14 days/.test(m.subject));
  assert.match(note.text, /Renew in one tap/);
  assert.match(note.text, /\/api\/renew\//);
  const again = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
  assert.equal(again.body.due.length, 0);
  const renewPath = note.text.match(/\/api\/renew\/[a-f0-9]+\?plan=season/)[0];
  await patchAccount((account) => { account.paidUntil = new Date(Date.now() - 2 * 864e5).toISOString(); });
  const during = await call("GET", "/api/site/sam");
  assert.equal(during.status, 200);
  assert.match(during.body, /Sam/);
  const grace = await json(await call("GET", "/api/me", { token }));
  assert.equal(grace.body.grace, true);
  assert.ok(grace.body.graceDays >= 1 && grace.body.graceDays <= 7);
  const renewed = await call("GET", renewPath);
  assert.match(renewed.body, /You're renewed/);
  await patchAccount((account) => { account.paidUntil = new Date(Date.now() - 8 * 864e5).toISOString(); });
  const resting = await call("GET", "/api/site/sam");
  assert.equal(resting.status, 200);
  assert.match(resting.body, /Taking a break/);
  assert.equal(resting.body.includes("<h1>Sam</h1>"), false);
  const paused = await json(await call("POST", "/api/book", { body: bookAt(5), headers: { "x-forwarded-for": "203.0.113.90" } }));
  assert.equal(paused.status, 403);
  assert.match(paused.body.message, /paused/);
});

test("a free trial lasts TRIAL_DAYS or 3 jobs, then the page takes a break and bookings are held", async () => {
  assert.equal(TRIAL_DAYS, 14);
  assert.equal(trialLengthDays(), 14);
  process.env.TRIAL_DAYS = "10";
  try {
    assert.equal(trialLengthDays(), 10);
    const { token, email } = await parent("clock@example.com");
    await call("POST", "/api/consent", { token, body: { consent: true } });
    const published = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
    const span = Date.parse(published.body.trialEndsAt) - Date.now();
    assert.ok(span > 9 * 864e5 && span < 11 * 864e5);
    const me = await json(await call("GET", "/api/me", { token }));
    assert.equal(me.body.trialLeft, 3);
    assert.ok(me.body.trialDaysLeft >= 9 && me.body.trialDaysLeft <= 10);
    assert.match(trialLineStandin(me.body), /days \/ 3 free jobs left/);
    const saved = await json(await call("POST", "/api/draft", { token, body: { draft: { first: "Sam", type: "lawn" } } }));
    assert.equal(saved.body.ok, true);
    const secret = { authorization: "Bearer test-admin-secret" };
    const soon = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 3, 15)).toISOString();
    await patchAccount((account) => { account.trialEndsAt = soon; });
    const dry = await json(await call("GET", "/api/cron/renewals?dry=1", { headers: secret }));
    assert.equal(dry.body.due.some((row) => row.kind === "trial-3"), true);
    const quiet = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
    assert.equal(quiet.body.messages.some((m) => /trial ends in 3 days/.test(m.subject)), false);
    await call("GET", "/api/cron/renewals", { headers: secret });
    const again = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
    assert.equal(again.body.due.filter((row) => row.kind === "trial-3").length, 0);
    const mail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
    const note = mail.body.messages.find((m) => /trial ends in 3 days/.test(m.subject));
    assert.match(note.text, /\$19\.99 for the season/);
    assert.match(note.html, /Pay \$19\.99 for the season/);
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 23, 59, 0)).toISOString();
    await patchAccount((account) => { account.trialEndsAt = today; });
    const endRun = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
    assert.equal(endRun.body.due.some((row) => row.kind === "trial-0"), true);
    const endAgain = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
    assert.equal(endAgain.body.due.some((row) => row.kind === "trial-0"), false);
    const still = await call("GET", "/api/site/sam");
    assert.match(still.body, /<h1>Sam<\/h1>/);
    await patchAccount((account) => { account.trialEndsAt = new Date(Date.now() - 3600e3).toISOString(); });
    const qr = await call("GET", "/api/site/sam");
    assert.equal(qr.status, 200);
    assert.match(qr.body, /Taking a break/);
    assert.equal(qr.body.includes("<h1>Sam</h1>"), false);
    const held = await json(await call("POST", "/api/book", { body: bookAt(1), headers: { "x-forwarded-for": "203.0.113.61" } }));
    assert.equal(held.status, 200);
    assert.equal(held.body.held, true);
    const draft = await json(await call("GET", "/api/draft/" + saved.body.code));
    assert.equal(draft.body.draft.first, "Sam");
    const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(pay.body.ok, true);
    const back = await call("GET", "/api/site/sam");
    assert.match(back.body, /<h1>Sam<\/h1>/);
    const unlocked = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
    assert.match(unlocked.body.messages.map((m) => m.text).join("\n"), /1 Oak Street/);
  } finally {
    delete process.env.TRIAL_DAYS;
  }
});

function trialLineStandin(me) {
  return me.trialDaysLeft + " days / " + me.trialLeft + " free jobs left.";
}

test("pet words and a pet booking stay allowed, and the key note stays with the parent", async () => {
  const phrase = "poop scoop dog poo pooper scooper litter kitty pet sitting";
  assert.equal(wordHits(phrase).block, "");
  assert.equal(checkSlug("poop-scoop"), "");
  assert.equal(checkSlug("pet-sitting"), "");
  const { readFile } = await import("fs/promises");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /Start a pet care page/);
  assert.match(src, /No aggressive dogs/);
  assert.match(src, /Poop scoop, one time/);
  assert.match(src, /Dog walk, 15 minutes/);
  assert.equal((src.match(/id:"pet"/g) || []).length, 1);
  assert.match(src, /dog:"Dog",cat:"Cat",fish:"Fish",bird:"Bird"/);
  assert.match(src, /Pets on your pictures/);
  const { token, email } = await parent("petparent@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-pets", html: page("Sam Pets") } }));
  assert.equal(pub.body.ok, true);
  const booked = await json(await call("POST", "/api/book", { body: {
    slug: "sam-pets", name: "Neighbor", contact: "neighbor-pet@example.com", service: "Poop scoop, one time",
    when: "Saturday morning", address: "4 Pine", start: "2026-11-07T10:00", t: 3000,
    freq: "Weekly poop scoop", petKind: "Dog", petCount: "2", petNames: "Milo", petSize: "Medium",
    dayPart: "Morning", access: "lockbox 4481"
  } }));
  assert.equal(booked.body.ok, true);
  const parentMail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const msg = parentMail.body.messages.at(-1);
  assert.match(msg.text, /Milo/);
  assert.match(msg.text, /lockbox 4481/);
  assert.match(msg.text, /Poop scoop/);
  assert.match(msg.ics || "", /Milo/);
  const note = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent("neighbor-pet@example.com")));
  assert.match(note.body.messages[0].text, /Poop scoop/);
  assert.equal(note.body.messages[0].text.includes("lockbox"), false);
  assert.equal(note.body.messages[0].text.includes(email), false);
  const plain = cardPng({ title: "Sam Pets", line: "Pet care", accent: "#0F6E6A" });
  const pictured = cardPng({ title: "Sam Pets", line: "Pet care", accent: "#0F6E6A", pets: ["dog", "cat", "fish", "bird"] });
  assert.equal(pictured[0], 137);
  assert.notEqual(Buffer.compare(plain, pictured), 0);
});

