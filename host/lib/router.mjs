import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { feedLinks, gcalTemplate, jobInstant, jobsToIcs, pruneJobs } from "./calendar.mjs";
import { cardPng } from "./card.mjs";
import { checkPage, checkSlug, pageOk, wordHits } from "./moderate.mjs";
import { decoratePage, hidePhone } from "./preview.mjs";
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

function supportReply() {
  const e = String(process.env.REPLY_TO || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}

async function sendMail({ to, subject, text, html: htmlBody, ics, replyTo }) {
  const clean = String(text || "").slice(0, 8000);
  const sub = String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 140);
  const icsText = ics ? String(ics).slice(0, 20000) : "";
  const markup = htmlBody ? String(htmlBody).slice(0, 20000) : "";
  const reply = String(replyTo || "").trim();
  if (testMode()) {
    const key = "outbox/" + sha(to) + ".json";
    const prev = (await readJson(key)) || [];
    const entry = { at: new Date().toISOString(), to, subject: sub, text: clean, replyTo: reply };
    if (markup) entry.html = markup;
    if (icsText) entry.ics = icsText;
    prev.push(entry);
    await writeJson(key, prev.slice(-20));
    return { ok: true, test: true };
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BOOKING_FROM;
  if (!key || !from) return { ok: false, error: "mail" };
  const payload = { from, to: [to], subject: sub, text: clean };
  if (markup) payload.html = markup;
  if (reply) payload.reply_to = reply;
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
<p>When a neighbor books, we store that job for the parent’s family calendar: the service, the customer name they typed, the address, the date and time, and a short note. We delete it about 30 days after the job, or sooner if the parent deletes the account. The phone number from a booking stays in the parent’s email only.</p>
<p>A kid can save a draft on our server so the same page opens on another device. The draft code is the key. We delete it about 90 days after the last save, or when the parent deletes the account. A parent can also get an email with a link that expires in 7 days, so they can finish publishing on their own phone.</p>
<p>If a neighbor leaves an email, we send them a note that we got the request and a link to cancel it. That note does not include the parent’s email or phone, and it does not include a gate code or key note. Those stay in the parent’s email and the private family calendar. The phone number from a booking stays in the parent’s email only.</p>
<p>The rest of the Boss mode job log stays on the phone or computer, unless a parent is signed in there and “Sync to family calendar” is on. Those jobs use the same calendar and the same 30-day delete.</p>
<p>The public page shows a first name and a town. A parent’s phone is not on the page unless they turn that on. Search engines are asked not to list the page unless the parent turns that on too.</p>
<p>Booking emails reply to the customer when they leave an email. If they leave only a phone number, the email says replies are not read and links to text or call them. A code email replies to the address in REPLY_TO when that is set.</p>
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
  const s = String(raw).trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return {};
  try { return JSON.parse(s); }
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

function clientIp(req) {
  const h = (req && req.headers) || {};
  const fwd = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  return String(fwd).split(",")[0].trim().slice(0, 80) || String(h["x-real-ip"] || "local").slice(0, 80);
}
async function bumpIp(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const key = "iplimit/" + sha(ip + "|" + day);
  const n = Number((await (await store()).get(key)) || 0) + 1;
  await (await store()).put(key, String(n));
  return n;
}
const IP_LIMIT = 12;
const MIN_FORM_MS = 2500;

function contactEmail(value) {
  const m = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : "";
}
function contactPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return digits.length === 10 ? "1" + digits : digits;
}
function mailEscape(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pngResponse(buf) {
  return { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" }, body: buf };
}

const ASK_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_MS = 90 * 24 * 60 * 60 * 1000;
const DRAFT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function draftCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => DRAFT_ALPHABET[b % DRAFT_ALPHABET.length]).join("");
}
async function notifyNeighbor({ origin, reply, fields, account }) {
  const cancel = rand(18);
  await writeJson("cancels/" + cancel + ".json", {
    accountId: account.id,
    parentEmail: account.email,
    customer: fields.name,
    service: fields.service,
    when: fields.when,
    used: false
  });
  const url = (origin || "") + "/api/cancel/" + cancel;
  const support = supportReply();
  const unread = support ? "" : "Replies to this email aren't read. The family will confirm with you.";
  const text = [
    "Hi " + fields.name + ",",
    "",
    "We got your request for " + (fields.service || "a job") + (fields.when ? " on " + fields.when : "") + ".",
    "Nothing is booked yet. The family will confirm with you.",
    "",
    "Changed your mind? Cancel here:",
    url,
    "",
    unread
  ].filter(Boolean).join("\n");
  const htmlMail = "<div style=\"font:18px/1.45 system-ui,sans-serif;color:#1d2226\">"
    + "<p>Hi " + mailEscape(fields.name) + ",</p>"
    + "<p>We got your request for <b>" + mailEscape(fields.service || "a job") + "</b>"
    + (fields.when ? " on " + mailEscape(fields.when) : "") + ".</p>"
    + "<p>Nothing is booked yet. The family will confirm with you.</p>"
    + "<p><a href=\"" + mailEscape(url) + "\">Cancel this request</a></p>"
    + (unread ? "<p>" + mailEscape(unread) + "</p>" : "")
    + "</div>";
  await sendMail({ to: reply, replyTo: support, subject: "We got your request", text, html: htmlMail });
}

function cancelPage(token, done, missing) {
  const title = missing ? "This link is finished" : done ? "Request cancelled" : "Cancel this request?";
  const inner = missing
    ? "<p>This cancel link is no longer active.</p>"
    : done
      ? "<p>Cancelled. The family got a note.</p>"
      : "<p>Nothing is booked until the family confirms. Tap below if you do not want this request.</p><form method=\"post\" action=\"/api/cancel/" + token + "\"><button type=\"submit\" style=\"font:700 18px system-ui;padding:14px 18px\">Cancel this request</button></form>";
  return html(missing ? 404 : 200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main style="max-width:36rem;margin:2rem auto;font:18px/1.5 system-ui,sans-serif;padding:0 1rem"><h1>${title}</h1>${inner}</main></body></html>`);
}

async function issueSession(account) {
  const token = rand(32);
  if (account.tokenHash) await (await store()).del("tokens/" + account.tokenHash);
  account.tokenHash = sha(token);
  account.emailVerifiedAt = account.emailVerifiedAt || new Date().toISOString();
  await saveAccount(account);
  return token;
}
function clipDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = JSON.stringify(value);
  if (raw.length > 900000) return { error: "big" };
  return { draft: value, raw };
}
async function countKey(key, limit) {
  const n = Number((await (await store()).get(key)) || 0) + 1;
  await (await store()).put(key, String(n));
  return n > limit;
}

export async function handleRequest(req) {
  const method = String(req.method || "GET").toUpperCase();
  let path = String(req.path || "/");
  const qMark = path.indexOf("?");
  if (qMark >= 0) path = path.slice(0, qMark);
  const origin = await publicOrigin(req.origin);
  if (method === "OPTIONS") return withCors({ status: 204, headers: {}, body: "" }, req.headers && req.headers.origin);
  if (method === "GET" && path === "/favicon.ico") return { status: 204, headers: { "cache-control": "public, max-age=86400" }, body: "" };
  const route = path.startsWith("/api/") ? path.slice(5) : "";

  if (method === "GET" && (route.startsWith("site/") || path.startsWith("/api/site/"))) {
    const slug = decodeURIComponent((route || path.replace(/^\/api\//, "")).slice(5));
    return withCors(await serveSlug(slug), req.headers && req.headers.origin);
  }

  const calFeed = route.match(/^cal\/([a-f0-9]{32,128})\.ics$/i);
  if (method === "GET" && calFeed) {
    return withCors(await serveCalendar(calFeed[1]), req.headers && req.headers.origin);
  }

  const cardHit = route.match(/^card\/([a-z0-9][a-z0-9-]{1,40})\.png$/);
  if (method === "GET" && cardHit) {
    const meta = await readJson("pages/" + cardHit[1] + ".json");
    const card = (meta && meta.card) || { title: cardHit[1], line: "Book a day", accent: "#FF5B14" };
    return pngResponse(cardPng(card));
  }

  if (method === "GET" && route === "slug") {
    const name = String((req.query && req.query.get && req.query.get("name")) || "").trim().toLowerCase();
    const why = checkSlug(name);
    if (why) return withCors(json(200, { ok: true, available: false, message: why }), req.headers && req.headers.origin);
    const meta = await readJson("pages/" + name + ".json");
    const available = !meta;
    return withCors(json(200, { ok: true, available, message: available ? "That link is free." : "That link is taken. Try another." }), req.headers && req.headers.origin);
  }

  const askGet = route.match(/^ask\/([a-f0-9]{32,128})$/i);
  if (method === "GET" && askGet) {
    const rec = await readJson("asks/" + askGet[1] + ".json");
    if (!rec || Date.parse(rec.expires) < Date.now()) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    return withCors(json(200, { ok: true, status: rec.status || "waiting", url: rec.url || "", email: rec.email, expires: rec.expires }), req.headers && req.headers.origin);
  }

  const draftGet = route.match(/^draft\/([a-z0-9]{8})$/);
  if (method === "GET" && draftGet) {
    const rec = await readJson("drafts/" + draftGet[1] + ".json");
    if (!rec || Date.now() - Date.parse(rec.updatedAt || 0) > DRAFT_MS) {
      if (rec) await (await store()).del("drafts/" + draftGet[1] + ".json");
      return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    }
    return withCors(json(200, { ok: true, code: draftGet[1], draft: rec.draft, updatedAt: rec.updatedAt }), req.headers && req.headers.origin);
  }

  const cancelGet = route.match(/^cancel\/([a-f0-9]{20,80})$/i);
  if (method === "GET" && cancelGet) {
    const rec = await readJson("cancels/" + cancelGet[1] + ".json");
    return cancelPage(cancelGet[1], !!(rec && rec.used), !rec);
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
    const reply = supportReply();
    const unread = reply ? "" : "\n\nReplies to this email aren't read.";
    const mailed = await sendMail({
      to: email,
      replyTo: reply,
      subject: "Your Hustle Builder code",
      text: "Your code is " + code + ".\n\nIt expires in 20 minutes. If you did not ask for this, ignore this email.\n\nPublishing a page shows a child’s first name and a town. A booked job’s name, address, and time are saved for the family calendar for about 30 days." + unread,
      html: "<p style=\"font:18px/1.45 system-ui,sans-serif\">Your code is <b>" + code + "</b>. It expires in 20 minutes.</p>" + (reply ? "" : "<p style=\"font:18px/1.45 system-ui,sans-serif\">Replies to this email aren't read.</p>")
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
      payMode: paywallMode(), indexable: !!account.indexable, draftCode: account.draftCode || "",
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
    if (paid(account)) {
      return withCors(json(200, { ok: true, alreadyPaid: true, mode, plan: account.plan || plan.id, paidUntil: account.paidUntil }), req.headers && req.headers.origin);
    }
    const pendingAt = Date.parse(account.checkoutPendingAt || "");
    if (mode === "stripe" && pendingAt && Date.now() - pendingAt < 20 * 60 * 1000) {
      return withCors(json(200, { ok: true, pending: true, mode: "stripe" }), req.headers && req.headers.origin);
    }
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
      account.checkoutPendingAt = new Date().toISOString();
      await saveAccount(account);
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
        account.checkoutPendingAt = "";
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
    const titleMatch = htmlIn.match(/<title>([^<]*)<\/title>/i);
    const cardTitle = clipField(body.cardTitle || (titleMatch && titleMatch[1]) || slug, 60);
    const cardLine = clipField(body.cardLine || "Book a day", 80);
    const accent = /^#[0-9a-fA-F]{6}$/.test(String(body.accent || "")) ? String(body.accent) : "#FF5B14";
    const indexable = body.indexable === true;
    const pageUrl = (origin || "") + "/" + slug;
    const image = (origin || "") + "/api/card/" + slug + ".png";
    let stored = decoratePage(htmlIn, { title: cardTitle, description: cardLine, image, url: pageUrl, indexable });
    if (body.showPhone !== true) stored = hidePhone(stored, body.phone || "");
    await (await store()).put("pages/" + slug + ".html", stored);
    await writeJson("pages/" + slug + ".json", {
      slug, accountId: account.id, status: "live", updatedAt: new Date().toISOString(), bytes: stored.length,
      indexable, card: { title: cardTitle, line: cardLine, accent }
    });
    account.slug = slug;
    account.indexable = indexable;
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
    if (account.draftCode) await (await store()).del("drafts/" + account.draftCode + ".json");
    await (await store()).del("draftacct/" + account.id);
    await (await store()).del("email/" + sha(account.email));
    await (await store()).del("outbox/" + sha(account.email) + ".json");
    await (await store()).del("accounts/" + account.id + ".json");
    return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "ask") {
    const email = emailOk(body.email);
    if (!email) return withCors(json(400, { ok: false, error: "email" }), req.headers && req.headers.origin);
    const packed = clipDraft(body.draft);
    if (!packed) return withCors(json(400, { ok: false, error: "draft" }), req.headers && req.headers.origin);
    if (packed.error) return withCors(json(413, { ok: false, error: "big" }), req.headers && req.headers.origin);
    const day = new Date().toISOString().slice(0, 10);
    if (await countKey("askem/" + sha(email + "|" + day), 5)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    if (await countKey("askip/" + sha(clientIp(req) + "|" + day), 8)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    const token = rand(24);
    const expires = new Date(Date.now() + ASK_MS).toISOString();
    await writeJson("asks/" + token + ".json", { email, draft: packed.draft, createdAt: new Date().toISOString(), expires, status: "waiting", url: "" });
    const link = (origin || "") + "/?ask=" + token;
    const mailed = await sendMail({
      to: email,
      replyTo: supportReply(),
      subject: "Your kid asked you to publish their page",
      text: "Your kid is ready to publish a Hustle Builder page.\n\nOpen this link on your phone. It expires in 7 days.\n\n" + link + "\n\nYou will confirm you are the parent, then the page can go online.\n" + (supportReply() ? "" : "\nReplies to this email aren't read.\n"),
      html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>Your kid is ready to publish a Hustle Builder page.</p><p><a href=\"" + mailEscape(link) + "\">Open it on your phone</a></p><p>The link expires in 7 days. You confirm you are the parent, then the page can go online.</p>" + (supportReply() ? "" : "<p>Replies to this email aren't read.</p>") + "</div>"
    });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    return withCors(json(200, { ok: true, token, link, expires }), req.headers && req.headers.origin);
  }

  const askOpen = route.match(/^ask\/([a-f0-9]{32,128})\/open$/i);
  if (method === "POST" && askOpen) {
    const rec = await readJson("asks/" + askOpen[1] + ".json");
    if (!rec || Date.parse(rec.expires) < Date.now()) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    let account = await accountByEmail(rec.email);
    if (!account) account = { id: rand(8), email: rec.email, createdAt: new Date().toISOString(), consentAt: null, plan: null, paidUntil: null, slug: null };
    const token = await issueSession(account);
    return withCors(json(200, { ok: true, token, email: rec.email, draft: rec.draft, consent: !!account.consentAt, paid: paid(account), slug: account.slug || "", status: rec.status || "waiting", url: rec.url || "" }), req.headers && req.headers.origin);
  }

  const askDone = route.match(/^ask\/([a-f0-9]{32,128})\/done$/i);
  if (method === "POST" && askDone) {
    const rec = await readJson("asks/" + askDone[1] + ".json");
    if (!rec) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    rec.status = "live";
    rec.url = String(body.url || rec.url || "").slice(0, 200);
    rec.liveAt = new Date().toISOString();
    await writeJson("asks/" + askDone[1] + ".json", rec);
    return withCors(json(200, { ok: true, status: "live", url: rec.url }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "draft") {
    const packed = clipDraft(body.draft);
    if (!packed) return withCors(json(400, { ok: false, error: "draft" }), req.headers && req.headers.origin);
    if (packed.error) return withCors(json(413, { ok: false, error: "big" }), req.headers && req.headers.origin);
    let code = String(body.code || "").trim().toLowerCase();
    if (code && !/^[a-z0-9]{8}$/.test(code)) return withCors(json(400, { ok: false, error: "code" }), req.headers && req.headers.origin);
    const day = new Date().toISOString().slice(0, 10);
    const existing = code ? await readJson("drafts/" + code + ".json") : null;
    if (!existing && await countKey("draftnew/" + sha(clientIp(req) + "|" + day), 40)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    const account = await me();
    let rec = existing;
    if (!code || !rec) {
      code = draftCode();
      rec = { createdAt: new Date().toISOString() };
    }
    rec.draft = packed.draft;
    rec.updatedAt = new Date().toISOString();
    if (account) {
      rec.accountId = account.id;
      account.draftCode = code;
      await saveAccount(account);
      await (await store()).put("draftacct/" + account.id, code);
    }
    await writeJson("drafts/" + code + ".json", rec);
    const link = (origin || "") + "/?draft=" + code;
    return withCors(json(200, { ok: true, code, link }), req.headers && req.headers.origin);
  }

  const cancelPost = route.match(/^cancel\/([a-f0-9]{20,80})$/i);
  if (method === "POST" && cancelPost) {
    const rec = await readJson("cancels/" + cancelPost[1] + ".json");
    if (!rec) return cancelPage(cancelPost[1], false, true);
    if (!rec.used) {
      rec.used = true;
      rec.cancelledAt = new Date().toISOString();
      await writeJson("cancels/" + cancelPost[1] + ".json", rec);
      const support = supportReply();
      await sendMail({
        to: rec.parentEmail,
        replyTo: support,
        subject: "A neighbor cancelled",
        text: rec.customer + " cancelled the request for " + (rec.service || "a job") + (rec.when ? " on " + rec.when : "") + ".\n\nYou do not need to do anything else.",
        html: "<p style=\"font:18px/1.45 system-ui,sans-serif\">" + mailEscape(rec.customer) + " cancelled the request for " + mailEscape(rec.service || "a job") + (rec.when ? " on " + mailEscape(rec.when) : "") + ".</p>"
      });
    }
    return cancelPage(cancelPost[1], true, false);
  }

  if (method === "POST" && route === "book") {
    const slug = String(body.slug || "").trim().toLowerCase();
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta || meta.status !== "live") return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const account = await readJson("accounts/" + meta.accountId + ".json");
    if (!account) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const ip = clientIp(req);
    const hits = await bumpIp(ip);
    if (String(body.hp || body.company || "").trim()) return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
    const waited = Number(body.t);
    if (!Number.isFinite(waited) || waited < MIN_FORM_MS) return withCors(json(400, { ok: false, error: "fast", message: "Wait a few seconds, then send it again." }), req.headers && req.headers.origin);
    if (hits > IP_LIMIT) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
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
      freq: clip(body.freq, 40),
      petKind: clip(body.petKind, 20),
      petCount: clip(body.petCount, 8),
      petNames: clip(body.petNames, 80),
      petSize: clip(body.petSize, 20),
      dayPart: clip(body.dayPart, 20),
      awayFrom: clip(body.awayFrom, 20),
      awayTo: clip(body.awayTo, 20),
      access: clip(body.access, 200)
    };
    const start = String(body.start || "").trim();
    if (!fields.name || !fields.address || !fields.contact || !fields.service || !(fields.when || start)) return withCors(json(400, { ok: false, error: "fields" }), req.headers && req.headers.origin);
    const startOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) && jobInstant(start) != null;
    const blob = Object.values(fields).join(" ") + " " + start;
    const hitsWords = wordHits(blob);
    if (hitsWords.block) return withCors(json(400, { ok: false, error: "moderation", message: "That request has a word that is not allowed: \"" + hitsWords.block + "\"." }), req.headers && req.headers.origin);
    const petBits = [
      fields.petKind ? "Pet: " + fields.petKind + (fields.petCount ? " x" + fields.petCount : "") : "",
      fields.petNames ? "Pet names: " + fields.petNames : "",
      fields.petSize ? "Dog size: " + fields.petSize : "",
      fields.dayPart ? "Time of day: " + fields.dayPart : "",
      (fields.awayFrom || fields.awayTo) ? "Away: " + (fields.awayFrom || "?") + " to " + (fields.awayTo || "?") : "",
      fields.access ? "Access, parent only: " + fields.access : ""
    ].filter(Boolean);
    const jobNote = [fields.note, petBits.join(". ")].filter(Boolean).join(" | ").slice(0, 500);
    const job = startOk ? {
      id: "b" + rand(8),
      source: "book",
      service: fields.service,
      customer: fields.name,
      address: fields.address,
      start,
      note: jobNote,
      createdAt: new Date().toISOString()
    } : null;
    const gcal = job ? gcalTemplate(job) : "";
    const ics = job ? jobsToIcs([job]) : "";
    const reply = contactEmail(fields.contact);
    const phone = contactPhone(fields.contact);
    const tel = phone ? "tel:+" + phone : "";
    const sms = phone ? "sms:+" + phone : "";
    const unread = reply ? "" : "Replies to this email aren't read; text or call the customer below.";
    const flagLine = hitsWords.flag ? "Check this one before you reply. The word \"" + hitsWords.flag + "\" was in the request." : "";
    const text = [
      unread,
      phone ? "Call: " + tel + "\nText: " + sms : "",
      reply ? "Email: " + reply : "",
      flagLine,
      "New booking request. Nothing is booked until you reply to the customer.",
      "",
      "Name: " + fields.name,
      "Reach them at: " + fields.contact,
      "Job: " + fields.service,
      "When: " + fields.when,
      "Size: " + (fields.size || "not sure"),
      "How often: " + fields.freq,
      petBits.join("\n"),
      "Address: " + fields.address,
      "Note: " + (fields.note || "none"),
      "",
      gcal ? "Add this job to Google Calendar:\n" + gcal : "",
      "",
      "This job is also on your family calendar link, if you already added it. We keep the name, address, and time for that calendar for about 30 days. It is not a customer list."
    ].filter((line, i, arr) => line !== "" && !(line === "" && arr[i - 1] === "")).join("\n");
    const link = (href, label) => href ? "<a href=\"" + mailEscape(href) + "\" style=\"font-weight:700\">" + mailEscape(label) + "</a>" : "";
    const htmlMail = "<div style=\"font:18px/1.45 system-ui,sans-serif;color:#1d2226\">"
      + (unread ? "<p><b>" + mailEscape(unread) + "</b></p>" : "")
      + "<p>" + [link(tel, "Call " + fields.name), link(sms, "Text " + fields.name), link(reply ? "mailto:" + reply : "", reply ? "Email " + fields.name : "")].filter(Boolean).join(" &nbsp; ") + "</p>"
      + (flagLine ? "<p>" + mailEscape(flagLine) + "</p>" : "")
      + "<p>New booking request. Nothing is booked until you reply to the customer.</p>"
      + "<p>Name: " + mailEscape(fields.name) + "<br>Reach them at: " + mailEscape(fields.contact) + "<br>Job: " + mailEscape(fields.service) + "<br>When: " + mailEscape(fields.when) + "<br>Address: " + mailEscape(fields.address) + "<br>Note: " + mailEscape(fields.note || "none")
      + (petBits.length ? "<br>" + petBits.map(mailEscape).join("<br>") : "") + "</p>"
      + (gcal ? "<p><a href=\"" + mailEscape(gcal) + "\">Add this job to Google Calendar</a></p>" : "")
      + "<p>This job is also on your family calendar link, if you already added it. We keep the name, address, and time for about 30 days.</p>"
      + "</div>";
    const mailed = await sendMail({
      to: account.email,
      replyTo: reply || supportReply(),
      subject: (hitsWords.flag ? "Check this booking: " : "Booking request: ") + (fields.service || "a job"),
      text, html: htmlMail, ics
    });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    if (job) {
      await ensureCalToken(account);
      const jobs = await loadJobs(account.id);
      jobs.push(job);
      await saveJobs(account.id, jobs);
    }
    meta.bookCount = (meta.bookCount || 0) + 1;
    await writeJson("pages/" + slug + ".json", meta);
    if (reply) await notifyNeighbor({ origin, reply, fields, account });
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
