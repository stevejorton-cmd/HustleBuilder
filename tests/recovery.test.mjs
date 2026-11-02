import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {randomBytes} from 'node:crypto';
import {backup,restore,backupKey} from '../scripts/backup.mjs';import {preflight} from '../scripts/preflight.mjs';import {SCHEMA,postgresStore} from '../host/lib/postgres-store.mjs';import {fileStore,setStore} from '../host/lib/store.mjs';import {flushMail} from '../host/lib/mail.mjs';
let dir;const originalFetch=globalThis.fetch;
test.beforeEach(async()=>{dir=await mkdtemp(tmpdir()+'/hb-recovery-');});test.afterEach(async()=>{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});});
test('encrypted backup restores exact Unicode records and never exposes their plaintext',async()=>{
 const source=new PGlite(),destination=new PGlite(),key=randomBytes(32),file=dir+'/backup.hbenc';try{
  await source.exec(SCHEMA);const secret='private address: 123 Test Lane — 🐶';await source.query('INSERT INTO hb_kv(key,value) VALUES($1,$2)',['requests/private.json',secret.repeat(25000)]);
  const out=await backup(source,file,key);assert.equal(out.records,1);const bytes=await readFile(file);assert.ok(!bytes.includes(Buffer.from('123 Test Lane')));assert.equal((await stat(file)).mode&0o777,0o600);
  assert.equal((await restore(null,file,key)).applied,false);assert.equal((await restore(destination,file,key,{apply:true})).records,1);assert.equal((await destination.query('SELECT value FROM hb_kv')).rows[0].value,secret.repeat(25000));
  await assert.rejects(()=>restore(destination,file,key,{apply:true}),/Destination must be empty/);
 }finally{await source.close();await destination.close();}
});
test('tampered backup cannot commit even if decrypted record lines were processed',async()=>{
 const source=new PGlite(),destination=new PGlite(),key=randomBytes(32),file=dir+'/tamper.hbenc';try{
  await source.exec(SCHEMA);await destination.exec(SCHEMA);await source.query('INSERT INTO hb_kv(key,value) VALUES($1,$2)',['accounts/example.json','private']);await backup(source,file,key);
  const b=await readFile(file);b[b.length-1]^=1;await writeFile(file,b);
  await assert.rejects(()=>restore(destination,file,key,{apply:true}));assert.equal((await destination.query('SELECT count(*)::int AS count FROM hb_kv')).rows[0].count,0);
 }finally{await source.close();await destination.close();}
});
test('wrong backup key and incomplete snapshots are rejected',async()=>{
 const db=new PGlite(),key=randomBytes(32),file=dir+'/wrong.hbenc';try{await db.exec(SCHEMA);await backup(db,file,key);await assert.rejects(()=>restore(null,file,randomBytes(32)));const bytes=await readFile(file);await writeFile(file,bytes.subarray(0,-10));await assert.rejects(()=>restore(null,file,key));assert.throws(()=>backupKey('short'));}finally{await db.close();}
});
test('failed backup removes its partial output and does not overwrite an existing file',async()=>{
 const file=dir+'/broken.hbenc',key=randomBytes(32);await assert.rejects(()=>backup({async query(){throw Error('injected failure');}},file,key));await assert.rejects(()=>stat(file),e=>e.code==='ENOENT');await writeFile(file,'existing');await assert.rejects(()=>backup({},file,key));assert.equal(await readFile(file,'utf8'),'existing');
});
test('deployment preflight reports missing settings without exposing values',async()=>{
 const db=new PGlite();try{await db.exec(SCHEMA);const env=Object.fromEntries(['DATABASE_URL','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','BOOKING_FROM','ADMIN_SECRET','CRON_SECRET'].map(k=>[k,'do-not-print-this-value']));Object.assign(env,{PUBLISH_TEST_MODE:'0',PAYWALL_MODE:'stripe',PUBLIC_ORIGIN:'https://example.com'});const r=await preflight(env,db);assert.equal(r.ok,true);assert.ok(!JSON.stringify(r).includes('do-not-print-this-value'));env.PUBLIC_ORIGIN='https://example.com/wrong-path';assert.equal((await preflight(env,db)).ok,false);assert.equal((await preflight({},null)).ok,false);}finally{await db.close();}
});
test('future retries cannot starve a later ready mail item',async()=>{
 const s=fileStore(dir);setStore(s);process.env.PUBLISH_TEST_MODE='1';for(let i=0;i<101;i++)await s.put('mailqueue/'+String(i).padStart(40,'0')+'.json',JSON.stringify({id:String(i).padStart(40,'0'),to:'parent@example.com',subject:'Test',text:'Saved',createdAt:Date.now(),nextAttemptAt:i<100?Date.now()+3600000:0,attempts:0}));await flushMail();assert.equal((await s.list('mailqueue/')).length,100);assert.equal(await s.get('mailqueue/'+String(100).padStart(40,'0')+'.json'),null);
});
test('expired sign-in mail is removed and connection errors persist retry backoff',async()=>{
 const s=fileStore(dir);setStore(s);process.env.PUBLISH_TEST_MODE='0';process.env.RESEND_API_KEY='placeholder';process.env.BOOKING_FROM='placeholder@example.com';const expired='a'.repeat(40),ready='b'.repeat(40);for(const [id,expiry]of [[expired,Date.now()-1],[ready,Date.now()+3600000]])await s.put('mailqueue/'+id+'.json',JSON.stringify({id,to:'parent@example.com',subject:'Code',text:'test',createdAt:Date.now(),expiresAt:expiry,attempts:0}));let calls=0;globalThis.fetch=async()=>{calls++;throw Error('connection failed');};await flushMail();assert.equal(calls,1);assert.equal(await s.get('mailqueue/'+expired+'.json'),null);const m=JSON.parse(await s.get('mailqueue/'+ready+'.json'));assert.equal(m.attempts,1);assert.ok(m.nextAttemptAt>Date.now());assert.ok(m.lastAttemptAt>0);
});
test('Postgres mail selection excludes future retries and favors work not yet attempted',async()=>{
 const db=new PGlite();try{await db.exec(SCHEMA);const s=postgresStore('unused',{query:(sql,args)=>db.query(sql,args),on(){}});for(const [id,last,next]of [['later',0,Date.now()+3600000],['retry',100,0],['new',0,0]])await s.put('mailqueue/'+id+'.json',JSON.stringify({lastAttemptAt:last,nextAttemptAt:next}));assert.deepEqual(await s.dueMail(1),['mailqueue/new.json']);assert.deepEqual(await s.dueMail(10),['mailqueue/new.json','mailqueue/retry.json']);}finally{await db.close();}
});
