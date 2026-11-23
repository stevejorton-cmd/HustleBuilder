import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {fileStore,setStore,store} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';
import {parseQuote,agreedPrice,quoteAccepted} from '../host/lib/neighbor.mjs';
import {withParentInquiry} from '../host/lib/preview.mjs';

const base='http://sites.test',sha=s=>createHash('sha256').update(s).digest('hex'),id=()=>randomBytes(16).toString('hex');
let dir,ip=0;
test.beforeEach(async ctx=>{
  ctx.mock.timers.enable({apis:['Date'],now:new Date('2026-11-22T18:00:00Z')});
  dir=await mkdtemp(path.join(tmpdir(),'hb-neighbor-'));setStore(fileStore(dir));ip=0;
  process.env.PUBLISH_TEST_MODE='1';process.env.PAYWALL_MODE='test';process.env.PUBLIC_ORIGIN=base;
});
test.afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
function call(method,url,{body,token,ip:address,form=false}={}){
  return handleRequest({method,path:url,origin:base,query:new URL(base+url).searchParams,headers:{origin:base,authorization:token?'Bearer '+token:'','x-forwarded-for':address||'203.0.113.'+(++ip)},body:body?(form?new URLSearchParams(body).toString():JSON.stringify(body)):''});
}
const json=res=>({status:res.status,body:JSON.parse(res.body||'{}')});
async function read(key){return JSON.parse(await (await store()).get(key)||'null');}
async function write(key,value){await (await store()).put(key,JSON.stringify(value));}
async function outbox(email){return json(await call('GET','/api/test/outbox?email='+encodeURIComponent(email))).body.messages;}
async function family(email='parent-neighbor@example.com',slug='sam-neighbor'){
  const a=json(await call('POST','/api/auth/start',{body:{email}}));assert.equal(a.status,200);
  const v=json(await call('POST','/api/auth/verify',{body:{email,code:a.body.devCode}})),token=v.body.token;
  assert.equal((await call('POST','/api/consent',{token,body:{consent:true}})).status,200);
  assert.equal((await call('POST','/api/checkout',{token,body:{plan:'season'}})).status,200);
  const html='<!doctype html><html><head><title>Sam Yard</title></head><body><!-- hb-public --><h1>Sam Yard</h1><section id="book"></section><script>window.__C={"first":"Sam","biz":"Sam Yard"};</script></body></html>';
  const pub=json(await call('POST','/api/publish',{token,body:{slug,html,venmo:'ParentYard'}}));assert.equal(pub.status,200,JSON.stringify(pub.body));
  const accountId=(await (await store()).get('tokens/'+sha(token))).trim();
  return {id:accountId,email,token,slug,code:pub.body.jobCode};
}
async function book(f,extras={}){
  const response=json(await call('POST','/api/book',{body:{slug:f.slug,name:'Casey Neighbor',contact:'customer-neighbor@example.com',service:'Leaf cleanup',start:'2026-12-02T16:00',when:'December 2 at 4 PM',address:'123 Private Lane',note:'Front yard only',access:'secret gate code 9876',price:'9',t:5000,...extras}}));
  assert.equal(response.status,200,JSON.stringify(response.body));
  const row=(await read('requests/'+f.id+'.json')).at(-1);assert.equal(response.body.manageUrl,base+'/api/booking/'+row.cancelToken);return row;
}
async function current(f,r){return (await read('requests/'+f.id+'.json')).find(x=>x.id===r.id);}
const parent=(r,body)=>call('POST','/api/job/'+r.actionToken,{body:{...body,json:true}});
const customer=(r,body)=>call('POST','/api/booking/'+r.cancelToken,{body:{...body,json:true}});
const quote=(extras={})=>({action:'send-quote',baseRevision:0,requestId:id(),scope:'Rake the front yard and bag the leaves.',equipment:'Family brings rake and gloves. Customer supplies leaf bags.',exclusions:'No gutters or work on ladders.',items:[{description:'Rake and bag leaves',amount:'20.10'},{description:'Bag pickup',amount:'2.25'}],...extras});
async function inquiry(f,extras={},options={}){
  const response=json(await call('POST','/api/inquiry/'+f.slug,{body:{json:true,requestId:id(),name:'Casey',email:'question-neighbor@example.com',text:'Do you bring the rake?',t:5000,...extras},...options}));
  assert.equal(response.status,200,JSON.stringify(response.body));
  return {response,row:(await read('requests/'+f.id+'.json')).find(row=>row.id===response.body.id)};
}

test('quote totals use exact cents, complete scope, and bounded itemized amounts',()=>{
  const q=parseQuote(quote());assert.equal(q.totalCents,2235);assert.deepEqual(q.items.map(x=>x.amountCents),[2010,225]);
  for(const bad of ['-1','1e2','1.001','1000','NaN','$20','20,00'])assert.ok(parseQuote(quote({items:[{description:'Work',amount:bad}]})).error,bad);
  for(const changes of [{items:[]},{items:Array(9).fill({description:'Work',amount:'1'})},{equipment:''},{scope:'x'.repeat(701)},{items:[{description:'Work',amount:'700'},{description:'Work',amount:'300'}]}])assert.ok(parseQuote(quote(changes)).error);
  assert.equal(parseQuote({scope:'Sweep',equipment:'Family brings broom',itemDescription0:'Sweep',itemAmount0:'0.10',itemDescription1:'Bag',itemAmount1:'0.20'}).totalCents,30);
  assert.equal(agreedPrice({fields:{price:'9'}}),'9');
  assert.equal(agreedPrice({quote:{revision:2,acceptedRevision:1,acceptedAt:'today',totalCents:2235},fields:{price:'9'}}),'');
});

test('customer accepts the itemized quote before confirmation or completion; agreed total is used in payment notice',async()=>{
  const f=await family(),r=await book(f),send=quote();
  assert.equal((await parent(r,send)).status,200);
  const pending=await current(f,r);assert.equal(pending.quote.totalCents,2235);assert.equal(quoteAccepted(pending),false);
  for(const status of ['confirmed','done','approve-series'])assert.equal((await parent(r,{status,count:3,start:r.invite.start})).status,409,status);
  assert.equal((await customer(r,{action:'accept-quote',revision:1})).status,400);
  const page=await call('GET','/api/booking/'+r.cancelToken);
  for(const text of ['Rake the front yard','Customer supplies leaf bags','No gutters','$22.35','revision 1'])assert.ok(page.body.includes(text),text);
  assert.match(page.body,/name="accept" value="yes" required/);
  const legacy=await call('GET','/api/cancel/'+r.cancelToken);
  assert.ok(legacy.body.includes('<form method="post" action="/api/booking/'+r.cancelToken+'"><input type="hidden" name="action" value="accept-quote">'),'legacy cancel links post quote acceptance to the booking route');
  assert.equal((await call('POST','/api/cancel/'+r.cancelToken,{body:{action:'accept-quote',revision:1,accept:'yes'}})).status,400,'misdirected quote acceptance cannot cancel a booking');
  assert.equal((await current(f,r)).status,'new');
  for(const secret of [f.email,r.actionToken,'secret gate code','9876'])assert.equal(page.body.includes(secret),false,secret);
  assert.equal((await customer(r,{action:'accept-quote',revision:1,accept:'yes'})).status,200);
  assert.equal((await current(f,r)).status,'new','price acceptance does not confirm appointment');
  assert.equal((await parent(r,{status:'confirmed'})).status,200);
  assert.equal((await parent(r,{status:'done'})).status,200);
  const mail=(await outbox('customer-neighbor@example.com')).find(m=>/finished|done/i.test(m.subject));assert.ok(mail);
  assert.match(mail.text,/\$22\.35/);assert.match(mail.text,/amount=22\.35/);assert.doesNotMatch(mail.text,/amount=9(?:\D|$)/);
  const jobs=json(await call('GET','/api/my-jobs',{token:f.token})).body.jobs;
  assert.equal(jobs[0].price,'22.35');assert.equal(jobs[0].quoteStatus,'accepted');assert.equal(jobs[0].quoteRevision,1);assert.equal(jobs[0].detailsUrl,base+'/api/job/'+r.actionToken);
  const before=(await outbox(f.email)).length;
  assert.equal((await parent(r,{status:'done'})).status,200);assert.equal((await outbox(f.email)).length,before);
  assert.equal((await parent(r,quote({baseRevision:1}))).status,409,'no new charges after completion');
});

test('quote retries and concurrent revisions are idempotent; stale acceptance never authorizes a new price',async()=>{
  const f=await family(),r=await book(f),send=quote();
  const before=(await outbox('customer-neighbor@example.com')).length;
  const sent=await Promise.all([parent(r,send),parent(r,send)]);assert.deepEqual(sent.map(x=>x.status),[200,200]);
  assert.equal((await outbox('customer-neighbor@example.com')).length,before+1);
  assert.equal((await parent(r,{...send,scope:'Changed without new request'})).status,409);
  assert.equal((await customer(r,{action:'accept-quote',revision:1,accept:'yes'})).status,200);
  const acceptedMail=(await outbox(f.email)).length;
  assert.equal((await customer(r,{action:'accept-quote',revision:1,accept:'yes'})).status,200);assert.equal((await outbox(f.email)).length,acceptedMail);
  assert.equal((await parent(r,{status:'confirmed'})).status,200);
  const attempts=await Promise.all([parent(r,quote({baseRevision:1,items:[{description:'Work',amount:'30'}]})),parent(r,quote({baseRevision:1,items:[{description:'Work',amount:'40'}]}))]);
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  let changed=await current(f,r);assert.equal(changed.quote.revision,2);assert.equal(changed.quote.acceptedAt,null);assert.equal(changed.previousAcceptedQuote.totalCents,2235);assert.equal(changed.status,'confirmed');
  assert.equal((await customer(r,{action:'accept-quote',revision:1,accept:'yes'})).status,409);
  assert.equal((await parent(r,{status:'done'})).status,409);
  assert.equal((await customer(r,{action:'reschedule',start:'2026-12-05T10:00'})).status,200);
  assert.equal((await parent(r,{status:'accept-reschedule',start:'2026-12-05T10:00'})).status,409,'reschedule cannot bypass outstanding agreement');
  assert.equal((await customer(r,{action:'accept-quote',revision:2,accept:'yes'})).status,200);
  assert.equal((await parent(r,{status:'accept-reschedule',start:'2026-12-05T10:00'})).status,200);
  changed=await current(f,r);assert.equal(changed.quote.acceptedRevision,2);assert.equal(changed.invite.start,'2026-12-05T10:00');
});

test('approved recurring visits each retain the accepted per-visit quote and remain independently manageable',async()=>{
  const f=await family(),r=await book(f,{freq:'Every week'}),sibling=await book(f,{service:'Dog walk',contact:'sibling-neighbor@example.com',start:'2026-12-03T16:00'});
  await parent(r,quote());assert.equal((await parent(r,{status:'approve-series',count:3,start:r.invite.start})).status,409);
  await customer(r,{action:'accept-quote',revision:1,accept:'yes'});
  const approved=await parent(r,{status:'approve-series',count:3,start:r.invite.start});assert.equal(approved.status,200,approved.body);
  const visits=(await read('requests/'+f.id+'.json')).filter(x=>x.series);assert.equal(visits.length,3);
  for(const visit of visits){assert.equal(quoteAccepted(visit),true);assert.equal(agreedPrice(visit),'22.35');}
  assert.equal((await parent(visits[1],quote({baseRevision:1,scope:'Second visit includes side yard'}))).status,200);
  assert.equal(quoteAccepted(await current(f,visits[0])),true);assert.equal(quoteAccepted(await current(f,visits[2])),true);
  assert.equal((await customer(visits[1],{action:'cancel'})).status,200);
  assert.equal((await parent(visits[1],quote({baseRevision:2}))).status,409);
  assert.equal((await current(f,sibling)).status,'new');assert.equal((await current(f,sibling)).quote,undefined);
});

test('legacy bookings and phone-only requests keep their existing confirmation and completion flow',async()=>{
  const f=await family(),r=await book(f,{contact:'402-555-0100'});
  const page=await call('GET','/api/job/'+r.actionToken);
  assert.doesNotMatch(page.body,/value="send-quote"/,'phone-only requests do not offer an unusable quote form');
  assert.match(page.body,/Online quote acceptance needs a customer email address/);
  assert.match(page.body,/value="confirmed">Confirm booking/);assert.match(page.body,/value="done">Mark done/);
  assert.equal((await parent(r,quote())).status,409,'online agreement requires an email customer');
  assert.equal((await parent(r,{status:'confirmed'})).status,200);assert.equal((await parent(r,{status:'done'})).status,200);
  assert.equal((await current(f,r)).status,'done');assert.equal(agreedPrice(await current(f,r)),'9');
});

test('simultaneous completion and price revision cannot charge an unaccepted amount',async()=>{
  const f=await family(),r=await book(f);await parent(r,quote());await customer(r,{action:'accept-quote',revision:1,accept:'yes'});
  const responses=await Promise.all([parent(r,{status:'done'}),parent(r,quote({baseRevision:1,items:[{description:'Changed work',amount:'90'}]}))]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const saved=await current(f,r),done=(await outbox('customer-neighbor@example.com')).filter(message=>/finished|done/i.test(message.subject));
  if(saved.status==='done'){assert.equal(saved.quote.revision,1);assert.equal(done.length,1);assert.match(done[0].text,/amount=22\.35/);}
  else{assert.equal(saved.status,'new');assert.equal(saved.quote.revision,2);assert.equal(quoteAccepted(saved),false);assert.equal(done.length,0);}
});

test('private booking questions and parent replies remain scoped, escaped, bounded, and deduplicated',async()=>{
  const f=await family(),r=await book(f),other=await book(f,{contact:'other-neighbor@example.com'});
  const question={action:'question',requestId:id(),text:'Is <img src=x onerror="alert(1)"> included?'};
  const before=(await outbox(f.email)).length;
  assert.deepEqual((await Promise.all([customer(r,question),customer(r,question)])).map(x=>x.status),[200,200]);
  assert.equal((await outbox(f.email)).length,before+1);
  const list=json(await call('GET','/api/my-jobs',{token:f.token})).body.jobs.find(j=>j.id===r.id);assert.equal(list.unreadMessages,1);assert.equal(JSON.stringify(list).includes('onerror'),false);
  const parentPage=await call('GET','/api/job/'+r.actionToken);assert.match(parentPage.body,/&lt;img/);assert.doesNotMatch(parentPage.body,/<img src=x/);
  assert.equal(json(await call('GET','/api/my-jobs',{token:f.token})).body.jobs.find(j=>j.id===r.id).unreadMessages,0);
  const answer={action:'reply',requestId:id(),text:'We bring the rake; please provide bags.'};
  assert.equal((await parent(r,answer)).status,200);const mailed=(await outbox('customer-neighbor@example.com')).length;
  assert.equal((await parent(r,answer)).status,200);assert.equal((await outbox('customer-neighbor@example.com')).length,mailed);
  assert.match((await call('GET','/api/booking/'+r.cancelToken)).body,/please provide bags/);
  assert.doesNotMatch((await call('GET','/api/booking/'+other.cancelToken)).body,/please provide bags|onerror/);
  assert.equal((await customer(r,{...answer})).status,400,'customer cannot use the parent action');
  assert.equal((await customer(r,{...question,text:'Different payload'})).status,409);
  assert.equal((await customer(r,{action:'question',requestId:id(),text:'x'.repeat(1201)})).status,400);
  const kid=json(await call('GET','/api/my-jobs?code='+f.code)).body;
  for(const secret of [r.actionToken,r.cancelToken,'onerror','please provide bags'])assert.equal(JSON.stringify(kid).includes(secret),false,secret);
  assert.notEqual((await call('POST','/api/job/'+r.cancelToken,{body:{...answer,json:true}})).status,200,'customer token has no parent authority');
});

test('mixed-case private routes acquire the same account and thread locks and preserve cancellation guards',async()=>{
  const f=await family(),r=await book(f),baseStore=await store(),lockSets=[];
  // Inspect the actual transaction options. The default file-store adapter's
  // global queue would hide missing per-account locks used by PostgreSQL.
  setStore({...baseStore,async transaction(fn,options){lockSets.push(options.keys);return fn(baseStore);}});
  const locked=async(method,route,body,{thread=true}={})=>{
    const index=lockSets.length,response=await call(method,route,{body:body?{...body,json:true}:undefined});
    assert.ok(lockSets[index].includes('account:'+f.id),route+' acquires the capability owner account lock');
    if(thread)assert.ok(lockSets[index].some(key=>key.startsWith('quota:thread:')),route+' acquires the thread IP quota lock');
    return response;
  };
  assert.equal((await locked('POST','/api/JoB/'+r.actionToken,quote())).status,200);
  assert.equal((await locked('POST','/api/BoOkInG/'+r.cancelToken,{action:'question',requestId:id(),text:'Are bags included?'})).status,200);
  assert.equal((await current(f,r)).thread.at(-1).author,'customer');
  assert.equal((await locked('POST','/api/BOOKING/'+r.cancelToken,{action:'accept-quote',revision:1,accept:'yes'})).status,200);
  assert.equal(quoteAccepted(await current(f,r)),true);
  assert.equal((await locked('POST','/api/JOB/'+r.actionToken,{action:'reply',requestId:id(),text:'Please provide the bags.'})).status,200);
  assert.equal((await locked('GET','/api/BoOkInG/'+r.cancelToken)).status,200);
  assert.equal((await locked('POST','/api/CANCEL/'+r.cancelToken,{action:'accept-quote',revision:1,accept:'yes'},{thread:false})).status,400);
  assert.equal((await current(f,r)).status,'new','a misplaced quote action cannot become cancellation');
  assert.equal((await locked('POST','/api/CaNcEl/'+r.cancelToken,{},{thread:false})).status,200);
  assert.equal((await current(f,r)).status,'cancelled','legacy cancellation remains usable with an accepted mixed-case route');
});

test('Ask the parent is available on existing published pages and creates only a private conversation',async()=>{
  const f=await family();
  const page=await call('GET','/api/site/'+f.slug);assert.match(page.body,/href="\/api\/inquiry\/sam-neighbor" target="_top"/);
  assert.equal((withParentInquiry(withParentInquiry('<body></body>',f.slug),f.slug).match(/id="hb-parent-inquiry"/g)||[]).length,1);
  const form=await call('GET','/api/inquiry/'+f.slug);assert.match(form.body,/name="email"/);assert.match(form.body,/does not create a job/);assert.doesNotMatch(form.body,/name="address"|name="start"/);
  assert.equal(form.body.includes(f.email),false);
  const {row:r,response}=await inquiry(f);assert.equal(response.body.manageUrl,base+'/api/booking/'+r.cancelToken);
  assert.equal(r.kind,'inquiry');assert.equal(r.invite,undefined);assert.equal(r.calendarJobId,undefined);assert.equal(await read('jobs/'+f.id+'.json'),null);
  for(const status of ['confirmed','done','approve-series','cancelled'])assert.equal((await parent(r,{status})).status,409,status);
  for(const action of ['reschedule','cancel','cancel-series','accept-quote'])assert.equal((await customer(r,{action,start:'2026-12-05T10:00',revision:1,accept:'yes'})).status,409,action);
  assert.equal((await parent(r,quote())).status,409);
  const kid=json(await call('GET','/api/my-jobs?code='+f.code)).body;assert.equal(kid.jobs.length,0);
  const list=json(await call('GET','/api/my-jobs',{token:f.token})).body.jobs;assert.equal(list.length,1);assert.equal(list[0].inquiry,true);assert.equal(list[0].unreadMessages,1);
  assert.equal((await parent(r,{action:'reply',requestId:id(),text:'Yes, our family brings the rake.'})).status,200);
  const conversation=await call('GET','/api/booking/'+r.cancelToken);assert.match(conversation.body,/family brings the rake/);assert.match(conversation.body,/No calendar appointment/);
  for(const secret of [f.email,r.actionToken,f.code])assert.equal(conversation.body.includes(secret),false,secret);
  assert.equal((await parent(r,{action:'close-inquiry'})).status,200);assert.equal((await current(f,r)).status,'closed');
  assert.equal((await customer(r,{action:'question',requestId:id(),text:'Another question'})).status,409);
  const gear=json(await call('GET','/api/gear',{token:f.token})).body;assert.equal(gear.businesses[0].completedJobs,0);
});

test('thread roles come from the private route and per-day and total limits bound notifications',async()=>{
  const f=await family(),r=await book(f);
  for(let i=0;i<10;i++)assert.equal((await customer(r,{action:'question',requestId:id(),author:'parent',text:'Question '+i})).status,200);
  assert.equal((await customer(r,{action:'question',requestId:id(),text:'Over daily limit'})).status,429);
  let saved=await current(f,r);assert.equal(saved.thread.length,10);assert.ok(saved.thread.every(message=>message.author==='customer'));
  assert.equal((await parent(r,{action:'reply',requestId:id(),text:'Parent can still reply.'})).status,200);
  saved=await current(f,r);saved.thread=Array.from({length:40},(_,i)=>({id:id(),author:'customer',text:'Retained '+i,at:new Date().toISOString()}));
  const rows=await read('requests/'+f.id+'.json');rows[rows.findIndex(row=>row.id===r.id)]=saved;await write('requests/'+f.id+'.json',rows);
  assert.equal((await parent(r,{action:'reply',requestId:id(),text:'Over total limit'})).status,409);
  assert.match((await call('GET','/api/booking/'+r.cancelToken)).body,/40-message limit/);
});

test('public inquiry enforces timing, honeypot, size, email, quotas, and concurrency-safe retry dedupe',async()=>{
  const f=await family(),url='/api/inquiry/'+f.slug;
  const body={json:true,requestId:id(),name:'Casey',email:'ask-rate@example.com',text:'Do you bring supplies?',t:5000};
  for(const changes of [{t:0},{email:'not-an-email'},{text:'x'.repeat(1201)},{requestId:'short'},{name:'x'.repeat(61)}])assert.equal((await call('POST',url,{body:{...body,...changes}})).status,400);
  assert.equal((await call('POST',url,{body:{...body,company:'robot'}})).status,200);assert.equal(await read('requests/'+f.id+'.json'),null);
  const before=(await outbox(f.email)).length;
  const repeated=await Promise.all([call('POST',url,{body}),call('POST',url,{body})]);assert.deepEqual(repeated.map(x=>x.status),[200,200]);assert.equal(json(repeated[0]).body.manageUrl,json(repeated[1]).body.manageUrl);
  assert.equal((await read('requests/'+f.id+'.json')).length,1);assert.equal((await outbox(f.email)).length,before+1);
  assert.equal((await call('POST',url,{body:{...body,text:'Changed question'}})).status,409);
  for(let i=0;i<4;i++)assert.equal((await call('POST',url,{body:{...body,requestId:id()}})).status,200);
  assert.equal((await call('POST',url,{body:{...body,requestId:id()}})).status,429,'email limit spans different IPs');
  const beforeBlocked=(await read('requests/'+f.id+'.json')).length;
  for(let i=0;i<5;i++)assert.equal((await call('POST',url,{ip:'192.0.2.8',body:{...body,email:'ip'+i+'@example.com',requestId:id()}})).status,200);
  assert.equal((await call('POST',url,{ip:'192.0.2.8',body:{...body,email:'ip-last@example.com',requestId:id()}})).status,429,'IP limit spans different emails');
  assert.equal((await read('requests/'+f.id+'.json')).length,beforeBlocked+5);
});

test('form submissions provide usable HTML controls and current revision acceptance',async()=>{
  const f=await family(),r=await book(f);
  let response=await call('POST','/api/job/'+r.actionToken,{form:true,body:{action:'send-quote',requestId:id(),baseRevision:'0',scope:'Sweep front steps',equipment:'Family brings broom',itemDescription0:'Sweep',itemAmount0:'12.50'}});
  assert.equal(response.status,200);assert.match(response.body,/Quote sent/);
  response=await call('POST','/api/booking/'+r.cancelToken,{form:true,body:{action:'accept-quote',revision:'1',accept:'yes'}});
  assert.equal(response.status,200);assert.match(response.body,/Quote accepted/);
  response=await call('POST','/api/job/'+r.actionToken,{form:true,body:{action:'reply',requestId:id(),text:'See you then.'}});
  assert.equal(response.status,200);assert.match(response.body,/See you then\./);
  const ask={requestId:id(),name:'Casey',email:'forms-neighbor@example.com',text:'Could you bring bags?',startedAt:String(Date.now()-5000)};
  response=await call('POST','/api/inquiry/'+f.slug,{form:true,body:ask});
  assert.equal(response.status,303,'POST redirects into the private conversation');
  const location=response.headers.location,privatePath=new URL(location).pathname;
  assert.match(privatePath,/^\/api\/booking\/[a-f0-9]+$/);
  assert.equal((await call('GET',privatePath)).status,200,'refresh uses GET and does not create another inquiry');
  const retry=await call('POST','/api/inquiry/'+f.slug,{form:true,body:ask});assert.equal(retry.status,303);assert.equal(retry.headers.location,location);
  response=await call('POST',privatePath,{form:true,body:{action:'question',requestId:id(),text:'Do you also rake the side yard?'}});
  assert.equal(response.status,200);assert.match(response.body,/side yard/);
  assert.equal((await read('requests/'+f.id+'.json')).filter(row=>row.kind==='inquiry').length,1);
});

test('inquiries follow owned renames, pause with the business, and expire with all private artifacts',async ctx=>{
  const f=await family(),{row:r}=await inquiry(f);
  assert.equal((await call('POST','/api/slug',{token:f.token,body:{from:f.slug,slug:'sam-new-address'}})).status,200);
  const routed=await inquiry(f,{requestId:id()});assert.equal(routed.row.slug,'sam-new-address');
  const meta=await read('pages/sam-new-address.json');meta.status='paused';await write('pages/sam-new-address.json',meta);
  assert.equal((await call('GET','/api/inquiry/'+f.slug)).status,404);assert.equal((await call('GET','/api/booking/'+r.cancelToken)).status,200,'existing conversation survives business pause');
  ctx.mock.timers.setTime(new Date('2026-12-23T18:00:00Z').getTime());
  assert.equal((await call('GET','/api/booking/'+r.cancelToken)).status,404);
  assert.equal(await read('cancels/'+r.cancelToken+'.json'),null);assert.equal(await (await store()).get('jobact/'+r.actionToken),null);assert.equal(await read('bookingids/'+f.id+'/'+r.idempotencyKey),null);
  assert.deepEqual(await read('requests/'+f.id+'.json'),[]);
});

test('deleting the account erases conversations, quotes, gear data, and private capability records',async()=>{
  const f=await family(),r=await book(f),{row:ask}=await inquiry(f);
  await parent(r,quote());await customer(r,{action:'accept-quote',revision:1,accept:'yes'});
  assert.equal((await call('DELETE','/api/account',{token:f.token})).status,200);
  for(const key of ['requests/'+f.id+'.json','gear/'+f.id+'.json','jobact/'+r.actionToken,'jobact/'+ask.actionToken,'cancels/'+r.cancelToken+'.json','cancels/'+ask.cancelToken+'.json'])assert.equal(await (await store()).get(key),null,key);
  assert.equal((await call('GET','/api/booking/'+ask.cancelToken)).status,404);
  assert.equal((await (await store()).list('bookingids/'+f.id+'/')).length,0);
});
