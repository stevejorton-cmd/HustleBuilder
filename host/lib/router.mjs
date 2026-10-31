import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { feedLinks, gcalTemplate, jobInstant, jobsToIcs, pruneJobs } from "./calendar.mjs";
import { checkPage, checkSlug, pageOk } from "./moderate.mjs";
import { store } from "./store.mjs";

export const PLANS = {
  month: { id: "month", amount: 600, days: 31, label: "$6 a month" },
  season: { id: "season", amount: 3900, days: 183, label: "$39 for the season" },
  year: { id: "year", amount: 5900, days: 365, label: "$59 for the year" }
};
export const CONSENT_VERSION = "2026-10-31";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const rand = (n = 32) => randomBytes(n).toString("hex");

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function testMode() { return process.env.PUBLISH_TEST_MODE === "1"; }
function paywallMode() { return process.env.PAYWALL_MODE || "test"; }

function emailOk(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 120) return "";
  return e;
}

function json(status, body, extra = {}) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", ...extra }, body: JSON.stringify(body) };
}

function html(status, markup) {
  return { status, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" }, body: markup };
}

async function readJson(key) {
  const raw = await (await store()).get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}
async function writeJson(key, value) {
  await (await store()).put(key, JSON.stringify(value));
}

async function accountByEmail(email) {
  const id = await (await store()).get("email/" + sha(email));
  if (!id) return null;
  return readJson("accounts/" + id.trim() + ".json");
}
async function accountByToken(header) {
  const m = String(header || "").match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  const id = await (await store()).get("tokens/" + sha(m[1]));
  if (!id) return null;
  const account = await readJson("accounts/" + id.trim() + ".json");
  if (!account || !safeEqual(account.tokenHash || "", sha(m[1]))) return null;
  return account;
}
async function saveAccount(account) {
  await writeJson("accounts/" + account.id + ".json", account);
  await (await store()).put("email/" + sha(account.email), account.id);
  if (account.tokenHash) await (await store()).put("tokens/" + account.tokenHash, account.id);
}

function paid(account) {
  return !!(account && account.paidUntil && Date.parse(account.paidUntil) > Date.now());
}

function allowOrigin(originHeader) {
  const origin = String(originHeader || "");
  if (!origin) return "*";
  let host = "";
  try { host = new URL(origin).hostname; } catch { return ""; }
  const list = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".github.io")) return origin;
  const pub = String(process.env.PUBLIC_ORIGIN || "");
  if (pub && origin === pub.replace(/\/$/, "")) return origin;
  return "";
}

function withCors(result, reqOrigin) {
  const allow = allowOrigin(reqOrigin);
  const headers = { ...result.headers };
  if (allow) {
    headers["access-control-allow-origin"] = allow;
    headers["access-control-allow-headers"] = "content-type, authorization, x-admin-secret";
    headers["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
    headers.vary = "Origin";
  }
  return { ...result, headers };
}

async function sendMail({ to, subject, text, ics }) {
  const clean = String(text || "").slice(0, 8000);
  const sub = String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 140);
  const icsText = ics ? String(ics).slice(0, 20000) : "";
  if (testMode()) {
    const key = "outbox/" + sha(to) + ".json";
    const prev = (await readJson(key)) || [];
    const entry = { at: new Date().toISOString(), to, subject: sub, text: clean };
    if (icsText) entry.ics = icsText;
    prev.push(entry);
    await writeJson(key, prev.slice(-20));
    return { ok: true, test: true };
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BOOKING_FROM;
  if (!key || !from) return { ok: false, error: "mail" };
  const payload = { from, to: [to], subject: sub, text: clean };
  if (icsText) payload.attachments = [{ filename: "booking.ics", content: Buffer.from(icsText, "utf8").toString("base64") }];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { ok: false, error: "mail" };
  return { ok: true };
}

function privacyPage() {
  return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Privacy</title></head><body>
<main style="max-width:40rem;margin:2rem auto;font:18px/1.5 system-ui,sans-serif;padding:0 1rem">
<h1>Privacy</h1>
<p>Hustle Builder hosting is for a parent and their child. The parent’s email is stored so we can verify it and send booking emails. The public page they approve is stored so neighbors can open the link.</p>
<p>When a neighbor books, we store that job for the parent’s family calendar: the service, the customer name they typed, the address, the date and time, and a short note. We delete it about 30 days after the job, or sooner if the parent deletes the account. The phone number from a booking stays in the email only.</p>
<p>The rest of the Boss mode job log stays on the phone or computer, unless a parent is signed in there and “Sync to family calendar” is on. Those jobs use the same calendar and the same 30-day delete.</p>
<p>A parent can take the page offline or delete the account from the builder. Taking a page down does not delete calendar jobs. Deleting the account removes the email, the consent record, the page, the calendar jobs, and the calendar link.</p>
<p>This notice is a plain summary. Have a lawyer read it before real families use hosting.</p>
</main></body></html>`);
}

function missingPage(slug, down) {
  const title = down ? "This page was taken down" : "This page is not up";
  return html(404, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:2rem"><h1>${title}</h1><p>${down ? "The host removed this page." : "Check the link, or ask them to publish again."}</p></body></html>`);
}

async function serveSlug(slug) {
  if (slug === "privacy") return privacyPage();
  const why = checkSlug(slug);
  if (why) return missingPage(slug, false);
  const meta = await readJson("pages/" + slug + ".json");
  if (!meta) return missingPage(slug, false);
  if (meta.status === "down") return missingPage(slug, true);
  if (meta.status !== "live") return missingPage(slug, false);
  const page = await (await store()).get("pages/" + slug + ".html");
  if (!page) return missingPage(slug, false);
  return html(200, page);
}

function parseBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return null; }
}

export function stripeSignatureOk(payload, header, secret) {
  const h = String(header || "");
  const t = (h.match(/(?:^|,)t=(\d+)/) || [])[1];
  const v1 = (h.match(/(?:^|,)v1=([a-f0-9]+)/) || [])[1];
  if (!t || !v1 || !secret) return false;
  const expect = createHmac("sha256", secret).update(t + "." + payload).digest("hex");
  return safeEqual(expect, v1);
}

async function publicOrigin(reqOrigin) {
  return String(process.env.PUBLIC_ORIGIN || reqOrigin || "").replace(/\/$/, "");
}

function jobsKey(accountId) { return "caljobs/" + accountId + ".json"; }

async function loadJobs(accountId) {
  const raw = await readJson(jobsKey(accountId));
  const jobs = Array.isArray(raw) ? raw : [];
  const kept = pruneJobs(jobs).slice(-200);
  if (kept.length !== jobs.length) await saveJobs(accountId, kept);
  return kept;
}
async function saveJobs(accountId, jobs) {
  const kept = pruneJobs(jobs).sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(-200);
  await writeJson(jobsKey(accountId), kept);
}

async function ensureCalToken(account) {
  if (account.calToken && /^[a-f0-9]{32,128}$/i.test(account.calToken)) return account;
  account.calToken = rand(24);
  await (await store()).put("caltokens/" + sha(account.calToken), account.id);
  await saveAccount(account);
  return account;
}
async function resetCalToken(account) {
  const prev = account.calToken || "";
  account.calToken = rand(24);
  await (await store()).put("caltokens/" + sha(account.calToken), account.id);
  if (prev) await (await store()).del("caltokens/" + sha(prev));
  await saveAccount(account);
  return account;
}
async function accountByCalToken(token) {
  if (!/^[a-f0-9]{32,128}$/i.test(token)) return null;
  const id = await (await store()).get("caltokens/" + sha(token));
  if (!id) return null;
  const account = await readJson("accounts/" + id.trim() + ".json");
  if (!account || !safeEqual(account.calToken || "", token)) return null;
  return account;
}

function clipField(v, n) { return String(v || "").replace(/[\r\n]+/g, " ").trim().slice(0, n); }

function cleanDeviceJob(input) {
  const id = String((input && input.id) || "").trim();
  const start = String((input && input.start) || "").trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || jobInstant(start) == null) return null;
  const job = {
    id,
    source: "device",
    service: clipField(input.service, 80),
    customer: clipField(input.customer, 60),
    address: clipField(input.address, 120),
    start,
    note: clipField(input.note, 300),
    createdAt: new Date().toISOString()
  };
  const amount = clipField(input.amount, 20);
  if (amount) job.amount = amount;
  if (checkPage("<!-- hb-public -->" + [job.service, job.customer, job.address, job.note, job.amount || ""].join(" "))) return null;
  return job;
}

function calendarResponse(status, body) {
  return {
    status,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    },
    body
  };
}

async function serveCalendar(token) {
  const account = await accountByCalToken(token);
  if (!account) return json(404, { ok: false, error: "missing" });
  const jobs = await loadJobs(account.id);
  return calendarResponse(200, jobsToIcs(jobs));
}

export async function handleRequest(req) {
  const method = String(req.method || "GET").toUpperCase();
  let path = String(req.path || "/");
  const qMark = path.indexOf("?");
  if (qMark >= 0) path = path.slice(0, qMark);
  const origin = await publicOrigin(req.origin);
  if (method === "OPTIONS") return withCors({ status: 204, headers: {}, body: "" }, req.headers && req.headers.origin);
  const route = path.startsWith("/api/") ? path.slice(5) : "";

  if (method === "GET" && (route.startsWith("site/") || path.startsWith("/api/site/"))) {
    const slug = decodeURIComponent((route || path.replace(/^\/api\//, "")).slice(5));
    return withCors(await serveSlug(slug), req.headers && req.headers.origin);
  }

  const calFeed = route.match(/^cal\/([a-f0-9]{32,128})\.ics$/i);
  if (method === "GET" && calFeed) {
    return withCors(await serveCalendar(calFeed[1]), req.headers && req.headers.origin);
  }

  const body = method === "GET" ? {} : parseBody(req.body);
  if (body === null) return withCors(json(400, { ok: false, error: "json" }), req.headers && req.headers.origin);
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);

  async function me() {
    const account = await accountByToken(auth);
    if (!account) return null;
    return account;
  }

  if (method === "POST" && route === "auth/start") {
    const email = emailOk(body.email);
    if (!email) return withCors(json(400, { ok: false, error: "email" }), req.headers && req.headers.origin);
    let account = await accountByEmail(email);
    const code = String(randomInt(100000, 1000000));
    if (!account) account = { id: rand(8), email, createdAt: new Date().toISOString(), consentAt: null, plan: null, paidUntil: null, slug: null };
    account.verifyHash = sha(code + ":" + email);
    account.verifyExpires = Date.now() + 20 * 60 * 1000;
    account.verifyTries = 0;
    await saveAccount(account);
    const mailed = await sendMail({
      to: email,
      subject: "Your Hustle Builder code",
      text: "Your code is " + code + ".\n\nIt expires in 20 minutes. If you did not ask for this, ignore this email.\n\nPublishing a page shows a child’s first name, town, and your phone or email. A booked job’s name, address, and time are saved for the family calendar for about 30 days."
    });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    const out = { ok: true, test: !!mailed.test };
    if (testMode()) out.devCode = code;
    return withCors(json(200, out), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "auth/verify") {
    const email = emailOk(body.email);
    const code = String(body.code || "").replace(/\s+/g, "");
    if (!email || !/^\d{6}$/.test(code)) return withCors(json(400, { ok: false, error: "code" }), req.headers && req.headers.origin);
    const account = await accountByEmail(email);
    if (!account || !account.verifyHash || Date.now() > account.verifyExpires) return withCors(json(400, { ok: false, error: "code" }), req.headers && req.headers.origin);
    account.verifyTries = (account.verifyTries || 0) + 1;
    if (account.verifyTries > 8) { account.verifyHash = ""; await saveAccount(account); return withCors(json(400, { ok: false, error: "code" }), req.headers && req.headers.origin); }
    if (!safeEqual(account.verifyHash, sha(code + ":" + email))) { await saveAccount(account); return withCors(json(400, { ok: false, error: "code" }), req.headers && req.headers.origin); }
    account.emailVerifiedAt = new Date().toISOString();
    account.verifyHash = "";
    const token = rand(32);
    if (account.tokenHash) await (await store()).del("tokens/" + account.tokenHash);
    account.tokenHash = sha(token);
    await saveAccount(account);
    return withCors(json(200, { ok: true, token, email, consent: !!account.consentAt, slug: account.slug || "", plan: account.plan || "", paid: paid(account) }), req.headers && req.headers.origin);
  }

  if (method === "GET" && route === "me") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    await ensureCalToken(account);
    const base = origin || "";
    return withCors(json(200, {
      ok: true, email: account.email, verified: !!account.emailVerifiedAt, consent: !!account.consentAt,
      plan: account.plan || "", paidUntil: account.paidUntil || "", paid: paid(account),
      slug: account.slug || "", url: account.slug && base ? base + "/" + account.slug : "", testMode: testMode(),
      ...feedLinks(base, account.calToken)
    }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "consent") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (body.consent !== true) return withCors(json(400, { ok: false, error: "consent" }), req.headers && req.headers.origin);
    account.consentAt = new Date().toISOString();
    account.consentVersion = CONSENT_VERSION;
    await saveAccount(account);
    return withCors(json(200, { ok: true, consentAt: account.consentAt }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "checkout") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    const plan = PLANS[body.plan];
    if (!plan) return withCors(json(400, { ok: false, error: "plan" }), req.headers && req.headers.origin);
    const mode = paywallMode();
    if (mode === "test" || mode === "off") {
      account.plan = plan.id;
      account.paidUntil = new Date(Date.now() + (mode === "off" ? 3650 : plan.days) * 864e5).toISOString();
      account.payMode = mode;
      await saveAccount(account);
      return withCors(json(200, { ok: true, mode, plan: plan.id, paidUntil: account.paidUntil }), req.headers && req.headers.origin);
    }
    if (mode === "stripe") {
      if (!process.env.STRIPE_SECRET_KEY) return withCors(json(503, { ok: false, error: "stripe-key" }), req.headers && req.headers.origin);
      const params = new URLSearchParams();
      params.set("mode", "payment");
      params.set("customer_email", account.email);
      params.set("success_url", (origin || "") + "/?hosting=paid");
      params.set("cancel_url", (origin || "") + "/?hosting=cancel");
      params.set("line_items[0][quantity]", "1");
      params.set("line_items[0][price_data][currency]", "usd");
      params.set("line_items[0][price_data][unit_amount]", String(plan.amount));
      params.set("line_items[0][price_data][product_data][name]", "Hustle Builder hosting, " + plan.label);
      params.set("metadata[accountId]", account.id);
      params.set("metadata[plan]", plan.id);
      params.set("payment_intent_data[statement_descriptor_suffix]", "HUSTLE BLDR");
      const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
        body: params
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) return withCors(json(502, { ok: false, error: "stripe" }), req.headers && req.headers.origin);
      return withCors(json(200, { ok: true, mode: "stripe", url: data.url }), req.headers && req.headers.origin);
    }
    return withCors(json(400, { ok: false, error: "paywall" }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "stripe/webhook") {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const header = (req.headers && (req.headers["stripe-signature"] || req.headers["Stripe-Signature"])) || "";
    if (!stripeSignatureOk(req.body || "", header, secret)) return withCors(json(400, { ok: false, error: "signature" }), req.headers && req.headers.origin);
    let event;
    try { event = JSON.parse(req.body || "{}"); } catch { return withCors(json(400, { ok: false, error: "json" }), req.headers && req.headers.origin); }
    if (event.type === "checkout.session.completed") {
      const meta = (event.data && event.data.object && event.data.object.metadata) || {};
      const plan = PLANS[meta.plan];
      const account = meta.accountId ? await readJson("accounts/" + meta.accountId + ".json") : null;
      if (account && plan) {
        account.plan = plan.id;
        account.paidUntil = new Date(Date.now() + plan.days * 864e5).toISOString();
        account.payMode = "stripe";
        await saveAccount(account);
      }
    }
    return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "publish") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (!account.consentAt) return withCors(json(403, { ok: false, error: "consent" }), req.headers && req.headers.origin);
    if (!paid(account)) return withCors(json(402, { ok: false, error: "payment" }), req.headers && req.headers.origin);
    const slug = String(body.slug || account.slug || "").trim().toLowerCase();
    if (account.slug && slug !== account.slug) return withCors(json(409, { ok: false, error: "slug-locked", slug: account.slug }), req.headers && req.headers.origin);
    const slugErr = checkSlug(slug);
    if (slugErr) return withCors(json(400, { ok: false, error: "slug", message: slugErr }), req.headers && req.headers.origin);
    const htmlIn = String(body.html || "");
    const shape = pageOk(htmlIn);
    if (shape) return withCors(json(400, { ok: false, error: "page", message: shape }), req.headers && req.headers.origin);
    const words = checkPage(htmlIn);
    if (words) return withCors(json(400, { ok: false, error: "moderation", message: words }), req.headers && req.headers.origin);
    const existing = await readJson("pages/" + slug + ".json");
    if (existing && existing.accountId !== account.id) return withCors(json(409, { ok: false, error: "taken" }), req.headers && req.headers.origin);
    if (existing && existing.status === "down") return withCors(json(403, { ok: false, error: "down" }), req.headers && req.headers.origin);
    await (await store()).put("pages/" + slug + ".html", htmlIn);
    await writeJson("pages/" + slug + ".json", { slug, accountId: account.id, status: "live", updatedAt: new Date().toISOString(), bytes: htmlIn.length });
    account.slug = slug;
    await saveAccount(account);
    const url = (origin || "") + "/" + slug;
    return withCors(json(200, { ok: true, slug, url, updated: !!existing }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "unpublish") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (!account.slug) return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
    const meta = await readJson("pages/" + account.slug + ".json");
    if (meta && meta.accountId === account.id) {
      meta.status = "offline";
      await writeJson("pages/" + account.slug + ".json", meta);
      await (await store()).del("pages/" + account.slug + ".html");
    }
    return withCors(json(200, { ok: true, slug: account.slug }), req.headers && req.headers.origin);
  }

  if (method === "DELETE" && route === "account") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (account.slug) {
      await (await store()).del("pages/" + account.slug + ".html");
      await (await store()).del("pages/" + account.slug + ".json");
    }
    if (account.tokenHash) await (await store()).del("tokens/" + account.tokenHash);
    if (account.calToken) await (await store()).del("caltokens/" + sha(account.calToken));
    await (await store()).del("caljobs/" + account.id + ".json");
    await (await store()).del("email/" + sha(account.email));
    await (await store()).del("outbox/" + sha(account.email) + ".json");
    await (await store()).del("accounts/" + account.id + ".json");
    return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "book") {
    const slug = String(body.slug || "").trim().toLowerCase();
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta || meta.status !== "live") return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const account = await readJson("accounts/" + meta.accountId + ".json");
    if (!account) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const day = new Date().toISOString().slice(0, 10);
    if (meta.bookDay !== day) { meta.bookDay = day; meta.bookCount = 0; }
    if ((meta.bookCount || 0) >= 30) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    const clip = (v, n) => String(v || "").replace(/[\r\n]+/g, " ").trim().slice(0, n);
    const fields = {
      name: clip(body.name, 60),
      contact: clip(body.contact, 80),
      service: clip(body.service, 80),
      when: clip(body.when, 80),
      address: clip(body.address, 120),
      note: clip(body.note, 300),
      size: clip(body.size, 20),
      freq: clip(body.freq, 40)
    };
    if (!fields.name || !fields.address || !fields.contact) return withCors(json(400, { ok: false, error: "fields" }), req.headers && req.headers.origin);
    const start = String(body.start || "").trim();
    const startOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) && jobInstant(start) != null;
    const blob = Object.values(fields).join(" ") + " " + start;
    if (checkPage("<!-- hb-public -->" + blob)) return withCors(json(400, { ok: false, error: "moderation" }), req.headers && req.headers.origin);
    const job = startOk ? {
      id: "b" + rand(8),
      source: "book",
      service: fields.service,
      customer: fields.name,
      address: fields.address,
      start,
      note: fields.note,
      createdAt: new Date().toISOString()
    } : null;
    const gcal = job ? gcalTemplate(job) : "";
    const ics = job ? jobsToIcs([job]) : "";
    const text = [
      "New booking request. Nothing is booked until you reply.",
      "",
      "Name: " + fields.name,
      "Reach them at: " + fields.contact,
      "Job: " + fields.service,
      "When: " + fields.when,
      "Size: " + (fields.size || "not sure"),
      "How often: " + fields.freq,
      "Address: " + fields.address,
      "Note: " + (fields.note || "none"),
      "",
      gcal ? "Add this job to Google Calendar:\n" + gcal : "",
      "",
      "This job is also on your family calendar link, if you already added it. We keep the name, address, and time for that calendar for about 30 days. It is not a customer list."
    ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
    const mailed = await sendMail({ to: account.email, subject: "Booking request: " + (fields.service || "a job"), text, ics });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    if (job) {
      await ensureCalToken(account);
      const jobs = await loadJobs(account.id);
      jobs.push(job);
      await saveJobs(account.id, jobs);
    }
    meta.bookCount = (meta.bookCount || 0) + 1;
    await writeJson("pages/" + slug + ".json", meta);
    return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
  }

  if ((method === "POST" || method === "DELETE") && route === "jobs") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (method === "DELETE") {
      const id = String(body.id || "");
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return withCors(json(400, { ok: false, error: "id" }), req.headers && req.headers.origin);
      const jobs = (await loadJobs(account.id)).filter((j) => j.id !== id);
      await saveJobs(account.id, jobs);
      return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
    }
    if (body.replaceDevice === true) {
      const incoming = Array.isArray(body.jobs) ? body.jobs.slice(0, 60) : null;
      if (!incoming) return withCors(json(400, { ok: false, error: "jobs" }), req.headers && req.headers.origin);
      const device = [];
      for (const raw of incoming) {
        const job = cleanDeviceJob(raw);
        if (job) device.push(job);
      }
      const kept = (await loadJobs(account.id)).filter((j) => j.source !== "device");
      await saveJobs(account.id, kept.concat(device));
      return withCors(json(200, { ok: true, count: device.length }), req.headers && req.headers.origin);
    }
    const job = cleanDeviceJob(body);
    if (!job) return withCors(json(400, { ok: false, error: "job" }), req.headers && req.headers.origin);
    const jobs = await loadJobs(account.id);
    const prev = jobs.find((j) => j.id === job.id);
    if (prev && prev.source === "book") return withCors(json(409, { ok: false, error: "book" }), req.headers && req.headers.origin);
    if (prev && prev.createdAt) job.createdAt = prev.createdAt;
    const next = jobs.filter((j) => j.id !== job.id);
    next.push(job);
    await saveJobs(account.id, next);
    return withCors(json(200, { ok: true, id: job.id }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "cal/reset") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    await resetCalToken(account);
    return withCors(json(200, { ok: true, ...feedLinks(origin || "", account.calToken) }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "admin/takedown") {
    const secret = process.env.ADMIN_SECRET || "";
    const given = (req.headers && (req.headers["x-admin-secret"] || req.headers["X-Admin-Secret"])) || "";
    if (!secret) return withCors(json(503, { ok: false, error: "admin" }), req.headers && req.headers.origin);
    if (!safeEqual(given, secret)) return withCors(json(401, { ok: false, error: "admin" }), req.headers && req.headers.origin);
    const slug = String(body.slug || "").trim().toLowerCase();
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    meta.status = "down";
    meta.downAt = new Date().toISOString();
    await writeJson("pages/" + slug + ".json", meta);
    return withCors(json(200, { ok: true, slug }), req.headers && req.headers.origin);
  }

  if (method === "GET" && route === "test/outbox") {
    if (!testMode()) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const email = emailOk((req.query && req.query.get && req.query.get("email")) || "");
    if (!email) return withCors(json(400, { ok: false, error: "email" }), req.headers && req.headers.origin);
    const box = (await readJson("outbox/" + sha(email) + ".json")) || [];
    return withCors(json(200, { ok: true, messages: box }), req.headers && req.headers.origin);
  }

  return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
}
