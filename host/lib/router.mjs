import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { DEFAULT_TZ, bookingInviteIcs, feedLinks, gcalTemplate, inviteSummary, jobInstant, jobTitle, jobsToIcs, pruneJobs, validTz } from "./calendar.mjs";
import { cardPng, iconPng } from "./card.mjs";
import { checkPage, checkSlug, pageOk, wordHits } from "./moderate.mjs";
import { decoratePage, hidePhone, stripParentContact } from "./preview.mjs";
import { store, transaction } from "./store.mjs";
import {queueMail,flushMail,withMailBatch} from "./mail.mjs";
import QRCode from "qrcode";

export const PLANS = {
  season: { id: "season", amount: 999, label: "$9.99" },
  year: { id: "year", amount: 1999, label: "$19.99" }
};
export const CONSENT_VERSION = "2026-11-10-card";
// A one-time parent check. Stripe emails the receipt, then we refund it in full.
// Not a plan payment, and not a new environment variable.
export const VERIFY_CENTS = 50;
// Stripe joins the account prefix, "* ", and this suffix. KEYSTONE* HUSTLE BLDR is 21 characters, under the 22-character card line.
export const STATEMENT_SUFFIX = "HUSTLE BLDR";
// Booking counts are analytics only; trial access is based on its end date.
export const GRACE_DAYS = 7;
export const TRIAL_DAYS = 14;

export function trialLengthDays() {
  const raw = process.env.TRIAL_DAYS;
  if (raw == null || String(raw).trim() === "") return TRIAL_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 1 || days > 366) return TRIAL_DAYS;
  return Math.floor(days);
}

export function trialBlurb() {
  return "Your website, booking requests, and flyer downloads are included for " + trialLengthDays() + " days after first publish. After that, a parent chooses a plan to continue. You are never charged automatically.";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function niceDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}

// A season is sold by its end date. Someone who buys (or renews) in the last
// weeks of a season would pay full price for a few days, so once fewer than
// SEASON_MIN_DAYS remain the offer is the NEXT season: the page is covered
// from today through that later end date for the same price.
export const SEASON_MIN_DAYS = 30;
export function seasonOffer(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const end = (yy, month, day) => new Date(Date.UTC(yy, month, day, 23, 59, 59)).toISOString();
  const summer = (yy) => ({
    id: "summer",
    name: "Summer season, May–Aug",
    end: end(yy, 7, 31),
    includes: "The page stays online, neighbors can book, and booking emails go to you through August 31, " + yy + "."
  });
  const winter = (endYear) => ({
    id: "winter",
    name: "Winter season, Nov–Mar",
    end: end(endYear, 2, 31),
    includes: "The page stays online, neighbors can book, and booking emails go to you through March 31, " + endYear + "."
  });
  const tooShort = (offer) => Date.parse(offer.end) - now.getTime() < SEASON_MIN_DAYS * 864e5;
  if (m >= 3 && m <= 7) {
    const offer = summer(y);
    return tooShort(offer) ? winter(y + 1) : offer;
  }
  const endYear = m >= 8 ? y + 1 : y;
  const offer = winter(endYear);
  return tooShort(offer) ? summer(endYear) : offer;
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

function reminderBucket(days, withEarly) {
  if (days === 0) return 0;
  if (days >= 1 && days <= 3) return 3;
  if (withEarly && days >= 4 && days <= 14) return 14;
  return null;
}
function daysWords(days) {
  return days === 0 ? "today" : days === 1 ? "tomorrow" : "in " + days + " days";
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
function paywallMode() { return testMode() ? (process.env.PAYWALL_MODE || "test") : "stripe"; }

function emailOk(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 120) return "";
  return e;
}

// Gmail ignores dots and +tags, and googlemail.com is the same inbox.
// The trial follows that inbox, not the spelling used at sign-in.
export function canonicalEmail(email) {
  const e = emailOk(email);
  if (!e) return "";
  const at = e.lastIndexOf("@");
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split("+")[0].replace(/\./g, "");
  return local + "@" + domain;
}

function trialKey(email) {
  const canon = canonicalEmail(email);
  return canon ? "trials/" + sha(canon) + ".json" : "";
}

function json(status, body, extra = {}) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control":"no-store", "x-content-type-options":"nosniff", ...extra }, body: JSON.stringify(body) };
}

// Every host-made HTML page: never framed by another site (the job, cancel
// and admin pages carry buttons), and never leaks its own address — several
// of those addresses are private links — to a site the visitor clicks out to.
function html(status, markup) {
  return { status, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" }, body: markup };
}

// One look for the small pages the host writes itself (taking a break, cancel
// a request, a receipt, the privacy notice ...). Inline styles only: these are
// also served under the published-page sandbox, which allows nothing else.
const SHELL_CSS = "body{margin:0;background:#f4f1ec;color:#1d2226;font:18px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}"
  + ".hb-top{background:#14181d;border-bottom:3px solid #ff5b14;padding:12px 16px}"
  + ".hb-top a{color:#fff;text-decoration:none;font-weight:800;letter-spacing:.02em}"
  + "main{max-width:38rem;margin:1.5rem auto;padding:1.5rem 1.25rem 2rem;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.12)}"
  + "main.wide{max-width:46rem}"
  + "h1{font-size:1.6rem;line-height:1.2;margin:0 0 .75rem}h2{font-size:1.15rem;margin:1.6rem 0 .4rem}"
  + "a{color:#b43c00}p{margin:.6rem 0}"
  + "button,.hb-btn{font:700 18px system-ui,sans-serif;padding:13px 18px;border-radius:10px;border:2px solid #14181d;background:#14181d;color:#fff;cursor:pointer;margin:6px 8px 6px 0;text-decoration:none;display:inline-block}"
  + "button.alt{background:#fff;color:#14181d}"
  + "textarea,input[type=text]{display:block;width:100%;box-sizing:border-box;margin-top:6px;font:18px system-ui,sans-serif;padding:10px;border:1px solid #8a949e;border-radius:8px}"
  + ".hb-foot{max-width:38rem;margin:0 auto 2rem;padding:0 1.25rem;font-size:14px;color:#5a6672}.hb-foot a{color:#5a6672}"
  + "@media (max-width:480px){main{margin:0;border-radius:0;box-shadow:none}}";
function shell(status, title, inner, opts = {}) {
    return html(status, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${mailEscape(title)}</title><style>${SHELL_CSS}</style></head><body>
<div class="hb-top"><a href="/">Hustle Builder</a></div>
<main${opts.wide ? ' class="wide"' : ""}>${inner}</main>
<p class="hb-foot"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
</body></html>`);
}
const SUPPORT_EMAIL = "support@hustlebuilder.org";

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
  if (!account || account.sessionVersion!==2 || !safeEqual(account.tokenHash || "", sha(token))) return null;
  if (account.sessionExpiresAt && Number(account.sessionExpiresAt) <= Date.now()) return null;
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
  await writeJson("adminsessions/" + sha(token) + ".json", { exp: Date.now() + ADMIN_COOKIE_MAX_AGE * 1000, version:2 });
  return token;
}
async function adminAuthed(headers) {
  const token = cookieValue(headers && (headers.cookie || headers.Cookie), ADMIN_COOKIE);
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const key = "adminsessions/" + sha(token) + ".json";
  const rec = await readJson(key);
  if (!rec || rec.version!==2) return false;
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
  // Keep the later end. A denied card on a second login must not shorten
  // a trial that the same Gmail inbox already has.
  if(account.trialEndsAt){
    const key=trialKey(account.email);
    if(key){
      const old=await readJson(key)||{};
      const oldEnd=Date.parse(old.trialEndsAt||"");
      const newEnd=Date.parse(account.trialEndsAt);
      const deniedShorten=account.trialDenied&&Number.isFinite(oldEnd)&&Number.isFinite(newEnd)&&oldEnd>newEnd;
      if(!deniedShorten){
        await writeJson(key,{...old,trialStartedAt:account.trialStartedAt,trialEndsAt:account.trialEndsAt});
      }
    }
  }
  await writeJson("accounts/" + account.id + ".json", account);
  await (await store()).put("email/" + sha(account.email), account.id);
  if (account.tokenHash) await (await store()).put("tokens/" + account.tokenHash, account.id);
}

// Friends & family comp: the operator can mark an account free with no
// payment and no end date (account.comp, set only from the admin view —
// there is no self-serve path). The flag is honored inside these paywall
// helpers, so a comped account counts as paid everywhere the state is
// decided: its page never pauses for payment reasons, no trial clock
// applies, and the renewal cron skips it entirely.
function comped(account) {
  return !!(account && account.comp === true);
}

function paid(account, now = Date.now()) {
  if (comped(account)) return true;
  return !!(account && account.paidUntil && Date.parse(account.paidUntil) > now);
}

// The page can go online only after a finished parent check: a refunded 50¢
// card charge, or a real plan payment. A checkbox by itself is not enough.
function consentReady(account) {
  if (!account || !account.consentAt) return false;
  if (account.consentMethod === "plan_payment") return true;
  if (account.consentMethod === "card_charge") return !!account.consentRefundedAt;
  return false;
}

function markPlanConsent(account, paymentIntent) {
  if (!account) return;
  if (account.consentMethod === "card_charge" && account.consentAt && account.consentRefundedAt) return;
  if (!account.consentAt) account.consentAt = new Date().toISOString();
  account.consentMethod = "plan_payment";
  account.consentVersion = account.consentVersion || CONSENT_VERSION;
  account.noticeAcceptedAt = account.noticeAcceptedAt || account.consentAt;
  if (/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntent || ""))) account.consentPaymentIntent = paymentIntent;
}

// A plan can be bought when nothing is paid, and renewed early once it is
// inside its last RENEW_WINDOW_DAYS (the reminder emails go out in that
// window). An early renewal is added on to the current end date, so no paid
// time is lost. A plan with more time left than that has nothing to buy yet.
export const RENEW_WINDOW_DAYS = 30;
// The promise on the Terms page: a full refund when asked within this many
// days of a payment. The operator issues it from the admin view.
export const REFUND_DAYS = 14;
function renewable(account, now = Date.now()) {
  if (!account || comped(account)) return false;
  if (!paid(account, now)) return true;
  return Date.parse(account.paidUntil) - now <= RENEW_WINDOW_DAYS * 864e5;
}
// The 14 days start at parent consent or at first publish, whichever
// happens first. Opening a checkout, paid or not, does not start them.
function beginTrial(account, now = Date.now()) {
  if (!account || account.trialDenied || account.trialEndsAt) return false;
  account.trialStartedAt = new Date(now).toISOString();
  account.trialEndsAt = new Date(now + trialLengthDays() * 864e5).toISOString();
  return true;
}

// A card that already started a trial cannot start another one, even under
// a new email. The parent goes straight to a paid plan.
function denyTrial(account, now = Date.now()) {
  if (!account || account.trialEndsAt) return;
  account.trialDenied = "card";
  const past = new Date(now - 1000).toISOString();
  account.trialStartedAt = past;
  account.trialEndsAt = past;
}

function fingerprintOk(value) {
  return /^[A-Za-z0-9]{8,40}$/.test(String(value || "")) ? String(value) : "";
}

async function cardTrialUsed(fingerprint) {
  const fp = fingerprintOk(fingerprint);
  if (!fp) return false;
  return !!(await readJson("cardtrials/" + fp + ".json"));
}

async function noteCardTrial(account) {
  const fp = fingerprintOk(account && account.cardFingerprint);
  if (!fp || !account.trialEndsAt || account.trialDenied) return;
  const key = "cardtrials/" + fp + ".json";
  if (await readJson(key)) return;
  await writeJson(key, { at: new Date().toISOString(), trialEndsAt: account.trialEndsAt });
}

async function applyConsentTrial(account, fingerprint) {
  const fp = fingerprintOk(fingerprint);
  if (fp) account.cardFingerprint = fp;
  if (account.trialEndsAt || account.trialDenied) {
    await noteCardTrial(account);
    return;
  }
  if (fp && await cardTrialUsed(fp)) {
    denyTrial(account);
    return;
  }
  beginTrial(account);
  await noteCardTrial(account);
}

async function cardFingerprintFromSession(session) {
  const pi = session && session.payment_intent;
  const inline = pi && typeof pi === "object" && pi.payment_method && typeof pi.payment_method === "object"
    ? pi.payment_method.card && pi.payment_method.card.fingerprint : "";
  const ready = fingerprintOk(inline);
  if (ready) return ready;
  const id = paymentIntentId(session);
  if (!id || paywallMode() !== "stripe" || !process.env.STRIPE_SECRET_KEY) return "";
  try {
    const r = await fetch("https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(id) + "?expand[]=payment_method", {
      headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return "";
    const data = await r.json();
    const method = data && data.payment_method;
    const fp = method && typeof method === "object" ? method.card && method.card.fingerprint : "";
    return fingerprintOk(fp);
  } catch { return ""; }
}

function planBase(account, now = Date.now()) {
  return paid(account, now) && !comped(account) ? new Date(account.paidUntil) : new Date(now);
}

// Family plan: one account can hold several kid pages under its single
// trial/payment. account.slug stays the first (primary) address — payloads
// and older records speak of it in the singular — and account.slugs is the
// full set. Accounts written before the family plan carry only the single
// field, so reads derive the set from both and writes keep the array in
// step. A page record (pages/<slug>.json) names its account in accountId
// and stays the lookup of record for which family a page belongs to.
function slugsOf(account) {
  const set = [];
  const push = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s && !set.includes(s)) set.push(s);
  };
  if (account) {
    if (Array.isArray(account.slugs)) account.slugs.forEach(push);
    push(account.slug);
  }
  return set;
}

function addAccountSlug(account, slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return;
  const set = slugsOf(account);
  if (!set.includes(s)) set.push(s);
  account.slugs = set;
  if (!account.slug) account.slug = s;
}

function swapAccountSlug(account, from, next) {
  const set = slugsOf(account).map((s) => (s === from ? next : s));
  account.slugs = [...new Set(set)];
  if (account.slug === from) account.slug = next;
}

function graceLeftDays(account, now = Date.now()) {
  const end = Date.parse(account && account.paidUntil || "");
  if (!Number.isFinite(end) || end > now) return 0;
  const left = end + GRACE_DAYS * 864e5 - now;
  if (left <= 0) return 0;
  return Math.max(1, Math.ceil(left / 864e5));
}

function inGrace(account, now = Date.now()) {
  if (comped(account)) return false;
  return graceLeftDays(account, now) > 0;
}

function onBreak(account, now = Date.now()) {
  if (comped(account)) return false;
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
  if (!account.trialEndsAt && slugsOf(account).length === 0) return false;
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
  await writeJson("trials/" + sha(email) + ".json", { ...(await readJson("trials/"+sha(email)+".json")||{}), used, at: new Date().toISOString() });
}

async function rememberAccount(account) {
  if(account?.id)await (await store()).put('planacct/'+account.id,account.id);
}
async function trackedAccounts() {
  const s=await store();
  return [...new Set([...(await readJson('plan-ids.json')||[]),...(await s.list('planacct/')).map(k=>k.slice(9))])];
}

async function trackPlan(account) {
  if (!account || !account.paidUntil) return;
  await rememberAccount(account);
}

const REQUEST_KEEP_MS=30*864e5;
async function removeRequestArtifacts(row,accountId) {
  const s=await store();
  if(row.actionToken)await s.del('jobact/'+row.actionToken);
  if(row.cancelToken)await s.del('cancels/'+row.cancelToken+'.json');
  if(row.idempotencyKey)await s.del('bookingids/'+accountId+'/'+row.idempotencyKey);
}
async function loadRequests(accountId) {
  const rows=(await readJson('requests/'+accountId+'.json'))||[],keep=[];
  for(const row of rows){if(Date.parse(row.createdAt)>Date.now()-REQUEST_KEEP_MS)keep.push(row);else await removeRequestArtifacts(row,accountId);}
  if(keep.length!==rows.length)await saveRequests(accountId,keep);
  return keep;
}

async function saveRequests(accountId, rows) {
  await writeJson("requests/" + accountId + ".json", rows);
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

// Job prices a neighbor would see. A number over $999 is refused at publish
// so a typo like $10000 cannot go live. An already published page is left
// as it is until the family publishes again.
export function pricesOverMax(html) {
  const found = [];
  const re = /\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]{1,2})?)/g;
  let match;
  const text = String(html || "");
  while ((match = re.exec(text))) {
    const n = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 999) found.push("$" + match[1]);
    if (found.length > 4) break;
  }
  return found;
}

async function checkoutSlug(account, raw) {
  const slug = String(raw || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return "";
  const meta = await readJson("pages/" + slug + ".json");
  if (meta && meta.accountId && meta.accountId !== account.id) return "";
  return slug;
}

function payLinks(origin, account) {
  const base = (origin || "") + "/api/renew/" + account.renewToken;
  return { season: base + "?plan=season", year: base + "?plan=year" };
}

// Apply a plan and report what it changed: the plan state from just before
// (so a refund can put it back) and how much time this payment added.
function grantPlan(account, planId) {
  const prev = { paidUntil: account.paidUntil || null, plan: account.plan || null, planName: account.planName || null };
  const base = planBase(account);
  applyPlan(account, planId, base);
  return { prev, addedMs: Math.max(0, Date.parse(account.paidUntil) - base.getTime()) };
}

// Undo one payment: used when it is refunded or disputed. If it was the most
// recent payment the account goes back to exactly how it was before it (a
// trial that still had time resumes; a lapsed plan is lapsed again). If a
// later payment sits on top of it, only the time it added is taken off.
// Returns false when there is nothing to undo (unknown or already undone).
async function revokeReceipt(account, receiptId, reason, origin) {
  const list = Array.isArray(account.receipts) ? account.receipts : [];
  const item = list.find((r) => r && r.id === receiptId);
  if (!item || item.refundedAt) return false;
  const live = list.filter((r) => r && !r.refundedAt);
  if (live[live.length - 1] === item) {
    const prev = item.prev || {};
    account.paidUntil = prev.paidUntil || null;
    account.plan = prev.plan || null;
    account.planName = prev.planName || null;
  } else if (Number(item.addedMs) > 0 && account.paidUntil) {
    account.paidUntil = new Date(Date.parse(account.paidUntil) - Number(item.addedMs)).toISOString();
  }
  item.refundedAt = new Date().toISOString();
  item.refundReason = reason === "dispute" ? "dispute" : "refund";
  const stored = await readJson("receipts/" + item.id + ".json");
  if (stored) await writeJson("receipts/" + item.id + ".json", { ...stored, refundedAt: item.refundedAt, refundReason: item.refundReason });
  await saveAccount(account);
  const link = accountUrl(origin);
  const state = paid(account) ? "Your page stays on through " + niceDate(account.paidUntil) + "." : "The page now shows a taking-a-break note unless your free trial still has time. Nothing is deleted, and you can pick a plan again any time.";
  const lead = reason === "dispute"
    ? "A payment for your Hustle Builder plan was disputed with the card company, so the plan it paid for has ended."
    : "We refunded " + (item.amountLabel || "your payment") + " for " + (item.planName || "your plan") + ". It can take 5 to 10 business days to show on your card. The plan it paid for has ended.";
  await sendOnce("sentmail/refund-" + item.id, {
    to: account.email,
    replyTo: supportReply() || SUPPORT_EMAIL,
    subject: reason === "dispute" ? "Your Hustle Builder plan has ended" : "Your Hustle Builder refund",
    text: lead + "\n\n" + state + "\n\nYour account:\n" + link + "\n",
    html: "<div style=\"font:18px/1.5 system-ui,sans-serif;color:#1d2226\"><p>" + mailEscape(lead) + "</p><p>" + mailEscape(state) + "</p><p><a href=\"" + mailEscape(link) + "\">Your account</a></p></div>"
  });
  return true;
}

// The Stripe payment behind a receipt. New receipts carry it; for a payment
// taken before receipts did, the most recent one can still be found through
// the checkout session the account remembers.
async function receiptPaymentIntent(account, item) {
  if (/^pi_[A-Za-z0-9_]+$/.test(String(item.paymentIntent || ""))) return item.paymentIntent;
  const sessionId = item.sessionId || (item.id === "stripe-" + String(account.lastPaidSessionId || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60) ? account.lastPaidSessionId : "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || "")) || !process.env.STRIPE_SECRET_KEY) return "";
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId), { headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return "";
    const pi = String((await r.json()).payment_intent || "");
    return /^pi_[A-Za-z0-9_]+$/.test(pi) ? pi : "";
  } catch { return ""; }
}

async function addReceipt(account, origin, { id, plan, planName, amountLabel, end, stripeUrl, extra }) {
  id = String(id || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!id) return;
  account.receipts = Array.isArray(account.receipts) ? account.receipts : [];
  if (account.receipts.some((item) => item.id === id)) return;
  const url = stripeUrl || ((origin || "") + "/api/receipt/" + id);
  const rec = {
    id, plan, planName: planName || plan, amountLabel,
    at: new Date().toISOString(),
    endLabel: end ? niceDate(end) : "",
    url,
    ...(extra || {})
  };
  account.receipts.push(rec);
  await writeJson("receipts/" + id + ".json", { ...rec, accountId: account.id });
}

// Turn one paid Stripe Checkout session into plan time. Used by the signed
// webhook and by the parent's own return from Stripe (the session is then
// fetched from Stripe with the secret key, so it is just as trustworthy) —
// whichever arrives first does the work and the payments ledger makes the
// other a no-op. Returns "" when applied, or the reason it was refused.
const receiptIdFor = (sessionId) => "stripe-" + String(sessionId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
async function fulfillPaidSession(account, session, origin, eventId) {
  const meta = session.metadata || {};
  const plan = Object.hasOwn(PLANS, meta.plan) ? PLANS[meta.plan] : null;
  if (session.payment_status !== "paid") return "unpaid";
  if (!plan || session.amount_total !== plan.amount || session.currency !== "usd") return "payment";
  if (!account.checkoutSessionId || account.checkoutSessionId !== session.id) return "session";
  if (meta.accountId !== account.id || meta.attempt !== sha("checkout:" + account.id + ":" + (account.checkoutGeneration || 0)) || account.checkoutPlan !== plan.id) return "session";
  const change = grantPlan(account, plan.id);
  const paymentIntent = /^pi_[A-Za-z0-9_]+$/.test(String(session.payment_intent || "")) ? session.payment_intent : "";
  markPlanConsent(account, paymentIntent);
  account.payMode = "stripe";
  account.checkoutPendingAt = "";
  // Keep payment deduplication in its own ledger; leave the next renewal available.
  account.lastPaidSessionId = session.id;
  account.checkoutSessionId = ""; account.checkoutUrl = ""; account.checkoutPlan = "";
  account.checkoutGeneration = (account.checkoutGeneration || 0) + 1;
  const pageSlug = /^[a-z0-9][a-z0-9-]{1,40}$/.test(String(meta.slug || "")) ? String(meta.slug) : "";
  await addReceipt(account, origin, { id: receiptIdFor(session.id), plan: plan.id, planName: account.planName, amountLabel: plan.label, end: account.paidUntil, stripeUrl: "", extra: { ...change, sessionId: session.id, ...(pageSlug ? { slug: pageSlug } : {}), ...(paymentIntent ? { paymentIntent } : {}) } });
  if (paymentIntent) await writeJson("payintents/" + paymentIntent + ".json", { accountId: account.id, receiptId: receiptIdFor(session.id) });
  await sendReceiptNote(account, origin, session.id);
  await saveAccount(account); await trackPlan(account); await releaseHeld(account, origin);
  await noteFunnel("plan_paid");
  await writeJson("payments/" + sha(session.id) + ".json", { eventId: eventId || "", sessionId: session.id, processedAt: new Date().toISOString() });
  return "";
}

// Ask Stripe about the account's open checkout session, and finish it here
// if it has been paid. "paid" | "pending" (paid for but not settled yet) |
// "open" (with the session) | "expired" | "none" | "error".
async function checkOpenCheckout(account, origin) {
  if (!account.checkoutSessionId) return { state: "none" };
  if (!process.env.STRIPE_SECRET_KEY) return { state: "error" };
  let session;
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(account.checkoutSessionId), { headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { state: "error" };
    session = await r.json();
  } catch { return { state: "error" }; }
  if (session.status === "complete") {
    if (await readJson("payments/" + sha(session.id) + ".json")) return { state: "paid" };
    const refused = await fulfillPaidSession(account, session, origin, "return");
    return { state: refused ? "pending" : "paid" };
  }
  if (session.status === "open" && session.url) return { state: "open", session };
  if (session.status === "expired") return { state: "expired" };
  return { state: "error" };
}

async function paymentFromStripe(paymentIntent) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions?limit=1&payment_intent=" + encodeURIComponent(paymentIntent), { headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const session = ((await r.json()).data || [])[0];
    const accountId = session && session.metadata && session.metadata.accountId;
    if (!session || !/^cs_[A-Za-z0-9_]+$/.test(String(session.id || "")) || !/^[a-f0-9]{16}$/.test(String(accountId || ""))) return null;
    if (session.metadata.purpose === "parent_verification") return { accountId, purpose: "parent_verification" };
    return { accountId, receiptId: receiptIdFor(session.id) };
  } catch { return null; }
}

function paymentIntentId(session) {
  const raw = session && session.payment_intent;
  const id = raw && typeof raw === "object" ? raw.id : raw;
  return /^pi_[A-Za-z0-9_]+$/.test(String(id || "")) ? String(id) : "";
}

async function fetchCheckoutSession(id) {
  if (!process.env.STRIPE_SECRET_KEY || !/^cs_[A-Za-z0-9_]+$/.test(String(id || ""))) return null;
  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Refund the 50¢ parent check. The idempotency key makes the webhook and the
// browser return issue one refund. Test mode never calls Stripe.
async function refundVerificationCharge(paymentIntent) {
  if (!/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntent || ""))) return false;
  if (paywallMode() !== "stripe" || !process.env.STRIPE_SECRET_KEY) return true;
  const params = new URLSearchParams();
  params.set("payment_intent", paymentIntent);
  params.set("reason", "requested_by_customer");
  params.set("metadata[purpose]", "parent_verification");
  try {
    const r = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": "hb-verify-refund-" + paymentIntent
      },
      body: params,
      signal: AbortSignal.timeout(8000)
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return true;
    return !!(data && data.error && data.error.code === "charge_already_refunded");
  } catch { return false; }
}

// Mark the parent verified only after the 50¢ charge is refunded. Stores the
// method, time, payment intent id, and notice version. No card data.
async function completeVerification(account, session) {
  const meta = session.metadata || {};
  if (meta.purpose !== "parent_verification") return "purpose";
  if (session.payment_status !== "paid") return "unpaid";
  if (Number(session.amount_total) !== VERIFY_CENTS || session.currency !== "usd") return "payment";
  if (meta.accountId !== account.id) return "account";
  const pi = paymentIntentId(session);
  if (!pi) return "payment";
  const ledgerKey = "payments/" + sha("verify:" + session.id) + ".json";
  if (await readJson(ledgerKey)) {
    if (consentReady(account)) return "";
  }
  await writeJson("payintents/" + pi + ".json", { accountId: account.id, purpose: "parent_verification" });
  const refunded = await refundVerificationCharge(pi);
  if (!refunded) return "refund";
  const now = new Date().toISOString();
  const firstPass = !(account.consentMethod === "card_charge" && account.consentAt && account.consentRefundedAt) && account.consentMethod !== "plan_payment";
  if (firstPass) {
    account.consentAt = account.consentAt || now;
    account.consentMethod = "card_charge";
    account.consentVersion = String(meta.notice || CONSENT_VERSION);
    account.consentPaymentIntent = pi;
    account.consentRefundedAt = now;
    account.noticeAcceptedAt = account.noticeAcceptedAt || now;
  } else if (account.consentMethod === "card_charge" && !account.consentRefundedAt) {
    account.consentRefundedAt = now;
    account.consentPaymentIntent = account.consentPaymentIntent || pi;
  }
  account.verifySessionId = "";
  account.verifyCheckoutUrl = "";
  if (firstPass) await applyConsentTrial(account, await cardFingerprintFromSession(session));
  await saveAccount(account);
  if (firstPass) await noteFunnel("check_passed");
  await writeJson(ledgerKey, { sessionId: session.id, purpose: "parent_verification", paymentIntent: pi, processedAt: now });
  return "";
}

async function beginCardCheck(account, origin) {
  if (!process.env.STRIPE_SECRET_KEY) return { error: "stripe-key" };
  const providerHeaders = { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY };
  if (account.verifySessionId) {
    const existing = await fetchCheckoutSession(account.verifySessionId);
    if (!existing) return { error: "stripe" };
    if (existing.status === "complete" && existing.payment_status === "paid") {
      const refused = await completeVerification(account, existing);
      if (refused) return { error: refused };
      return { consent: true };
    }
    if (existing.status === "open" && existing.url) return { url: existing.url, reused: true };
    account.verifyGeneration = (account.verifyGeneration || 0) + 1;
    account.verifySessionId = "";
    account.verifyCheckoutUrl = "";
  }
  const attempt = sha("verify:" + account.id + ":" + (account.verifyGeneration || 0));
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("customer_email", account.email);
  params.set("success_url", origin + "/?consent=paid");
  params.set("cancel_url", origin + "/?consent=cancel");
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(VERIFY_CENTS));
  params.set("line_items[0][price_data][product_data][name]", "Hustle Builder parent check, 50¢, refunded right away");
  params.set("metadata[accountId]", account.id);
  params.set("metadata[purpose]", "parent_verification");
  params.set("metadata[notice]", CONSENT_VERSION);
  params.set("payment_intent_data[receipt_email]", account.email);
  params.set("payment_intent_data[description]", "Hustle Builder parent check, 50¢, refunded right away");
  params.set("payment_intent_data[statement_descriptor_suffix]", STATEMENT_SUFFIX);
  params.set("payment_intent_data[metadata][purpose]", "parent_verification");
  params.set("payment_intent_data[metadata][accountId]", account.id);
  params.set("payment_intent_data[metadata][notice]", CONSENT_VERSION);
  let response, data;
  try {
    response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { ...providerHeaders, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": "hb-verify-" + attempt },
      body: params,
      signal: AbortSignal.timeout(8000)
    });
    data = await response.json();
  } catch {
    await saveAccount(account);
    return { error: "stripe" };
  }
  if (!response.ok || !data.url || !data.id) {
    await saveAccount(account);
    return { error: "stripe" };
  }
  account.verifySessionId = data.id;
  account.verifyCheckoutUrl = data.url;
  await saveAccount(account);
  return { url: data.url };
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
    changed = true;
    await ensureCalToken(account);
    const mailed = await sendMail(parentBookingMail(row, origin, account));
    if(mailed.ok)row.status="new";
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

function calendarPitch(origin, account) {
  if (!account || !account.calToken) return { text: "", html: "" };
  const links = feedLinks(origin, account.calToken);
  return {
    text: "Add every job to the family calendar:\n" + links.calGoogle + "\n",
    html: "<p><a href=\"" + mailEscape(links.calGoogle) + "\">Add the family calendar to Google Calendar</a></p>"
  };
}
function parentBookingMail(row, origin, account) {
  const fields = row.fields || {};
  const action = (origin || "") + "/api/job/" + row.actionToken;
  const pitch = calendarPitch(origin, account);
  const text = [
    "New booking request. Nothing is booked until you reply to the customer.",
    "Mark it confirmed or done: " + action,
    "",
    "Name: " + (fields.name || row.firstName),
    "Reach them at: " + (fields.contact || ""),
    "Job: " + (fields.service || row.service),
    "When: " + (fields.when || row.when),
    "Address: " + (fields.address || ""),
    "Note: " + (fields.note || "none"),
    "",
    pitch.text
  ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
  const htmlMail = "<div style=\"font:18px/1.45 system-ui,sans-serif\">"
    + "<p>New booking request. Nothing is booked until you reply to the customer.</p>"
    + "<p><a href=\"" + mailEscape(action) + "\">Mark confirmed or done</a></p>"
    + "<p>Name: " + mailEscape(fields.name || row.firstName) + "<br>Reach them at: " + mailEscape(fields.contact || "")
    + "<br>Job: " + mailEscape(fields.service || row.service) + "<br>When: " + mailEscape(fields.when || row.when)
    + "<br>Address: " + mailEscape(fields.address || "") + "</p>"
    + pitch.html + "</div>";
  return {
    to: row.parentEmail,
    replyTo: row.replyTo || supportReply(),
    subject: "Booking request: " + (row.service || fields.service || "a job"),
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

// One "live" note per page, tracked as a set (liveMailedSlugs, with the
// legacy single liveMailed folded in) so a family's second page gets its
// own note and republishing either page never re-sends. kind picks the
// wording: "added" for a further page joining the family plan, "renamed"
// when the primary address moved, "" for the first page.
async function sendLiveNote(account, origin, slug, kind = "") {
  const mailed = new Set(Array.isArray(account.liveMailedSlugs) ? account.liveMailedSlugs : []);
  if (account.liveMailed) mailed.add(account.liveMailed);
  if (mailed.has(slug)) return;
  const url = (origin || "") + "/" + slug;
  const qr = (origin || "") + "/api/qr/" + slug + ".png";
  const accountLink = accountUrl(origin);
  const renamed = kind === "renamed";
  const added = kind === "added";
  const subject = renamed ? "Your new web address is live" : added ? "Your new page is live" : "Your page is live";
  const lead = renamed ? "Your new web address is live." : added ? "Your new page is live." : "Your page is live.";
  await ensureCalToken(account);
  const links = feedLinks(origin, account.calToken);
  const sent = await sendOnce("sentmail/live-" + account.id + "-" + slug, {
    to: account.email,
    replyTo: supportReply(),
    subject,
    text: lead + "\n\n" + url + "\n\nNext:\n1. Print a flyer in the app. The QR code is on it, and in this email.\n2. Share the link with neighbors.\n\nAdd the family calendar once. New jobs show up there.\nGoogle Calendar:\n" + links.calGoogle + "\nPrivate link:\n" + links.calUrl + "\n\nQR code: " + qr + "\n\nYour account:\n" + accountLink + "\n",
    html: "<div style=\"font:18px/1.5 system-ui,sans-serif;color:#1d2226\"><p><b>" + lead + "</b></p><p><a href=\"" + mailEscape(url) + "\">" + mailEscape(url) + "</a></p><p><img src=\"" + mailEscape(qr) + "\" alt=\"QR code for the page\" width=\"220\" height=\"220\"></p><p>Next:</p><ol><li>Print a flyer in the app.</li><li>Share the link with neighbors.</li></ol><p><a href=\"" + mailEscape(links.calGoogle) + "\">Add the family calendar to Google Calendar</a></p><p>Private link: " + mailEscape(links.calUrl) + "</p><p><a href=\"" + mailEscape(accountLink) + "\">Your account</a></p></div>"
  });
  if (sent.ok) {
    mailed.add(slug);
    account.liveMailedSlugs = [...mailed];
    account.liveMailed = slug;
  }
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
    text: "Thanks. We got your payment.\n\n" + (account.planName || "Plan") + "\n" + plan.label + "\nThrough " + end + ".\n\nThis is a one-time payment. It does not renew on its own. Not happy? Email " + SUPPORT_EMAIL + " within " + REFUND_DAYS + " days for a full refund.\n\nYour account:\n" + link + "\n",
    html: "<div style=\"font:18px/1.5 system-ui,sans-serif;color:#1d2226\"><p>Thanks. We got your payment.</p><p><b>" + mailEscape(account.planName || "Plan") + "</b><br>" + mailEscape(plan.label) + "<br>Through " + mailEscape(end) + ".</p><p>This is a one-time payment. It does not renew on its own. Not happy? Email " + SUPPORT_EMAIL + " within " + REFUND_DAYS + " days for a full refund.</p><p><a href=\"" + mailEscape(link) + "\">Your account</a></p></div>"
  });
}

async function sendMail({ to, subject, text, html: htmlBody, ics, replyTo, forParent, origin, ownerId, expiresAt }) {
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
  return queueMail({to,subject:sub,text:clean,html:markup,ics:icsText,replyTo:reply,ownerId:ownerId||'',expiresAt:expiresAt||null});
}

export const LEGAL_UPDATED = "November 10, 2026";
function privacyPage() {
  return shell(200, "Privacy", `<h1>Privacy</h1>
<p>Last updated ${LEGAL_UPDATED}.</p>
<p>Hustle Builder helps a kid build a page for a small neighborhood business, and lets a parent or guardian put that page online. This page says what we keep, why, and for how long.</p>

<h2>The builder, before anything is published</h2>
<p>Until a parent completes verification and consent, your draft stays only in this browser. “Ask my parent” sends only the contact information and names needed to request consent, not the business draft. If consent is not completed within seven days, we delete that request information. Cloud drafts become available only after parental consent.</p>

<h2>What we keep for a parent account</h2>
<p>The account belongs to the parent or guardian, not the child. We keep the parent’s email address, the parent check described below, the page they approved, and the plan and payment status. We use the email to send sign-in codes, booking requests, receipts, and plan reminders. We do not sell it, share it for advertising, or send marketing email.</p>
<p>A kid does not make an account and does not give us an email address.</p>

<h2>How a parent agrees</h2>
<p>Before the first page goes online, a parent reads this notice and pays 50¢ with a card through Stripe. Stripe emails a receipt to the parent’s email. We refund that 50¢ in full right away. The free trial stays free. You are never charged automatically.</p>
<p>We store that the check happened: the method (a card check, or a later plan payment), the time, Stripe’s payment id, and this notice’s version. We do not store the card number, the expiration date, or the security code. A parent who already passed the check does not do it again for another kid’s page or for an update. Buying a real plan also counts, so that parent skips the 50¢. Refunding the 50¢ does not take the page down.</p>

<h2>What the public page shows</h2>
<p>The page shows a first name and a town, plus the services, prices, photos, and reviews the family chose to add. A parent’s email and phone are not on the page. Neighbors use the booking form. Search engines are asked not to list the page unless the parent turns that on too.</p>
<p>Each page has a “Report this page” link. If a few people report a page, it is hidden until we check it.</p>

<h2>Booking requests from neighbors</h2>
<p>When a neighbor asks for a job, we keep what they typed: their name, how to reach them, the address, the job, the day and time, and a short note. It goes to the parent by email, to the parent’s private family calendar link, and to the parent’s account. We delete the request about 30 days after it arrives and the calendar entry about 30 days after the job date, or sooner if the parent deletes the account. It is not a customer list and we do not use it for anything else.</p>
<p>If the neighbor leaves an email address, we send one note saying the request arrived, with a link to cancel it. That note does not include the parent’s email or phone, and it does not include a gate code or key note.</p>
<p>The kid’s “My jobs” list shows the job, the day and time, the neighbor’s first name, and a status. It does not show the neighbor’s email, phone, or street unless the parent turns street sharing on, and even then it shows the street name without the house number.</p>

<h2>Drafts and “ask my parent” links</h2>
<p>After a parent has verified their email and agreed, a draft can be saved on our server so the same page opens on another device. The draft code is the key, so keep it private. We delete a draft about 90 days after its last save, or when the parent deletes the account. Before that agreement, the draft stays in the browser. An “ask my parent” note keeps only the parent’s email, the kid’s first name, and the business name, and we delete it after 7 days if consent is not completed.</p>

<h2>Job log and calendar sync</h2>
<p>The job log in Boss mode stays on the phone or computer, unless a parent is signed in there and “Sync to family calendar” is on. Synced jobs go to the same private calendar link and follow the same 30-day delete.</p>

<h2>Payments</h2>
<p>Payments are handled by Stripe. We never see or store a card number. We keep a record that a plan was paid, the amount, and the date it runs through.</p>

<h2>Page views and abuse limits</h2>
<p>We count how many times a page is opened, as a daily total only. We do not keep who opened it. We also keep a daily total for steps such as a draft started, a parent invited, a page published, and a plan paid. Those totals have no name, email, or address. To stop spam we keep short-lived counters tied to a scrambled form of a visitor’s network address; they cannot be turned back into the address, and the counters are cleared within a few days. A report on a page keeps one such scrambled marker so the same visitor is only counted once. We do not use advertising or tracking cookies. A signed-in parent gets one cookie that keeps them signed in.</p>

<h2>Who helps us run this</h2>
<p>We use service providers to host the site and database, send email, and take payments. They handle the information above only to provide those services to us.</p>

<h2>Free trial and plans</h2>
<p>${trialBlurb()} One trial belongs to the parent’s email and is shared by every page on that account. It does not start over with a new link. When the trial ends, the public link shows a taking-a-break page. The page and, after consent, the kid’s draft stay saved. New requests are saved and held until a parent picks a plan, and each request is deleted about 30 days after it arrives. Plans and prices are on the <a href="/terms">Terms</a> page.</p>

<h2>Taking a page down, or deleting everything</h2>
<p>A parent can pause the page, take it offline, or delete the account from the account screen at any time. Taking a page offline does not delete calendar jobs. Deleting the account removes the email, the consent record, every page on the account, the booking requests, the calendar jobs, and the calendar link. One thing stays: a scrambled marker that this email already used its free trial, so the trial cannot be restarted.</p>

<h2>Questions</h2>
<p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. A parent can ask us what we hold for their account or ask us to delete it.</p>`, { wide: true });
}

function termsPage() {
  return shell(200, "Terms", `<h1>Terms of use</h1>
<p>Last updated ${LEGAL_UPDATED}.</p>
<p>These terms cover the Hustle Builder app and the pages it hosts at hustlebuilder.org. By publishing a page or buying a plan you agree to them.</p>

<h2>Who can use it</h2>
<p>Kids can use the builder with a parent or guardian’s permission. Only a parent or guardian who is an adult can open an account, publish a page, or buy a plan. The parent is responsible for the page, for every job the child takes, and for the child’s safety on those jobs.</p>

<h2>What Hustle Builder does, and does not do</h2>
<p>We host the page and pass booking requests to the parent. A booking request is only a request: nothing is booked until the parent replies to the neighbor. We are not part of any job, we do not check who neighbors are, we do not supervise work, and we do not handle money between a family and a neighbor.</p>
<p>Payments for jobs go directly between neighbors and the family. Hustle Builder doesn't collect, hold, or guarantee job payments.</p>

<h2>Free trial</h2>
<p>${trialBlurb()} There is one trial per parent email, shared by every page on that account.</p>

<h2>Parent check</h2>
<p>Before the first page goes online, a parent pays 50¢ by card. Stripe emails a receipt to that parent, and we refund the 50¢ in full right away. The trial stays free. You are never charged automatically. We keep the method, the time, Stripe’s payment id, and the notice version. We do not keep the card number. A parent who already passed this check, or who later buys a plan, does not pay the 50¢ again. Refunding the 50¢ does not take the page down. A refund of a plan is different and is described under Refunds.</p>

<h2>Plans and payment</h2>
<p>A season plan is ${PLANS.season.label}. It covers the page through the end of the current season: August 31 for summer, March 31 for winter. If fewer than ${SEASON_MIN_DAYS} days are left in a season, the plan runs through the end of the next one instead. A year plan is ${PLANS.year.label} and covers 365 days. The end date is shown before you pay.</p>
<p>Each plan is a one-time payment handled by Stripe. <b>Plans do not renew on their own and we do not keep a card on file.</b> We email the parent before a plan ends. After the end date the page stays up for ${GRACE_DAYS} more days, then shows a taking-a-break page until a new plan is bought. One plan covers every page on the family’s account.</p>
<h2>Refunds</h2>
<p>If you are not happy, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> within ${REFUND_DAYS} days of a payment and we will refund it in full to the card you paid with. You do not need to give a reason. A refund ends the plan that payment bought: the page goes back to how it was before the payment, and nothing is deleted. After ${REFUND_DAYS} days, payments are not refunded except where the law requires it.</p>

<h2>What can go on a page</h2>
<p>Keep pages about the kid’s business. Use a first name only. Do not post a last name, school, home address, or anyone else’s personal information, and only post photos and reviews you have permission to share. No rude, hateful, or unsafe content. We may hide or remove a page, or close an account, that breaks these rules or is reported.</p>

<h2>Your content</h2>
<p>The words and photos a family adds stay theirs. Publishing gives us permission to store and show them on the page until it is taken offline or the account is deleted.</p>

<h2>Ending</h2>
<p>A parent can take a page offline or delete the account at any time from the account screen. Deleting the account removes the data described in the <a href="/privacy">Privacy</a> notice.</p>

<h2>No guarantees</h2>
<p>We work to keep pages and booking emails running, but the service is provided as it is. Email can be delayed or land in spam, and a page can be briefly unavailable, so do not rely on Hustle Builder alone for anything urgent. Hustle Builder does not give legal, tax, or safety advice; local rules about kids working, permits, and taxes are the family’s to check.</p>

<h2>Changes</h2>
<p>If these terms change, we will update the date above. Using the service after a change means you accept the new terms.</p>

<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`, { wide: true });
}

function missingPage(slug, down) {
  const title = down ? "This page was taken down" : "This page is not up";
  return shell(404, title, `<h1>${title}</h1><p>${down ? "The host removed this page." : "Check the link, or ask them to publish again."}</p>`);
}

function pausePage() {
  return shell(200, "Paused", `<h1>Paused for now</h1>
<p>This page is paused. Nothing new is being scheduled.</p>
<p>If you know the family, ask them when they are working again.</p>`);
}

function breakPage() {
  return shell(200, "Taking a break", `<h1>Taking a break</h1>
<p>This page is resting for now. Bookings are paused, so nothing new is being scheduled.</p>
<p>If you know the family, ask them when they are working again.</p>
<p style="font-size:15px;color:#5a6672">Is this your page? <a href="/?account=1">Open your account</a> to bring it back.</p>`);
}

function finishedPage(message) {
  return shell(404, "This link is finished", `<h1>This link is finished</h1><p>${mailEscape(message)}</p>`);
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
// The same pass flags a page still wired to the family's own Google Apps
// Script inbox (the pre-hosting booking path): its embedded config carries an
// inbox object instead of "inbox":null. The published-page CSP now blocks
// those outside calls, so the sheet's busy times and customer photos silently
// fail — the operator needs to spot those pages and reach the family.
// Nothing is stripped server-side, so the marker is read, never rewritten.
const LEGACY_INBOX_MARK = '"inbox":{"url":"https://script.google.com/';
function namesFromHtml(raw) {
  let first = "";
  let biz = "";
  const text = String(raw || "");
  const m = text.match(/window\.__C=(\{.*?\});<\/script>/s);
  if (m) {
    try {
      const cfg = JSON.parse(m[1]);
      first = String(cfg.first || "").slice(0, 40);
      biz = String(cfg.biz || "").slice(0, 80);
    } catch { /* fall through to the card title */ }
  }
  return { first, biz, legacyInbox: text.includes(LEGACY_INBOX_MARK) };
}
// Publishing now saves these three facts on the small page record, so the
// admin view never has to open a page's HTML (up to 2 MB each). Pages
// published before that are read once, when they are shown.
async function siteNames(slug, meta) {
  const known = meta && meta.names && typeof meta.names === "object";
  const found = known
    ? { first: String(meta.names.first || ""), biz: String(meta.names.biz || ""), legacyInbox: !!meta.legacyInbox }
    : namesFromHtml(await (await store()).get("pages/" + slug + ".html"));
  if (!found.biz && meta && meta.card) found.biz = String(meta.card.title || "").slice(0, 80);
  return found;
}
async function entries(prefix, suffix = "") {
  const s = await store();
  if (typeof s.entries === "function") return s.entries(prefix, suffix);
  const out = [];
  for (const key of await s.list(prefix)) if (!suffix || key.endsWith(suffix)) out.push([key, await s.get(key)]);
  return out;
}
const parseOr = (raw, fallback) => { try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch { return fallback; } };

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
  if (!meta || slugsOf(account).length === 0) {
    return { key: "draft", label: "Draft", date: account.createdAt ? "Started " + niceDate(account.createdAt) : "" };
  }
  if (meta.status === "review") {
    return { key: "hidden", label: "Hidden (reports)", date: meta.updatedAt ? "Updated " + niceDate(meta.updatedAt) : "" };
  }
  if (meta.status === "down") {
    return { key: "down", label: "Taken down", date: meta.downAt ? "Since " + niceDate(meta.downAt) : "" };
  }
  if (comped(account)) {
    return { key: "free", label: "Free (friends & family)", date: account.compAt ? "Since " + niceDate(account.compAt) : "" };
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
    date: (account.trialEndsAt ? "Ends " + niceDate(account.trialEndsAt) : "Not started")
  };
}

export const ADMIN_PAGE_SIZE = 50;
async function adminDashboardPage(origin, query) {
  // Three bulk reads (accounts, page records, trial counters) build every
  // row's status. The heavier per-row details — booking counts, names for
  // pages published before names were saved — are read only for the rows
  // actually shown, so the view costs the same at 50 families or 50,000.
  const metas = new Map();
  for (const [, raw] of await entries("pages/", ".json")) {
    const meta = parseOr(raw, null);
    if (meta && meta.slug && meta.status !== "redirect") metas.set(meta.slug, meta);
  }
  const accounts = [];
  for (const [, raw] of await entries("accounts/", ".json")) {
    const account = parseOr(raw, null);
    if (account && account.id) accounts.push(account);
  }
  const trialUsed = new Map();
  for (const [key, raw] of await entries("trials/", ".json")) {
    const n = Number(parseOr(raw, {}).used);
    trialUsed.set(key.slice(7, -5), Number.isFinite(n) && n > 0 ? n : 0);
  }
  const usedBy = (account) => trialUsed.get(sha(account.email)) || 0;
  const byAccount = new Map();
  for (const meta of metas.values()) {
    if (!meta.accountId) continue;
    if (!byAccount.has(meta.accountId)) byAccount.set(meta.accountId, []);
    byAccount.get(meta.accountId).push(meta);
  }
  const counts = { accounts: 0, live: 0, trial: 0, paid: 0, free: 0, grace: 0, break: 0, hidden: 0, bookings: 0, legacy: 0 };
  for (const meta of metas.values()) {
    if (meta.status === "live") counts.live += 1;
    if (meta.status === "review") counts.hidden += 1;
    if (meta.legacyInbox) counts.legacy += 1;
  }
  const rows = [];
  const seen = new Set();
  const cardBiz = (meta) => String((meta && meta.names && meta.names.biz) || (meta && meta.card && meta.card.title) || "");
  for (const account of accounts) {
    counts.accounts += 1;
    if (comped(account)) counts.free += 1;
    // Family plan: one row per page the account owns, all sharing the
    // account's status and the account-level comp button (making a family
    // free frees every page at once). Page records that name this account
    // are adopted even if the account's slug set somehow missed them.
    const ownedMetas = [];
    for (const slug of slugsOf(account)) {
      const meta = metas.get(slug);
      if (meta && !ownedMetas.includes(meta)) ownedMetas.push(meta);
    }
    for (const meta of byAccount.get(account.id) || []) if (!ownedMetas.includes(meta)) ownedMetas.push(meta);
    for (const meta of ownedMetas) seen.add(meta.slug);
    const used = usedBy(account);
    // The summary tiles count each account once, by its primary page's
    // status; the rows below carry each page's own status.
    const headStatus = adminStatus(account, ownedMetas[0] || null, used);
    if (headStatus.key === "trial") counts.trial += 1;
    if (headStatus.key === "paid") counts.paid += 1;
    if (headStatus.key === "grace") counts.grace += 1;
    if (headStatus.key === "break") counts.break += 1;
    if (!ownedMetas.length) {
      rows.push({ account, meta: null, index: 0, id: account.id, comp: comped(account), slug: account.slug || "", email: account.email || "", status: headStatus, reports: 0, pageStatus: "", search: (account.slug || "") + " " + (account.email || ""), sortAt: account.createdAt || "" });
      continue;
    }
    for (const [index, meta] of ownedMetas.entries()) {
      rows.push({ account, meta, index, id: account.id, comp: comped(account), slug: meta.slug, email: account.email || "", status: adminStatus(account, meta, used), reports: Array.isArray(meta.reports) ? meta.reports.length : 0, pageStatus: meta.status || "", search: meta.slug + " " + (account.email || "") + " " + cardBiz(meta), sortAt: meta.updatedAt || account.createdAt || "" });
    }
  }
  for (const meta of metas.values()) {
    if (seen.has(meta.slug)) continue;
    rows.push({ account: null, meta, index: 0, id: "", comp: false, slug: meta.slug, email: "", status: adminStatus(null, meta, 0), reports: Array.isArray(meta.reports) ? meta.reports.length : 0, pageStatus: meta.status || "", search: meta.slug + " " + cardBiz(meta), sortAt: meta.updatedAt || "" });
  }
  rows.sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)));
  const q = String((query && query.get && query.get("q")) || "").trim().toLowerCase().slice(0, 80);
  const only = String((query && query.get && query.get("show")) || "");
  let matched = q ? rows.filter((row) => row.search.toLowerCase().includes(q)) : rows;
  if (only === "reported") matched = matched.filter((row) => row.reports > 0 || row.pageStatus === "review" || row.pageStatus === "down");
  const pages = Math.max(1, Math.ceil(matched.length / ADMIN_PAGE_SIZE));
  const pageNo = Math.min(pages, Math.max(1, Math.floor(Number(query && query.get && query.get("page")) || 1)));
  const shown = matched.slice((pageNo - 1) * ADMIN_PAGE_SIZE, pageNo * ADMIN_PAGE_SIZE);
  // Details for the rows on screen only.
  const requestsFor = new Map();
  for (const row of shown) {
    row.legacyInbox = false; row.biz = ""; row.first = ""; row.bookings = 0;
    if (row.account && !requestsFor.has(row.account.id)) requestsFor.set(row.account.id, await loadRequests(row.account.id));
    const requests = row.account ? requestsFor.get(row.account.id) : [];
    if (!row.meta) { row.bookings = requests.length; continue; }
    const names = await siteNames(row.meta.slug, row.meta);
    if (names.legacyInbox && !row.meta.legacyInbox) counts.legacy += 1;
    row.legacyInbox = names.legacyInbox; row.biz = names.biz; row.first = names.first;
    row.bookings = requests.filter((item) => (item.slug ? item.slug === row.meta.slug : row.index === 0)).length;
  }
  const backing = await store();
  if (typeof backing.sumArrayLengths === "function") counts.bookings = await backing.sumArrayLengths("requests/");
  else for (const [, raw] of await entries("requests/", ".json")) { const list = parseOr(raw, []); counts.bookings += Array.isArray(list) ? list.length : 0; }
  const linkTo = (n) => "/admin?page=" + n + (q ? "&q=" + encodeURIComponent(q) : "") + (only ? "&show=" + encodeURIComponent(only) : "");
  const pager = `<p style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:10px 0">${pageNo > 1 ? `<a href="${mailEscape(linkTo(pageNo - 1))}">← Newer</a>` : ""}<span>${matched.length === rows.length ? rows.length + " rows" : matched.length + " of " + rows.length + " rows"}${pages > 1 ? " · page " + pageNo + " of " + pages : ""}</span>${pageNo < pages ? `<a href="${mailEscape(linkTo(pageNo + 1))}">Older →</a>` : ""}</p>`;
  const searchForm = `<form method="get" action="/admin" style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0"><input type="search" name="q" value="${mailEscape(q)}" placeholder="Search link name, email, or business" style="flex:1;min-width:14rem;font:16px system-ui;padding:8px"><select name="show" style="font:16px system-ui;padding:8px"><option value="">All pages</option><option value="reported"${only === "reported" ? " selected" : ""}>Reported or taken down</option></select><button type="submit" style="font:16px system-ui;padding:8px 14px">Search</button>${q || only ? `<a href="/admin" style="align-self:center">Clear</a>` : ""}</form>`;
  // The latest payment that has not been refunded, on the family's first row.
  const refundLink = (row) => {
    if (!row.account || row.index !== 0) return "";
    const item = (Array.isArray(row.account.receipts) ? row.account.receipts : []).filter((r) => r && r.id && !r.refundedAt).pop();
    if (!item || !paid(row.account) || comped(row.account)) return "";
    const age = Math.floor((Date.now() - Date.parse(item.at || "")) / 864e5);
    return `<a href="/admin/refund?id=${mailEscape(row.id)}&amp;receipt=${mailEscape(item.id)}" style="display:inline-block;margin-top:6px;font-size:14px">Refund ${mailEscape(item.amountLabel || "")}</a><br><span style="font-size:13px;color:#5a6672">${age <= REFUND_DAYS ? "day " + Math.max(0, age) + " of " + REFUND_DAYS : "past " + REFUND_DAYS + " days"}</span>`;
  };
  const noteText = { "refund-done": "Refunded. The plan has ended and the family was emailed.", "refund-failed": "The refund did not go through. Nothing was changed. Check Stripe, then try again.", "refund-none": "That payment was already refunded." }[String((query && query.get && query.get("note")) || "")] || "";
  const actionForm = (path, slug, label) => `<form method="post" action="/admin/${path}" style="margin:0 0 4px"><input type="hidden" name="slug" value="${mailEscape(slug)}"><button type="submit" style="font:14px system-ui;padding:6px 10px">${label}</button></form>`;
  const pageActions = (row) => {
    if (!row.slug || !row.pageStatus) return "—";
    if (row.pageStatus === "down") return actionForm("restore", row.slug, "Put back");
    return (row.pageStatus === "review" || row.reports > 0 ? actionForm("restore", row.slug, row.pageStatus === "review" ? "Restore" : "Clear reports") : "") + actionForm("takedown", row.slug, "Take down");
  };
  const consentAdminLabel = (account) => {
    if (!account) return "";
    if (account.consentMethod === "card_charge" && account.consentRefundedAt) return "Consent: card check, refunded";
    if (account.consentMethod === "card_charge") return "Consent: card check, refund pending";
    if (account.consentMethod === "plan_payment" && account.consentAt) return "Consent: plan payment";
    if (account.consentAt) return "Consent: recorded";
    return "Consent: not verified";
  };
  const tile = (n, label) => `<div style="border:1px solid #ccd2d8;border-radius:10px;padding:10px 14px;min-width:6.5rem"><div style="font-size:28px;font-weight:800">${n}</div><div>${label}</div></div>`;
  const tiles = [
    tile(counts.accounts, "Accounts"),
    tile(counts.live, "Sites live"),
    tile(counts.trial, "In trial"),
    tile(counts.paid, "Paid"),
    tile(counts.free, "Free"),
    tile(counts.grace, "In grace"),
    tile(counts.break, "Taking a break"),
    tile(counts.hidden, "Hidden by reports"),
    tile(counts.legacy, "Legacy inbox"),
    tile(counts.bookings, "Bookings stored")
  ].join("");
  const body = shown.map((row) => `<tr>
<td style="padding:8px;vertical-align:top">${row.biz ? `<b>${mailEscape(row.biz)}</b>` : ""}${row.first ? `<br>${mailEscape(row.first)}` : ""}${!row.biz && !row.first ? "—" : ""}</td>
<td style="padding:8px;vertical-align:top">${row.slug ? `<a href="${mailEscape((origin || "") + "/" + row.slug)}">/${mailEscape(row.slug)}</a>` : "—"}</td>
<td style="padding:8px;vertical-align:top">${row.email ? mailEscape(row.email) : "—"}</td>
<td style="padding:8px;vertical-align:top">${mailEscape(row.status.label)}${row.status.date ? `<br><span style="color:#5a6672">${mailEscape(row.status.date)}</span>` : ""}${row.index === 0 && row.account ? `<br><span style="color:#5a6672">${mailEscape(consentAdminLabel(row.account))}</span>` : ""}${row.legacyInbox ? `<br><span style="display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;background:#fde68a;border:1px solid #d97706;color:#7c2d12;font-size:13px;font-weight:700">Legacy inbox</span>` : ""}</td>
<td style="padding:8px;vertical-align:top">${row.bookings}</td>
<td style="padding:8px;vertical-align:top">${row.reports}</td>
<td style="padding:8px;vertical-align:top">${row.id ? `<form method="post" action="/admin/comp"><input type="hidden" name="id" value="${mailEscape(row.id)}"><input type="hidden" name="on" value="${row.comp ? "0" : "1"}"><button type="submit" style="font:14px system-ui;padding:6px 10px">${row.comp ? "Remove free" : "Make free"}</button></form>${refundLink(row)}` : "—"}</td>
<td style="padding:8px;vertical-align:top">${pageActions(row)}</td>
</tr>`).join("");
  return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Hustle Builder admin</title></head><body>
<main style="max-width:64rem;margin:2rem auto;font:16px/1.5 system-ui,sans-serif;padding:0 1rem">
<div style="display:flex;justify-content:space-between;align-items:center;gap:1rem">
<h1 style="margin:0">Hustle Builder admin</h1>
<form method="post" action="/admin/logout"><button type="submit" style="font:16px system-ui;padding:8px 14px">Sign out</button></form>
</div>
<div style="display:flex;flex-wrap:wrap;gap:10px;margin:18px 0">${tiles}</div>
${await funnelTable()}
${noteText ? `<p style="padding:10px 14px;border:1px solid #ccd2d8;border-radius:10px;background:#f4f6f8"><b>${mailEscape(noteText)}</b></p>` : ""}
${searchForm}${pager}
<table style="border-collapse:collapse;width:100%">
<thead><tr style="text-align:left;border-bottom:2px solid #1d2226">
<th style="padding:8px">Business · kid</th><th style="padding:8px">Page</th><th style="padding:8px">Parent email</th><th style="padding:8px">Status</th><th style="padding:8px">Bookings</th><th style="padding:8px">Reports</th><th style="padding:8px">Plan</th><th style="padding:8px">Page</th>
</tr></thead>
<tbody>${body || `<tr><td colspan="8" style="padding:8px">${rows.length ? "Nothing matches that search." : "No accounts yet."}</td></tr>`}</tbody>
</table>
${pages > 1 ? pager : ""}
<p style="color:#5a6672">Bookings are the requests still stored per family (each is deleted after about 30 days). Reports are the reports on a page right now; three hide a page automatically. “Restore” or “Clear reports” puts it back and clears them. “Take down” removes a page from public view and stops the family republishing it until you “Put back”. “Make free” puts a family on the friends &amp; family plan: no payment, no trial clock, no renewal emails. “Remove free” hands the account back to whatever its trial or paid dates say. “Refund” shows on a paid family’s latest payment: it asks you to confirm, sends the money back through Stripe, and ends the plan that payment bought. The terms promise a full refund within ${REFUND_DAYS} days.</p>
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
    const backing=await store();
    if(backing.incrementView)return backing.incrementView(slug,viewDayKey(),viewDayKey(Date.now()-VIEW_KEEP_DAYS*864e5));
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
function beltHtml(slug) {
  const ref = /^[a-z0-9][a-z0-9-]{1,40}$/.test(String(slug || "")) ? encodeURIComponent(slug) : "";
  const href = "https://hustlebuilder.org/?for=parents" + (ref ? "&ref=" + ref : "");
  return `<div id="hb-belt" style="margin:28px 0 0;padding:14px 12px;background:#14181d;border-top:3px solid #ff5b14;text-align:center;font:13px/1.4 system-ui,sans-serif;color:#aeb8c2"><a href="${href}" target="_top" style="color:#e8ecf0;text-decoration:none;font-weight:600"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style="vertical-align:-1px;margin-right:5px"><polygon points="9,1 3,9 7,9 6,15 13,7 9,7" fill="#ff5b14"/></svg>Make one for your kid, free for 14 days</a></div>`;
}
function withBelt(pageHtml, slug) {
  if (typeof pageHtml !== "string" || pageHtml.includes(BELT_MARKER)) return pageHtml;
  const at = pageHtml.toLowerCase().lastIndexOf("</body>");
  const belt = beltHtml(slug);
  return at >= 0
    ? pageHtml.slice(0, at) + belt + "\n" + pageHtml.slice(at)
    : pageHtml + belt;
}

async function serveSlug(slug, view) {
  const res = await serveSlugInner(slug, view);
  if (res && res.headers && String(res.headers["content-type"] || "").includes("text/html")) {
    const origin=await publicOrigin();
    res.headers = {...res.headers,"content-security-policy":"sandbox allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation; default-src 'none'; script-src 'unsafe-inline'; connect-src "+(origin?new URL(origin).origin+"/api/book":"'self'")+"; img-src "+(origin?new URL(origin).origin:"'self'")+" data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'};
  }
  return res;
}

async function serveSlugInner(slug, view) {
  if (slug === "privacy") return privacyPage();
  if (slug === "terms") return termsPage();
  const why = checkSlug(slug);
  if (why) return missingPage(slug, false);
  const meta = await readJson("pages/" + slug + ".json");
  if (!meta) return missingPage(slug, false);
  if (meta.status === "down") return missingPage(slug, true);
  if (meta.status === "review") return shell(200, "Hidden for review", `<h1>Hidden for now</h1><p>This page is hidden while it is being checked. Nothing new is being scheduled.</p>`);
  if (meta.status === "redirect" && meta.to) {
    if (Date.parse(meta.until || "") > Date.now()) return redirect("/" + meta.to);
    return missingPage(slug, false);
  }
  if (meta.status === "paused") return pausePage();

  if (meta.status !== "live") return missingPage(slug, false);
  const account = meta.accountId ? await readJson("accounts/" + meta.accountId + ".json") : null;
  if (account && (onBreak(account) || trialOver(account, await trialCount(account.email)))) return breakPage();
  const page = stripParentContact(await (await store()).get("pages/" + slug + ".html"));
  if (!page) return missingPage(slug, false);
  // The real page is the only response that gets the "Built with" belt,
  // added here at serve time so the stored page stays exactly as the
  // family published it.
  const res = html(200, withBelt(page, slug));
  // The response is settled; only now does the view count. noteView swallows
  // its own errors, and every other return above (break, pause, review,
  // missing, down, redirect) leaves the counter untouched.
  res.viewEvent={slug,meta,view};
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
  try { const value=JSON.parse(s);return value&&typeof value==="object"&&!Array.isArray(value)?value:null; }
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

// The family's time zone, saved from the parent's browser at publish.
function tzOf(account) { return validTz(account && account.tz) || DEFAULT_TZ; }
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

function checkSlugShape(slug) { return /^[a-z0-9][a-z0-9-]{1,40}$/.test(String(slug || "")); }
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
  return calendarResponse(200, jobsToIcs(jobs, Date.now(), tzOf(account)));
}

function clientIp(req) {
  const h = (req && req.headers) || {};
  const fwd = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  return String(fwd).split(",")[0].trim().slice(0, 80) || String(h["x-real-ip"] || "local").slice(0, 80);
}
// Abuse counters. Each lives under counters/<UTC day or hour>/..., so the daily
// sweep can delete every bucket older than yesterday without reading them.
// Only a hash of the address is ever stored.
function counterKey(kind, who, bucket = new Date().toISOString().slice(0, 10)) {
  return "counters/" + bucket + "/" + kind + "-" + sha(who + "|" + bucket);
}
async function bumpIp(ip) {
  const key = counterKey("book", ip);
  const n = Number((await (await store()).get(key)) || 0) + 1;
  await (await store()).put(key, String(n));
  return n;
}
const IP_LIMIT = 12;
const CODE_MISS_LIMIT = 60;
// Family plan ceiling: far above any real family, low enough that one free
// account cannot be used to park hundreds of 2 MB pages.
export const MAX_PAGES_PER_ACCOUNT = 20;
const MIN_FORM_MS = 2500;

function contactEmail(value) {
  const m = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : "";
}
function contactPhone(value) {
  // Drop any email first, so "name2@example.com, 402-555-0199" does not
  // treat the 2 in the address as part of the phone.
  const rest = String(value || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const digits = rest.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return digits.length === 10 ? "1" + digits : digits;
}
function mailEscape(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pngResponse(buf) {
  return { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" }, body: buf };
}

// A PNG wrapped as a .ico so browsers that request /favicon.ico get a real icon.
function icoFromPng(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 32;
  header[7] = 32;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

const HOME_ORIGIN = "https://hustlebuilder.org";
function siteOrigin(origin) {
  return String(origin || HOME_ORIGIN).replace(/\/$/, "") || HOME_ORIGIN;
}
function robotsTxt(origin) {
  const base = siteOrigin(origin);
  return "User-agent: *\nAllow: /\n\nSitemap: " + base + "/sitemap.xml\n";
}
async function sitemapXml(origin) {
  const base = siteOrigin(origin);
  const urls = [base + "/", base + "/terms", base + "/privacy"];
  try {
    const keys = await (await store()).list("pages/");
    for (const key of keys) {
      if (!String(key).endsWith(".json")) continue;
      const meta = await readJson(key);
      const slug = meta && meta.slug;
      if (!meta || meta.indexable !== true) continue;
      if (meta.status === "down" || meta.status === "review") continue;
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(String(slug || ""))) continue;
      urls.push(base + "/" + slug);
    }
  } catch { /* an empty sitemap still lists the public pages */ }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` + urls.map((loc) => `  <url><loc>${mailEscape(loc)}</loc></url>`).join("\n") + "\n</urlset>\n";
  return body;
}
function textFile(body, type) {
  return { status: 200, headers: { "content-type": type, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" }, body };
}

const ASK_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_MS = 90 * 24 * 60 * 60 * 1000;
const DRAFT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function draftCode() {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => DRAFT_ALPHABET[b % DRAFT_ALPHABET.length]).join("");
}
async function notifyNeighbor({ origin, reply, fields, account, requestId, slug }) {
  const cancel = rand(18);
  await writeJson("cancels/" + cancel + ".json", {
    accountId: account.id,
    parentEmail: account.email,
    requestId: requestId || "",
    customer: fields.name,
    service: fields.service,
    when: fields.when,
    used: false, createdAt:new Date().toISOString(), expiresAt:Date.now()+30*864e5
  });
  if(requestId){const rows=await loadRequests(account.id);const row=rows.find(r=>r.id===requestId);if(row){row.cancelToken=cancel;await saveRequests(account.id,rows);}}
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
    "Make one for your kid, free for 14 days: https://hustlebuilder.org/?for=parents" + (slug ? "&ref=" + slug : ""),
    "",
    unread
  ].filter(Boolean).join("\n");
  const htmlMail = "<div style=\"font:18px/1.45 system-ui,sans-serif;color:#1d2226\">"
    + "<p>Hi " + mailEscape(fields.name) + ",</p>"
    + "<p>We got your request for <b>" + mailEscape(fields.service || "a job") + "</b>"
    + (fields.when ? " on " + mailEscape(fields.when) : "") + ".</p>"
    + "<p>Nothing is booked yet. The family will confirm with you.</p>"
    + "<p><a href=\"" + mailEscape(url) + "\">Cancel this request</a></p>"
    + "<p><a href=\"https://hustlebuilder.org/?for=parents" + (slug ? "&amp;ref=" + mailEscape(slug) : "") + "\">Make one for your kid, free for 14 days</a></p>"
    + (unread ? "<p>" + mailEscape(unread) + "</p>" : "")
    + "</div>";
  await sendMail({ to: reply, ownerId:account.id, replyTo: support, subject: "We got your request", text, html: htmlMail });
}

function cancelPage(token, done, missing) {
  const title = missing ? "This link is finished" : done ? "Request cancelled" : "Cancel this request?";
  const inner = missing
    ? "<p>This cancel link is no longer active.</p>"
    : done
      ? "<p>Cancelled. The family got a note.</p>"
      : "<p>Nothing is booked until the family confirms. Tap below if you do not want this request.</p><form method=\"post\" action=\"/api/cancel/" + token + "\"><button type=\"submit\">Cancel this request</button></form>";
  return shell(missing ? 404 : 200, title, `<h1>${title}</h1>${inner}`);
}

function clipDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = JSON.stringify(value);
  if (raw.length > 900000) return { error: "big" };
  return { draft: value, raw };
}
function askNames(body) {
  const src = body && body.draft && typeof body.draft === "object" && !Array.isArray(body.draft) ? body.draft : {};
  const clip = (v) => String(v || "").replace(/[\r\n]+/g, " ").trim();
  return { first: clip(body && (body.first || src.first)).slice(0, 40), biz: clip(body && (body.biz || body.bizName || src.bizName || src.biz)).slice(0, 80) };
}
async function dropAsk(token, rec) {
  await (await store()).del("asks/" + token + ".json");
  if (rec && rec.email) await (await store()).del("askby/" + sha(rec.email) + "/" + token);
}
async function readAsk(token) {
  const rec = await readJson("asks/" + token + ".json");
  if (!rec) return null;
  if (!(Date.parse(rec.expires) > Date.now())) {
    await dropAsk(token, rec);
    return null;
  }
  return rec;
}
async function countKey(key, limit) {
  const n = Number((await (await store()).get(key)) || 0) + 1;
  await (await store()).put(key, String(n));
  return n > limit;
}

const FUNNEL_EVENTS = ["draft_started", "parent_invited", "parent_verified", "check_started", "check_passed", "published", "checkout_started", "plan_paid", "booking_sent", "ref_visit"];
function funnelDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
async function noteFunnel(event) {
  if (!FUNNEL_EVENTS.includes(event)) return;
  const key = "funnel/" + funnelDay() + "/" + event;
  const n = Number((await (await store()).get(key)) || 0) + 1;
  await (await store()).put(key, String(n));
}
async function funnelTotals(days) {
  const totals = Object.fromEntries(FUNNEL_EVENTS.map((event) => [event, 0]));
  for (let i = 0; i < days; i++) {
    const day = funnelDay(Date.now() - i * 864e5);
    for (const event of FUNNEL_EVENTS) totals[event] += Number((await (await store()).get("funnel/" + day + "/" + event)) || 0);
  }
  return totals;
}
const FUNNEL_LABELS = {
  draft_started: "Draft started",
  parent_invited: "Parent invited",
  parent_verified: "Parent verified",
  check_started: "Card check started",
  check_passed: "Card check passed",
  published: "Published",
  checkout_started: "Checkout started",
  plan_paid: "Plan paid",
  booking_sent: "Booking sent",
  ref_visit: "Referral visit"
};
async function funnelTable() {
  const week = await funnelTotals(7);
  const month = await funnelTotals(30);
  const rows = FUNNEL_EVENTS.map((event) => `<tr><td style="padding:6px 8px">${FUNNEL_LABELS[event]}</td><td style="padding:6px 8px">${week[event]}</td><td style="padding:6px 8px">${month[event]}</td></tr>`).join("");
  return `<h2 style="font-size:20px;margin:8px 0">Funnel</h2><p style="color:#5a6672;margin:0 0 8px">Totals only. No names, emails, or addresses.</p><table style="border-collapse:collapse;margin:0 0 18px"><thead><tr style="text-align:left"><th style="padding:6px 8px">Step</th><th style="padding:6px 8px">7 days</th><th style="padding:6px 8px">30 days</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function routeRequest(req) {
  const method = String(req.method || "GET").toUpperCase();
  let path = String(req.path || "/");
  const qMark = path.indexOf("?");
  if (qMark >= 0) path = path.slice(0, qMark);
  const origin = await publicOrigin(req.origin);
  if (method === "OPTIONS") return withCors({ status: 204, headers: {}, body: "" }, req.headers && req.headers.origin);
  if (method === "GET") {
    const bare = path.replace(/^\/api\/site\//, "/");
    if (bare === "/robots.txt") return textFile(robotsTxt(origin), "text/plain; charset=utf-8");
    if (bare === "/sitemap.xml") return textFile(await sitemapXml(origin), "application/xml; charset=utf-8");
    if (bare === "/favicon.ico") return { status: 200, headers: { "content-type": "image/x-icon", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" }, body: icoFromPng(iconPng(32, false)) };
    if (bare === "/apple-touch-icon.png") return pngResponse(iconPng(180, false));
  }
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
    const rec = await readAsk(askGet[1]);
    if (!rec) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    return withCors(json(200, { ok: true, status: rec.status || "waiting", url: rec.url || "", expires: rec.expires }), req.headers && req.headers.origin);
  }

  const draftGet = route.match(/^draft\/([a-z0-9]{8})$/);
  if (method === "GET" && draftGet) {
    const rec = await readJson("drafts/" + draftGet[1] + ".json");
    if (!rec || Date.now() - Date.parse(rec.updatedAt || 0) > DRAFT_MS) {
      if (rec) await (await store()).del("drafts/" + draftGet[1] + ".json");
      // A draft code is the only key to a kid's draft. Wrong codes are
      // counted per address so nobody can sit and guess them.
      if (await countKey(counterKey("codemiss", clientIp(req)), CODE_MISS_LIMIT)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
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
    // Family plan: the caller may name which of the family's pages is
    // moving (body.from); without one, the primary page moves, as before.
    const from = String(body.from || account.slug || "").trim().toLowerCase();
    const next = String(body.slug || "").trim().toLowerCase();
    if (!from || !slugsOf(account).includes(from)) return withCors(json(400, { ok: false, error: "slug", message: "Publish the page first." }), req.headers && req.headers.origin);
    if (next === from) return withCors(json(200, { ok: true, slug: from, url: (origin || "") + "/" + from, same: true }), req.headers && req.headers.origin);
    const slugErr = checkSlug(next);
    if (slugErr) return withCors(json(400, { ok: false, error: "slug", message: slugErr }), req.headers && req.headers.origin);
    const taken = await readJson("pages/" + next + ".json");
    if (taken && (taken.accountId !== account.id || taken.status!=="redirect" || taken.to!==from)) return withCors(json(409, { ok: false, error: "taken", message: "That link is taken. Try another." }), req.headers && req.headers.origin);
    const now = Date.now();
    account.slugChanges = (Array.isArray(account.slugChanges) ? account.slugChanges : []).filter((at) => now - Date.parse(at) < 90 * 864e5);
    if (account.slugChanges.length >= 3) return withCors(json(429, { ok: false, error: "limit", message: "You can change the web address 3 times in 90 days. Try again later." }), req.headers && req.headers.origin);
    const htmlPage = await (await store()).get("pages/" + from + ".html");
    const prev = await readJson("pages/" + from + ".json");
    if (!htmlPage || !prev || prev.accountId !== account.id) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const until = new Date(now + 90 * 864e5).toISOString();
    await (await store()).put("pages/" + next + ".html", htmlPage);
    await writeJson("pages/" + next + ".json", { ...prev, slug: next, status: prev.status, updatedAt: new Date(now).toISOString() });
    account.formerSlugs = Array.isArray(account.formerSlugs) ? account.formerSlugs : [];
    for (const old of account.formerSlugs) {
      const rec = await readJson("pages/" + old + ".json");
      // Only this page's own redirects follow it to the new address; a
      // sibling page's redirects keep pointing at the sibling.
      if (rec && rec.accountId === account.id && rec.status === "redirect" && rec.to === from) {
        rec.to = next;
        rec.until = until;
        await writeJson("pages/" + old + ".json", rec);
      }
    }
    await writeJson("pages/" + from + ".json", { slug: from, accountId: account.id, status: "redirect", to: next, until, updatedAt: new Date(now).toISOString() });
    account.formerSlugs.push(from);
    swapAccountSlug(account, from, next);
    account.slugChanges.push(new Date(now).toISOString());
    await saveAccount(account);
    return withCors(json(200, { ok: true, slug: next, from, url: (origin || "") + "/" + next, until }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "auth/start") {
    const email = emailOk(body.email);
    if (!email) return withCors(json(400, { ok: false, error: "email" }), req.headers && req.headers.origin);
    const day = new Date().toISOString().slice(0, 10);
    if (await countKey(counterKey("authem", email), 5)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    if (await countKey(counterKey("authip", clientIp(req)), 8)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    let account = await accountByEmail(email);
    const code = String(randomInt(100000, 1000000));
    if (!account) account = { id: rand(8), email, createdAt: new Date().toISOString(), consentAt: null, plan: null, paidUntil: null, slug: null, slugs: [] };
    if(!account.trialEndsAt){const clock=await readJson(trialKey(email));if(clock&&clock.trialEndsAt){account.trialStartedAt=clock.trialStartedAt;account.trialEndsAt=clock.trialEndsAt;}}
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
      expiresAt:account.verifyExpires,
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
    await noteFunnel("parent_verified");
    account.sessionVersion=2;
    account.sessionExpiresAt = Date.now() + SESSION_COOKIE_MAX_AGE * 1000;
    account.verifyHash = "";
    const token = rand(32);
    if (account.tokenHash) await (await store()).del("tokens/" + account.tokenHash);
    account.tokenHash = sha(token);
    await saveAccount(account);
    return withCors(json(200, { ok: true, token, email, consent: consentReady(account), slug: account.slug || "", slugs: slugsOf(account), plan: account.plan || "", paid: paid(account) }, { "set-cookie": sessionCookieHeader(token) }), req.headers && req.headers.origin);
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
      ok: true, email: account.email, verified: !!account.emailVerifiedAt, consent: consentReady(account), consentMethod: consentReady(account) ? (account.consentMethod || "") : "",
      plan: account.plan || "", planName: comped(account) ? "Friends & family" : account.planName || "", paidUntil: account.paidUntil || "", paid: paid(account), comp: comped(account),
      grace: inGrace(account), graceDays: graceLeftDays(account), renewable: renewable(account),
      trialUsed: used, trialLeft: null,
      trialDays: trialLengthDays(), trialDaysLeft: trialDaysLeft(account), trialEndsAt: account.trialEndsAt || "",
      trialOver: trialOver(account, used),
      exportAllowed: !onBreak(account) && !trialOver(account, used),
      seasonName: season.name, seasonEnd: season.end, yearEnd: year.end,
      shareStreet: !!account.shareStreet, jobCode: account.jobCode || account.draftCode || "",
      slug: account.slug || "", slugs: slugsOf(account), url: account.slug && base ? base + "/" + account.slug : "", testMode: testMode(),
      payMode: paywallMode(), indexable: !!account.indexable, draftCode: account.draftCode || "",
      ...feedLinks(base, account.calToken)
    }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "funnel") {
    const event = String(body.event || "");
    if (event !== "ref_visit") return withCors(json(400, { ok: false, error: "event" }), req.headers && req.headers.origin);
    await noteFunnel(event);
    return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "consent") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (body.consent !== true) return withCors(json(400, { ok: false, error: "consent" }), req.headers && req.headers.origin);
    if (consentReady(account)) return withCors(json(200, { ok: true, consent: true, already: true, method: account.consentMethod }), req.headers && req.headers.origin);
    account.noticeAcceptedAt = new Date().toISOString();
    account.consentVersion = CONSENT_VERSION;
    if (account.plan && paid(account) && !comped(account)) {
      markPlanConsent(account, account.consentPaymentIntent || "");
      await saveAccount(account);
      return withCors(json(200, { ok: true, consent: true, method: "plan_payment", alreadyPaid: true }), req.headers && req.headers.origin);
    }
    const mode = paywallMode();
    if (mode === "stripe") {
      const started = await beginCardCheck(account, origin);
      if (started.consent) return withCors(json(200, { ok: true, consent: true, method: "card_charge", refunded: true }), req.headers && req.headers.origin);
      if (started.error === "stripe-key") return withCors(json(503, { ok: false, error: "stripe-key" }), req.headers && req.headers.origin);
      if (started.error || !started.url) return withCors(json(502, { ok: false, error: started.error || "stripe" }), req.headers && req.headers.origin);
      await noteFunnel("check_started");
      return withCors(json(200, { ok: true, needsCard: true, url: started.url, mode: "stripe", reused: !!started.reused }), req.headers && req.headers.origin);
    }
    const now = new Date().toISOString();
    const pi = "pi_test_" + account.id;
    await writeJson("payintents/" + pi + ".json", { accountId: account.id, purpose: "parent_verification" });
    account.consentAt = now;
    account.consentMethod = "card_charge";
    account.consentVersion = CONSENT_VERSION;
    account.consentPaymentIntent = pi;
    account.consentRefundedAt = now;
    await applyConsentTrial(account, testMode() ? body.fingerprint : "");
    await saveAccount(account);
    await noteFunnel("check_passed");
    return withCors(json(200, { ok: true, consent: true, refunded: true, mode, method: "card_charge", consentAt: account.consentAt }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "consent/confirm") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (consentReady(account)) return withCors(json(200, { ok: true, consent: true, method: account.consentMethod || "" }), req.headers && req.headers.origin);
    if (paywallMode() !== "stripe" || !account.verifySessionId) return withCors(json(200, { ok: true, consent: false, state: "none" }), req.headers && req.headers.origin);
    const session = await fetchCheckoutSession(account.verifySessionId);
    if (!session) return withCors(json(200, { ok: true, consent: false, state: "error" }), req.headers && req.headers.origin);
    if (session.status === "complete" && session.payment_status === "paid") {
      const refused = await completeVerification(account, session);
      return withCors(json(200, { ok: !refused, consent: consentReady(account), state: refused ? "pending" : "paid", method: account.consentMethod || "", error: refused || "" }), req.headers && req.headers.origin);
    }
    if (session.status === "open") return withCors(json(200, { ok: true, consent: false, state: "open" }), req.headers && req.headers.origin);
    return withCors(json(200, { ok: true, consent: false, state: session.status || "none" }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "checkout") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    const plan = Object.hasOwn(PLANS,body.plan)?PLANS[body.plan]:null;
    if (!plan) return withCors(json(400, { ok: false, error: "plan" }), req.headers && req.headers.origin);
    const mode = paywallMode();
    if (!renewable(account)) {
      return withCors(json(200, { ok: true, alreadyPaid: true, mode, plan: account.plan || plan.id, paidUntil: account.paidUntil }), req.headers && req.headers.origin);
    }
    if (mode === "test" || mode === "off") {
      const change = grantPlan(account, plan.id);
      markPlanConsent(account, "");
      if (mode === "off") account.paidUntil = new Date(Date.now() + 3650 * 864e5).toISOString();
      const receiptId = "pay-" + account.id + "-" + rand(4);
      const pageSlug = await checkoutSlug(account, body.slug);
      await addReceipt(account, origin, {
        id: receiptId,
        plan: plan.id,
        planName: account.planName,
        amountLabel: plan.label,
        end: account.paidUntil,
        extra: { ...change, ...(pageSlug ? { slug: pageSlug } : {}) }
      });
      await sendReceiptNote(account, origin, receiptId);
      await saveAccount(account);
      await trackPlan(account);
      await releaseHeld(account, origin);
      await noteFunnel("plan_paid");
      return withCors(json(200, { ok: true, mode, plan: plan.id, planName: account.planName, paidUntil: account.paidUntil }), req.headers && req.headers.origin);
    }
    if (mode === "stripe") {
      if(!process.env.STRIPE_SECRET_KEY)return json(503,{ok:false,error:'stripe-key'});
      const providerHeaders={Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY};
      if(account.checkoutSessionId){
        const open=await checkOpenCheckout(account,origin),session=open.session||{};
        if(open.state==='error')return json(502,{ok:false,error:'stripe'});
        if(open.state==='paid')return json(200,{ok:true,alreadyPaid:true,mode,plan:account.plan||plan.id,paidUntil:account.paidUntil});
        if(open.state==='pending')return json(200,{ok:true,pending:true,mode:'stripe'});
        if(open.state==='open'){
          if(account.checkoutPlan===plan.id)return json(200,{ok:true,mode:'stripe',url:session.url,reused:true});
          // The parent went back and picked the other plan. Close the open
          // session first so the old price can never be paid by mistake; if
          // it cannot be closed (it was paid a moment ago), stop here.
          try{const r=await fetch('https://api.stripe.com/v1/checkout/sessions/'+encodeURIComponent(account.checkoutSessionId)+'/expire',{method:'POST',headers:providerHeaders,signal:AbortSignal.timeout(8000)});if(!r.ok)return json(200,{ok:true,pending:true,mode:'stripe'});}catch{return json(502,{ok:false,error:'stripe'});}
        }
        account.checkoutGeneration=(account.checkoutGeneration||0)+1;
        account.checkoutSessionId='';account.checkoutUrl='';account.checkoutPlan='';
      }
      // A try that never produced a session (the provider call failed) keeps
      // its plan so a retry is idempotent. Asking for the other plan is a new
      // attempt with its own idempotency key.
      if(account.checkoutPlan&&account.checkoutPlan!==plan.id)account.checkoutGeneration=(account.checkoutGeneration||0)+1;
      const checkoutPlan=plan;
      account.checkoutPlan=checkoutPlan.id;
      const pageSlug=await checkoutSlug(account, body.slug);
      const attempt=sha('checkout:'+account.id+':'+(account.checkoutGeneration||0));
      const params=new URLSearchParams();
      params.set('mode','payment');params.set('customer_email',account.email);
      params.set('success_url',origin+'/?hosting=paid');params.set('cancel_url',origin+'/?hosting=cancel');
      params.set('line_items[0][quantity]','1');params.set('line_items[0][price_data][currency]','usd');
      params.set('line_items[0][price_data][unit_amount]',String(checkoutPlan.amount));
      params.set('line_items[0][price_data][product_data][name]','Hustle Builder hosting, '+planOffer(checkoutPlan.id,planBase(account)).name+', through '+niceDate(planOffer(checkoutPlan.id,planBase(account)).end));
      params.set('metadata[accountId]',account.id);params.set('metadata[plan]',checkoutPlan.id);params.set('metadata[attempt]',attempt);
      if(pageSlug){params.set('metadata[slug]',pageSlug);params.set('payment_intent_data[metadata][slug]',pageSlug);}
      params.set('payment_intent_data[statement_descriptor_suffix]',STATEMENT_SUFFIX);
      let response,data;
      try{response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{...providerHeaders,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':'hb-checkout-'+attempt},body:params,signal:AbortSignal.timeout(8000)});data=await response.json();}catch{await saveAccount(account);return json(502,{ok:false,error:'stripe'});}
      if(!response.ok||!data.url||!data.id){await saveAccount(account);return json(502,{ok:false,error:'stripe'});}
      account.checkoutSessionId=data.id;account.checkoutUrl=data.url;account.checkoutPendingAt=new Date().toISOString();
      await saveAccount(account);
      await noteFunnel("checkout_started");
      return json(200,{ok:true,mode:'stripe',url:data.url});
    }
    return withCors(json(400, { ok: false, error: "paywall" }), req.headers && req.headers.origin);
  }

  // The parent's browser lands back here after Stripe. Do not wait on the
  // webhook alone: look the session up and apply it now if it was paid.
  if (method === "POST" && route === "checkout/confirm") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    let state = "none";
    if (paywallMode() === "stripe" && account.checkoutSessionId) state = (await checkOpenCheckout(account, origin)).state;
    return withCors(json(200, { ok: true, state, paid: paid(account), paidUntil: account.paidUntil || "", planName: account.planName || "" }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "stripe/webhook") {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const header = (req.headers && (req.headers["stripe-signature"] || req.headers["Stripe-Signature"])) || "";
    if (!stripeSignatureOk(req.body || "", header, secret)) return withCors(json(400, { ok: false, error: "signature" }), req.headers && req.headers.origin);
    let event;
    try { event = JSON.parse(req.body || "{}"); } catch { return withCors(json(400, { ok: false, error: "json" }), req.headers && req.headers.origin); }
    const legacyEvent=String(event.id||'');
    if(/^[A-Za-z0-9_-]{1,80}$/.test(legacyEvent)&&await (await store()).get('stripe-events/'+legacyEvent))return json(200,{ok:true,duplicate:true});
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const obj = event.data?.object || {}, pi = String(obj.payment_intent || '');
      if (!/^evt_[A-Za-z0-9_]+$/.test(event.id || '') || !/^pi_[A-Za-z0-9_]+$/.test(pi)) return json(200, { ok: true, ignored: true });
      // A partial refund is a goodwill gesture, not the plan being undone.
      if (event.type === 'charge.refunded' && !(obj.refunded === true || (Number(obj.amount) > 0 && Number(obj.amount_refunded) >= Number(obj.amount)))) return json(200, { ok: true, ignored: true, partial: true });
      // The refunded 50¢ parent check is not a plan. It must not end a plan or take a page down.
      if (obj.metadata && obj.metadata.purpose === 'parent_verification') return json(200, { ok: true, ignored: true, verification: true });
      let pointer = await readJson('payintents/' + pi + '.json');
      if (!pointer) {
        // A payment from before receipts recorded their Stripe payment: ask
        // Stripe which checkout it belonged to, remember the answer, and
        // have Stripe deliver the event again so it runs under that
        // account's lock.
        const found = await paymentFromStripe(pi);
        if (!found) return json(200, { ok: true, ignored: true });
        if (found.purpose === 'parent_verification') {
          await writeJson('payintents/' + pi + '.json', found);
          return json(200, { ok: true, ignored: true, verification: true });
        }
        await writeJson('payintents/' + pi + '.json', found);
        return json(503, { ok: false, error: 'retry' }, { 'retry-after': '60' });
      }
      if (pointer.purpose === 'parent_verification') return json(200, { ok: true, ignored: true, verification: true });
      const account = /^[a-f0-9]{8,32}$/.test(String(pointer.accountId || '')) ? await readJson('accounts/' + pointer.accountId + '.json') : null;
      if (!account) return json(200, { ok: true, ignored: true });
      const changed = await revokeReceipt(account, pointer.receiptId, event.type === 'charge.refunded' ? 'refund' : 'dispute', origin);
      return json(200, { ok: true, refunded: changed });
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session=event.data?.object||{},meta=session.metadata||{},plan=Object.hasOwn(PLANS,meta.plan)?PLANS[meta.plan]:null;
      if(!/^evt_[A-Za-z0-9_]+$/.test(event.id||'')||!/^cs_[A-Za-z0-9_]+$/.test(session.id||''))return json(400,{ok:false,error:'event'});
      if(session.payment_status!=='paid')return json(200,{ok:true,ignored:true});
      if(meta.purpose==='parent_verification'){
        if(Number(session.amount_total)!==VERIFY_CENTS||session.currency!=='usd'||!/^([a-f0-9]{16})$/.test(meta.accountId||''))return json(400,{ok:false,error:'payment'});
        const account=await readJson('accounts/'+meta.accountId+'.json');
        if(!account)return json(200,{ok:true,ignored:true});
        const refused=await completeVerification(account,session);
        if(refused)return json(400,{ok:false,error:refused});
        return json(200,{ok:true,verification:true});
      }
      if(!plan||session.amount_total!==plan.amount||session.currency!=='usd'||!/^([a-f0-9]{16})$/.test(meta.accountId||''))return json(400,{ok:false,error:'payment'});
      if(await readJson('payments/'+sha(session.id)+'.json'))return json(200,{ok:true,duplicate:true});
      const account=await readJson('accounts/'+meta.accountId+'.json');
      if(account){
        const refused=await fulfillPaidSession(account,session,origin,event.id);
        if(refused)return json(400,{ok:false,error:refused});
      }
      else await writeJson('payments/'+sha(session.id)+'.json',{eventId:event.id,sessionId:session.id,processedAt:new Date().toISOString()});
    }
    return withCors(json(200,{ok:true}),req.headers?.origin);
  }

  if (method === "POST" && route === "publish") {
    const account = await me();
    if (!account || !account.emailVerifiedAt) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    if (!consentReady(account)) return withCors(json(403, { ok: false, error: "consent" }), req.headers && req.headers.origin);
    if (onBreak(account) || trialOver(account, 0)) return withCors(json(402, { ok: false, error: "break", message: "This plan is taking a break. Renew it, then publish again." }), req.headers && req.headers.origin);
    const slug = String(body.slug || account.slug || "").trim().toLowerCase();
    const slugErr = checkSlug(slug);
    if (slugErr) return withCors(json(400, { ok: false, error: "slug", message: slugErr }), req.headers && req.headers.origin);
    const htmlIn = String(body.html || "");
    const shape = pageOk(htmlIn);
    if (shape) return withCors(json(400, { ok: false, error: "page", message: shape }), req.headers && req.headers.origin);
    const words = checkPage(htmlIn);
    if (words) return withCors(json(400, { ok: false, error: "moderation", message: words }), req.headers && req.headers.origin);
    const steep = pricesOverMax(htmlIn);
    if (steep.length) return withCors(json(400, { ok: false, error: "price", message: "A job price is over $999 (" + steep[0] + "). Lower it, then publish again. The live page was not changed." }), req.headers && req.headers.origin);
    const existing = await readJson("pages/" + slug + ".json");
    if (existing && existing.accountId !== account.id) return withCors(json(409, { ok: false, error: "taken" }), req.headers && req.headers.origin);
    if (existing && existing.status === "down") return withCors(json(403, { ok: false, error: "down" }), req.headers && req.headers.origin);
    // Family plan: a slug this account does not own yet — and, per the
    // check above, no other family owns — JOINS the account instead of
    // refusing. It rides the account's one trial/payment: the trial-start
    // block below only fires when trialStartedAt is unset, so an added
    // page never restarts or extends the trial and never opens a checkout.
    const ownedBefore = slugsOf(account);
    const addedPage = !ownedBefore.includes(slug);
    if (addedPage && ownedBefore.length >= MAX_PAGES_PER_ACCOUNT) return withCors(json(400, { ok: false, error: "pages", message: "This account already has " + MAX_PAGES_PER_ACCOUNT + " pages, which is the most one family plan covers." }), req.headers && req.headers.origin);
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
    stored = stripParentContact(stored);
    await (await store()).put("pages/" + slug + ".html", stored);
    const pageNames = namesFromHtml(stored);
    const keptStatus = existing && ["paused","review"].includes(existing.status) ? existing.status : "live";
    await writeJson("pages/" + slug + ".json", {
      ...existing, slug, accountId: account.id, status: keptStatus, updatedAt: new Date().toISOString(), bytes: stored.length,
      indexable, card: { title: cardTitle, line: cardLine, accent, pets },
      names: { first: pageNames.first, biz: pageNames.biz }, legacyInbox: pageNames.legacyInbox
    });
    addAccountSlug(account, slug);
    account.indexable = indexable;
    // The publishing parent's browser names the family's time zone, so the
    // calendar shows a 4:00 PM job at 4:00 PM wherever they live.
    const tz = validTz(body.tz);
    if (tz) account.tz = tz;
    // A checkout, including one that is abandoned or never paid, does not
    // start this clock. Consent does, and so does the first publish when
    // consent did not. A clock already on the account (same Gmail inbox,
    // or a card that already had a trial) is left as it is.
    if (!paid(account)) beginTrial(account);
    await rememberAccount(account);
    const jobCode = String(body.draftCode || account.jobCode || account.draftCode || "").toLowerCase();
    account.jobCode = /^[a-z0-9]{8}$/.test(jobCode) ? jobCode : account.jobCode || rand(4).slice(0, 8);
    await (await store()).put("jobcode/" + account.jobCode, account.id);
    // "renamed" is when the page at the primary address is not the one the
    // last live note announced — the address moved and this publish is the
    // first at the new one. (sendLiveNote's mailed set suppresses the note
    // entirely for pages already announced, so this only picks wording.)
    const liveKind = addedPage && ownedBefore.length > 0
      ? "added"
      : account.slug === slug && account.liveMailed && account.liveMailed !== slug ? "renamed" : "";
    await sendLiveNote(account, origin, slug, liveKind);
    if (!existing) await noteFunnel("published");
    await saveAccount(account);
    const url = (origin || "") + "/" + slug;
    const used = await trialCount(account.email);
    return withCors(json(200, { ok: true, slug, url, updated: !!existing, added: addedPage, slugs: slugsOf(account), jobCode: account.jobCode, trialLeft: null, trialDaysLeft: trialDaysLeft(account), trialEndsAt: account.trialEndsAt || "" }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "unpublish") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    // Family plan: unpublishing is per page — the caller names the page,
    // defaulting to the primary, and sibling pages stay up.
    const slug = String(body.slug || account.slug || "").trim().toLowerCase();
    if (!slug || !slugsOf(account).includes(slug)) return withCors(json(200, { ok: true }), req.headers && req.headers.origin);
    const meta = await readJson("pages/" + slug + ".json");
    if (meta && meta.accountId === account.id) {
      meta.status = "offline";
      await writeJson("pages/" + slug + ".json", meta);
      await (await store()).del("pages/" + slug + ".html");
    }
    return withCors(json(200, { ok: true, slug }), req.headers && req.headers.origin);
  }

  if (method === "DELETE" && route === "account") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    await eraseRelated(account);
    for (const slug of slugsOf(account)) {
      await (await store()).del("pages/" + slug + ".html");
      await (await store()).del("pages/" + slug + ".json");
    }
    if (account.tokenHash) await (await store()).del("tokens/" + account.tokenHash);
    if (account.calToken) await (await store()).del("caltokens/" + sha(account.calToken));
    await (await store()).del("caljobs/" + account.id + ".json");
    if (account.draftCode) await (await store()).del("drafts/" + account.draftCode + ".json");
    if (account.draftCode) await (await store()).del("draftby/" + account.id + "/" + account.draftCode);
    await (await store()).del("draftacct/" + account.id);
    await (await store()).del("email/" + sha(account.email));
    await (await store()).del("outbox/" + sha(account.email) + ".json");
    await (await store()).del("accounts/" + account.id + ".json");
    return withCors(json(200, { ok: true }, { "set-cookie": clearSessionCookieHeader() }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "ask") {
    const email = emailOk(body.email);
    if (!email) return withCors(json(400, { ok: false, error: "email" }), req.headers && req.headers.origin);
    const names = askNames(body);
    const day = new Date().toISOString().slice(0, 10);
    if (await countKey(counterKey("askem", email), 5)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    if (await countKey(counterKey("askip", clientIp(req)), 8)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    const token = rand(24);
    const expires = new Date(Date.now() + ASK_MS).toISOString();
    await writeJson("asks/" + token + ".json", { email, first: names.first, biz: names.biz, createdAt: new Date().toISOString(), expires, status: "waiting", url: "" });
    await ownerIndexSince();
    await (await store()).put("askby/" + sha(email) + "/" + token, String(Date.now()));
    const link = (origin || "") + "/?ask=" + token;
    const who = names.first || "Your kid";
    const ready = names.biz ? who + " is ready to publish " + names.biz + "." : "Your kid is ready to publish a Hustle Builder page.";
    const mailed = await sendMail({
      to: email,
      replyTo: supportReply(),
      forParent: true,
      origin,
      subject: names.biz ? who + " asked you to publish " + names.biz : "Your kid asked you to publish their page",
      text: ready + "\n\n" + trialBlurb() + " A first-time parent verifies their email and completes a 50¢ card check that is refunded right away. Plans never renew automatically.\n\nAfter that, a season is " + PLANS.season.label + " and a year is " + PLANS.year.label + ".\n\nThe page itself stays on their phone until you agree. Review the page together on the device where your child built it. Choose Go live, then “I’m the parent — continue here.” This invitation link expires in 7 days, and we delete the request then if you have not agreed.\n\n" + link + "\n" + (supportReply() ? "" : "\nReplies to this email aren't read.\n"),
      html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>" + mailEscape(ready) + "</p><p>" + mailEscape(trialBlurb()) + " A first-time parent verifies their email and completes a 50¢ card check that is refunded right away. Plans never renew automatically.</p><p>After that, a season is " + PLANS.season.label + " and a year is " + PLANS.year.label + ".</p><p>The page itself stays on their device until you agree. Review it together there: choose Go live, then “I’m the parent — continue here.”</p><p><a href=\"" + mailEscape(link) + "\">View the invitation</a></p><p>The link expires in 7 days, and we delete this request then if you have not agreed.</p>" + (supportReply() ? "" : "<p>Replies to this email aren't read.</p>") + "</div>"
    });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    await noteFunnel("parent_invited");
    return withCors(json(200, { ok: true, token, link, expires }), req.headers && req.headers.origin);
  }

  const askOpen = route.match(/^ask\/([a-f0-9]{32,128})\/open$/i);
  if (method === "POST" && askOpen) {
    const rec = await readAsk(askOpen[1]);
    if (!rec) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const account=await me();
    const names={first:rec.first||"",biz:rec.biz||""};
    if(!account || account.email!==rec.email)return withCors(json(200,{ok:true,requiresVerification:true,email:rec.email,...names}),req.headers?.origin);
    return withCors(json(200,{ok:true,email:rec.email,...names,consent:consentReady(account),paid:paid(account),slug:account.slug||'',slugs:slugsOf(account),status:rec.status||'waiting',url:rec.url||''}),req.headers?.origin);
  }

  const askDone = route.match(/^ask\/([a-f0-9]{32,128})\/done$/i);
  if (method === "POST" && askDone) {
    const rec = await readAsk(askDone[1]);
    if (!rec) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    const account=await me();
    const slug=String(body.slug||String(body.url||'').split('/').pop()||account?.slug||'').trim().toLowerCase();
    if(!account||account.email!==rec.email||!slugsOf(account).includes(slug))return json(401,{ok:false,error:'auth'});
    const live=await readJson('pages/'+slug+'.json');
    if(!live||live.status!=='live'||live.accountId!==account.id)return json(409,{ok:false,error:'page'});
    rec.status = "live";
    rec.url=origin+"/"+slug;
    rec.liveAt = new Date().toISOString();
    await writeJson("asks/" + askDone[1] + ".json", rec);
    return withCors(json(200, { ok: true, status: "live", url: rec.url }), req.headers && req.headers.origin);
  }

  if (method === "POST" && route === "draft") {
    const account = await me();
    if (!account || !consentReady(account)) return withCors(json(403, { ok: false, error: "consent" }), req.headers && req.headers.origin);
    const packed = clipDraft(body.draft);
    if (!packed) return withCors(json(400, { ok: false, error: "draft" }), req.headers && req.headers.origin);
    if (packed.error) return withCors(json(413, { ok: false, error: "big" }), req.headers && req.headers.origin);
    let code = String(body.code || "").trim().toLowerCase();
    if (code && !/^[a-z0-9]{8}$/.test(code)) return withCors(json(400, { ok: false, error: "code" }), req.headers && req.headers.origin);
    const day = new Date().toISOString().slice(0, 10);
    const existing = code ? await readJson("drafts/" + code + ".json") : null;
    if (!existing && await countKey(counterKey("draftnew", clientIp(req)), 40)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
    let rec = existing;
    const freshDraft = !code || !rec;
    if (freshDraft) {
      code = draftCode();
      rec = { createdAt: new Date().toISOString() };
    }
    rec.draft = packed.draft;
    rec.updatedAt = new Date().toISOString();
    if (account) {
      rec.accountId = account.id;
      account.draftCode = code;
      await saveAccount(account);
      await ownerIndexSince();
      await (await store()).put("draftby/" + account.id + "/" + code, String(Date.now()));
      await (await store()).put("draftacct/" + account.id, code);
    }
    await writeJson("drafts/" + code + ".json", rec);
    if (freshDraft) await noteFunnel("draft_started");
    const link = (origin || "") + "/?draft=" + code;
    return withCors(json(200, { ok: true, code, link }), req.headers && req.headers.origin);
  }

  const cancelPost = route.match(/^cancel\/([a-f0-9]{20,80})$/i);
  if (method === "POST" && cancelPost) {
    const rec = await readJson("cancels/" + cancelPost[1] + ".json");
    if (!rec || rec.expiresAt && rec.expiresAt<Date.now()) return cancelPage(cancelPost[1], false, true);
    if (!rec.used) {
      rec.used = true;
      rec.cancelledAt = new Date().toISOString();
      await writeJson("cancels/" + cancelPost[1] + ".json", rec);
      let cancelIcs = "";
      if (rec.requestId && rec.accountId) {
        const rows = await loadRequests(rec.accountId);
        const row = rows.find((item) => item.id === rec.requestId);
        if (row && row.status !== "done") {
          row.status = "cancelled";
          cancelIcs = takeCancelIcs(row);
          await removeCalendarRequest(rec.accountId,row);
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
        html: "<p style=\"font:18px/1.45 system-ui,sans-serif\">" + mailEscape(rec.customer) + " cancelled the request for " + mailEscape(rec.service || "a job") + (rec.when ? " on " + mailEscape(rec.when) : "") + ".</p>",
        ics: cancelIcs
      });
    }
    return cancelPage(cancelPost[1], true, false);
  }

  if (method === "GET" && route === "plans") {
    const season = seasonOffer();
    const year = yearOffer();
    return withCors(json(200, {
      ok: true,
      free: trialBlurb(),
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
    const parentSession = account;
    const code = String((req.query && req.query.get && req.query.get("code")) || "").trim().toLowerCase();
    if (!account && /^[a-z0-9]{8}$/.test(code)) {
      const id = await (await store()).get("jobcode/" + code);
      if (id) account = await readJson("accounts/" + id.trim() + ".json");
      if (!account) {
        const draft = await readJson("drafts/" + code + ".json");
        if (draft && draft.accountId) account = await readJson("accounts/" + draft.accountId + ".json");
      }
    }
    if (!account) {
      if (code && await countKey(counterKey("codemiss", clientIp(req)), CODE_MISS_LIMIT)) return withCors(json(429, { ok: false, error: "limit" }), req.headers && req.headers.origin);
      return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    }
    const rows = await loadRequests(account.id);
    const jobs = rows.map((row) => {
      const job = kidJob(row, account);
      if (parentSession && parentSession.id === account.id && row.actionToken) job.action = row.actionToken;
      return job;
    });
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
    if (!account || !row) return finishedPage("This request is no longer stored. Requests are deleted about 30 days after they arrive.");
    if (method === "POST") {
      const next = String(body.status || "");
      if (next !== "confirmed" && next !== "done" && next !== "cancelled") return json(400, { ok: false, error: "status" });
      const cancelIcs = next === "cancelled" ? takeCancelIcs(row) : "";
      row.status = next;
      if(next==='cancelled')await removeCalendarRequest(account.id,row);
      await saveRequests(account.id, rows);
      if (cancelIcs) await sendMail({
        to: account.email,
        replyTo: supportReply(),
        forParent: true,
        origin,
        subject: "Booking cancelled: " + (row.service || "a job"),
        text: "You marked this request cancelled. It comes off your calendar.\n\n" + (row.firstName || "Neighbor") + " · " + (row.service || "a job"),
        html: "<p style=\"font:18px/1.45 system-ui,sans-serif\">You marked this request cancelled. It comes off your calendar.</p>",
        ics: cancelIcs
      });
      if (body.json === true) return json(200, { ok: true, status: row.status });
    }
    const title = row.status === "new" ? "New request" : row.status[0].toUpperCase() + row.status.slice(1);
    return shell(200, title, `<h1>${mailEscape(row.service || "A job")}</h1>
<p>${mailEscape(row.firstName || "Neighbor")} · ${mailEscape(row.when || "")}</p>
<p>Status: <b id="st">${mailEscape(row.status)}</b></p>
<p>${mailEscape((row.fields && row.fields.contact) || "")}<br>${mailEscape((row.fields && row.fields.address) || "")}</p>
<p>Nothing is booked until you reply to the customer. These buttons only update your own list and the kid’s My jobs.</p>
<button type="button" id="yes">Confirmed</button>
<button type="button" id="done">Done</button>
<button type="button" id="no" class="alt">Cancelled</button>
<p id="msg" role="status"></p>
<script>
async function mark(status){
  const msg=document.getElementById("msg");
  try{
    const res=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status})});
    if(res.ok){document.getElementById("st").textContent=status;msg.textContent="Saved.";}
    else msg.textContent="Could not save that. Try again.";
  }catch(e){msg.textContent="Could not save that. Check your connection and try again.";}
}
document.getElementById("yes").onclick=()=>mark("confirmed");
document.getElementById("done").onclick=()=>mark("done");
document.getElementById("no").onclick=()=>mark("cancelled");
</script>`);
  }

  const renewGet = route.match(/^renew\/([a-f0-9]{16,80})$/i);
  if (method === "GET" && renewGet) {
    const id = await (await store()).get("renew/" + renewGet[1]);
    const account = id ? await readJson("accounts/" + id.trim() + ".json") : null;
    if (!account) return finishedPage("This renew link is no longer active. Open your account to see your plan.");
    if (comped(account)) {
      return shell(200, "You're covered", `<h1>You're covered</h1><p>This page is on the friends &amp; family plan — free, with no payment due. There is nothing to renew.</p><p><a href="${mailEscape(accountUrl(origin))}">Your account</a></p>`);
    }
    // Paying needs the signed-in parent, so the link never charges anything
    // by itself. It opens the account screen with the plan already picked;
    // the parent signs in if needed and taps Pay there.
    const planId = (req.query && req.query.get && req.query.get("plan")) === "year" ? "year" : "season";
    return redirect((origin || "") + "/?account=1&plan=" + planId);
  }

  if (method === "POST" && route === "book") {
    let slug=String(body.slug||'').trim().toLowerCase();
    if(checkSlug(slug))return json(400,{ok:false,error:'slug'});
    let meta=await readJson('pages/'+slug+'.json');
    const owner=meta?.accountId,seen=new Set([slug]);
    for(let hops=0;meta?.status==='redirect'&&hops<8;hops++){
      if(Date.parse(meta.until||'')<=Date.now()||checkSlug(meta.to)||seen.has(meta.to))return json(404,{ok:false,error:'missing'});
      slug=meta.to;seen.add(slug);meta=await readJson('pages/'+slug+'.json');
      if(meta?.accountId!==owner)return json(404,{ok:false,error:'missing'});
    }
    if(!meta||meta.status!=='live')return json(404,{ok:false,error:'missing'});
    const account = await readJson("accounts/" + meta.accountId + ".json");
    if (!account) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    if (onBreak(account)) return withCors(json(403, { ok: false, error: "break", message: "This page is taking a break. Bookings are paused." }), req.headers && req.headers.origin);
    const ip = clientIp(req);
    const idempotency=String(body.requestId||'');
    if(idempotency && !/^[A-Za-z0-9_-]{16,80}$/.test(idempotency))return json(400,{ok:false,error:'request-id'});
    const payloadHash=sha(JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key])=>!['t','hp','company','requestId','slug'].includes(key)).sort(([a],[b])=>a.localeCompare(b)))));
    const dedupe=idempotency?sha(slug+'|'+idempotency):sha(slug+'|'+ip+'|'+payloadHash+'|'+Math.floor(Date.now()/300000));
    const prior=await readJson('bookingids/'+account.id+'/'+dedupe);
    if(prior){if(prior.payloadHash!==payloadHash)return json(409,{ok:false,error:'request-id'});return json(200,{ok:true,held:prior.held,id:prior.id,duplicate:true});}
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
    const titled = jobTitle(fields.service, fields.note);
    const job = startOk ? {
      id: "b" + rand(8),
      source: "book",
      service: titled,
      customer: fields.name,
      address: fields.address,
      start,
      note: jobNote,
      createdAt: new Date().toISOString()
    } : null;
    const gcal = job ? gcalTemplate(job, tzOf(account)) : "";
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
      "Job: " + titled,
      "When: " + fields.when,
      "Size: " + (fields.size || "not sure"),
      "How often: " + fields.freq,
      petBits.join("\n"),
      "Address: " + fields.address,
      "Note: " + (fields.note || "none"),
      "",
      gcal ? "Add this job to Google Calendar:\n" + gcal : "",
      "",
      "We keep the name, address, and time for the family calendar for about 30 days. It is not a customer list."
    ].filter((line, i, arr) => line !== "" && !(line === "" && arr[i - 1] === "")).join("\n");
    const link = (href, label) => href ? "<a href=\"" + mailEscape(href) + "\" style=\"font-weight:700\">" + mailEscape(label) + "</a>" : "";
    const htmlMail = "<div style=\"font:18px/1.45 system-ui,sans-serif;color:#1d2226\">"
      + (unread ? "<p><b>" + mailEscape(unread) + "</b></p>" : "")
      + "<p>" + [link(tel, "Call " + fields.name), link(sms, "Text " + fields.name), link(reply ? "mailto:" + reply : "", reply ? "Email " + fields.name : "")].filter(Boolean).join(" &nbsp; ") + "</p>"
      + (flagLine ? "<p>" + mailEscape(flagLine) + "</p>" : "")
      + "<p>New booking request. Nothing is booked until you reply to the customer.</p>"
      + "<p>Name: " + mailEscape(fields.name) + "<br>Reach them at: " + mailEscape(fields.contact) + "<br>Job: " + mailEscape(titled) + "<br>When: " + mailEscape(fields.when) + "<br>Address: " + mailEscape(fields.address) + "<br>Note: " + mailEscape(fields.note || "none")
      + (petBits.length ? "<br>" + petBits.map(mailEscape).join("<br>") : "") + "</p>"
      + (gcal ? "<p><a href=\"" + mailEscape(gcal) + "\">Add this job to Google Calendar</a></p>" : "")
      + "<p>We keep the name, address, and time for the family calendar for about 30 days.</p>"
      + "</div>";
    if (!account.renewToken) account.renewToken = rand(16);
    await (await store()).put("renew/" + account.renewToken, account.id);
    const links = payLinks(origin, account);
    const used = await trialCount(account.email);
    const mode = (paid(account) || inGrace(account)) ? "paid" : (trialClockOpen(account) ? "trial" : "hold");
    const requestId = "r" + rand(8);
    const actionToken = rand(12);
    const actionUrl = (origin || "") + "/api/job/" + actionToken;
    const names = await siteNames(slug, meta);
    const summary = job ? inviteSummary(names.first, titled, fields.name) : "";
    const description = job ? [job.note, "Mark confirmed or done: " + actionUrl].filter(Boolean).join("\n") : "";
    const ics = job ? bookingInviteIcs({
      id: job.id, start: job.start, tz: tzOf(account), summary,
      location: fields.address, description, attendee: account.email, sequence: 0, method: "REQUEST"
    }) : "";
    const row = {
      id: requestId,
      actionToken,
      slug,
      parentEmail: account.email,
      replyTo: reply || supportReply(),
      firstName: firstName(fields.name),
      service: titled,
      when: fields.when || start,
      address: fields.address,
      status: mode === "hold" ? "held" : "new",
      fields,
      ics,
      invite: job ? {
        uid: job.id + "@hustlebuilder.org", sequence: 0, start: job.start, tz: tzOf(account),
        summary, location: fields.address, description, attendee: account.email
      } : null,
      calJob: job,
      calendarJobId:job?.id||null,
      idempotencyKey:dedupe,
      createdAt: new Date().toISOString()
    };
    await (await store()).put("jobact/" + actionToken, account.id + ":" + requestId);
    const rows = await loadRequests(account.id);
    rows.push(row);
    await saveRequests(account.id, rows);
    await writeJson('bookingids/'+account.id+'/'+dedupe,{id:requestId,payloadHash,held:mode==='hold',createdAt:new Date().toISOString()});
    meta.bookCount=(meta.bookCount||0)+1;
    await writeJson('pages/'+slug+'.json',meta);
    if (mode === "hold") {
      const heldText = "You have a new request waiting. Pay to unlock it.\n\n" + row.firstName + " asked for " + titled + (fields.when ? " on " + fields.when : "") + ".\n\nThe street, email, and phone stay hidden until you pay.\n\n" + PLANS.season.label + " season:\n" + links.season + "\n\n" + PLANS.year.label + " year:\n" + links.year + "\n";
      const held = await sendMail({
        to: account.email,
        replyTo: supportReply(),
        subject: "You have a new request waiting",
        text: heldText,
        html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p><b>You have a new request waiting. Pay to unlock it.</b></p><p>" + mailEscape(row.firstName) + " asked for " + mailEscape(titled) + (fields.when ? " on " + mailEscape(fields.when) : "") + ".</p><p><a href=\"" + mailEscape(links.season) + "\">Pay " + PLANS.season.label + " for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Pay " + PLANS.year.label + " for the year</a></p></div>"
      });
      if (!held.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
      return withCors(json(200, { ok: true, held: true }), req.headers && req.headers.origin);
    }
    await ensureCalToken(account);
    const pitch = calendarPitch(origin, account);
    const fullText = text + "\n\nMark it confirmed or done:\n" + actionUrl + (pitch.text ? "\n\n" + pitch.text : "");
    const fullHtml = htmlMail.replace("</div>", "<p><a href=\"" + mailEscape(actionUrl) + "\">Mark confirmed or done</a></p>" + pitch.html + "</div>");
    const mailed = await sendMail({
      to: account.email,
      replyTo: reply || supportReply(),
      subject: (hitsWords.flag ? "Check this booking: " : "Booking request: ") + (titled || "a job"),
      text: fullText, html: fullHtml, ics
    });
    if (!mailed.ok) return withCors(json(503, { ok: false, error: "mail" }), req.headers && req.headers.origin);
    await noteFunnel("booking_sent");
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

    }

    if (reply) await notifyNeighbor({ origin, reply, fields, account, requestId, slug });
    return withCors(json(200, { ok: true, trialLeft: undefined }), req.headers && req.headers.origin);
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
    return shell(200, "Report this page", `<h1>Report this page</h1><p>Tell us what is wrong. You do not need an account.</p>${note ? `<p><b>${mailEscape(note)}</b></p>` : ""}<form method="post" action="/api/report"><input type="hidden" name="slug" value="${mailEscape(slug)}">${choices}<label style="display:block;margin:14px 0">Anything else? (optional)<textarea name="details" maxlength="500" rows="4"></textarea></label><button type="submit">Send</button></form>`);
  }
  const reportGet = route.match(/^report\/([a-z0-9][a-z0-9-]{1,40})$/);
  if (method === "GET" && reportGet) {
    const meta = await readJson("pages/" + reportGet[1] + ".json");
    if (!meta) return finishedPage("That page is not here.");
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
    if (await countKey(counterKey("reportip", ip), 8)) return reply(429, { ok: false, error: "limit" }, "That's enough reports for today.");
    meta.reports = Array.isArray(meta.reports) ? meta.reports : [];
    const mark = sha(ip).slice(0, 16);
    const freshReport = !meta.reports.some((item) => item.ip === mark);
    if (freshReport) {
      meta.reports.push({ ip: mark, reason, at: new Date().toISOString() });
      await sendMail({
        to: SUPPORT_EMAIL,
        replyTo: supportReply() || SUPPORT_EMAIL,
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
    return shell(200, "Report sent", `<h1>Thanks</h1><p>We got your note. You can close this page.</p>`);
  }

  if (method === "GET" && adminRoute === "admin") {
    const secret = process.env.ADMIN_SECRET || "";
    if (!secret) return adminSetupPage();
    if (await adminAuthed(req.headers)) return await adminDashboardPage(origin, req.query);
    return adminLoginPage(200, "");
  }

  if (method === "POST" && adminRoute === "admin/login") {
    const secret = process.env.ADMIN_SECRET || "";
    if (!secret) return adminSetupPage();
    // Every try from one address counts, right or wrong: 10 an hour is plenty
    // for the operator and far too slow for guessing. Mirrors the countKey
    // limits on auth/start, with an hour bucket instead of a day.
    const hour = new Date().toISOString().slice(0, 13);
    if (await countKey(counterKey("adminip", clientIp(req), hour), 10)) return adminLoginPage(429, "Too many tries. Wait an hour, then try again.");
    if (!safeEqual(String(body.secret || ""), secret)) return adminLoginPage(401, "That password did not work.");
    const token = await issueAdminSession();
    return { status: 302, headers: { location: "/admin", "cache-control": "no-store", "set-cookie": adminCookieHeader(token) }, body: "" };
  }

  if (method === "POST" && adminRoute === "admin/logout") {
    await dropAdminSession(req.headers);
    return { status: 302, headers: { location: "/admin", "cache-control": "no-store", "set-cookie": clearAdminCookieHeader() }, body: "" };
  }

  // Refund a payment from the dashboard. GET shows what will happen and asks
  // for a second click; POST sends the money back through Stripe (when the
  // payment was a real one) and ends the plan that payment bought. A
  // payment made in test mode has nothing to send back, so only the plan ends.
  if ((method === "GET" || method === "POST") && adminRoute === "admin/refund") {
    const secret = process.env.ADMIN_SECRET || "";
    if (!secret) return adminSetupPage();
    const back = (note) => ({ status: 302, headers: { location: "/admin" + (note ? "?note=" + note : ""), "cache-control": "no-store" }, body: "" });
    if (!(await adminAuthed(req.headers))) return back("");
    const src = method === "GET" ? { id: req.query && req.query.get && req.query.get("id"), receipt: req.query && req.query.get && req.query.get("receipt") } : body;
    const id = String(src.id || ""), receiptId = String(src.receipt || "");
    if (!/^[a-f0-9]{8,32}$/.test(id) || !/^[a-z0-9-]{1,80}$/.test(receiptId)) return back("");
    const account = await readJson("accounts/" + id + ".json");
    const item = account && (account.receipts || []).find((r) => r && r.id === receiptId);
    if (!item || item.refundedAt) return back("refund-none");
    const age = Math.floor((Date.now() - Date.parse(item.at || "")) / 864e5);
    const earlier = (account.receipts || []).filter((r) => r && r.refundedAt).length;
    const real = String(item.id).startsWith("stripe-");
    if (method === "GET") {
      return html(200, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Refund</title></head><body>
<main style="max-width:34rem;margin:2rem auto;font:17px/1.5 system-ui,sans-serif;padding:0 1rem">
<h1>Refund ${mailEscape(item.amountLabel || "")}?</h1>
<p><b>${mailEscape(account.email || "")}</b><br>${mailEscape(item.planName || item.plan || "Plan")} · paid ${mailEscape(niceDate(item.at))} (${age <= 0 ? "today" : age + " day" + (age === 1 ? "" : "s") + " ago"})</p>
<p>${age <= REFUND_DAYS ? "Inside the " + REFUND_DAYS + "-day money-back window." : "<b>Past the " + REFUND_DAYS + "-day window.</b> The terms do not require this refund; it is your call."}${earlier ? " This family has had " + earlier + " refund" + (earlier === 1 ? "" : "s") + " before." : ""}</p>
<p>${real ? "The full amount goes back to the card through Stripe." : "This was a test-mode payment, so there is no money to send back."} The plan it bought ends now and the family gets an email. The page returns to how it was before the payment; nothing is deleted.</p>
<form method="post" action="/admin/refund"><input type="hidden" name="id" value="${mailEscape(id)}"><input type="hidden" name="receipt" value="${mailEscape(receiptId)}">
<button type="submit" style="font:17px system-ui;padding:10px 16px">${real ? "Refund and end the plan" : "End the plan"}</button> &nbsp; <a href="/admin">Cancel</a></form>
</main></body></html>`);
    }
    if (real) {
      if (!process.env.STRIPE_SECRET_KEY) return back("refund-failed");
      const paymentIntent = await receiptPaymentIntent(account, item);
      if (!paymentIntent) return back("refund-failed");
      let ok = false;
      try {
        const params = new URLSearchParams({ payment_intent: paymentIntent, reason: "requested_by_customer" });
        const r = await fetch("https://api.stripe.com/v1/refunds", { method: "POST", headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": "hb-refund-" + receiptId }, body: params, signal: AbortSignal.timeout(8000) });
        const data = await r.json().catch(() => ({}));
        // Already refunded in the Stripe dashboard counts as done.
        ok = r.ok || (data && data.error && data.error.code === "charge_already_refunded");
      } catch { ok = false; }
      if (!ok) return back("refund-failed");
      if (!item.paymentIntent) { item.paymentIntent = paymentIntent; await writeJson("payintents/" + paymentIntent + ".json", { accountId: account.id, receiptId }); }
    }
    await revokeReceipt(account, receiptId, "refund", origin);
    return back("refund-done");
  }

  // The one place a friends & family comp is granted or taken back. It
  // rides the dashboard's own admin session (never the bare secret, never
  // a public path): no session, no change, and no account data back.
  if (method === "POST" && adminRoute === "admin/comp") {
    const secret = process.env.ADMIN_SECRET || "";
    if (!secret) return adminSetupPage();
    const back = { status: 302, headers: { location: "/admin", "cache-control": "no-store" }, body: "" };
    if (!(await adminAuthed(req.headers))) return back;
    const id = String(body.id || "");
    if (!/^[a-f0-9]{8,32}$/.test(id)) return back;
    const account = await readJson("accounts/" + id + ".json");
    if (!account) return back;
    if (String(body.on || "") === "1") {
      account.comp = true;
      account.compAt = new Date().toISOString();
      await saveAccount(account);
      // Like a payment landing: requests held while the family was paused
      // for payment are released to the parent right away.
      await releaseHeld(account, origin);
    } else {
      delete account.comp;
      delete account.compAt;
      await saveAccount(account);
    }
    return back;
  }

  // Restore and take-down work two ways: from the dashboard's buttons (an
  // admin session cookie and a form post, answered with a redirect back),
  // or scripted with the x-admin-secret header and a JSON body.
  if (method === "POST" && (adminRoute === "admin/restore" || adminRoute === "admin/takedown")) {
    const secret = process.env.ADMIN_SECRET || "";
    const given = (req.headers && (req.headers["x-admin-secret"] || req.headers["X-Admin-Secret"])) || "";
    const viaForm = !given && !String(req.body || "").trim().startsWith("{");
    const back = { status: 302, headers: { location: "/admin", "cache-control": "no-store" }, body: "" };
    if (!secret) return viaForm ? adminSetupPage() : withCors(json(503, { ok: false, error: "admin" }), req.headers && req.headers.origin);
    const allowed = given ? safeEqual(given, secret) : await adminAuthed(req.headers);
    if (!allowed) return viaForm ? back : withCors(json(401, { ok: false, error: "admin" }), req.headers && req.headers.origin);
    const slug = String(body.slug || "").trim().toLowerCase();
    const meta = checkSlugShape(slug) ? await readJson("pages/" + slug + ".json") : null;
    if (!meta || meta.status === "redirect") return viaForm ? back : withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
    if (adminRoute === "admin/takedown") {
      meta.status = "down";
      meta.downAt = new Date().toISOString();
      await writeJson("pages/" + slug + ".json", meta);
      return viaForm ? back : withCors(json(200, { ok: true, slug }), req.headers && req.headers.origin);
    }
    // Restore: a page hidden by reports goes live again; a page the operator
    // took down goes back to live (or to offline if the family removed it).
    if (meta.status === "review") meta.status = "live";
    else if (meta.status === "down") {
      meta.status = (await (await store()).get("pages/" + slug + ".html")) ? "live" : "offline";
      delete meta.downAt;
    }
    meta.reports = [];
    meta.reviewMailed = false;
    meta.restoredAt = new Date().toISOString();
    await writeJson("pages/" + slug + ".json", meta);
    return viaForm ? back : withCors(json(200, { ok: true, slug, status: meta.status }), req.headers && req.headers.origin);
  }

  if (method === "GET" && route === "account") {
    const account = await me();
    if (!account) return withCors(json(401, { ok: false, error: "auth" }), req.headers && req.headers.origin);
    await ensureRenew(account);
    await saveAccount(account);
    const used = await trialCount(account.email);
    const sites = [];
    // Family plan: one card per page the account owns. Plan, trial, and
    // renewal fields are the account's single shared state, repeated on
    // each card as before; receipts ride on the first card only (they are
    // the family's, not a page's). Booking requests are stored per
    // account; newer rows name the page they came through, and rows
    // without a page name belong to the primary (first) card.
    const rows = await loadRequests(account.id);
    const ownedSlugs = slugsOf(account);
    for (const [index, siteSlug] of ownedSlugs.entries()) {
      const meta = await readJson("pages/" + siteSlug + ".json") || {};
      sites.push({
        slug: siteSlug,
        url: (origin || "") + "/" + siteSlug,
        status: meta.status || "offline",
        plan: account.plan || "",
        planName: comped(account) ? "Friends & family" : account.planName || (paid(account) ? "Paid plan" : "Free trial"),
        paid: paid(account),
        comp: comped(account),
        paidUntil: account.paidUntil || "",
        paidUntilLabel: account.paidUntil ? niceDate(account.paidUntil) : "",
        grace: inGrace(account),
        graceDays: graceLeftDays(account),
        renewable: renewable(account),
        trialDaysLeft: trialDaysLeft(account),
        trialLeft: null,
        trialDays: trialLengthDays(),
        trialEndsLabel: account.trialEndsAt ? niceDate(account.trialEndsAt) : "",
        trialOver: trialOver(account, used),
        renew: payLinks(origin, account),
        receipts: (account.receipts || []).filter((item) => {
          const named = String(item && item.slug || "").trim().toLowerCase();
          return named ? named === siteSlug : index === 0;
        }).slice(-12).map((item) => ({
          id: item.id, plan: item.planName || item.plan || "", amount: item.amountLabel || "", at: item.at || "", end: item.endLabel || "", url: item.url || "", refunded: !!item.refundedAt, slug: item.slug || ""
        })),
        requests: rows.filter((row) => (row.slug ? row.slug === siteSlug : index === 0)).slice(-20).reverse().map((row) => ({
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
    // Family plan: pause/resume is per page — any page the account owns
    // can be paused or resumed on its own; siblings are untouched.
    if (!slugsOf(account).includes(slug)) return withCors(json(404, { ok: false, error: "missing" }), req.headers && req.headers.origin);
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
    if (!rec) return finishedPage("That receipt is not here.");
    return shell(200, "Receipt", `<h1>Receipt</h1><p>Hustle Builder hosting</p><p>${mailEscape(rec.planName || "Hustle Builder")}</p><p><b>${mailEscape(rec.amountLabel || "")}</b>${rec.at ? " · paid " + mailEscape(niceDate(rec.at)) : ""}</p>${rec.refundedAt ? `<p><b>${rec.refundReason === "dispute" ? "Disputed" : "Refunded"} ${mailEscape(niceDate(rec.refundedAt))}.</b> The plan this payment bought has ended.</p>` : `<p>Through ${mailEscape(rec.endLabel || "")}.</p>`}<p>Receipt ${mailEscape(rec.id || "")}</p><p>One-time payment. This plan does not renew on its own. Full refund if you ask within ${REFUND_DAYS} days. This is not a card statement. Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`);
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

// One account's share of the daily job: prune its old requests and calendar
// jobs, then queue any plan or trial reminder that is due. It runs in its
// own short transaction that locks only this account, so the daily job never
// pauses the rest of the site however many families there are.
async function remindAccount(id, origin, dry, due) {
  const account = await readJson("accounts/" + id + ".json");
  if (!account) return;
  if (!dry) { await loadRequests(id); await loadJobs(id); }
  paidPlan: {
      if (comped(account) || !account.paidUntil) break paidPlan;
      // Reminders go by window (14 to 4 days out, 3 to 1, the last day), not
      // by an exact day count, so one missed cron run cannot skip a reminder.
      const days = daysUntil(account.paidUntil);
      const bucket = reminderBucket(days, true);
      if (bucket === null) break paidPlan;
      const key = bucket + ":" + String(account.paidUntil).slice(0, 10);
      account.sentReminders = account.sentReminders || {};
      if (account.sentReminders[key]) break paidPlan;
      if (!account.renewToken) account.renewToken = rand(16);
      await (await store()).put("renew/" + account.renewToken, account.id);
      const links = payLinks(origin, account);
      const when = daysWords(days);
      const subject = "Your Hustle Builder plan ends " + when;
      const text = "Your " + (account.planName || "plan") + " ends " + when + ", on " + niceDate(account.paidUntil) + ".\n\nRenew from your account. Renewing early adds on to the end date, so you lose no time. Plans never renew on their own.\n\n" + PLANS.season.label + " for the season:\n" + links.season + "\n\n" + PLANS.year.label + " for the year:\n" + links.year + "\n\nAfter the end date the page stays up for 7 days, then it shows a taking-a-break page and bookings pause.";
      due.push({ email: account.email, kind: String(bucket), days });
      if (!dry) {
        await sendMail({
          to: account.email,
          replyTo: supportReply(),
          forParent: true,
          origin,
          subject,
          text,
          html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>Your <b>" + mailEscape(account.planName || "plan") + "</b> ends " + when + ", on " + mailEscape(niceDate(account.paidUntil)) + ".</p><p>Renew from your account. Renewing early adds on to the end date, so you lose no time. Plans never renew on their own.</p><p><a href=\"" + mailEscape(links.season) + "\">Renew, " + PLANS.season.label + " for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Renew, " + PLANS.year.label + " for the year</a></p><p>After the end date the page stays up for 7 days, then it shows a taking-a-break page and bookings pause.</p></div>"
        });
        account.sentReminders[key] = new Date().toISOString();
        await saveAccount(account);
      }
      }
  trial: {
      if (comped(account) || !account.trialEndsAt || paid(account) || inGrace(account)) break trial;
      const used = await trialCount(account.email);
      const days = daysUntil(account.trialEndsAt);
      const bucket = reminderBucket(days, false);
      if (bucket === null) break trial;
      const key = "trial-" + bucket + ":" + String(account.trialEndsAt).slice(0, 10);
      account.sentReminders = account.sentReminders || {};
      if (account.sentReminders[key]) break trial;
      if (!account.renewToken) account.renewToken = rand(16);
      await (await store()).put("renew/" + account.renewToken, account.id);
      const links = payLinks(origin, account);
      const when = daysWords(days);
      const subject = "Your free trial ends " + when;
      const text = "Your free trial ends " + when + ", on " + niceDate(account.trialEndsAt) + ".\n\nThe website and booking requests pause, and new flyer downloads and printing require a plan. Your saved work stays available. Pay to bring it back.\n\n" + PLANS.season.label + " for the season:\n" + links.season + "\n\n" + PLANS.year.label + " for the year:\n" + links.year + "\n";
      due.push({ email: account.email, kind: "trial-" + bucket, days });
      if (!dry) {
        await sendMail({
          to: account.email,
          replyTo: supportReply(),
          forParent: true,
          origin,
          subject,
          text,
          html: "<div style=\"font:18px/1.45 system-ui,sans-serif\"><p>Your free trial ends <b>" + when + "</b>, on " + mailEscape(niceDate(account.trialEndsAt)) + ".</p><p>The website and booking requests pause, and new flyer downloads and printing require a plan. Your saved work stays available. Pick a plan to bring it back.</p><p><a href=\"" + mailEscape(links.season) + "\">Pay " + PLANS.season.label + " for the season</a><br><a href=\"" + mailEscape(links.year) + "\">Pay " + PLANS.year.label + " for the year</a></p></div>"
        });
        account.sentReminders[key] = new Date().toISOString();
        await saveAccount(account);
      }
      }
}

// The daily job, resumable. It walks the tracked accounts in id order within
// a time budget and records how far it got; if it runs out of time, the
// five-minute mail cron picks it up from there until the day's pass is done.
// Reminders are keyed per account and window, so repeating a step is harmless.
const CRON_STATE = "cronstate/renewals.json";
export async function runRenewals({ origin, dry, budgetMs, resume }) {
  const base = await store();
  const deadline = Date.now() + budgetMs;
  const today = new Date().toISOString().slice(0, 10);
  const due = [];
  let state = null;
  if (resume) {
    try { state = JSON.parse((await base.get(CRON_STATE)) || "null"); } catch { state = null; }
    if (!state || state.day !== today || state.done) return { due, done: true, processed: 0, skipped: true };
  } else state = { day: today, after: "", done: false, swept: false };
  const save = async () => { if (!dry) await base.put(CRON_STATE, JSON.stringify(state)); };
  if (!dry && !state.swept) { await sweepExpired(); state.swept = true; await save(); }
  const ids = (await trackedAccounts()).filter((id) => /^[a-f0-9]{8,32}$/.test(id)).sort();
  let processed = 0, done = true;
  for (const id of ids) {
    if (state.after && id <= state.after) continue;
    if (Date.now() >= deadline) { done = false; break; }
    await withMailBatch(() => transaction(() => remindAccount(id, origin, dry, due), { keys: ["account:" + id] }));
    processed += 1;
    state.after = id;
    if (processed % 25 === 0) await save();
  }
  state.done = done;
  await save();
  return { due, done, processed };
}

function cronAuthed(req) {
  const secret = process.env.CRON_SECRET || process.env.ADMIN_SECRET || "";
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization || req.headers["x-cron-secret"])) || "";
  const token = String(header).replace(/^Bearer\s+/i, "");
  return !!secret && safeEqual(token, secret);
}

async function cronRequest(req, route) {
  if (!cronAuthed(req)) return json(401, { ok: false, error: "auth" });
  const origin = await publicOrigin(req.origin);
  if (route === "cron/mail") {
    // Finish today's renewal pass first if the daily run ran out of time.
    await runRenewals({ origin, dry: false, budgetMs: 15000, resume: true });
    await flushMail();
    return json(200, { ok: true });
  }
  const dry = !!(req.query && req.query.get && req.query.get("dry") === "1");
  const out = await runRenewals({ origin, dry, budgetMs: 30000, resume: false });
  if (!dry) await flushMail();
  return json(200, { ok: true, dry, due: out.due, done: out.done, processed: out.processed });
}

function takeCancelIcs(row) {
  const invite = row && row.invite;
  if (!invite || !invite.uid || invite.cancelled) return "";
  const id = String(invite.uid).replace(/@hustlebuilder\.org$/, "");
  const sequence = Number(invite.sequence || 0) + 1;
  invite.sequence = sequence;
  invite.cancelled = true;
  return bookingInviteIcs({
    id, start: invite.start, tz: invite.tz, summary: invite.summary,
    location: invite.location || "", description: invite.description || "",
    attendee: invite.attendee || row.parentEmail, sequence, method: "CANCEL"
  });
}
async function removeCalendarRequest(accountId,row) {
  const id=row.calendarJobId||row.calJob?.id||row.ics?.match(/UID:([^@\r\n]+)@/)?.[1];
  if(id)await saveJobs(accountId,(await loadJobs(accountId)).filter(j=>j.id!==id));
  row.calJob=null;
}
// Everything that belongs to one account, found by following what the
// account itself points at — never by reading every stored row. Drafts and
// "ask my parent" links are found through small owner-index pointers written
// when they are saved (draftby/<account>/<code>, askby/<email hash>/<token>).
// Records saved before that index existed are covered by a one-off scan of
// just those two folders, which switches itself off once every such record
// has aged out (90 days after the index began).
const OWNER_INDEX = "meta/owner-index.json";
async function ownerIndexSince() {
  const rec = await readJson(OWNER_INDEX);
  if (rec && Number(rec.since)) return Number(rec.since);
  const since = Date.now();
  await writeJson(OWNER_INDEX, { since });
  return since;
}
async function eraseRelated(account) {
  const s=await store();
  for(const row of await loadRequests(account.id))await removeRequestArtifacts(row,account.id);
  await s.del('requests/'+account.id+'.json');
  await s.del('planacct/'+account.id);
  for(const slug of [...slugsOf(account),...(account.formerSlugs||[])]){await s.del('pages/'+slug+'.html');await s.del('pages/'+slug+'.json');await s.del('views/'+slug+'.json');}
  if(account.renewToken)await s.del('renew/'+account.renewToken);
  if(account.jobCode)await s.del('jobcode/'+account.jobCode);
  for(const key of await s.list('bookingids/'+account.id+'/'))await s.del(key);
  for(const item of Array.isArray(account.receipts)?account.receipts:[]){
    if(item&&/^[a-z0-9-]{1,80}$/.test(String(item.id||'')))await s.del('receipts/'+item.id+'.json');
    if(item&&/^pi_[A-Za-z0-9_]+$/.test(String(item.paymentIntent||'')))await s.del('payintents/'+item.paymentIntent+'.json');
  }
  if(/^pi_[A-Za-z0-9_]+$/.test(String(account.consentPaymentIntent||'')))await s.del('payintents/'+account.consentPaymentIntent+'.json');
  for(const slug of slugsOf(account))await s.del('sentmail/live-'+account.id+'-'+slug);
  const emailKey=sha(account.email);
  for(const key of await s.list('draftby/'+account.id+'/')){await s.del('drafts/'+key.split('/').pop()+'.json');await s.del(key);}
  for(const key of await s.list('askby/'+emailKey+'/')){await s.del('asks/'+key.split('/').pop()+'.json');await s.del(key);}
  // Mail still waiting to go out to, or about, this family. The queue only
  // ever holds a few minutes of mail, so reading it is cheap.
  const owns=rec=>rec&&typeof rec==='object'&&!Array.isArray(rec)&&(rec.accountId===account.id||rec.ownerId===account.id||rec.email===account.email||rec.parentEmail===account.email||rec.to===account.email);
  for(const key of await s.list('mailqueue/')){if(owns(await readJson(key)))await s.del(key);}
  if(Date.now()-await ownerIndexSince()<DRAFT_MS+864e5){
    for(const prefix of ['drafts/','asks/'])for(const key of await s.list(prefix)){if(owns(await readJson(key)))await s.del(key);}
  }
  const legacy=await readJson('plan-ids.json');
  if(legacy)await writeJson('plan-ids.json',legacy.filter(id=>id!==account.id));
}
// Housekeeping for records that simply expire. On PostgreSQL this is one
// DELETE (see postgres-store.mjs sweep); the loop below is the dev/test file
// store's version of the same rules.
async function sweepExpired() {
  const base=await store();
  const keepFrom=new Date(Date.now()-864e5).toISOString().slice(0,10);
  if(base.sweep)return base.sweep({keepFrom});
  return transaction(async()=>{
    const s=await store();
    // Abuse counters: drop every bucket older than yesterday, plus the
    // pre-bucket key shapes (which carried no date and so were never cleared).
    for(const key of await s.list('counters/')){if(key.slice(9,19)<keepFrom)await s.del(key);}
    for(const legacy of LEGACY_COUNTER_PREFIXES)for(const key of await s.list(legacy))await s.del(key);
    // Admin sessions that simply ran out (nobody came back to trip the check).
    for(const key of await s.list('adminsessions/')){const rec=await readJson(key);if(!rec||Number(rec.exp)<=Date.now())await s.del(key);}
    for(const prefix of ['cancels/','asks/','drafts/','bookingids/'])for(const key of await s.list(prefix)){
      const rec=await readJson(key);if(!rec)continue;
      const expiry=prefix==='asks/'?Date.parse(rec.expires):prefix==='drafts/'?Date.parse(rec.updatedAt)+DRAFT_MS:rec.expiresAt||Date.parse(rec.createdAt)+REQUEST_KEEP_MS;
      if(!Number.isFinite(expiry)||expiry<Date.now()){
        await s.del(key);
        if(prefix==='asks/'&&rec.email)await s.del('askby/'+sha(rec.email)+'/'+key.slice(5,-5));
      }
    }
    // Owner index pointers outlive nothing: each holds the time it was written.
    for(const [prefix,keep] of [['draftby/',DRAFT_MS],['askby/',ASK_MS]])for(const key of await s.list(prefix)){
      if(!(Number(await s.get(key))>Date.now()-keep))await s.del(key);
    }
  },{keys:['sweep']});
}
export const LEGACY_COUNTER_PREFIXES=['iplimit/','authem/','authip/','askem/','askip/','draftnew/','reportip/','adminip/'];

async function requestLocks(req) {
  const s=await store(),keys=[];
  const route=String(req.path||'').split('?')[0].replace(/^\/api\//,'').replace(/^\//,'');
  if(String(req.method).toUpperCase()==='GET'&&/^(site\/|card\/|qr\/|slug$|plans$|test\/outbox$)/.test(route))return {readOnly:true};
  const body=parseBody(req.body)||{};
  const read=async k=>{const v=await s.get(k);try{return JSON.parse(v);}catch{return null;}};
  const accountIds=new Set();
  const email=emailOk(body.email);
  if(email){keys.push('email:'+sha(email));const id=await s.get('email/'+sha(email));if(id)accountIds.add(id.trim());}
  const auth=String(req.headers?.authorization||req.headers?.Authorization||'').match(/^Bearer\s+([a-f0-9]{64})$/i);
  if(auth){const id=await s.get('tokens/'+sha(auth[1]));if(id)accountIds.add(id.trim());}
  const cookieToken=cookieValue(req.headers?.cookie||req.headers?.Cookie,SESSION_COOKIE);
  if(cookieToken){const id=await s.get('tokens/'+sha(cookieToken));if(id)accountIds.add(id.trim());}
  if(/^\/?(api\/)?admin\/(comp|refund)$/.test(String(req.path||'').split('?')[0])&&/^[a-f0-9]{8,32}$/.test(body.id||''))accountIds.add(body.id);
  if(route.startsWith('admin')||String(req.path).startsWith('/admin'))keys.push('quota:admin:'+sha(clientIp(req)));
  const slug=String(body.slug||route.match(/^site\/(.*)$/)?.[1]||'').trim().toLowerCase();
  if(slug&&!checkSlug(slug)){keys.push('slug:'+slug);const page=await read('pages/'+slug+'.json');if(page?.accountId)accountIds.add(page.accountId);}
  if(route==='stripe/webhook'){
    const id=body.data?.object?.metadata?.accountId;
    if(/^[a-f0-9]{16}$/.test(id||''))accountIds.add(id);
    const pi=String(body.data?.object?.payment_intent||'');
    if(/^pi_[A-Za-z0-9_]+$/.test(pi)){keys.push('payintent:'+pi);const ptr=await read('payintents/'+pi+'.json');if(/^[a-f0-9]{8,32}$/.test(String(ptr?.accountId||'')))accountIds.add(ptr.accountId);}
  }
  const capability=route.match(/^(cancel|job|renew|cal)\/([a-f0-9]+)(?:\.ics)?$/);
  if(capability){const [,kind,token]=capability;
    if(kind==='cancel'){const row=await read('cancels/'+token+'.json');if(row?.accountId)accountIds.add(row.accountId);}
    else {const pointer=await s.get((kind==='job'?'jobact/':kind==='cal'?'caltokens/':'renew/')+(kind==='cal'?sha(token):token));if(pointer)accountIds.add(pointer.split(':')[0]);}
  }
  const code=String(body.code||req.query?.get?.('code')||'').trim().toLowerCase();
  if(/^[a-z0-9]{8}$/.test(code))keys.push('draft:'+code);
  if(route.startsWith('ask/'))keys.push('ask:'+route.split('/')[1]);
  if(route==='book'||route==='ask'||route==='draft'||route.startsWith('auth/'))keys.push('quota:'+route.split('/')[0]+':'+sha(clientIp(req)));
  if(req.method==='GET'&&route==='my-jobs'&&code){const id=await s.get('jobcode/'+code);if(id)accountIds.add(id);else{const d=await read('drafts/'+code+'.json');if(d?.accountId)accountIds.add(d.accountId);}}
  if(route==='slug'&&req.method==='POST'){
    for(const id of accountIds){const account=await read('accounts/'+id+'.json');for(const owned of [...slugsOf(account),...(account?.formerSlugs||[])])keys.push('slug:'+owned);}
  }
  if(route==='report')keys.push('quota:report:'+sha(clientIp(req)));
  keys.push(...[...accountIds].map(id=>'account:'+id));
  const readOnly=String(req.method).toUpperCase()==='GET'&&(/^(site\/|card\/|qr\/|slug$|plans$|test\/outbox$)/.test(route));
  // Each of these used to take the site-wide exclusive lock (pausing every
  // other write while it ran). Deletion now locks only its own account and
  // pages, the dashboard only reads, and the cron runs per account.
  return {keys,maintenance:false,readOnly};
}

export async function handleRequest(req) {
  try {
    if(process.env.HB_MAINTENANCE_MODE==='1')return json(503,{ok:false,error:'maintenance'},{'retry-after':'60'});
    const requestOrigin=req.headers?.origin||req.headers?.Origin;
    const hasCookie=!!cookieValue(req.headers?.cookie||req.headers?.Cookie,SESSION_COOKIE)||!!cookieValue(req.headers?.cookie||req.headers?.Cookie,ADMIN_COOKIE);
    // A same-site form on a no-referrer page sends Origin: null. The Lax
    // admin and parent cookies are not attached to a cross-site POST, and
    // Sec-Fetch-Site says whether this navigation stayed on our site.
    const fetchSite = String(req.headers?.["sec-fetch-site"] || req.headers?.["Sec-Fetch-Site"] || "");
    const strippedOrigin = requestOrigin === "null" && (fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none");
    if(hasCookie&&!['GET','HEAD','OPTIONS'].includes(String(req.method).toUpperCase())&&requestOrigin&&requestOrigin!==await publicOrigin(req.origin)&&!strippedOrigin)return json(403,{ok:false,error:'origin'});
    if(Buffer.byteLength(String(req.body||''),'utf8')>2_200_000)return json(413,{ok:false,error:'big'});
    const cronRoute=String(req.path||'').split('?')[0].replace(/^\/api\//,'');
    if(String(req.method).toUpperCase()==='GET'&&(cronRoute==='cron/renewals'||cronRoute==='cron/mail'))return await cronRequest(req,cronRoute);
    let batch;
    for(let attempt=0;attempt<3;attempt++){
      const options=await requestLocks(req);
      try{
        batch=await withMailBatch(()=>transaction(async()=>{
          if(!options.readOnly){
            // Ownership can change while waiting. Acquire its current lock set before mutation.
            const current=await requestLocks(req);
            if(current.keys.some(key=>!options.keys.includes(key))){const error=new Error('Ownership changed');error.code='HB_LOCK_RETRY';throw error;}
          }
          return routeRequest(req);
        },options));break;
      }catch(error){if(error.code!=='HB_LOCK_RETRY')throw error;}
    }
    if(!batch)return json(503,{ok:false,error:'busy'},{'retry-after':'5'});
    const {result,ids}=batch;
    if(result.viewEvent){
      const {slug,meta,view}=result.viewEvent;delete result.viewEvent;
      try{const backing=await store();if(backing.incrementView)await noteView(slug,meta,view);else await transaction(()=>noteView(slug,meta,view),{keys:['view:'+slug]});}catch{/* A failed counter must not break a public page. */}
    }
    // Mail is sent only after successful commit. Retryable failures remain durable.
    if(ids.length)await flushMail(ids);
    if(req.headers?.origin==='null'&&String(req.path).split('?')[0]==='/api/book'){
      result.headers={...result.headers,'access-control-allow-origin':'null','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','vary':'Origin'};
    }
    return result;
  }catch(error){
    if(error instanceof URIError)return json(400,{ok:false,error:'path'});
    // Name and code only: never the message (it can quote a query or a host
    // name) and never the full path (several paths are private links).
    try{console.error('[hb] request failed',String(req.method||'').toUpperCase(),String(req.path||'').split('?')[0].replace(/[a-f0-9]{16,}/gi,':token'),error&&error.name||'Error',error&&error.code||'');}catch{}
    return json(503,{ok:false,error:'unavailable',message:'Temporarily busy. Your saved page is safe. Please try again.',},{'retry-after':'5'});
  }
}
