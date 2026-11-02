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
