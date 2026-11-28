import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setStore, store, transaction } from '../host/lib/store.mjs';
import {
  getGear, updateGearPreferences, recordGearCompletion, syncGearBusiness,
  renameGearBusiness, deleteGearAccount, OPERATOR_JOBS
} from '../host/lib/gear.mjs';

let db, account;
const ORIGIN = 'https://gear.test';
const asJson = async key => JSON.parse(await db.get(key));
const putJson = (key, value) => db.put(key, JSON.stringify(value));
const page = (slug, name, kid, owner = account.id) => ({slug,accountId:owner,status:'live',names:{first:kid,biz:name},card:{title:name,line:'Friendly neighborhood help',accent:'#245B45',theme:'neighbor'}});
const get = options => getGear(account,{origin:ORIGIN,...options});
const prefer = (businessId, milestoneEmails) => updateGearPreferences(account,{businessId,milestoneEmails,origin:ORIGIN});
const done = (id, extra = {}, options = {}) => recordGearCompletion(account,{id,slug:'alex-lawn',status:'done',...extra},{parentAuthorized:true,previousStatus:'confirmed',origin:ORIGIN,...options});
async function business(slug = 'alex-lawn') { return (await get({slug})).businesses.find(item => item.slug === slug); }
async function mails() { return Promise.all((await db.list('mailqueue/')).map(asJson)); }
async function draft(code, value, owner = account.id) {
  await putJson('drafts/' + code + '.json',{accountId:owner,draft:value,updatedAt:new Date().toISOString()});
  await db.put('draftby/' + owner + '/' + code,String(Date.now()));
}

test.beforeEach(async ctx => {
  ctx.mock.timers.enable({apis:['Date'],now:new Date('2026-11-23T02:00:00Z')});
  const values = new Map();
  db = {
    failOnceFor:'',
    async get(key) { return values.get(key) ?? null; },
    async put(key,value) { if (key === this.failOnceFor) { this.failOnceFor = ''; throw new Error('test write failure'); } values.set(key,value); },
    async del(key) { values.delete(key); },
    async list(prefix = '') { return [...values.keys()].filter(key => key.startsWith(prefix)); }
  };
  setStore(db);
  process.env.PUBLISH_TEST_MODE = '1';
  process.env.PUBLIC_ORIGIN = ORIGIN;
  account = {id:'account-gear-a',email:'verified-parent@example.test',emailVerifiedAt:new Date().toISOString(),slug:'alex-lawn',slugs:['alex-lawn','sam-pets'],trialEndsAt:'2020-01-01T00:00:00Z',status:'expired'};
  await putJson('accounts/' + account.id + '.json',account);
  await putJson('pages/alex-lawn.json',page('alex-lawn','Alex & Co.','Alex'));
  await putJson('pages/sam-pets.json',page('sam-pets',"Sam's Pet Care",'Sam'));
});
test.afterEach(() => setStore(null));

test('gear is parent-only and is available before any jobs, offline and after a plan expires', async () => {
  assert.equal((await getGear(null)).status,401);
  assert.equal((await getGear({...account,emailVerifiedAt:null})).status,401);
  assert.equal((await getGear({...account,id:'../../another'})).status,401);
  const meta = await asJson('pages/alex-lawn.json'); meta.status = 'offline'; await putJson('pages/alex-lawn.json',meta);
  const roster = await get();
  assert.equal(roster.ok,false); assert.equal(roster.status,404); assert.equal(roster.error,'owner');
  assert.equal(JSON.stringify(roster).includes('Alex'),false); assert.equal(JSON.stringify(roster).includes('Sam'),false);
  const result = await get({slug:'alex-lawn'});
  assert.equal(result.ok,true); assert.equal(result.businesses.length,1); assert.equal(result.businesses[0].slug,'alex-lawn');
  assert.equal(result.downloadsFree,true); assert.equal(result.physicalPurchaseOptional,true);
  const alex = result.businesses[0];
  assert.equal(alex.completedJobs,0); assert.equal(alex.milestoneEmails,false);
  assert.deepEqual(alex.operator,{threshold:3,earned:false,earnedAt:''});
  assert.match(alex.id,/^gb_[a-f0-9]{24}$/);
  assert.equal(alex.gearUrl,ORIGIN + '/?gear=1&business=' + alex.id);
  assert.equal(alex.previewUrl,ORIGIN + '/api/card/alex-lawn.png');
  assert.equal((await asJson('pages/alex-lawn.json')).gearBusinessId,alex.id);
  assert.deepEqual(await mails(),[]);
});

test('business selectors and preferences cannot access another family or overwrite progress', async () => {
  const alex = await business(), sam = await business('sam-pets');
  assert.equal((await get({businessId:'gb_' + 'f'.repeat(24)})).status,404);
  assert.equal((await get({businessId:alex.id,slug:'sam-pets'})).status,404);
  for (const milestoneEmails of ['true',1,null,{},undefined]) assert.equal((await updateGearPreferences(account,{businessId:alex.id,milestoneEmails})).status,400);
  assert.equal((await updateGearPreferences(account,{milestoneEmails:true})).status,400);
  const changed = await updateGearPreferences(account,{businessId:alex.id,milestoneEmails:true,completedJobs:500,operator:{earned:true}});
  assert.equal(changed.businesses.length,1); assert.equal(changed.businesses[0].id,alex.id);
  assert.equal(changed.businesses[0].completedJobs,0); assert.equal(changed.businesses[0].operator.earned,false);
  assert.equal(changed.businesses[0].milestoneEmails,true); assert.equal((await get({slug:'sam-pets'})).businesses[0].milestoneEmails,false);
  assert.equal(JSON.stringify(changed).includes('Sam'),false);
  const stolen = await asJson('pages/sam-pets.json'); stolen.accountId = 'another-parent'; await putJson('pages/sam-pets.json',stolen);
  assert.equal((await get()).businesses.length,1);
  assert.equal((await get({businessId:sam.id})).status,404);
  assert.equal((await prefer(sam.id,true)).status,404);
});

test('saved gear is visible only to the kid who owns that business', async () => {
  await putJson('pages/alex-snow.json', page('alex-snow','Alex Snow Co.','Alex'));
  account.slugs = [...account.slugs, 'alex-snow'];
  const roster = await get();
  assert.equal(roster.status,404); assert.equal(roster.error,'owner');
  for (const secret of ['Alex','Sam','Snow','Pet']) assert.equal(JSON.stringify(roster).includes(secret),false,secret);
  const alex = await get({slug:'alex-lawn'});
  assert.deepEqual(alex.businesses.map(item => item.slug).sort(), ['alex-lawn','alex-snow']);
  assert.equal(alex.businesses.every(item => item.kid === 'Alex'),true);
  assert.equal(alex.selectedBusinessId, alex.businesses.find(item => item.slug === 'alex-lawn').id);
  assert.equal(JSON.stringify(alex).includes('Sam'),false);
  const samId = (await business('sam-pets')).id;
  const sam = await get({businessId:samId});
  assert.deepEqual(sam.businesses.map(item => item.slug), ['sam-pets']);
  assert.equal(JSON.stringify(sam).includes('Alex'),false);
  assert.equal(JSON.stringify(sam).includes(alex.businesses[0].id),false);
  const crossed = await get({slug:'sam-pets',businessId:alex.selectedBusinessId,kid:'Sam'});
  assert.equal(crossed.status,404); assert.equal(JSON.stringify(crossed).includes('Alex'),false); assert.equal(JSON.stringify(crossed).includes('Sam'),false);
  const byName = await get({kid:'Alex'});
  assert.deepEqual(byName.businesses.map(item => item.slug).sort(), ['alex-lawn','alex-snow']);
  assert.equal(byName.selectedBusinessId,'');
  assert.equal((await get({kid:'Alex',businessId:samId})).status,404);
  assert.equal((await get({kid:'alex'})).businesses.length,2);
  assert.equal((await get({businessId:samId,slug:'alex-lawn'})).status,404);
  const preferAlex = await prefer(alex.selectedBusinessId,true);
  assert.equal(preferAlex.businesses.every(item => item.kid === 'Alex'),true);
  assert.equal((await business('sam-pets')).milestoneEmails,false);
});

test('only a trusted parent transition of a booking into Done counts', async () => {
  for (const options of [{parentAuthorized:false},{parentAuthorized:undefined},{previousStatus:'done'},{previousStatus:'cancelled'},{previousStatus:'inquiry'}]) assert.equal((await done('bad-' + JSON.stringify(options),{},options)).counted,false);
  for (const extra of [{status:'confirmed'},{kind:'inquiry'},{kind:'quote'},{id:''},{accountId:'other'},{slug:'foreign-page'},{gearBusinessId:'gb_' + 'e'.repeat(24)}]) assert.equal((await done('bad',extra)).counted,false);
  assert.equal((await recordGearCompletion({...account,emailVerifiedAt:''},{id:'one',slug:'alex-lawn',status:'done'},{previousStatus:'confirmed',parentAuthorized:true})).status,401);
  assert.equal((await business()).completedJobs,0);
  assert.equal((await done('first',{}, {previousStatus:'new'})).counted,true);
  assert.equal((await done('second',{kind:'booking'})).counted,true);
  assert.equal((await business()).completedJobs,2);
});

test('three distinct parent completions earn Operator once with default emails off', async () => {
  await done('one'); await done('two');
  const third = await done('three');
  assert.equal(OPERATOR_JOBS,3); assert.equal(third.crossed,true); assert.equal(third.queued,false);
  assert.equal((await done('three')).counted,false);
  await done('four');
  const alex = await business(); assert.equal(alex.completedJobs,4); assert.equal(alex.operator.earned,true);
  assert.equal((await business('sam-pets')).completedJobs,0);
  assert.equal((await mails()).length,0);
  const ledger = await asJson('gear/' + account.id + '.json');
  assert.equal(Object.keys(ledger.businesses[alex.id].completed).length,4);
  assert.ok(Object.keys(ledger.businesses[alex.id].completed).every(key => /^[a-f0-9]{64}$/.test(key)));
  assert.equal(JSON.stringify(ledger).includes('customer@example.test'),false);
});

test('an opted-in crossing queues one escaped parent message with an authenticated gear link', async () => {
  const meta = await asJson('pages/alex-lawn.json'); meta.names.biz = 'Alex <Garden> & Co.'; meta.card.title = meta.names.biz; await putJson('pages/alex-lawn.json',meta);
  const alex = await business(); await prefer(alex.id,true);
  await done('one',{email:'customer@example.test',contact:'customer@example.test'}); await done('two');
  assert.equal((await mails()).length,0);
  assert.equal((await done('three')).queued,true);
  await done('three'); await done('four'); await prefer(alex.id,true);
  const [message] = await mails(); assert.equal((await mails()).length,1);
  assert.equal(message.to,account.email); assert.equal(message.ownerId,account.id); assert.equal(message.kind,'gear-operator');
  assert.equal(message.gearBusinessId,alex.id); assert.match(message.subject,/Alex <Garden> & Co\. earned Operator/);
  assert.match(message.html,/Alex &lt;Garden&gt; &amp; Co\./); assert.doesNotMatch(message.html,/<Garden>/);
  assert.match(message.text,/3 jobs marked Done by a parent/); assert.match(message.text,/Downloads are free/); assert.match(message.text,/printed items is optional/);
  assert.match(message.html,/Public business card preview/); assert.match(message.html,/\/api\/card\/alex-lawn\.png/);
  assert.ok(message.text.includes(ORIGIN + '/?gear=1&business=' + alex.id));
  assert.doesNotMatch(message.text,/customer@example|\?draft=|[?&]token=|\/api\/job\/|[?&]code=/);
});

test('sibling progress and email choices stay separate, even with a family-wide latest draft', async () => {
  await draft('alex0001',{first:'Alex',bizName:'Alex & Co.',siteUrl:ORIGIN + '/alex-lawn',theme:'neighbor',palette:'violet',siteFont:'pacifico',type:'garden'});
  await draft('sam00001',{first:'Sam',bizName:"Sam's Pet Care",siteUrl:ORIGIN + '/sam-pets',theme:'hustle',palette:'teal',siteFont:'bungee',type:'pet'});
  account.draftCode = 'sam00001';
  await syncGearBusiness(account,{slug:'alex-lawn',draftCode:'alex0001'});
  const alex = await business(), sam = await business('sam-pets');
  assert.equal(alex.brand.font,'pacifico'); assert.equal(alex.brand.accent,'#A78BFA'); assert.equal(alex.brand.businessName,'Alex & Co.');
  assert.equal(sam.brand.font,'bungee'); assert.equal(sam.brand.accent,'#14B8A6');
  assert.equal(JSON.stringify(await get({slug:'alex-lawn'})).includes('alex0001'),false); assert.equal(JSON.stringify(await get({slug:'sam-pets'})).includes('sam00001'),false);
  assert.equal(JSON.stringify(await get()).includes('alex0001'),false); assert.equal(JSON.stringify(await get()).includes('Sam'),false);
  await prefer(alex.id,true);
  for (let i = 0; i < 3; i++) await done('sam-' + i,{slug:'sam-pets',gearBusinessId:sam.id});
  assert.equal((await business()).completedJobs,0); assert.equal((await business('sam-pets')).operator.earned,true);
  assert.equal((await mails()).length,0);
  for (let i = 0; i < 3; i++) await done('alex-' + i,{gearBusinessId:alex.id});
  assert.equal((await mails()).length,1); assert.equal((await mails())[0].gearBusinessId,alex.id);
});

test('legacy draft resolution uses an unambiguous owned page URL, never the newest draft or another owner', async () => {
  await draft('sam00001',{first:'Sam',bizName:"Sam's Pet Care",siteUrl:ORIGIN + '/sam-pets',theme:'neighbor',siteFont:'fredoka'});
  account.draftCode = 'sam00001';
  assert.equal((await business()).brand.source,'page');
  assert.equal((await business()).brand.font,'');
  await draft('alex0001',{first:'Alex',siteUrl:ORIGIN + '/alex-lawn',theme:'hustle',palette:'cobalt',siteFont:'anton'});
  assert.equal((await business()).brand.font,'anton');
  await draft('foreign1',{first:'Alex',siteUrl:ORIGIN + '/alex-lawn',theme:'hustle',siteFont:'bangers'},'foreign-parent');
  const result = await syncGearBusiness(account,{slug:'alex-lawn',draftCode:'foreign1'});
  assert.equal(result.ok,true); assert.equal((await business()).brand.font,'anton');
  assert.equal((await asJson('pages/alex-lawn.json')).gearDraftCode,'alex0001');
});

test('ambiguous legacy drafts and an explicitly wrong sibling draft safely use public page branding', async () => {
  await draft('alex0001',{siteUrl:ORIGIN + '/alex-lawn',theme:'hustle',siteFont:'anton'});
  await draft('alex0002',{siteUrl:ORIGIN + '/alex-lawn',theme:'neighbor',siteFont:'pacifico'});
  await draft('sam00001',{first:'Sam',bizName:"Sam's Pet Care",siteUrl:ORIGIN + '/sam-pets',theme:'neighbor',siteFont:'fredoka'});
  await syncGearBusiness(account,{slug:'alex-lawn',draftCode:'sam00001'});
  const alex = await business();
  assert.equal(alex.brand.source,'page'); assert.equal(alex.brand.font,''); assert.equal(alex.business,'Alex & Co.');
  assert.equal((await asJson('pages/alex-lawn.json')).gearDraftCode,undefined);
});

test('a new owned draft without a URL binds only when its names match the published page', async () => {
  await draft('sam00001',{first:'Sam',bizName:"Sam's Pet Care",theme:'neighbor',siteFont:'fredoka'});
  await syncGearBusiness(account,{slug:'alex-lawn',draftCode:'sam00001'});
  assert.equal((await business()).brand.font,'');
  await draft('alex0001',{first:'Alex',bizName:'Alex & Co.',theme:'neighbor',palette:'gold',siteFont:'playfair'});
  await syncGearBusiness(account,{slug:'alex-lawn',draftCode:'alex0001'});
  assert.equal((await business()).brand.font,'playfair'); assert.equal((await business()).brand.accent,'#F5B800');
});

test('page-only branding refreshes on republish instead of retaining a stale fallback', async () => {
  const original = await business(); assert.equal(original.brand.theme,'neighbor'); assert.equal(original.brand.accent,'#245B45');
  const meta = await asJson('pages/alex-lawn.json');
  meta.names.biz = 'Alex Garden'; meta.card = {title:'Alex Garden',line:'Updated garden help',theme:'hustle',accent:'#3E8BFF'};
  await putJson('pages/alex-lawn.json',meta); await syncGearBusiness(account,{slug:'alex-lawn'});
  const changed = await business();
  assert.equal(changed.id,original.id); assert.equal(changed.business,'Alex Garden');
  assert.equal(changed.brand.theme,'hustle'); assert.equal(changed.brand.accent,'#3E8BFF'); assert.equal(changed.brand.palette,'cobalt');
  assert.equal(changed.brand.tagline,'Updated garden help'); assert.equal(changed.brand.source,'page');
});

test('completed jobs and the owned brand snapshot survive booking and draft retention', async ctx => {
  await draft('alex0001',{first:'Alex',bizName:'Alex & Co.',siteUrl:ORIGIN + '/alex-lawn',theme:'neighbor',palette:'violet',siteFont:'pacifico'});
  await syncGearBusiness(account,{slug:'alex-lawn',draftCode:'alex0001'});
  await done('one'); await done('two'); await done('three');
  const original = await business();
  await putJson('requests/' + account.id + '.json',[]);
  await db.del('drafts/alex0001.json'); await db.del('draftby/' + account.id + '/alex0001');
  ctx.mock.timers.setTime(new Date('2028-01-01T00:00:00Z').getTime());
  const after = await business();
  assert.equal(after.id,original.id); assert.equal(after.completedJobs,3); assert.equal(after.operator.earnedAt,original.operator.earnedAt);
  assert.equal(after.brand.font,'pacifico'); assert.equal(after.brand.accent,'#A78BFA');
  assert.equal((await done('three')).counted,false);
  assert.equal((await mails()).length,0);
});

test('renaming preserves stable identity, draft branding, old booking aliases and sibling isolation', async () => {
  await draft('alex0001',{first:'Alex',bizName:'Alex & Co.',siteUrl:ORIGIN + '/alex-lawn',theme:'neighbor',siteFont:'pacifico'});
  const before = await business(), sam = await business('sam-pets');
  await prefer(before.id,true); await done('one'); await done('two');
  const old = await asJson('pages/alex-lawn.json');
  await putJson('pages/alex-garden.json',{...old,slug:'alex-garden'});
  await putJson('pages/alex-lawn.json',{slug:'alex-lawn',accountId:account.id,status:'redirect',to:'alex-garden'});
  account.slug = 'alex-garden'; account.slugs = ['alex-garden','sam-pets']; account.formerSlugs = ['alex-lawn'];
  const renamed = await renameGearBusiness(account,'alex-lawn','alex-garden');
  assert.equal(renamed.businessId,before.id);
  const after = await business('alex-garden'); assert.equal(after.id,before.id); assert.equal(after.completedJobs,2); assert.equal(after.brand.font,'pacifico');
  assert.equal((await get({slug:'alex-lawn'})).selectedBusinessId,before.id);
  assert.equal((await done('three')).queued,true);
  assert.equal((await business('alex-garden')).completedJobs,3);
  assert.equal((await business('sam-pets')).id,sam.id); assert.equal((await business('sam-pets')).completedJobs,0);
  assert.equal((await asJson('pages/alex-garden.json')).gearBusinessId,before.id);
  assert.equal((await mails())[0].gearBusinessId,before.id);
});

test('rename migration works before the ledger exists and rejects a foreign target', async () => {
  const old = await asJson('pages/alex-lawn.json');
  await putJson('pages/alex-garden.json',{...old,slug:'alex-garden'});
  await putJson('pages/alex-lawn.json',{slug:'alex-lawn',accountId:account.id,status:'redirect',to:'alex-garden'});
  account.slug = 'alex-garden'; account.slugs = ['alex-garden','sam-pets']; account.formerSlugs = ['alex-lawn'];
  const renamed = await renameGearBusiness(account,'alex-lawn','alex-garden');
  assert.equal(renamed.ok,true); assert.equal((await done('legacy-old-slug')).counted,true);
  assert.equal((await business('alex-garden')).completedJobs,1);
  await putJson('pages/not-ours.json',page('not-ours','Other','Other','other-parent'));
  assert.equal((await renameGearBusiness(account,'alex-garden','not-ours')).status,404);
  assert.equal((await business('alex-garden')).id,renamed.businessId);
});

test('retained historical Done rows migrate without promotional mail and never replay on later opt-in', async () => {
  await putJson('requests/' + account.id + '.json',[
    ...['one','two','three','three'].map(id => ({id,slug:'alex-lawn',status:'done'})),
    {id:'pending',slug:'alex-lawn',status:'new'}, {id:'cancelled',slug:'alex-lawn',status:'cancelled'},
    {id:'question',slug:'alex-lawn',status:'done',kind:'inquiry'}, {id:'foreign',slug:'not-ours',status:'done'}
  ]);
  const alex = await business(); assert.equal(alex.completedJobs,3); assert.equal(alex.operator.earned,true);
  await prefer(alex.id,true); await done('four');
  assert.equal((await business()).completedJobs,4); assert.equal((await mails()).length,0);
  assert.equal((await asJson('gear/' + account.id + '.json')).businesses[alex.id].operatorEmailDecision,'historical');
});

test('turning emails on after an opted-out achievement never sends it retroactively', async () => {
  await done('one'); await done('two'); await done('three');
  const alex = await business(); await prefer(alex.id,true); await done('four');
  await prefer(alex.id,false); await prefer(alex.id,true); await done('five');
  assert.equal((await mails()).length,0); assert.equal((await business()).completedJobs,5);
});

test('opt-out is per business and removes its unsent queued milestone without allowing a replay', async () => {
  const alex = await business(), sam = await business('sam-pets'); await prefer(alex.id,true); await prefer(sam.id,true);
  for (const id of ['one','two','three']) { await done('alex-' + id); await done('sam-' + id,{slug:'sam-pets'}); }
  assert.equal((await mails()).length,2);
  await prefer(alex.id,false);
  assert.equal((await mails()).length,1); assert.equal((await mails())[0].gearBusinessId,sam.id);
  await prefer(alex.id,true); await done('alex-four');
  assert.equal((await mails()).length,1);
});

test('concurrent retries count a request once and distinct crossings queue only one notice', async () => {
  const alex = await business(); await prefer(alex.id,true);
  await Promise.all(Array.from({length:12},() => done('same-request')));
  assert.equal((await business()).completedJobs,1);
  await Promise.all(Array.from({length:12},(_,i) => done('distinct-' + i)));
  assert.equal((await business()).completedJobs,13); assert.equal((await mails()).length,1);
});

test('the booking, progress and queued notice all roll back with a failed account transaction', async () => {
  const alex = await business(); await prefer(alex.id,true); await done('one'); await done('two');
  await putJson('requests/' + account.id + '.json',[{id:'three',slug:'alex-lawn',status:'confirmed'}]);
  await assert.rejects(transaction(async () => {
    assert.equal((await done('three')).queued,true);
    await (await store()).put('requests/' + account.id + '.json',JSON.stringify([{id:'three',slug:'alex-lawn',status:'done'}]));
    throw new Error('booking save failed');
  },{keys:['account:' + account.id]}),/booking save failed/);
  assert.equal((await business()).completedJobs,2); assert.equal((await mails()).length,0);
  assert.equal((await asJson('requests/' + account.id + '.json'))[0].status,'confirmed');
  assert.equal((await done('three')).queued,true); assert.equal((await mails()).length,1);
});

test('a failed ledger commit does not leave a notice behind or consume the achievement', async () => {
  const alex = await business(); await prefer(alex.id,true); await done('one'); await done('two');
  db.failOnceFor = 'gear/' + account.id + '.json';
  await assert.rejects(done('three'),/test write failure/);
  assert.equal((await business()).completedJobs,2); assert.equal((await mails()).length,0);
  assert.equal((await done('three')).queued,true); assert.equal((await mails()).length,1);
});

test('account erasure removes durable milestones and owned queued gear mail without touching another family', async () => {
  const alex = await business(); await prefer(alex.id,true); await done('one'); await done('two'); await done('three');
  await putJson('gear/other-parent.json',{version:1,accountId:'other-parent',businesses:{}});
  await putJson('mailqueue/other-family.json',{kind:'gear-operator',ownerId:'other-parent',gearBusinessId:'other',to:'other@example.test'});
  await putJson('mailqueue/booking.json',{kind:'booking',ownerId:account.id,to:account.email});
  await deleteGearAccount(account);
  assert.equal(await db.get('gear/' + account.id + '.json'),null);
  assert.ok(await db.get('gear/other-parent.json'));
  assert.deepEqual((await mails()).map(row => row.kind).sort(),['booking','gear-operator']);
  assert.equal((await mails()).find(row => row.kind === 'gear-operator').ownerId,'other-parent');
});

test('retained owned gear works with missing page metadata but never follows a slug to a foreign owner', async () => {
  await done('one'); const alex = await business();
  await db.del('pages/alex-lawn.json');
  const missing = await business(); assert.equal(missing.id,alex.id); assert.equal(missing.completedJobs,1); assert.equal(missing.previewUrl,'');
  await putJson('pages/alex-lawn.json',page('alex-lawn','Someone Else','Other','foreign-parent'));
  assert.equal((await get()).businesses.some(item => item.id === alex.id),false);
  assert.equal((await done('two')).counted,false);
});

test('corrupt or wrong-owner ledgers fail closed instead of resetting earned progress', async () => {
  await putJson('gear/' + account.id + '.json',{version:1,accountId:'someone-else',businesses:{}});
  await assert.rejects(get(),/Invalid gear ledger/);
  assert.equal((await asJson('gear/' + account.id + '.json')).accountId,'someone-else');
  await db.put('gear/' + account.id + '.json','{broken');
  await assert.rejects(done('one'),SyntaxError);
  assert.equal(await db.get('gear/' + account.id + '.json'),'{broken');
  assert.equal((await mails()).length,0);
});

test('parent API integrates publish branding, first Done, retained progress, rename, offline access and erasure', async ctx => {
  const {handleRequest} = await import('../host/lib/router.mjs');
  process.env.PAYWALL_MODE = 'test';
  let ip = 0;
  const call = async (method,path,body,token) => {
    const response = await handleRequest({method,path,origin:ORIGIN,query:new URL(ORIGIN + path).searchParams,
      headers:{origin:ORIGIN,authorization:token ? 'Bearer ' + token : '', 'x-forwarded-for':'203.0.113.' + (++ip)},body:body ? JSON.stringify(body) : ''});
    return {status:response.status,body:JSON.parse(response.body || '{}')};
  };
  const email = 'gear-api-parent@example.test';
  const auth = await call('POST','/api/auth/start',{email});
  assert.equal(auth.status,200);
  const verified = await call('POST','/api/auth/verify',{email,code:auth.body.devCode}), token = verified.body.token;
  assert.equal(verified.status,200);
  assert.equal((await call('POST','/api/consent',{consent:true},token)).status,200);
  assert.equal((await call('POST','/api/checkout',{plan:'season'},token)).status,200);
  const saved = await call('POST','/api/draft',{draft:{first:'Rae',bizName:'Rae Garden',theme:'neighbor',palette:'cobalt',siteFont:'gochi'}},token);
  assert.equal(saved.status,200);
  const html = '<!doctype html><html><head><title>Rae Garden</title></head><body><!-- hb-public --><h1>Rae Garden</h1><script>window.__C={"first":"Rae","biz":"Rae Garden"};</script></body></html>';
  const published = await call('POST','/api/publish',{slug:'rae-garden',html,draftCode:saved.body.code},token);
  assert.equal(published.status,200);
  const owner = await db.get('tokens/' + createHash('sha256').update(token).digest('hex'));
  assert.ok(owner);
  assert.equal((await call('GET','/api/gear')).status,401);
  assert.equal((await call('GET','/api/gear?code=' + published.body.jobCode)).status,401);
  assert.equal((await call('GET','/api/gear?business=gb_' + 'ab'.repeat(12) + '&code=' + published.body.jobCode)).status,401);
  assert.equal(JSON.stringify((await call('GET','/api/gear?business=gb_' + 'cd'.repeat(12))).body).includes('Rae'),false);
  assert.equal((await call('POST','/api/gear',{code:published.body.jobCode,milestoneEmails:true})).status,401);
  const gear = await call('GET','/api/gear',null,token), business = gear.body.businesses[0];
  assert.equal(gear.status,200); assert.equal(business.brand.font,'gochi'); assert.equal(business.brand.accent,'#3E8BFF');
  assert.equal((await call('POST','/api/gear',{businessId:business.id,milestoneEmails:true},token)).status,200);
  for (let i = 0; i < 3; i++) {
    const booking = await call('POST','/api/book',{requestId:'gear-api-request-' + i,slug:'rae-garden',name:'Test Neighbor ' + i,contact:'gear-customer-' + i + '@example.test',service:'Garden cleanup',when:'November 24 at 4 PM',start:'2026-11-24T16:00',address:'123 Test Street',t:5000});
    assert.equal(booking.status,200,JSON.stringify(booking.body));
    const row = (await asJson('requests/' + owner + '.json')).at(-1);
    assert.equal(row.gearBusinessId,business.id);
    const before = await call('GET','/api/gear',null,token); assert.equal(before.body.businesses[0].completedJobs,i);
    const completed = await call('POST','/api/job/' + row.actionToken,{status:'done',json:true});
    assert.equal(completed.status,200); assert.equal(completed.body.status,'done');
    assert.equal((await call('POST','/api/job/' + row.actionToken,{status:'done',json:true})).status,200);
  }
  const progress = await call('GET','/api/gear',null,token);
  assert.equal(progress.body.businesses[0].completedJobs,3); assert.equal(progress.body.businesses[0].operator.earned,true);
  const inboxKey = 'outbox/' + createHash('sha256').update(email).digest('hex') + '.json';
  assert.equal((await asJson(inboxKey)).filter(message => message.kind === 'gear-operator').length,1);
  const renamed = await call('POST','/api/slug',{from:'rae-garden',slug:'rae-garden-care'},token);
  assert.equal(renamed.status,200);
  const moved = await call('GET','/api/gear?business=' + business.id,null,token);
  assert.equal(moved.body.businesses[0].id,business.id); assert.equal(moved.body.businesses[0].slug,'rae-garden-care');
  assert.equal(moved.body.businesses[0].brand.font,'gochi'); assert.equal(moved.body.businesses[0].completedJobs,3);
  assert.equal((await call('POST','/api/unpublish',{slug:'rae-garden-care'},token)).status,200);
  ctx.mock.timers.setTime(new Date('2027-04-01T00:00:00Z').getTime());
  assert.equal((await call('GET','/api/my-jobs',null,token)).status,200);
  assert.deepEqual(await asJson('requests/' + owner + '.json'),[],'normal request retention pruned the bookings');
  const retained = await call('GET','/api/gear',null,token);
  assert.equal(retained.status,200); assert.equal(retained.body.businesses[0].completedJobs,3); assert.equal(retained.body.businesses[0].operator.earned,true);
  assert.equal((await call('DELETE','/api/account',null,token)).status,200);
  assert.equal(await db.get('gear/' + owner + '.json'),null);
  assert.equal((await call('GET','/api/gear',null,token)).status,401);
});
