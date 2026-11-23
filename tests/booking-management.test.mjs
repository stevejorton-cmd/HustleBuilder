import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ICAL from 'ical.js';
import {fileStore,setStore,store} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';

let dir, ip=0;
const sha=s=>createHash('sha256').update(s).digest('hex');
const base='http://sites.test';
test.beforeEach(async ctx=>{
  ctx.mock.timers.enable({apis:['Date'],now:new Date('2026-11-22T18:00:00Z')});
  dir=await mkdtemp(path.join(tmpdir(),'hb-manage-'));
  setStore(fileStore(dir));ip=0;
  process.env.PUBLISH_TEST_MODE='1';process.env.PAYWALL_MODE='test';
  process.env.PUBLIC_ORIGIN=base;
});
test.afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
function call(method,url,{body,token}={}){
  return handleRequest({method,path:url,origin:base,query:new URL(base+url).searchParams,
    headers:{origin:base,authorization:token?'Bearer '+token:'','x-forwarded-for':'203.0.113.'+(++ip)},
    body:body?JSON.stringify(body):''});
}
const json=async res=>({status:res.status,body:JSON.parse(res.body||'{}')});
async function read(key){return JSON.parse(await (await store()).get(key)||'null');}
async function write(key,value){return (await store()).put(key,JSON.stringify(value));}
async function outbox(email){const r=await json(await call('GET','/api/test/outbox?email='+encodeURIComponent(email)));return r.body.messages;}
function ics(message){
  assert.ok(message?.ics,'calendar attachment exists');
  const c=new ICAL.Component(ICAL.parse(message.ics)),e=c.getFirstSubcomponent('vevent');
  return {method:c.getFirstPropertyValue('method'),uid:e.getFirstPropertyValue('uid'),sequence:e.getFirstPropertyValue('sequence'),status:e.getFirstPropertyValue('status'),start:e.getFirstPropertyValue('dtstart').toString(),description:e.getFirstPropertyValue('description')||''};
}
async function family(email='parent-manage@example.com',slug='sam-manage',code='samdraft'){
  const a=await json(await call('POST','/api/auth/start',{body:{email}}));
  assert.equal(a.body.ok,true);
  const v=await json(await call('POST','/api/auth/verify',{body:{email,code:a.body.devCode}}));
  const token=v.body.token;
  assert.equal((await call('POST','/api/consent',{token,body:{consent:true}})).status,200);
  assert.equal((await call('POST','/api/checkout',{token,body:{plan:'season'}})).status,200);
  const html='<!doctype html><html><head><title>Sam Yard</title></head><body><!-- hb-public --><h1>Sam Yard</h1><script>window.__C={"first":"Sam","biz":"Sam Yard"};</script></body></html>';
  const pub=await json(await call('POST','/api/publish',{token,body:{slug,html,draftCode:code}}));
  assert.equal(pub.body.ok,true);
  const id=(await (await store()).get('tokens/'+sha(token))).trim();
  const me=await json(await call('GET','/api/me',{token}));
  return {id,email,token,slug,code:pub.body.jobCode||code,feed:new URL(me.body.calUrl).pathname};
}
async function book(f,{contact='customer-manage@example.com',service='Leaf cleanup',start='2026-12-02T16:00',when='December 2 at 4 PM',...extras}={}){
  const r=await json(await call('POST','/api/book',{body:{slug:f.slug,name:'Casey Neighbor',contact,service,start,when,address:'123 Private Lane',note:'Front yard',access:'secret gate code 9876',t:5000,...extras}}));
  assert.equal(r.status,200,JSON.stringify(r.body));
  const rows=await read('requests/'+f.id+'.json');
  return rows.at(-1);
}
async function row(f,id){return (await read('requests/'+f.id+'.json')).find(r=>r.id===id);}
async function act(r,status,start){return call('POST','/api/job/'+r.actionToken,{body:{status,...(start?{start}:{}),json:true}});}
async function events(f){
  const response=await call('GET',f.feed);assert.equal(response.status,200);
  const c=new ICAL.Component(ICAL.parse(response.body));
  return c.getAllSubcomponents('vevent').map(e=>({uid:e.getFirstPropertyValue('uid'),start:e.getFirstPropertyValue('dtstart').toString(),status:e.getFirstPropertyValue('status')}));
}

test('customer management page follows booking state and keeps family secrets out',async()=>{
  const f=await family(),r=await book(f);
  assert.ok(r.cancelToken);
  const manage='/api/booking/'+r.cancelToken;
  const page=await call('GET',manage);
  assert.equal(page.status,200);assert.match(page.body,/Leaf cleanup/);assert.match(page.body,/December 2/);
  for(const secret of [f.email,r.actionToken,'secret gate code','9876',f.feed])assert.equal(page.body.includes(secret),false,secret);
  assert.equal((await call('GET','/api/cancel/'+r.cancelToken)).status,200,'legacy cancellation URL remains usable');
  await act(r,'confirmed');
  const confirmed=await call('GET',manage);
  assert.match(confirmed.body,/confirmed/i);
  assert.doesNotMatch(confirmed.body,/Nothing is booked until the family confirms/);
  const mails=await outbox('customer-manage@example.com');
  for(const subject of ['We got your request','Your booking is confirmed']){
    const message=mails.find(m=>m.subject===subject);assert.ok(message,subject);
    assert.ok(message.text.includes(manage),subject+' has management link');
    assert.ok(message.html.includes(manage),subject+' HTML has management link');
  }
});

test('customer cancellation notifies both sides once and removes the family calendar event',async()=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');
  const beforeParent=(await outbox(f.email)).length,beforeCustomer=(await outbox('customer-manage@example.com')).length;
  const cancel='/api/cancel/'+r.cancelToken;
  const result=await call('POST',cancel,{body:{}});assert.equal(result.status,200);assert.match(result.body,/cancelled/i);
  assert.equal((await row(f,r.id)).status,'cancelled');assert.equal((await events(f)).length,0);
  const parentMail=await outbox(f.email),customerMail=await outbox('customer-manage@example.com');
  assert.equal(parentMail.length,beforeParent+1);assert.equal(customerMail.length,beforeCustomer+1);
  assert.match(parentMail.at(-1).subject,/cancelled/i);assert.match(customerMail.at(-1).subject,/cancelled/i);
  const original=ics(customerMail.find(m=>m.subject==='Your booking is confirmed')),drop=ics(customerMail.at(-1));
  assert.equal(drop.method,'CANCEL');assert.equal(drop.uid,original.uid);assert.ok(drop.sequence>original.sequence);
  assert.equal((await call('POST',cancel,{body:{}})).status,200);
  assert.equal((await outbox(f.email)).length,parentMail.length);assert.equal((await outbox('customer-manage@example.com')).length,customerMail.length);
  assert.match((await call('GET','/api/booking/'+r.cancelToken)).body,/cancelled/i);
});

test('family cancellation sends receipts without requiring a dated calendar attachment',async()=>{
  const f=await family(),r=await book(f,{start:'',when:'Next weekend, arrange a time'});
  assert.equal(r.invite,null);
  const parentBefore=(await outbox(f.email)).length,customerBefore=(await outbox('customer-manage@example.com')).length;
  const result=await json(await act(r,'cancelled'));assert.equal(result.status,200);assert.equal(result.body.status,'cancelled');
  assert.equal((await outbox(f.email)).length,parentBefore+1);
  assert.equal((await outbox('customer-manage@example.com')).length,customerBefore+1);
  await act(r,'cancelled');assert.equal((await outbox(f.email)).length,parentBefore+1);
});

test('phone-only cancellation prompts direct contact and never reports an email sent',async()=>{
  const f=await family(),r=await book(f,{contact:'402-555-0100'});
  const result=await json(await act(r,'cancelled'));assert.equal(result.status,200);
  assert.match(result.body.message,/contact|call|text/i);
  assert.doesNotMatch(result.body.message,/customer (?:was |has been )?emailed/i);
  assert.match((await outbox(f.email)).at(-1).text,/contact|call|text/i);
});

test('terminal bookings cannot be cancelled after completion or resurrected after cancellation',async()=>{
  const f=await family(),done=await book(f);await act(done,'done');
  const count=(await outbox(f.email)).length;
  const cancel=await call('POST','/api/cancel/'+done.cancelToken,{body:{}});
  assert.ok(cancel.status===409||cancel.status===200);assert.equal((await row(f,done.id)).status,'done');
  assert.equal((await outbox(f.email)).length,count);
  assert.equal((await act(done,'cancelled')).status,409);
  const cancelled=await book(f,{service:'Second yard cleanup'});await act(cancelled,'cancelled');
  for(const state of ['confirmed','done'])assert.equal((await act(cancelled,state)).status,409,state);
  assert.equal((await row(f,cancelled.id)).status,'cancelled');
});

test('confirmed customer invitations preserve identity, contain management URL and exclude parent secrets',async()=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');
  const customer=(await outbox('customer-manage@example.com')).find(m=>m.subject==='Your booking is confirmed');
  const invite=ics(customer);assert.equal(invite.method,'REQUEST');assert.equal(invite.status,'CONFIRMED');
  const parent=(await outbox(f.email)).find(m=>/Booking request/.test(m.subject));
  assert.equal(invite.uid,ics(parent).uid);assert.ok(invite.sequence>ics(parent).sequence);
  assert.ok(customer.ics.replace(/\r\n[ \t]/g,'').includes('/api/booking/'+r.cancelToken));
  for(const secret of [f.email,r.actionToken,'secret gate code','9876',f.feed])assert.equal(customer.ics.includes(secret),false,secret);
});

test('rescheduling waits for parent approval then moves the same event and preserves siblings',async()=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');
  const sibling=await book(f,{service:'Dog walk',contact:'second-customer@example.com',start:'2026-12-03T10:00',when:'December 3 at 10 AM'});
  const before=await events(f),original=before.find(e=>e.uid===r.invite.uid),other=before.find(e=>e.uid===sibling.invite.uid);
  const target='2026-12-06T14:30';
  const request=await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:target}});
  assert.equal(request.status,200);
  let current=await row(f,r.id);assert.equal(current.reschedule.start,target);assert.equal(current.invite.start,r.invite.start);
  assert.deepEqual(await events(f),before);
  const pCount=(await outbox(f.email)).length,cCount=(await outbox('customer-manage@example.com')).length;
  assert.equal((await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:target}})).status,200);
  assert.equal((await outbox(f.email)).length,pCount);assert.equal((await outbox('customer-manage@example.com')).length,cCount);
  assert.equal((await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:'2026-12-07T16:00'}})).status,409,'cannot overwrite an unreviewed proposal');
  assert.equal((await act(r,'accept-reschedule','2026-12-07T16:00')).status,409,'stale approval cannot move another proposed time');
  const approved=await json(await act(r,'accept-reschedule',target));assert.equal(approved.status,200);
  current=await row(f,r.id);assert.equal(current.status,'confirmed');assert.equal(current.invite.start,target);assert.ok(!current.reschedule);
  const after=await events(f),moved=after.find(e=>e.uid===original.uid);
  assert.ok(moved);assert.equal(moved.start,'2026-12-06T14:30:00');assert.equal(moved.status,'CONFIRMED');
  assert.deepEqual(after.find(e=>e.uid===other.uid),other);
  assert.equal(after.length,before.length);
  assert.equal((await outbox(f.email)).length,pCount+1);assert.equal((await outbox('customer-manage@example.com')).length,cCount+1);
  const notice=(await outbox('customer-manage@example.com')).at(-1),update=ics(notice);
  assert.equal(update.uid,original.uid);assert.equal(update.start,'2026-12-06T14:30:00');assert.equal(update.method,'REQUEST');
});

test('declining a reschedule retains original time and emails both parties',async()=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');const before=await events(f);
  assert.equal((await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:'2026-12-06T14:30'}})).status,200);
  const pCount=(await outbox(f.email)).length,cCount=(await outbox('customer-manage@example.com')).length;
  assert.equal((await act(r,'decline-reschedule','2026-12-06T14:30')).status,200);
  assert.ok(!(await row(f,r.id)).reschedule);assert.deepEqual(await events(f),before);
  assert.equal((await outbox(f.email)).length,pCount+1);assert.equal((await outbox('customer-manage@example.com')).length,cCount+1);
});

test('reschedule rejects invalid, past, nonexistent local and more than 120-day dates without changing booking',async()=>{
  const f=await family(),r=await book(f);const before=await row(f,r.id);
  for(const start of ['bad','2026-02-31T10:00','2026-11-22T16:00','2026-11-21T10:00','2027-03-14T02:30','2027-06-01T10:00']){
    const result=await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start}});
    assert.equal(result.status,400,start);
    const after=await row(f,r.id);assert.equal(after.invite.start,before.invite.start);assert.ok(!after.reschedule,start);
  }
});

test('kid asks parent once without cancelling, revealing management authority or crossing family boundaries',async()=>{
  const f=await family(),r=await book(f),other=await family('other-parent@example.com','other-manage','otherkid');
  const response=await json(await call('GET','/api/my-jobs?code='+f.code));assert.equal(response.status,200);assert.equal(response.body.parentAuthenticated,false);
  const kid=response.body.jobs.find(j=>j.id===r.id);assert.equal(kid.canAskCancel,true);
  for(const secret of ['action','actionToken','parentEmail','address','contact','cancelToken'])assert.equal(kid[secret],undefined,secret);
  const before=(await outbox(f.email)).length;
  const ask=await json(await call('POST','/api/my-jobs/cancel-request',{body:{code:f.code,id:r.id}}));assert.equal(ask.status,200);
  assert.equal((await row(f,r.id)).status,'new');assert.ok((await row(f,r.id)).cancelRequestedAt);
  assert.equal((await outbox(f.email)).length,before+1);
  const pendingKid=await json(await call('GET','/api/my-jobs?code='+f.code));
  assert.equal(pendingKid.body.jobs.find(j=>j.id===r.id).cancelRequested,true);
  assert.equal((await call('POST','/api/my-jobs/cancel-request',{body:{code:f.code,id:r.id}})).status,200);
  assert.equal((await outbox(f.email)).length,before+1);
  const parentView=await json(await call('GET','/api/my-jobs',{token:f.token}));assert.equal(parentView.body.parentAuthenticated,true);
  const managed=parentView.body.jobs.find(j=>j.id===r.id);assert.ok(managed.action);assert.ok(managed.cancelRequested);
  for(const code of ['notacode',other.code]){
    const denied=await call('POST','/api/my-jobs/cancel-request',{body:{code,id:r.id}});
    assert.ok(denied.status===401||denied.status===404,code);
  }
  assert.equal((await row(f,r.id)).status,'new');
});

test('expired or unknown customer capability cannot view or change a booking',async()=>{
  const f=await family(),r=await book(f),token='a'.repeat(36);
  assert.equal((await call('GET','/api/booking/'+token)).status,404);
  assert.equal((await call('POST','/api/booking/'+token,{body:{action:'reschedule',start:'2026-12-06T10:00'}})).status,404);
  const rows=await read('requests/'+f.id+'.json');rows[0].createdAt='2025-01-01T00:00:00Z';rows[0].invite.start='2025-01-02T10:00';rows[0].calJob=null;
  await write('requests/'+f.id+'.json',rows);
  assert.equal((await call('GET','/api/booking/'+r.cancelToken)).status,404);
});

test('simultaneous family and customer cancellation creates one result and one receipt per party',async()=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');
  const pCount=(await outbox(f.email)).length,cCount=(await outbox('customer-manage@example.com')).length;
  const results=await Promise.all([
    act(r,'cancelled'),
    call('POST','/api/cancel/'+r.cancelToken,{body:{}}),
    call('POST','/api/booking/'+r.cancelToken,{body:{action:'cancel'}})
  ]);
  for(const result of results)assert.equal(result.status,200);
  assert.equal((await row(f,r.id)).status,'cancelled');assert.equal((await events(f)).length,0);
  assert.equal((await outbox(f.email)).length,pCount+1);assert.equal((await outbox('customer-manage@example.com')).length,cCount+1);
});

test('cancelling with a proposed new time clears the proposal and blocks stale parent approval',async()=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');const target='2026-12-06T14:30';
  assert.equal((await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:target}})).status,200);
  assert.equal((await call('POST','/api/cancel/'+r.cancelToken,{body:{}})).status,200);
  const beforeP=(await outbox(f.email)).length,beforeC=(await outbox('customer-manage@example.com')).length;
  assert.equal((await act(r,'accept-reschedule',target)).status,409);
  const cancelled=await row(f,r.id);assert.equal(cancelled.status,'cancelled');assert.ok(!cancelled.reschedule);
  assert.equal((await events(f)).length,0);assert.equal((await outbox(f.email)).length,beforeP);assert.equal((await outbox('customer-manage@example.com')).length,beforeC);
});

test('an undated booking gaining a date keeps one identity across both calendar formats and the family feed',async()=>{
  const f=await family(),r=await book(f,{start:'',when:'Arrange a time next week'});
  assert.equal(r.invite,null);assert.ok(r.cancelToken);
  const target='2026-12-08T15:30';
  assert.equal((await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:target}})).status,200);
  assert.equal((await act(r,'accept-reschedule',target)).status,200);
  const current=await row(f,r.id);assert.equal(current.status,'confirmed');
  const feed=await events(f);assert.equal(feed.length,1);assert.equal(feed[0].uid,current.invite.uid);
  const message=(await outbox('customer-manage@example.com')).at(-1),invite=ics(message);
  assert.equal(invite.method,'REQUEST');assert.equal(invite.uid,feed[0].uid);
  const one=await call('GET','/api/event/'+current.eventToken+'.ics');assert.equal(one.status,200);
  const publicCalendar=ics({ics:one.body});assert.equal(publicCalendar.method,'PUBLISH');assert.equal(publicCalendar.uid,invite.uid);
  assert.equal(publicCalendar.sequence,invite.sequence);assert.equal(publicCalendar.start,invite.start);
  const stored=await read('events/'+current.eventToken+'.json');assert.equal(stored.id+'@hustlebuilder.org',invite.uid);
});

test('undated phone-only booking retains its management token before any parent action',async()=>{
  const f=await family(),r=await book(f,{contact:'402-555-0100',start:'',when:'Arrange a time next week'});
  assert.ok(r.cancelToken,'management token is persisted for phone-only requests');
  const capability=await read('cancels/'+r.cancelToken+'.json');assert.equal(capability.requestId,r.id);assert.equal(capability.accountId,f.id);
  const page=await call('GET','/api/booking/'+r.cancelToken);assert.equal(page.status,200);assert.match(page.body,/Leaf cleanup/);
});

test('family feed uses the safe My jobs entry point without distributing parent action authority',async()=>{
  const f=await family(),r=await book(f);const feed=await call('GET',f.feed);
  const unfolded=feed.body.replace(/\r\n[ \t]/g,'');
  assert.ok(unfolded.includes('/?jobs=1'),'family calendar has safe My jobs link');
  assert.equal(unfolded.includes('/api/job/'),false);assert.equal(unfolded.includes(r.actionToken),false);
  await act(r,'confirmed');
  const confirmed=(await call('GET',f.feed)).body.replace(/\r\n[ \t]/g,'');
  assert.ok(confirmed.includes('/?jobs=1'));assert.equal(confirmed.includes(r.actionToken),false);
});

test('moving a booking later extends request, capability and public-event retention to the new appointment',async ctx=>{
  const f=await family(),r=await book(f);await act(r,'confirmed');
  const before=await read('cancels/'+r.cancelToken+'.json'),target='2027-02-15T16:00';
  assert.equal((await call('POST','/api/booking/'+r.cancelToken,{body:{action:'reschedule',start:target}})).status,200);
  assert.equal((await act(r,'accept-reschedule',target)).status,200);
  const moved=await row(f,r.id),capability=await read('cancels/'+r.cancelToken+'.json'),event=await read('events/'+moved.eventToken+'.json');
  assert.ok(capability.expiresAt>before.expiresAt);assert.ok(event.expiresAt>capability.expiresAt);
  assert.equal(moved.invite.start,target);
  const later=Date.parse('2027-03-16T18:00:00Z');ctx.mock.timers.tick(later-Date.now());
  const active=await call('GET','/api/booking/'+r.cancelToken);assert.equal(active.status,200,'link survives original date plus 30 days and remains available 29 days after new work');
  assert.match(active.body,/February 15, 2027/);
  assert.equal((await row(f,r.id)).invite.start,target);
  assert.equal((await call('GET','/api/event/'+moved.eventToken+'.ics')).status,200);
});

test('parent keeping a kid-requested booking clears the request without cancellation or misleading mail',async()=>{
  const f=await family(),r=await book(f);
  assert.equal((await call('POST','/api/my-jobs/cancel-request',{body:{code:f.code,id:r.id}})).status,200);
  const pCount=(await outbox(f.email)).length,cCount=(await outbox('customer-manage@example.com')).length,before=await events(f);
  const result=await json(await act(r,'keep-booking'));assert.equal(result.status,200);assert.match(result.body.message,/kept|keep/i);
  const kept=await row(f,r.id);assert.equal(kept.status,'new');assert.ok(!kept.cancelRequestedAt);
  const kid=await json(await call('GET','/api/my-jobs?code='+f.code));assert.equal(kid.body.jobs[0].cancelRequested,false);
  assert.equal((await outbox(f.email)).length,pCount);assert.equal((await outbox('customer-manage@example.com')).length,cCount);assert.deepEqual(await events(f),before);
});

test('parent family filters identify sibling businesses, include empty pages and exclude other families',async()=>{
  const f=await family(),other=await family('other-navigation@example.com','other-yard','othernav');
  const publishSibling=async(slug,kid,business)=>{
    const html='<!doctype html><html><head><title>'+business+'</title></head><body><!-- hb-public --><h1>'+business+'</h1><script>window.__C='+JSON.stringify({first:kid,biz:business})+';</script></body></html>';
    const response=await json(await call('POST','/api/publish',{token:f.token,body:{slug,html}}));assert.equal(response.status,200);
  };
  await publishSibling('riley-yard','Riley','Riley Yard Crew');
  await publishSibling('quinn-yard','Quinn','Quinn Yard Crew');
  const sam=await book(f,{service:'Leaf cleanup'}),riley=await book({...f,slug:'riley-yard'},{service:'Leaf cleanup',contact:'riley-customer@example.com'});
  const foreign=await book(other,{service:'Leaf cleanup',contact:'other-customer@example.com'});
  // A stale or damaged account slug list must not expose another family's
  // page names through the navigation metadata.
  const account=await read('accounts/'+f.id+'.json');account.slugs.push(other.slug);await write('accounts/'+f.id+'.json',account);
  const s=await store(),originalGet=s.get;
  s.get=async key=>{assert.equal(key.endsWith('.html'),false,'filters read small metadata, not website HTML');return originalGet(key);};
  const response=await json(await call('GET','/api/my-jobs',{token:f.token}));assert.equal(response.status,200);
  assert.deepEqual(response.body.jobs.map(j=>j.businessKey).sort(),[f.slug,'riley-yard'].sort());
  assert.equal(response.body.jobs.length,2);assert.ok(response.body.jobs.every(j=>j.service==='Leaf cleanup'));
  assert.deepEqual(response.body.businesses.map(b=>b.key).sort(),[f.slug,'riley-yard','quinn-yard'].sort());
  assert.deepEqual(response.body.businesses.find(b=>b.key==='quinn-yard'),{key:'quinn-yard',kid:'Quinn',business:'Quinn Yard Crew'});
  assert.equal(response.body.jobs.some(j=>j.id===foreign.id),false);assert.equal(response.body.businesses.some(b=>b.key===other.slug),false);
  assert.equal(response.body.jobs.find(j=>j.id===sam.id).action,sam.actionToken);
  assert.equal(response.body.jobs.find(j=>j.id===riley.id).action,riley.actionToken);
  const child=await json(await call('GET','/api/my-jobs?code='+f.code));assert.equal(child.status,200);
  assert.deepEqual(child.body.businesses.map(b=>b.key).sort(),[f.slug,'riley-yard'].sort(),'kid view derives filters only from the existing job view');
  assert.ok(child.body.jobs.every(j=>j.action===undefined));
});

test('parent booking pages link to the signed-in family view while customer pages stay booking-specific',async()=>{
  const f=await family(),r=await book(f);
  const parentPage=await call('GET','/api/job/'+r.actionToken);assert.equal(parentPage.status,200);
  assert.match(parentPage.body,/<a href="\/\?jobs=1">View all family bookings<\/a>/);
  assert.match(parentPage.body,/Sam Yard/);
  const customerPage=await call('GET','/api/booking/'+r.cancelToken);assert.equal(customerPage.status,200);
  assert.doesNotMatch(customerPage.body,/View all family bookings|href="\/\?jobs=1"/);
  assert.equal(customerPage.body.includes(r.actionToken),false);
  const unsigned=await call('GET','/api/my-jobs');assert.equal(unsigned.status,401,'following the public family link does not grant parent access');
});
