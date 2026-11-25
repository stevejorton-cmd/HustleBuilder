import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import handler from '../api/handler.js';
import {setStore} from '../host/lib/store.mjs';

const demoRoutes = [
  ['/api/handler?hbpath=plans', /application\/json/],
  ['/api/handler?hbsite=taylor-demo', /text\/html/],
  ['/api/handler?hbsite=privacy', /text\/html/],
  ['/api/handler?hbsite=security', /text\/html/],
  ['/api/handler?hbsite=retention', /text\/html/],
  ['/api/handler?hbsite=terms', /text\/html/],
  ['/api/handler?hbsite=favicon.ico', /image\/x-icon/],
  ['/api/handler?hbsite=favicon.svg', /image\/svg/],
  ['/api/handler?hbsite=apple-touch-icon.png', /image\/png/],
  ['/api/handler?hbsite=robots.txt', /text\/plain/],
  ['/api/handler?hbpath=qr%2Ftaylor-demo.png', /image\/png/]
];

test('Vercel guest entry points do not touch storage; signed-in and live family paths still do', async (t) => {
  const token = 'a'.repeat(64), id = 'owner1';
  const hash = createHash('sha256').update(token).digest('hex');
  const account = {id, email:'owner@example.com', tokenHash:hash, sessionVersion:2,
    emailVerifiedAt:'2025-01-01T00:00:00.000Z', calToken:'b'.repeat(64),
    slug:'family-demo', slugs:['family-demo'], trialEndsAt:'2090-01-01T00:00:00.000Z'};
  const rows = new Map([
    ['tokens/' + hash,id], ['accounts/' + id + '.json',JSON.stringify(account)],
    ['pages/family-demo.json',JSON.stringify({accountId:id,status:'live'})],
    ['pages/family-demo.html','<!doctype html><html><body><h1>Family business</h1></body></html>']
  ]);
  const calls = [];
  const adapter = {
    async get(key){calls.push(['get',key]);return rows.get(key) ?? null;},
    async put(key,value){calls.push(['put',key]);rows.set(key,value);},
    async incrementView(slug){calls.push(['view',slug]);}
  };
  setStore({...adapter, async transaction(fn,options){calls.push(['transaction',options]);return fn(adapter);}});
  const server = createServer(handler);
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => {setStore(null); server.close();});
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const [path,type] of demoRoutes) {
    const response = await fetch(base + path);
    assert.equal(response.status,200,path);
    assert.match(response.headers.get('content-type'),type,path);
    if (path.includes('hbsite=taylor-demo')) {
      assert.match(response.headers.get('content-security-policy'),/sandbox.*connect-src 'none'/);
      assert.match(await response.text(),/Taylor/);
    }
  }
  for (const path of ['me','account']) {
    const response = await fetch(base + '/api/handler?hbpath=' + path, {
      headers:{cookie:'tracking=1; hb_session=malformed',authorization:'Bearer malformed'}
    });
    assert.equal(response.status,401);
    assert.deepEqual(await response.json(),{ok:false,error:'auth'});
  }
  const options = await fetch(base + '/api/handler?hbpath=book',{method:'OPTIONS',headers:{origin:'null'}});
  assert.equal(options.status,204);
  assert.equal(options.headers.get('access-control-allow-origin'),'null');
  assert.equal(options.headers.get('access-control-allow-methods'),'POST, OPTIONS');
  assert.deepEqual(calls,[], 'guest routes must issue no read, lock, or transaction');

  for (const headers of [{cookie:'hb_session=' + token},{authorization:'Bearer ' + token}]) {
    const signedIn = await fetch(base + '/api/handler?hbpath=me',{headers});
    assert.equal(signedIn.status,200);
    assert.equal((await signedIn.json()).email,account.email);
    assert.ok(calls.some(([kind,key])=>kind==='get'&&key==='tokens/'+hash));
    assert.ok(calls.some(([kind])=>kind==='transaction'));
    calls.length=0;
  }

  const family = await fetch(base + '/api/handler?hbsite=family-demo',{headers:{
    'user-agent':'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0'
  }});
  assert.match(await family.text(),/Family business/);
  assert.ok(calls.some(([kind,key])=>kind==='get'&&key==='accounts/'+id+'.json'));
  assert.ok(calls.some(([kind])=>kind==='transaction'));
  assert.ok(!calls.some(([kind,key])=>kind==='get'&&key.startsWith('trials/')));
});
