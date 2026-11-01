import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { feedLinks, gcalTemplate, jobInstant, jobsToIcs, pruneJobs } from "./calendar.mjs";
import { cardPng } from "./card.mjs";
import { checkPage, checkSlug, pageOk, wordHits } from "./moderate.mjs";
import { decoratePage, hidePhone } from "./preview.mjs";
import { store } from "./store.mjs";
import QRCode from "qrcode";

export const PLANS = {
  season: { id: "season", amount: 1999, label: "$19.99" },
  year: { id: "year", amount: 2999, label: "$29.99" }
};
export const CONSENT_VERSION = "2026-10-31";
export const FREE_JOBS = 3;
export const GRACE_DAYS = 7;
export const TRIAL_DAYS = 14;

export function trialLengthDays() {
  const raw = process.env.TRIAL_DAYS;
  if (raw == null || String(raw).trim() === "") return TRIAL_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 1 || days > 366) return TRIAL_DAYS;
  return Math.floor(days);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function niceDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}

export function seasonOffer(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const end = (yy, month, day) => new Date(Date.UTC(yy, month, day, 23, 59, 59)).toISOString();
  if (m >= 3 && m <= 7) {
    return {
      id: "summer",
      name: "Summer season, May–Aug",
      end: end(y, 7, 31),
      includes: "The page stays online, neighbors can book, and booking emails go to you through August 31, " + y + "."
    };
  }
  const endYear = m >= 8 ? y + 1 : y;
  return {
    id: "winter",
    name: "Winter season, Nov–Mar",
    end: end(endYear, 2, 31),
    includes: "The page stays online, neighbors can book, and booking emails go to you through March 31, " + endYear + "."
  };
}

export function yearOffer(now = new Date()) {
  const end = new Date(now.getTime() + 365 * 864e5).toISOString();
  return {
    id: "year",
    name: "Full year",
    end,
    includes: "The page stays online for 365 days, through " + niceDate(end) + ". Booking emails and the family calendar are included."
  };
}

export function planOffer(planId, now = new Date()) {
  return planId === "year" ? yearOffer(now) : seasonOffer(now);
}

function utcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function daysUntil(endIso, now = Date.now()) {
  const end = Date.parse(endIso || "");
  if (!Number.isFinite(end)) return null;
  return Math.round((utcDay(end) - utcDay(now)) / 864e5);
}

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

function redirect(location) {
  return { status: 302, headers: { location, "cache-control": "no-store" }, body: "" };
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
async function accountByTokenValue(token) {
  if (!/^[a-f0-9]{64}$/i.test(String(token || ""))) return null;
  const id = await (await store()).get("tokens/" + sha(token));
  if (!id) return null;
  const account = await readJson("accounts/" + id.trim() + ".json");
  if (!account || !safeEqual(account.tokenHash || "", sha(token))) return null;
  return account;
}
async function accountByToken(header) {
  const m = String(header || "").match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) return null;
  return accountByTokenValue(m[1]);
}

// Parent sessions also travel as an HttpOnly cookie, so a script running on a
// published page (same origin) cannot read the token out of localStorage.
// Server-side session tokens have no expiry of their own: a token stays valid
// until a new sign-in replaces it or the account is deleted. The cookie
// mirrors that with a long Max-Age; the server stays the source of truth, so
// replacing the token kills old cookies and Bearer tokens at once.
const SESSION_COOKIE = "hb_session";
const SESSION_COOKIE_MAX_AGE = 180 * 86400;
function sessionCookieHeader(token) {
  return SESSION_COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + SESSION_COOKIE_MAX_AGE;
}
function clearSessionCookieHeader() {
  return SESSION_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
}
function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

// The operator view at /admin is gated by the same ADMIN_SECRET as
// /api/admin/restore, but a correct password trades for a random HttpOnly
// cookie session (same shape as the parent sessions above), so the secret
// itself is typed once into a form and never sits in browser storage.
const ADMIN_COOKIE = "hb_admin";
const ADMIN_COOKIE_MAX_AGE = 12 * 3600;
function adminCookieHeader(token) {
  return ADMIN_COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=" + ADMIN_COOKIE_MAX_AGE;
}
function clearAdminCookieHeader() {
  return ADMIN_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0";
}
async function issueAdminSession() {
  const token = rand(32);
  await writeJson("adminsessions/" + sha(token) + ".json", { exp: Date.now() + ADMIN_COOKIE_MAX_AGE * 1000 });
  return token;
}
async function adminAuthed(headers) {
  const token = cookieValue(headers && (headers.cookie || headers.Cookie), ADMIN_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const key = "adminsessions/" + sha(token) + ".json";
  const rec = await readJson(key);
  if (!rec) return false;
  if (Number(rec.exp) <= Date.now()) {
    await (await store()).del(key);
    return false;
  }
  return true;
}
async function dropAdminSession(headers) {
  const token = cookieValue(headers && (headers.cookie || headers.Cookie), ADMIN_COOKIE);
  if (/^[a-f0-9]{64}$/.test(token)) await (await store()).del("adminsessions/" + sha(token) + ".json");
}
async function saveAccount(account) {
  await writeJson("accounts/" + account.id + ".json", account);
  await (await store()).put("email/" + sha(account.email), account.id);
  if (account.tokenHash) await (await store()).put("tokens/" + account.tokenHash, account.id);
}

function paid(account, now = Date.now()) {
  return !!(account && account.paidUntil && Date.parse(account.paidUntil) > now);
}

function graceLeftDays(account, now = Date.now()) {
  const end = Date.parse(account && account.paidUntil || "");
  if (!Number.isFinite(end) || end > now) return 0;
  const left = end + GRACE_DAYS * 864e5 - now;
  if (left <= 0) return 0;
  return Math.max(1, Math.ceil(left / 864e5));
}

function inGrace(account, now = Date.now()) {
  return graceLeftDays(account, now) > 0;
}

function onBreak(account, now = Date.now()) {
  const end = Date.parse(account && account.paidUntil || "");
  if (!Number.isFinite(end)) return false;
  return now > end + GRACE_DAYS * 864e5;
}

function trialClockOpen(account, now = Date.now()) {
  const end = Date.parse(account && account.trialEndsAt || "");
  if (!Number.isFinite(end)) return true;
  return end > now;
}

function trialDaysLeft(account, now = Date.now()) {
  if (!account || !account.trialEndsAt) return trialLengthDays();
  const days = daysUntil(account.trialEndsAt, now);
  if (days == null) return 0;
  return Math.max(0, days);
}

function trialOver(account, used, now = Date.now()) {
  if (!account || paid(account, now) || inGrace(account, now)) return false;
  if (!account.trialEndsAt && !account.slug) return false;
  if (used >= FREE_JOBS) return true;
  return !trialClockOpen(account, now);
}

function firstName(name) {
  const part = String(name || "").trim().split(/\s+/)[0] || "Neighbor";
  return part.slice(0, 40);
}

function streetOnly(address) {
  return String(address || "").replace(/^\s*\d+\s*/, "").split(",")[0].trim().slice(0, 80);
}

function applyPlan(account, planId, now = new Date()) {
  const offer = planOffer(planId, now);
  account.plan = planId === "year" ? "year" : "season";
  account.planName = offer.name;
  account.paidUntil = offer.end;
  account.payMode = paywallMode();
  if (!account.renewToken) account.renewToken = rand(16);
}

async function trialCount(email) {
  const rec = await readJson("trials/" + sha(email) + ".json");
  const n = rec && Number(rec.used);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setTrialCount(email, used) {
  await writeJson("trials/" + sha(email) + ".json", { used, at: new Date().toISOString() });
}

async function rememberAccount(account) {
  if (!account || !account.id) return;
  const ids = (await readJson("plan-ids.json")) || [];
  if (!ids.includes(account.id)) {
    ids.push(account.id);
    await writeJson("plan-ids.json", ids.slice(-5000));
  }
}

async function trackPlan(account) {
  if (!account || !account.paidUntil) return;
  await rememberAccount(account);
}

async function loadRequests(accountId) {
  return (await readJson("requests/" + accountId + ".json")) || [];
}

async function saveRequests(accountId, rows) {
  await writeJson("requests/" + accountId + ".json", rows.slice(-80));
}

function kidJob(row, account) {
  const place = account && account.shareStreet ? (streetOnly(row.address) || "In your neighborhood") : "In your neighborhood";
  return {
    id: row.id,
    service: row.service || "A job",
    when: row.when || "",
    firstName: row.firstName || "Neighbor",
    status: row.status || "new",
    place
  };
}

function payLinks(origin, account) {
  const base = (origin || "") + "/api/renew/" + account.renewToken;
  return { season: base + "?plan=season", year: base + "?plan=year" };
}

async function addReceipt(account, origin, { id, plan, planName, amountLabel, end, stripeUrl }) {
  id = String(id || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!id) return;
  account.receipts = Array.isArray(account.receipts) ? account.receipts : [];
  if (account.receipts.some((item) => item.id === id)) return;
  const url = stripeUrl || ((origin || "") + "/api/receipt/" + id);
  const rec = {
    id, plan, planName: planName || plan, amountLabel,
    at: new Date().toISOString(),
    endLabel: end ? niceDate(end) : "",
    url
  };
  account.receipts.push(rec);
  await writeJson("receipts/" + id + ".json", { ...rec, accountId: account.id });
}

async function ensureRenew(account) {
  if (!account.renewToken) account.renewToken = rand(16);
  await (await store()).put("renew/" + account.renewToken, account.id);
}

async function releaseHeld(account, origin) {
  const rows = await loadRequests(account.id);
  let changed = false;
  for (const row of rows) {
    if (row.status !== "held") continue;
    row.status = "new";
    changed = true;
    const mailed = await sendMail(parentBookingMail(row, origin));
    if (mailed.ok && row.calJob) {
      await ensureCalToken(account);
      const jobs = await loadJobs(account.id);
      jobs.push(row.calJob);
      await saveJobs(account.id, jobs);
      row.calJob = null;
    }
  }
  if (changed) await saveRequests(account.id, rows);
}

function parentBookingMail(row, origin) {
  const fields = row.fields || {};
  const action = (origin || "") + "/api/job/" + row.actionToken;
  const text = [
    "New booking request. Nothing is booked until you reply to the customer.",
    "Mark it confirmed or done: " + action,
    "",
    "Name: " + (fields.name || row.firstName),
    "Reach them at: " + (fields.contact || ""),
    "Job: " + (fields.service || row.service),
    "When: " + (fields.when || row.when),
    "Address: " + (fields.address || ""),
    "Note: " + (fields.note || "none")
  ].join("\n");
  const htmlMail = "<div style=\"font:18px/1.45 system-ui,sans-serif\">"
    + "<p>New booking request. Nothing is booked until you reply to the customer.</p>"
    + "<p><a href=\"" + mailEscape(action) + "\">Mark confirmed or done</a></p>"
    + "<p>Name: " + mailEscape(fields.name || row.firstName) + "<br>Reach them at: " + mailEscape(fields.contact || "")
    + "<br>Job: " + mailEscape(fields.service || row.service) + "<br>When: " + mailEscape(fields.when || row.when)
    + "<br>Address: " + mailEscape(fields.address || "") + "</p></div>";
  return {
    to: row.parentEmail,
    replyTo: row.replyTo || supportReply(),
    subject: "Booking request: " + (fields.service || "a job"),
    text,
    html: htmlMail,
    ics: row.ics || "",
    forParent: true,
    origin
  };
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

function accountUrl(origin) {
  return (origin || "") + "/?account=1";
}

async function sendOnce(flag, message) {
  if (await (await store()).get(flag)) return { ok: true, skipped: true };
  const mailed = await sendMail(message);
  if (mailed.ok) await (await store()).put(flag, "1");
  return mailed;
}

async function sendLiveNote(account, origin, slug) {
  if (account.liveMailed === slug) return;
  const url = (origin || "") + "/" + slug;
  const qr = (origin || "") + "/api/qr/" + slug + ".png";
  const accountLink = accountUrl(origin);
  const renamed = !!(account.liveMailed && account.liveMailed !== slug);
  const subject = renamed ? "Your new web address is live" : "Your page is live";
  const lead = renamed ? "Your new web address is live." : "Your page is live.";
  const mailed = await sendOnce("sentmail/live-" + account.id + "-" + slug, {
    to: account.email,
    replyTo: supportReply(),
    subject,
    text: lead + "\n\n" + url + "\n\nNext:\n1. Print a flyer in the app. The QR code is on it, and in this email.\n2. Share the link with neighbors.\n\nQR code: " + qr + "\n\nYour account:\n" + accountLink + "\n",
    html: "<div style=\"font:18px/1.5 system-ui,sans-serif;color:#1d2226\"><p><b>" + lead + "</b></p><p><a href=\"" + mailEscape(url) + "\">" + mailEscape(url) + "</a></p><p><img src=\"" + mailEscape(qr) + "\" alt=\"QR code for the page\" width=\"220\" height=\"220\"></p><p>Next:</p><ol><li>Print a flyer in the app.</li><li>Share the link with neighbors.</li></ol><p><a href=\"" + mailEscape(accountLink) + "\">Your account</a></p></div>"
  });
  if (mailed.ok) account.liveMailed = slug;
}

async function sendReceiptNote(account, origin, eventId) {
  const plan = PLANS[account.plan] || PLANS.season;
  const end = niceDate(account.paidUntil);
  const flag = "sentmail/receipt-" + String(eventId || ("local-" + account.id + "-" + (account.plan || "plan")));
  const link = accountUrl(origin);
  await sendOnce(flag, {
    to: account.email,
    replyTo: supportReply(),
    subject: "Your Hustle Builder receipt",
    text: "Thanks. We got your payment.\n\n" + (account.planName || "Plan") + "\n" + plan.label + "\nThrough " + end + ".\n\nYour account:\n" + link + "\n",
    html: "<div style=\"font:18px/1.5 system-ui,sans-serif;color:#1d2226\"><p>Thanks. We got your payment.</p><p><b>" + mailEscape(account.planName || "Plan") + "</b><br>" + mailEscape(plan.label) + "<br>Through " + mailEscape(end) + ".</p><p><a href=\"" + mailEscape(link) + "\">Your account</a></p></div>"
  });
}

async function sendMail({ to, subject, text, html: htmlBody, ics, replyTo, forParent, origin }) {
  let bodyText = String(text || "");
  let markup = htmlBody ? String(htmlBody) : "";
  if (forParent) {
    const link = accountUrl(origin);
    bodyText += "\n\nYour account:\n" + link;
    if (markup) markup += "<p style=\"font:18px/1.45 system-ui,sans-serif\"><a href=\"" + mailEscape(link) + "\">Your account</a></p>";
  }
  const clean = bodyText.slice(0, 8000);
  const sub = String(subject || "").replace(/[\r\n]+/g, " ").slice(0, 140);
  const icsText = ics ? String(ics).slice(0, 20000) : "";
  markup = markup.slice(0, 20000);
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
<p>A family can publish with no payment. The page stays up for 14 days from the first publish, or until 3 real booking requests are delivered, whichever comes first. The length is the TRIAL_DAYS setting. One trial belongs to the parent’s email and does not start over with a new link. We email the parent 3 days before that time ends and on the day it ends. When the trial ends, the public link shows a taking-a-break page. The page and the kid’s draft stay saved. New booking requests are saved and held until a parent pays, and paying brings the page back and sends those requests. A paid plan is $19.99 for the current season (summer, May–August, or winter, November–March) or $29.99 for 365 days. We email the parent 14 days before, 3 days before, and on the day a paid plan ends. The page stays up for 7 more days, then it shows a taking-a-break page and bookings pause.</p>
<p>The kid’s My jobs list shows the service, the day and time, the neighbor’s first name, and a status. It does not show the neighbor’s email, phone, or street unless the parent turns street sharing on. Even then it shows the street name, not the house number.</p>
<p>A parent can take the page offline or delete the account from the builder. Taking a page down does not delete calendar jobs. Deleting the account removes the email, the consent record, the page, the calendar jobs, and the calendar link. The free-trial count for that email stays, so a new account cannot start the 3 free jobs again.</p>
<p>This notice is a plain summary. Have a lawyer read it before real families use hosting.</p>
</main></body></html>`);
}

function missingPage(slug, down) {
  const title = down ? "This page was taken down" : "This page is not up";
  return html(404, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:2rem"><h1>${title}</h1><p>${down ? "The host removed this page." : "Check the link, or ask them to publish again."}</p></body></html>`);
}

function pausePage() {
  return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paused</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:2rem;max-width:36rem">
<h1>Paused for now</h1>
<p>This page is paused. Nothing new is being scheduled.</p>
<p>If you know the family, ask them when they are working again.</p>
</body></html>`);
}

function breakPage() {
  return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Taking a break</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:2rem;max-width:36rem">
<h1>Taking a break</h1>
<p>This page is resting for now. Bookings are paused, so nothing new is being scheduled.</p>
<p>If you know the family, ask them when they are working again.</p>
</body></html>`);
}

function adminLoginPage(status, note) {
  return html(status, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Admin sign in</title></head><body>
<main style="max-width:24rem;margin:3rem auto;font:18px/1.5 system-ui,sans-serif;padding:0 1rem">
<h1>Hustle Builder admin</h1>
${note ? `<p><b>${mailEscape(note)}</b></p>` : ""}
<form method="post" action="/admin/login">
<label style="display:block;margin:14px 0">Admin password
<input type="password" name="secret" autocomplete="current-password" required style="display:block;width:100%;margin-top:6px;font:18px system-ui;padding:10px;box-sizing:border-box"></label>
<button type="submit" style="font:18px system-ui;padding:12px 18px">Sign in</button>
</form>
</main></body></html>`);
}

function adminSetupPage() {
  return html(503, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Admin not set up</title></head><body>
<main style="max-width:24rem;margin:3rem auto;font:18px/1.5 system-ui,sans-serif;padding:0 1rem">
<h1>Admin is not set up</h1>
<p>This server has no ADMIN_SECRET, so the admin view stays closed.</p>
</main></body></html>`);
}

// A site's business name and the kid's first name are not account fields; they
// live in the config the builder embeds in the published page. Read just those
// two fields out of it — never the phone digits or contact email the config
// also carries. Fall back to the share-card title stored on the page record.
async function siteNames(slug, meta) {
  let first = "";
  let biz = "";
  const raw = await (await store()).get("pages/" + slug + ".html");
  if (raw) {
    const m = raw.match(/window\.__C=(\{.*?\});<\/script>/s);
    if (m) {
      try {
        const cfg = JSON.parse(m[1]);
        first = String(cfg.first || "").slice(0, 40);
        biz = String(cfg.biz || "").slice(0, 80);
      } catch { /* fall through to the card title */ }
    }
  }
  if (!biz && meta && meta.card) biz = String(meta.card.title || "").slice(0, 80);
  return { first, biz };
}

function adminStatus(account, meta, used) {
  if (account && !account.emailVerifiedAt) {
    return { key: "awaiting", label: "Awaiting parent", date: account.createdAt ? "Started " + niceDate(account.createdAt) : "" };
  }
  if (!account) {
    if (meta && meta.status === "review") return { key: "hidden", label: "Hidden (reports)", date: meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
    if (meta && meta.status === "down") return { key: "down", label: "Taken down", date: meta.downAt ? "Since " + niceDate(meta.downAt) : "" };
    if (meta && meta.status === "paused") return { key: "break", label: "Paused by family", date: meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
    return { key: "live", label: "Live", date: meta && meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
  }
  if (!account.slug || !meta) {
    return { key: "draft", label: "Draft", date: account.createdAt ? "Started " + niceDate(account.createdAt) : "" };
  }
  if (meta.status === "review") {
    return { key: "hidden", label: "Hidden (reports)", date: meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
  }
  if (meta.status === "down") {
    return { key: "down", label: "Taken down", date: meta.downAt ? "Since " + niceDate(meta.downAt) : "" };
  }
  if (paid(account)) {
    return { key: "paid", label: "Paid" + (account.planName ? " · " + account.planName : ""), date: "Through " + niceDate(account.paidUntil) };
  }
  if (inGrace(account)) {
    return { key: "grace", label: "Grace period", date: graceLeftDays(account) + " day" + (graceLeftDays(account) === 1 ? "" : "s") + " of grace left" };
  }
  if (onBreak(account) || trialOver(account, used)) {
    const ended = account.paidUntil ? "Plan ended " + niceDate(account.paidUntil) : account.trialEndsAt ? "Trial ended " + niceDate(account.trialEndsAt) : "";
    return { key: "break", label: "Taking a break", date: ended };
  }
  if (meta.status === "paused") {
    return { key: "break", label: "Paused by family", date: meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
  }
  if (meta.status === "offline") {
    return { key: "draft", label: "Unpublished", date: meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
  }
  return {
    key: "trial",
    label: "Free trial",
    date: (account.trialEndsAt ? "Ends " + niceDate(account.trialEndsAt) : "") + " · " + used + " of " + FREE_JOBS + " free jobs used"
  };
}

async function adminDashboardPage(origin) {
  const s = await store();
  const canList = typeof s.list === "function";
  const accountKeys = canList ? await s.list("accounts/") : [];
  const pageKeys = canList ? await s.list("pages/") : [];
  const metas = new Map();
  for (const key of pageKeys) {
    if (!key.endsWith(".json")) continue;
    const meta = await readJson(key);
    if (meta && meta.slug && meta.status !== "redirect") metas.set(meta.slug, meta);
  }
  const counts = { accounts: 0, live: 0, trial: 0, paid: 0, grace: 0, break: 0, hidden: 0, bookings: 0 };
  for (const meta of metas.values()) {
    if (meta.status === "live") counts.live += 1;
    if (meta.status === "review") counts.hidden += 1;
  }
  const rows = [];
  const seen = new Set();
  for (const key of accountKeys) {
    if (!key.endsWith(".json")) continue;
    const account = await readJson(key);
    if (!account || !account.id) continue;
    counts.accounts += 1;
    const meta = account.slug ? metas.get(account.slug) || null : null;
    if (meta) seen.add(meta.slug);
    const used = await trialCount(account.email);
    const status = adminStatus(account, meta, used);
    if (status.key === "trial") counts.trial += 1;
    if (status.key === "paid") counts.paid += 1;
    if (status.key === "grace") counts.grace += 1;
    if (status.key === "break") counts.break += 1;
    const requests = await loadRequests(account.id);
    counts.bookings += requests.length;
    const names = meta ? await siteNames(meta.slug, meta) : { first: "", biz: "" };
    rows.push({
      biz: names.biz,
      first: names.first,
      slug: meta ? meta.slug : account.slug || "",
      email: account.email || "",
      status,
      bookings: requests.length,
      reports: meta && Array.isArray(meta.reports) ? meta.reports.length : 0,
      sortAt: (meta && meta.updatedAt) || account.createdAt || ""
    });
  }
  for (const meta of metas.values()) {
    if (seen.has(meta.slug)) continue;
    const status = adminStatus(null, meta, 0);
    const names = await siteNames(meta.slug, meta);
    rows.push({
      biz: names.biz,
      first: names.first,
      slug: meta.slug,
      email: "",
      status,
      bookings: 0,
      reports: Array.isArray(meta.reports) ? meta.reports.length : 0,
      sortAt: meta.updatedAt || ""
    });
  }
  rows.sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)));
  const tile = (n, label) => `<div style="border:1px solid #ccd2d8;border-radius:10px;padding:10px 14px;min-width:6.5rem"><div style="font-size:28px;font-weight:800">${n}</div><div>${label}</div></div>`;
  const tiles = [
    tile(counts.accounts, "Accounts"),
    tile(counts.live, "Sites live"),
    tile(counts.trial, "In trial"),
    tile(counts.paid, "Paid"),
    tile(counts.grace, "In grace"),
    tile(counts.break, "Taking a break"),
    tile(counts.hidden, "Hidden by reports"),
    tile(counts.bookings, "Bookings stored")
  ].join("");
  const body = rows.map((row) => `<tr>
<td style="padding:8px;vertical-align:top">${row.biz ? `<b>${mailEscape(row.biz)}</b>` : ""}${row.first ? `<br>${mailEscape(row.first)}` : ""}${!row.biz && !row.first ? "—" : ""}</td>
<td style="padding:8px;vertical-align:top">${row.slug ? `<a href="${mailEscape((origin || "") + "/" + row.slug)}">/${mailEscape(row.slug)}</a>` : "—"}</td>
<td style="padding:8px;vertical-align:top">${row.email ? mailEscape(row.email) : "—"}</td>
<td style="padding:8px;vertical-align:top">${mailEscape(row.status.label)}${row.status.date ? `<br><span style="color:#5a6672">${mailEscape(row.status.date)}</span>` : ""}</td>
<td style="padding:8px;vertical-align:top">${row.bookings}</td>
<td style="padding:8px;vertical-align:top">${row.reports}</td>
</tr>`).join("");
  return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Hustle Builder admin</title></head><body>
<main style="max-width:64rem;margin:2rem auto;font:16px/1.5 system-ui,sans-serif;padding:0 1rem">
<div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
<h1 style="margin:0">Hustle Builder admin</h1>
<form method="post" action="/admin/logout"><button type="submit" style="font:16px system-ui;padding:8px 14px">Sign out</button></form>
</div>
<div style="display:flex;flex-wrap:wrap;gap:10px;margin:18px 0">${tiles}</div>
<table style="border-collapse:collapse;width:100%">
<thead><tr style="text-align:left;border-bottom:2px solid #1d2226">
<th style="padding:8px">Business · kid</th><th style="padding:8px">Page</th><th style="padding:8px">Parent email</th><th style="padding:8px">Status</th><th style="padding:8px">Bookings</th><th style="padding:8px">Reports</th>
</tr></thead>
<tbody>${body || `<tr><td colspan="6" style="padding:8px">No accounts yet.</td></tr>`}</tbody>
</table>
<p style="color:#5a6672">Bookings are the requests still stored per family (newest 80 kept). Reports are the reports on a page right now; restoring a page clears them.</p>
</main></body></html>`);
}

// Published pages are account-supplied HTML and can carry inline script (the
// booking widget). This policy keeps the page's own inline code, same-origin
// fetches, embedded data: photos/fonts and same-origin images working, while
// blocking scripts, connections and form posts to outside origins — a rogue
// page cannot load outside code or ship a visiting parent's data elsewhere.
const PAGE_CSP = "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// Page view counts: a small motivation number for the kid ("your page has
// been viewed N times"). Only aggregate counts are stored — a running total
// plus one bucket per day — in views/<slug>.json, apart from the page record.
// No visitor addresses, user agents, or per-visit data of any kind are kept.
// A count happens only when the real page is served (below, at the one
// return that hands out the page HTML): the break / pause / review / missing
// pages never count, and neither do the family's own checks of their page,
// the operator's admin visits, obvious bots and link previews, or non-GET
// requests. Counting is best-effort — a store hiccup must never break the
// page — and read-modify-write like countKey, so two views landing in the
// same instant can undercount by one. At this app's traffic that is fine.
const VIEW_BOT_UA = /bot|crawler|spider|preview|facebookexternalhit/i;
const VIEW_KEEP_DAYS = 35;
function viewDayKey(when = Date.now()) {
  return new Date(when).toISOString().slice(0, 10);
}
async function noteView(slug, meta, view) {
  try {
    if (!view || view.method !== "GET") return;
    const headers = view.headers || {};
    const ua = String(headers["user-agent"] || headers["User-Agent"] || "");
    if (VIEW_BOT_UA.test(ua)) return;
    if (await adminAuthed(headers)) return;
    if (meta && meta.accountId) {
      const viewer = (await accountByTokenValue(cookieValue(headers.cookie || headers.Cookie, SESSION_COOKIE)))
        || (await accountByToken(headers.authorization || headers.Authorization));
      if (viewer && viewer.id === meta.accountId) return;
    }
    const key = "views/" + slug + ".json";
    const rec = (await readJson(key)) || { total: 0, days: {} };
    rec.total = (Number(rec.total) || 0) + 1;
    if (!rec.days || typeof rec.days !== "object") rec.days = {};
    const today = viewDayKey();
    rec.days[today] = (Number(rec.days[today]) || 0) + 1;
    const cutoff = viewDayKey(Date.now() - VIEW_KEEP_DAYS * 864e5);
    for (const day of Object.keys(rec.days)) if (day < cutoff) delete rec.days[day];
    await writeJson(key, rec);
  } catch { /* counting never breaks the page */ }
}
async function viewCounts(slug) {
  const rec = (await readJson("views/" + slug + ".json")) || { total: 0, days: {} };
  let last7 = 0;
  for (let i = 0; i < 7; i++) last7 += Number((rec.days || {})[viewDayKey(Date.now() - i * 864e5)]) || 0;
  return { total: Number(rec.total) || 0, last7 };
}

// The "Built with Hustle Builder" belt: a slim credit strip the host adds
// to a kid's page when the page is SERVED, not when it is published — so
// pages already out in the world carry it too, and it can be restyled or
// removed later in this one place. It is attached at the same single
// return that hands out the real page HTML (and counts the view), so the
// break / pause / review / down / missing pages never get one. The belt
// is inert markup with inline styles only — a published page's CSP
// allows inline styles but no outside scripts, images or fonts — and it
// sits in normal flow at the very end of the page, never fixed over the
// booking buttons. Its own dark strip and text colors are declared on
// the belt itself, so it reads the same on light and dark kid pages. A
// page whose stored HTML somehow already carries the marker is served
// exactly as stored, never double-belted.
const BELT_MARKER = 'id="hb-belt"';
const BELT_HTML = `<div id="hb-belt" style="margin:28px 0 0;padding:14px 12px;background:#14181d;border-top:3px solid #ff5b14;text-align:center;font:13px/1.4 system-ui,sans-serif;color:#aeb8c2"><a href="https://hustlebuilder.org" target="_top" style="color:#e8ecf0;text-decoration:none;font-weight:600"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style="vertical-align:-1px;margin-right:5px"><polygon points="9,1 3,9 7,9 6,15 13,7 9,7" fill="#ff5b14"/></svg>Built with Hustle Builder</a></div>`;
function withBelt(pageHtml) {
  if (typeof pageHtml !== "string" || pageHtml.includes(BELT_MARKER)) return pageHtml;
  const at = pageHtml.toLowerCase().lastIndexOf("</body>");
  return at >= 0
    ? pageHtml.slice(0, at) + BELT_HTML + "\n" + pageHtml.slice(at)
    : pageHtml + BELT_HTML;
}

async function serveSlug(slug, view) {
  const res = await serveSlugInner(slug, view);
  if (res && res.headers && String(res.headers["content-type"] || "").includes("text/html")) {
    res.headers = { ...res.headers, "content-security-policy": PAGE_CSP };
  }
  return res;
}

async function serveSlugInner(slug, view) {
  if (slug === "privacy") return privacyPage();
  const why = checkSlug(slug);
  if (why) return missingPage(slug, false);
  const meta = await readJson("pages/" + slug + ".json");
  if (!meta) return missingPage(slug, false);
  if (meta.status === "down") return missingPage(slug, true);
  if (meta.status === "review") return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hidden for review</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:2rem;max-width:36rem"><h1>Hidden for now</h1><p>This page is hidden while it is being checked. Nothing new is being scheduled.</p></body></html>`);
  if (meta.status === "redirect" && meta.to) {
    if (Date.parse(meta.until || "") > Date.now()) return redirect("/" + meta.to);
    return missingPage(slug, false);
  }
  if (meta.status === "paused") return pausePage();

  if (meta.status !== "live") return missingPage(slug, false);
  const account = meta.accountId ? await readJson("accounts/" + meta.accountId + ".json") : null;
  if (account && (onBreak(account) || trialOver(account, await trialCount(account.email)))) return breakPage();
  const page = await (await store()).get("pages/" + slug + ".html");
  if (!page) return missingPage(slug, false);
  // The real page is the only response that gets the "Built with" belt,
  // added here at serve time so the stored page stays exactly as the
  // family published it.
  const res = html(200, withBelt(page));
  // The response is settled; only now does the view count. noteView swallows
  // its own errors, and every other return above (break, pause, review,
  // missing, down, redirect) leaves the counter untouched.
  await noteView(slug, meta, view);
  return res;
}

function parseBody(raw) {
  if (!raw) return {};
  const s = String(raw).trim();
  if (!s) return {};
  if (s[0] !== "{" && s[0] !== "[") {
    if (!s.includes("=")) return {};
    return Object.fromEntries(new URLSearchParams(s));
  }
  try { return JSON.parse(s); }
  catch { return null; }
}

export function stripeSignatureOk(payload, header, secret, now = Date.now()) {
  const h = String(header || "");
  const t = (h.match(/(?:^|,)t=(\d+)/) || [])[1];
  const v1 = (h.match(/(?:^|,)v1=([a-f0-9]+)/) || [])[1];
  if (!t || !v1 || !secret) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > 5 * 60 * 1000) return false;
  const expect = createHmac("sha256", secret).update(t + "." + payload).digest("hex");
  return safeEqual(expect, v1);
}

async function publicOrigin(reqOrigin) {
  return String(process.env.PUBLIC_ORIGIN || reqOrigin || "").replace(/\/$/, "");
}

export function petOgImage(origin) {
  const base = String(origin || "").replace(/\/$/, "");
  let host = "";
  try { host = new URL(base).hostname; } catch { host = ""; }
  if (!base || /(^|\.)hustlebuilder\.org$/i.test(host)) return "https://hustlebuilder.org/assets/pets/pet-og.jpg";
  return base + "/assets/pets/pet-og.jpg";
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
async function notifyNeighbor({ origin, reply, fields, account, requestId }) {
  const cancel = rand(18);
  await writeJson("cancels/" + cancel + ".json", {
    accountId: account.id,
    parentEmail: account.email,
    requestId: requestId || "",
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
  // /admin is a small operator site, not an API route. Vercel rewrites /admin
  // and /admin/* to /api/handler?hbpath=admin... (so they arrive as route
  // "admin..."), while the dev server passes the bare path through; meet both
  // shapes under one name.
  const adminRoute = route.startsWith("admin") ? route : (path === "/admin" || path.startsWith("/admin/") ? path.slice(1) : "");

  if (method === "GET" && (route.startsWith("site/") || path.startsWith("/api/site/"))) {
    const slug = decodeURIComponent((route || path.replace(/^\/api\//, "")).slice(5));
    return withCors(await serveSlug(slug, { method, headers: req.headers || {} }), req.headers && req.headers.origin);
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

  const qrHit = route.match(/^qr\/([a-z0-9][a-z0-9-]{1,40})\.png$/);
  if (method === "GET" && qrHit) {
    const buf = await QRCode.toBuffer((origin || "") + "/" + qrHit[1], { type: "png", width: 320, margin: 1, errorCorrectionLevel: "M" });
    return pngResponse(buf);
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
  const cookieHdr = req.headers && (req.headers.cookie || req.headers.Cookie);

  async function me() {
    // The HttpOnly cookie is the primary credential now. The Bearer token is
    // still accepted so parents who signed in before cookies existed (token
    // in localStorage) are not logged out; the cookie wins when it resolves.
    const fromCookie = await accountByTokenValue(cookieValue(cookieHdr, SESSION_COOKIE));
    if (fromCookie) return fromCookie;
    return accountByToken(auth);
  }

  if (method === "POST" && route === "slug") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    const from = String(account.slug || "").trim().toLowerCase();
    const next = String(body.slug || "").trim().toLowerCase();
    if (!from) return withCors(json(400, { ok: false, error: "slug", message: "Publish the page first." }), req.headers && req.headers.origin);
    if (next === from) return withCors(json(200, { ok: true, slug: from, url: (origin || "") + "/" + from, same: true }), req.headers && req.headers.origin);
    const slugErr = checkSlug(next);
    if (slugErr) return withCors(json(400, { ok: false, error: "slug", message: slugErr }), req.headers && req.headers.origin);
    const taken = await readJson("pages/" + next + ".json");
    if (taken && taken.accountId !== account.id) return withCors(json(409, { ok: false, error: "taken", message: "That link is taken. Try another." }), req.headers && req.headers.origin);
    const now = Date.now();
    account.slugChanges = (Array.isArray(account.slugChanges) ? account.slugChanges : []).filter((at) => now - Date.parse(at) < 90 * 864e5);
    if (account.slugChanges.length >= 3) return withCors(json(429, { ok: false, error: "limit", message: "You can change the web address 3 times in 90 days. Try again later." }), req.headers && req.headers.origin);
    const htmlPage = await (await store()).get("pages/" + from + ".html");
    const prev = await readJson("pages/" + from + ".json");
    if (!htmlPage || !prev || prev.accountId !== account.id) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const until = new Date(now + 90 * 864e5).toISOString();
    await (await store()).put("pages/" + next + ".html", htmlPage);
    await writeJson("pages/" + next + ".json", { ...prev, slug: next, status: prev.status === "down" ? "down" : "live", updatedAt: new Date(now).toISOString() });
    account.formerSlugs = Array.isArray(account.formerSlugs) ? account.formerSlugs : [];
    for (const old of account.formerSlugs) {
      const rec = await readJson("pages/" + old + ".json");
      if (rec && rec.accountId === account.id && rec.status === "redirect") {
        rec.to = next;
        rec.until = until;
        await writeJson("pages/" + old + ".json", rec);
      }
    }
    await writeJson("pages/" + from + ".json", { slug: from, accountId: account.id, status: "redirect", to: next, until, updatedAt: new Date(now).toISOString() });
    account.formerSlugs.push(from);
    account.slug = next;
    account.slugChanges.push(new Date(now).toISOString());
    await saveAccount(account);
    return withCors(json(200, { ok: true, slug: next, from, url: (origin || "") + "/" + next, until }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "auth/start") {
    const email = emailOk(body.email);
    if (!email) return withCors(json(400, { ok: false, error: "email" }), req.headers && req.headers.origin);
    const day = new Date().toISOString().slice(0, 10);
    if (await countKey("authem/" + sha(email + "|" + day), 5)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    if (await countKey("authip/" + sha(clientIp(req) + "|" + day), 8)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
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
      forParent: true,
      origin,
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
    return withCors(json(200, { ok: true, token, email, consent: !!account.consentAt, slug: account.slug || "", plan: account.plan || "", paid: paid(account) }, { "set-cookie": sessionCookieHeader(token) }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "auth/logout") {
    const account = await me();
    if (account) {
      if (account.tokenHash) await (await store()).del("tokens/" + account.tokenHash);
      account.tokenHash = "";
      await saveAccount(account);
    }
    return withCors(json(200, { ok: true }, { "set-cookie": clearSessionCookieHeader() }), req.headers && req.headers.origin);
  }

  if (method === "GET" && route === "me") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    await ensureCalToken(account);
    const base = origin || "";
    const used = await trialCount(account.email);
    const season = seasonOffer();
    const year = yearOffer();
    return withCors(json(200, {
      ok: true, email: account.email, verified: !!account.emailVerifiedAt, consent: !!account.consentAt,
      plan: account.plan || "", planName: account.planName || "", paidUntil: account.paidUntil || "", paid: paid(account),
      grace: inGrace(account), graceDays: graceLeftDays(account),
      trialUsed: used, trialLeft: Math.max(0, FREE_JOBS - used),
      trialDays: trialLengthDays(), trialDaysLeft: trialDaysLeft(account), trialEndsAt: account.trialEndsAt || "",
      trialOver: trialOver(account, used),
      seasonName: season.name, seasonEnd: season.end, yearEnd: year.end,
      shareStreet: !!account.shareStreet, jobCode: account.jobCode || account.draftCode || "",
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
      applyPlan(account, plan.id);
      if (mode === "off") account.paidUntil = new Date(Date.now() + 3650 * 864e5).toISOString();
      const receiptId = "pay-" + account.id + "-" + rand(4);
      await addReceipt(account, origin, {
        id: receiptId,
        plan: plan.id,
        planName: account.planName,
        amountLabel: plan.label,
        end: account.paidUntil
      });
      await sendReceiptNote(account, origin, receiptId);
      await saveAccount(account);
      await trackPlan(account);
      await releaseHeld(account, origin);
      return withCors(json(200, { ok: true, mode, plan: plan.id, planName: account.planName, paidUntil: account.paidUntil }), req.headers && req.headers.origin);
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
      params.set("line_items[0][price_data][product_data][name]", "Hustle Builder hosting, " + planOffer(plan.id).name + ", " + plan.label);
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
    const eventId = String(event.id || "").trim();
    if (event.type === "checkout.session.completed") {
      if (!eventId) return withCors(json(400, { ok: false, error: "event" }), req.headers && req.headers.origin);
      const seenKey = "stripe-events/" + eventId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
      if (await (await store()).get(seenKey)) return withCors(json(200, { ok: true, duplicate: true }), req.headers && req.headers.origin);
      await (await store()).put(seenKey, "1");
      const session = (event.data && event.data.object) || {};
      const meta = session.metadata || {};
      const plan = PLANS[meta.plan];
      const account = meta.accountId ? await readJson("accounts/" + meta.accountId + ".json") : null;
      if (account && plan) {
        applyPlan(account, plan.id);
        account.payMode = "stripe";
        account.checkoutPendingAt = "";
        const stripeUrl = session.receipt_url || (session.payment_intent && session.payment_intent.receipt_url) || "";
        await addReceipt(account, origin, {
          id: "stripe-" + eventId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60),
          plan: plan.id,
          planName: account.planName,
          amountLabel: plan.label,
          end: account.paidUntil,
          stripeUrl
        });
        await sendReceiptNote(account, origin, eventId);
        await saveAccount(account);
        await trackPlan(account);
        await releaseHeld(account, origin);
      }
    }
    return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "publish") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (!account.consentAt) return withCors(json(403, { ok: false, error: "consent" }), req.headers && req.headers.origin);
    if (onBreak(account)) return withCors(json(402, { ok: false, error: "break", message: "This plan is taking a break. Renew it, then publish again." }), req.headers && req.headers.origin);
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
    const petIds = new Set(["dog", "cat", "fish", "bird", "small"]);
    const pets = Array.isArray(body.pets) ? [...new Set(body.pets.map((v) => String(v)))].filter((v) => petIds.has(v)).slice(0, 5) : [];
    const indexable = body.indexable === true;
    const pageUrl = (origin || "") + "/" + slug;
    const image = pets.length ? petOgImage(origin) : (origin || "") + "/api/card/" + slug + ".png";
    let stored = decoratePage(htmlIn, { title: cardTitle, description: cardLine, image, url: pageUrl, indexable });
    if (body.showPhone !== true) stored = hidePhone(stored, body.phone || "");
    await (await store()).put("pages/" + slug + ".html", stored);
    const keptStatus = existing && existing.status === "paused" ? "paused" : "live";
    await writeJson("pages/" + slug + ".json", {
      slug, accountId: account.id, status: keptStatus, updatedAt: new Date().toISOString(), bytes: stored.length,
      indexable, card: { title: cardTitle, line: cardLine, accent, pets }
    });
    account.slug = slug;
    account.indexable = indexable;
    if (!paid(account) && !account.trialStartedAt) {
      const now = Date.now();
      account.trialStartedAt = new Date(now).toISOString();
      account.trialEndsAt = new Date(now + trialLengthDays() * 864e5).toISOString();
    }
    await rememberAccount(account);
    const jobCode = String(body.draftCode || account.jobCode || account.draftCode || "").toLowerCase();
    account.jobCode = /^[a-z0-9]{8}$/.test(jobCode) ? jobCode : account.jobCode || rand(4).slice(0, 8);
    await (await store()).put("jobcode/" + account.jobCode, account.id);
    if (account.liveMailed !== slug) await sendLiveNote(account, origin, slug);
    await saveAccount(account);
    const url = (origin || "") + "/" + slug;
    const used = await trialCount(account.email);
    return withCors(json(200, { ok: true, slug, url, updated: !!existing, jobCode: account.jobCode, trialLeft: Math.max(0, FREE_JOBS - used), trialDaysLeft: trialDaysLeft(account), trialEndsAt: account.trialEndsAt || "" }), req.headers && req.headers.origin);
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
    return withCors(json(200, { ok: true }, { "set-cookie": clearSessionCookieHeader() }), req.headers && req.headers.origin);
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
      forParent: true,
      origin,
      subject: "Your kid asked you to publish their page",
      text: "Your kid is ready to publish a Hustle Builder page.\n\nTry free: your first 3 jobs are on us. The page stays up for " + trialLengthDays() + " days, or until those 3 jobs are used, whichever comes first. You still confirm you are the parent. No payment is needed to go live.\n\nAfter that, a season is " + PLANS.season.label + " and a year is " + PLANS.year.label + ".\n\nOpen this link on your phone. It expires in 7 days.\n\n" + link + "\n" + (supportReply() ? "" : "\nReplies to this email aren't read.\n"),
      html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>Your kid is ready to publish a Hustle Builder page.</p><p><b>Try free: your first 3 jobs are on us.</b> The page stays up for " + trialLengthDays() + " days, or until those 3 jobs are used, whichever comes first. You still confirm you are the parent. No payment is needed to go live.</p><p>After that, a season is " + PLANS.season.label + " and a year is " + PLANS.year.label + ".</p><p><a href=\"" + mailEscape(link) + "\">Open it on your phone</a></p><p>The link expires in 7 days.</p>" + (supportReply() ? "" : "<p>Replies to this email aren't read.</p>") + "</div>"
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
    return withCors(json(200, { ok: true, token, email: rec.email, draft: rec.draft, consent: !!account.consentAt, paid: paid(account), slug: account.slug || "", status: rec.status || "waiting", url: rec.url || "" }, { "set-cookie": sessionCookieHeader(token) }), req.headers && req.headers.origin);
  }

  const askDone = route.match(/^ask\/([a-f0-9]{32,128})\/done$/i);
  if (method === "POST" && askDone) {
    const rec = await readJson("asks/" + askDone[1] + ".json");
    if (!rec || Date.parse(rec.expires) < Date.now()) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
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
      if (rec.requestId && rec.accountId) {
        const rows = await loadRequests(rec.accountId);
        const row = rows.find((item) => item.id === rec.requestId);
        if (row && row.status !== "done") {
          row.status = "cancelled";
          await saveRequests(rec.accountId, rows);
        }
      }
      const support = supportReply();
      await sendMail({
        to: rec.parentEmail,
        replyTo: support,
        forParent: true,
        origin,
        subject: "A neighbor cancelled",
        text: rec.customer + " cancelled the request for " + (rec.service || "a job") + (rec.when ? " on " + rec.when : "") + ".\n\nYou do not need to do anything else.",
        html: "<p style=\"font:18px/1.45 system-ui,sans-serif\">" + mailEscape(rec.customer) + " cancelled the request for " + mailEscape(rec.service || "a job") + (rec.when ? " on " + mailEscape(rec.when) : "") + ".</p>"
      });
    }
    return cancelPage(cancelPost[1], true, false);
  }

  if (method === "GET" && route === "plans") {
    const season = seasonOffer();
    const year = yearOffer();
    return withCors(json(200, {
      ok: true,
      free: "Try free: your first 3 jobs are on us, for " + trialLengthDays() + " days.",
      plans: [
        { id: "season", price: PLANS.season.label, amount: PLANS.season.amount, name: season.name, ends: season.end, endsLabel: niceDate(season.end), includes: season.includes },
        { id: "year", price: PLANS.year.label, amount: PLANS.year.amount, name: year.name, ends: year.end, endsLabel: niceDate(year.end), includes: year.includes }
      ]
    }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "share") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    account.shareStreet = body.on === true;
    await saveAccount(account);
    return withCors(json(200, { ok: true, shareStreet: account.shareStreet }), req.headers && req.headers.origin);
  }

  if (method === "GET" && route === "my-jobs") {
    let account = await me();
    const code = String((req.query && req.query.get && req.query.get("code")) || "").trim().toLowerCase();
    if (!account && /^[a-z0-9]{8}$/.test(code)) {
      const id = await (await store()).get("jobcode/" + code);
      if (id) account = await readJson("accounts/" + id.trim() + ".json");
      if (!account) {
        const draft = await readJson("drafts/" + code + ".json");
        if (draft && draft.accountId) account = await readJson("accounts/" + draft.accountId + ".json");
      }
    }
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    const rows = await loadRequests(account.id);
    const jobs = rows.map((row) => kidJob(row, account));
    const fresh = jobs.filter((row) => row.status === "new").length;
    return withCors(json(200, { ok: true, jobs, fresh, shareStreet: !!account.shareStreet }), req.headers && req.headers.origin);
  }

  const jobAct = route.match(/^job\/([a-f0-9]{16,80})$/i);
  if (jobAct && (method === "GET" || method === "POST")) {
    const pointer = await (await store()).get("jobact/" + jobAct[1]);
    const parts = String(pointer || "").split(":");
    const account = parts[0] ? await readJson("accounts/" + parts[0] + ".json") : null;
    const rows = account ? await loadRequests(account.id) : [];
    const row = rows.find((item) => item.id === parts[1]);
    if (!account || !row) return html(404, "<!DOCTYPE html><html><body><p>This link is finished.</p></body></html>");
    if (method === "POST") {
      const next = String(body.status || "");
      if (next !== "confirmed" && next !== "done" && next !== "cancelled") return json(400, { ok: false, error: "status" });
      row.status = next;
      await saveRequests(account.id, rows);
    }
    const title = row.status === "new" ? "New request" : row.status[0].toUpperCase() + row.status.slice(1);
    return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:36rem">
<h1>${mailEscape(row.service || "A job")}</h1>
<p>${mailEscape(row.firstName || "Neighbor")} · ${mailEscape(row.when || "")}</p>
<p>Status: <b id="st">${mailEscape(row.status)}</b></p>
<p>${mailEscape((row.fields && row.fields.contact) || "")}<br>${mailEscape((row.fields && row.fields.address) || "")}</p>
<button type="button" id="yes" style="font:18px system-ui;padding:12px 16px;margin-right:8px">Confirmed</button>
<button type="button" id="done" style="font:18px system-ui;padding:12px 16px">Done</button>
<script>
async function mark(status){
  const res=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status})});
  if(res.ok) document.getElementById("st").textContent=status;
}
document.getElementById("yes").onclick=()=>mark("confirmed");
document.getElementById("done").onclick=()=>mark("done");
</script>
</body></html>`);
  }

  const renewGet = route.match(/^renew\/([a-f0-9]{16,80})$/i);
  if (method === "GET" && renewGet) {
    const id = await (await store()).get("renew/" + renewGet[1]);
    const account = id ? await readJson("accounts/" + id.trim() + ".json") : null;
    if (!account) return html(404, "<!DOCTYPE html><html><body><p>This renew link is finished.</p></body></html>");
    const planId = (req.query && req.query.get && req.query.get("plan")) === "year" ? "year" : "season";
    if (paywallMode() === "stripe" && process.env.STRIPE_SECRET_KEY) {
      return html(200, "<!DOCTYPE html><html><body><p>Open the builder to pay with a card. Test mode is off.</p></body></html>");
    }
    applyPlan(account, planId);
    const offer = PLANS[planId];
    const receiptId = "pay-" + account.id + "-" + rand(4);
    await addReceipt(account, origin, {
      id: receiptId,
      plan: planId,
      planName: account.planName,
      amountLabel: offer.label,
      end: account.paidUntil
    });
    await sendReceiptNote(account, origin, receiptId);
    await saveAccount(account);
    await trackPlan(account);
    await releaseHeld(account, origin);
    return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Renewed</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:36rem"><h1>You're renewed</h1><p>${mailEscape(account.planName)} is on through ${mailEscape(niceDate(account.paidUntil))}.</p><p>Any requests that were waiting have been emailed to you.</p><p><a href="${mailEscape(accountUrl(origin))}">Your account</a></p></body></html>`);
  }

  if (method === "GET" && route === "cron/renewals") {
    const secret = process.env.CRON_SECRET || process.env.ADMIN_SECRET || "";
    const header = (req.headers && (req.headers.authorization || req.headers.Authorization || req.headers["x-cron-secret"])) || "";
    const token = String(header).replace(/^Bearer\s+/i, "");
    if (!secret || !safeEqual(token, secret)) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    const dry = !!(req.query && req.query.get && req.query.get("dry") === "1");
    const ids = (await readJson("plan-ids.json")) || [];
    const due = [];
    for (const id of ids) {
      const account = await readJson("accounts/" + id + ".json");
      if (!account || !account.paidUntil) continue;
      const days = daysUntil(account.paidUntil);
      if (days !== 14 && days !== 3 && days !== 0) continue;
      const key = days + ":" + String(account.paidUntil).slice(0, 10);
      account.sentReminders = account.sentReminders || {};
      if (account.sentReminders[key]) continue;
      if (!account.renewToken) account.renewToken = rand(16);
      await (await store()).put("renew/" + account.renewToken, account.id);
      const links = payLinks(origin, account);
      const when = days === 0 ? "today" : "in " + days + " days";
      const subject = days === 0 ? "Your Hustle Builder plan ends today" : "Your Hustle Builder plan ends in " + days + " days";
      const text = "Your " + (account.planName || "plan") + " ends " + when + ", on " + niceDate(account.paidUntil) + ".\n\nRenew in one tap.\n\n$19.99 for the season:\n" + links.season + "\n\n$29.99 for the year:\n" + links.year + "\n\nAfter the end date the page stays up for 7 days, then it shows a taking-a-break page and bookings pause.";
      due.push({ email: account.email, kind: String(days), days });
      if (!dry) {
        await sendMail({
          to: account.email,
          replyTo: supportReply(),
          forParent: true,
          origin,
          subject,
          text,
          html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>Your <b>" + mailEscape(account.planName || "plan") + "</b> ends " + when + ", on " + mailEscape(niceDate(account.paidUntil)) + ".</p><p>Renew in one tap.</p><p><a href=\"" + mailEscape(links.season) + "\">Renew, $19.99 for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Renew, $29.99 for the year</a></p><p>After the end date the page stays up for 7 days, then it shows a taking-a-break page and bookings pause.</p></div>"
        });
        account.sentReminders[key] = new Date().toISOString();
        await saveAccount(account);
      }
    }
    for (const id of ids) {
      const account = await readJson("accounts/" + id + ".json");
      if (!account || !account.trialEndsAt || paid(account) || inGrace(account)) continue;
      const used = await trialCount(account.email);
      if (used >= FREE_JOBS) continue;
      const days = daysUntil(account.trialEndsAt);
      if (days !== 3 && days !== 0) continue;
      const key = "trial-" + days + ":" + String(account.trialEndsAt).slice(0, 10);
      account.sentReminders = account.sentReminders || {};
      if (account.sentReminders[key]) continue;
      if (!account.renewToken) account.renewToken = rand(16);
      await (await store()).put("renew/" + account.renewToken, account.id);
      const links = payLinks(origin, account);
      const when = days === 0 ? "today" : "in 3 days";
      const subject = days === 0 ? "Your free trial ends today" : "Your free trial ends in 3 days";
      const text = "Your free trial ends " + when + ", on " + niceDate(account.trialEndsAt) + ".\n\nThe page then shows a taking-a-break page. Your draft and the site stay saved. Pay to bring it back.\n\n$19.99 for the season:\n" + links.season + "\n\n$29.99 for the year:\n" + links.year + "\n";
      due.push({ email: account.email, kind: "trial-" + days, days });
      if (!dry) {
        await sendMail({
          to: account.email,
          replyTo: supportReply(),
          forParent: true,
          origin,
          subject,
          text,
          html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>Your free trial ends <b>" + when + "</b>, on " + mailEscape(niceDate(account.trialEndsAt)) + ".</p><p>The page then shows a taking-a-break page. Your draft and the site stay saved. Pay in one tap to bring it back.</p><p><a href=\"" + mailEscape(links.season) + "\">Pay $19.99 for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Pay $29.99 for the year</a></p></div>"
        });
        account.sentReminders[key] = new Date().toISOString();
        await saveAccount(account);
      }
    }
    return withCors(json(200, { ok: true, dry, due }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "book") {
    const slug = String(body.slug || "").trim().toLowerCase();
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta || meta.status !== "live") return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const account = await readJson("accounts/" + meta.accountId + ".json");
    if (!account) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    if (onBreak(account)) return withCors(json(403, { ok: false, error: "break", message: "This page is taking a break. Bookings are paused." }), req.headers && req.headers.origin);
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
    if (!account.renewToken) account.renewToken = rand(16);
    await (await store()).put("renew/" + account.renewToken, account.id);
    const links = payLinks(origin, account);
    const used = await trialCount(account.email);
    const mode = (paid(account) || inGrace(account)) ? "paid" : (used < FREE_JOBS && trialClockOpen(account) ? "trial" : "hold");
    const requestId = "r" + rand(8);
    const actionToken = rand(12);
    const row = {
      id: requestId,
      actionToken,
      parentEmail: account.email,
      replyTo: reply || supportReply(),
      firstName: firstName(fields.name),
      service: fields.service,
      when: fields.when || start,
      address: fields.address,
      status: mode === "hold" ? "held" : "new",
      fields,
      ics,
      calJob: job,
      createdAt: new Date().toISOString()
    };
    await (await store()).put("jobact/" + actionToken, account.id + ":" + requestId);
    const rows = await loadRequests(account.id);
    rows.push(row);
    await saveRequests(account.id, rows);
    if (mode === "hold") {
      const heldText = "You have a new request waiting. Pay to unlock it.\n\n" + row.firstName + " asked for " + fields.service + (fields.when ? " on " + fields.when : "") + ".\n\nThe street, email, and phone stay hidden until you pay.\n\n$19.99 season:\n" + links.season + "\n\n$29.99 year:\n" + links.year + "\n";
      const held = await sendMail({
        to: account.email,
        replyTo: supportReply(),
        forParent: true,
        origin,
        subject: "You have a new request waiting",
        text: heldText,
        html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p><b>You have a new request waiting. Pay to unlock it.</b></p><p>" + mailEscape(row.firstName) + " asked for " + mailEscape(fields.service) + (fields.when ? " on " + mailEscape(fields.when) : "") + ".</p><p><a href=\"" + mailEscape(links.season) + "\">Pay $19.99 for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Pay $29.99 for the year</a></p></div>"
      });
      if (!held.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
      return withCors(json(200, { ok: true, held: true }), req.headers && req.headers.origin);
    }
    const actionUrl = (origin || "") + "/api/job/" + actionToken;
    const fullText = text + "\n\nMark it confirmed or done:\n" + actionUrl;
    const fullHtml = htmlMail.replace("</div>", "<p><a href=\"" + mailEscape(actionUrl) + "\">Mark confirmed or done</a></p></div>");
    const mailed = await sendMail({
      to: account.email,
      replyTo: reply || supportReply(),
      forParent: true,
      origin,
      subject: (hitsWords.flag ? "Check this booking: " : "Booking request: ") + (fields.service || "a job"),
      text: fullText, html: fullHtml, ics
    });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    if (job) {
      await ensureCalToken(account);
      const jobs = await loadJobs(account.id);
      jobs.push(job);
      await saveJobs(account.id, jobs);
      row.calJob = null;
      await saveRequests(account.id, rows);
    }
    if (mode === "trial") {
      const next = used + 1;
      await setTrialCount(account.email, next);
      if (next >= FREE_JOBS) {
        const trialText = "Your 3 free jobs are used up.\n\nNew requests will wait until you pick a plan.\n\n$19.99 season:\n" + links.season + "\n\n$29.99 year:\n" + links.year + "\n";
        await sendMail({
          to: account.email,
          replyTo: supportReply(),
          forParent: true,
          origin,
          subject: "Your 3 free jobs are used up",
          text: trialText,
          html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p><b>Your 3 free jobs are used up.</b></p><p>New requests will wait until you pick a plan.</p><p><a href=\"" + mailEscape(links.season) + "\">Pay $19.99 for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Pay $29.99 for the year</a></p></div>"
        });
      }
    }
    meta.bookCount = (meta.bookCount || 0) + 1;
    await writeJson("pages/" + slug + ".json", meta);
    if (reply) await notifyNeighbor({ origin, reply, fields, account, requestId });
    return withCors(json(200, { ok: true, trialLeft: mode === "trial" ? Math.max(0, FREE_JOBS - used - 1) : undefined }), req.headers && req.headers.origin);
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

  const reportReasons = {
    fake: "It is not a real kid business",
    personal: "It has personal information",
    unsafe: "It has a rude or unsafe word",
    other: "Something else"
  };
  function reportForm(slug, note) {
    const choices = Object.entries(reportReasons).map(([id, label]) => `<label style="display:block;margin:10px 0"><input type="radio" name="reason" value="${id}" required> ${label}</label>`).join("");
    return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Report this page</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:36rem"><h1>Report this page</h1><p>Tell us what is wrong. You do not need an account.</p>${note ? `<p><b>${mailEscape(note)}</b></p>` : ""}<form method="post" action="/api/report"><input type="hidden" name="slug" value="${mailEscape(slug)}">${choices}<label style="display:block;margin:14px 0">Anything else? (optional)<textarea name="details" maxlength="500" rows="4" style="display:block;width:100%;margin-top:6px;font:18px system-ui"></textarea></label><button type="submit" style="font:18px system-ui;padding:12px 16px">Send</button></form></body></html>`);
  }
  const reportGet = route.match(/^report\/([a-z0-9][a-z0-9-]{1,40})$/);
  if (method === "GET" && reportGet) {
    const meta = await readJson("pages/" + reportGet[1] + ".json");
    if (!meta) return html(404, "<!DOCTYPE html><html><body><p>That page is not here.</p></body></html>");
    return reportForm(reportGet[1], "");
  }
  if (method === "POST" && route === "report") {
    const slug = String(body.slug || "").trim().toLowerCase();
    const reason = reportReasons[body.reason] ? body.reason : "";
    const details = String(body.details || "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    const asJson = String(req.body || "").trim().startsWith("{");
    const reply = (status, payload, note) => asJson ? withCors(json(status, payload), req.headers && req.headers.origin) : reportForm(slug, note || payload.message || "");
    if (!reason) return reply(400, { ok: false, error: "reason" }, "Pick a reason, then send it.");
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta) return reply(404, { ok: false, error: "missing" }, "That page is not here.");
    const day = new Date().toISOString().slice(0, 10);
    const ip = clientIp(req) || "unknown";
    if (await countKey("reportip/" + sha(ip + "|" + day), 8)) return reply(429, { ok: false, error: "limit" }, "That's enough reports for today.");
    meta.reports = Array.isArray(meta.reports) ? meta.reports : [];
    const mark = sha(ip).slice(0, 16);
    const freshReport = !meta.reports.some((item) => item.ip === mark);
    if (freshReport) {
      meta.reports.push({ ip: mark, reason, at: new Date().toISOString() });
      await sendMail({
        to: "support@hustlebuilder.org",
        replyTo: supportReply() || "support@hustlebuilder.org",
        subject: "Page report: " + slug,
        text: "Page: " + slug + "\nReason: " + reportReasons[reason] + "\nDetails: " + (details || "none") + "\n",
        html: "<p style=\"font:18px/1.5 system-ui,sans-serif\">Page: " + mailEscape(slug) + "<br>Reason: " + mailEscape(reportReasons[reason]) + "<br>Details: " + mailEscape(details || "none") + "</p>"
      });
      if (meta.reports.length >= 3 && meta.status === "live") {
        meta.status = "review";
        if (!meta.reviewMailed) {
          const account = meta.accountId ? await readJson("accounts/" + meta.accountId + ".json") : null;
          if (account && account.email) {
            await sendMail({
              to: account.email,
              replyTo: supportReply() || "support@hustlebuilder.org",
              subject: "We hid the page while we check a report",
              text: "A few people asked us to look at the page.\n\nWe hid it for now. The page and the draft are still saved. Nothing new will be booked while it is hidden.\n\nIf this was a mistake, reply to this email.\n",
              html: "<div style=\"font:18px/1.5 system-ui,sans-serif\"><p>A few people asked us to look at the page.</p><p>We hid it for now. The page and the draft are still saved. Nothing new will be booked while it is hidden.</p><p>If this was a mistake, reply to this email.</p></div>"
            });
          }
          meta.reviewMailed = true;
        }
      }
      await writeJson("pages/" + slug + ".json", meta);
    }
    if (asJson) return withCors(json(200, { ok: true, status: meta.status, reports: meta.reports.length }), req.headers && req.headers.origin);
    return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Report sent</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:36rem"><h1>Thanks</h1><p>We got your note. You can close this page.</p></body></html>`);
  }

  if (method === "GET" && adminRoute === "admin") {
    const secret = process.env.ADMIN_SECRET || "";
    if (!secret) return adminSetupPage();
    if (await adminAuthed(req.headers)) return await adminDashboardPage(origin);
    return adminLoginPage(200, "");
  }

  if (method === "POST" && adminRoute === "admin/login") {
    const secret = process.env.ADMIN_SECRET || "";
    if (!secret) return adminSetupPage();
    // Every try from one address counts, right or wrong: 10 an hour is plenty
    // for the operator and far too slow for guessing. Mirrors the countKey
    // limits on auth/start, with an hour bucket instead of a day.
    const hour = new Date().toISOString().slice(0, 13);
    if (await countKey("adminip/" + sha(clientIp(req) + "|" + hour), 10)) return adminLoginPage(429, "Too many tries. Wait an hour, then try again.");
    if (!safeEqual(String(body.secret || ""), secret)) return adminLoginPage(401, "That password did not work.");
    const token = await issueAdminSession();
    return { status: 302, headers: { location: "/admin", "cache-control": "no-store", "set-cookie": adminCookieHeader(token) }, body: "" };
  }

  if (method === "POST" && adminRoute === "admin/logout") {
    await dropAdminSession(req.headers);
    return { status: 302, headers: { location: "/admin", "cache-control": "no-store", "set-cookie": clearAdminCookieHeader() }, body: "" };
  }

  if (method === "POST" && route === "admin/restore") {
    const secret = process.env.ADMIN_SECRET || "";
    const given = (req.headers && (req.headers["x-admin-secret"] || req.headers["X-Admin-Secret"])) || "";
    if (!secret) return withCors(json(503, { ok: false, error: "admin" }), req.headers && req.headers.origin);
    if (!safeEqual(given, secret)) return withCors(json(401, { ok: false, error: "admin" }), req.headers && req.headers.origin);
    const slug = String(body.slug || "").trim().toLowerCase();
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    if (meta.status === "review") meta.status = "live";
    meta.reports = [];
    meta.reviewMailed = false;
    meta.restoredAt = new Date().toISOString();
    await writeJson("pages/" + slug + ".json", meta);
    return withCors(json(200, { ok: true, slug, status: meta.status }), req.headers && req.headers.origin);
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

  if (method === "GET" && route === "account") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    await ensureRenew(account);
    await saveAccount(account);
    const used = await trialCount(account.email);
    const sites = [];
    if (account.slug) {
      const meta = await readJson("pages/" + account.slug + ".json") || {};
      const rows = await loadRequests(account.id);
      sites.push({
        slug: account.slug,
        url: (origin || "") + "/" + account.slug,
        status: meta.status || "offline",
        plan: account.plan || "",
        planName: account.planName || (paid(account) ? "Paid plan" : "Free trial"),
        paid: paid(account),
        paidUntil: account.paidUntil || "",
        paidUntilLabel: account.paidUntil ? niceDate(account.paidUntil) : "",
        grace: inGrace(account),
        graceDays: graceLeftDays(account),
        trialDaysLeft: trialDaysLeft(account),
        trialLeft: Math.max(0, FREE_JOBS - used),
        trialDays: trialLengthDays(),
        trialEndsLabel: account.trialEndsAt ? niceDate(account.trialEndsAt) : "",
        trialOver: trialOver(account, used),
        renew: payLinks(origin, account),
        receipts: (account.receipts || []).slice(-12).map((item) => ({
          id: item.id, plan: item.planName || item.plan || "", amount: item.amountLabel || "", at: item.at || "", end: item.endLabel || "", url: item.url || ""
        })),
        requests: rows.slice(-20).reverse().map((row) => ({
          service: row.service || "A job",
          when: row.when || "",
          firstName: row.firstName || "Neighbor",
          status: row.status || "new"
        }))
      });
    }
    return withCors(json(200, { ok: true, email: account.email, accountUrl: accountUrl(origin), sites }), req.headers && req.headers.origin);
  }

  if (method === "GET" && route === "views") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    // Only ever the caller's own page: the slug comes from their account,
    // never from the request, so nobody can read another family's count.
    const slug = String(account.slug || "").trim().toLowerCase();
    if (!slug) return withCors(json(200, { ok: true, slug: "", total: 0, last7: 0 }), req.headers && req.headers.origin);
    const counts = await viewCounts(slug);
    return withCors(json(200, { ok: true, slug, total: counts.total, last7: counts.last7 }), req.headers && req.headers.origin);
  }

  if (method === "POST" && (route === "account/pause" || route === "account/resume")) {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    const slug = String(body.slug || account.slug || "").trim().toLowerCase();
    if (!account.slug || slug !== account.slug) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const meta = await readJson("pages/" + slug + ".json");
    if (!meta || meta.accountId !== account.id) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    if (meta.status === "down") return withCors(json(403, { ok: false, error: "down" }), req.headers && req.headers.origin);
    if (route === "account/pause") {
      if (meta.status === "live") meta.status = "paused";
    } else if (meta.status === "paused") {
      const page = await (await store()).get("pages/" + slug + ".html");
      meta.status = page ? "live" : "offline";
    }
    await writeJson("pages/" + slug + ".json", meta);
    return withCors(json(200, { ok: true, slug, status: meta.status }), req.headers && req.headers.origin);
  }

  const receiptGet = route.match(/^receipt\/([a-z0-9-]{6,80})$/i);
  if (method === "GET" && receiptGet) {
    const rec = await readJson("receipts/" + receiptGet[1].toLowerCase() + ".json");
    if (!rec) return html(404, "<!DOCTYPE html><html><body><p>That receipt is not here.</p></body></html>");
    return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Receipt</title></head><body style="font:18px/1.5 system-ui,sans-serif;margin:1.5rem;max-width:36rem"><h1>Receipt</h1><p>${mailEscape(rec.planName || "Hustle Builder")}</p><p><b>${mailEscape(rec.amountLabel || "")}</b></p><p>Through ${mailEscape(rec.endLabel || "")}.</p><p>Hustle Builder. This is not a card statement.</p></body></html>`);
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
