import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileStore,setStore,store} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';
import {checkSlug} from '../host/lib/moderate.mjs';
import '../config/season.js';

let dir;
test.beforeEach(async()=>{dir=await mkdtemp(path.join(tmpdir(),'hb-taylor-demo-'));setStore(fileStore(dir));process.env.PUBLISH_TEST_MODE='1';process.env.PAYWALL_MODE='test';process.env.PUBLIC_ORIGIN='https://hustlebuilder.org';});
test.afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
function call(method,url,{body,token}={}){return handleRequest({method,path:url,origin:'https://hustlebuilder.org',query:new URL('https://hustlebuilder.org'+url).searchParams,headers:{origin:'https://hustlebuilder.org',authorization:token?'Bearer '+token:''},body:body?JSON.stringify(body):''});}
function cfg(html){return JSON.parse(html.match(/window\.__C=(\{[^\n]+\});<\/script>/)[1]);}

test('fictional Taylor website opens from a fresh store and matches the front-page seasonal example',async()=>{
 const before=await(await store()).list('');
 const response=await call('GET','/api/site/taylor-demo');
 assert.equal(response.status,200);assert.match(response.headers['content-type'],/text\/html/);
 assert.match(response.headers['content-security-policy'],/connect-src 'none'/);assert.equal(response.headers['referrer-policy'],'no-referrer');
 const active=globalThis.HB_SEASON_FILE.activeSeason();
 const view=globalThis.HB_SEASON_FILE.seasonView(active==='winter'?'snow':'fall'),data=cfg(response.body);
 assert.equal(data.first,'Taylor');assert.equal(data.biz,view.biz);assert.deepEqual(data.services,view.rates.map(r=>({n:r.n,p:'$'+r.p})));
 assert.match(response.body,/Example business/);assert.match(response.body,/No real bookings/);assert.match(response.body,/href="\/\?build=1">Build your own/);
 assert.match(response.body,/name="robots" content="noindex, nofollow"/);
 assert.match(response.body,/id="demoRequest"/);assert.match(response.body,/id="demoRequestResult"/);
 assert.equal(data.publish,null);assert.equal(data.inbox,null);assert.equal(data.venmo,'');assert.equal(data.phoneDigits,'');assert.equal(data.email,'');assert.equal(data.publicUrl,'');
 assert.doesNotMatch(response.body,/parent@example\.com|4025550100|Molly|hb-pilot|\/api\/book\b|mailto:|tel:/);
 assert.deepEqual(await(await store()).list(''),before,'demo visit creates no accounts, requests, emails or analytics');
});
test('both supported seasonal templates keep matching rates and safe local-only configuration',async()=>{
 for(const id of ['fall','snow']){
  const html=await readFile(new URL('../host/demo/taylor-'+id+'.html',import.meta.url),'utf8'),data=cfg(html),view=globalThis.HB_SEASON_FILE.seasonView(id);
  assert.equal(data.biz,view.biz);assert.deepEqual(data.services,view.rates.map(r=>({n:r.n,p:'$'+r.p})));
  assert.equal(data.publish,null);assert.equal(data.inbox,null);assert.equal(data.venmo,'');assert.match(html,/font\/woff2;base64,/,'actual site fonts are embedded for the sandbox');
  assert.match(html,/Serving your neighborhood\./);assert.doesNotMatch(html,/Serving Your neighborhood/);
  if(id==='fall')assert.match(html,/Leaves raked\. Dead plants cleared\./);
 }
});
test('sample request requires a day and only displays a simulated result',async()=>{
 const response=await call('GET','/api/site/taylor-demo');
 const script=response.body.match(/<script>\(function\(\)\{var name=document\.getElementById\('nm'\)[\s\S]+?<\/script>/)[0].replace(/^<script>|<\/script>$/g,'');
 const nodes={nm:{value:''},addr:{value:''},demoRequest:{},demoRequestResult:{hidden:true,textContent:''},picked:{textContent:''},svc:{value:'Leaf raking'}};
 const context=vm.createContext({document:{getElementById:id=>nodes[id]}});vm.runInContext(script,context);
 assert.equal(nodes.nm.value,'Example Neighbor');assert.equal(nodes.addr.value,'100 Example Lane');
 nodes.demoRequest.onclick();assert.match(nodes.demoRequestResult.textContent,/Pick a day/);assert.equal(nodes.demoRequestResult.hidden,false);
 nodes.picked.textContent='Tap a day to pick it.';nodes.demoRequest.onclick();assert.match(nodes.demoRequestResult.textContent,/Pick a day/);
 nodes.picked.textContent='Selected: Friday, December 4.';nodes.demoRequest.onclick();assert.match(nodes.demoRequestResult.textContent,/Example request: Leaf raking/);assert.match(nodes.demoRequestResult.textContent,/has not sent or saved anything/);
 assert.equal('fetch' in context,false);assert.equal('localStorage' in context,false);
 assert.deepEqual(await(await store()).list(''),[]);
});
test('fixed demo address is reserved and cannot become a real family booking destination',async()=>{
 assert.match(checkSlug('taylor-demo'),/reserved/i);
 const start=JSON.parse((await call('POST','/api/auth/start',{body:{email:'demo-test-parent@example.com'}})).body);
 const verified=JSON.parse((await call('POST','/api/auth/verify',{body:{email:'demo-test-parent@example.com',code:start.devCode}})).body);
 await call('POST','/api/consent',{body:{consent:true},token:verified.token});
 const publish=await call('POST','/api/publish',{token:verified.token,body:{slug:'taylor-demo',html:'<!doctype html><html><body><!-- hb-public --><h1>Real page</h1></body></html>'}});
 assert.equal(publish.status,400);assert.equal(JSON.parse(publish.body).error,'slug');
 const request=await call('POST','/api/book',{body:{slug:'taylor-demo',name:'Example',contact:'example@example.com',service:'Yard cleanup',address:'100 Example Lane',start:'2027-01-01T16:00',when:'Example',t:5000}});
 assert.equal(request.status,400);assert.deepEqual(await(await store()).list('requests/'),[]);
});
