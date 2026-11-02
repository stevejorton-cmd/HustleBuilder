// Run only against an explicitly supplied isolated test database, never the production URL.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {postgresStore,SCHEMA} from '../host/lib/postgres-store.mjs';
const url=process.env.HB_TEST_DATABASE_URL;
if(!url){console.error('Set HB_TEST_DATABASE_URL to an isolated preview/test database. No test was run.');process.exit(2);}
const pool=new pg.Pool({connectionString:url,max:1});await pool.query(SCHEMA);await pool.end();
const a=postgresStore(url),b=postgresStore(url),prefix='integration/'+randomBytes(16).toString('hex'),key=prefix+'/counter',viewSlug='integration-'+randomBytes(16).toString('hex');
try{
 await a.put(key,'0');
 await Promise.all(Array.from({length:40},(_,i)=>(i%2?a:b).transaction(async tx=>{const n=Number(await tx.get(key));await tx.put(key,String(n+1));},{keys:[prefix]})));
 assert.equal(await a.get(key),'40');
 await assert.rejects(()=>b.transaction(async tx=>{await tx.put(prefix+'/orphan','bad');throw Error('rollback');},{keys:[prefix]}));
 assert.equal(await a.get(prefix+'/orphan'),null);
 await Promise.all(Array.from({length:80},(_,i)=>(i%2?a:b).incrementView(viewSlug,'2026-11-01','2026-08-01')));
 assert.equal(JSON.parse(await a.get('views/'+viewSlug+'.json')).total,80);
 console.log('PASS: 40 increments retained across two independent Postgres pools; rollback leaves no partial record; 80 atomic view increments retained.');
}finally{await a.del('views/'+viewSlug+'.json');for(const k of await a.list(prefix+'/'))await a.del(k);await a.close();await b.close();}
