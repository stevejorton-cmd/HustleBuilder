import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileStore, setStore } from '../host/lib/store.mjs';
import { handleRequest } from '../host/lib/router.mjs';

const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const retryMinutes = Number(config.crons.find(c => c.path === '/api/cron/mail').schedule.match(/^\*\/(\d+) \* \* \* \*$/)[1]);
let dir, base, now, originalNow, originalFetch, env;
const call = (method, path, body = {}, auth = '') => handleRequest({
  method, path, body: JSON.stringify(body), origin: 'http://sites.test',
  headers: { origin: 'http://sites.test', authorization: auth },
  query: new URL('http://sites.test' + path).searchParams
});
test.beforeEach(async () => {
  dir = await mkdtemp(tmpdir() + '/hb-retry-'); base = fileStore(dir); setStore(base);
  env = { ...process.env }; originalNow = Date.now; originalFetch = globalThis.fetch;
  now = originalNow(); Date.now = () => now;
  Object.assign(process.env, { PUBLISH_TEST_MODE: '0', PUBLIC_ORIGIN: 'http://sites.test', RESEND_API_KEY: 'test-placeholder', BOOKING_FROM: 'test@example.com', CRON_SECRET: 'test-cron' });
});
test.afterEach(async () => {
  Date.now = originalNow; globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env); await rm(dir, { recursive: true, force: true });
});
test('retry polls are halved without changing the daily renewal schedule', () => {
  assert.equal(retryMinutes, 10);
  assert.equal(24 * 60 / retryMinutes, 144);
  assert.equal(config.crons.find(c => c.path === '/api/cron/renewals').schedule, '0 14 * * *');
});
test('new sign-in mail sends in the originating request, without waiting for cron', async () => {
  let sends = 0; globalThis.fetch = async () => { sends++; return { ok: true }; };
  const response = await call('POST', '/api/auth/start', { email: 'parent@example.com' });
  assert.equal(response.status, 200); assert.equal(sends, 1);
  assert.deepEqual(await base.list('mailqueue/'), []);
});
test('failed sign-in survives durably and retries on the next poll before expiry', async () => {
  let sends = 0; globalThis.fetch = async () => { sends++; return { ok: false, status: 503 }; };
  assert.equal((await call('POST', '/api/auth/start', { email: 'parent@example.com' })).status, 200);
  const [key] = await base.list('mailqueue/'); assert.ok(key);
  const queued = JSON.parse(await base.get(key)); assert.equal(queued.attempts, 1);
  assert.equal(queued.expiresAt - now, 20 * 60_000);
  // Worst phase: failed immediate attempt just after the scheduled poll.
  now += retryMinutes * 60_000;
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
