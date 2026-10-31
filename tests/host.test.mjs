import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { fileStore, setStore } from "../host/lib/store.mjs";
import { handleRequest, stripeSignatureOk } from "../host/lib/router.mjs";
import { checkSlug } from "../host/lib/moderate.mjs";

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
  assert.match(checkSlug("sam-smith"), /last name/i);
  assert.match(checkSlug("admin"), /reserved/i);
  assert.match(checkSlug("ab"), /3 to 24/);
  assert.match(checkSlug("Sam Yard"), /letters/i);
});

test("consent gate blocks publish until the parent verifies, agrees, and has a plan", async () => {
  const early = await json(await call("POST", "/api/publish", { body: { slug: "sam", html: page("Sam") } }));
  assert.equal(early.status, 401);

  const { token } = await parent();
  const noConsent = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.body.error, "consent");

  const consent = await json(await call("POST", "/api/consent", { token, body: { consent: true } }));
  assert.equal(consent.body.ok, true);
  const noPay = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } }));
  assert.equal(noPay.status, 402);

  const pay = await json(await call("POST", "/api/checkout", { token, body: { plan: "season" } }));
  assert.equal(pay.body.mode, "test");
  assert.equal(pay.body.plan, "season");
});

test("publish and republish keep the same url", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "month" } });
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
  const dump = await json(await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") + "hustle-boss-v1" } }));
  assert.equal(dump.body.error, "page");
  const last = await json(await call("POST", "/api/publish", { token, body: { slug: "sam-smith", html: page("Sam") } }));
  assert.equal(last.body.error, "slug");
});

test("booking emails the parent and is not stored on the page", async () => {
  const { token, email } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "season" } });
  await call("POST", "/api/publish", { token, body: { slug: "sam", html: page("Sam") } });
  const book = await json(await call("POST", "/api/book", { body: {
    slug: "sam", name: "Riley", contact: "402-555-0199", service: "Mow", when: "Monday at 4:00 PM", address: "999 Secret Lane", note: "Gate"
  } }));
  assert.equal(book.body.ok, true);
  const live = await call("GET", "/api/site/sam");
  assert.equal(live.body.includes("999 Secret Lane"), false);
  const box = await json(await call("GET", "/api/test/outbox?email=" + encodeURIComponent(email)));
  assert.match(box.body.messages.at(-1).text, /999 Secret Lane/);
  assert.match(box.body.messages.at(-1).text, /not saved as a customer list/);
});

test("admin takedown hides the page and the parent cannot put it back", async () => {
  const { token } = await parent();
  await call("POST", "/api/consent", { token, body: { consent: true } });
  await call("POST", "/api/checkout", { token, body: { plan: "month" } });
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
