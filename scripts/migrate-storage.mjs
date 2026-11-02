// Read-only inspection by default. Run --apply only with writes paused and an empty destination.
import pg from 'pg';
import {createHash} from 'node:crypto';
import {blobStore,fileStore} from '../host/lib/store.mjs';
import {SCHEMA} from '../host/lib/postgres-store.mjs';
export async function migrate(source,client,{apply=false}={}){
 const keys=await source.list('');
 const rows=[];let accounts=0;
 for(const key of keys){
  if(key.startsWith('tokens/')||key.startsWith('caltokens/')||key.startsWith('adminsessions/'))continue;
  let value=await source.get(key);if(value===null)throw Error('Source changed during migration');
  if(key.startsWith('accounts/')&&key.endsWith('.json')){
   const account=JSON.parse(value);account.tokenHash='';account.sessionVersion=2;account.calToken='';account.verifyHash='';account.verifyExpires=0;
   account.checkoutPendingAt='';account.checkoutUrl='';account.checkoutSessionId='';account.checkoutPlan='';
   value=JSON.stringify(account);accounts++;
   rows.push(['planacct/'+account.id,account.id]);
  }
  if(key.startsWith('requests/')&&key.endsWith('.json')){value=JSON.stringify(JSON.parse(value).filter(r=>Date.parse(r.createdAt)>Date.now()-30*864e5).map(r=>({...r,calendarJobId:r.calendarJobId||r.calJob?.id||r.ics?.match(/UID:([^@\r\n]+)@/)?.[1]||null})));}
  if(key.startsWith('cancels/')){const record=JSON.parse(value);const requests=JSON.parse(await source.get('requests/'+record.accountId+'.json')||'[]');const row=requests.find(r=>r.id===record.requestId);if(!row||Date.parse(row.createdAt)<=Date.now()-30*864e5)continue;record.createdAt=row.createdAt;record.expiresAt=Date.parse(row.createdAt)+30*864e5;value=JSON.stringify(record);}
  if(key.startsWith('jobact/')){const [accountId,requestId]=value.split(':');const requests=JSON.parse(await source.get('requests/'+accountId+'.json')||'[]');if(!requests.some(r=>r.id===requestId&&Date.parse(r.createdAt)>Date.now()-30*864e5))continue;}
  rows.push([key,value]);
 }
 if(!apply)return {dryRun:true,objects:keys.length,preparedRows:rows.length,accounts};
 await client.query('BEGIN');
 try{
  await client.query(SCHEMA);
  const count=await client.query('SELECT count(*)::int AS count FROM hb_kv');
  if(count.rows[0].count!==0)throw Error('Destination must be empty');
  for(const [key,value]of rows)await client.query('INSERT INTO hb_kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,value]);
  // Compare transformed bytes inside the same transaction before committing.
  for(const [key,value]of rows){const actual=(await client.query('SELECT value FROM hb_kv WHERE key=$1',[key])).rows[0]?.value;if(createHash('sha256').update(actual||'').digest('hex')!==createHash('sha256').update(value).digest('hex'))throw Error('Migration verification failed');}
  await client.query('COMMIT');return {dryRun:false,objects:keys.length,preparedRows:rows.length,accounts};
 }catch(e){await client.query('ROLLBACK');throw e;}
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 try{
  if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
  const apply=process.argv.includes('--apply');
  if(apply&&process.env.HB_MAINTENANCE_MODE!=='1')throw Error('Pause production writes and set HB_MAINTENANCE_MODE=1 first');
  const source=process.env.HB_MIGRATE_FILE_DIR?fileStore(process.env.HB_MIGRATE_FILE_DIR):await blobStore();
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),client=await pool.connect();
  try{console.log(JSON.stringify(await migrate(source,client,{apply})));}finally{client.release();await pool.end();}
 }catch{console.error('Migration did not complete. Check required environment, maintenance mode, connectivity and empty destination. No credentials or customer records are logged.');process.exitCode=1;}
}
