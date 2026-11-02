import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {migrate} from '../scripts/migrate-storage.mjs';
test('migration is read-only by default, preserves bookings, revokes old sessions and refuses overwrite',async()=>{
 const data=new Map([['accounts/abc.json',JSON.stringify({id:'abc',email:'parent@example.com',tokenHash:'old',calToken:'old',checkoutSessionId:'old'})],['tokens/old','abc'],['caltokens/old','abc'],['requests/abc.json',JSON.stringify([{id:'recent',actionToken:'action',createdAt:new Date().toISOString()},{id:'old',createdAt:'2020-01-01T00:00:00Z'}])],['jobact/action','abc:recent'],['jobact/stale','abc:old']]);
 const source={async list(){return [...data.keys()];},async get(k){return data.get(k)??null;}};
 const db=new PGlite();try{
  const dry=await migrate(source,db);assert.equal(dry.dryRun,true);assert.equal((await db.query("select to_regclass('public.hb_kv') as name")).rows[0].name,null);
  await migrate(source,db,{apply:true});const get=async k=>(await db.query('select value from hb_kv where key=$1',[k])).rows[0]?.value;
  assert.equal(await get('tokens/old'),undefined);assert.equal(await get('caltokens/old'),undefined);assert.equal(await get('jobact/action'),'abc:recent');assert.equal(await get('jobact/stale'),undefined);
  assert.equal(JSON.parse(await get('accounts/abc.json')).tokenHash,'');assert.equal(JSON.parse(await get('requests/abc.json')).length,1);assert.equal(await get('planacct/abc'),'abc');
  await assert.rejects(()=>migrate(source,db,{apply:true}),/Destination must be empty/);
  assert.ok(data.get('tokens/old')); // Original data is never modified or deleted.
 }finally{await db.close();}
});
