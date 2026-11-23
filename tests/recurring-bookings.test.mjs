import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import ICAL from 'ical.js';
import {fileStore,setStore,store} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';

let dir,ip=0;
const base='http://sites.test';
const sha=s=>createHash('sha256').update(s).digest('hex');
test.beforeEach(async ctx=>{
  ctx.mock.timers.enable({apis:['Date'],now:new Date('2026-11-22T18:00:00Z')});
  dir=await mkdtemp(path.join(tmpdir(),'hb-repeat-'));
  setStore(fileStore(dir));ip=0;
  process.env.PUBLISH_TEST_MODE='1';process.env.PAYWALL_MODE='test';process.env.PUBLIC_ORIGIN=base;
});
test.afterEach(async()=>{await rm(dir,{recursive:true,force:true});});

function call(method,url,{body,token}={}){
  return handleRequest({method,path:url,origin:base,query:new URL(base+url).searchParams,
    headers:{origin:base,authorization:token?'Bearer '+token:'','x-forwarded-for':'203.0.113.'+(++ip)},
    body:body?JSON.stringify(body):''});
}
const json=async response=>({status:response.status,body:JSON.parse(response.body||'{}')});
const read=async key=>JSON.parse(await (await store()).get(key)||'null');
const write=async(key,value)=>(await store()).put(key,JSON.stringify(value));
const rows=async f=>await read('requests/'+f.id+'.json')||[];
const row=async(f,id)=>(await rows(f)).find(r=>r.id===id);
async function outbox(email){return (await json(await call('GET','/api/test/outbox?email='+encodeURIComponent(email)))).body.messages;}
function parseCalendar(text){
  const calendar=new ICAL.Component(ICAL.parse(text));
  return {method:calendar.getFirstPropertyValue('method'),events:calendar.getAllSubcomponents('vevent').map(event=>({
    uid:event.getFirstPropertyValue('uid'),start:event.getFirstPropertyValue('dtstart').toString(),
    status:event.getFirstPropertyValue('status'),sequence:event.getFirstPropertyValue('sequence'),
    url:event.getFirstPropertyValue('url'),rrule:event.getFirstPropertyValue('rrule')
  }))};
}
async function feed(f){const response=await call('GET',f.feed);assert.equal(response.status,200);return parseCalendar(response.body).events;}
async function publish(f,slug,kid='Sam',biz='Sam Yard'){
  const html='<!doctype html><html><head><title>'+biz+'</title></head><body><!-- hb-public --><h1>'+biz+'</h1><script>window.__C='+JSON.stringify({first:kid,biz})+';</script></body></html>';
  const result=await json(await call('POST','/api/publish',{token:f.token,body:{slug,html,draftCode:'repeats1'}}));
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
}
async function family(){
  const email='repeat-parent@example.com';
  const start=await json(await call('POST','/api/auth/start',{body:{email}}));
  const verified=await json(await call('POST','/api/auth/verify',{body:{email,code:start.body.devCode}}));
  const token=verified.body.token;assert.ok(token);
  assert.equal((await call('POST','/api/consent',{token,body:{consent:true}})).status,200);
  assert.equal((await call('POST','/api/checkout',{token,body:{plan:'season'}})).status,200);
  const f={email,token,slug:'sam-repeat'};
  const published=await publish(f,f.slug);
  f.id=(await (await store()).get('tokens/'+sha(token))).trim();f.code=published.jobCode||'repeats1';
  const me=await json(await call('GET','/api/me',{token}));f.feed=new URL(me.body.calUrl).pathname;
  return f;
}
async function book(f,extra={}){
  const response=await json(await call('POST','/api/book',{body:{slug:f.slug,name:'Casey Neighbor',contact:'repeat-customer@example.com',
    service:'Leaf cleanup',start:'2026-12-02T16:00',when:'December 2 at 4 PM',freq:'Every week',address:'123 Private Lane',
    note:'Front yard',access:'private gate code 9876',t:5000,...extra}}));
  assert.equal(response.status,200,JSON.stringify(response.body));return (await rows(f)).at(-1);
}
const act=(r,status,extra={})=>call('POST','/api/job/'+r.actionToken,{body:{status,json:true,...extra}});
const approve=(r,count=4,extra={})=>act(r,'approve-series',{start:r.invite.start,count,...extra});
async function series(f,original){return (await rows(f)).filter(r=>r.series?.id===original.series.id).sort((a,b)=>a.series.index-b.series.index);}

test('weekly approval creates independent confirmed visits, fresh capabilities and safe customer calendar updates',async()=>{
  const f=await family(),original=await book(f),beforeParent=(await outbox(f.email)).length,beforeCustomer=(await outbox('repeat-customer@example.com')).length;
  assert.equal((await rows(f)).length,1,'frequency preference alone creates one request');
  assert.equal((await feed(f)).length,1);
  const approved=await json(await approve(original));assert.equal(approved.status,200,JSON.stringify(approved.body));
  const visits=await series(f,await row(f,original.id));
  assert.equal(visits.length,4);assert.equal(visits[0].id,original.id);
  assert.equal(visits[0].invite.uid,original.invite.uid,'original calendar identity is retained');
  assert.deepEqual(visits.map(v=>v.invite.start),['2026-12-02T16:00','2026-12-09T16:00','2026-12-16T16:00','2026-12-23T16:00']);
  for(const key of ['id','actionToken','cancelToken','eventToken'])assert.equal(new Set(visits.map(v=>v[key])).size,4,key+' must be unique per visit');
  assert.equal(new Set(visits.map(v=>v.invite.uid)).size,4,'each visit has a different calendar UID');
  for(let i=0;i<visits.length;i++){
    const visit=visits[i];assert.equal(visit.status,'confirmed');
    assert.deepEqual(visit.series,{id:visits[0].series.id,index:i+1,total:4,kind:'weekly'});
    assert.equal(await (await store()).get('jobact/'+visit.actionToken),f.id+':'+visit.id);
    const capability=await read('cancels/'+visit.cancelToken+'.json');assert.equal(capability.requestId,visit.id);
    const customerPage=await call('GET','/api/booking/'+visit.cancelToken);assert.equal(customerPage.status,200);
    assert.match(customerPage.body,new RegExp('Visit '+(i+1)+' of 4'));
    assert.match(customerPage.body,/cancel-series|Cancel remaining visits/);
    const parentPage=await call('GET','/api/job/'+visit.actionToken);assert.equal(parentPage.status,200);
    assert.match(parentPage.body,new RegExp('Visit '+(i+1)+' of 4'));
    assert.match(parentPage.body,/cancel-series|Cancel remaining visits/);
    const customerCalendar=await call('GET','/api/booking/'+visit.cancelToken+'/calendar.ics');assert.equal(customerCalendar.status,200);
    const parsed=parseCalendar(customerCalendar.body);assert.equal(parsed.events.length,1);
    assert.equal(parsed.events[0].uid,visit.invite.uid);assert.equal(parsed.events[0].status,'CONFIRMED');assert.equal(parsed.events[0].rrule,null);
    assert.ok(parsed.events[0].url.endsWith('/api/booking/'+visit.cancelToken));
    for(const secret of [f.email,visit.actionToken,'private gate code','9876',f.feed]){
      assert.equal(customerCalendar.body.includes(secret),false,secret+' is excluded from customer calendar');
      assert.equal(customerPage.body.includes(secret),false,secret+' is excluded from customer page');
    }
  }
  const events=await feed(f);assert.equal(events.length,4);
  assert.deepEqual(events.map(e=>e.uid).sort(),visits.map(v=>v.invite.uid).sort());
  assert.ok(events.every(e=>e.status==='CONFIRMED'&&e.rrule===null));
  const parentMail=await outbox(f.email),customerMail=await outbox('repeat-customer@example.com');
  assert.equal(parentMail.length,beforeParent+4);assert.equal(customerMail.length,beforeCustomer+4);
  const notices=customerMail.filter(m=>m.subject==='Your booking is confirmed');assert.equal(notices.length,4);
  assert.deepEqual(notices.map(m=>parseCalendar(m.ics).events[0].uid).sort(),visits.map(v=>v.invite.uid).sort());
  for(const mail of notices){assert.equal(parseCalendar(mail.ics).method,'REQUEST');for(const visit of visits)assert.equal(mail.ics.includes(visit.actionToken),false);}
});

test('away approval confirms exactly the inclusive dates at the agreed hour',async()=>{
  const f=await family(),original=await book(f,{service:'Dog walk',freq:"While I'm away",start:'2026-11-27T09:30',when:'November 27 at 9:30 AM',awayFrom:'2026-11-27',awayTo:'2026-11-30'});
  const result=await json(await act(original,'approve-series',{start:original.invite.start}));assert.equal(result.status,200,JSON.stringify(result.body));
  const visits=await series(f,await row(f,original.id));
  assert.deepEqual(visits.map(v=>v.invite.start),['2026-11-27T09:30','2026-11-28T09:30','2026-11-29T09:30','2026-11-30T09:30']);
  assert.ok(visits.every(v=>v.status==='confirmed'&&v.series.kind==='away'&&v.series.total===4));
  assert.equal((await feed(f)).length,4);
});

test('repeating visits preserve care instructions on parent surfaces without leaking details or reusing parent links',async()=>{
  const f=await family(),original=await book(f,{
    service:'Dog walk',note:'Keep the small dog separate & close <gate>',size:'Small',
    petKind:'Dog',petCount:'2',petNames:'Fido & Spot',petSize:'Small',dayPart:'Afternoon',
    access:'Use side gate code TEST9876'
  });
  assert.equal((await approve(original,2)).status,200);
  const visits=await series(f,await row(f,original.id)),clone=visits[1];
  const details=[original.fields.note,original.fields.petNames,original.fields.access];
  const storedJobs=await read('caljobs/'+f.id+'.json'),cloneJob=storedJobs.find(job=>job.id===clone.calendarJobId);
  for(const detail of details){
    assert.ok(clone.invite.description.includes(detail),'parent invitation retains '+detail);
    assert.ok(cloneJob.note.includes(detail),'private family calendar retains '+detail);
  }
  assert.match(clone.invite.description,/Pet: Dog x2/);
  assert.match(clone.invite.description,/Time of day: Afternoon/);
  assert.ok(clone.invite.description.includes('/api/job/'+clone.actionToken));
  assert.equal(clone.invite.description.includes(original.actionToken),false,'clone never inherits original parent action');
  const parentMail=(await outbox(f.email)).find(mail=>mail.subject==='Booking confirmed: Dog walk'&&mail.ics.includes(clone.invite.uid));
  assert.ok(parentMail);
  const parentEvent=new ICAL.Component(ICAL.parse(parentMail.ics)).getFirstSubcomponent('vevent');
  const description=parentEvent.getFirstPropertyValue('description');
  for(const detail of details)assert.ok(description.includes(detail),'delivered parent calendar retains '+detail);
  for(const visit of visits){
    const page=await call('GET','/api/job/'+visit.actionToken);assert.equal(page.status,200);
    assert.match(page.body,/Keep the small dog separate &amp; close &lt;gate&gt;/);
    assert.match(page.body,/Pet names: Fido &amp; Spot/);assert.match(page.body,/Use side gate code TEST9876/);
    const customerPage=await call('GET','/api/booking/'+visit.cancelToken);
    const customerIcs=await call('GET','/api/booking/'+visit.cancelToken+'/calendar.ics');
    for(const detail of [...details,visit.actionToken]){
      assert.equal(customerPage.body.includes(detail),false,'customer page excludes '+detail);
      assert.equal(customerIcs.body.includes(detail),false,'customer calendar excludes '+detail);
    }
  }
  const child=await call('GET','/api/my-jobs?code='+f.code);assert.equal(child.status,200);
  for(const detail of [...details,...visits.map(visit=>visit.actionToken)])assert.equal(child.body.includes(detail),false,'kid code excludes '+detail);
});

test('repeated and concurrent approval are idempotent without extra rows, events or email',async()=>{
  const f=await family(),original=await book(f,{freq:'Every other week'});
  const results=await Promise.all([approve(original,3),approve(original,3),approve(original,3)]);
  assert.ok(results.every(r=>r.status===200),results.map(r=>r.status).join(','));
  const snapshot=await rows(f),events=await feed(f),parentCount=(await outbox(f.email)).length,customerCount=(await outbox('repeat-customer@example.com')).length;
  assert.equal(snapshot.length,3);assert.deepEqual(snapshot.map(r=>r.invite.start),['2026-12-02T16:00','2026-12-16T16:00','2026-12-30T16:00']);
  assert.equal((await approve(original,8)).status,200,'a retry cannot replace an approved schedule with a larger count');
  assert.deepEqual(await rows(f),snapshot);assert.deepEqual(await feed(f),events);
  assert.equal((await outbox(f.email)).length,parentCount);assert.equal((await outbox('repeat-customer@example.com')).length,customerCount);
});

test('invalid count and invalid generated dates reject the entire proposal without side effects',async()=>{
  const f=await family(),original=await book(f);
  for(const count of [undefined,null,0,1,9,2.5,'bad']){
    const snapshot=await rows(f),events=await feed(f),mails=(await outbox(f.email)).length;
    const result=await act(original,'approve-series',{start:original.invite.start,...(count===undefined?{}:{count})});
    assert.equal(result.status,400,String(count));assert.deepEqual(await rows(f),snapshot);assert.deepEqual(await feed(f),events);
    assert.equal((await outbox(f.email)).length,mails);
  }
  const invalid=[
    {freq:"While I'm away",awayFrom:'2026-12-03',awayTo:'2026-12-06'},
    {freq:"While I'm away",awayFrom:'2026-12-02',awayTo:'2026-12-17'},
    {freq:"While I'm away",awayFrom:'2026-12-02',awayTo:'2026-02-31'},
    {freq:'Every week',start:'2027-03-07T02:30',when:'March 7 at 2:30 AM'},
    {freq:'Every week',start:'2027-03-16T16:00',when:'March 16 at 4 PM'}
  ];
  for(const [i,extra] of invalid.entries()){
    const r=await book(f,{...extra,service:'Cleanup option '+i}),snapshot=await rows(f),events=await feed(f),mails=(await outbox(f.email)).length;
    const result=await approve(r,2);assert.equal(result.status,400,JSON.stringify(extra));
    assert.deepEqual(await rows(f),snapshot);assert.deepEqual(await feed(f),events);assert.equal((await outbox(f.email)).length,mails);
  }
});

test('stale first time, pending reschedule, finished bookings and vague preferences cannot expand a schedule',async()=>{
  const f=await family(),original=await book(f),snapshot=await rows(f);
  assert.equal((await approve(original,3,{start:'2026-12-03T16:00'})).status,409);
  assert.deepEqual(await rows(f),snapshot);
  assert.equal((await call('POST','/api/booking/'+original.cancelToken,{body:{action:'reschedule',start:'2026-12-06T14:00'}})).status,200);
  assert.equal((await approve(original,3)).status,409);
  assert.equal((await rows(f)).length,1);assert.equal((await row(f,original.id)).status,'new');
  const pending=await row(f,original.id);assert.equal(pending.reschedule.start,'2026-12-06T14:00');
  for(const freq of ['Every snowfall this winter','A few days a week','Every day','Weekdays']){
    const r=await book(f,{service:'Preference '+freq,freq});assert.equal((await approve(r,3)).status,409,freq);
    assert.ok(!(await row(f,r.id)).series);
  }
  for(const status of ['done','cancelled']){
    const r=await book(f,{service:'Finished '+status});assert.equal((await act(r,status)).status,200);
    assert.equal((await approve(r,3)).status,409);assert.equal((await row(f,r.id)).status,status);
  }
});

test('My jobs exposes approval only to the parent and exposes safe series labels to kids',async()=>{
  const f=await family(),original=await book(f);
  const parent=await json(await call('GET','/api/my-jobs',{token:f.token}));
  const managed=parent.body.jobs.find(j=>j.id===original.id);
  assert.deepEqual(managed.recurrence,{kind:'weekly',label:'Weekly visits',maxCount:8,defaultCount:4,requiresCount:true,start:original.invite.start});
  const kid=await json(await call('GET','/api/my-jobs?code='+f.code));assert.equal(kid.status,200);
  assert.equal(kid.body.jobs.find(j=>j.id===original.id).recurrence,undefined);
  assert.equal((await approve(original,3)).status,200);
  const approved=await row(f,original.id),visits=await series(f,approved);
  const parentAfter=await json(await call('GET','/api/my-jobs',{token:f.token}));
  const childAfter=await json(await call('GET','/api/my-jobs?code='+f.code));
  for(const visit of visits){
    const child=childAfter.body.jobs.find(j=>j.id===visit.id),p=parentAfter.body.jobs.find(j=>j.id===visit.id);
    assert.deepEqual(child.series,{index:visit.series.index,total:3,kind:'weekly'});
    assert.equal(child.series.id,undefined);assert.equal(child.action,undefined);assert.equal(child.recurrence,undefined);assert.equal(p.recurrence,undefined);
  }
  assert.equal(JSON.stringify(childAfter.body).includes(approved.series.id),false);
});

test('parent can cancel the remaining series from a completed visit without changing completed, cancelled or sibling bookings',async()=>{
  const f=await family(),original=await book(f);assert.equal((await approve(original,4)).status,200);
  const visits=await series(f,await row(f,original.id));
  await publish(f,'riley-repeat','Riley','Riley Pet Care');
  const sibling=await book({...f,slug:'riley-repeat'},{service:'Dog walk',freq:'Just this visit',contact:'sibling-customer@example.com'});
  assert.equal((await act(visits[0],'done')).status,200);assert.equal((await act(visits[1],'cancelled')).status,200);
  const done=await row(f,visits[0].id),cancelled=await row(f,visits[1].id),siblingBefore=await row(f,sibling.id),parentCount=(await outbox(f.email)).length,customerCount=(await outbox('repeat-customer@example.com')).length;
  const response=await act(done,'cancel-series');assert.equal(response.status,200);
  assert.deepEqual(await row(f,done.id),done);assert.deepEqual(await row(f,cancelled.id),cancelled);assert.deepEqual(await row(f,sibling.id),siblingBefore);
  for(const visit of visits.slice(2)){const current=await row(f,visit.id);assert.equal(current.status,'cancelled');assert.equal(current.cancelledBy,'family');}
  const events=await feed(f);assert.ok(events.some(e=>e.uid===sibling.invite.uid));
  assert.ok(events.every(e=>!visits.slice(1).some(v=>v.invite.uid===e.uid)));
  assert.equal((await outbox(f.email)).length,parentCount+2);assert.equal((await outbox('repeat-customer@example.com')).length,customerCount+2);
  assert.equal((await act(cancelled,'cancel-series')).status,200,'cancelled visit still manages remaining schedule');
  assert.equal((await outbox(f.email)).length,parentCount+2);assert.equal((await outbox('repeat-customer@example.com')).length,customerCount+2);
});

test('customer cancellation of the remaining schedule preserves completed and sibling appointments and sends per-visit calendar cancellations once',async()=>{
  const f=await family(),original=await book(f);assert.equal((await approve(original,4)).status,200);
  const visits=await series(f,await row(f,original.id)),sibling=await book(f,{service:'Separate one-off work',freq:'Just this time',contact:'other-customer@example.com'});
  assert.equal((await act(visits[0],'done')).status,200);assert.equal((await act(visits[1],'cancelled')).status,200);
  const done=await row(f,visits[0].id),cancelled=await row(f,visits[1].id),siblingBefore=await row(f,sibling.id),parentCount=(await outbox(f.email)).length,customerCount=(await outbox('repeat-customer@example.com')).length;
  const response=await call('POST','/api/booking/'+cancelled.cancelToken,{body:{action:'cancel-series'}});assert.equal(response.status,200);
  assert.deepEqual(await row(f,done.id),done);assert.deepEqual(await row(f,cancelled.id),cancelled);assert.deepEqual(await row(f,sibling.id),siblingBefore);
  for(const visit of visits.slice(2)){const current=await row(f,visit.id);assert.equal(current.status,'cancelled');assert.equal(current.cancelledBy,'customer');}
  const customerMail=await outbox('repeat-customer@example.com');
  assert.equal((await outbox(f.email)).length,parentCount+2);assert.equal(customerMail.length,customerCount+2);
  const cancellations=customerMail.slice(customerCount);assert.equal(cancellations.length,2);
  assert.deepEqual(cancellations.map(m=>parseCalendar(m.ics).events[0].uid).sort(),visits.slice(2).map(v=>v.invite.uid).sort());
  for(const notice of cancellations){
    const parsed=parseCalendar(notice.ics),event=parsed.events[0],before=visits.find(v=>v.invite.uid===event.uid);
    assert.equal(parsed.method,'CANCEL');assert.equal(event.status,'CANCELLED');assert.ok(event.sequence>before.invite.sequence);
    for(const visit of visits)assert.equal(notice.ics.includes(visit.actionToken),false);
  }
  assert.equal((await call('POST','/api/booking/'+done.cancelToken,{body:{action:'cancel-series'}})).status,200,'completed visit can manage remaining schedule');
  assert.equal((await outbox(f.email)).length,parentCount+2);assert.equal((await outbox('repeat-customer@example.com')).length,customerCount+2);
  assert.ok((await feed(f)).some(e=>e.uid===sibling.invite.uid));
});

test('cancel remaining excludes past visits and rejects one-off requests',async ctx=>{
  const f=await family(),original=await book(f,{start:'2026-11-23T09:00',when:'November 23 at 9 AM'});
  assert.equal((await approve(original,3)).status,200);const visits=await series(f,await row(f,original.id));
  const oneOff=await book(f,{service:'One-off cleanup',freq:'Just this time'});
  assert.equal((await act(oneOff,'cancel-series')).status,409);
  assert.equal((await call('POST','/api/booking/'+oneOff.cancelToken,{body:{action:'cancel-series'}})).status,409);
  ctx.mock.timers.tick(Date.parse('2026-11-24T18:00:00Z')-Date.now());
  const first=await row(f,visits[0].id);assert.equal((await act(first,'cancel-series')).status,200);
  assert.deepEqual(await row(f,first.id),first,'a past uncompleted appointment is left for the family to resolve individually');
  assert.ok((await rows(f)).filter(r=>r.series?.id===first.series.id&&r.id!==first.id).every(r=>r.status==='cancelled'));
  assert.equal((await row(f,oneOff.id)).status,'new');
});

test('held requests, an expired trial or plan, and a full calendar cannot add repeating visits',async()=>{
  const f=await family(),original=await book(f),accountKey='accounts/'+f.id+'.json',originalAccount=await read(accountKey);
  const snapshot=await rows(f),parentCount=(await outbox(f.email)).length,customerCount=(await outbox('repeat-customer@example.com')).length;
  await write('requests/'+f.id+'.json',snapshot.map(r=>({...r,status:'held'})));
  assert.equal((await approve(original,3)).status,409);
  assert.equal((await rows(f))[0].status,'held');assert.equal((await rows(f)).length,1);
  await write('requests/'+f.id+'.json',snapshot);
  for(const expired of [
    {...originalAccount,paidUntil:null,trialEndsAt:'2026-11-21T18:00:00Z'},
    {...originalAccount,paidUntil:'2026-11-01T18:00:00Z'}
  ]){
    await write(accountKey,expired);
    const response=await json(await approve(original,3));assert.equal(response.status,409);assert.equal(response.body.error,'plan');
    assert.deepEqual(await rows(f),snapshot);
  }
  await write(accountKey,originalAccount);
  const jobsKey='caljobs/'+f.id+'.json',originalJobs=await read(jobsKey);
  await write(jobsKey,[...originalJobs,...Array.from({length:199},(_,i)=>({id:'device-'+i,source:'device',start:'2026-12-10T15:00',service:'Existing job',createdAt:new Date().toISOString()}))]);
  const response=await json(await approve(original,2));assert.equal(response.status,409);assert.equal(response.body.error,'capacity');
  assert.deepEqual(await rows(f),snapshot);assert.equal((await read(jobsKey)).length,200);
  assert.equal((await outbox(f.email)).length,parentCount);assert.equal((await outbox('repeat-customer@example.com')).length,customerCount);
});

test('a customer cannot approve repeats and moving or cancelling one approved clone leaves the other visits intact',async()=>{
  const f=await family(),original=await book(f),before=await rows(f);
  const forbidden=await call('POST','/api/booking/'+original.cancelToken,{body:{action:'approve-series',count:4,start:original.invite.start}});
  assert.equal(forbidden.status,400);assert.deepEqual(await rows(f),before);
  assert.equal((await approve(original,4)).status,200);
  const visits=await series(f,await row(f,original.id)),clone=visits[1],target='2026-12-10T14:30',beforeEvents=await feed(f);
  const rescheduled=await call('POST','/api/booking/'+clone.cancelToken,{body:{action:'reschedule',start:target}});assert.equal(rescheduled.status,200);
  assert.equal((await row(f,clone.id)).invite.start,clone.invite.start,'proposal waits for parent approval');
  assert.equal((await act(clone,'accept-reschedule',{start:target})).status,200);
  const moved=await row(f,clone.id);assert.equal(moved.invite.start,target);assert.equal(moved.invite.uid,clone.invite.uid);assert.deepEqual(moved.series,clone.series);
  for(const visit of visits.filter(v=>v.id!==clone.id))assert.deepEqual(await row(f,visit.id),visit);
  const afterEvents=await feed(f);assert.equal(afterEvents.length,4);
  assert.equal(afterEvents.find(e=>e.uid===clone.invite.uid).start,target+':00');
  for(const event of beforeEvents.filter(e=>e.uid!==clone.invite.uid))assert.deepEqual(afterEvents.find(e=>e.uid===event.uid),event);
  const latest=(await outbox('repeat-customer@example.com')).at(-1),invitation=parseCalendar(latest.ics);
  assert.equal(invitation.method,'REQUEST');assert.equal(invitation.events[0].uid,clone.invite.uid);assert.ok(invitation.events[0].sequence>clone.invite.sequence);
  assert.equal((await call('POST','/api/booking/'+clone.cancelToken,{body:{action:'cancel'}})).status,200);
  assert.equal((await row(f,clone.id)).status,'cancelled');
  for(const visit of visits.filter(v=>v.id!==clone.id))assert.deepEqual(await row(f,visit.id),visit);
  assert.equal((await feed(f)).length,3);
});

test('a failed series commit rolls back all visits, capabilities, calendar entries and queued notifications before a safe retry',async ctx=>{
  const f=await family(),original=await book(f),backing=await store();
  const snapshot=Object.fromEntries(await Promise.all((await backing.list('')).map(async key=>[key,await backing.get(key)])));
  const put=backing.put;let armed=true;
  backing.put=async(key,value)=>{
    if(armed&&key.startsWith('events/')&&key!=='events/'+original.eventToken+'.json'){armed=false;throw new Error('injected series commit failure');}
    return put(key,value);
  };
  ctx.mock.method(console,'error',()=>{});
  try{assert.equal((await approve(original,4)).status,503);}finally{backing.put=put;}
  assert.equal(armed,false,'failure was injected after transaction work and before its commit finished');
  const after=Object.fromEntries(await Promise.all((await backing.list('')).map(async key=>[key,await backing.get(key)])));
  assert.deepEqual(after,snapshot,'failed operation leaves neither partial series nor mail ready to send');
  assert.equal((await approve(original,4)).status,200);assert.equal((await rows(f)).length,4);assert.equal((await feed(f)).length,4);
  assert.equal((await outbox('repeat-customer@example.com')).filter(m=>m.subject==='Your booking is confirmed').length,4);
});
