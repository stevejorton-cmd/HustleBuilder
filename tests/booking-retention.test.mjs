import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileStore,setStore} from '../host/lib/store.mjs';
import {handleRequest} from '../host/lib/router.mjs';
import {bookingExpiry} from '../host/lib/retention.mjs';
import {jobInstant} from '../host/lib/calendar.mjs';

test('booking retention follows the later arrival, scheduled work and last pet-care day',()=>{
 const row={createdAt:'2026-11-01T12:00:00Z',invite:{start:'2027-02-01T10:00',tz:'America/Chicago'}};
 assert.equal(bookingExpiry(row),jobInstant(row.invite.start,row.invite.tz)+30*864e5);
 row.fields={awayTo:'2027-02-08'};
 assert.equal(bookingExpiry(row),jobInstant('2027-02-08T23:59','America/Chicago')+30*864e5);
 assert.equal(bookingExpiry({createdAt:row.createdAt}),Date.parse(row.createdAt)+30*864e5);
 assert.equal(bookingExpiry({createdAt:'invalid',start:'invalid'}),0);
});

test('advance bookings, old cancellation links and calendar files survive housekeeping until after the job',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-13T15:00:00Z')});
 const dir=await mkdtemp(tmpdir()+'/hb-retention-'),s=fileStore(dir);setStore(s);
 process.env.PUBLISH_TEST_MODE='1';process.env.PAYWALL_MODE='test';process.env.ADMIN_SECRET='retention-test-secret';
 const call=(method,path,body,token)=>handleRequest({method,path,origin:'http://retention.test',query:new URL('http://retention.test'+path).searchParams,headers:{origin:'http://retention.test',authorization:token?'Bearer '+token:''},body:body?JSON.stringify(body):''});
 const json=async(...a)=>JSON.parse((await call(...a)).body);
 try{
  const email='retention@example.com',a=await json('POST','/api/auth/start',{email}),v=await json('POST','/api/auth/verify',{email,code:a.devCode}),token=v.token;
  await json('POST','/api/consent',{consent:true},token);
  await json('POST','/api/checkout',{plan:'year'},token);
  const published=await json('POST','/api/publish',{slug:'future-yard',html:'<!doctype html><html><head><title>Alex</title></head><body><!-- hb-public --><h1>Alex</h1></body></html>'},token);assert.equal(published.ok,true);
  const booked=await json('POST','/api/book',{requestId:'retention-booking-123',slug:'future-yard',name:'Neighbor',contact:'neighbor@example.com',service:'Leaf cleanup',when:'February 1',address:'123 Example Lane',start:'2027-02-01T10:00',t:5000});assert.equal(booked.ok,true);
  const [key]=await s.list('requests/'),rows=JSON.parse(await s.get(key)),row=rows[0],eventKey='events/'+row.eventToken+'.json',cancelKey='cancels/'+row.cancelToken+'.json';
  // Exercise a link created before the new scheduled-date rule, too.
  const cancel=JSON.parse(await s.get(cancelKey));delete cancel.retentionVersion;cancel.expiresAt=Date.parse('2026-12-13T15:00:00Z');await s.put(cancelKey,JSON.stringify(cancel));
  t.mock.timers.setTime(new Date('2026-12-28T15:00:00Z').getTime());
  await call('GET','/api/cron/renewals',null,'retention-test-secret');
  assert.equal(JSON.parse(await s.get(key)).length,1);assert.ok(await s.get(eventKey));assert.ok(await s.get(cancelKey));
  assert.equal((await call('GET','/api/event/'+row.eventToken+'.ics')).status,200);
  const cancelled=await call('POST','/api/cancel/'+row.cancelToken,{});assert.equal(cancelled.status,200);assert.equal(JSON.parse(await s.get(key))[0].status,'cancelled');assert.equal(await s.get(eventKey),null);
  t.mock.timers.setTime(new Date('2027-03-05T15:00:00Z').getTime());
  await call('GET','/api/cron/renewals',null,'retention-test-secret');
  assert.deepEqual(JSON.parse(await s.get(key)),[]);assert.equal(await s.get('jobact/'+row.actionToken),null);assert.equal(await s.get(cancelKey),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
