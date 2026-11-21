import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {postgresStore,SCHEMA} from '../host/lib/postgres-store.mjs';
test('real SQL engine commits related records together and rolls back partial writes',async()=>{
 const db=new PGlite();await db.exec(SCHEMA);const log=[];
 const client={query:async(sql,params)=>{log.push(sql);return db.query(sql,params);},release(){}};
 const pool={...client,on(){},async connect(){return client;},async end(){await db.close();}};
 const s=postgresStore('unused-in-test',pool);
 try{
  await assert.rejects(()=>s.transaction(async tx=>{await tx.put('pages/example.html','page');await tx.put('mailqueue/example.json','mail');throw Error('injected failure');},{keys:['account:example','slug:example']}),/injected failure/);
  assert.equal(await s.get('pages/example.html'),null);assert.equal(await s.get('mailqueue/example.json'),null);
  await s.transaction(async tx=>{await tx.put('requests/example.json','booking');await tx.put('mailqueue/example.json','mail');},{keys:['account:example']});
  assert.equal(await s.get('requests/example.json'),'booking');assert.deepEqual(await s.list('mailqueue/'),['mailqueue/example.json']);
  await s.transaction(async tx=>assert.equal(await tx.get('requests/example.json'),'booking'),{readOnly:true});
  assert.ok(log.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(log.includes('SELECT pg_advisory_xact_lock_shared($1::bigint)'));
  assert.ok(log.includes('SELECT pg_advisory_xact_lock($1::bigint)'));
  await s.transaction(tx=>tx.del('requests/example.json'),{maintenance:true});assert.equal(await s.get('requests/example.json'),null);
 }finally{await s.close();}
});

test('SQL housekeeping preserves upcoming booking links and removes expired records',async()=>{
 const db=new PGlite(),client={query:(sql,params)=>db.query(sql,params),release(){}};
 const pool={...client,on(){},async connect(){return client;},async end(){await db.close();}},s=postgresStore('unused',pool);
 const now=Date.now(),past=new Date(now-70*864e5).toISOString(),future=new Date(now+20*864e5).toISOString().slice(0,16);
 try{
  const rows={
   'events/future.json':{createdAt:past,start:future,tz:'America/Chicago'},
   'events/new-future.json':{createdAt:past,start:future,expiresAt:now+40*864e5},
   'events/expired.json':{createdAt:past,start:'2020-01-01T09:00',expiresAt:now-1000},
   'events/legacy-expired.json':{createdAt:past,start:'2020-01-01T09:00'},
   'cancels/upcoming.json':{createdAt:past,retentionVersion:2,expiresAt:now+40*864e5},
   'cancels/expired.json':{createdAt:past,retentionVersion:2,expiresAt:now-1000},
   'cancels/legacy.json':{createdAt:past,expiresAt:now-40*864e5}
  };
  for(const [key,value] of Object.entries(rows)){await s.put(key,JSON.stringify(value));await db.query("UPDATE hb_kv SET updated_at=now()-interval '70 days' WHERE key=$1",[key]);}
  await s.put('renew/plaintext','account-id');await s.put('pages/example.html','<html>Page</html>');
  await s.sweep({keepFrom:new Date(now-864e5).toISOString().slice(0,10)});
  for(const key of ['events/future.json','events/new-future.json','cancels/upcoming.json','cancels/legacy.json','renew/plaintext','pages/example.html'])assert.ok(await s.get(key),key);
  for(const key of ['events/expired.json','events/legacy-expired.json','cancels/expired.json'])assert.equal(await s.get(key),null,key);
 }finally{await s.close();}
});
