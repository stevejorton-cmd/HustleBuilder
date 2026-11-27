import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import vm from "node:vm";
import { fileStore, setStore, store } from "../host/lib/store.mjs";
import { handleRequest } from "../host/lib/router.mjs";

const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
function part(startMarker, endMarker) {
  const s = indexSource.indexOf(startMarker);
  const e = indexSource.indexOf(endMarker, s + startMarker.length);
  assert.ok(s >= 0 && e > s, `missing slice ${startMarker} .. ${endMarker}`);
  return indexSource.slice(s, e);
}

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "hb-audit-"));
  setStore(fileStore(dir));
  process.env.PUBLISH_TEST_MODE = "1";
  process.env.PAYWALL_MODE = "test";
  process.env.PUBLIC_ORIGIN = "http://sites.test";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_audit";
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
function samplePage(title) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body><!-- hb-public --><h1>${title}</h1><p>Kid-owned. Parent-backed.</p></body></html>`;
}
async function findAccountIdByEmail(email) {
  const files = await readdir(path.join(dir, "accounts"));
  for (const f of files) {
    const rec = JSON.parse(await readFile(path.join(dir, "accounts", f), "utf8"));
    if (String(rec.email || "").toLowerCase() === email.toLowerCase()) return rec.id || f.replace(/\.json$/, "");
  }
  throw new Error("account not found for " + email);
}
async function makeParent(email) {
  const s = await json(await call("POST", "/api/auth/start", { body: { email } }));
  assert.equal(s.body.ok, true);
  const v = await json(await call("POST", "/api/auth/verify", { body: { email, code: s.body.devCode } }));
  assert.equal(v.body.ok, true);
  await call("POST", "/api/consent", { token: v.body.token, body: { consent: true } });
  const accountId = await findAccountIdByEmail(email);
  return { email, token: v.body.token, accountId };
}
function stripeWebhook(payload) {
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex");
  return call("POST", "/api/stripe/webhook", { raw, headers: { "stripe-signature": `t=${ts},v1=${sig}` } });
}
async function chargeAndRefundReady(accountId, plan, sessionId, paymentIntent) {
  const file = path.join(dir, "accounts", `${accountId}.json`);
  const acct = JSON.parse(await readFile(file, "utf8"));
  acct.checkoutSessionId = sessionId;
  acct.checkoutPlan = plan;
  const attempt = createHash("sha256").update(`checkout:${accountId}:${acct.checkoutGeneration || 0}`).digest("hex");
  await writeFile(file, JSON.stringify(acct));
  const res = await stripeWebhook({
    id: "evt_paid_" + sessionId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        payment_intent: paymentIntent,
        amount_total: plan === "year" ? 1999 : 999,
        currency: "usd",
        metadata: { accountId, plan, attempt }
      }
    }
  });
  assert.equal(res.status, 200);
}

test("Bug #1: POST /api/publish rejects hijacking another account's jobcode via body.draftCode", async () => {
  const victim = await makeParent("victim@example.com");
  const attacker = await makeParent("attacker@example.com");

  const victimDraft = await json(await call("POST", "/api/draft", { token: victim.token, body: { draft: { first: "Taylor" } } }));
  assert.equal(victimDraft.status, 200);
  const victimCode = victimDraft.body.code;

  const victimPub = await json(await call("POST", "/api/publish", {
    token: victim.token,
    body: { slug: "taylor-yard-clean", html: samplePage("Taylor"), draftCode: victimCode }
  }));
  assert.equal(victimPub.status, 200);

  const attackPub = await json(await call("POST", "/api/publish", {
    token: attacker.token,
    body: { slug: "attacker-yard", html: samplePage("Attacker"), draftCode: victimCode }
  }));
  assert.equal(attackPub.status, 200);
  assert.notEqual(attackPub.body.jobCode, victimCode, "attacker must not adopt victim's draft/job code");

  const ownerId = String((await (await store()).get(`jobcode/${victimCode}`)) || "").trim();
  assert.equal(ownerId, victim.accountId, "victim's jobcode mapping must remain owned by victim");
});

test("Bug #2: held bookings hide neighbor street/Venmo/tokens and block confirmation or messaging until paid", async () => {
  const parent = await makeParent("held-parent@example.com");
  const pub = await json(await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "riley-lawn", html: samplePage("Riley"), venmo: "RileyParent" }
  }));
  assert.equal(pub.status, 200);

  // Expire trial so the next booking is placed in "held" state.
  const acctFile = path.join(dir, "accounts", `${parent.accountId}.json`);
  const acct = JSON.parse(await readFile(acctFile, "utf8"));
  acct.trialEndsAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(acctFile, JSON.stringify(acct));

  const slotDay = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const book = await json(await call("POST", "/api/book", {
    body: {
      slug: "riley-lawn",
      name: "Jordan",
      contact: "jordan@example.com",
      service: "Mow a small yard",
      address: "742 Evergreen Terrace",
      start: `${slotDay}T15:00`,
      when: "Saturday at 3:00 PM",
      t: 5000
    }
  }));
  assert.equal(book.status, 200);

  const reqs = JSON.parse(await (await store()).get(`requests/${parent.accountId}.json`));
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].status, "held");
  const secretToken = reqs[0].actionToken;
  assert.ok(secretToken, "stored booking has an action token");

  // GET /api/my-jobs must redact address, Venmo, action token, and detailsUrl for held bookings.
  const jobsRes = await json(await call("GET", "/api/my-jobs", { token: parent.token }));
  assert.equal(jobsRes.status, 200);
  assert.equal(jobsRes.body.jobs.length, 1);
  const job = jobsRes.body.jobs[0];
  assert.equal(job.status, "held");
  assert.equal(job.held, true);
  assert.equal(job.action, undefined);
  assert.equal(job.detailsUrl, undefined);
  assert.equal(job.venmoUrl || "", "");
  assert.doesNotMatch(JSON.stringify(job), /Evergreen|jordan@example\.com/i);

  // Direct access to GET /api/job/:token must return 402 with zero neighbor PII.
  const pageRes = await call("GET", `/api/job/${secretToken}`);
  assert.equal(pageRes.status, 402);
  assert.doesNotMatch(pageRes.body, /742 Evergreen|jordan@example\.com|RileyParent/i);

  // Direct POST /api/job/:token (confirm) must be rejected with 402.
  const confirmRes = await json(await call("POST", `/api/job/${secretToken}`, { body: { status: "confirmed", json: true } }));
  assert.equal(confirmRes.status, 402);
  assert.equal(confirmRes.body.error, "plan_required");

  // Direct message attempt on held booking must also be rejected with 402.
  const msgRes = await json(await call("POST", `/api/job/${secretToken}`, {
    body: { action: "reply", body: "Hi neighbor!", json: true }
  }));
  assert.equal(msgRes.status, 402);
  assert.equal(msgRes.body.error, "plan_required");
});

test("Bug #3: refunded upfront paid plan without a trial closes the site instead of falling back to an open free trial", async () => {
  const parent = await makeParent("billing-audit@example.com");
  const acctFile = path.join(dir, "accounts", `${parent.accountId}.json`);

  // Simulate an account that paid upfront without an active trial.
  const initial = JSON.parse(await readFile(acctFile, "utf8"));
  delete initial.trialEndsAt;
  await writeFile(acctFile, JSON.stringify(initial));

  await chargeAndRefundReady(parent.accountId, "year", "cs_audit_upfront", "pi_audit_upfront");

  const pub = await json(await call("POST", "/api/publish", {
    token: parent.token,
    body: { slug: "upfront-refund-site", html: samplePage("Upfront Kid") }
  }));
  assert.equal(pub.status, 200);

  // Full refund of the upfront payment.
  const ref = await stripeWebhook({
    id: "evt_ref_upfront",
    type: "charge.refunded",
    data: { object: { payment_intent: "pi_audit_upfront", amount: 1999, amount_refunded: 1999, refunded: true } }
  });
  assert.equal(ref.status, 200);

  const after = JSON.parse(await readFile(acctFile, "utf8"));
  assert.equal(after.plan, null, "account plan must clear after full refund");
  assert.equal(after.paidUntil, null, "paidUntil must clear after full refund");

  const me = await json(await call("GET", "/api/me", { token: parent.token }));
  assert.equal(me.body.trialOver, true, "refunded upfront plan without trial must report trialOver=true");
  assert.equal(me.body.trialDaysLeft, 0, "refunded upfront plan without trial must not show remaining trial days");
  assert.equal(me.body.exportAllowed, false, "refunded upfront plan must not remain exportAllowed");

  const site = await call("GET", "/api/site/upfront-refund-site");
  assert.match(site.body, /Taking a break/i, "site must pause instead of staying live forever for free");
});

test("Bug #4: setMode('flyers') while signed out with untouched empty shell does not save or dirty draft", () => {
  let saves = 0;
  const nodes = new Map();
  const c = vm.createContext({
    S: { flyerStyle: "" },
    draftDirty: false,
    savedRaw: null,
    draftOwner: "",
    anonymousDraft: false,
    document: { body: { classList: { toggle() {} } } },
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { setAttribute() {} });
      return nodes.get(id);
    },
    save() { saves++; },
    syncLiveUrlFields() {},
    renderFlyerChips() {},
    refreshFlyers() {},
    window: { scrollTo() {} }
  });
  vm.runInContext(part("function setMode(m){", '$("#mBuild").onclick='), c);
  c.setMode("flyers");
  assert.equal(c.S.flyerStyle, "ink");
  assert.equal(saves, 0, "must not call save() on untouched blank signed-out shell");

  // Once the user has an anonymous or dirty draft, defaulting flyerStyle may save.
  c.S.flyerStyle = "";
  c.anonymousDraft = true;
  c.setMode("flyers");
  assert.equal(saves, 1);
});

test("Bug #5: ensureStudio prevents Poster Studio crash after reset and clears undo history; saveNewAddress never hijacks a sibling slug", async () => {
  // Part 1: ensureStudio
  const undoBtn = { disabled: false };
  const studioCtx = vm.createContext({
    S: { palette: "ember", type: "lawn" },
    RIGS: { ember: { c: "#D94B3D" }, grass: { c: "#166534" } },
    $: id => (id === "#stUndo" ? undoBtn : null)
  });
  vm.runInContext(part("const PW=850", "const foldOpen={};"), studioCtx);
  vm.runInContext('stHist.push(\'{"layout":3}\');', studioCtx);
  studioCtx.S = { palette: "grass", type: "snow" }; // simulates startNewPage()/defaults() where S.studio is undefined
  const st = studioCtx.ensureStudio(true);
  assert.equal(st.layout, 0);
  assert.equal(st.rig, "grass");
  assert.deepEqual(Array.from(st.pkg), []);
  assert.equal(vm.runInContext("stHist.length", studioCtx), 0);
  assert.equal(undoBtn.disabled, true);

  // Part 2: saveNewAddress refuses unpublished draft instead of renaming sibling's pubSession().slug
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { value: "", textContent: "", readOnly: false, hidden: false });
    return els.get(id);
  };
  let apiCalls = [];
  let recordedSlug = "";
  let savedSession = { email: "parent@example.com", slug: "older-sibling-slug" };
  const addrCtx = vm.createContext({
    S: { siteUrl: "" },
    $: el,
    pubSession: () => ({ ...savedSession }),
    pubSaveSession: s => { savedSession = s; },
    recordSiteDraft: slug => { recordedSlug = slug; },
    showPublished() {},
    pubApi: async (endpoint, opts) => {
      apiCalls.push({ endpoint, opts });
      return { ok: true, slug: opts.body.slug, url: `https://hustlebuilder.org/${opts.body.slug}` };
    }
  });
  vm.runInContext(part("function ownSlug(){", "function ownedSlugs(") + part("async function saveNewAddress(){", "const checkNewBtn="), addrCtx);

  // Unpublished draft: must refuse and make zero API calls.
  el("#newSlug").value = "younger-kid";
  await addrCtx.saveNewAddress();
  assert.equal(apiCalls.length, 0);
  assert.match(el("#newSlugStatus").textContent, /Publish this page first/i);
  assert.equal(savedSession.slug, "older-sibling-slug");

  // Published secondary kid page: renames its own slug, records site draft ownership, and preserves older sibling's primary session.slug.
  addrCtx.S.siteUrl = "https://hustlebuilder.org/second-kid";
  el("#newSlug").value = "second-kid-new";
  await addrCtx.saveNewAddress();
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].opts.body.from, "second-kid");
  assert.equal(recordedSlug, "second-kid-new");
  assert.equal(savedSession.slug, "older-sibling-slug", "renaming second kid must not overwrite primary session.slug");
});

test("Weekly earnings summary calculates per-kid weekly totals, deltas, multi-kid family totals, and survives malformed records", () => {
  const storeMap = new Map();
  const ctx = vm.createContext({
    S: { first: "Taylor", bizName: "Taylor’s Lawn Co." },
    anonymousDraft: false,
    draftOwner: "",
    draftWriteAllowed: () => true,
    esc: s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])),
    buildsList: () => [
      { code: "kid1code", label: "Taylor’s Lawn Co." },
      { code: "kid2code", label: "Riley’s Pet Care" }
    ],
    localDrafts: () => ({
      kid1code: { first: "Taylor", bizName: "Taylor’s Lawn Co." },
      kid2code: { first: "Riley", bizName: "Riley’s Pet Care" }
    }),
    currentDraftCode: () => "kid1code",
    bossKeyFor: code => "hb-boss-" + code,
    localStorage: {
      getItem: k => storeMap.get(k) ?? null,
      setItem: (k, v) => storeMap.set(k, v)
    }
  });
  storeMap.set("hb-boss-kid2code", JSON.stringify({
    jobs: [
      { id: "r1", date: "2026-11-23", customer: "Alex", service: "Dog walk", amount: 15, tip: 3, paid: true },
      { id: "r2", date: "2026-11-26", customer: "Morgan", service: "Pet drop-in", amount: 12, tip: 0, paid: true }
    ],
    costs: [],
    upcoming: []
  }));

  vm.runInContext(part("function freshBoss(){", "const RANKS=["), ctx);
  vm.runInContext(`B = ${JSON.stringify({
    goalAmount: 500,
    goalLabel: "New mower",
    jobs: [
      { id: "j1", date: "2026-11-24", customer: "Pat", service: "Leaf raking", amount: 30, tip: 5, paid: true },
      { id: "j2", date: "2026-11-25", customer: "Sam", service: "Yard cleanup", amount: 25, tip: 0, paid: false },
      { id: "j3", date: "2026-11-18", customer: "Pat", service: "Leaf raking", amount: 20, tip: 0, paid: true },
      { id: "bad", date: "not-a-date", customer: "", amount: "oops", tip: null, paid: true }
    ],
    costs: [{ id: "c1", date: "2026-11-24", label: "Bags", amount: 6 }],
    upcoming: []
  })};`, ctx);

  const now = new Date(2026, 10, 26, 12, 0, 0); // Thursday, Nov 26, 2026 (week starts Mon Nov 23)
  const family = ctx.familyWeeklyEarnings(now);
  assert.equal(family.kids.length, 2);

  const taylor = family.kids[0];
  assert.equal(taylor.label, "Taylor’s Lawn Co.");
  assert.equal(taylor.summary.collected, 35);
  assert.equal(taylor.summary.tips, 5);
  assert.equal(taylor.summary.owed, 25);
  assert.equal(taylor.summary.costs, 6);
  assert.equal(taylor.summary.profit, 29);
  assert.equal(taylor.summary.jobsCount, 2);
  assert.equal(taylor.summary.prevCollected, 20);
  assert.equal(taylor.summary.delta, 15);

  const riley = family.kids[1];
  assert.equal(riley.label, "Riley’s Pet Care");
  assert.equal(riley.summary.collected, 30);
  assert.equal(riley.summary.tips, 3);
  assert.equal(riley.summary.jobsCount, 2);

  assert.equal(family.total.collected, 65);
  assert.equal(family.total.owed, 25);
  assert.equal(family.total.jobsCount, 4);

  const html = ctx.weeklyEarningsHTML(now);
  assert.match(html, /This week’s earnings/);
  assert.match(html, /Taylor/);
  assert.match(html, /Riley/);
  assert.match(html, /\$35/);
  assert.match(html, /\$30/);
  assert.match(html, /Family total \(2 kids · 4 jobs\)/);
  assert.match(html, /\$65/);
  assert.doesNotMatch(html, /NaN|Invalid Date/);
});

test("parseBooking parses modern website requests (time, size, how often, reply-to) and plain job text", () => {
  const ctx = vm.createContext({
    MONTHS_L: ["january","february","march","april","may","june","july","august","september","october","november","december"],
    pad: n => String(n).padStart(2, "0"),
    isoOf: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    digitsOf: p => String(p || "").replace(/[^\d+]/g, "")
  });
  vm.runInContext(part("function parseTime12(raw){", "function todayHTML(){"), ctx);

  const modern = "Hi Taylor! This is Jordan. I’d like to book: Mow a small yard on Saturday, June 14 at 2:30 PM. Size: Medium. How often: Just once. Address: 410 Maple Ave. Note: Back gate is unlocked. Reply to: 555-234-5678. (Sent from the Taylor’s Lawn Co. website)";
  const parsed = ctx.parseBooking(modern);
  assert.ok(parsed);
  assert.equal(parsed.customer, "Jordan");
  assert.equal(parsed.service, "Mow a small yard");
  assert.equal(parsed.time, "14:30");
  assert.equal(parsed.address, "410 Maple Ave");
  assert.equal(parsed.phone, "555-234-5678");
  assert.match(parsed.note, /Back gate is unlocked/);

  const plain = "Service: Leaf raking\nCustomer: Sam\nAddress: 22 Oak St\nDate/Time: Friday, October 16 at 4:00 pm\nPrice: $20\nNotes: Bring extra bags";
  const parsedPlain = ctx.parseBooking(plain);
  assert.ok(parsedPlain);
  assert.equal(parsedPlain.customer, "Sam");
  assert.equal(parsedPlain.service, "Leaf raking");
  assert.equal(parsedPlain.time, "16:00");
  assert.equal(parsedPlain.address, "22 Oak St");
  assert.equal(parsedPlain.note, "Bring extra bags");
});
