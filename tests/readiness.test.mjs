// Isolated lifecycle evidence: no real email, payment, or production records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileStore,setStore,store} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';

test('readiness: signup, consent, publish, duplicate booking, confirm and parent cancellation notifications',async()=>{
 const dir=await mkdtemp(tmpdir()+'/hb-readiness-');setStore(fileStore(dir));
 const saved={...process.env};Object.assign(process.env,{PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',PUBLIC_ORIGIN:'http://sites.test',ADMIN_SECRET:'test-admin-secret'});
 const call=(method,path,body,token)=>handleRequest({method,path,query:new URL('http://sites.test'+path).searchParams,headers:{origin:'http://sites.test',authorization:token?'Bearer '+token:''},body:body?JSON.stringify(body):'',origin:'http://sites.test'});
 const json=async(...args)=>{const r=await call(...args);assert.equal(r.status,200,`${args[1]}: ${r.body}`);return JSON.parse(r.body);};
 const inbox=async(email)=>(await json('GET','/api/test/outbox?email='+email)).messages;
 try{
  const email='readiness-parent@example.com',neighbor='readiness-neighbor@example.com';
  const auth=await json('POST','/api/auth/start',{email});
  const {token}=await json('POST','/api/auth/verify',{email,code:auth.devCode});
  const html='<!doctype html><html><head><title>Test yard</title></head><body><!-- hb-public --><h1>Alex</h1></body></html>';
  assert.equal((await call('POST','/api/publish',{slug:'test-yard',html},token)).status,403);
  await json('POST','/api/consent',{consent:true},token);
  await json('POST','/api/publish',{slug:'test-yard',html},token);
  assert.match((await call('GET','/api/site/test-yard')).body,/<h1>Alex<\/h1>/);
  const date=new Date(Date.now()+3*864e5).toISOString().slice(0,10);
  const booking={requestId:'readiness-booking-0001',slug:'test-yard',name:'Casey',contact:neighbor,address:'123 Example Lane',service:'Yard cleanup',start:date+'T10:00',when:date+' at 10 AM',access:'Private test key note',t:5000};
  const first=await json('POST','/api/book',booking);
  const twice=await json('POST','/api/book',booking);assert.equal(twice.duplicate,true);
  const jobs=await json('GET','/api/my-jobs',undefined,token);assert.equal(jobs.jobs.length,1);
  const action='/api/job/'+jobs.jobs[0].action;
  assert.equal((await call('GET','/api/account')).status,401);
  assert.doesNotMatch((await call('GET','/api/site/test-yard')).body,/123 Example Lane|Private test key note|readiness-neighbor/);
  await json('POST',action,{status:'confirmed',json:true},token);
  assert.equal((await inbox(neighbor)).filter(m=>m.subject==='Your booking is confirmed').length,1);
  await json('POST',action,{status:'confirmed',json:true},token);
  assert.equal((await inbox(neighbor)).filter(m=>m.subject==='Your booking is confirmed').length,1);
  const before=(await inbox(neighbor)).length;
  await Promise.all([1,2].map(()=>json('POST',action,{status:'cancelled',json:true},token)));
  assert.equal((await inbox(neighbor)).length,before+1);
  const notice=(await inbox(neighbor)).find(m=>m.subject==='Your booking has been cancelled');
  assert.ok(notice);
  assert.match(notice.text,/cancelled by the family/i);
  assert.match(notice.text,/Yard cleanup/);
  assert.doesNotMatch(JSON.stringify(notice),/Private test key note|readiness-parent@example.com|123 Example Lane/);
  assert.match(notice.ics,/METHOD:CANCEL/,'Send a customer-safe cancellation invitation');
  assert.doesNotMatch(notice.ics,/Private test key note|readiness-parent@example.com|\/api\/job\//,'Never forward parent private details');
  assert.equal((await inbox(email)).filter(m=>/^Booking cancelled:/.test(m.subject)).length,1);
  await json('POST',action,{status:'cancelled',json:true},token);
  assert.equal((await inbox(email)).filter(m=>/^Booking cancelled:/.test(m.subject)).length,1);
  assert.equal((await inbox(neighbor)).filter(m=>m.subject==='Your booking has been cancelled').length,1);
  // Phone-only requests remain actionable, but no SMS is claimed or sent.
  await json('POST','/api/book',{...booking,requestId:'readiness-phone-0001',contact:'402-555-0100',service:'Phone cleanup'});
  const phoneJobs=await json('GET','/api/my-jobs',undefined,token);
  const phoneAction='/api/job/'+phoneJobs.jobs.find(j=>j.service==='Phone cleanup').action;
  await json('POST',phoneAction,{status:'cancelled',json:true},token);
  assert.equal((await inbox(neighbor)).filter(m=>m.subject==='Your booking has been cancelled').length,1);
  // A separate completed booking sends exactly one customer completion notice.
  await json('POST','/api/book',{...booking,requestId:'readiness-booking-0002',service:'Leaf cleanup'});
  const allJobs=await json('GET','/api/my-jobs',undefined,token);
  const doneAction='/api/job/'+allJobs.jobs.find(j=>j.service==='Leaf cleanup').action;
  await json('POST',doneAction,{status:'done',json:true},token);
  const doneCount=(await inbox(neighbor)).filter(m=>m.subject.includes('finished')).length;
  assert.equal(doneCount,1);
  await json('POST',doneAction,{status:'done',json:true},token);
  assert.equal((await inbox(neighbor)).filter(m=>m.subject.includes('finished')).length,doneCount);
  // Change only this synthetic account to the expiry boundary, then recover it
  // through test-mode checkout. No Stripe charge is attempted.
  const customerMailBeforeTrialChange=(await inbox(neighbor)).length;
  const storage=await store(),accountKey=(await storage.list('accounts/'))[0];
  const account=JSON.parse(await storage.get(accountKey));
  account.trialEndsAt=new Date(Date.now()-1000).toISOString();
  await storage.put(accountKey,JSON.stringify(account));
  assert.match((await call('GET','/api/site/test-yard')).body,/Taking a break/);
  assert.equal((await json('GET','/api/me',undefined,token)).exportAllowed,false);
  await json('GET','/api/cron/renewals',undefined,'test-admin-secret');
  assert.equal((await inbox(neighbor)).length,customerMailBeforeTrialChange,'Family trial expiry must not cancel or email a customer booking');
  await json('POST','/api/checkout',{plan:'year'},token);
  assert.match((await call('GET','/api/site/test-yard')).body,/<h1>Alex<\/h1>/);
  assert.equal((await json('GET','/api/me',undefined,token)).exportAllowed,true);
  assert.equal((await inbox(neighbor)).length,customerMailBeforeTrialChange,'Family plan checkout must not send a customer booking cancellation');
  const screen=(await call('GET',action)).body;
  assert.doesNotMatch(screen,/These buttons only update/);
  assert.match(screen,/This booking is finished/);
  assert.doesNotMatch(screen,/<button[^>]*value="(?:confirmed|done|cancelled)"/);
 } finally {
  for(const k of ['PUBLISH_TEST_MODE','PAYWALL_MODE','PUBLIC_ORIGIN','ADMIN_SECRET']){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
  await rm(dir,{recursive:true,force:true});
 }
});
