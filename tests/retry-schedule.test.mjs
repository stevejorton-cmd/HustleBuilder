import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileStore, setStore } from '../host/lib/store.mjs';
import { handleRequest } from '../host/lib/router.mjs';
import { mailRetriesOpen } from '../host/lib/mail-schedule.mjs';

const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
let dir, base, now, originalNow, originalFetch, env;
const call = (method, path, body = {}, auth = '') => handleRequest({
  method, path, body: JSON.stringify(body), origin: 'http://sites.test',
  headers: { origin: 'http://sites.test', authorization: auth },
  query: new URL('http://sites.test' + path).searchParams
});
test.beforeEach(async () => {
  dir = await mkdtemp(tmpdir() + '/hb-retry-'); base = fileStore(dir); setStore(base);
  env = { ...process.env }; originalNow = Date.now; originalFetch = globalThis.fetch;
  now = Date.parse("2026-11-25T16:00:00Z"); Date.now = () => now;
  Object.assign(process.env, { PUBLISH_TEST_MODE: '0', PUBLIC_ORIGIN: 'http://sites.test', RESEND_API_KEY: 'test-placeholder', BOOKING_FROM: 'test@example.com', CRON_SECRET: 'test-cron' });
});
test.afterEach(async () => {
  Date.now = originalNow; globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env); await rm(dir, { recursive: true, force: true });
});
test('mail cron runs once an hour and daily renewals stay at 14:00 UTC', () => {
  assert.equal(config.crons.find(c => c.path === '/api/cron/mail').schedule, '0 * * * *');
  assert.equal(config.crons.find(c => c.path === '/api/cron/renewals').schedule, '0 14 * * *');
});
test('new sign-in mail sends in the originating request, without waiting for cron', async () => {
  let sends = 0; globalThis.fetch = async () => { sends++; return { ok: true }; };
  const response = await call('POST', '/api/auth/start', { email: 'parent@example.com' });
  assert.equal(response.status, 200); assert.equal(sends, 1);
  assert.deepEqual(await base.list('mailqueue/'), []);
});
test('failed sign-in survives durably and retries when cron runs before expiry', async () => {
  let sends = 0; globalThis.fetch = async () => { sends++; return { ok: false, status: 503 }; };
  assert.equal((await call('POST', '/api/auth/start', { email: 'parent@example.com' })).status, 200);
  const [key] = await base.list('mailqueue/'); assert.ok(key);
  const queued = JSON.parse(await base.get(key)); assert.equal(queued.attempts, 1);
  assert.equal(queued.expiresAt - now, 20 * 60_000);
  now += 60_000;
  assert.ok(now < queued.expiresAt);
  globalThis.fetch = async () => { sends++; return { ok: true }; };
  assert.equal((await call('GET', '/api/cron/mail', {}, 'Bearer test-cron')).status, 200);
  assert.equal(sends, 2); assert.deepEqual(await base.list('mailqueue/'), []);
});
test('a prolonged outage never delivers an expired sign-in code', async () => {
  let sends = 0; globalThis.fetch = async () => { sends++; return { ok: false, status: 503 }; };
  await call('POST', '/api/auth/start', { email: 'parent@example.com' });
  now += 21 * 60_000;
  await call('GET', '/api/cron/mail', {}, 'Bearer test-cron');
  assert.equal(sends, 1); assert.deepEqual(await base.list('mailqueue/'), []);
});


test('the daily renewal cron logs counts only', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    assert.equal((await call('GET', '/api/cron/renewals', {}, 'Bearer test-cron')).status, 200);
  } finally { console.log = orig; }
  const line = lines.find((item) => item.includes('"cron":"renewals"'));
  assert.ok(line);
  const rec = JSON.parse(line);
  assert.deepEqual(Object.keys(rec).sort(), ['cron', 'done', 'dry', 'notices', 'processed']);
  assert.equal(rec.cron, 'renewals');
  assert.equal(typeof rec.processed, 'number');
  assert.equal(typeof rec.notices, 'number');
  assert.equal(JSON.stringify(rec).includes('@'), false);
});

test('Chicago quiet hours stay 10 p.m.–9 a.m. across both daylight-saving offsets', () => {
  for (const z of [
    ['2026-01-25T14:59:59Z', '2026-01-25T15:00:00Z', '2026-01-26T03:59:59Z', '2026-01-26T04:00:00Z'],
    ['2026-07-25T13:59:59Z', '2026-07-25T14:00:00Z', '2026-07-26T02:59:59Z', '2026-07-26T03:00:00Z'],
  ]) assert.deepEqual(z.map(t => mailRetriesOpen(Date.parse(t))), [false, true, true, false]);
});

test('the night retry endpoint authenticates and exits before touching any database', async () => {
  now = Date.parse('2026-11-26T04:00:00Z');
  delete process.env.PUBLIC_ORIGIN;
  let touches = 0;
  const trap = async () => { touches++; throw Error('night cron touched storage'); };
  setStore({ get: trap, put: trap, list: trap, dueMail: trap });
  assert.equal((await call('GET', '/api/cron/mail')).status, 401);
  const r = await call('GET', '/api/cron/mail', {}, 'Bearer test-cron');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).skipped, 'outside_retry_hours');
  assert.equal(touches, 0);
});

test('parent signup code and welcome send immediately at night; repeat signin still verifies in-app', async () => {
  now = Date.parse('2026-11-26T04:20:00Z');
  const messages = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    messages.push(JSON.parse(options.body));
    return { ok: true };
  };
  const email = 'parent@example.com';
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await call('POST', '/api/auth/start', { email })).status, 200);
    const code = messages.at(-1).text.match(/Your code is (\d{6})/)[1];
    const verified = await call('POST', '/api/auth/verify', { email, code });
    assert.equal(verified.status, 200);
    assert.equal(JSON.parse(verified.body).ok, true);
    assert.match(verified.headers['set-cookie'], /HttpOnly/);
  }
  assert.equal(messages.filter(m => /Hustle Builder code/.test(m.subject)).length, 2);
  assert.equal(messages.filter(m => /Welcome to Hustle Builder/.test(m.subject)).length, 1);
  assert.deepEqual(messages.flatMap(m => m.to), [email, email, email]);
  assert.deepEqual(await base.list('mailqueue/'), []);
});

test('overnight retries wait for morning; the daily renewal job does not flush them early', async () => {
  now = Date.parse('2026-11-26T13:50:00Z'); // 7:50 a.m. CST
  const messageId = 'a'.repeat(40);
  const key = 'mailqueue/' + messageId + '.json';
  await base.put(key, JSON.stringify({ id: messageId, to: 'parent@example.com',
    subject: 'Booking request', text: 'Example only', createdAt: now - 60_000, attempts: 1 }));
  let sends = 0; globalThis.fetch = async () => { sends++; return { ok: true }; };
  assert.equal((await call('GET', '/api/cron/mail', {}, 'Bearer test-cron')).status, 200);
  now += 10 * 60_000; // daily renewal job, 8 a.m. CST
  assert.equal((await call('GET', '/api/cron/renewals', {}, 'Bearer test-cron')).status, 200);
  assert.equal(sends, 0);
  assert.ok(await base.get(key));
  now += 60 * 60_000; // 9 a.m. CST
  assert.equal((await call('GET', '/api/cron/mail', {}, 'Bearer test-cron')).status, 200);
  assert.equal(sends, 1);
  assert.equal(await base.get(key), null);
});

test('overnight booking, parent email action, and customer yes/no notice never wait on cron', async () => {
  now = Date.parse('2026-11-26T04:20:00Z');
  process.env.PAYWALL_MODE = 'test';
  const messages = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    messages.push(JSON.parse(options.body));
    return { ok: true };
  };
  const email = 'parent@example.com', slug = 'night-booking';
  await call('POST', '/api/auth/start', { email });
  const code = messages.at(-1).text.match(/Your code is (\d{6})/)[1];
  const auth = JSON.parse((await call('POST', '/api/auth/verify', { email, code })).body);
  assert.ok(auth.token);
  const bearer = 'Bearer ' + auth.token;
  // Provision only the fixture with simulated payment and consent.
  process.env.PUBLISH_TEST_MODE = '1';
  assert.equal((await call('POST', '/api/consent', { consent: true }, bearer)).status, 200);
  assert.equal((await call('POST', '/api/checkout', { plan: 'season' }, bearer)).status, 200);
  const html = '<!doctype html><html><head><title>Alex Yard</title></head><body><!-- hb-public --><h1>Alex Yard</h1></body></html>';
  const published = await call('POST', '/api/publish', { slug, html }, bearer);
  assert.equal(published.status, 200, published.body);
  assert.equal((await call('GET', '/api/site/' + slug)).status, 200);
  process.env.PUBLISH_TEST_MODE = '0';
  for (const [i, status] of ['confirmed', 'cancelled'].entries()) {
    const customer = 'neighbor' + i + '@example.com';
    const from = messages.length;
    const booked = await call('POST', '/api/book', {
      slug, name: 'Riley', contact: customer, service: 'Yard cleanup', address: '12 Oak',
      when: '4 PM', start: '2026-12-0' + (2 + i) + 'T16:00', t: 4000
    });
    assert.equal(booked.status, 200, booked.body);
    const parentNotice = messages.slice(from).find(m => m.to.includes(email) && /Booking request/.test(m.subject));
    assert.ok(parentNotice, 'parent got a first notification before the request returned');
    assert.ok(messages.slice(from).some(m => m.to.includes(customer)), 'customer got a first receipt');
    const action = parentNotice.text.match(/\/api\/job\/[a-f0-9]+/)[0];
    const page = await call('GET', action);
    assert.equal(page.status, 200);
    assert.match(page.body, /Confirm booking/);
    assert.match(page.body, /Cancel request/);
    const beforeDecision = messages.length;
    const decision = await call('POST', action, { status, json: true });
    assert.equal(decision.status, 200, decision.body);
    assert.equal(JSON.parse(decision.body).status, status);
    assert.ok(messages.slice(beforeDecision).some(m => m.to.includes(customer) && m.subject.includes(status)),
      'customer got the family’s decision before the request returned');
  }
  assert.deepEqual(await base.list('mailqueue/'), []);
});
