// Encrypted snapshots only. Never print key material, connection strings or rows.
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {open,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import pg from 'pg';
import {SCHEMA} from '../host/lib/postgres-store.mjs';
const MAGIC=Buffer.from('HBKV1');
export function backupKey(value){const key=Buffer.from(value||'','base64');if(key.length!==32)throw Error('A 32-byte base64 HB_BACKUP_KEY is required');return key;}
function validRecord(row){return row&&typeof row.key==='string'&&row.key.length>0&&row.key.length<1024&&!row.key.includes('\\')&&!row.key.includes('\0')&&!row.key.split('/').some(x=>!x||x==='.'||x==='..')&&typeof row.value==='string';}
export async function backup(client,file,key){
 if(key.length!==32)throw Error('Invalid backup key');
 const handle=await open(file,'wx',0o600),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),hash=createHash('sha256');
 let count=0,committed=false;
 const write=async buffer=>{let offset=0;while(offset<buffer.length){const r=await handle.write(buffer,offset,buffer.length-offset);offset+=r.bytesWritten;}};
 const line=async value=>{await write(cipher.update(JSON.stringify(value)+'\n'));};
 try{
  await write(Buffer.concat([MAGIC,iv]));
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query('DECLARE hb_backup_cursor NO SCROLL CURSOR FOR SELECT key,value FROM hb_kv ORDER BY key');
  await line({format:'hb-kv',version:1,createdAt:new Date().toISOString()});
  for(;;){const rows=(await client.query('FETCH 100 FROM hb_backup_cursor')).rows;if(!rows.length)break;for(const row of rows){const record={key:row.key,value:row.value};if(!validRecord(record))throw Error('Invalid stored record');const raw=JSON.stringify(record)+'\n';hash.update(raw);await write(cipher.update(raw));count++;}}
  await line({end:true,count,sha256:hash.digest('hex')});await write(cipher.final());await write(cipher.getAuthTag());await handle.sync();
  await client.query('COMMIT');committed=true;return {records:count,encrypted:true};
 }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{await handle.close();if(!committed)await rm(file,{force:true});}
}
async function* lines(file,key){
 const h=await open(file,'r');let info,head,tag;
 try{info=await h.stat();head=Buffer.alloc(17);tag=Buffer.alloc(16);if(info.size<34)throw Error('Invalid backup');await h.read(head,0,17,0);await h.read(tag,0,16,info.size-16);}finally{await h.close();}
 if(!head.subarray(0,5).equals(MAGIC))throw Error('Unknown backup format');
 const cipher=createDecipheriv('aes-256-gcm',key,head.subarray(5));cipher.setAuthTag(tag);let buffer='';
 // Cipher output can split a UTF-8 character; StringDecoder preserves its bytes.
 const {StringDecoder}=await import('node:string_decoder');const decoder=new StringDecoder('utf8');
 for await(const chunk of createReadStream(file,{start:17,end:info.size-17})){
  buffer+=decoder.write(cipher.update(chunk));if(buffer.length>16_000_000)throw Error('Record too large');
  let i;while((i=buffer.indexOf('\n'))>=0){yield buffer.slice(0,i);buffer=buffer.slice(i+1);}
 }
 buffer+=decoder.write(cipher.final())+decoder.end();
 let i;while((i=buffer.indexOf('\n'))>=0){yield buffer.slice(0,i);buffer=buffer.slice(i+1);}
 if(buffer)throw Error('Truncated backup');
}
export async function restore(client,file,key,{apply=false}={}){
 if(key.length!==32)throw Error('Invalid backup key');let count=0,header=false,footer=false,started=false;const hash=createHash('sha256'),seen=new Set();
 try{
  if(apply){await client.query('BEGIN');started=true;await client.query(SCHEMA);await client.query('LOCK TABLE hb_kv IN ACCESS EXCLUSIVE MODE');if((await client.query('SELECT count(*)::int AS count FROM hb_kv')).rows[0].count!==0)throw Error('Destination must be empty');}
  for await(const raw of lines(file,key)){
   const row=JSON.parse(raw);
   if(!header){if(row.format!=='hb-kv'||row.version!==1)throw Error('Unknown backup format');header=true;continue;}
   if(footer)throw Error('Unexpected trailing records');
   if(row.end===true){if(row.count!==count||row.sha256!==hash.digest('hex'))throw Error('Backup checksum mismatch');footer=true;continue;}
   if(!validRecord(row)||seen.has(row.key))throw Error('Invalid or duplicate backup record');seen.add(row.key);hash.update(raw+'\n');count++;
   if(apply)await client.query('INSERT INTO hb_kv(key,value) VALUES($1,$2)',[row.key,row.value]);
  }
  // The generator must finish GCM authentication before the transaction can commit.
  if(!header||!footer)throw Error('Incomplete backup');
  if(apply)await client.query('COMMIT');return {records:count,verified:true,applied:apply};
 }catch(error){if(started)try{await client.query('ROLLBACK');}catch{}throw error;}
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 let pool,client;
 try{
  const [command,file]=process.argv.slice(2);if(!['backup','verify','restore'].includes(command)||!file)throw Error('Usage: backup|verify|restore FILE [--apply]');
  const key=backupKey(process.env.HB_BACKUP_KEY),apply=process.argv.includes('--apply');
  if(command!=='verify'&&(!process.env.DATABASE_URL||apply&&process.env.HB_MAINTENANCE_MODE!=='1'))throw Error('Database and maintenance configuration required');
  if(command!=='verify'){pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});client=await pool.connect();}
  const result=command==='backup'?await backup(client,file,key):await restore(client,file,key,{apply:command==='restore'&&apply});console.log(JSON.stringify(result));
 }catch{console.error('Backup operation did not complete. Check command, key, permissions, database configuration and empty restore destination. No secrets or records are logged.');process.exitCode=1;}finally{client?.release();await pool?.end();}
}
