import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "crypto";
import { fileStore, setStore } from "../host/lib/store.mjs";
import { chicagoWall, jobsToIcs } from "../host/lib/calendar.mjs";
import { handleRequest, petOgImage, seasonOffer, stripeSignatureOk, trialLengthDays, TRIAL_DAYS } from "../host/lib/router.mjs";
import { stripParentContact } from "../host/lib/preview.mjs";
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
    headers: { origin: "http://sites.test", authorization: token ? "Bearer " + token : "", ...(headers || {}) },
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

async function pendingSession(accountId,plan,id) {
  const file=dir+'/accounts/'+accountId+'.json';
  const account=JSON.parse(await readFile(file,'utf8'));
  account.checkoutSessionId=id;account.checkoutPlan=plan;
  const attempt=createHash('sha256').update('checkout:'+accountId+':'+(account.checkoutGeneration||0)).digest('hex');
  await writeFile(file,JSON.stringify(account));
  return {id,payment_status:'paid',amount_total:plan==='year'?1999:999,currency:'usd',metadata:{accountId,plan,attempt}};
}

test("the first page stays under 300KB compressed", async () => {
  const { brotliCompressSync } = await import("zlib");
  const html = await readFile(new URL("../index.html", import.meta.url));
  const size = brotliCompressSync(html).length;
  assert.ok(size < 300000, "brotli bytes " + size);
  assert.match(html.toString("utf8"), /<h1 class="sr-only">Your kid's first neighborhood business<\/h1>/);
  assert.equal(html.includes("data:image/jpeg;base64"), false);
});

test("the parent landing names the winter price and uses a made-up example", async () => {
  const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const block = home.slice(home.indexOf('id="forParents"'), home.indexOf("</section>") + 10);
  assert.match(block, /\$9\.99 for the whole winter, never auto-renews/);
  assert.match(block, /id="parentsStart"/);
  assert.match(block, />Start free</);
  assert.match(home, /if\(!force\)document\.documentElement\.classList\.add\("hb-skip-parents"\)/);
  assert.equal(home.includes('setItem("hb_intro_seen"'), false);
  assert.match(home, /shouldOpenIntro\(entryParams\)&&document\.documentElement\.classList\.contains\("hb-skip-parents"\)/);
  assert.match(block, /Sam's Lawn Co\./);
  assert.match(block, /Elkhorn/);
  assert.equal(/steve|lincoln|maryn|levi|402/i.test(block), false);
  assert.match(checkSlug("parents"), /reserved/i);
});

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
  assert.equal(consent.body.method, "card_charge");
  assert.equal(consent.body.refunded, true);
  const meChecked = await json(await call("GET", "/api/me", { token }));
  assert.equal(meChecked.body.consent, true);
  assert.equal(meChecked.body.consentMethod, "card_charge");
  const noPay = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
  assert.equal(noPay.status, 200);
  assert.equal(noPay.body.ok, true);
  const meFree = await json(await call("GET", "/api/me", { token }));
  assert.equal(meFree.body.paid, false);
  assert.equal(meFree.body.trialLeft, null);

  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(pay.body.mode, "test");
  assert.equal(pay.body.plan, "season");
  const stillCard = await json(await call("GET", "/api/me", { token }));
  assert.equal(stillCard.body.consentMethod, "card_charge", "a later plan does not erase a finished card check");
});

test("a real plan payment counts as the parent check and skips the 50 cent charge", async () => {
  const { token } = await parent();
  const blocked = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam") } }));
  assert.equal(blocked.status, 403);
  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "year" } }));
  assert.equal(pay.body.ok, true);
  const me = await json(await call("GET", "/api/me", { token }));
  assert.equal(me.body.consent, true);
  assert.equal(me.body.consentMethod, "plan_payment");
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam") } }));
  assert.equal(pub.status, 200);
  const again = await json(await call("POST", "/api/consent", { token, body: { consent: true } }));
  assert.equal(again.body.already, true);
  assert.equal(again.body.method, "plan_payment");
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

  // Family plan: a second, unowned address JOINS the same account instead
  // of the old 409 slug-locked refusal. Another family's address (below)
  // still refuses.
  const joined = await json(await call("POST", "/api/publish", { token, body: { slug: "other-yard", html: page("Other") } }));
  assert.equal(joined.status, 200);
  assert.equal(joined.body.added, true);
  const joinedLive = await call("GET", "/api/site/other-yard");
  assert.equal(joinedLive.status, 200);
  assert.match(joinedLive.body, /Other/);

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
  const payload = JSON.stringify({ id: "evt_paid_once", type: "checkout.session.completed", data: { object: await pendingSession(accountId,"season","cs_paid_once") } });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const bad = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers: { "stripe-signature": "t=1,v1=deadbeef" } }));
  assert.equal(bad.status, 400);
  const t = String(Math.floor(Date.now() / 1000));
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
    return { ok: true, json: async () => ({id:"cs_descriptor", url: "https://checkout.stripe.test/c" }) };
  };
  try {
    const res = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.url, "https://checkout.stripe.test/c");
    const params = new URLSearchParams(seen);
    assert.equal(params.get("payment_intent_data[statement_descriptor_suffix]"), "HUSTLE BLDR");
    assert.ok(("KEYSTONE* " + params.get("payment_intent_data[statement_descriptor_suffix]")).length <= 22);
    assert.equal(params.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(params.get("line_items[0][price_data][unit_amount]"), "999");
    assert.equal(params.get("line_items[0][price]"), null);
    const yearParent = await parent("card-year@example.com");
    const year = await json(await call("POST", "/api/checkout", { token: yearParent.token, body: { plan: "year" } }));
    assert.equal(year.body.ok, true);
    const yearParams = new URLSearchParams(seen);
    assert.equal(yearParams.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(yearParams.get("line_items[0][price_data][unit_amount]"), "1999");
    assert.equal(yearParams.get("line_items[0][price]"), null);
    const checkParent = await parent("card-check@example.com");
    await call("POST", "/api/consent", { token: checkParent.token, body: { consent: true } });
    const checkParams = new URLSearchParams(seen);
    assert.equal(checkParams.get("payment_intent_data[statement_descriptor_suffix]"), "HUSTLE BLDR");
    assert.equal(checkParams.get("line_items[0][price_data][unit_amount]"), "50");
    const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(home, /id="buySeason">Buy the winter season, \$9\.99/);
  } finally {
    global.fetch = prev;
    process.env.PAYWALL_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("an existing page does not skip the parent check, and both plans can open checkout", async () => {
  const { token } = await parent("family-check@example.com");
  const files = await readdir(path.join(dir, "accounts"));
  const file = path.join(dir, "accounts", files[0]);
  const account = JSON.parse(await readFile(file, "utf8"));
  account.slug = "old-yard";
  account.slugs = ["old-yard"];
  delete account.consentAt;
  delete account.consentMethod;
  delete account.consentRefundedAt;
  await writeFile(file, JSON.stringify(account));
  const blocked = await json(await call("POST", "/api/publish", { token, body: { slug: "new-yard", html: page("New") } }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, "consent");
  process.env.PAYWALL_MODE = "stripe";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const prev = global.fetch;
  const bodies = [];
  global.fetch = async (_url, opt) => {
    bodies.push(String(opt && opt.body || ""));
    const n = bodies.length;
    return { ok: true, json: async () => ({ id: "cs_family_" + n, url: "https://checkout.stripe.test/pay" + n, status: "open" }) };
  };
  try {
    const check = await json(await call("POST", "/api/consent", { token, body: { consent: true } }));
    assert.equal(check.body.ok, true);
    assert.equal(check.body.needsCard, true);
    assert.equal(check.body.url, "https://checkout.stripe.test/pay1");
    assert.equal(new URLSearchParams(bodies[0]).get("line_items[0][price_data][unit_amount]"), "50");
    const yearParent = await parent("family-year@example.com");
    const yearFile = path.join(dir, "accounts", (await readdir(path.join(dir, "accounts"))).find((name) => name !== files[0]));
    const yearAccount = JSON.parse(await readFile(yearFile, "utf8"));
    yearAccount.slug = "year-yard";
    yearAccount.slugs = ["year-yard"];
    delete yearAccount.consentAt;
    delete yearAccount.consentMethod;
    await writeFile(yearFile, JSON.stringify(yearAccount));
    const season = await json(await call("POST", "/api/checkout", { token: yearParent.token, body: { plan: "season" } }));
    assert.equal(season.body.ok, true);
    assert.equal(season.body.url, "https://checkout.stripe.test/pay2");
    assert.equal(new URLSearchParams(bodies.at(-1)).get("line_items[0][price_data][unit_amount]"), "999");
    const year = await json(await call("POST", "/api/checkout", { token: yearParent.token, body: { plan: "year" } }));
    assert.equal(year.body.ok, true);
    assert.match(year.body.url || "", /^https:\/\/checkout\.stripe\.test\/pay/);
    assert.equal(new URLSearchParams(bodies.at(-1)).get("line_items[0][price_data][unit_amount]"), "1999");
  } finally {
    global.fetch = prev;
    process.env.PAYWALL_MODE = "test";
    delete process.env.STRIPE_SECRET_KEY;
  }
  const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(home.includes("if(!session.slug){"), false);
  assert.match(home, /const prior=await pubApi\("\/api\/me"/);
  assert.match(home, /day"\+\(days===1\?"":"s"\)\+" left/);
  assert.match(home, /placeholder="Taylor's Lawn Co\."/);
  assert.match(home, /Pick at least one day you can work, then tap Next\./);
  assert.match(home, /\$\("#pubCode"\)\.value=""/);
  assert.match(home, /verified\.scrollIntoView\(\{block:"center"\}\)/);
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
  global.fetch = async (_url,init) => {
    if(!init?.method)return {ok:true,json:async()=>({id:'cs_once',status:'open',url:'https://checkout.stripe.test/once'})};
    calls++;return {ok:true,json:async()=>({id:'cs_once',url:'https://checkout.stripe.test/once'})};
  };
  try {
    const first = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(first.body.url, "https://checkout.stripe.test/once");
    const second = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
    assert.equal(second.body.url,"https://checkout.stripe.test/once");
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
  assert.equal(live2.body.includes("tel:"), false);
  assert.equal(live2.body.includes("4025550100"), false);
});

test("a public page and its site payload contain no parent email or phone", async () => {
  const leaked = `<!DOCTYPE html><html><head><title>Will</title></head><body>
<a class="btn alt" href="mailto:parent@example.com">Email</a>
<a href="tel:4025550199">Call</a>
<p>Steve helps run this business.</p>
<script>window.__C={"first":"Will","biz":"The Lawn Ranger","email":"parent@example.com","phoneDigits":"4025550199","phone":"402-555-0199"};
if(e){e.onclick=function(){var m=build(); if(m){window.location.href="mailto:"+C.email+"?subject="+encodeURIComponent("Booking request: "+C.biz)+"&body="+encodeURIComponent(m);}};}
</script>
</body></html>`;
  const { token, email } = await parent("secret-parent@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const pub = await json(await call("POST", "/api/publish", { token, body: {
    slug: "will-public", html: page("Will") + leaked, showPhone: true, phone: "402-555-0199"
  } }));
  assert.equal(pub.body.ok, true);
  const live = await call("GET", "/api/site/will-public");
  assert.equal(live.status, 200);
  assert.equal(live.body.includes("secret-parent@example.com"), false);
  assert.equal(live.body.includes("parent@example.com"), false);
  assert.equal(live.body.includes("@gmail.com"), false);
  assert.equal(live.body.includes("4025550199"), false);
  assert.equal(live.body.includes("402-555-0199"), false);
  assert.equal(live.body.includes("mailto:parent"), false);
  assert.equal(live.body.includes("tel:"), false);
  assert.match(live.body, /href="#book"/);
  assert.match(live.body, /"email":""/);
  assert.match(live.body, /"first":"Will"/);
  assert.match(live.body, /Report this page/);
  assert.match(live.body, /report-link-contrast/);
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "will-public", name: "Dana", contact: "402-555-0101", service: "Mow", when: "Saturday at 10:00 AM",
    address: "8 Quiet St", note: "front", start: "2026-11-21T10:00", t: 5000
  } }));
  assert.equal(book.body.ok, true);
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.ok(box.body.messages.length >= 1);
  assert.equal(live.body.includes(email), false);
  for (const slug of ["maryn", "will-highline-yard"]) {
    const pub2 = await json(await call("POST", "/api/publish", { token, body: { slug, html: page(slug) + leaked, showPhone: true, phone: "402-555-0199" } }));
    assert.equal(pub2.body.ok, true, slug);
    const live2 = await call("GET", "/api/site/" + slug);
    assert.equal(live2.body.includes("parent@example.com"), false, slug);
    assert.equal(live2.body.includes(email), false, slug);
    assert.equal(live2.body.includes("4025550199"), false, slug);
    assert.equal(live2.body.includes("mailto:"), false, slug);
  }
});

test("a plan purchase is recorded on the page the parent was buying", async () => {
  const { token } = await parent("which-page@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "maryn", html: page("Maryn") } });
  await call("POST", "/api/publish", { token, body: { slug: "will-the-lawn-ranger", html: page("Will") } });
  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season", slug: "will-the-lawn-ranger" } }));
  assert.equal(pay.body.ok, true);
  const acct = await json(await call("GET", "/api/account", { token }));
  const maryn = acct.body.sites.find((site) => site.slug === "maryn");
  const will = acct.body.sites.find((site) => site.slug === "will-the-lawn-ranger");
  assert.equal(maryn.receipts.length, 0);
  assert.equal(will.receipts.length, 1);
  assert.equal(will.receipts[0].slug, "will-the-lawn-ranger");
  assert.equal(will.paid, true);
  assert.match(will.planName, /Winter season/);
});

test("the builder hides the phone unless the parent turns it on", async () => {
  const { readFile } = await import("fs/promises");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /showPhone:false/);
  assert.match(src, /const publicPhone=false/);
  assert.equal(src.includes("mailto:${esc(c.email)}"), false);
  assert.match(src, /href="#book">Email</);
  assert.match(src, /mailto:bookings@hustlebuilder\.org/);
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

test("ask my parent requires verification and reports only the verified family page live", async () => {
  const draft = { type: "pet", first: "Sam", town: "Elkhorn", bizName: "Sam’s Pet Care", services: [{ n: "Dog walk", p: "8" }] };
  const sent = await json(await call("POST", "/api/ask", { body: { email: "mom@example.com", draft } }));
  assert.equal(sent.body.ok, true);
  assert.match(sent.body.link, /\/\?ask=/);
  const mail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent("mom@example.com")));
  assert.match(mail.body.messages[0].text, /device where your child built it/);
  assert.match(mail.body.messages[0].text, /50¢ card check that is refunded/);
  assert.doesNotMatch(mail.body.messages[0].text, /No payment is needed/);
  assert.match(mail.body.messages[0].text, /ask=/);
  const waiting = await json(await call("GET", "/api/ask/" + sent.body.token));
  assert.equal(waiting.body.status, "waiting");
  assert.equal(waiting.body.draft, undefined);
  const opened = await json(await call("POST", "/api/ask/" + sent.body.token + "/open", { body: {} }));
  assert.equal(opened.body.ok, true);
  assert.equal(opened.body.email, "mom@example.com");
  assert.equal(opened.body.draft, undefined);
  assert.equal(opened.body.first, "Sam");
  assert.match(opened.body.biz, /Pet Care/);
  const storedAsk = JSON.parse(await readFile(path.join(dir, "asks", sent.body.token + ".json"), "utf8"));
  assert.equal(storedAsk.draft, undefined);
  assert.equal(JSON.stringify(storedAsk).includes("Dog walk"), false);
  assert.equal(JSON.stringify(storedAsk).includes("phone"), false);
  assert.equal(opened.body.token,undefined);
  assert.equal(opened.body.requiresVerification,true);
  assert.equal((await json(await call('POST','/api/ask/'+sent.body.token+'/done',{body:{url:'https://bad.invalid'}}))).status,401);
  const verified=await parent('mom@example.com');
  await call('POST','/api/consent',{token:verified.token,body:{consent:true}});
  await call('POST','/api/publish',{token:verified.token,body:{slug:'sam-pets',html:page('Sam')}});
  const done=await json(await call('POST','/api/ask/'+sent.body.token+'/done',{token:verified.token,body:{slug:'sam-pets',url:'https://bad.invalid'}}));
  assert.equal(done.body.status,'live');
  const live = await json(await call("GET", "/api/ask/" + sent.body.token));
  assert.equal(live.body.status, "live");
  assert.equal(live.body.url, "http://sites.test/sam-pets");
  for (let i = 0; i < 5; i++) await call("POST", "/api/ask", { body: { email: "mom@example.com", draft } });
  const limited = await json(await call("POST", "/api/ask", { body: { email: "mom@example.com", draft } }));
  assert.equal(limited.status, 429);
});

test("auth start is limited to five code emails per address per day", async () => {
  const email = "codes@example.com";
  for (let i = 0; i < 5; i++) {
    const ok = await json(await call("POST", "/api/auth/start", { body: { email } }));
    assert.equal(ok.body.ok, true);
  }
  const limited = await json(await call("POST", "/api/auth/start", { body: { email } }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "limit");
});

test("auth start is limited to eight code emails per IP per day", async () => {
  for (let i = 0; i < 8; i++) {
    const ok = await json(await call("POST", "/api/auth/start", { body: { email: "person" + i + "@example.com" } }));
    assert.equal(ok.body.ok, true);
  }
  const limited = await json(await call("POST", "/api/auth/start", { body: { email: "person8@example.com" } }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "limit");
});

test("an expired ask link cannot be marked done", async () => {
  const draft = { type: "pet", first: "Sam", town: "Elkhorn", bizName: "Sam’s Pet Care", services: [{ n: "Dog walk", p: "8" }] };
  const sent = await json(await call("POST", "/api/ask", { body: { email: "dad@example.com", draft } }));
  assert.equal(sent.body.ok, true);
  const file = path.join(dir, "asks", sent.body.token + ".json");
  const rec = JSON.parse(await readFile(file, "utf8"));
  rec.expires = new Date(Date.now() - 60000).toISOString();
  await writeFile(file, JSON.stringify(rec));
  const done = await json(await call("POST", "/api/ask/" + sent.body.token + "/done", { body: { url: "https://sites.test/sam-pets" } }));
  assert.equal(done.status, 404);
  await assert.rejects(() => readFile(file));
});

test("an unfinished ask is deleted after 7 days", async () => {
  const sent = await json(await call("POST", "/api/ask", { body: { email: "later@example.com", first: "Sam", biz: "Sam's Yard", draft: { phone: "4025550100", services: [{ n: "Mow" }] } } }));
  assert.equal(sent.body.ok, true);
  const file = path.join(dir, "asks", sent.body.token + ".json");
  const rec = JSON.parse(await readFile(file, "utf8"));
  assert.equal(rec.draft, undefined);
  assert.equal(rec.first, "Sam");
  assert.equal(rec.biz, "Sam's Yard");
  assert.equal(JSON.stringify(rec).includes("4025550100"), false);
  rec.expires = new Date(Date.now() - 1000).toISOString();
  await writeFile(file, JSON.stringify(rec));
  await call("GET", "/api/cron/renewals", { headers: { authorization: "Bearer test-admin-secret" } });
  await assert.rejects(() => readFile(file));
});

test("a draft is not stored until a parent consents", async () => {
  const denied = await json(await call("POST", "/api/draft", { body: { draft: { type: "wash", first: "Riley", phone: "4025550100", services: [{ n: "Wash the outside", p: "10" }] } } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "consent");
  assert.deepEqual(await readdir(path.join(dir, "drafts")).catch(() => []), []);
  const { token } = await parent("draft@example.com");
  const early = await json(await call("POST", "/api/draft", { token, body: { draft: { first: "Riley", phone: "4025550100" } } }));
  assert.equal(early.status, 403);
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const saved = await json(await call("POST", "/api/draft", { token, body: { draft: { type: "wash", first: "Riley", services: [{ n: "Wash the outside", p: "10" }] } } }));
  assert.equal(saved.body.ok, true);
  assert.match(saved.body.code, /^[a-z0-9]{8}$/);
  assert.match(saved.body.link, /draft=/);
  const loaded = await json(await call("GET", "/api/draft/" + saved.body.code));
  assert.equal(loaded.body.draft.first, "Riley");
  const again = await json(await call("POST", "/api/draft", { token, body: { code: saved.body.code, draft: { type: "wash", first: "Riley", town: "Millard" } } }));
  assert.equal(again.body.code, saved.body.code);
  const missing = await json(await call("GET", "/api/draft/zzzzzzzz"));
  assert.equal(missing.status, 404);
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
  assert.match(msg.text, /Make one for your kid, free for 14 days/);
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
  assert.deepEqual(plans.body.plans.map((p) => p.price), ["$9.99", "$19.99"]);
  assert.deepEqual(plans.body.plans.map((p) => p.amount), [999, 1999]);
  assert.equal(JSON.stringify(plans.body).includes("$6"), false);
  assert.match(plans.body.free, /14 days after first publish/);
  assert.match(plans.body.free, /never charged automatically/);
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

test("booking volume does not end the trial; expired requests wait until payment", async () => {
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
  assert.equal(me.body.trialLeft, null);
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(box.body.messages.filter((m) => /used up/.test(m.subject)).length, 0);
  assert.equal(me.body.trialOver, false);
  const fourth=await json(await call("POST", "/api/book", { body: bookAt(9), headers: { "x-forwarded-for": "203.0.113.99" } }));
  assert.equal(fourth.body.held, undefined);
  await patchAccount(account=>{account.trialEndsAt=new Date(Date.now()-1000).toISOString();});

  const held = await json(await call("POST", "/api/book", { body: bookAt(4), headers: { "x-forwarded-for": "203.0.113.40" } }));
  assert.equal(held.body.held, true);
  const after = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const waiting = after.body.messages.find((m) => /waiting/.test(m.subject));
  assert.match(waiting.text, /Pay to unlock it/);
  assert.equal(waiting.text.includes("riley4@example.com"), false);
  assert.equal(waiting.text.includes("4 Oak"), false);
  const kid = await json(await call("GET", "/api/my-jobs?code=samdraft"));
  assert.equal(kid.body.jobs.length, 5);
  assert.equal(JSON.stringify(kid.body).includes("riley"), false);
  assert.equal(JSON.stringify(kid.body).includes("Oak"), false);
  assert.equal(kid.body.jobs[0].place, "In your neighborhood");
  assert.equal(kid.body.jobs[4].status, "held");
  assert.equal(kid.body.fresh, 4);
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
  assert.equal(seen.body.fresh, 3);
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
  assert.equal(me2.body.trialLeft, null);
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
  assert.match(note.text, /Renew from your account/);
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
  assert.equal(renewed.status, 302);
  assert.equal(renewed.headers.location, "http://sites.test/?account=1&plan=season");
  assert.equal((await json(await call('GET','/api/me',{token}))).body.paid,false);
  await patchAccount((account) => { account.paidUntil = new Date(Date.now() - 8 * 864e5).toISOString(); });
  const resting = await call("GET", "/api/site/sam");
  assert.equal(resting.status, 200);
  assert.match(resting.body, /Taking a break/);
  assert.equal(resting.body.includes("<h1>Sam</h1>"), false);
  const paused = await json(await call("POST", "/api/book", { body: bookAt(5), headers: { "x-forwarded-for": "203.0.113.90" } }));
  assert.equal(paused.status, 403);
  assert.match(paused.body.message, /paused/);
});

test("a free trial lasts TRIAL_DAYS, then the page takes a break and bookings are held", async () => {
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
    assert.equal(me.body.trialLeft, null);
    assert.ok(me.body.trialDaysLeft >= 9 && me.body.trialDaysLeft <= 10);
    assert.match(trialLineStandin(me.body), /days left/);
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
    assert.match(note.text, /\$9\.99 for the season/);
    assert.match(note.html, /Pay \$9\.99 for the season/);
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

test("a leftover trial clock does not shorten the first publish of a new account", async () => {
  const email = "inherited@example.com";
  const hash = createHash("sha256").update(email).digest("hex");
  await mkdir(path.join(dir, "trials"), { recursive: true });
  await writeFile(path.join(dir, "trials", hash + ".json"), JSON.stringify({
    trialStartedAt: new Date(Date.now() - 13 * 864e5).toISOString(),
    trialEndsAt: new Date(Date.now() + 864e5).toISOString()
  }));
  const { token } = await parent(email);
  const before = await json(await call("GET", "/api/me", { token }));
  assert.ok(before.body.trialDaysLeft <= 2);
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const published = await json(await call("POST", "/api/publish", { token, body: { slug: "will-yard", html: page("Will") } }));
  assert.equal(published.body.ok, true);
  assert.ok(published.body.trialDaysLeft >= 13 && published.body.trialDaysLeft <= 14);
  const again = await json(await call("POST", "/api/publish", { token, body: { slug: "will-yard", html: page("Will again") } }));
  assert.equal(again.body.trialEndsAt, published.body.trialEndsAt);
});

test("a parent can confirm, finish, or cancel a booking from My jobs", async () => {
  const { token, email } = await parent("jobs@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Dana", contact: "402-555-0199", service: "Mow", when: "Saturday at 10:00 AM",
    address: "8 Quiet St", note: "front", start: "2026-11-21T10:00", t: 5000
  } }));
  assert.equal(book.body.ok, true);
  const list = await json(await call("GET", "/api/my-jobs", { token }));
  assert.equal(list.body.jobs.length, 1);
  assert.match(list.body.jobs[0].action, /^[a-f0-9]{16,}$/);
  const marked = await json(await call("POST", "/api/job/" + list.body.jobs[0].action, { token, body: { status: "confirmed", json: true } }));
  assert.equal(marked.body.ok, true);
  assert.equal(marked.body.status, "confirmed");
  const after = await json(await call("GET", "/api/my-jobs", { token }));
  assert.equal(after.body.jobs[0].status, "confirmed");
  const cancelled = await json(await call("POST", "/api/job/" + list.body.jobs[0].action, { token, body: { status: "cancelled", json: true } }));
  assert.equal(cancelled.body.status, "cancelled");
  const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(home, /data-st="confirmed">Confirm/);
  assert.match(home, /data-st="done">Done/);
  assert.match(home, /data-st="cancelled">Cancel/);
  assert.match(home, /settleGoLive\(me\)/);
  assert.match(home, /id="askCopy"/);
  assert.match(home, /id="fUrlHelp"/);
  assert.match(home, /fHelp\.hidden=/);
  assert.match(home, /if\(!build\(false\)\)return/);
  assert.match(home, /href="\/privacy">Privacy/);
  assert.match(home, /href="\/terms">Terms/);
  assert.match(home, /parents-only/);
  assert.match(home, /location\.pathname==="\/parents"/);
  assert.match(home, /What job do you need\?/);
  assert.match(home, /Plans are one-time payments and never renew on their own\./);
  assert.match(home, /function applyPlanChrome\(me\)/);
  assert.match(home, /id="planStatus"/);
  assert.match(home, /Your site is good through /);
  assert.match(home, /const EXAMPLE_RATES=/);
  assert.match(home, /class="parents-link" href="\/parents"/);
  assert.match(home, /overflow-wrap:break-word;word-break:normal/);
  assert.equal(email.includes("@"), true);
});

function trialLineStandin(me) {
  return me.trialDaysLeft + " days left.";
}

test("pet words and a pet booking stay allowed, and the key note stays with the parent", async () => {
  const phrase = "poop scoop dog poo pooper scooper litter kitty pet sitting";
  assert.equal(wordHits(phrase).block, "");
  assert.equal(checkSlug("poop-scoop"), "");
  assert.equal(checkSlug("pet-sitting"), "");
  const { readFile } = await import("fs/promises");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /id="petFront" hidden/);
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
  assert.equal(plain[0], 137);
  assert.equal(petOgImage("https://hustlebuilder.org"), "https://hustlebuilder.org/assets/pets/pet-og.jpg");
  assert.equal(petOgImage("https://www.hustlebuilder.org"), "https://hustlebuilder.org/assets/pets/pet-og.jpg");
  assert.equal(petOgImage("http://sites.test"), "http://sites.test/assets/pets/pet-og.jpg");
  const preview = await json(await call("POST", "/api/publish", {
    token,
    body: { slug: "sam-pets", html: page("Sam Pets"), pets: ["dog", "cat", "bird"] }
  }));
  assert.equal(preview.body.ok, true);
  const shared = await call("GET", "/api/site/sam-pets");
  assert.match(shared.body, /property="og:image" content="http:\/\/sites\.test\/assets\/pets\/pet-og\.jpg"/);
  assert.match(src, /assets\/pets\/pet-hero\.webp/);
  assert.match(src, /pet-dog\.webp/);
  assert.equal(src.includes("function petAnimal"), false);
});

test("add more jobs lists the selected business type first", async () => {
  const { readFile } = await import("fs/promises");
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("const JOBS=");
  const end = src.indexOf("JOBS.forEach(g=>g.items", start);
  if (start < 0 || end < 0) throw new Error("missing job catalog");
  const names = (picked) => runInNewContext(src.slice(start, end) + `orderedJobGroups(${JSON.stringify(picked)}).map(g=>g.g).join("|")`);
  const all = ["Yard jobs", "Snow jobs", "Pet jobs", "Car jobs", "Reading jobs", "Helpful extras"];
  const expectOrder = (picked, first) => {
    const got = names(picked).split("|");
    assert.deepEqual(got.slice(0, first.length), first);
    assert.deepEqual(got.slice().sort(), all.slice().sort());
    assert.equal(new Set(got).size, got.length);
  };
  expectOrder("lawn", ["Yard jobs"]);
  expectOrder("snow", ["Snow jobs"]);
  expectOrder("pet", ["Pet jobs"]);
  expectOrder("both", ["Yard jobs", "Snow jobs"]);
  expectOrder("odd", ["Yard jobs"]);
  expectOrder("wash", ["Car jobs"]);
  expectOrder("help", ["Helpful extras"]);
  expectOrder("tutor", ["Reading jobs"]);
  expectOrder("other", ["Yard jobs", "Snow jobs", "Pet jobs", "Car jobs", "Reading jobs", "Helpful extras"]);
  expectOrder(["pet", "snow"], ["Pet jobs", "Snow jobs"]);
  expectOrder(["snow", "lawn"], ["Snow jobs", "Yard jobs"]);
  expectOrder(["both", "pet"], ["Yard jobs", "Snow jobs", "Pet jobs"]);
  assert.match(src, /orderedJobGroups\(picked\)/);
  assert.equal(src.includes('groups=[JOBS[2],JOBS[1],JOBS[3]]'), false);
});

test("each business type preloads starter jobs", async () => {
  const { readFile } = await import("fs/promises");
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("const PRESETS=");
  const end = src.indexOf("const TAGS=", start);
  if (start < 0 || end < 0) throw new Error("missing starter jobs");
  const api = runInNewContext(src.slice(start, end) + "({starterServices, svcSwitch})");
  const { starterServices, svcSwitch } = api;
  for (const type of ["lawn", "snow", "pet", "wash", "odd", "help", "tutor", "both"]) {
    const jobs = starterServices(type, 1);
    assert.ok(jobs.length >= 4, type + " preloaded " + jobs.length);
    assert.equal(new Set(jobs.map((job) => job.n.toLowerCase())).size, jobs.length);
    assert.ok(jobs.every((job) => Number(job.p) > 0));
  }
  assert.equal(starterServices("other", 1).length, 1);
  const lawn = starterServices("lawn", 1).map((job) => job.n);
  assert.ok(lawn.includes("Mow a small yard"));
  assert.ok(lawn.includes("Weeding"));
  assert.equal(starterServices("lawn", 1)[0].p, "10");
  assert.equal(starterServices("lawn", 5)[0].p, "15"); // softened curve (Steven, 2026-11-07): L5 = base x1.48
  const mixed = starterServices(["pet", "lawn"], 1);
  assert.equal(mixed[0].n, "Dog walk, 15 minutes");
  assert.ok(mixed.some((job) => job.n === "Mow a small yard"));
  assert.equal(new Set(mixed.map((job) => job.n.toLowerCase())).size, mixed.length);
  const year = starterServices("both", 1).map((job) => job.n);
  assert.ok(year.includes("Mow a small yard") && year.includes("Shovel the driveway"));
  // switching to a job with no saved rows seeds that job's starters
  const seeded = svcSwitch({}, "pet", { services: starterServices("pet", 1), edited: true }, "lawn", 1);
  assert.deepEqual(seeded.services.map((job) => job.n), lawn);
  assert.equal(seeded.edited, false);
  const goAt = src.indexOf("function go(");
  const goSrc = src.slice(goAt, goAt + 500);
  assert.equal(goSrc.includes("S.services"), false);
  assert.match(src, /svcSwitch\(S\.svcSets/);
});

test("price rows stay with the job they were made under", async () => {
  const { readFile } = await import("fs/promises");
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("const PRESETS=");
  const end = src.indexOf("const TAGS=", start);
  if (start < 0 || end < 0) throw new Error("missing starter jobs");
  const api = runInNewContext(src.slice(start, end) + "({starterServices, svcSwitch, svcRowsOwner, svcSetsClean})");
  const { starterServices, svcSwitch, svcRowsOwner, svcSetsClean } = api;
  const plain = (v) => JSON.parse(JSON.stringify(v)); // cross-realm compare

  // the pilot case: pet rows were edited, then the kid switches to lawn
  const petRows = starterServices("pet", 1);
  petRows[0].p = "9"; // an edited price
  petRows.push({ n: "Walkies deluxe", p: "20" }); // a custom row
  const toLawn = svcSwitch({}, "pet", { services: petRows, edited: true }, "lawn", 1);
  assert.ok(toLawn.services.every((s) => !/dog|pet|poop/i.test(s.n)), "no pet rows on the lawn build");
  assert.equal(toLawn.services[0].n, "Mow a small yard");
  assert.equal(toLawn.edited, false);
  assert.deepEqual(plain(toLawn.sets.pet.services), plain(petRows), "pet rows parked untouched");
  assert.equal(toLawn.sets.pet.edited, true);

  // switching back restores the pet rows exactly, custom row and edit included
  const back = svcSwitch(toLawn.sets, "lawn", { services: toLawn.services, edited: toLawn.edited }, "pet", 1);
  assert.deepEqual(plain(back.services), plain(petRows));
  assert.equal(back.edited, true);
  assert.equal(back.sets.pet, undefined, "the active set is not also parked");

  // a set the kid never edited is seeded fresh at the level that applies now
  const fresh = svcSwitch({ lawn: { services: starterServices("lawn", 1), edited: false } }, "pet", { services: starterServices("pet", 1), edited: false }, "lawn", 5);
  assert.deepEqual(fresh.services, starterServices("lawn", 5));
  assert.equal(fresh.edited, false);

  // a first visit to a job seeds at the applied level
  const firstSnow = svcSwitch({}, "lawn", { services: starterServices("lawn", 1), edited: false }, "snow", 5);
  assert.equal(firstSnow.services[0].p, "15"); // softened curve (Steven, 2026-11-07): L5 = base x1.48

  // parked sets are validated: junk in a saved draft cannot ride along
  assert.deepEqual(plain(svcSetsClean({ nope: { services: [{ n: "X", p: "1" }], edited: true }, pet: { services: "no" }, lawn: { services: [{ n: "Mow", p: 5 }], edited: 1 } })),
    { lawn: { services: [{ n: "Mow", p: "5" }], edited: true } });

  // contaminated-draft detection: whose rows are these, really?
  assert.equal(svcRowsOwner(starterServices("pet", 1), "lawn"), "pet", "pet rows on a lawn build are detected");
  assert.equal(svcRowsOwner(starterServices("pet", 1), "pet"), "", "pet rows on a pet build are home");
  assert.equal(svcRowsOwner(starterServices("lawn", 1), "lawn"), "", "lawn rows on a lawn build are home");
  assert.equal(svcRowsOwner(starterServices("snow", 1), "lawn"), "snow", "snow rows on a lawn build are detected");
  assert.equal(svcRowsOwner([{ n: "Walkies deluxe", p: "20" }, { n: "Thing", p: "5" }], "lawn"), "", "custom names prove nothing");
  assert.equal(svcRowsOwner([{ n: "Dog walk, 15 minutes", p: "5" }], "lawn"), "", "a single row proves nothing");
  const lawnPlusDog = starterServices("lawn", 1).concat([{ n: "Dog walk, 15 minutes", p: "5" }]);
  assert.equal(svcRowsOwner(lawnPlusDog, "lawn"), "", "one menu-added pet row does not move a lawn list");
  assert.equal(svcRowsOwner(starterServices("both", 1), "pet"), "", "a lawn+snow tie proves nothing");

  // the load paths run the repair
  assert.match(src, /fixSvcRows\(\);\nif\(!S\.svcEdited\)/);
  assert.match(src, /if\(!PRESETS\[S\.type\]\)S\.type="lawn";\n  fixSvcRows\(\);/);
});

test("every job type has at least 12 name ideas and funny names", async () => {
  const { readFile } = await import("fs/promises");
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const cut = (from, to) => {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start + from.length);
    if (start < 0 || end < 0) throw new Error("missing " + from);
    return src.slice(start, end);
  };
  const types = ["lawn", "snow", "both", "pet", "odd", "wash", "help", "tutor", "other"];
  runInNewContext(cut("const NAME_IDEAS=", "const TAG_IDEAS=") + cut("const FUNNY=", "let funnyPage=") + `
    const seen = {};
    for (const type of ${JSON.stringify(types)}) {
      const ideas = NAME_IDEAS[type] || [];
      if (ideas.length < 12) throw new Error(type + " has " + ideas.length + " name ideas");
      const plain = ideas.filter((item) => item.indexOf("{F}") < 0 && item.indexOf("{T}") < 0);
      if (plain.length < 12) throw new Error(type + " shows " + plain.length + " names before a first name is typed");
      const page0 = ideas.slice(0, 6);
      const page1 = ideas.slice(6, 12);
      if (page1.length < 6 || page0.join("|") === page1.join("|")) throw new Error(type + " shuffle page is short");
      const funny = FUNNY[type];
      if (!funny || !funny["Keep it simple"]) throw new Error(type + " is missing Keep it simple");
      const jokes = Object.values(funny).reduce((all, list) => all.concat(list), []);
      if (jokes.length < 12) throw new Error(type + " has " + jokes.length + " funny names");
      const norm = (item) => item.toLowerCase().replace(/[{]F[}]/g, "john").replace(/[{]T[}]/g, "lincoln").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "");
      const near = (a, b) => {
        if (!a || !b || a === b) return a === b && !!a;
        const short = a.length < b.length ? a : b;
        const long = a.length < b.length ? b : a;
        if (short.length >= 8 && long.includes(short)) return true;
        const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 0; j <= b.length; j++) rows[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
          for (let j = 1; j <= b.length; j++) {
            rows[i][j] = a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
          }
        }
        return rows[a.length][b.length] / Math.max(a.length, b.length) <= 0.28;
      };
      if ((type === "help" || type === "other") && jokes.length > 15) throw new Error(type + " has " + jokes.length + " funny names");
      for (const joke of jokes) {
        for (const idea of ideas) {
          if (near(norm(joke), norm(idea))) throw new Error(type + " overlaps: " + joke + " / " + idea);
        }
        const key = norm(joke);
        if (seen[key]) throw new Error(type + " duplicates " + seen[key] + ": " + joke);
        seen[key] = type;
      }
    }
    if (FUNNY.help["Keep it simple"].indexOf("Mother\u2019s Little Helper") < 0) throw new Error("helper puns missing");
    if (FUNNY.other["Keep it simple"].indexOf("Jack of All Trades") < 0) throw new Error("something else puns missing");
    const helperJokes = Object.values(FUNNY.help).reduce((all, list) => all.concat(list), []);
    if (FUNNY.odd["Puns"].indexOf("Helping Handful") >= 0 || helperJokes.indexOf("Helping Handful") >= 0) throw new Error("Helping Handful is still shared");
  `, {}, { timeout: 1000 });
});

test("three reports hide a page until an admin restores it", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam Yard") } });
  const live = await call("GET", "/api/site/sam-yard");
  assert.match(live.body, /Report this page/);
  assert.equal(live.body.includes(email), false);
  const form = await call("GET", "/api/report/sam-yard");
  assert.match(form.body, /It is not a real kid business/);
  assert.match(form.body, /You do not need an account/);
  const send = async (ip, reason) => json(await call("POST", "/api/report", {
    headers: { "x-forwarded-for": ip },
    body: { slug: "sam-yard", reason, details: "please look" }
  }));
  const first = await send("1.1.1.1", "fake");
  assert.equal(first.body.reports, 1);
  assert.equal(first.body.status, "live");
  const again = await send("1.1.1.1", "fake");
  assert.equal(again.body.reports, 1);
  await send("2.2.2.2", "personal");
  const third = await send("3.3.3.3", "unsafe");
  assert.equal(third.body.status, "review");
  const hidden = await call("GET", "/api/site/sam-yard");
  assert.match(hidden.body, /Hidden for now/);
  assert.equal(hidden.body.includes(email), false);
  await send("4.4.4.4", "other");
  const parentMail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(parentMail.body.messages.filter((m) => /hid the page/.test(m.subject)).length, 1);
  const support = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent("support@hustlebuilder.org")));
  assert.ok(support.body.messages.length >= 3);
  assert.match(support.body.messages[0].text, /please look/);
  const denied = await json(await call("POST", "/api/admin/restore", { headers: { "x-admin-secret": "nope" }, body: { slug: "sam-yard" } }));
  assert.equal(denied.status, 401);
  const restored = await json(await call("POST", "/api/admin/restore", { headers: { "x-admin-secret": "test-admin-secret" }, body: { slug: "sam-yard" } }));
  assert.equal(restored.body.status, "live");
  const back = await call("GET", "/api/site/sam-yard");
  assert.match(back.body, /Sam Yard/);
});

test("a parent can rename the web address and the old link redirects", async () => {
  const { token } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam Yard") } });
  const bad = await json(await call("POST", "/api/slug", { token, body: { slug: "sam-smith" } }));
  assert.equal(bad.body.error, "slug");
  const renamed = await json(await call("POST", "/api/slug", { token, body: { slug: "sam-mow" } }));
  assert.equal(renamed.body.ok, true);
  assert.equal(renamed.body.slug, "sam-mow");
  const days = (Date.parse(renamed.body.until) - Date.now()) / 864e5;
  assert.ok(days > 89 && days < 91);
  const old = await call("GET", "/api/site/sam-yard");
  assert.equal(old.status, 302);
  assert.equal(old.headers.location, "/sam-mow");
  const live = await call("GET", "/api/site/sam-mow");
  assert.equal(live.status, 200);
  assert.match(live.body, /Sam Yard/);
  const free = await json(await call("GET", "/api/slug?name=sam-yard"));
  assert.equal(free.body.available, false);
  const second = await json(await call("POST", "/api/slug", { token, body: { slug: "sam-work" } }));
  assert.equal(second.body.ok, true);
  const third = await json(await call("POST", "/api/slug", { token, body: { slug: "sam-jobs" } }));
  assert.equal(third.body.ok, true);
  const limited = await json(await call("POST", "/api/slug", { token, body: { slug: "sam-crew" } }));
  assert.equal(limited.status, 429);
  const still = await call("GET", "/api/site/sam-yard");
  assert.equal(still.status, 302);
  assert.equal(still.headers.location, "/sam-jobs");
  const other = await parent("other@example.com");
  await call("POST", "/api/consent", { token: other.token, body: { consent: true } });
  await call("POST", "/api/publish", { token: other.token, body: { slug: "ada-yard", html: page("Ada") } });
  const taken = await json(await call("POST", "/api/slug", { token, body: { slug: "ada-yard" } }));
  assert.equal(taken.status, 409);
});

test("the home screen app can install and keep the builder offline", async () => {
  const { readFile } = await import("fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.theme_color, "#FF5B14");
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable" && icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable" && icon.sizes === "512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "any" && icon.sizes === "512x512"));
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(sw, /hustle-shell-2/);
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /rel="manifest"/);
  assert.match(html, /You’re offline\. You can keep editing here\./);
  assert.match(html, /serviceWorker\.register\("\/sw\.js"\)/);
  const icon = await readFile(new URL("../icons/icon-192.png", import.meta.url));
  assert.equal(icon[0], 137);
  const mask = await readFile(new URL("../icons/maskable-512.png", import.meta.url));
  assert.equal(mask[0], 137);
});

test("going live and paying each send one email", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const html = page("Sam");
  const first = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html } }));
  assert.equal(first.body.ok, true);
  await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html } });
  const liveBox = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const live = liveBox.body.messages.filter((m) => m.subject === "Your page is live");
  assert.equal(live.length, 1);
  assert.match(live[0].text, /http:\/\/sites\.test\/sam-yard/);
  assert.match(live[0].text, /Print a flyer/);
  assert.match(live[0].text, /Share the link/);
  assert.match(live[0].html, /api\/qr\/sam-yard\.png/);
  assert.match(live[0].text, /\/\?account=1/);
  const qr = await call("GET", "/api/qr/sam-yard.png");
  assert.equal(qr.body[0], 137);
  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(pay.body.ok, true);
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  const receipts = box.body.messages.filter((m) => m.subject === "Your Hustle Builder receipt");
  assert.equal(receipts.length, 1);
  assert.match(receipts[0].text, /\$9\.99/);
  assert.match(receipts[0].text, /Through /);
  assert.match(receipts[0].text, /\/\?account=1/);
  assert.equal(receipts[0].text.includes("steve@"), false);
});

test("a repeated year webhook does not extend the plan or send another receipt", async () => {
  const { token, email } = await parent("year@example.com");
  const { readFile, readdir, writeFile } = await import("fs/promises");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "year-yard", html: page("Year") } });
  const names = await readdir(dir + "/accounts");
  const file = dir + "/accounts/" + names[0];
  const account = JSON.parse(await readFile(file, "utf8"));
  account.slug = "year-mow";
  await writeFile(file, JSON.stringify(account));
  await writeFile(dir + "/pages/year-mow.html", page("Year"));
  await writeFile(dir + "/pages/year-mow.json", JSON.stringify({ slug: "year-mow", accountId: account.id, status: "live" }));
  await call("POST", "/api/publish", { token, body: { slug: "year-mow", html: page("Year") } });
  const moved = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(moved.body.messages.filter((m) => m.subject === "Your new web address is live").length, 1);
  assert.equal(moved.body.messages.filter((m) => m.subject === "Your page is live").length, 1);
  const payload = JSON.stringify({ id: "evt_year_once", type: "checkout.session.completed", data: { object: await pendingSession(account.id,"year","cs_year_once") } });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_year";
  const t = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", "whsec_year").update(t + "." + payload).digest("hex");
  const headers = { "stripe-signature": "t=" + t + ",v1=" + sig };
  const first = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers }));
  assert.equal(first.body.ok, true);
  const paidUntil = (await json(await call("GET", "/api/me", { token }))).body.paidUntil;
  const old = String(Math.floor(Date.now() / 1000) - 10 * 60);
  const oldSig = createHmac("sha256", "whsec_year").update(old + "." + payload).digest("hex");
  const stale = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers: { "stripe-signature": "t=" + old + ",v1=" + oldSig } }));
  assert.equal(stale.status, 400);
  const again = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers }));
  assert.equal(again.body.duplicate, true);
  const after = await json(await call("GET", "/api/me", { token }));
  assert.equal(after.body.paidUntil, paidUntil);
  assert.equal(after.body.plan, "year");
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(box.body.messages.filter((m) => m.subject === "Your Hustle Builder receipt").length, 1);
  assert.match(box.body.messages.find((m) => m.subject === "Your Hustle Builder receipt").text, /\$19\.99/);
});

test("a backup preview names every business type", async () => {
  const { readFile } = await import("fs/promises");
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("function workLabel(");
  const end = src.indexOf("function openBackup(", start);
  if (start < 0 || end < 0) throw new Error("missing work label");
  const workLabel = runInNewContext(src.slice(start, end) + "workLabel");
  const expect = {
    lawn: "Lawn",
    snow: "Snow",
    both: "Lawn and snow",
    pet: "Pet care",
    wash: "Car wash",
    odd: "Odd jobs",
    help: "Parent\u2019s helper",
    tutor: "Reading buddy",
    other: "Something else"
  };
  for (const [type, label] of Object.entries(expect)) {
    assert.equal(workLabel(type), label);
  }
  assert.equal(src.includes('b.type==="snow"?"Snow":b.type==="both"?"Lawn and snow":"Lawn"'), false);
  assert.match(src, /workLabel\(b\.type\)/);
});

test("a parent account lists the site, trial, receipts, and requests", async () => {
  const { token, email } = await parent();
  const codeMail = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.match(codeMail.body.messages[0].text, /\/\?account=1/);
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(pay.body.ok, true);
  await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam") } });
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam-yard", name: "Riley", contact: "402-555-0199", service: "Mow the yard", when: "Saturday morning",
    address: "12 Oak", start: "2026-11-07T10:00", t: 4000
  } }));
  assert.equal(book.body.ok, true);
  const account = await json(await call("GET", "/api/account", { token }));
  assert.equal(account.body.ok, true);
  assert.equal(account.body.sites.length, 1);
  const site = account.body.sites[0];
  assert.equal(site.slug, "sam-yard");
  assert.equal(site.plan, "season");
  assert.match(site.planName, /Summer|Winter|season/i);
  assert.ok(site.paidUntil);
  assert.ok(site.receipts.length >= 1);
  assert.match(site.receipts[0].url, /\/api\/receipt\//);
  assert.equal(site.receipts[0].amount, "$9.99");
  assert.equal(site.requests[0].service, "Mow the yard");
  assert.equal(site.requests[0].firstName, "Riley");
  assert.equal(site.requests[0].address, undefined);
  const receipt = await call("GET", site.receipts[0].url.replace("http://sites.test", ""));
  assert.match(receipt.body, /\$9\.99/);
  assert.equal(receipt.body.includes(email), false);
  const paused = await json(await call("POST", "/api/account/pause", { token, body: { slug: "sam-yard" } }));
  assert.equal(paused.body.status, "paused");
  const hidden = await call("GET", "/api/site/sam-yard");
  assert.equal(hidden.status, 200);
  assert.match(hidden.body, /Paused for now/);
  assert.equal(hidden.body.includes(email), false);
  await call("POST", "/api/publish", { token, body: { slug: "sam-yard", html: page("Sam again") } });
  const stillPaused = await call("GET", "/api/site/sam-yard");
  assert.match(stillPaused.body, /Paused for now/);
  const back = await json(await call("POST", "/api/account/resume", { token, body: { slug: "sam-yard" } }));
  assert.equal(back.body.status, "live");
  const again = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(again.body.alreadyPaid, true);
  const still = await json(await call("GET", "/api/account", { token }));
  assert.equal(still.body.sites[0].receipts.length, 1);
  const stranger = await json(await call("GET", "/api/account"));
  assert.equal(stranger.status, 401);
});

test("verify sets an HttpOnly session cookie and the cookie alone signs in", async () => {
  const email = "cookie@example.com";
  const start = await json(await call("POST", "/api/auth/start", { body: { email } }));
  assert.equal(start.body.ok, true);
  const verifyRes = await call("POST", "/api/auth/verify", { body: { email, code: start.body.devCode } });
  const verify = await json(verifyRes);
  assert.equal(verify.body.ok, true);
  const setCookie = verifyRes.headers["set-cookie"] || "";
  assert.match(setCookie, new RegExp("hb_session=" + verify.body.token));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=15552000/);
  const cookie = "hb_session=" + verify.body.token;
  const me = await json(await call("GET", "/api/me", { headers: { cookie } }));
  assert.equal(me.body.ok, true);
  assert.equal(me.body.email, email);
  const consent = await json(await call("POST", "/api/consent", { headers: { cookie }, body: { consent: true } }));
  assert.equal(consent.body.ok, true);
  const pub = await json(await call("POST", "/api/publish", { headers: { cookie }, body: { slug: "cookie-kid", html: page("Cookie") } }));
  assert.equal(pub.status, 200);
  assert.equal(pub.body.ok, true);
});

test("a verified parent stays signed in after reload until the session expires, without consent", async () => {
  const email = "reload@example.com";
  const start = await json(await call("POST", "/api/auth/start", { body: { email } }));
  const verifyRes = await call("POST", "/api/auth/verify", { body: { email, code: start.body.devCode } });
  const verify = await json(verifyRes);
  assert.equal(verify.body.ok, true);
  assert.equal(verify.body.consent, false);
  const cookie = "hb_session=" + verify.body.token;
  const again = await json(await call("GET", "/api/me", { headers: { cookie } }));
  assert.equal(again.body.ok, true);
  assert.equal(again.body.verified, true);
  assert.equal(again.body.consent, false);
  assert.equal(again.body.email, email);
  const blocked = await json(await call("POST", "/api/publish", { headers: { cookie }, body: { slug: "reload-kid", html: page("Reload") } }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, "consent");
  const files = await readdir(path.join(dir, "accounts"));
  const file = path.join(dir, "accounts", files[0]);
  const account = JSON.parse(await readFile(file, "utf8"));
  assert.ok(Number(account.sessionExpiresAt) > Date.now());
  account.sessionExpiresAt = Date.now() - 1000;
  await writeFile(file, JSON.stringify(account));
  const expired = await json(await call("GET", "/api/me", { headers: { cookie } }));
  assert.equal(expired.status, 401);
  const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(home, /function showParentVerified/);
  assert.match(home, /if\(me\.verified\)showParentVerified\(me\)/);
  assert.match(home, /delete keep\.token/);
  assert.equal(home.includes("localStorage.setItem(PUB_KEY,JSON.stringify(s))"), false);
});

test("Bearer tokens still work during the cookie transition", async () => {
  const { token } = await parent("bearer@example.com");
  const me = await json(await call("GET", "/api/me", { token }));
  assert.equal(me.body.ok, true);
  const both = await json(await call("GET", "/api/me", { token: "0".repeat(64), headers: { cookie: "hb_session=" + token } }));
  assert.equal(both.body.ok, true);
  const stale = await json(await call("GET", "/api/me", { token, headers: { cookie: "hb_session=" + "f".repeat(64) } }));
  assert.equal(stale.body.ok, true);
  assert.equal(stale.body.email, "bearer@example.com");
});

test("ask open cannot mint a cookie or bearer credential without independent verification", async()=>{
  const sent=await json(await call('POST','/api/ask',{body:{email:'dad@example.com',draft:{first:'Sam'}}}));
  const response=await call('POST','/api/ask/'+sent.body.token+'/open',{body:{}});
  const opened=await json(response);
  assert.equal(opened.body.requiresVerification,true);
  assert.equal(opened.body.token,undefined);assert.equal(response.headers['set-cookie'],undefined);
  assert.equal((await json(await call('GET','/api/me'))).status,401);
});

test("logout clears the cookie and ends the session everywhere", async () => {
  const { token } = await parent("bye@example.com");
  const cookie = "hb_session=" + token;
  const outRes = await call("POST", "/api/auth/logout", { headers: { cookie }, body: {} });
  const out = await json(outRes);
  assert.equal(out.body.ok, true);
  const cleared = outRes.headers["set-cookie"] || "";
  assert.match(cleared, /hb_session=;/);
  assert.match(cleared, /Max-Age=0/);
  const meCookie = await json(await call("GET", "/api/me", { headers: { cookie } }));
  assert.equal(meCookie.status, 401);
  const meBearer = await json(await call("GET", "/api/me", { token }));
  assert.equal(meBearer.status, 401);
});

test("published pages carry a Content-Security-Policy, the builder API does not", async () => {
  const { token } = await parent("csp@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "csp-kid", html: page("Csp Kid") } }));
  assert.equal(pub.status, 200);
  const live = await call("GET", "/api/site/csp-kid");
  assert.equal(live.status, 200);
  assert.match(live.body, /Csp Kid/);
  const csp = live.headers["content-security-policy"] || "";
  assert.match(csp,/sandbox allow-scripts/);assert.doesNotMatch(csp,/allow-same-origin/);assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(csp, /script-src[^;]*https:/);
  assert.match(csp,/connect-src http:\/\/sites\.test\/api\/book/);
  assert.match(csp,/img-src http:\/\/sites\.test data: blob:/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp,/font-src data:/);
  assert.match(csp,/form-action 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const plans = await call("GET", "/api/plans");
  assert.equal(plans.headers["content-security-policy"], undefined);
});

test("admin view gates on the secret and lists accounts without private details", async () => {
  // A trial family with a published page whose config carries a kid name,
  // a business name, and a phone number that must never reach the dashboard.
  const trial = await parent("admin-trial@example.com");
  await call("POST", "/api/consent", { token: trial.token, body: { consent: true } });
  const cfgPage = `<!DOCTYPE html><html><head><title>Green Guys Lawn Care</title></head><body><!-- hb-public --><h1>Green Guys Lawn Care</h1><script>window.__C={"first":"Sam","biz":"Green Guys Lawn Care","phoneDigits":"4025551234"};</script></body></html>`;
  const pub = await json(await call("POST", "/api/publish", { token: trial.token, body: { slug: "sam-mows", html: cfgPage, cardTitle: "Card Title Biz" } }));
  assert.equal(pub.status, 200);
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam-mows", name: "Riley", contact: "402-555-0199", service: "Mow", when: "Monday at 4:00 PM",
    address: "999 Secret Lane", note: "Gate code 4321", start: "2026-11-16T16:00", t: 5000
  } }));
  assert.equal(book.body.ok, true);
  // A paid family.
  const paidParent = await parent("admin-paid@example.com");
  await call("POST", "/api/consent", { token: paidParent.token, body: { consent: true } });
  await call("POST", "/api/checkout", { token: paidParent.token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token: paidParent.token, body: { slug: "cleo-lawns", html: page("Cleo") } });
  // A verified parent who never published, and one who only asked for a code.
  await parent("admin-draft@example.com");
  await call("POST", "/api/auth/start", { body: { email: "admin-waiting@example.com" } });

  const gate = await call("GET", "/admin");
  assert.equal(gate.status, 200);
  assert.match(gate.body, /Admin password/);
  assert.equal(gate.body.includes("admin-trial@example.com"), false);
  assert.equal(gate.body.includes("Green Guys"), false);

  const bad = await call("POST", "/admin/login", { raw: "secret=wrong" });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);

  const good = await call("POST", "/admin/login", { raw: "secret=test-admin-secret" });
  assert.equal(good.status, 302);
  assert.equal(good.headers.location, "/admin");
  const setCookie = good.headers["set-cookie"] || "";
  assert.match(setCookie, /hb_admin=[a-f0-9]{64}/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/admin/);
  const cookie = setCookie.split(";")[0];

  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.equal(dash.status, 200);
  assert.match(dash.body, />4<\/div><div>Accounts</);
  assert.match(dash.body, />1<\/div><div>Bookings stored</);
  assert.match(dash.body, /Green Guys Lawn Care/);
  assert.match(dash.body, />Sam</);
  assert.match(dash.body, /\/sam-mows/);
  assert.match(dash.body, /admin-trial@example\.com/);
  assert.match(dash.body, /Free trial/);
  assert.match(dash.body, /admin-paid@example\.com/);
  assert.match(dash.body, /Paid/);
  assert.match(dash.body, /Cleo/);
  assert.match(dash.body, /admin-draft@example\.com/);
  assert.match(dash.body, /Draft/);
  assert.match(dash.body, /admin-waiting@example\.com/);
  assert.match(dash.body, /Awaiting parent/);
  // The page config's phone, the customer's name, address, and gate note stay out.
  assert.equal(dash.body.includes("4025551234"), false);
  assert.equal(dash.body.includes("Riley"), false);
  assert.equal(dash.body.includes("999 Secret Lane"), false);
  assert.equal(dash.body.includes("4321"), false);

  const out = await call("POST", "/admin/logout", { headers: { cookie } });
  assert.equal(out.status, 302);
  assert.match(out.headers["set-cookie"] || "", /Max-Age=0/);
  const after = await call("GET", "/admin", { headers: { cookie } });
  assert.match(after.body, /Admin password/);
  assert.equal(after.body.includes("admin-trial@example.com"), false);
});

test("admin login is limited to ten tries an hour per address", async () => {
  for (let i = 0; i < 10; i++) {
    const res = await call("POST", "/admin/login", { raw: "secret=wrong-" + i });
    assert.equal(res.status, 401);
  }
  const over = await call("POST", "/admin/login", { raw: "secret=test-admin-secret" });
  assert.equal(over.status, 429);
  assert.equal(over.headers["set-cookie"], undefined);
});

async function adminCookie() {
  const good = await call("POST", "/admin/login", { raw: "secret=" + "test-admin-secret" });
  assert.equal(good.status, 302);
  return (good.headers["set-cookie"] || "").split(";")[0];
}

test("friends & family comp: the admin grants it, the page stays up, and no reminder ever queues", async () => {
  const { token, email } = await parent("comp@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "comp-kid", html: page("Comp Kid") } }));
  assert.equal(pub.status, 200);
  const account = await patchAccount((a) => {
    a.trialStartedAt = new Date(Date.now() - 30 * 864e5).toISOString();
    a.trialEndsAt = new Date(Date.now() - 864e5).toISOString();
  });
  // The trial is long over: the page rests and the payload says so.
  const resting = await call("GET", "/api/site/comp-kid");
  assert.match(resting.body, /Taking a break/);
  const before = await json(await call("GET", "/api/me", { token }));
  assert.equal(before.body.comp, false);
  assert.equal(before.body.trialOver, true);

  // Without the admin session the grant endpoint changes nothing.
  const denied = await call("POST", "/admin/comp", { raw: "id=" + account.id + "&on=1" });
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.location, "/admin");
  const stillOff = await json(await call("GET", "/api/me", { token }));
  assert.equal(stillOff.body.comp, false);

  // The operator grants the comp from the dashboard.
  const cookie = await adminCookie();
  const grant = await call("POST", "/admin/comp", { raw: "id=" + account.id + "&on=1", headers: { cookie } });
  assert.equal(grant.status, 302);
  assert.equal(grant.headers.location, "/admin");
  const after = await json(await call("GET", "/api/me", { token }));
  assert.equal(after.body.comp, true);
  assert.equal(after.body.paid, true);
  assert.equal(after.body.planName, "Friends & family");
  assert.equal(after.body.trialOver, false);
  assert.equal(after.body.grace, false);
  const acct = await json(await call("GET", "/api/account", { token }));
  assert.equal(acct.body.sites[0].comp, true);
  assert.equal(acct.body.sites[0].planName, "Friends & family");

  // The page is back on its feet on the very next serve.
  const live = await call("GET", "/api/site/comp-kid");
  assert.equal(live.status, 200);
  assert.match(live.body, /Comp Kid/);
  assert.equal(live.body.includes("Taking a break"), false);

  // Checkout resolves as already covered and stamps no paid plan.
  const checkout = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(checkout.body.ok, true);
  assert.equal(checkout.body.alreadyPaid, true);
  const saved = JSON.parse(await readFile(path.join(dir, "accounts", account.id + ".json"), "utf8"));
  assert.equal(saved.comp, true);
  assert.ok(saved.compAt);
  assert.equal(saved.paidUntil || "", "");

  // The dashboard names the comp and offers the way back.
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.match(dash.body, />1<\/div><div>Free</);
  assert.match(dash.body, /Free \(friends &amp; family\)/);
  assert.match(dash.body, /Remove free/);
  assert.match(dash.body, new RegExp('name="id" value="' + account.id + '"'));

  // No renewal or trial reminder ever queues for this account, whichever
  // clock the cron looks at: a paid date three days out (paid loop) and
  // a trial end three days out (trial loop) both pass it by.
  await patchAccount((a) => {
    a.paidUntil = new Date(Date.now() + 3 * 864e5).toISOString();
    a.trialEndsAt = new Date(Date.now() + 3 * 864e5).toISOString();
  });
  const secret = { authorization: "Bearer " + "test-admin-secret" };
  const dry = await json(await call("GET", "/api/cron/renewals?dry=1", { headers: secret }));
  assert.equal(dry.body.due.some((d) => d.email === email), false);
  const sent = await json(await call("GET", "/api/cron/renewals", { headers: secret }));
  assert.equal(sent.body.due.some((d) => d.email === email), false);
  const outbox = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.equal(outbox.body.messages.some((m) => /ends|Renew/.test(m.subject || "")), false);

  // Revoking hands the account back to its dates: the break returns.
  const revoke = await call("POST", "/admin/comp", { raw: "id=" + account.id + "&on=0", headers: { cookie } });
  assert.equal(revoke.status, 302);
  await patchAccount((a) => {
    delete a.paidUntil;
    a.trialEndsAt = new Date(Date.now() - 864e5).toISOString();
  });
  const revoked = await json(await call("GET", "/api/me", { token }));
  assert.equal(revoked.body.comp, false);
  const restingAgain = await call("GET", "/api/site/comp-kid");
  assert.match(restingAgain.body, /Taking a break/);
});

test("a comped account in the dashboard shows Free in the summary and its row", async () => {
  const { token } = await parent("comp-dash@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "comp-dash", html: page("Comp Dash") } });
  await patchAccount((a) => { a.comp = true; a.compAt = new Date().toISOString(); });
  const cookie = await adminCookie();
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.equal(dash.status, 200);
  assert.match(dash.body, />1<\/div><div>Free</);
  assert.match(dash.body, /Free \(friends &amp; family\)/);
  assert.match(dash.body, /comp-dash@example\.com/);
  // The comped row's own button offers the way back, not another grant.
  assert.match(dash.body, /Remove free/);
  assert.match(dash.body, /name="on" value="0"/);
  assert.equal(dash.body.includes('name="on" value="1"'), false);
});

test("page views count strangers, not the family, the operator, or bots", async () => {
  const { token } = await parent("views@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
  assert.equal(pub.status, 200);

  const browser = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };
  // Two neighbors open the page.
  assert.equal((await call("GET", "/api/site/sam", { headers: browser })).status, 200);
  assert.equal((await call("GET", "/api/site/sam", { headers: browser })).status, 200);
  // The family's own checks of the page do not count, by Bearer or by cookie.
  await call("GET", "/api/site/sam", { token, headers: browser });
  await call("GET", "/api/site/sam", { headers: { ...browser, cookie: "hb_session=" + token } });
  // Crawlers and link previews do not count.
  await call("GET", "/api/site/sam", { headers: { "user-agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" } });
  await call("GET", "/api/site/sam", { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } });
  await call("GET", "/api/site/sam", { headers: { "user-agent": "Twitterbot/1.0" } });
  // The operator, signed in to the admin view, does not count either.
  const login = await call("POST", "/admin/login", { raw: "secret=test-admin-secret" });
  assert.equal(login.status, 302);
  const adminCookie = (login.headers["set-cookie"] || "").split(";")[0];
  await call("GET", "/api/site/sam", { headers: { ...browser, cookie: adminCookie } });

  const mine = await json(await call("GET", "/api/views", { token }));
  assert.equal(mine.body.ok, true);
  assert.equal(mine.body.slug, "sam");
  assert.equal(mine.body.total, 2);
  assert.equal(mine.body.last7, 2);

  // The stored record is only counts: a total and day buckets, nothing else.
  const stored = JSON.parse(await readFile(path.join(dir, "views", "sam.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["days", "total"]);
  assert.equal(stored.total, 2);
  assert.equal(Object.values(stored.days).reduce((a, b) => a + b, 0), 2);

  // Signed out, there is no count to read; another family reads only its own.
  const stranger = await json(await call("GET", "/api/views"));
  assert.equal(stranger.status, 401);
  const other = await parent("views-other@example.com");
  const theirs = await json(await call("GET", "/api/views", { token: other.token }));
  assert.equal(theirs.body.ok, true);
  assert.equal(theirs.body.total, 0);
});

test("resting and missing pages do not count, and the week sum reads day buckets", async () => {
  const { token } = await parent("views-week@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "cleo", html: page("Cleo") } });
  const browser = { "user-agent": "Mozilla/5.0 (Android 15; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0" };
  await call("GET", "/api/site/cleo", { headers: browser });
  // Pause the page: neighbors now see the pause note, and those loads do not count.
  const paused = await json(await call("POST", "/api/account/pause", { token, body: { slug: "cleo" } }));
  assert.equal(paused.body.ok, true);
  await call("GET", "/api/site/cleo", { headers: browser });
  await call("GET", "/api/site/cleo", { headers: browser });
  // A slug that was never published has nothing to count.
  assert.equal((await call("GET", "/api/site/no-such-kid", { headers: browser })).status, 404);
  const mine = await json(await call("GET", "/api/views", { token }));
  assert.equal(mine.body.total, 1);
  assert.equal(mine.body.last7, 1);

  // Seed day buckets: the week is today plus the six days before it, and a
  // fresh view prunes buckets older than the kept window.
  const dayMs = 864e5, now = Date.now();
  const key = (t) => new Date(t).toISOString().slice(0, 10);
  const days = {};
  days[key(now)] = 1;
  days[key(now - 3 * dayMs)] = 4;
  days[key(now - 6 * dayMs)] = 5;
  days[key(now - 7 * dayMs)] = 7;
  days[key(now - 40 * dayMs)] = 9;
  await mkdir(path.join(dir, "views"), { recursive: true });
  await writeFile(path.join(dir, "views", "cleo.json"), JSON.stringify({ total: 26, days }));
  const week = await json(await call("GET", "/api/views", { token }));
  assert.equal(week.body.total, 26);
  assert.equal(week.body.last7, 10);

  const resumed = await json(await call("POST", "/api/account/resume", { token, body: { slug: "cleo" } }));
  assert.equal(resumed.body.ok, true);
  await call("GET", "/api/site/cleo", { headers: browser });
  const stored = JSON.parse(await readFile(path.join(dir, "views", "cleo.json"), "utf8"));
  assert.equal(stored.total, 27);
  assert.equal(stored.days[key(now)], 2);
  assert.equal(stored.days[key(now - 40 * dayMs)], undefined);
});

test("funnel counts stay aggregate and show on the admin page", async () => {
  const bad = await json(await call("POST", "/api/funnel", { body: { event: "published" } }));
  assert.equal(bad.status, 400);
  const visit = await json(await call("POST", "/api/funnel", { body: { event: "ref_visit" } }));
  assert.equal(visit.body.ok, true);
  const { token } = await parent("funnel@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "funnel-yard", html: page("Funnel") } });
  await call("POST", "/api/draft", { token, body: { draft: { first: "Sam" } } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  const login = await call("POST", "/admin/login", { raw: "secret=test-admin-secret", headers: { "x-forwarded-for": "198.51.100.44" } });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.match(dash.body, /Card check passed/);
  assert.match(dash.body, /Published/);
  assert.match(dash.body, /Plan paid/);
  assert.match(dash.body, /Referral visit/);
  assert.equal(dash.body.includes("funnel/"), false);
});

test("live pages are served with one Built with Hustle Builder belt, added at serve time", async () => {
  const { token } = await parent("belt@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "belt-kid", html: page("Belt Kid") } }));
  assert.equal(pub.status, 200);

  const first = await call("GET", "/api/site/belt-kid");
  assert.equal(first.status, 200);
  // Exactly one belt, linking home, after the page's own content and
  // still inside the body.
  assert.equal(first.body.split('id="hb-belt"').length - 1, 1);
  assert.ok(first.body.includes('Make one for your kid, free for 14 days'));
  assert.ok(first.body.includes('<a href="https://hustlebuilder.org/?for=parents&amp;ref=belt-kid" target="_top"') || first.body.includes('<a href="https://hustlebuilder.org/?for=parents&ref=belt-kid" target="_top"'));
  assert.ok(first.body.indexOf('id="hb-belt"') > first.body.indexOf("<h1>Belt Kid</h1>"));
  assert.ok(first.body.indexOf('id="hb-belt"') < first.body.toLowerCase().indexOf("</body>"));
  // The family's own words are untouched.
  assert.ok(first.body.includes("<p>Student-owned. Parent-backed.</p>"));

  // Serving again does not stack a second belt...
  const second = await call("GET", "/api/site/belt-kid");
  assert.equal(second.body.split('id="hb-belt"').length - 1, 1);
  // ...because the belt is added at serve time only: the page stored on
  // disk is byte-for-byte what the family published, with no belt in it.
  const stored = await readFile(path.join(dir, "pages", "belt-kid.html"), "utf8");
  assert.equal(stored.includes("hb-belt"), false);
});

test("resting, missing, and already-belted pages get no second belt", async () => {
  const { token } = await parent("belt2@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "belt-rest", html: page("Belt Rest") } });

  // Pause the page: neighbors see the pause note, and it carries no belt.
  const paused = await json(await call("POST", "/api/account/pause", { token, body: { slug: "belt-rest" } }));
  assert.equal(paused.body.ok, true);
  const rest = await call("GET", "/api/site/belt-rest");
  assert.equal(rest.status, 200);
  assert.equal(rest.body.includes("hb-belt"), false);

  // A slug that was never published has no belt either.
  const missing = await call("GET", "/api/site/no-such-kid");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.includes("hb-belt"), false);

  // A page whose stored HTML already carries the marker (say it was baked
  // in by some future publisher) is served as stored, never double-belted.
  const other = await parent("belt3@example.com");
  await call("POST", "/api/consent", { token: other.token, body: { consent: true } });
  const baked = page("Belt Baked").replace("</body>", '<div id="hb-belt">already here</div></body>');
  const pub = await json(await call("POST", "/api/publish", { token: other.token, body: { slug: "belt-baked", html: baked } }));
  assert.equal(pub.status, 200);
  const served = await call("GET", "/api/site/belt-baked");
  assert.equal(served.body.split('id="hb-belt"').length - 1, 1);
  assert.ok(served.body.includes("already here"));
});

test("admin view flags a page still wired to a legacy Apps Script inbox", async () => {
  // A family whose page dates from when bookings ran through their own
  // Google Apps Script inbox: the config embedded in the page carries the
  // inbox object instead of null.
  const legacy = await parent("legacy-flag@example.com");
  await call("POST", "/api/consent", { token: legacy.token, body: { consent: true } });
  const legacyPage = `<!DOCTYPE html><html><head><title>Legacy Lawn Co</title></head><body><!-- hb-public --><h1>Legacy Lawn Co</h1><script>window.__C={"first":"Lee","biz":"Legacy Lawn Co","inbox":{"url":"https://script.google.com/macros/s/AKfycbxTEST123/exec","key":"testkey"}};</script></body></html>`;
  const pubLegacy = await json(await call("POST", "/api/publish", { token: legacy.token, body: { slug: "legacy-lawn", html: legacyPage } }));
  assert.equal(pubLegacy.status, 200);
  // A family on today's hosted booking: the same spot in the config is null.
  const modern = await parent("modern-flag@example.com");
  await call("POST", "/api/consent", { token: modern.token, body: { consent: true } });
  const modernPage = `<!DOCTYPE html><html><head><title>Modern Mowing</title></head><body><!-- hb-public --><h1>Modern Mowing</h1><script>window.__C={"first":"Mo","biz":"Modern Mowing","inbox":null};</script></body></html>`;
  const pubModern = await json(await call("POST", "/api/publish", { token: modern.token, body: { slug: "modern-lawn", html: modernPage } }));
  assert.equal(pubModern.status, 200);

  const cookie = await adminCookie();
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.equal(dash.status, 200);
  // The summary counts the one legacy page, and exactly one badge is drawn.
  assert.match(dash.body, />1<\/div><div>Legacy inbox</);
  assert.equal((dash.body.match(/background:#fde68a/g) || []).length, 1);
  // The badge sits on the legacy page's own row, not the modern family's.
  const rows = dash.body.split("<tr>");
  const legacyRow = rows.find((r) => r.includes("/legacy-lawn")) || "";
  const modernRow = rows.find((r) => r.includes("/modern-lawn")) || "";
  assert.match(legacyRow, />Legacy inbox<\/span>/);
  assert.equal(modernRow.includes("Legacy inbox"), false);
  // Both families are otherwise listed as usual.
  assert.match(dash.body, /legacy-flag@example\.com/);
  assert.match(dash.body, /modern-flag@example\.com/);
});

test("admin view shows a zero legacy-inbox count when no page carries one", async () => {
  const { token } = await parent("zero-flag@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const cleanPage = `<!DOCTYPE html><html><head><title>Clean Cuts</title></head><body><!-- hb-public --><h1>Clean Cuts</h1><script>window.__C={"first":"Cl","biz":"Clean Cuts","inbox":null};</script></body></html>`;
  const pub = await json(await call("POST", "/api/publish", { token, body: { slug: "clean-cuts", html: cleanPage } }));
  assert.equal(pub.status, 200);
  const cookie = await adminCookie();
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.equal(dash.status, 200);
  // The tile is always there so a clean board visibly reads zero.
  assert.match(dash.body, />0<\/div><div>Legacy inbox</);
  assert.equal(dash.body.includes(">Legacy inbox</span>"), false);
});

/* ---- page reskins: the theme system inside index.html's genSite ---- */
function extractBuilderParts(src, fontData) {
  const lines = src.split("\n");
  const extractFn = (name) => {
    const start = lines.findIndex((l) => new RegExp("^(async )?function " + name + "\\b").test(l));
    if (start < 0) return null;
    let depth = 0, begun = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; begun = true; }
        else if (ch === "}") { depth--; if (begun && depth === 0) return lines.slice(start, i + 1).join("\n"); }
      }
    }
    return null;
  };
  const extractConst = (name) => {
    const start = lines.findIndex((l) => new RegExp("^(const|let|var) " + name + "\\b").test(l));
    if (start < 0) return null;
    let depth = 0, seen = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if ("{[(".includes(ch)) { depth++; seen = true; } if ("}])".includes(ch)) depth--; }
      if (seen && depth <= 0 && /;\s*$/.test(lines[i])) return lines.slice(start, i + 1).join("\n");
      if (!seen && /;\s*$/.test(lines[i])) return lines.slice(start, i + 1).join("\n");
    }
    return null;
  };
  const consts = ["RIGS", "TAGS", "PET_ART", "FONT_META", "FONT_ORDER", "SITE_THEMES", "SPAL", "SVGH"];
  const fns = ["genSite", "bannerArt", "sceneArt", "scene", "defHours", "esc", "fmtPrice", "priceNum", "cleanPrice", "petPortrait", "petFace", "petSrc", "petHero", "schedSummary", "siteFontCss", "siteTheme", "themeCss", "dayCss", "typeInfo", "t12", "inboxValid", "house", "silTree", "siteMain"];
  let code = "";
  for (const c of consts) { const t = extractConst(c); assert.ok(t, "const " + c); code += t + "\n"; }
  for (const f of fns) { const t = extractFn(f); assert.ok(t, "fn " + f); code += t + "\n"; }
  return new Function("FONT_DATA", "FONT_CSS", "NOISE", "let sceneN=0;\n" + code + "\nreturn { genSite, siteTheme, SITE_THEMES, fmtPrice, cleanPrice, petFace, PET_ART, siteFontCss };")(fontData || {}, "", "");
}
function demoCfg(extra) {
  const sched = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ on: i >= 1 && i <= 6, from: "16:00", to: "20:00" }));
  return {
    type: "lawn", look: "night", sky: "dusk", art: "dusk", font: "", pets: [], snowTrigger: "2",
    inboxUrl: "", inboxKey: "", publicUrl: "", parent2: "", phone2Digits: "", email2: "",
    seasonOn: false, seasonPrice: "", promise: "If something isn't right, tell my parent.",
    first: "Taylor", town: "Lincoln", biz: "Taylor's Lawn Co.", tagline: "Straight lines. Clean edges. Done right.",
    parentName: "Molly", phone: "", phoneDigits: "4025550100", showPhone: true,
    email: "parent@example.com", venmo: "taylor-lawn", about: "I'm Taylor. I show up and do it right.",
    services: [{ n: "Mow a small yard", p: "$25" }, { n: "Leaf raking", p: "$30" }],
    palette: "ember", days: sched.map((x) => x.on), sched, hours: "", proof: [], reviews: [],
    publish: { slug: "demo", book: "http://sites.test/api/book" }, ...(extra || {})
  };
}

test("page reskins: every theme stamps its marker and keeps the booking widget intact", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, SITE_THEMES } = extractBuilderParts(src);
  const ids = Object.keys(SITE_THEMES);
  assert.deepEqual(ids, ["bold", "clean", "paper", "sport", "friendly", "midnight", "retro"]);
  const seen = new Set();
  for (const id of ids) {
    const html = genSite(demoCfg({ theme: id }));
    assert.ok(html.includes(`data-theme="${id}"`), id + " data-theme");
    assert.ok(html.includes(`/* hb-theme:${id} */`), id + " css marker");
    assert.ok(html.includes(`"theme":"${id}"`), id + " window.__C theme");
    for (const el of ["cal", "svc", "nm", "freq", "err", "sendHost"]) {
      assert.ok(html.includes(`id="${el}"`), id + " keeps #" + el);
    }
    seen.add(html);
  }
  // Seven themes, seven genuinely different documents.
  assert.equal(seen.size, ids.length);
});

test("page reskins: an unknown theme falls back to Bold Block", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, siteTheme } = extractBuilderParts(src);
  assert.equal(siteTheme("neon"), "bold");
  assert.equal(siteTheme(""), "");
  assert.equal(siteTheme(undefined), "");
  const html = genSite(demoCfg({ theme: "neon" }));
  assert.ok(html.includes('data-theme="bold"'));
  assert.ok(html.includes("/* hb-theme:bold */"));
});

test("page reskins: no theme picked renders exactly the pre-theme page", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite } = extractBuilderParts(src);
  const night = genSite(demoCfg({ theme: "" }));
  assert.equal(night.includes("data-theme="), false);
  assert.equal(night.includes("hb-theme:"), false);
  assert.ok(night.includes('"theme":""'));
  assert.ok(night.includes("--bg:#0E1012")); // the original dark base, untouched
  const day = genSite(demoCfg({ theme: "", look: "day" }));
  assert.equal(day.includes("data-theme="), false);
  assert.equal(day.includes("hb-theme:"), false);
  assert.ok(day.includes("--bg:#FBF8F2")); // the legacy day look still applies
});

test("page reskins: the builder offers the picker and carries the choice to publish", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /id="themes"/);
  assert.match(src, /theme:""/); // state default: unset, so old drafts render as before
  assert.match(src, /theme:siteTheme\(S\.theme\)/); // resolve() carries it into genSite
  for (const name of ["Bold Block", "Clean", "Paper", "Sport Stripe", "Friendly", "Midnight", "Retro Badge"]) {
    assert.ok(src.includes('"' + name + '"') || src.includes(name), name);
  }
});

/* ---- website font: a font picked in "Make it yours" reaches the published page ---- */
const STUB_FONT_DATA = { pacifico: "QUJD", bebas: "REVG" };

test("website font: genSite embeds the picked face for headings in every theme", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, SITE_THEMES } = extractBuilderParts(src, STUB_FONT_DATA);
  for (const id of Object.keys(SITE_THEMES)) {
    const html = genSite(demoCfg({ theme: id, font: "pacifico" }));
    assert.ok(html.includes('@font-face{font-family:"HB-pacifico"'), id + " embeds the picked face");
    assert.ok(html.includes("data:font/woff2;base64,QUJD"), id + " carries the face data");
    assert.ok(html.includes('--display:"HB-pacifico"'), id + " points headings at the pick");
    // the font block is emitted after the theme CSS, so the pick wins over theme heading rules
    assert.ok(html.indexOf("HB-pacifico") > html.indexOf("/* hb-theme:" + id + " */"), id + " font css lands after theme css");
  }
  const bebas = genSite(demoCfg({ theme: "clean", font: "bebas" }));
  assert.ok(bebas.includes('@font-face{font-family:"HB-bebas"'), "a second pick embeds its own face");
  assert.equal(bebas.includes("HB-pacifico"), false);
});

test("website font: no pick, the default, and an unknown pick stay clean", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, siteFontCss } = extractBuilderParts(src, STUB_FONT_DATA);
  assert.equal(siteFontCss(""), "");
  assert.equal(siteFontCss("workwear"), ""); // the default keeps today's exact rendering
  assert.equal(siteFontCss("comic"), ""); // unknown id falls back, never breaks the page
  assert.ok(siteFontCss("pacifico").includes('@font-face{font-family:"HB-pacifico"'));
  const plain = genSite(demoCfg({ font: "" }));
  assert.equal(plain.includes('font-family:"HB-'), false);
  const unknown = genSite(demoCfg({ font: "comic" }));
  assert.equal(unknown.includes("HB-comic"), false);
  for (const el of ["cal", "svc", "nm", "sendHost"]) {
    assert.ok(unknown.includes(`id="${el}"`), "unknown pick keeps #" + el);
  }
});

test("website font: the Make it yours panel drives the website pick", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const handler = src.split("\n").find((l) => l.includes("lkFont") && l.includes("LOOK.font=v"));
  assert.ok(handler, "the panel font handler exists");
  assert.match(handler, /S\.siteFont=v==="workwear"\?"":v/); // the pick lands in the website state
  assert.match(handler, /S\.siteFont\|\|LOOK\.font/); // the panel shows the website's current font
  assert.match(handler, /queue\(\)/); // preview + draft refresh through the usual path
  // the Step 5 "Website font" picker still writes the same state field
  assert.match(src, /id="siteFonts"/);
  // honest copy: the font covers the website too, and the old app/posters-only wording is gone
  assert.ok(src.includes("The big headings in the app and on your website."));
  assert.equal(src.includes("by default, on your posters"), false);
});

/* ---- service switching: an app-supplied business name follows the new job ---- */
function extractNameParts(src) {
  const cut = (from, to) => {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start + from.length);
    if (start < 0 || end < 0) throw new Error("missing " + from);
    return src.slice(start, end);
  };
  return cut("function typeInfo(", "const PET_ART=") + cut("function autoBiz(", "const DEF_HOURS=");
}

test("service name: an app-supplied name clears when the job switches, a typed name stays", async () => {
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const api = runInNewContext(extractNameParts(src) + "({autoBiz, nameIsPlaceholder, switchedBizName})");
  // The reported flow at the state level: a name-idea pick made under Cars,
  // then the kid goes back and picks Snow. The pick was the app's, so it
  // clears and the new job's built-in default takes over in resolve().
  assert.equal(api.switchedBizName("Suds Buds", "Suds Buds", "wash", "Alex"), "");
  assert.equal(api.autoBiz("snow", "Alex"), "Alex’s Snow Removal");
  assert.equal(api.autoBiz("lawn", "Alex"), "Alex’s Lawn Co.");
  assert.equal(api.autoBiz("pet", "Alex"), "Alex’s Pet Care");
  // A stored name that is exactly the old job's built-in default is a
  // placeholder too (covers names stored before provenance existed).
  assert.equal(api.switchedBizName("Alex’s Car Wash", "", "wash", "Alex"), "");
  assert.equal(api.switchedBizName("Alex’s Lawn Co.", "", "lawn", "Alex"), "");
  // Preset -> preset -> preset: each default reads as a placeholder for the
  // next switch, so the name keeps following the tiles.
  assert.equal(api.nameIsPlaceholder("Alex’s Snow Removal", "", "snow", "Alex"), true);
  assert.equal(api.nameIsPlaceholder("Alex’s Pet Care", "", "pet", "Alex"), true);
  // A name the kid typed is never overwritten by switching.
  assert.equal(api.switchedBizName("Car Detail", "", "wash", "Alex"), "Car Detail");
  assert.equal(api.switchedBizName("Sam’s Snow Crew", "", "lawn", "Sam"), "Sam’s Snow Crew");
  // Editing an app-supplied pick makes it the kid's own: the recorded pick no
  // longer matches, so the edited name stays.
  assert.equal(api.switchedBizName("Suds Buds Co.", "Suds Buds", "wash", "Alex"), "Suds Buds Co.");
  // Blank stays blank; it already derives from the current job.
  assert.equal(api.switchedBizName("", "", "wash", "Alex"), "");
  assert.equal(api.nameIsPlaceholder("", "", "wash", "Alex"), false);
});

test("service name: the builder wires provenance through picks, typing, and switching", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /bizNameAuto:""/); // state default: no app-supplied name recorded
  assert.match(src, /function applyName\(v\)\{S\.bizName=v;S\.bizNameAuto=v;/); // idea chips supply the name
  assert.match(src, /S\.bizName=n;S\.bizNameAuto=n;/); // the surprise pick supplies it too
  assert.match(src, /switchedBizName\(S\.bizName,S\.bizNameAuto,S\.type,/); // switching consults provenance first
  assert.match(src, /dataset\.k==="bizName"&&S\.bizNameAuto/); // typing in the field takes ownership
});

/* ---- serving line lift (Nov 1): extra room under the hero's Serving row ---- */
test("serving line: the hero keeps extra room under the Serving row in every look", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, SITE_THEMES } = extractBuilderParts(src);
  // The .meta "Serving <town>" row is the last thing in .hero-in, so its
  // clearance above the hero's bottom edge is the hero-in bottom padding.
  // In the builder's phone frame that edge sits at the frame's curved
  // bottom corner, so the row needs more than the old 52px.
  const bold = genSite(demoCfg({ theme: "" }));
  assert.ok(bold.includes("padding:0 22px 66px"), "base hero-in bottom padding is lifted to 66px");
  const day = genSite(demoCfg({ theme: "", look: "day" }));
  assert.ok(day.includes("padding:0 22px 66px"), "the day look shares the lifted base padding");
  // Themes ride the base padding unless they override the hero-in bottom
  // spacing themselves; only Clean and Retro do, and both carry the lift.
  for (const id of Object.keys(SITE_THEMES)) {
    const html = genSite(demoCfg({ theme: id }));
    assert.ok(html.includes("Serving Lincoln"), id + " still renders the Serving row");
    if (id === "clean") assert.ok(html.includes(".hero-in{text-align:center;padding-bottom:58px}"), "clean lifts its override to 58px");
    else if (id === "retro") assert.ok(html.includes("margin:0 auto 54px"), "retro lifts its hero card to a 54px bottom margin");
    else assert.ok(html.includes("padding:0 22px 66px"), id + " inherits the lifted base padding");
  }
});

/* ---- pilot fixes (Nov 1): prices, pet art, sticky preview, pet hero, tagline, Make It Yours ---- */
test("job prices over $200 ask to confirm and prices over $999 cannot publish", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, fmtPrice, cleanPrice } = extractBuilderParts(src);
  assert.equal(cleanPrice("250"), "250");
  assert.equal(cleanPrice("10000"), "10000");
  assert.equal(cleanPrice("20/hr"), "20/hr");
  assert.equal(cleanPrice("-50"), "");
  assert.equal(fmtPrice("25"), "$25");
  assert.equal(fmtPrice("10000"), "$10000");
  const html = genSite(demoCfg({ services: [{ n: "Dog walk, 15 minutes", p: "10000" }, { n: "Hourly help", p: "20/hr" }] }));
  assert.ok(html.includes("$10000"));
  assert.ok(html.includes("20/hr"));
  assert.match(src, /priceTooHigh/);
  assert.match(src, /priceNeedsConfirm/);
  assert.match(src, /A price over \$999 cannot be published/);
  const { token } = await parent("prices@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season", slug: "maryn" } });
  const ok = await json(await call("POST", "/api/publish", { token, body: { slug: "maryn", html: page("Maryn") + "<p>$15</p>" } }));
  assert.equal(ok.body.ok, true);
  const before = await call("GET", "/api/site/maryn");
  const blocked = await json(await call("POST", "/api/publish", { token, body: { slug: "maryn", html: page("Maryn") + "<p>Dog walk, 15 minutes $10000</p>" } }));
  assert.equal(blocked.body.error, "price");
  assert.match(blocked.body.message, /\$10000/);
  const after = await call("GET", "/api/site/maryn");
  assert.equal(after.body, before.body);
  assert.equal(after.body.includes("$10000"), false);
});

test("pilot fixes: small animal has real art like the other pets", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { genSite, petFace, PET_ART } = extractBuilderParts(src);
  assert.equal(PET_ART.small.file, "pet-small.webp");
  const face = petFace("small", "Small animal", {});
  assert.ok(face.startsWith("<img"), "small pet renders an image, not the emoji fallback");
  assert.ok(face.includes("pet-small.webp"));
  const art = await readFile(new URL("../assets/pets/pet-small.webp", import.meta.url));
  assert.ok(art.length > 5000, "the hamster tile is a real image file");
  const html = genSite(demoCfg({ type: "pet", pets: ["dog", "cat", "fish", "bird", "small"] }));
  assert.ok(html.includes("pet-small.webp"), "the published pets row uses the hamster art");
  assert.equal(html.includes("🐹"), false, "no emoji stand-in left on the page");
});

test("pilot fixes: sticky preview offset survives, pet hero spans full width, friendly tag is solid", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const stageRule = src.match(/\.stage,\.shell\.sheet \.stage\{display:flex;position:sticky;[^}]*\}/);
  assert.ok(stageRule, "desktop stage rule found");
  assert.ok(stageRule[0].indexOf("inset:auto") < stageRule[0].indexOf("top:62px"),
    "inset:auto must come before top:62px or it silently resets the sticky offset");
  const { genSite } = extractBuilderParts(src);
  const pet = genSite(demoCfg({ type: "pet", pets: ["dog"] }));
  assert.ok(pet.includes("grid-template-columns:minmax(0,1fr)"), "pet hero grid track spans the full width");
  const friendly = genSite(demoCfg({ theme: "friendly" }));
  assert.equal(friendly.includes("rgba(51,38,26,.42)"), false, "the translucent gray tag pill is gone");
  assert.match(friendly, /\.hero \.tag\{color:var\(--bone\)[^}]*background:var\(--card\)/, "friendly tag is a solid chip with dark text");
});

test("pilot fixes: Make It Yours offers the same page designs as step 5", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /id="lkThemes"/, "the look panel has a page-design grid");
  assert.match(src, /paintThemeCards\(mbody\.querySelector\("#lkThemes"\)/, "the panel paints the shared theme cards");
  assert.match(src, /function renderThemes\(\)\{\s*paintThemeCards\(\$\("#themes"\),\$\("#themeHelp"\)\);/, "step 5 uses the same painter, so both bind S.theme");
});

// ---- Family plan: one account, several kid pages, one trial/payment ----

function bookOn(slug, n) {
  return {
    slug,
    name: "Riley " + n,
    contact: "riley" + n + "@example.com",
    service: "Mow " + n,
    when: "Monday at 4:0" + n + " PM",
    address: n + " Oak Street",
    start: "2026-11-02T16:0" + n,
    t: 4000
  };
}

async function accountIdFor(email) {
  const names = await readdir(path.join(dir, "accounts"));
  for (const name of names) {
    const raw = JSON.parse(await readFile(path.join(dir, "accounts", name), "utf8"));
    if (raw.email === email) return raw.id;
  }
  return "";
}

test("family plan: one account publishes two pages under one trial", async () => {
  const { token } = await parent("fam-one@example.test");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  const first = await json(await call("POST", "/api/publish", { token, body: { slug: "kid-one", html: page("Kid One") } }));
  assert.equal(first.status, 200);
  assert.equal(first.body.added, true);
  const before = await json(await call("GET", "/api/me", { token }));

  const second = await json(await call("POST", "/api/publish", { token, body: { slug: "kid-two", html: page("Kid Two") } }));
  assert.equal(second.status, 200);
  assert.equal(second.body.added, true);
  assert.deepEqual(second.body.slugs, ["kid-one", "kid-two"]);

  // (a) both pages serve live
  const one = await call("GET", "/api/site/kid-one");
  assert.equal(one.status, 200);
  assert.match(one.body, /Kid One/);
  const two = await call("GET", "/api/site/kid-two");
  assert.equal(two.status, 200);
  assert.match(two.body, /Kid Two/);

  // (b) the second publish did not restart or extend the trial, and the
  // account still has not paid anything
  const after = await json(await call("GET", "/api/me", { token }));
  assert.equal(after.body.trialEndsAt, before.body.trialEndsAt);
  assert.equal(after.body.trialEndsAt, first.body.trialEndsAt);
  assert.equal(after.body.paidUntil || "", before.body.paidUntil || "");
  assert.equal(after.body.paid, false);
  assert.deepEqual(after.body.slugs, ["kid-one", "kid-two"]);

  // the account view lists one card per page
  const acct = await json(await call("GET", "/api/account", { token }));
  assert.equal(acct.body.sites.length, 2);
  assert.deepEqual(acct.body.sites.map((s) => s.slug), ["kid-one", "kid-two"]);
  assert.ok(acct.body.sites.every((s) => s.status === "live"));

  // (c) another family cannot publish at either address
  const other = await parent("fam-other@example.test");
  await call("POST", "/api/consent", { token: other.token, body: { consent: true } });
  const steal = await json(await call("POST", "/api/publish", { token: other.token, body: { slug: "kid-two", html: page("Stolen") } }));
  assert.equal(steal.status, 409);

  // the dashboard shows one row per page for the same family
  const good = await call("POST", "/admin/login", { raw: "secret=test-admin-secret" });
  const cookie = (good.headers["set-cookie"] || "").split(";")[0];
  const dash = await call("GET", "/admin", { headers: { cookie } });
  assert.equal(dash.status, 200);
  assert.match(dash.body, /\/kid-one/);
  assert.match(dash.body, /\/kid-two/);
  assert.equal(dash.body.split("fam-one@example.test").length - 1, 2);
});

test("family plan: both pages take the break together and one payment revives all", async () => {
  const { token, email } = await parent("fam-break@example.test");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "break-one", html: page("Break One") } });
  await call("POST", "/api/publish", { token, body: { slug: "break-two", html: page("Break Two") } });

  // Bookings do not end the shared trial; both pages use its end date.
  const b1 = await json(await call("POST", "/api/book", { body: bookOn("break-one", 1), headers: { "x-forwarded-for": "203.0.113.201" } }));
  assert.equal(b1.body.ok, true);
  const b2 = await json(await call("POST", "/api/book", { body: bookOn("break-two", 2), headers: { "x-forwarded-for": "203.0.113.202" } }));
  assert.equal(b2.body.ok, true);
  const b3 = await json(await call("POST", "/api/book", { body: bookOn("break-one", 3), headers: { "x-forwarded-for": "203.0.113.203" } }));
  assert.equal(b3.body.ok, true);

  await patchAccount(account=>{account.trialEndsAt=new Date(Date.now()-1000).toISOString();});
  // (d) the account is on break, so BOTH pages serve the break page
  for (const slug of ["break-one", "break-two"]) {
    const res = await call("GET", "/api/site/" + slug);
    assert.equal(res.status, 200);
    assert.match(res.body, /Taking a break/);
    assert.match(res.body, /resting for now/);
  }
  // and a fresh job on either page is held, not accepted as live
  const held = await json(await call("POST", "/api/book", { body: bookOn("break-two", 4), headers: { "x-forwarded-for": "203.0.113.204" } }));
  assert.equal(held.body.held, true);

  // one test-mode payment for the account revives both pages
  const accountId = await accountIdFor(email);
  assert.ok(accountId);
  const payload = JSON.stringify({ id: "evt_family_paid", type: "checkout.session.completed", data: { object: await pendingSession(accountId,"year","cs_family_paid") } });
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const t = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", "whsec_test").update(t + "." + payload).digest("hex");
  const hook = await json(await call("POST", "/api/stripe/webhook", { raw: payload, headers: { "stripe-signature": "t=" + t + ",v1=" + sig } }));
  assert.equal(hook.body.ok, true);
  for (const slug of ["break-one", "break-two"]) {
    const res = await call("GET", "/api/site/" + slug);
    assert.equal(res.status, 200);
    assert.match(res.body, /Break (One|Two)/);
    assert.doesNotMatch(res.body, /Taking a break/);
  }
  const me = await json(await call("GET", "/api/me", { token }));
  assert.equal(me.body.paid, true);
  assert.deepEqual(me.body.slugs, ["break-one", "break-two"]);
});

test("family plan: renaming one page keeps the other page live", async () => {
  const { token } = await parent("fam-rename@example.test");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "rename-one", html: page("Rename One") } });
  await call("POST", "/api/publish", { token, body: { slug: "rename-two", html: page("Rename Two") } });

  // (e) rename the SECOND page, naming it in the request
  const moved = await json(await call("POST", "/api/slug", { token, body: { slug: "rename-two-new", from: "rename-two" } }));
  assert.equal(moved.status, 200);
  assert.equal(moved.body.ok, true);
  assert.equal(moved.body.slug, "rename-two-new");

  const me = await json(await call("GET", "/api/me", { token }));
  assert.deepEqual(me.body.slugs, ["rename-one", "rename-two-new"]);
  assert.equal(me.body.slug, "rename-one"); // the primary page did not move

  const one = await call("GET", "/api/site/rename-one");
  assert.equal(one.status, 200);
  assert.match(one.body, /Rename One/);
  const fresh = await call("GET", "/api/site/rename-two-new");
  assert.equal(fresh.status, 200);
  assert.match(fresh.body, /Rename Two/);
  const old = await call("GET", "/api/site/rename-two");
  assert.equal(old.status, 302);
  assert.equal(old.headers.location, "/rename-two-new");

  // the untouched page still updates under its own address
  const upd = await json(await call("POST", "/api/publish", { token, body: { slug: "rename-one", html: page("Rename One v2") } }));
  assert.equal(upd.status, 200);
  assert.equal(upd.body.updated, true);
  assert.equal(upd.body.added, false);
});

test("family plan: pausing one page leaves its sibling up", async () => {
  const { token } = await parent("fam-pause@example.test");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "pause-one", html: page("Pause One") } });
  await call("POST", "/api/publish", { token, body: { slug: "pause-two", html: page("Pause Two") } });

  const paused = await json(await call("POST", "/api/account/pause", { token, body: { slug: "pause-two" } }));
  assert.equal(paused.body.ok, true);
  const two = await call("GET", "/api/site/pause-two");
  assert.equal(two.status, 200);
  assert.match(two.body, /paused/);
  assert.doesNotMatch(two.body, /Pause Two/);
  const one = await call("GET", "/api/site/pause-one");
  assert.equal(one.status, 200);
  assert.match(one.body, /Pause One/);

  // taking just that page offline works too, and the sibling stays live
  const off = await json(await call("POST", "/api/unpublish", { token, body: { slug: "pause-two" } }));
  assert.equal(off.body.ok, true);
  assert.equal((await call("GET", "/api/site/pause-two")).status, 404);
  assert.equal((await call("GET", "/api/site/pause-one")).status, 200);
});

/* ---- start a new page, refit onto the family plan (Nov 1): several kids, one browser, one account ---- */
function extractNamedFns(src, names) {
  const lines = src.split("\n");
  const extractFn = (name) => {
    const start = lines.findIndex((l) => new RegExp("^(async )?function " + name + "\\b").test(l));
    if (start < 0) return null;
    let depth = 0, begun = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; begun = true; }
        else if (ch === "}") { depth--; if (begun && depth === 0) return lines.slice(start, i + 1).join("\n"); }
      }
    }
    return null;
  };
  let code = "";
  const out = {};
  for (const n of names) { const t = extractFn(n); assert.ok(t, "fn " + n); code += t + "\n"; out[n] = true; }
  return new Function(code + "\nreturn { " + names.join(", ") + " };")();
}
function fnBody(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " exists");
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(async )?function [A-Za-z]+\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("start a new page: build labels prefer the business name, then the kid's first name", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { buildLabelOf } = extractNamedFns(src, ["buildLabelOf"]);
  assert.equal(buildLabelOf({ bizName: "  Sam's Pet Care ", first: "Sam" }), "Sam's Pet Care");
  assert.equal(buildLabelOf({ bizName: "  ", first: " Riley " }), "Riley");
  assert.equal(buildLabelOf({ bizName: "", first: "" }), "Untitled page");
  assert.equal(buildLabelOf({}), "Untitled page");
  assert.equal(buildLabelOf(null), "Untitled page");
});

test("start a new page: the device registry dedupes by code, newest first, capped at ten", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { buildsClean, buildsUpsert } = extractNamedFns(src, ["buildsClean", "buildsUpsert"]);
  assert.deepEqual(buildsClean("junk"), []);
  assert.deepEqual(buildsClean([{ code: " A1 ", label: " One ", updatedAt: "5" }, { code: "A1", label: "Dupe" }, { code: "" }, null, { label: "No code" }]),
    [{ code: "A1", label: "One", updatedAt: 5 }]);
  let list = [];
  list = buildsUpsert(list, { code: "AAA", label: "First", updatedAt: 1 });
  list = buildsUpsert(list, { code: "BBB", label: "Second", updatedAt: 2 });
  assert.deepEqual(list.map((x) => x.code), ["BBB", "AAA"], "newest first");
  list = buildsUpsert(list, { code: "AAA", label: "First, renamed", updatedAt: 3 });
  assert.deepEqual(list.map((x) => [x.code, x.label]), [["AAA", "First, renamed"], ["BBB", "Second"]], "re-using a code refreshes its label in place");
  assert.deepEqual(buildsUpsert(list, { code: " ", label: "Nope" }), list, "a blank code changes nothing");
  let big = [];
  for (let i = 0; i < 14; i++) big = buildsUpsert(big, { code: "C" + i, label: "Build " + i, updatedAt: i });
  assert.equal(big.length, 10, "the registry is capped at ten");
  assert.equal(big[0].code, "C13");
  assert.equal(big[9].code, "C4");
});

test("start a new page: switching never disturbs the current build before the target loads and the current build saves", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(src, /id="buildsBox"/, "the account screen has a builds box");
  assert.match(src, /renderBuildsBox\(\);[\s\S]{0,160}?let data; try\{data=await pubApi\("\/api\/account"/, "the account view renders the builds box on every open");
  assert.match(src, /btn\.id="startNewPage"; btn\.textContent="Start a new page"/, "the button is labeled Start a new page");
  assert.match(src, /<h3>Start a new page\?<\/h3>/, "starting asks first, naming the current build");
  const open = fnBody(src, "openBuild");
  const getAt = open.indexOf('pubApi("/api/draft/"+encodeURIComponent(code),{method:"GET"})');
  const stashAt = open.indexOf("stashCurrentBuild()");
  const applyAt = open.indexOf("applyDraft(target)");
  assert.ok(getAt >= 0 && stashAt > getAt, "openBuild fetches the target draft before touching the current build");
  assert.ok(applyAt > stashAt, "openBuild saves the current build before applying the target");
  assert.match(open, /90 days may be up/, "an expired target draft fails with a plain message, not a wipe");
  assert.ok(open.indexOf("initPublish()", applyAt) > applyAt, "after a switch the publish panel is re-pointed at the opened build's own page");
  const start = fnBody(src, "startNewPage");
  assert.ok(start.indexOf("stashCurrentBuild()") < start.indexOf("clearBuildLeftovers()"), "startNewPage saves before it clears anything");
  assert.ok(start.indexOf("clearBuildLeftovers()") < start.indexOf("S=defaults()"), "the reset happens only after the save and the clear");
  assert.ok(start.indexOf("initPublish()") > start.indexOf("paintCurrentBuild()"), "a fresh build re-points the publish panel too");
  assert.match(src, /localStorage\.removeItem\("hb-draft"\)/, "the old draft code is released so the next save mints a new one");
  assert.match(src, /hb-boss-/, "Boss data is stashed per build code");
});

test("start a new page: publishing remembers which build owns each live page, per page", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { siteDraftsClean, siteDraftsWith, siteOwnerOf } = extractNamedFns(src, ["siteDraftsClean", "siteDraftsWith", "siteOwnerOf"]);
  assert.deepEqual(siteDraftsClean("junk"), {});
  assert.deepEqual(siteDraftsClean(null), {});
  assert.deepEqual(siteDraftsClean({ " A ": " x ", "": "y", B: "" }), { a: "x" }, "keys and codes are trimmed, blanks dropped");
  let map = siteDraftsWith({}, " Sam-Pet-Care ", " AAA ");
  assert.deepEqual(map, { "sam-pet-care": "AAA" }, "recording normalizes the address");
  map = siteDraftsWith(map, "riley-snow-crew", "BBB");
  assert.deepEqual(map, { "sam-pet-care": "AAA", "riley-snow-crew": "BBB" }, "a second page's record keeps its sibling's");
  assert.deepEqual(siteDraftsWith(map, "", "CCC"), map, "a blank address records nothing");
  assert.equal(siteOwnerOf(map, "sam-pet-care", "ZZZ", "sam-pet-care"), "AAA", "the per-page record wins");
  assert.equal(siteOwnerOf(map, "riley-snow-crew", "", "sam-pet-care"), "BBB");
  assert.equal(siteOwnerOf({}, "sam-pet-care", "ZZZ", "sam-pet-care"), "ZZZ", "the pre-family-plan single record still answers for the primary page");
  assert.equal(siteOwnerOf({}, "riley-snow-crew", "ZZZ", "sam-pet-care"), "", "but it never claims a sibling's page");
  assert.equal(siteOwnerOf({}, "riley-snow-crew", "", ""), "", "no record anywhere means no known owner");
  const push = fnBody(src, "pubPush");
  assert.match(push, /recordSiteDraft\(data\.slug\)/, "a successful publish records the owner of the page it just published");
  assert.match(fnBody(src, "recordSiteDraft"), /hb-site-drafts/, "the record is stored per page");
});

test("start a new page: the replace warning guards another build's page — never an added page or this build's own page", async () => {
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const { replaceWarnNeeded } = extractNamedFns(src, ["replaceWarnNeeded"]);
  assert.equal(replaceWarnNeeded("AAA", "AAA"), false, "this build's own page updates quietly");
  assert.equal(replaceWarnNeeded("AAA", "BBB"), true, "a different build's page asks first");
  assert.equal(replaceWarnNeeded("", "BBB"), false, "no remembered owner, no warning");
  assert.equal(replaceWarnNeeded("AAA", ""), false, "no open build code, no warning");
  const push = fnBody(src, "pubPush");
  const gateAt = push.indexOf("ownedSlugs(me).includes(slug)");
  const warnAt = push.indexOf("confirmModal(");
  const postAt = push.indexOf('pubApi("/api/publish"');
  assert.ok(gateAt >= 0 && warnAt > gateAt, "the warning can only fire for an address the account already owns — a new page is added, never warned");
  assert.ok(postAt > warnAt, "the warning is asked before the publish call");
  assert.match(push, /if\(!yes\)\{pubErr\("Nothing was published\."\); return;\}/, "cancelling publishes nothing");
  assert.match(push, /Replace the live page\?/, "the warning says plainly what would happen");
  assert.match(push, /hustlebuilder\.org\/'\+esc\(slug\)/, "the warning names the page at risk");
});

test("old capped pet prices recover once without changing custom prices", async () => {
  const { readFile } = await import("fs/promises");
  const { runInNewContext } = await import("vm");
  const src = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const start = src.indexOf("const PRESETS=");
  const end = src.indexOf("const TAGS=", start);
  const { repairPetPriceCaps } = runInNewContext(src.slice(start, end) + "({repairPetPriceCaps})");
  const state = { type: "pet", services: [
    { n: "Dog walk, 15 minutes", p: "500", t: 1 },
    { n: "Dog walk, 30 minutes", p: "500", t: 1 },
    { n: "Pet feeding drop-in", p: "12.50", t: 1 },
    { n: "Custom package", p: "500", t: 1 }
  ], svcSets: {} };
  assert.equal(repairPetPriceCaps(state), 2);
  assert.deepEqual(state.services.map(s => s.p), ["5", "8", "12.50", "500"]);
  state.services[0].p = "20";
  assert.equal(repairPetPriceCaps(state), 0);
  assert.equal(state.services[0].p, "20");
  const parked = { type: "lawn", services: [{ n: "Custom package", p: "500" }], svcSets: { pet: { services: [{ n: "Dog walk, 15 minutes", p: "500", t: 1 }] } } };
  assert.equal(repairPetPriceCaps(parked), 1);
  assert.equal(parked.svcSets.pet.services[0].p, "5");
  assert.equal(parked.services[0].p, "500");
});

test("website and exports share expiry, renewal, and retained account deadline", async () => {
  const {token}=await parent("unified-clock@example.test");
  await call("POST","/api/consent",{token,body:{consent:true}});
  await call("POST","/api/publish",{token,body:{slug:"unified-clock",html:page("Clock")}});
  assert.equal((await json(await call("GET","/api/me",{token}))).body.exportAllowed,true);
  await patchAccount(account=>{account.trialEndsAt=new Date(Date.now()-1000).toISOString();});
  const expired=(await json(await call("GET","/api/me",{token}))).body;
  assert.equal(expired.exportAllowed,false);
  assert.equal(expired.trialOver,true);
  assert.equal((await call("POST","/api/publish",{token,body:{slug:"new-clock",html:page("Clock")}})).status,402);
  await call("POST","/api/checkout",{token,body:{plan:"year"}});
  assert.equal((await json(await call("GET","/api/me",{token}))).body.exportAllowed,true);
  await call("DELETE","/api/account",{token});
  const again=await parent("unified-clock@example.test");
  const recreated=(await json(await call("GET","/api/me",{token:again.token}))).body;
  assert.equal(recreated.trialEndsAt,expired.trialEndsAt);
  assert.equal(recreated.exportAllowed,false);
});

test("all flyer and poster export paths check account access and fail closed", async () => {
  const {readFile}=await import("fs/promises");
  const {runInNewContext}=await import("vm");
  const src=await readFile(new URL("../index.html",import.meta.url),"utf8");
  const code=src.slice(src.indexOf("function rememberExportDeadline"),src.indexOf("async function saveFlyer"));
  let response={ok:true,exportAllowed:false,trialEndsAt:"2026-01-01T00:00:00Z"};
  const local=new Map();
  const ctx={localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},pubSession:()=>({}),pubToken:()=>"",pubApi:async()=>response};
  const api=runInNewContext(code+";({allowBusinessExport})",ctx);
  const status={textContent:""};
  assert.equal(await api.allowBusinessExport(status),false);
  assert.match(status.textContent,/trial has ended/);
  response={ok:true,exportAllowed:true,comp:true};
  assert.equal(await api.allowBusinessExport(status),true);
  response={ok:false,status:401};
  assert.equal(await api.allowBusinessExport(status),false);
  assert.match(status.textContent,/sign in/);
  ctx.pubApi=async()=>{throw new Error("offline");};
  assert.equal(await api.allowBusinessExport(status),false);
  assert.match(status.textContent,/internet/);
  for(const name of ["saveFlyer(kind)","printFlyer()","saveStudio(kind)","printStudio()"]){
    const start=src.indexOf("async function "+name+"{");
    assert.ok(src.slice(start,start+130).includes("await allowBusinessExport("),name);
  }
});

test("the home page can be shared and search engines can find the public pages", async () => {
  const home = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(home, /rel="canonical" href="https:\/\/hustlebuilder\.org\/"/);
  assert.match(home, /property="og:title"/);
  assert.match(home, /property="og:image" content="https:\/\/hustlebuilder\.org\/assets\/og-home\.png"/);
  assert.match(home, /name="twitter:card" content="summary_large_image"/);
  assert.match(home, /"@type":"SoftwareApplication"/);
  assert.match(home, /"price":"9\.99"/);
  assert.match(home, /"price":"19\.99"/);
  const robots = await call("GET", "/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.body, /Allow: \//);
  assert.match(robots.body, /Sitemap: http:\/\/sites\.test\/sitemap\.xml/);
  const { token } = await parent("search@example.com");
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/publish", { token, body: { slug: "sam-lawn", html: page("Sam"), indexable: true } });
  await call("POST", "/api/publish", { token, body: { slug: "sam-snow", html: page("Snow"), indexable: false } });
  const map = await call("GET", "/sitemap.xml");
  assert.equal(map.status, 200);
  assert.match(map.headers["content-type"], /xml/);
  assert.match(map.body, /<loc>http:\/\/sites\.test\/<\/loc>/);
  assert.match(map.body, /\/terms</);
  assert.match(map.body, /\/privacy</);
  assert.match(map.body, /\/sam-lawn</);
  assert.equal(map.body.includes("/sam-snow"), false);
  const icon = await call("GET", "/favicon.ico");
  assert.equal(icon.status, 200);
  assert.ok(Buffer.isBuffer(icon.body) ? icon.body.length > 32 : String(icon.body).length > 32);
  const touch = await call("GET", "/apple-touch-icon.png");
  assert.equal(touch.status, 200);
  assert.match(touch.headers["content-type"], /png/);
});
